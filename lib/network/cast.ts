/**
 * Google Cast's own protocol (CastV2), as much as a status, a few commands and playing a queue take:
 * TLS to port 8009, each message a big-endian length and a `CastMessage` protobuf whose payload is
 * JSON in a namespace. A session connects to the receiver (`receiver-0`), asks its status (volume,
 * the app running) and, when an app plays media, connects to that app's transport and asks the
 * media status (player state, title, what it plays). To play, it starts Google's Default Media
 * Receiver, which every Cast device has, and loads a queue of addresses into it, which the device
 * fetches itself: files, HLS playlists and live fragmented MP4, not raw MPEG-TS, which it refuses.
 * It shows a picture until it is told to move on.
 *
 * A Cast device's certificate is its own, signed by no authority, so it is not checked: the
 * connection is to the address the device answered on.
 */

import tls from 'node:tls';
import { type Media, type Status, Unreachable, type Way } from './play.ts';

const SENDER = 'sender-ein';
const RECEIVER = 'receiver-0';
const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
const TIMEOUT_MS = 8000;
/** How long starting the player and loading into it may take: about 8 s the first time. */
const LOAD_TIMEOUT_MS = 30_000;

/** Google's Default Media Receiver, the player every Cast device has. */
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';
const HLS = 'application/x-mpegurl';
/** What the Default Media Receiver refuses: MPEG-TS on its own, rather than in an HLS playlist. */
const REFUSED = new Set(['video/mp2t']);

/** What a Cast device says of itself and of what it plays. */
type CastStatus = {
  /** 0 to 1. */
  volume?: number;
  muted?: boolean;
  /** The app running, by its name (`Spotify`, `Backdrop` when idle). */
  app?: string;
  /** Its id (`CC1AD845`); unset when nothing runs. */
  appId?: string;
  /** Whether the app running is the device's idle screen. */
  idleScreen?: boolean;
  /** `PLAYING`, `PAUSED`, `BUFFERING` or `IDLE`, while an app plays media. */
  player?: string;
  /** Why the player is idle: `FINISHED`, `CANCELLED`, `INTERRUPTED` or `ERROR`. */
  idleReason?: string;
  /** The address of what it plays, as it was loaded. */
  contentId?: string;
  /** How far into it, in seconds. */
  currentTime?: number;
  title?: string;
  artist?: string;
};

/** What can be asked of a Cast device. */
type CastCommand =
  | { type: 'volume'; level: number }
  | { type: 'mute'; muted: boolean }
  | { type: 'play' | 'pause' | 'stop' | 'next' }
  | { type: 'seek'; seconds: number };

// ---- CastMessage ----

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
};

const field = (number: number, text: string): number[] => {
  const data = encoder.encode(text);
  return [(number << 3) | 2, ...varint(data.length), ...data];
};

/** One framed CastMessage with a JSON payload. */
export const encodeCastMessage = (destination: string, namespace: string, payload: unknown): Uint8Array => {
  const body = [0x08, 0, ...field(2, SENDER), ...field(3, destination), ...field(4, namespace), 0x28, 0, ...field(6, JSON.stringify(payload))];
  return new Uint8Array([body.length >>> 24, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body]);
};

type CastMessage = { source: string; namespace: string; payload: Record<string, unknown> };

/** A CastMessage's body (without its length); undefined for one with no JSON payload. */
export const decodeCastMessage = (body: Uint8Array): CastMessage | undefined => {
  const strings: Record<number, string> = {};
  let offset = 0;
  while (offset < body.length) {
    let key = 0, shift = 0, byte;
    do {
      byte = body[offset++];
      key |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    const number = key >> 3;
    if ((key & 7) === 0) {
      while (body[offset++] & 0x80);
    } else if ((key & 7) === 2) {
      let length = 0;
      shift = 0;
      do {
        byte = body[offset++];
        length |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      strings[number] = decoder.decode(body.subarray(offset, offset + length));
      offset += length;
    } else {
      return undefined;
    }
  }
  if (!strings[6]) return undefined;
  try {
    return { source: strings[2] ?? '', namespace: strings[4] ?? '', payload: JSON.parse(strings[6]) };
  } catch {
    return undefined;
  }
};

// ---- a session ----

type Payload = Record<string, unknown>;

type Session = {
  send(destination: string, namespace: string, payload: Payload): void;
  /** The next message in `namespace` that `wanted` takes. */
  next(namespace: string, wanted: (payload: Payload) => boolean): Promise<Payload>;
  close(): void;
};

/** A payload whose `type` is one of `types`. */
const ofType = (...types: string[]) => (payload: Payload): boolean => types.includes(String(payload.type));

const open = (ip: string, timeoutMs = TIMEOUT_MS): Promise<Session> =>
  new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port: 8009, rejectUnauthorized: false });
    let buffer = new Uint8Array();
    const waiting: { namespace: string; wanted(payload: Payload): boolean; resolve(payload: Payload): void }[] = [];
    let failed: Error | undefined;
    const timer = setTimeout(() => socket.destroy(new Error(`${ip} did not answer in time`)), timeoutMs);
    const session: Session = {
      send: (destination, namespace, payload) => socket.write(encodeCastMessage(destination, namespace, payload)),
      next: (namespace, wanted) =>
        failed ? Promise.reject(failed) : new Promise((resolveNext, rejectNext) => {
          waiting.push({ namespace, wanted, resolve: resolveNext });
          socket.once('close', () => rejectNext(failed ?? new Error(`${ip} closed the connection`)));
        }),
      close: () => {
        clearTimeout(timer);
        socket.destroy();
      },
    };
    socket.on('secureConnect', () => {
      session.send(RECEIVER, NS.connection, { type: 'CONNECT' });
      resolve(session);
    });
    socket.on('error', (error: Error) => {
      failed = error;
      reject(new Unreachable(`cannot reach ${ip}: ${error.message}`));
    });
    socket.on('data', (chunk: Uint8Array) => {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      buffer = joined;
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
        if (buffer.length < 4 + length) break;
        const message = decodeCastMessage(buffer.subarray(4, 4 + length));
        buffer = buffer.slice(4 + length);
        if (!message) continue;
        if (message.namespace === NS.heartbeat && message.payload.type === 'PING') {
          session.send(message.source, NS.heartbeat, { type: 'PONG' });
          continue;
        }
        const at = waiting.findIndex((each) => each.namespace === message.namespace && each.wanted(message.payload));
        if (at >= 0) waiting.splice(at, 1)[0].resolve(message.payload);
      }
    });
  });

type Application = { appId?: string; displayName?: string; sessionId?: string; transportId?: string; isIdleScreen?: boolean };
type ReceiverStatus = { volume?: { level?: number; muted?: boolean }; applications?: Application[] };
type MediaStatus = {
  mediaSessionId?: number;
  playerState?: string;
  idleReason?: string;
  currentTime?: number;
  media?: { contentId?: string; metadata?: { title?: string; artist?: string; albumArtist?: string } };
};

const receiverStatus = async (session: Session): Promise<ReceiverStatus> => {
  session.send(RECEIVER, NS.receiver, { type: 'GET_STATUS', requestId: 1 });
  return ((await session.next(NS.receiver, ofType('RECEIVER_STATUS'))).status ?? {}) as ReceiverStatus;
};

/** The app that plays media, when one does, its transport connected. */
const mediaApp = (status: ReceiverStatus): Application | undefined => status.applications?.find((app) => !app.isIdleScreen && app.transportId);

/**
 * What the app plays. Only the answer to this request is taken: the status the player sends of its
 * own accord as it changes leaves out what it plays when that has not changed.
 */
const mediaStatus = async (session: Session, app: Application): Promise<MediaStatus | undefined> => {
  const requestId = 2;
  session.send(app.transportId!, NS.connection, { type: 'CONNECT' });
  session.send(app.transportId!, NS.media, { type: 'GET_STATUS', requestId });
  const answer = await session.next(NS.media, (payload) => payload.type === 'MEDIA_STATUS' && payload.requestId === requestId);
  return (answer.status as MediaStatus[] | undefined)?.[0];
};

/** What the Cast device at `ip` plays, and its volume. */
const castStatus = async (ip: string): Promise<CastStatus> => {
  const session = await open(ip);
  try {
    const receiver = await receiverStatus(session);
    const app = receiver.applications?.[0];
    const status: CastStatus = {
      ...(receiver.volume?.level !== undefined ? { volume: receiver.volume.level } : {}),
      ...(receiver.volume?.muted !== undefined ? { muted: receiver.volume.muted } : {}),
      app: app?.displayName ?? '',
      ...(app?.appId ? { appId: app.appId, idleScreen: app.isIdleScreen === true } : {}),
    };
    const playing = mediaApp(receiver);
    const media = playing ? await mediaStatus(session, playing).catch(() => undefined) : undefined;
    status.player = media?.playerState ?? 'IDLE';
    if (media?.idleReason) status.idleReason = media.idleReason;
    if (media?.media?.contentId) status.contentId = media.media.contentId;
    if (typeof media?.currentTime === 'number') status.currentTime = media.currentTime;
    status.title = media?.media?.metadata?.title ?? '';
    status.artist = media?.media?.metadata?.artist ?? media?.media?.metadata?.albumArtist ?? '';
    return status;
  } finally {
    session.close();
  }
};

/** Asks the Cast device at `ip` to do `command`; throws when nothing plays that it could act on. */
const castCommand = async (ip: string, command: CastCommand): Promise<void> => {
  const session = await open(ip);
  try {
    if (command.type === 'volume' || command.type === 'mute') {
      const volume = command.type === 'volume' ? { level: Math.min(1, Math.max(0, command.level)) } : { muted: command.muted };
      session.send(RECEIVER, NS.receiver, { type: 'SET_VOLUME', volume, requestId: 3 });
      await session.next(NS.receiver, ofType('RECEIVER_STATUS'));
      return;
    }
    const receiver = await receiverStatus(session);
    const app = mediaApp(receiver);
    if (!app) throw new Error('nothing is playing on it');
    if (command.type === 'stop') {
      session.send(RECEIVER, NS.receiver, { type: 'STOP', sessionId: app.sessionId, requestId: 4 });
      await session.next(NS.receiver, ofType('RECEIVER_STATUS'));
      return;
    }
    const media = await mediaStatus(session, app);
    if (media?.mediaSessionId === undefined) throw new Error(`${app.displayName ?? 'the app'} plays nothing it can ${command.type}`);
    const sent = command.type === 'next'
      ? { type: 'QUEUE_UPDATE', jump: 1 }
      : command.type === 'seek'
      ? { type: 'SEEK', currentTime: Math.max(0, command.seconds) }
      : { type: command.type.toUpperCase() };
    session.send(app.transportId!, NS.media, { ...sent, mediaSessionId: media.mediaSessionId, requestId: 5 });
    await session.next(NS.media, ofType('MEDIA_STATUS'));
  } finally {
    session.close();
  }
};

/** The Default Media Receiver on the device, started when it is not running, its transport connected. */
const mediaReceiver = async (session: Session): Promise<Application> => {
  const running = (status: ReceiverStatus) => status.applications?.find((app) => app.appId === DEFAULT_MEDIA_RECEIVER && app.transportId);
  let app = running(await receiverStatus(session));
  if (!app) {
    session.send(RECEIVER, NS.receiver, { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER, requestId: 6 });
    while (!app) {
      const answer = await session.next(NS.receiver, ofType('RECEIVER_STATUS', 'LAUNCH_ERROR'));
      if (answer.type === 'LAUNCH_ERROR') throw new Error(`it would not start its media player: ${answer.reason ?? 'no reason given'}`);
      app = running((answer.status ?? {}) as ReceiverStatus);
    }
  }
  session.send(app.transportId!, NS.connection, { type: 'CONNECT' });
  return app;
};

/**
 * Plays `queue` on the Cast device at `ip` in the Default Media Receiver, in order, from item
 * `start` at `seconds` into it, in place of whatever it played. Resolves once the player took the
 * first; throws what it said when it would not.
 */
const castLoad = async (ip: string, queue: Media[], start: number, seconds: number): Promise<void> => {
  if (!queue.length) throw new Error('nothing to play');
  const session = await open(ip, LOAD_TIMEOUT_MS);
  try {
    const app = await mediaReceiver(session);
    const media = (item: Media) => ({
      contentId: item.url,
      contentUrl: item.url,
      contentType: item.contentType,
      streamType: item.live ? 'LIVE' : 'BUFFERED',
      ...(item.contentType === HLS ? { hlsSegmentFormat: 'ts', hlsVideoSegmentFormat: 'mpeg2_ts' } : {}),
      metadata: { metadataType: item.contentType.startsWith('image/') ? 4 : 0, title: item.title },
    });
    const requestId = 7;
    session.send(app.transportId!, NS.media, {
      type: 'QUEUE_LOAD',
      requestId,
      sessionId: app.sessionId,
      items: queue.map((item) => ({ media: media(item), autoplay: true, preloadTime: 10 })),
      startIndex: start,
      currentTime: seconds,
      repeatMode: 'REPEAT_OFF',
    });
    const answer = await session.next(
      NS.media,
      (payload) => payload.requestId === requestId || ['LOAD_FAILED', 'LOAD_CANCELLED', 'INVALID_REQUEST'].includes(String(payload.type)),
    );
    if (answer.type !== 'MEDIA_STATUS') throw new Error(`its player would not play it (${answer.reason ?? answer.type})`);
    const status = (answer.status as MediaStatus[] | undefined)?.[0];
    if (status?.playerState === 'IDLE' && status.idleReason === 'ERROR') throw new Error('its player could not play it');
  } finally {
    session.close();
  }
};

/** The Cast device at `ip`, as a way to play on it: what it says, as the player's. */
export const createCast = (ip: string): Way => ({
  kind: 'cast',
  queues: true,
  status: async (): Promise<Status> => {
    const status = await castStatus(ip);
    const what = [status.title, status.artist].filter(Boolean).join(' – ');
    const player = (status.player ?? 'IDLE').toLowerCase();
    return {
      ...(status.volume !== undefined ? { volume: status.volume } : {}),
      ...(status.muted !== undefined ? { muted: status.muted } : {}),
      player: player === 'playing' || player === 'paused' || player === 'buffering' ? player : player === 'loading' ? 'buffering' : 'idle',
      playing: what && status.app ? `${what} (${status.app})` : what || status.app || null,
      ...(status.appId === DEFAULT_MEDIA_RECEIVER && status.contentId ? { url: status.contentId } : {}),
      ...(status.player === 'IDLE' && status.idleReason === 'ERROR' ? { failed: true } : {}),
      ...(!status.appId || status.idleScreen ? { letGo: true } : {}),
      ...(status.currentTime !== undefined ? { seconds: status.currentTime } : {}),
    };
  },
  command: (command) => castCommand(ip, command),
  load: (items, start, seconds) => castLoad(ip, items, start, seconds),
  pick: (types) => Promise.resolve(types.find((type) => !REFUSED.has(type))),
});

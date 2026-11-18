/**
 * What is written to a speaker's or a screen's `show`, played or shown on it: lines, one per thing,
 * each a path from / (`find /music/Some-band -name '*.flac' > /dev/hall-speaker/show`), played in
 * order.
 *
 * - A recording goes as its `playback` rendition when it has one and the device plays it, else the
 *   original.
 * - A video goes as the device's `video` setting says: `h264` (the default) gives an original that
 *   is H.264 within 1080p as it is, and any other as H.264 made by the media service while it plays
 *   (as HLS, which a player seeks in, where the device takes it and the length is known; else as
 *   one stream); `av1` gives EiN's AV1 `playback` copy, for a device that plays AV1; `original`
 *   gives the original, for a device that plays it. While the media service is not there, a video
 *   goes only as a file the device plays as it is.
 * - A picture goes as its largest AVIF rendition, else as the original when that is a JPEG, PNG,
 *   AVIF, WebP or GIF, and is shown for the device's `picture` seconds before the next; the last
 *   stays until stopped.
 * - A rendition (`find <folder> -type f` lists them under each file) is left out when the lines
 *   name originals too.
 * - Any other path, one that names no file under a folder of EiN's (`/dashboard-wall/Kitchen`,
 *   `/albums/Summer?slideshow=screen`), is a page of EiN, which the media service renders as live
 *   video as the writer sees it, and is refused while the media service is not there. It plays until
 *   stopped, so it is the last line.
 *
 * The device fetches each thing from EiN itself, at EiN's address on the network: a file with a
 * file ticket for that file alone, made with the writer's access; a stream at an unguessable
 * address of its own, which the writer may read too.
 *
 * A device is one, whatever it speaks, and is reached by one or more ways: Google Cast (`cast.ts`)
 * and a DLNA renderer (`dlna.ts`) on a TV that has both. A list is given over the first way that
 * answers, each thing in the form that way plays, and the device is then asked and told over that
 * one while it plays it.
 *
 * At each poll, while the device plays the list, its tickets are renewed. A Cast device plays the
 * list itself; a renderer is given the next when the one it played ended (it stopped at its end,
 * or stays playing there with the position no longer moving), and asked again as it should end.
 * When a Cast device lets go of the list while it played (it went back to its idle
 * screen, as some do after a while), it is given again from where it was; let go of again within
 * `REGIVE_WINDOW_MS`, it is left. When the list is finished or stopped, or another app or sender
 * takes the device, its tickets are dropped and its streams stopped.
 */

import { audioFileName, imageFileName, videoFileName } from '@ein/api';
import { type Access, type ModuleDevices, type NodeVFS, readRenditionTable } from '@ein/client';
import { HlsVideo } from './hls.ts';

/** How the media service is asked to stream a video: its frame, and which part in which form. */
export type VideoStreamRequest = {
  angle: number;
  mirror: boolean;
  /** ffmpeg's name for its picture codec, when known. */
  codec?: string;
  start?: number;
  duration?: number;
  /** On the video's clock from `start`, rather than from 0. */
  sourceClock?: boolean;
  format: 'mp4' | 'mpegts';
};

/** A page streamed as live video: where it is served (`/live/<id>`, without the format's extension), and how to stop it. */
type PageStreamed = { path: string; stop(): Promise<void> };

/** What the media service makes now: videos as H.264 (`MediaHost.streamVideo`), and pages as video (`MediaHost.streamPage`). */
type MediaService = { video: boolean; pages: boolean };

/** What playing on a device needs of EiN. */
export type MediaHost = {
  vfs: NodeVFS;
  devices: ModuleDevices;
  /** EiN's address as devices on the network reach it (`http://192.168.1.10:8080`); undefined when it is not known. */
  address(): string | undefined;
  /** Ask `device` now, as what it plays should have ended. */
  wake?(device: string): void;
  /** The video at `path` as H.264 made by the media service while it is read; unset where there is none. */
  streamVideo?(path: string, request: VideoStreamRequest): Promise<ReadableStream<Uint8Array>>;
  /** The page at `route` as live video, as `access` sees it; unset where nothing renders pages. */
  streamPage?(route: string, access: Access): Promise<PageStreamed>;
  /**
   * What the media service makes now, asked as something is given to play a video or a page, since
   * the service comes and goes; unset where `streamVideo` and `streamPage` always make what they are asked.
   */
  mediaService?(): Promise<MediaService>;
};

/** How a device takes what is written to it, from its driver's config. */
type PlaySettings = {
  /** Which form of a video it is given. */
  video: 'h264' | 'av1' | 'original';
  /** How long a picture followed by something else shows, in milliseconds. */
  pictureMs: number;
};

export const DEFAULT_SETTINGS: PlaySettings = { video: 'h264', pictureMs: 10_000 };

const VIDEO_SETTINGS: readonly PlaySettings['video'][] = ['h264', 'av1', 'original'];

/** The settings `config` gives (`video`, `picture`), throwing on one it gets wrong. */
export const playSettings = (config: Record<string, string>): PlaySettings => {
  const video = (config.video ?? '').trim() || DEFAULT_SETTINGS.video;
  if (!VIDEO_SETTINGS.includes(video as PlaySettings['video'])) throw new Error(`video=${video}: one of ${VIDEO_SETTINGS.join(', ')}`);
  const picture = (config.picture ?? '').trim();
  const seconds = picture ? Number(picture) : DEFAULT_SETTINGS.pictureMs / 1000;
  if (!(seconds > 0 && seconds <= 3600)) throw new Error(`picture=${picture}: a number of seconds, up to 3600`);
  return { video: video as PlaySettings['video'], pictureMs: seconds * 1000 };
};

/** One thing for a device to play: where it fetches it, its type, the title it shows, and whether it is live. */
export type Media = { url: string; contentType: string; title: string; live?: boolean };

/** What a device says of itself and of what it plays, over whichever way it was asked. */
export type Status = {
  /** 0 to 1. */
  volume?: number;
  muted?: boolean;
  player: 'playing' | 'paused' | 'buffering' | 'idle';
  /** What it plays, as one line (title, artist and app); null when nothing. */
  playing: string | null;
  /** The address of what the player EiN gives to plays, as it was given. */
  url?: string;
  /** It stopped because it could not play `url`. */
  failed?: boolean;
  /** It went back to its own idle screen, which no other app took (a Cast device). */
  letGo?: boolean;
  /** How far into `url`, in seconds. */
  seconds?: number;
  /** How long `url` is, in seconds, when it says. */
  duration?: number;
};

export type WayCommand =
  | { type: 'volume'; level: number }
  | { type: 'mute'; muted: boolean }
  | { type: 'play' | 'pause' | 'stop' | 'next' }
  | { type: 'seek'; seconds: number };

/** One protocol a device is reached by. */
export type Way = {
  kind: 'cast' | 'dlna';
  /** It plays a queue itself; else it is given each item when the one before ended. */
  queues: boolean;
  status(): Promise<Status>;
  command(command: WayCommand): Promise<void>;
  /** Plays `items` from `start`, `seconds` into it, in place of what it played: the queue, or that item alone. */
  load(items: Media[], start: number, seconds: number): Promise<void>;
  /** Which of `types`, the best first, it plays; unset for a way that does not say, which is given the first. */
  pick?(types: string[]): Promise<string | undefined>;
};

/** The device does not answer over this way at all, so the next may be tried. */
export class Unreachable extends Error {}

/** A queue given to a device lets go of again within this is left. */
const REGIVE_WINDOW_MS = 5 * 60_000;
/** A renderer stopped this close to where its item should end has ended it; a picture this close to its end is moved on from. */
const END_SLACK_MS = 5000;
/** A renderer playing this close to an item's end, without moving on, has ended it. */
const AT_END_S = 2;
/** A renderer given something that has not begun to play in this long is let go. */
const START_MS = 30_000;
/** The largest original a device is given as it is under `video=h264`: 1080p, either way up. */
const H264_LONG_SIDE = 1920;
const H264_SHORT_SIDE = 1080;
/** The originals a device reads as MP4. */
const MP4_TYPES = new Set(['video/mp4', 'video/quicktime']);
/** The pictures a device is given as they are when they have no rendition, if it takes them. */
const PICTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/avif', 'image/webp', 'image/gif']);

/**
 * EiN's address as devices on the network reach it: `setting` when it names one, else `http://` this
 * machine's address the network listener gives devices for the broker (`host:port`), on `port`.
 */
export const mediaAddress = (setting: string | undefined, broker: string | undefined, port: string | undefined): string | undefined => {
  const set = (setting ?? '').trim().replace(/\/+$/, '');
  if (set) return set;
  const host = broker?.replace(/:\d+$/, '');
  return host ? `http://${host}:${port || '8080'}` : undefined;
};

/**
 * A thing made for a device to fetch: where, how to keep it and let it go, and how to begin making
 * what the device fetches first when it plays it from a second, before it is given or told to seek.
 */
export type Made = { url: string; renew?(): void; release(): void; prepare?(seconds: number): void };

/**
 * One way a line can reach a device, as the type it fetches; made only when it is the one given.
 * `stream` is one stream made while it is read, whose length nobody knows up front.
 */
type Form = { contentType: string; live?: boolean; stream?: boolean; make(access: Access, address: string): Promise<Made> };

/** A line written to the device, as what it is and the forms it can go in, the best first; with none, why. */
type Entry = { line: string; title: string; picture: boolean; forms: Form[]; why?: string };

/** One thing in a list: the line, the form it went in, and what was made for it. */
type Item = Media & { entry: Entry; form: Form; made: Made };

type Given = {
  via: Way['kind'];
  items: Item[];
  access: Access;
  settings: PlaySettings;
  /** When it was last given, so a status asked before is not taken as the device's answer to it. */
  at: number;
  /** When it was last given again. */
  regivenAt?: number;
  /** Where the device was in it at the last poll. */
  index: number;
  /** When the device was first seen at `index`. */
  since: number;
  seconds: number;
  player: Status['player'];
  /** When the item a renderer plays should end; infinite while it is paused. */
  endsAt?: number;
  wake?: ReturnType<typeof setTimeout>;
};

/** A path as a URL's, each part encoded. */
const urlPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** `source` as a stream that can be stopped while another reads it. */
const stoppable = (source: ReadableStream<Uint8Array>): { body: ReadableStream<Uint8Array>; stop(): void } => {
  const reader = source.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start: (each) => {
      controller = each;
    },
    async pull(each) {
      const { value, done } = await reader.read();
      if (done) each.close();
      else each.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return {
    body,
    stop: () => {
      reader.cancel().catch(() => {});
      try {
        controller?.close();
      } catch { /* already closed */ }
    },
  };
};

/** A node's `mirror`, as a shell round trip may have left it. */
const mirrored = (value: unknown): boolean => value === true || value === 'true' || value === 1 || value === '1';

/** A quarter turn, from a node's `angle`; anything else is upright. */
const angleOf = (value: unknown): number => {
  const turn = ((Math.round(Number(value)) % 360) + 360) % 360;
  return turn === 90 || turn === 180 || turn === 270 ? turn : 0;
};

type FileAttrs = {
  mimetype?: string;
  title?: unknown;
  name?: unknown;
  size?: number;
  duration?: unknown;
  codec?: unknown;
  width?: unknown;
  height?: unknown;
  angle?: unknown;
  mirror?: unknown;
};

export class MediaPlayer {
  readonly #given = new Map<string, Given>();

  constructor(
    private readonly host?: MediaHost,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** `ways`, the one the device was given its list over first. */
  #ordered(device: string, ways: Way[]): Way[] {
    const via = this.#given.get(device)?.via;
    return [...ways.filter((way) => way.kind === via), ...ways.filter((way) => way.kind !== via)];
  }

  /** `act` over the first of `ways` that answers. */
  async #first<T>(ways: Way[], act: (way: Way) => Promise<T>): Promise<T> {
    let unreachable: unknown;
    for (const way of ways) {
      try {
        return await act(way);
      } catch (error) {
        if (!(error instanceof Unreachable)) throw error;
        unreachable = error;
      }
    }
    throw unreachable ?? new Error('there is no way to reach it');
  }

  /** Plays or shows what the lines of `text` name on the device, as `access`, the writer's, in place of what it played. */
  async play(device: string, ways: Way[], text: string, access: Access, settings: PlaySettings = DEFAULT_SETTINGS): Promise<{ message: string }> {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error('write the paths of what to play, one per line');
    const relative = lines.find((line) => !line.startsWith('/'));
    if (relative) throw new Error(`${relative}: write a path from /, as find /music prints it`);
    let asked: Promise<MediaService> | undefined;
    const service = () => asked ??= this.host?.mediaService?.() ?? Promise.resolve({ video: true, pages: true });
    const entries = await this.#entries(lines, access, settings, service);
    const address = this.host?.address();
    if (!address) throw new Error('EiN does not know its address on the network to give it: set CFG_DEVICES_MEDIA_URL');
    const { way, items } = await this.#first(ways, async (way) => {
      const items = await this.#made(await this.#chosen(way, entries), access, address);
      try {
        items[0].made.prepare?.(0);
        await way.load(items, 0, 0);
      } catch (error) {
        this.#drop(items);
        throw error;
      }
      return { way, items };
    });
    this.forget(device);
    const now = Date.now();
    const given: Given = { via: way.kind, items, access: access, settings, at: now, since: now, index: 0, seconds: 0, player: 'buffering' };
    this.#given.set(device, given);
    this.#pictureEnds(device, given);
    return { message: items.length === 1 ? `playing ${items[0].title}` : `playing ${items.length} things, from ${items[0].title}` };
  }

  /**
   * The recording, video or picture at `path` as a browser hands it to a screen near it, one EiN
   * does not reach itself, made for that screen to fetch as `access`: the first of the forms a
   * device is given under `video=h264` that is a file, or HLS of the video's whole length. Not one
   * stream whose length is unknown: a browser takes such a video's length to be what it has read of
   * it, and Chrome hands a screen nothing shorter than 15 s. A recording's or video's transcript, a
   * WebVTT file, goes with it as `captions`, for a screen that draws them. Each `url` is a path on
   * EiN's own address, at whichever the browser reached EiN.
   */
  async nearby(path: string, access: Access): Promise<{ media: Media & { captions?: string }; made: Made }> {
    if (!path.startsWith('/')) throw new Error(`${path}: write a path from /`);
    let asked: Promise<MediaService> | undefined;
    const service = () => asked ??= this.host?.mediaService?.() ?? Promise.resolve({ video: true, pages: true });
    const [entry] = await this.#entries([path], access, DEFAULT_SETTINGS, service);
    if (entry.forms.some((form) => form.live)) throw new Error(`${path} is not a recording, a video or a picture`);
    if (!entry.forms.length) {
      throw new Error(
        entry.picture ? `${path}: a screen is given only JPEG, PNG, AVIF, WebP or GIF` : `${path}: it goes as H.264 made by the media service, which is not there`,
      );
    }
    const form = entry.forms.find((each) => !each.stream);
    if (!form) throw new Error(`${path}: its length is not known, and a browser hands a screen only a video whose length it knows`);
    const made = await form.make(access, '');
    const transcript = entry.picture ? undefined : await this.#transcript(path, access);
    if (!transcript) return { media: { url: made.url, contentType: form.contentType, title: entry.title }, made };
    return {
      media: { url: made.url, contentType: form.contentType, title: entry.title, captions: transcript.url },
      made: {
        url: made.url,
        renew: () => (made.renew?.(), transcript.renew?.()),
        release: () => (made.release(), transcript.release()),
        ...(made.prepare ? { prepare: made.prepare } : {}),
      },
    };
  }

  /** The transcript of the recording or video at `path`, with a ticket of its own; undefined when it has none `access` reads. */
  async #transcript(path: string, access: Access): Promise<Made | undefined> {
    const file = `${path}/metadata/transcript`;
    const node = await this.host!.vfs.get(access, file).catch(() => undefined);
    if (node?.type !== 'file' || !(node.attrs as FileAttrs).size) return undefined;
    return await this.#ticketed(file, access, '').catch(() => undefined);
  }

  /** The line, as it was written, of what the device plays of what EiN gave it; undefined when nothing. */
  showing(device: string): string | undefined {
    const given = this.#given.get(device);
    return given?.items[given.index]?.entry.line;
  }

  /** What the device says, over the way it was given its list, else the first that answers; with what it played acted on. */
  async status(device: string, ways: Way[]): Promise<Status> {
    const asked = Date.now();
    return await this.#first(this.#ordered(device, ways), async (way) => {
      const status = await way.status();
      await this.polled(device, way, status, asked);
      return status;
    });
  }

  /** Tells the device `command`, over the way it was given its list, else the first that answers. */
  async command(device: string, ways: Way[], command: WayCommand): Promise<void> {
    const ordered = this.#ordered(device, ways);
    if (command.type === 'stop') this.forget(device);
    if (command.type === 'seek') {
      const given = this.#given.get(device);
      given?.items[given.index]?.made.prepare?.(command.seconds);
    }
    await this.#first(ordered, (way) => way.command(command));
  }

  /** What the device said over `way` at a poll that began at `asked`: tickets renewed, the next given, or the list given again or let go. */
  async polled(device: string, way: Way, status: Status, asked: number): Promise<void> {
    const given = this.#given.get(device);
    if (!given || given.via !== way.kind || given.at > asked) return;
    const index = status.url ? given.items.findIndex((item) => item.url === status.url) : -1;
    if (index >= 0 && status.failed) {
      this.log(`${device} could not play ${given.items[index].entry.line}`);
      return this.forget(device);
    }
    if (!way.queues && status.player === 'idle' && (index >= 0 || !status.url)) return await this.#stopped(device, way, given, index >= 0 ? index : given.index);
    if (index >= 0) {
      const seconds = status.seconds ?? 0;
      // Some renderers stay `PLAYING` at the end of a recording, the position no longer moving.
      const stuck = !way.queues && status.player === 'playing' && given.player === 'playing' && given.index === index && given.seconds === seconds &&
        status.duration !== undefined && seconds >= status.duration - AT_END_S;
      if (stuck) return await this.#next(device, way, given, index);
      this.#renew(given);
      if (index !== given.index) given.since = asked;
      Object.assign(given, { index, seconds, player: status.player });
      if (given.items[index].entry.picture) return await this.#pictureShown(device, way, given, asked);
      if (!way.queues) this.#expect(device, given, status, asked);
      return;
    }
    const letGo = status.letGo && (given.player === 'playing' || given.player === 'buffering' || given.player === 'paused');
    if (!letGo || (given.regivenAt !== undefined && Date.now() - given.regivenAt < REGIVE_WINDOW_MS)) return this.forget(device);
    await this.#regive(device, way, given).catch((error) => {
      this.log(`${device} let go of what it played, and would not take it again: ${message(error)}`);
      this.forget(device);
    });
  }

  /** Let go of what the device was given: stopped, or given something else. */
  forget(device: string): void {
    const given = this.#given.get(device);
    if (!given) return;
    clearTimeout(given.wake);
    this.#drop(given.items);
    this.#given.delete(device);
  }

  /** A picture the device shows: the next given once it has shown for its time, else a poll asked for then. */
  async #pictureShown(device: string, way: Way, given: Given, asked: number): Promise<void> {
    if (given.index + 1 >= given.items.length) return;
    if (asked < given.since + given.settings.pictureMs - END_SLACK_MS) return this.#pictureEnds(device, given);
    try {
      given.items[given.index + 1].made.prepare?.(0);
      if (way.queues) await way.command({ type: 'next' });
      else await way.load(given.items, given.index + 1, 0);
    } catch (error) {
      this.log(`${device} would not move on from ${given.items[given.index].entry.line}: ${message(error)}`);
      return this.forget(device);
    }
    const now = Date.now();
    Object.assign(given, { at: now, since: now, index: given.index + 1, seconds: 0, player: 'buffering', endsAt: undefined });
    this.#pictureEnds(device, given);
  }

  /** When the device shows a picture that something follows, a poll asked for as its time ends. */
  #pictureEnds(device: string, given: Given): void {
    clearTimeout(given.wake);
    const wake = this.host?.wake;
    if (!wake || !given.items[given.index]?.entry.picture || given.index + 1 >= given.items.length) return;
    given.wake = setTimeout(() => wake(device), Math.max(0, given.since + given.settings.pictureMs - Date.now()) + 500);
  }

  /** When the item a renderer plays should end, and a poll asked for then. */
  #expect(device: string, given: Given, status: Status, asked: number): void {
    if (status.player === 'paused') given.endsAt = Infinity;
    else if (status.player === 'playing') given.endsAt = status.duration ? asked + (status.duration - (status.seconds ?? 0)) * 1000 : undefined;
    clearTimeout(given.wake);
    const wake = this.host?.wake;
    if (wake && given.endsAt !== undefined && Number.isFinite(given.endsAt)) given.wake = setTimeout(() => wake(device), Math.max(0, given.endsAt - Date.now()) + 1500);
  }

  /** A renderer that stopped at `index`: given the next when that one ended, else let go. */
  async #stopped(device: string, way: Way, given: Given, index: number): Promise<void> {
    if (given.player === 'buffering') {
      if (Date.now() - given.at > START_MS) {
        this.log(`${device} did not begin to play ${given.items[index].entry.line}`);
        this.forget(device);
      }
      return;
    }
    if (given.player !== 'playing') return this.forget(device);
    const ended = given.endsAt === undefined || Date.now() >= given.endsAt - END_SLACK_MS;
    if (!ended) return this.forget(device);
    await this.#next(device, way, given, index);
  }

  /** A renderer that ended the item at `index`: given the one after, else let go. */
  async #next(device: string, way: Way, given: Given, index: number): Promise<void> {
    if (index + 1 >= given.items.length) return this.forget(device);
    this.#renew(given);
    try {
      await way.load(given.items, index + 1, 0);
    } catch (error) {
      this.log(`${device} would not take ${given.items[index + 1].entry.line}: ${message(error)}`);
      return this.forget(device);
    }
    const now = Date.now();
    Object.assign(given, { at: now, since: now, index: index + 1, seconds: 0, player: 'buffering', endsAt: undefined });
    this.#pictureEnds(device, given);
  }

  async #regive(device: string, way: Way, given: Given): Promise<void> {
    const address = this.host?.address();
    if (!address) throw new Error('EiN no longer knows its address on the network');
    const items = await this.#made(given.items.slice(given.index), given.access, address);
    this.#drop(given.items);
    given.items = items;
    items[0].made.prepare?.(given.seconds);
    await way.load(items, 0, given.seconds);
    const now = Date.now();
    Object.assign(given, { at: now, regivenAt: now, since: now, index: 0 });
    this.#pictureEnds(device, given);
    this.log(`${device} let go of what it played; given again from ${items[0].title}`);
  }

  /**
   * What each line names, and the forms it can reach a device in, asking `service` what the media
   * service makes for a video or a page; throws naming a line that names nothing it can play.
   */
  async #entries(lines: string[], access: Access, settings: PlaySettings, service: () => Promise<MediaService>): Promise<Entry[]> {
    const vfs = this.host!.vfs;
    const { table } = await readRenditionTable(vfs);
    const nodes = await Promise.all(lines.map((line) => vfs.get(access, line).catch(() => undefined)));
    // `find <folder> -type f` lists each file's renditions under it too, which are left out unless
    // they are all there is.
    const rendition = (at: number) => nodes[at]?.attrs.sourceId != null;
    const originals = lines.some((_, at) => nodes[at] && !rendition(at));
    const entries: Entry[] = [];
    for (const [at, line] of lines.entries()) {
      const node = nodes[at];
      if (originals && rendition(at)) continue;
      if (!node) {
        const folder = `/${line.split('/')[1]?.split('?')[0] ?? ''}`;
        if (folder === '/' || await vfs.get(access, folder).then(() => true, () => false)) throw new Error(`${line}: no such file`);
        if (at < lines.length - 1) throw new Error(`${line}: a page plays until it is stopped, so it can only be the last line`);
        if (!this.host?.streamPage || !(await service()).pages) throw new Error(`${line}: no such file, and pages are rendered by the media service, which is not there`);
        entries.push(this.#page(line));
        continue;
      }
      const attrs = node.attrs as FileAttrs;
      const mimetype = attrs.mimetype ?? '';
      if (node.type !== 'file' || !/^(audio|video|image)\//.test(mimetype)) {
        throw new Error(`${line} is not a recording, a video or a picture; write the files to play, as find ${line} -type f prints them`);
      }
      const title = typeof attrs.title === 'string' && attrs.title
        ? attrs.title
        : typeof attrs.name === 'string' && attrs.name
        ? attrs.name
        : line.slice(line.lastIndexOf('/') + 1);
      const made = async (role: string | undefined): Promise<string | undefined> => {
        if (!role) return undefined;
        const file = `${line}/thumbnails/${role}`;
        const rendition = await vfs.get(access, file).catch(() => undefined);
        return (rendition?.attrs as FileAttrs | undefined)?.size ? file : undefined;
      };
      const file = (path: string, contentType: string): Form => ({ contentType, make: (access, address) => this.#ticketed(path, access, address) });
      if (mimetype.startsWith('audio/')) {
        const playback = await made(table.audio.playback ? audioFileName(table.audio.playback) : undefined);
        entries.push({ line, title, picture: false, forms: [...(playback ? [file(playback, 'audio/mp4')] : []), file(line, mimetype)] });
      } else if (mimetype.startsWith('image/')) {
        const sizes = Object.values(table.image).filter((each) => each.kinds.includes('photo')).sort((a, b) => b.width * b.height - a.width * a.height);
        let rendition: string | undefined;
        for (const size of sizes) if (!rendition) rendition = await made(imageFileName(size));
        const forms = [...(rendition ? [file(rendition, 'image/avif')] : []), ...(PICTURE_TYPES.has(mimetype) ? [file(line, mimetype)] : [])];
        entries.push({ line, title, picture: true, forms });
      } else {
        const playback = settings.video === 'av1' ? await made(table.video.playback ? videoFileName(table.video.playback) : undefined) : undefined;
        const files = this.#videoFiles(line, attrs, settings, playback, file);
        const streams = (await service()).video ? this.#videoStreams(line, attrs) : [];
        const why = 'a device is given it as H.264 by the media service, which is not there; set video=original for a device that plays the original';
        entries.push({ line, title, picture: false, forms: [...files, ...streams], ...(streams.length ? {} : { why }) });
      }
    }
    return entries;
  }

  /** The files of a video the device is given as they are, as `settings` says. */
  #videoFiles(path: string, attrs: FileAttrs, settings: PlaySettings, playback: string | undefined, file: (path: string, type: string) => Form): Form[] {
    if (settings.video === 'original') return [file(path, attrs.mimetype!)];
    if (settings.video === 'av1') return playback ? [file(playback, 'video/mp4')] : [];
    const [width, height] = [Number(attrs.width), Number(attrs.height)];
    const fits = Math.max(width, height) <= H264_LONG_SIDE && Math.min(width, height) <= H264_SHORT_SIDE;
    const upright = angleOf(attrs.angle) === 0 && !mirrored(attrs.mirror);
    return attrs.codec === 'h264' && fits && upright && MP4_TYPES.has(attrs.mimetype!) ? [file(path, 'video/mp4')] : [];
  }

  /** A video as H.264 made by the media service while it plays: HLS when its length is known, and one stream in each form. */
  #videoStreams(path: string, attrs: FileAttrs): Form[] {
    const host = this.host!;
    const stream = host.streamVideo;
    if (!stream) return [];
    const source = { angle: angleOf(attrs.angle), mirror: mirrored(attrs.mirror), ...(typeof attrs.codec === 'string' && attrs.codec ? { codec: attrs.codec } : {}) };
    const duration = Number(attrs.duration);
    const hls: Form[] = duration > 0
      ? [{
        contentType: 'application/x-mpegurl',
        make: (_access, address) => {
          const video = new HlsVideo((start, length) => stream(path, { ...source, start, duration: length, sourceClock: true, format: 'mpegts' }), duration);
          const served = host.devices.serveFiles((name) => video.get(name));
          return Promise.resolve({
            url: `${address}${served.path}/index.m3u8`,
            release: () => (served.end(), video.close()),
            prepare: (seconds) => video.prepare(seconds),
          });
        },
      }]
      : [];
    const live = (extension: 'ts' | 'mp4', contentType: string): Form => ({
      contentType,
      stream: true,
      make: (_access, address) => {
        // One reader at a time: a player that opens it again has let go of the last.
        let reading: { stop(): void } | undefined;
        const served = host.devices.serveLive(async (format) => {
          reading?.stop();
          const body = stoppable(await stream(path, { ...source, format: format === 'ts' ? 'mpegts' : 'mp4' }));
          reading = body;
          return body.body;
        });
        return Promise.resolve({ url: `${address}${served.path}.${extension}`, release: () => (served.end(), reading?.stop()) });
      },
    });
    return [...hls, live('ts', 'video/mp2t'), live('mp4', 'video/mp4')];
  }

  /** A page of EiN, as live video, in the forms a renderer and a Cast player take. */
  #page(route: string): Entry {
    const stream = this.host!.streamPage!;
    const page = (extension: 'ts' | 'mp4', contentType: string): Form => ({
      contentType,
      live: true,
      make: async (access, address) => {
        const streamed = await stream(route, access);
        return { url: `${address}${streamed.path}.${extension}`, release: () => void streamed.stop().catch(() => {}) };
      },
    });
    return { line: route, title: route, picture: false, forms: [page('ts', 'video/mp2t'), page('mp4', 'video/mp4')] };
  }

  /** The form of each entry that `way` plays; throws naming one it plays none of. */
  async #chosen(way: Way, entries: Entry[]): Promise<{ entry: Entry; form: Form }[]> {
    const chosen = [];
    for (const entry of entries) {
      const types = entry.forms.map((each) => each.contentType);
      if (!types.length) throw new Error(`${entry.line}: ${entry.why ?? 'there is no form of it a device plays here'}`);
      const type = way.pick ? await way.pick(types) : types[0];
      const form = entry.forms.find((each) => each.contentType === type);
      if (!form) throw new Error(`${entry.line}: it plays none of ${[...new Set(types)].join(', ')}`);
      chosen.push({ entry, form });
    }
    return chosen;
  }

  /** Each chosen form made for the device to fetch; what was made is let go of again when one cannot be. */
  async #made(chosen: { entry: Entry; form: Form }[], access: Access, address: string): Promise<Item[]> {
    const items: Item[] = [];
    try {
      for (const { entry, form } of chosen) {
        const made = await form.make(access, address);
        items.push({ url: made.url, contentType: form.contentType, title: entry.title, ...(form.live ? { live: true } : {}), entry, form, made });
      }
    } catch (error) {
      this.#drop(items);
      throw error;
    }
    return items;
  }

  async #ticketed(file: string, access: Access, address: string): Promise<Made> {
    const devices = this.host!.devices;
    const ticket = await devices.fileTicket(access, file);
    return { url: `${address}/file${urlPath(file)}?ticket=${ticket}`, renew: () => devices.renewFileTicket(ticket), release: () => devices.dropFileTicket(ticket) };
  }

  #renew(given: Given): void {
    for (const item of given.items) item.made.renew?.();
  }

  #drop(items: Item[]): void {
    for (const item of items) item.made.release();
  }
}

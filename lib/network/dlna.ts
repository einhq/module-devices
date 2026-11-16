/**
 * A DLNA renderer (UPnP AV's `MediaRenderer`), as much as playing on it takes: its description,
 * found at the address it answered SSDP with, names the control address of its services, each asked
 * over SOAP. AVTransport is given one address at a time (`SetAVTransportURI`, then `Play`) and says
 * what it plays and how far in; RenderingControl has the volume and mute; ConnectionManager's
 * `GetProtocolInfo` says which types it plays. It fetches what it is given itself.
 *
 * A renderer has no queue of its own that every one keeps, so the player gives it the next when one
 * ends (`play.ts`).
 */

import type { Fetch } from './adopt.ts';
import { child, escapeXml, find, findAll, parseXml, textOf, type XmlElement } from '../cameras/xml.ts';
import { type Media, type Status, Unreachable, type Way, type WayCommand } from './play.ts';

const TIMEOUT_MS = 8000;
/** How long a renderer that was just stopped may refuse a new address (UPnP 705, transport locked). */
const LOCKED_MS = 8000;

type Service = { type: string; control: string };
/** A renderer's services, by their short name (`AVTransport`). */
type Services = Record<string, Service>;

/** A renderer's refusal: its UPnP error code (714, illegal MIME type) and description. */
export class UpnpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** Every device the description names, the root first, then those inside it. */
const devicesOf = (from: XmlElement | undefined): XmlElement[] => findAll(from, 'device').flatMap((device) => [device, ...devicesOf(child(device, 'deviceList'))]);

/** The services of the renderer the description at `location` describes, at addresses from it. */
export const readDescription = (xml: string, location: string): Services => {
  const root = parseXml(xml);
  const base = textOf(root, 'URLBase') ?? location;
  const renderer = devicesOf(root).find((device) => /:MediaRenderer:/.test(child(device, 'deviceType')?.text ?? ''));
  if (!renderer) throw new Error('it describes no media renderer');
  const services: Services = {};
  for (const service of findAll(child(renderer, 'serviceList'), 'service')) {
    const type = textOf(service, 'serviceType');
    const control = textOf(service, 'controlURL');
    const name = type?.match(/:service:(\w+):\d+$/)?.[1];
    if (type && control && name && !services[name]) services[name] = { type, control: new URL(control, base).href };
  }
  if (!services.AVTransport) throw new Error('its renderer has no AVTransport');
  return services;
};

/** The names files are often given for a type, as the one renderers list it by. */
const SAME_TYPE: Record<string, string> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/aac': 'audio/vnd.dlna.adts',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-flac': 'audio/flac',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'video/x-m4v': 'video/mp4',
};

/** A MIME type as a renderer lists it: without parameters, in lower case, by its usual name. */
const listedType = (type: string): string => {
  const bare = type.split(';')[0].trim().toLowerCase();
  return SAME_TYPE[bare] ?? bare;
};

/** The MIME types of a `GetProtocolInfo` sink list (`http-get:*:audio/mp4:DLNA.ORG_PN=AAC_ISO,…`). */
export const sinkTypes = (sink: string): string[] => [
  ...new Set(
    sink.split(',').map((each) => each.trim().split(':')).filter((parts) => parts[0] === 'http-get' && parts[2]).map((parts) => listedType(parts[2])),
  ),
];

/** `H:MM:SS` (with a fraction, or `NOT_IMPLEMENTED`) in seconds; undefined when it says none. */
export const clockSeconds = (text: string | undefined): number | undefined => {
  const match = text?.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
};

const UPNP_CLASS: Record<string, string> = { audio: 'object.item.audioItem.musicTrack', video: 'object.item.videoItem', image: 'object.item.imageItem.photo' };

/**
 * What a renderer is told of how an address may be read, as a DLNA media server says it: by byte
 * range (OP=01), not converted (CI=0), streamed, in the background, paused by stalling the
 * connection (FLAGS). Without it the 2014 Philips TV offered only Stop, not Pause or Seek.
 */
const DLNA_FEATURES = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';

/** The DIDL-Lite a renderer is given with an address: its title, kind, type and how it may be read. */
export const didl = (media: Media): string =>
  '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
  `<item id="1" parentID="0" restricted="1"><dc:title>${escapeXml(media.title)}</dc:title>` +
  `<upnp:class>${UPNP_CLASS[media.contentType.split('/')[0]] ?? 'object.item'}</upnp:class>` +
  `<res protocolInfo="http-get:*:${escapeXml(listedType(media.contentType))}:${DLNA_FEATURES}">${escapeXml(media.url)}</res></item></DIDL-Lite>`;

/** Seconds as AVTransport's `H:MM:SS`. */
const relTime = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};

/** AVTransport's states, as the player's. */
const PLAYER: Record<string, Status['player']> = { PLAYING: 'playing', PAUSED_PLAYBACK: 'paused', TRANSITIONING: 'buffering' };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The descriptions read, by address, kept while they answer. */
const described = new Map<string, Promise<Services>>();
/** The types each renderer plays, by its description's address. */
const playable = new Map<string, Promise<string[]>>();

/**
 * The renderer whose description is at `location`, as a way to play on it. Its services are read
 * once and asked again after one does not answer.
 */
export const createDlna = (fetcher: Fetch, location: string): Way => {
  const services = (): Promise<Services> => {
    let known = described.get(location);
    if (!known) {
      known = fetcher(location, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then(async (response) => {
        if (!response.ok) {
          await response.body?.cancel();
          throw new Unreachable(`its renderer's description answered ${response.status}`);
        }
        return readDescription(await response.text(), location);
      }, (error) => {
        throw new Unreachable(`cannot reach its renderer: ${error instanceof Error ? error.message : error}`);
      });
      described.set(location, known);
      known.catch(() => described.delete(location));
    }
    return known;
  };

  const call = async (name: string, action: string, args: Record<string, string> = {}): Promise<XmlElement> => {
    const service = (await services())[name];
    if (!service) throw new Error(`its renderer has no ${name}`);
    // ConnectionManager's actions take no instance; AVTransport's and RenderingControl's do.
    const inner = Object.entries(name === 'ConnectionManager' ? args : { InstanceID: '0', ...args }).map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`).join('');
    const body = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.type}">${inner}</u:${action}></s:Body></s:Envelope>`;
    const response = await fetcher(service.control, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${service.type}#${action}"` },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((error) => {
      described.delete(location);
      throw new Unreachable(`cannot reach its renderer: ${error instanceof Error ? error.message : error}`);
    });
    const text = await response.text();
    let answer: XmlElement;
    try {
      answer = parseXml(text);
    } catch {
      throw new Error(`its renderer answered ${action} with ${response.status}`);
    }
    if (!response.ok || find(answer, 'Fault')) {
      const code = Number(textOf(answer, 'errorCode'));
      const said = textOf(answer, 'errorDescription') ?? `${response.status}`;
      throw new UpnpError(`its renderer refused ${action}: ${said}${Number.isFinite(code) ? ` (${code})` : ''}`, Number.isFinite(code) ? code : undefined);
    }
    return find(answer, `${action}Response`) ?? answer;
  };

  /** Whether it answers `action` of `name` without a refusal; undefined when it refuses it. */
  const ask = (name: string, action: string, args?: Record<string, string>) =>
    call(name, action, args).catch((error) => {
      if (error instanceof Unreachable) throw error;
      return undefined;
    });

  return {
    kind: 'dlna',
    queues: false,
    status: async () => {
      const transport = await call('AVTransport', 'GetTransportInfo');
      const position = await ask('AVTransport', 'GetPositionInfo');
      const said = (text: string | undefined) => text && text !== 'NOT_IMPLEMENTED' ? text : undefined;
      // Many renderers give the title only with the whole medium.
      const media = said(textOf(position, 'TrackURI')) && said(textOf(position, 'TrackMetaData')) ? undefined : await ask('AVTransport', 'GetMediaInfo');
      const volume = Number(textOf(await ask('RenderingControl', 'GetVolume', { Channel: 'Master' }), 'CurrentVolume'));
      const muted = textOf(await ask('RenderingControl', 'GetMute', { Channel: 'Master' }), 'CurrentMute');
      const state = textOf(transport, 'CurrentTransportState') ?? '';
      const metadata = said(textOf(position, 'TrackMetaData')) ?? said(textOf(media, 'CurrentURIMetaData'));
      let title: string | undefined, artist: string | undefined;
      try {
        const item = metadata ? parseXml(metadata) : undefined;
        title = textOf(item, 'title');
        artist = textOf(item, 'artist') ?? textOf(item, 'creator');
      } catch {
        // Metadata that is not XML says nothing worth showing.
      }
      const player = PLAYER[state] ?? 'idle';
      const seconds = clockSeconds(textOf(position, 'RelTime'));
      const duration = clockSeconds(textOf(position, 'TrackDuration'));
      const url = said(textOf(position, 'TrackURI')) ?? said(textOf(media, 'CurrentURI'));
      return {
        player,
        playing: player === 'idle' ? null : [title, artist].filter(Boolean).join(' – ') || null,
        ...(Number.isFinite(volume) ? { volume: volume / 100 } : {}),
        ...(muted !== undefined ? { muted: muted === '1' || muted === 'true' } : {}),
        ...(url ? { url } : {}),
        ...(textOf(transport, 'CurrentTransportStatus') === 'ERROR_OCCURRED' ? { failed: true } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(duration ? { duration } : {}),
      };
    },
    command: async (command: WayCommand) => {
      if (command.type === 'volume') {
        await call('RenderingControl', 'SetVolume', { Channel: 'Master', DesiredVolume: String(Math.round(Math.min(1, Math.max(0, command.level)) * 100)) });
      } else if (command.type === 'mute') {
        await call('RenderingControl', 'SetMute', { Channel: 'Master', DesiredMute: command.muted ? '1' : '0' });
      } else if (command.type === 'play') {
        await call('AVTransport', 'Play', { Speed: '1' });
      } else if (command.type === 'next') {
        throw new Error('a renderer has no list of its own; it is given the next itself');
      } else if (command.type === 'seek') {
        await call('AVTransport', 'Seek', { Unit: 'REL_TIME', Target: relTime(command.seconds) });
      } else {
        await call('AVTransport', command.type === 'pause' ? 'Pause' : 'Stop');
      }
    },
    load: async (items, start, seconds) => {
      const media = items[start];
      if (!media) throw new Error('nothing to play');
      await ask('AVTransport', 'Stop');
      // Straight after a stop, a renderer may hold its transport for a few seconds.
      for (const started = Date.now();;) {
        try {
          await call('AVTransport', 'SetAVTransportURI', { CurrentURI: media.url, CurrentURIMetaData: didl(media) });
          break;
        } catch (error) {
          if (!(error instanceof UpnpError && error.code === 705) || Date.now() - started > LOCKED_MS) throw error;
          await delay(1000);
        }
      }
      await call('AVTransport', 'Play', { Speed: '1' });
      if (seconds >= 1) await ask('AVTransport', 'Seek', { Unit: 'REL_TIME', Target: relTime(seconds) });
    },
    pick: async (types) => {
      let sinks = playable.get(location);
      if (!sinks) {
        sinks = call('ConnectionManager', 'GetProtocolInfo').then((answer) => sinkTypes(textOf(answer, 'Sink') ?? ''));
        playable.set(location, sinks);
        sinks.catch(() => playable.delete(location));
      }
      const plays = await sinks;
      return types.find((type) => plays.includes(listedType(type)));
    },
  };
};

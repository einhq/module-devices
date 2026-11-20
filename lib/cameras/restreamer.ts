/**
 * The restreamer cameras are given to: go2rtc's HTTP API, in the devices sidecar
 * (`CFG_DEVICES_STREAMS_URL`, as the account `ein` with `CFG_DEVICES_STREAMS_KEY`). It keeps
 * one connection to each source it is given and serves it again: MPEG-TS and fragmented MP4 to the driver, which writes them into the camera's stream nodes. A source is named
 * `<device>-<profile>`, and its address, with the camera's password in it, never leaves the driver
 * and the restreamer: go2rtc shows it masked.
 */

import type { StreamInfo } from '@ein/api';
import type { Fetch } from '../network/adopt.ts';

/** What the restreamer says of a source when it is asked to connect to it. */
type Probed = {
  producers?: { receivers?: { codec?: { codec_name?: string; codec_type?: string } }[] }[];
};

export type Restreamer = {
  /** The names of the sources it has now. */
  names(): Promise<Set<string>>;
  /** Gives it `source` as `name`, in place of what it had under that name. */
  put(name: string, source: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** What the source sends, the restreamer connecting to the camera to see: its video's codec and whether it has sound; throws when it sends no picture. */
  probe(name: string): Promise<StreamInfo>;
  /**
   * The source from now until `signal` aborts or the restreamer ends it, H.264 or H.265 with its
   * sound: as MPEG-TS (`ts`, go2rtc's `stream.ts`, which carries AAC sound alone), or as fragmented
   * MP4 (`mp4`, its `stream.mp4`, a fragment a frame, with AAC sound or G.711 as FLAC).
   */
  stream(name: string, format: StreamFormat, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
};

/** What the restreamer sends a source as: MPEG-TS or fragmented MP4. */
export type StreamFormat = 'ts' | 'mp4';

/** The query each format is asked with: MP4 takes G.711 sound too, as FLAC, which a browser plays. */
const FORMAT_QUERY: Record<StreamFormat, Record<string, string>> = { ts: {}, mp4: { mp4: 'flac' } };

const TIMEOUT_MS = 12_000;

export const createRestreamer = (fetcher: Fetch, base: string, password: string): Restreamer => {
  const root = base.replace(/\/+$/, '');
  const headers = { authorization: `Basic ${btoa(`ein:${password}`)}` };
  const ask = async (method: string, path: string, query: Record<string, string>): Promise<Response> => {
    const response = await fetcher(`${root}${path}?${new URLSearchParams(query)}`, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      const text = (await response.text()).trim();
      throw new Error(`the restreamer answered ${response.status}${text ? `: ${text}` : ''}`);
    }
    return response;
  };
  return {
    names: async () => new Set(Object.keys(await (await ask('GET', '/api/streams', {})).json() ?? {})),
    put: async (name, source) => void await (await ask('PUT', '/api/streams', { name, src: source })).body?.cancel(),
    remove: async (name) => void await (await ask('DELETE', '/api/streams', { src: name })).body?.cancel(),
    probe: async (name) => {
      const probed = await (await ask('GET', '/api/streams', { src: name, video: 'all', audio: 'all' })).json() as Probed;
      const codecs = (probed.producers ?? []).flatMap((producer) => producer.receivers ?? []).map((receiver) => receiver.codec ?? {});
      const video = codecs.find((codec) => codec.codec_type === 'video')?.codec_name;
      if (!video) throw new Error('it sends no picture');
      return { codec: video, audio: codecs.some((codec) => codec.codec_type === 'audio') };
    },
    stream: async (name, format, signal) => {
      const response = await fetcher(`${root}/api/stream.${format}?${new URLSearchParams({ src: name, ...FORMAT_QUERY[format] })}`, { headers, signal });
      if (!response.ok || !response.body) {
        const text = (await response.text().catch(() => '')).trim();
        throw new Error(`the restreamer answered ${response.status}${text ? `: ${text}` : ''}`);
      }
      return response.body;
    },
  };
};

/** A JPEG's width and height, from its first frame header; undefined for bytes that are not one. */
export const jpegSize = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    // SOF0 to SOF15, but for DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
    }
    at += 2 + length;
  }
  return undefined;
};

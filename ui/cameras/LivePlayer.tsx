import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import { type CSSProperties, useEffect, useRef } from 'react';
import { mediaTypeOf, Mp4Boxes } from './mp4.ts';

/** How far behind the newest frame the picture may fall before it jumps ahead, in seconds. */
const MAX_LAG_S = 2;

/** How much of what has been played is kept, in seconds; the rest is let go. */
const KEEP_S = 15;

/** How long a transcode made for this page runs on once nobody reads it, in seconds. */
const TRANSCODE_IDLE_S = 15;

type MediaSourceClass = typeof MediaSource;

/** Where a page's media comes from: Safari on an iPhone has only ManagedMediaSource. */
const mediaSourceClass = (): MediaSourceClass | undefined => (globalThis as unknown as { ManagedMediaSource?: MediaSourceClass }).ManagedMediaSource ?? globalThis.MediaSource;

export type LiveStatus = { state: 'connecting' | 'playing' | 'ended' | 'failed'; reason?: string };

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A stream node's bytes as they come, over `GET /file/…`; throws with what EiN answered when it cannot be read. */
const openStream = async (path: string, signal: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
  const response = await fetch(`/file${path.split('/').map(encodeURIComponent).join('/')}`, { signal, cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error((await response.text().catch(() => '')).trim() || `the stream answered ${response.status}`);
  return response.body.getReader();
};

/** A stream read up to its header (`ftyp` and `moov`): the header, and the boxes after it that came with it. */
const readHeader = async (reader: ReadableStreamDefaultReader<Uint8Array>, boxes: Mp4Boxes) => {
  const head: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the stream ended before its header');
    const cut = boxes.feed(value);
    const moov = cut.findIndex((box) => box.kind === 'moov');
    if (moov < 0) {
      head.push(...cut.map((box) => box.bytes));
      continue;
    }
    head.push(...cut.slice(0, moov + 1).map((box) => box.bytes));
    const header = new Uint8Array(head.reduce((total, part) => total + part.length, 0));
    head.reduce((at, part) => (header.set(part, at), at + part.length), 0);
    return { header, rest: cut.slice(moov + 1) };
  }
};

/**
 * A stream played as it comes: the stream node `/dev/<device>/<stream>`, fragmented MP4, read over
 * `GET /file/…` into a MediaSource, its header first. When the browser does not play its codecs (a
 * camera's HEVC in most browsers), the media service transcodes it into a node made for this page
 * (`stream-transcode`), which is read instead and stopped when the page lets go. It keeps a few
 * seconds and stays at the newest frame; a new header, as when the camera's stream started anew,
 * starts the picture over.
 */
export function LivePlayer({ device, stream, onStatus, controls, style }: {
  device: string;
  stream: string;
  onStatus: (status: LiveStatus) => void;
  /** The browser's own play and full-screen buttons. */
  controls?: boolean;
  style?: CSSProperties;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    const Source = mediaSourceClass();
    if (!element) return;
    if (!Source) {
      onStatus({ state: 'failed', reason: 'this browser cannot play a live stream (no Media Source Extensions)' });
      return;
    }
    const stop = new AbortController();
    /** What is read: the stream, or the transcode of it made for this page. */
    let path = `/dev/${device}/${stream}`;
    let transcode: string | undefined;
    element.disableRemotePlayback = true;

    /** A MediaSource on the element, once it is open. */
    const attach = () =>
      new Promise<MediaSource>((resolve) => {
        const source = new Source();
        const url = URL.createObjectURL(source);
        source.addEventListener('sourceopen', () => {
          URL.revokeObjectURL(url);
          resolve(source);
        }, { once: true });
        element.src = url;
      });

    /** The reader and header of what is read, the stream moved to its transcode when the browser does not play its own codecs. */
    const open = async () => {
      const boxes = new Mp4Boxes();
      const reader = await openStream(path, stop.signal);
      const { header, rest } = await readHeader(reader, boxes);
      const type = mediaTypeOf(header);
      if (type && Source.isTypeSupported(type)) return { reader, boxes, header, rest, type };
      await reader.cancel();
      if (transcode) throw new Error(`this browser does not play the transcoded stream (${type ?? 'an unknown codec'})`);
      onStatus({ state: 'connecting', reason: 'Transcoding for this browser…' });
      try {
        const started = await execCommand<{ id: string; output: string }>(
          `stream-transcode start ${shq(path)} --idle=${TRANSCODE_IDLE_S}`,
          { signal: stop.signal },
        );
        transcode = started.id;
        path = started.output;
        return await open();
      } catch (error) {
        if (stop.signal.aborted) throw error;
        throw new Error(`this browser does not play the camera's video (${type ?? 'an unknown codec'}), and it could not be transcoded: ${message(error)}`);
      }
    };

    /** Play from one reading of the stream until it ends or sends a new header: whether it did. */
    const play = async (): Promise<'ended' | 'header'> => {
      const { reader, boxes, header, rest, type } = await open();
      const source = await attach();
      const buffer = source.addSourceBuffer(type);
      buffer.mode = 'segments';
      const waiting: Uint8Array[] = [header];
      const append = () => {
        if (buffer.updating || waiting.length === 0 || source.readyState !== 'open') return;
        try {
          buffer.appendBuffer(waiting.shift()! as Uint8Array<ArrayBuffer>);
        } catch {
          // A full buffer: what was played is let go at the next update.
        }
      };
      buffer.addEventListener('updateend', () => {
        if (stop.signal.aborted || buffer.updating) return;
        if (waiting.length) return append();
        const ranges = buffer.buffered;
        if (!ranges.length) return;
        const start = ranges.start(ranges.length - 1);
        const end = ranges.end(ranges.length - 1);
        // A reader joins at a keyframe some way back, and its times are the stream's: start near the newest frame.
        if (element.currentTime < start || end - element.currentTime > MAX_LAG_S) element.currentTime = Math.max(start, end - 0.3);
        if (element.currentTime - ranges.start(0) > KEEP_S) buffer.remove(ranges.start(0), element.currentTime - KEEP_S);
      });
      const push = (parts: Uint8Array[]) => {
        if (!parts.length) return;
        const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
        parts.reduce((at, part) => (bytes.set(part, at), at + part.length), 0);
        waiting.push(bytes);
        append();
      };
      push(rest.map((box) => box.bytes));
      append();
      element.play().then(() => onStatus({ state: 'playing' })).catch(() => onStatus({ state: 'playing', reason: 'press play' }));
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return 'ended';
          const cut = boxes.feed(value);
          const again = cut.findIndex((box) => box.kind === 'ftyp');
          if (again >= 0) {
            push(cut.slice(0, again).map((box) => box.bytes));
            return 'header';
          }
          push(cut.map((box) => box.bytes));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    };

    void (async () => {
      onStatus({ state: 'connecting' });
      try {
        while (await play() === 'header') {
          if (stop.signal.aborted) return;
        }
        if (!stop.signal.aborted) onStatus({ state: 'ended' });
      } catch (error) {
        if (!stop.signal.aborted) onStatus({ state: 'failed', reason: message(error) });
      }
    })();

    return () => {
      stop.abort();
      if (transcode) void execCommand(`stream-transcode stop ${shq(transcode)}`).catch(() => {});
      element.removeAttribute('src');
      element.load();
    };
  }, [device, stream, onStatus]);
  return <video ref={video} muted playsInline controls={controls} style={{ background: 'black', ...style }} />;
}

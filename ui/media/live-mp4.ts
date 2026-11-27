/**
 * A live fragmented MP4 played as it comes, through a MediaSource rather than the element's own
 * loader: read without pause, its header first, a few seconds kept and the picture held at the
 * newest frame. A browser that loads an endless MP4 itself stops reading it once it holds enough,
 * and a stream nobody reads ends; it also jumps back to the start when it catches up.
 */

import { mediaTypeOf, Mp4Boxes } from './mp4.ts';

/** How far behind the newest frame the picture may fall before it jumps ahead, in seconds. */
const MAX_LAG_S = 2;

/** How much of what has been played is kept, in seconds; the rest is let go. */
const KEEP_S = 15;

type MediaSourceClass = typeof MediaSource;

/** Where a page's media comes from: Safari on an iPhone has only ManagedMediaSource. */
export const mediaSourceClass = (): MediaSourceClass | undefined =>
  (globalThis as unknown as { ManagedMediaSource?: MediaSourceClass }).ManagedMediaSource ?? globalThis.MediaSource;

/** A stream read up to its header: the reader, the header, the whole boxes after it read with it, and its tracks as a media type. */
export type LiveReading = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  boxes: Mp4Boxes;
  header: Uint8Array;
  rest: Uint8Array[];
  type: string | undefined;
};

/** `reader` read up to its header (`ftyp` and `moov`). */
export const readLive = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<LiveReading> => {
  const boxes = new Mp4Boxes();
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
    const header = joined(head);
    return { reader, boxes, header, rest: cut.slice(moov + 1).map((box) => box.bytes), type: mediaTypeOf(header) };
  }
};

const joined = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  parts.reduce((at, part) => (bytes.set(part, at), at + part.length), 0);
  return bytes;
};

/**
 * Play `reading` on `element` in a new MediaSource of `Source` until the stream ends or sends a new
 * header, as a camera's does when its stream starts anew: which it did. `type` must be one `Source`
 * plays. `started` is called once the header is given to the element, where it may be played.
 */
export const playLive = async (
  element: HTMLVideoElement,
  reading: LiveReading & { type: string },
  Source: MediaSourceClass,
  signal: AbortSignal,
  started: () => void = () => {},
): Promise<'ended' | 'header'> => {
  const { reader, boxes, header, rest, type } = reading;
  try {
    const source = await new Promise<MediaSource>((resolve) => {
      const source = new Source();
      const url = URL.createObjectURL(source);
      source.addEventListener('sourceopen', () => {
        URL.revokeObjectURL(url);
        resolve(source);
      }, { once: true });
      element.src = url;
    });
    const buffer = source.addSourceBuffer(type);
    buffer.mode = 'segments';
    const waiting: Uint8Array<ArrayBuffer>[] = [joined([header])];
    const append = () => {
      if (buffer.updating || waiting.length === 0 || source.readyState !== 'open') return;
      try {
        buffer.appendBuffer(waiting.shift()!);
      } catch {
        // A full buffer: what was played is let go at the next update.
      }
    };
    buffer.addEventListener('updateend', () => {
      if (signal.aborted || buffer.updating) return;
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
      waiting.push(joined(parts));
      append();
    };
    push(rest);
    append();
    started();
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

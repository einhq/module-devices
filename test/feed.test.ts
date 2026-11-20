/**
 * A camera's stream node fed from the restreamer: the source is read only while the node is
 * wanted, written on in whole packets however its chunks cut them, its program tables at the start
 * of each read made the stream's header, asked again after it ends, and let go when the node is no
 * longer wanted or the feed closes; fragmented MP4 written as its header and whole fragments, one
 * at a keyframe marked where a reader may start.
 */

import { assert, assertEquals } from '@std/assert';
import type { StreamWriter } from '@ein/client';
import { StreamFeed } from '../lib/cameras/feed.ts';
import { fragment, joined, mp4Header } from './mp4-boxes.ts';

/** A TS packet of `pid`, its payload `fill`. */
const packet = (pid: number, fill = 0xff): Uint8Array => {
  const bytes = new Uint8Array(188).fill(fill);
  bytes.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10]);
  return bytes;
};

/** A PAT naming one program, its PMT at PID 0x1000, as go2rtc sends it. */
const pat = (): Uint8Array => {
  const bytes = packet(0);
  bytes.set([0x00, 0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00, 0, 0, 0, 0], 4);
  return bytes;
};

/** A stream's writer as far as a feed uses it: what was written, and `wanted` set by hand. */
const fakeWriter = () => {
  const listeners = new Set<(wanted: boolean) => void>();
  const state = { wanted: false, closed: false, written: [] as Uint8Array[], headers: [] as Uint8Array[], starts: [] as Uint8Array[] };
  const writer = {
    id: 'fake',
    get wanted() {
      return state.wanted;
    },
    get closed() {
      return state.closed;
    },
    onWanted: (listener: (wanted: boolean) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    write: async (data: Uint8Array) => {
      state.written.push(data.slice());
      return data.length;
    },
    writeHeader: async (data: Uint8Array) => {
      state.headers.push(data.slice());
      return data.length;
    },
    writeStart: async (data: Uint8Array) => {
      state.starts.push(data.slice());
      state.written.push(data.slice());
      return data.length;
    },
    close: async () => {
      state.closed = true;
    },
  } as unknown as StreamWriter;
  const want = (wanted: boolean) => {
    state.wanted = wanted;
    for (const listener of listeners) listener(wanted);
  };
  return { writer, state, want };
};

const until = async (what: string, check: () => boolean): Promise<void> => {
  for (const end = Date.now() + 5000; Date.now() < end;) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what}: not yet`);
};

Deno.test('a stream node is fed from its source only while it is wanted, in whole packets', async () => {
  const { writer, state, want } = fakeWriter();
  const opened: { cancelled: boolean }[] = [];
  /** A source that sends 1.5 packets at once, so every other chunk ends inside a packet, and ends after `chunks`. */
  const source = (chunks: number) => (_signal: AbortSignal) => {
    const reading = { cancelled: false };
    opened.push(reading);
    let sent = 0;
    return Promise.resolve(
      new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (sent++ === chunks) return controller.close();
          const bytes = new Uint8Array(282).fill(sent);
          bytes[0] = 0x47;
          controller.enqueue(bytes);
        },
        cancel: () => void (reading.cancelled = true),
      }),
    );
  };
  const feed = new StreamFeed('/dev/porch/main.ts', writer, 'video/mp2t', source(1000), () => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(opened.length, 0);

  want(true);
  await until('bytes written', () => state.written.length >= 3);
  assert(state.written.every((chunk) => chunk.length % 188 === 0), `written ${state.written.map((chunk) => chunk.length)}`);
  assertEquals(state.written[0][0], 0x47);

  want(false);
  await until('the source let go', () => opened[0].cancelled);
  const written = state.written.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(state.written.length, written);

  await feed.close();
  assert(state.closed);
});

Deno.test('a source that ends is asked again while the node is wanted', async () => {
  const { writer, want } = fakeWriter();
  let opened = 0;
  const lines: string[] = [];
  const feed = new StreamFeed('/dev/porch/sub.ts', writer, 'video/mp2t', () => {
    opened++;
    return Promise.resolve(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }));
  }, (line) => lines.push(line));
  want(true);
  await until('asked again', () => opened >= 2);
  assertEquals(lines, ['/dev/porch/sub.ts: the restreamer ended the stream']);
  await feed.close();
});

Deno.test("each read's program tables are the stream's header, however its chunks cut them", async () => {
  const { writer, state, want } = fakeWriter();
  const tables = joined(pat(), packet(0x1000));
  const video = joined(packet(0x100, 1), packet(0x100, 2));
  const all = joined(tables, video);
  const feed = new StreamFeed('/dev/porch/main.ts', writer, 'video/mp2t', () =>
    Promise.resolve(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          // The PMT cut in two, and the first video packet with it.
          controller.enqueue(all.slice(0, 250));
          controller.enqueue(all.slice(250, 400));
          controller.enqueue(all.slice(400));
        },
      }),
    ), () => {});
  want(true);
  await until('the video written', () => state.written.reduce((total, chunk) => total + chunk.length, 0) >= video.length);
  assertEquals(state.headers[0], tables);
  assertEquals(joined(...state.written).subarray(0, video.length), video);
  await feed.close();
});

Deno.test('fragmented MP4 is written as its header and whole fragments, those at a keyframe where a reader may start', async () => {
  const { writer, state, want } = fakeWriter();
  const header = mp4Header();
  const all = joined(header, fragment(true, 1), fragment(false, 2), fragment(true, 3));
  const feed = new StreamFeed('/dev/porch/main.mp4', writer, 'video/mp4', () =>
    Promise.resolve(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (let at = 0; at < all.length; at += 50) controller.enqueue(all.slice(at, at + 50));
        },
      }),
    ), () => {});
  want(true);
  await until('the fragments written', () => state.written.length >= 3);
  assertEquals(state.headers, [header]);
  assertEquals(state.written, [fragment(true, 1), fragment(false, 2), fragment(true, 3)]);
  assertEquals(state.starts, [fragment(true, 1), fragment(true, 3)]);
  await feed.close();
});

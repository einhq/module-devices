/**
 * A video as HLS made while a screen plays it: a playlist of the whole video in short MPEG-TS
 * segments, each made by the media service when the player asks for it, on the video's own clock.
 * A Cast player seeks in it by asking for the segment it wants, whoever asked it to seek: EiN, a
 * phone or the TV's remote (ein/core#1333).
 *
 * A segment takes about a second to make and longer to cross Wi-Fi, so while one is sent the next
 * `AHEAD` are made. A Cast player begins to play once it holds 12 s, wherever in a segment it
 * starts, so those segments are begun before it asks for them, while it starts its app and reads
 * the playlist: where it is given the video, and where EiN tells it to seek (`prepare`). `LANES`
 * of them are made at once, so the 12 s a start or a seek waits for is two segments' time, not
 * four; a video holds that many of the media service's few encoders at a time. A segment asked
 * for out of turn, after a seek, drops what was made ahead. Nothing is made past `AHEAD` segments
 * after the last one asked for or prepared, so a player that lets go holds an encoder a few
 * seconds at most (ein/core#1340).
 */

import type { ServedFile } from '@ein/client';

/** Seconds in a segment: a seek fetches the whole segment it lands in before it plays. */
const SEGMENT_SECONDS = 4;
/** Segments made ahead of the one asked for: a Cast player holds 12 s before it plays, from wherever in a segment it starts. */
const AHEAD = 3;
/** Segments made at once: the media service's encoders a video uses while catching up to `AHEAD`. */
const LANES = 2;

/** The media service's stream of `duration` seconds of the video from `start`, on the video's clock, as MPEG-TS. */
type SegmentStream = (start: number, duration: number) => Promise<ReadableStream<Uint8Array>>;

type Segment = { bytes: Promise<Uint8Array<ArrayBuffer>>; cancel(): void };

export class HlsVideo {
  readonly #made = new Map<number, Segment>();
  readonly #count: number;
  /** Which run of making ahead is current: one begun before a seek stops. */
  #run = 0;
  /** One per lane: settles when the lane's segment made last is, which the next in that lane waits for. */
  readonly #turns: Promise<unknown>[] = Array.from({ length: LANES }, () => Promise.resolve());
  #closed = false;

  constructor(private readonly stream: SegmentStream, private readonly duration: number) {
    this.#count = Math.max(1, Math.ceil(duration / SEGMENT_SECONDS));
  }

  /** The playlist: every segment of the video, its length known. */
  playlist(): string {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    for (let n = 0; n < this.#count; n++) lines.push(`#EXTINF:${this.#length(n).toFixed(3)},`, `${n}.ts`);
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
  }

  /** Begin making the segment that holds `seconds` and the `AHEAD` after it, dropping any others: where the player will start, or seek to. */
  prepare(seconds: number): void {
    if (this.#closed) return;
    const n = Math.min(this.#count - 1, Math.max(0, Math.floor(seconds / SEGMENT_SECONDS)));
    this.#keep(n);
    this.#ahead(n, n + AHEAD, ++this.#run);
  }

  /** `index.m3u8` or a segment `<n>.ts`; undefined for anything else. Throws when the media service could not make a segment. */
  async get(name: string): Promise<ServedFile | undefined> {
    if (this.#closed) return undefined;
    if (name === 'index.m3u8') return { body: new TextEncoder().encode(this.playlist()), type: 'application/vnd.apple.mpegurl' };
    const match = /^(\d+)\.ts$/.exec(name);
    const n = match ? Number(match[1]) : -1;
    if (n < 0 || n >= this.#count) return undefined;
    this.#keep(n);
    const segment = this.#made.get(n) ?? this.#make(n);
    this.#made.delete(n);
    const run = ++this.#run;
    const body = await segment.bytes;
    this.#ahead(n + 1, n + AHEAD, run);
    return { body, type: 'video/mp2t' };
  }

  /** Stop making segments, and answer nothing from now on. */
  close(): void {
    this.#closed = true;
    for (const segment of this.#made.values()) segment.cancel();
    this.#made.clear();
  }

  #length(n: number): number {
    return Math.min(SEGMENT_SECONDS, this.duration - n * SEGMENT_SECONDS);
  }

  /** Stop making the segments outside `n` and the `AHEAD` after it. */
  #keep(n: number): void {
    for (const [at, segment] of this.#made) {
      if (at >= n && at <= n + AHEAD) continue;
      segment.cancel();
      this.#made.delete(at);
    }
  }

  /** Make the segments from `from` to `to` that are not made yet, `LANES` at once, while `run` is current. */
  async #ahead(from: number, to: number, run: number): Promise<void> {
    const end = Math.min(to, this.#count - 1);
    const segments: Segment[] = [];
    for (let n = from; n <= end; n++) {
      if (this.#closed || run !== this.#run) return;
      let segment = this.#made.get(n);
      if (!segment) this.#made.set(n, segment = this.#make(n));
      segments.push(segment);
    }
    for (const segment of segments) {
      if (this.#closed || run !== this.#run) return;
      if (!(await segment.bytes.then(() => true, () => false))) return;
    }
  }

  /** Segment `n`, made once its lane's previous segment is; cancelling it stops the media service's encoder. */
  #make(n: number): Segment {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;
    const lane = n % LANES;
    const before = this.#turns[lane];
    const bytes = (async () => {
      await before;
      if (cancelled) throw new Error('cancelled');
      const body = await this.stream(n * SEGMENT_SECONDS, this.#length(n));
      if (cancelled) {
        await body.cancel().catch(() => {});
        throw new Error('cancelled');
      }
      reader = body.getReader();
      const chunks: Uint8Array[] = [];
      for (let read = await reader.read(); !read.done; read = await reader.read()) chunks.push(read.value);
      if (cancelled) throw new Error('cancelled');
      const joined = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
      chunks.reduce((at, chunk) => (joined.set(chunk, at), at + chunk.length), 0);
      return joined;
    })();
    this.#turns[lane] = bytes.catch(() => {});
    return {
      bytes,
      cancel: () => {
        cancelled = true;
        reader?.cancel().catch(() => {});
      },
    };
  }
}

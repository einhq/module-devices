/**
 * One of a camera's stream nodes fed from the restreamer. The driver holds the node open as its
 * writer for as long as it runs; while the stream is wanted (someone reads it, or did a few seconds
 * ago) the feed reads the restreamer's bytes of the source and writes them on, cut by the node's
 * media type (`@ems/live/split`) so a reader who joins later is given the stream's header first
 * and then the bytes from its latest keyframe: MPEG-TS in whole 188-byte packets, its program tables
 * the restreamer sends once at the start of each read (go2rtc's PAT and PMT) the header, without
 * which a reader cannot tell what the stream holds; fragmented MP4 in whole fragments, its `ftyp`
 * and `moov` the header, which a browser's MediaSource needs before any fragment. A source that
 * ends, fails or sends nothing for `STALL_MS` is asked again after a pause that doubles from a
 * second up to half a minute, while it is still wanted, and its next read's header replaces the
 * last. Once it is not wanted, the restreamer is let go, which lets the camera go when nobody else
 * watches it there.
 */

import type { StreamWriter } from '@ein/client';
import { splitterFor } from '@ems/live/split';

/** How long a source may send nothing before it is asked again. */
const STALL_MS = 15_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** The source's bytes, from now until `signal` aborts. */
type FeedSource = (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A pause that ends early, quietly, when `signal` aborts. */
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

export class StreamFeed {
  #run?: AbortController;
  #closed = false;
  readonly #unlisten: () => void;

  /** `name` is what the log calls it: the node's path; `mimetype` what its bytes are. */
  constructor(
    private readonly name: string,
    private readonly writer: StreamWriter,
    private readonly mimetype: string,
    private readonly source: FeedSource,
    private readonly log: (line: string) => void,
  ) {
    this.#unlisten = writer.onWanted((wanted) => wanted ? this.#start() : this.#stop());
    if (writer.wanted) this.#start();
  }

  /** Whether it no longer feeds its node: closed, or its node's writer closed under it (the node removed). */
  get closed(): boolean {
    return this.#closed || this.writer.closed;
  }

  /** Stop reading the source, and close the node's writer, which ends the stream for its readers. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#unlisten();
    this.#stop();
    await this.writer.close();
  }

  #start(): void {
    if (this.#run || this.closed) return;
    const run = new AbortController();
    this.#run = run;
    void this.#loop(run.signal).finally(() => {
      if (this.#run === run) this.#run = undefined;
    });
  }

  #stop(): void {
    this.#run?.abort();
    this.#run = undefined;
  }

  async #loop(signal: AbortSignal): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    let failing = false;
    while (!signal.aborted && !this.closed) {
      const began = Date.now();
      try {
        await this.#copy(signal, () => {
          if (failing) this.log(`${this.name}: the restreamer sends the stream again`);
          failing = false;
        });
        if (signal.aborted || this.closed) return;
        throw new Error('the restreamer ended the stream');
      } catch (error) {
        if (signal.aborted || this.closed) return;
        if (!failing) this.log(`${this.name}: ${message(error)}`);
        failing = true;
      }
      if (Date.now() - began > MAX_BACKOFF_MS) backoff = MIN_BACKOFF_MS;
      await pause(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  /** One read of the source, written on until it ends, stalls or `signal` aborts; `flowing` is told of its first bytes. */
  async #copy(signal: AbortSignal, flowing: () => void): Promise<void> {
    const attempt = new AbortController();
    const abort = () => attempt.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let stall = setTimeout(() => attempt.abort(new Error(`the restreamer sent nothing for ${STALL_MS / 1000} s`)), STALL_MS);
    try {
      const reader = (await this.source(attempt.signal)).getReader();
      // A source that does not heed the signal is let go all the same.
      const cancel = () => void reader.cancel().catch(() => {});
      attempt.signal.addEventListener('abort', cancel, { once: true });
      let first = true;
      const splitter = splitterFor(this.mimetype);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (attempt.signal.aborted) throw attempt.signal.reason;
          if (done) return;
          clearTimeout(stall);
          stall = setTimeout(() => attempt.abort(new Error(`the restreamer sent nothing for ${STALL_MS / 1000} s`)), STALL_MS);
          if (first) flowing();
          first = false;
          if (!splitter) {
            await this.writer.write(value);
            continue;
          }
          for (const piece of splitter.feed(value)) {
            if (piece.kind === 'header') await this.writer.writeHeader(piece.bytes);
            else if (piece.kind === 'start') await this.writer.writeStart(piece.bytes);
            else await this.writer.write(piece.bytes);
          }
        }
      } catch (error) {
        throw attempt.signal.aborted && !signal.aborted ? attempt.signal.reason : error;
      } finally {
        attempt.signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(stall);
      signal.removeEventListener('abort', abort);
    }
  }
}

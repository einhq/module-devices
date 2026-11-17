/**
 * Recordings and videos a browser hands a screen near it, one EiN does not reach itself (a TV where
 * a phone that reaches EiN over the internet is): each in the form `MediaPlayer.nearby` makes, kept
 * while the browser renews it and let go of `NEARBY_TTL_MS` after it last did, or when it is
 * stopped. Kept in this process's memory, by the running bridge, which asks the media service.
 */

import { type Access, isAdmin } from '@ein/client';
import type { NearbyFile } from '../api.ts';
import type { Made, MediaPlayer } from './play.ts';

/** How long a file is kept for a screen near the browser without being renewed. */
const NEARBY_TTL_MS = 5 * 60_000;

type Held = { uid: number; made: Made; timer: ReturnType<typeof setTimeout> };

export class NearbyFiles {
  readonly #held = new Map<string, Held>();

  constructor(private readonly player: MediaPlayer, private readonly ttlMs = NEARBY_TTL_MS) {}

  /** The recording or video at `path`, made for a screen near the browser to fetch as `access`. */
  async start(path: string, access: Access): Promise<NearbyFile> {
    const { media, made } = await this.player.nearby(path, access);
    made.prepare?.(0);
    const id = `near-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    this.#held.set(id, { uid: access.uid, made, timer: this.#expire(id) });
    return { id, url: media.url, type: media.contentType, title: media.title };
  }

  /** Keep `id` another `NEARBY_TTL_MS`; false when it has run out, or is not `access`'s. */
  renew(id: string, access: Access): boolean {
    const held = this.#own(id, access);
    if (!held) return false;
    clearTimeout(held.timer);
    held.made.renew?.();
    held.timer = this.#expire(id);
    return true;
  }

  /** Let go of `id` now; false when there is none of `access`'s. */
  stop(id: string, access: Access): boolean {
    if (!this.#own(id, access)) return false;
    this.#release(id);
    return true;
  }

  /** Let go of every one. */
  close(): void {
    for (const id of [...this.#held.keys()]) this.#release(id);
  }

  #own(id: string, access: Access): Held | undefined {
    const held = this.#held.get(id);
    return held && (held.uid === access.uid || isAdmin(access)) ? held : undefined;
  }

  #expire(id: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.#release(id), this.ttlMs);
  }

  #release(id: string): void {
    const held = this.#held.get(id);
    if (!held) return;
    this.#held.delete(id);
    clearTimeout(held.timer);
    held.made.release();
  }
}

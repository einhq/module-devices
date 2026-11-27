/**
 * Browsers that show the module's display page (`/display`, `ui/pages/display.tsx`) as screens: each
 * is a device of the `browser` driver, and talks with it by writing to the device with the device's
 * key. It reports what it plays (`DisplayReport`) and is answered what to do next (`DisplayReply`,
 * core's `DriverAnswer.reply`), numbered messages it says it took in its next report. A report that
 * asks to `wait` is held until there is a message for it or `WAIT_MS` pass, so a display hears what
 * the player gives it at once, over plain requests through any proxy.
 *
 * A display is there while it asks: one holding a report, or heard within `GONE_MS`. It plays a list
 * itself, moving on when a recording or video ends, and is told to move on from a picture; it is
 * given paths on the address it reached EiN at, in the first form it says it plays.
 */

import type { DisplayItem, DisplayMessage, DisplayReply, DisplayReport } from '../api.ts';
import { type Media, type Status, Unreachable, type Way, type WayCommand } from './play.ts';

/** How long a report that asks to wait is held without a message. */
const WAIT_MS = 25_000;
/** A display not heard from in this long, and holding no report, has gone. */
const GONE_MS = 45_000;
/** How long a message waits for the display to say it took it. */
const TAKE_MS = 15_000;

type Display = {
  report?: DisplayReport;
  heardAt: number;
  /** Reports held now. */
  holding: number;
  /** The messages it has not said it took, oldest first. */
  messages: DisplayMessage[];
  /** Called when a message comes, to answer the held reports. */
  waiting: Set<() => void>;
  /** Called on each report, to settle the messages waiting to be taken. */
  taking: Set<() => void>;
};

type MessageBody = DisplayMessage extends infer M ? M extends DisplayMessage ? Omit<M, 'id'> : never : never;

export class BrowserDisplays {
  /** This run's: a display that took messages from another (EiN started again) counts from the first. */
  readonly epoch = crypto.randomUUID();
  #next = 1;
  readonly #displays = new Map<string, Display>();

  /** `heard` is told of a display that came, went, or plays something else now, so its device is asked at once. */
  constructor(private readonly heard: (device: string) => void = () => {}) {}

  #alive(device: string): Display | undefined {
    const display = this.#displays.get(device);
    return display && (display.holding > 0 || Date.now() - display.heardAt < GONE_MS) ? display : undefined;
  }

  /** What the display of `device`, called `label`, reports: answered with the messages it has not taken, after holding it when it asks to wait. */
  async report(device: string, label: string, report: DisplayReport): Promise<DisplayReply> {
    if (report.bye) {
      const display = this.#displays.get(device);
      this.#displays.delete(device);
      for (const each of display?.waiting ?? []) each();
      this.heard(device);
      return { epoch: this.epoch, messages: [], label };
    }
    const was = this.#alive(device);
    let display = this.#displays.get(device);
    if (!display) {
      display = { heardAt: 0, holding: 0, messages: [], waiting: new Set(), taking: new Set() };
      this.#displays.set(device, display);
    }
    const seen = report.epoch === this.epoch ? report.seen : 0;
    const last = display.report;
    display.messages = display.messages.filter((message) => message.id > seen);
    display.report = { ...report, seen };
    display.heardAt = Date.now();
    for (const each of display.taking) each();
    if (!was || last?.player !== report.player || last.url !== report.url || last.failed !== report.failed) this.heard(device);
    if (report.wait && display.messages.length === 0) {
      const held = display;
      held.holding++;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          held.waiting.delete(done);
          resolve();
        };
        const timer = setTimeout(done, WAIT_MS);
        held.waiting.add(done);
      });
      held.holding--;
      held.heardAt = Date.now();
    }
    return { epoch: this.epoch, messages: this.#displays.get(device)?.messages ?? [], label };
  }

  /** Tell the display of `device` `body`; resolves once it says it took it, and throws when no display shows the device. */
  async #send(device: string, body: MessageBody): Promise<void> {
    const display = this.#alive(device);
    if (!display) throw new Unreachable('no browser shows it now: open its display address');
    const message = { ...body, id: this.#next++ } as DisplayMessage;
    display.messages.push(message);
    for (const each of display.waiting) each();
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if ((display.report?.seen ?? 0) < message.id) return;
        settle();
        resolve();
      };
      const settle = () => {
        clearTimeout(timer);
        display.taking.delete(check);
      };
      // One not taken in time is dropped: a display that asks later is not given what was let go of.
      const timer = setTimeout(() => {
        settle();
        display.messages = display.messages.filter((each) => each !== message);
        reject(new Error('the browser did not take it in time'));
      }, TAKE_MS);
      display.taking.add(check);
    });
  }

  /** Let go of what is known of `device`'s display: the device is forgotten. */
  forget(device: string): void {
    const display = this.#displays.get(device);
    this.#displays.delete(device);
    for (const each of display?.waiting ?? []) each();
  }

  /** The display of `device` as a way to play on it. */
  way(device: string): Way {
    return {
      kind: 'browser',
      address: '',
      queues: true,
      status: (): Promise<Status> => {
        const report = this.#alive(device)?.report;
        if (!report) return Promise.reject(new Unreachable('no browser shows it now: open its display address'));
        return Promise.resolve({
          player: report.player,
          playing: report.player === 'idle' ? null : report.title ?? null,
          ...(report.url !== undefined ? { url: report.url } : {}),
          ...(report.seconds !== undefined ? { seconds: report.seconds } : {}),
          ...(report.duration !== undefined ? { duration: report.duration } : {}),
          ...(report.volume !== undefined ? { volume: report.volume } : {}),
          ...(report.muted !== undefined ? { muted: report.muted } : {}),
          ...(report.failed ? { failed: true } : {}),
        });
      },
      command: (command: WayCommand) => this.#send(device, command),
      load: (items: Media[], start: number, seconds: number) =>
        this.#send(device, {
          type: 'load',
          items: items.map(({ url, contentType, title, live }): DisplayItem => ({ url, contentType, title, ...(live ? { live } : {}) })),
          start,
          seconds,
        }),
      pick: (types: string[]) => {
        const plays = this.#alive(device)?.report?.plays;
        if (!plays) return Promise.reject(new Unreachable('no browser shows it now: open its display address'));
        return Promise.resolve(types.find((type) => plays.includes(type)));
      },
    };
  }
}

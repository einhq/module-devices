/**
 * The running bridge, as the other commands of this process see it.
 *
 * A module's lib file is staged once per process, so this module's state is shared by the service
 * and every command that imports it: `devices-status` reads it. There is at most one bridge per
 * process; nothing here is persisted.
 */

import type { NetworkHosts } from './network/found.ts';
import type { NearbyFiles } from './network/nearby.ts';

export type BridgeState = {
  url: string;
  /** The drivers it registered, one per source. */
  drivers: string[];
  connected: boolean;
  since: number;
  messages: number;
  lastError?: string;
  /** Entities the drivers cannot read, as `<device>/<entity>: why`. */
  notes(): string[];
  /** What the network listener heard, on the same broker. */
  network: NetworkHosts;
  /** Ask a device of a polled driver now; set once the poller runs. */
  pollNow?(device: string): void;
  /** The recordings and videos given to screens near a browser; unset where nothing makes them. */
  nearby?: NearbyFiles;
};

let running: BridgeState | undefined;

export const bridgeState = (): BridgeState | undefined => running;

export const setBridgeState = (state: BridgeState | undefined): void => {
  running = state;
};

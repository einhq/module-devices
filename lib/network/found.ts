/**
 * What the network listener heard, as the bridge receives it on the broker: one retained message per
 * host under `ein/discovery/host/<id>` (empty when the listener let it go), and the listener's own
 * `ein/discovery/status`. The broker replays them to every connection, so nothing here is kept
 * across restarts.
 *
 * `foundDevices` names each host (`identify`) and matches it to a device under /dev: the one added
 * from it, else by a hardware address it was heard at, or by a name it answers to, which is the name
 * Shelly's and ESPHome's MQTT give it.
 */

import { deviceName } from '@ein/api';
import type { FoundAnswer, FoundDevice, NetworkHost } from '../api.ts';
import { identify, namesOf, ownIdOf } from './identify.ts';

/** Where the network listener publishes. */
const NETWORK_PREFIX = 'ein/discovery';

type ListenerStatus = { round?: string; broker?: string; version?: string };

/** A device under /dev, as much of it as matching needs: `found` is the host it was added from. */
export type KnownDevice = { name: string; mac?: string; found?: string };

const HOST_TOPIC = `${NETWORK_PREFIX}/host/`;
const STATUS_TOPIC = `${NETWORK_PREFIX}/status`;

/** A hardware address as twelve lowercase hex digits, whatever it was written with. */
const macKey = (mac: string): string => mac.toLowerCase().replace(/[^0-9a-f]/g, '');

const isHost = (value: unknown): value is NetworkHost => {
  const host = value as NetworkHost;
  return typeof host === 'object' && host !== null && typeof host.ip === 'string' && Array.isArray(host.mdns) && Array.isArray(host.ssdp) &&
    Array.isArray(host.names);
};

export class NetworkHosts {
  /** Each host as the listener published it, by the listener's id. */
  readonly heard = new Map<string, NetworkHost>();
  /**
   * The hosts by the id EiN knows them by: the listener's, except that the hosts that give the same
   * id of their own (`ownIdOf`) are one under it, at the address that announced it last, however
   * many interfaces and addresses the listener heard it on.
   */
  readonly hosts = new Map<string, NetworkHost>();
  /** The id in `hosts` of each id the listener published under. */
  readonly #idOf = new Map<string, string>();
  status: ListenerStatus = {};

  /** The id in `hosts` that `id`, one of the listener's or one of `hosts`, is known by. */
  idOf(id: string): string {
    return this.#idOf.get(id) ?? id;
  }

  /** The host `id` is: by its id in `hosts`, or by one the listener published it under. */
  host(id: string): NetworkHost | undefined {
    return this.hosts.get(this.idOf(id));
  }

  /** Every host the listener published that is the host `id` of `hosts`. */
  partsOf(id: string): NetworkHost[] {
    return [...this.heard].filter(([heard]) => this.idOf(heard) === id).map(([, host]) => host);
  }

  #merge(): void {
    this.hosts.clear();
    this.#idOf.clear();
    for (const [id, host] of this.heard) {
      const own = ownIdOf(host) ?? id;
      this.#idOf.set(id, own);
      const other = this.hosts.get(own);
      if (!other || host.seen >= other.seen) this.hosts.set(own, host);
    }
  }

  topics(): string[] {
    return [`${NETWORK_PREFIX}/#`];
  }

  /** Takes a message on the listener's topics; false for one that is not its. */
  hear(topic: string, payload: string): boolean {
    if (topic === STATUS_TOPIC) {
      try {
        const status = JSON.parse(payload) as ListenerStatus;
        this.status = {
          round: typeof status.round === 'string' ? status.round : undefined,
          broker: typeof status.broker === 'string' ? status.broker : undefined,
          ...(typeof status.version === 'string' ? { version: status.version } : {}),
        };
      } catch {
        this.status = {};
      }
      return true;
    }
    if (!topic.startsWith(HOST_TOPIC)) return topic.startsWith(`${NETWORK_PREFIX}/`);
    const id = topic.slice(HOST_TOPIC.length);
    if (!payload) {
      this.heard.delete(id);
      this.#merge();
      return true;
    }
    try {
      const host = JSON.parse(payload);
      if (isHost(host)) {
        this.heard.set(id, { ...host, wsd: Array.isArray(host.wsd) ? host.wsd : [] });
        this.#merge();
      }
    } catch {
      // Not the listener's JSON: nothing to keep.
    }
    return true;
  }
}

/** Every host heard, named, with the device under /dev it is when it is one. */
export const foundDevices = (network: NetworkHosts, devices: KnownDevice[], ignored: Set<string>): FoundAnswer => {
  const byMac = new Map(devices.filter((device) => device.mac).map((device) => [macKey(device.mac!), device.name]));
  const byName = new Set(devices.map((device) => device.name));
  const byFound = new Map(devices.filter((device) => device.found).map((device) => [network.idOf(device.found!), device.name]));
  const found: FoundDevice[] = [...network.hosts].map(([id, host]) => {
    const macs = network.partsOf(id).flatMap((part) => part.mac ? [macKey(part.mac)] : []);
    const device = byFound.get(id) ?? macs.map((mac) => byMac.get(mac)).find(Boolean) ?? namesOf(host).map(deviceName).find((name) => byName.has(name));
    return {
      ...identify(host),
      id,
      ip: host.ip,
      ...(host.mac ? { mac: host.mac } : {}),
      names: host.names,
      seen: host.seen,
      services: [
        ...new Set([
          ...host.mdns.map((each) => each.type),
          ...host.ssdp.flatMap((each) => each.deviceType ? [each.deviceType] : []),
          ...host.wsd.flatMap((each) => each.types),
        ]),
      ],
      ...(device ? { device } : {}),
      ignored: ignored.has(id),
    };
  });
  found.sort((a, b) => Number(b.addable) - Number(a.addable) || a.label.localeCompare(b.label));
  return { ...network.status, devices: found };
};

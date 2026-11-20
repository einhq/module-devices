/**
 * The answers of devices' commands, for other modules (`@devices/api`). Import-free on purpose: a
 * page imports it without pulling in the module's commands.
 */

/** `devices-status`: the bridge and its drivers, as this process sees them. */
export type DevicesStatus = {
  /** False when the broker address is unset: only the devices asked over the network are read. */
  configured: boolean;
  url?: string;
  /** Whether the bridge runs in this process. */
  running: boolean;
  connected: boolean;
  /** Since when it has been connected, or disconnected. */
  since?: string;
  /** The drivers the bridge has registered with core, one per source it listens with: `ha-discovery`, `shelly`. */
  drivers: string[];
  /** The devices under /dev that this module's drivers drive, as the caller sees them. */
  devices: number;
  /** Their endpoints. */
  endpoints: number;
  /** MQTT messages heard since the bridge started. */
  messages: number;
  /** What the drivers cannot read, as `<device>/<entity>: why`. */
  unsupported: string[];
  lastError?: string;
  /**
   * The sidecar, when its network listener has been heard: the version it reports (absent from one
   * older than versions), and why this module does not speak it.
   */
  sidecar?: { version?: string; problem?: string };
};

/**
 * `devices-status --streams`: the restreamer cameras are given to (`CFG_DEVICES_STREAMS_URL`),
 * whether it answers with the account EiN signs in as, and how many streams it has.
 */
export type RestreamerStatus = {
  /** False when no restreamer is set. */
  configured: boolean;
  url?: string;
  answering: boolean;
  /** The streams it has, when it answers. */
  streams?: number;
  /** Why it did not answer, or refused EiN's account. */
  error?: string;
};

/**
 * One address on the network as the network listener heard it, `ein/discovery/host/<id>` on the
 * broker: its mDNS services, SSDP answers and WS-Discovery matches, and its hardware address when the
 * listener's host had talked to it.
 */
export type NetworkHost = {
  ip: string;
  mac?: string;
  /** Its mDNS host names (`shellyplus1pm-a8032ab12345.local`). */
  names: string[];
  /** When the listener last heard it. */
  seen: string;
  mdns: { type: string; instance: string; port?: number; txt: Record<string, string> }[];
  ssdp: {
    st: string;
    usn?: string;
    server?: string;
    location?: string;
    friendlyName?: string;
    manufacturer?: string;
    modelName?: string;
    modelNumber?: string;
    serialNumber?: string;
    deviceType?: string;
    udn?: string;
  }[];
  /** What it answered an ONVIF probe: its endpoint's id, types, scopes (`onvif://www.onvif.org/name/…`) and service addresses. */
  wsd: { endpoint?: string; types: string[]; scopes: string[]; xaddrs: string[] }[];
};

/** What a host on the network is. */
export type NetworkIdentity = {
  /** `camera`, `shelly`, `shelly-gen1`, `esphome`, `tasmota`, `matter`, `homekit`, `hue`, `sonos`, `cast`, `airplay`, `printer`, `router`, `media`, `storage` or `other`. */
  kind: string;
  vendor?: string;
  label: string;
  model?: string;
  firmware?: string;
  serial?: string;
  /** What it would be as a device (`speaker`, `printer`), where its kind says. */
  class?: string;
  /** It can become a device of this module's, by `devices-adopt` or by hand as `connect` says. */
  addable: boolean;
  /**
   * The driver `devices-adopt` adds it with: a Shelly's, which it points at the broker, or one
   * that asks the device itself (`network`, `ipp`, `snmp`, `cast`, `dlna`, `onvif`). A host offered as
   * `network` is added as `snmp` when it answers SNMP; an `onvif` camera takes its user and password.
   */
  adopt?: 'shelly' | 'shelly-gen1' | 'network' | 'ipp' | 'snmp' | 'cast' | 'dlna' | 'onvif';
  /** What adding it does, or what it takes. */
  connect?: string;
};

/** `devices-found`: a host on the network, what it is, and whether it is a device already. */
export type FoundDevice = NetworkIdentity & {
  /**
   * The id it gives itself, the same on every interface (a Cast device's, a DLNA renderer's UDN), else its hardware address
   * without colons, else its IP: what `devices-adopt` and `devices-ignore` take.
   */
  id: string;
  ip: string;
  mac?: string;
  names: string[];
  seen: string;
  /** Its mDNS service types, SSDP device types and WS-Discovery types. */
  services: string[];
  /** Its name under /dev, when it is a device already. */
  device?: string;
  ignored: boolean;
};

/** `devices-found`: the network listener, and what it found. */
export type FoundAnswer = {
  /** When the listener's last round was; absent when it has never been heard. */
  round?: string;
  /** The address devices reach the broker at, which `devices-adopt` gives them. */
  broker?: string;
  /** The sidecar's version, as its listener reports it. */
  version?: string;
  devices: FoundDevice[];
};

/**
 * `devices-adopt`: the driver it was added with. A Shelly was told the broker and restarts, and
 * becomes a device when it is back; any other is the device `device` at once.
 */
export type AdoptAnswer = { id: string; label: string; driver: string; broker?: string; restarted: boolean; device?: string };

/** `devices-found <id>`: one host, and everything the network listener heard of it. */
export type FoundDetail = FoundDevice & { host: NetworkHost };

/** `devices-snmp`: one object of a walk, its value as text when it is a 64-bit counter. */
export type SnmpObject = { oid: string; type: string; value: string | number | null };

/**
 * `devices-nearby start <path>`: a recording, video or picture made for a screen near the browser
 * to fetch, kept while `devices-nearby renew <id>` is run within five minutes of the last time.
 * `url` is a path on EiN's own address, read without signing in: the file with a ticket for it
 * alone, or H.264 HLS made while it is read; `type` is its media type. `captions`, when the
 * recording or video has a transcript, is that WebVTT file the same way.
 */
export type NearbyFile = { id: string; url: string; type: string; title: string; captions?: string };

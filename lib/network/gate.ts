/**
 * Where the drivers that ask at an address a person gives may go: a web API's (`http`), a camera's
 * streams and still picture (`rtsp`, `onvif`). A host on the public internet always, and one on this
 * machine, a local network, the containers beside EiN or a cloud's metadata service only when it is
 * in a network an administrator names in `CFG_DEVICES_NETWORKS` (ein/core#1375).
 *
 * `AddressGate.check` says whether a host may be asked, refusing it when any of its addresses may
 * not. `AddressGate.fetch` asks an http or https address, following a redirect a hop at a time so
 * each is checked, and every connection it makes goes through a gate in this process: a SOCKS5
 * proxy on loopback that looks the host up itself, refuses what may not be asked, and connects to
 * the address it checked. A name that answers one address to the check and another to the
 * connection therefore cannot slip past.
 */

import type { Fetch } from './adopt.ts';

/** The setting that names the local networks devices may be asked on. */
const NETWORKS_SETTING = 'CFG_DEVICES_NETWORKS';

const MAX_REDIRECTS = 5;

/** The four numbers of a dotted IPv4 address, or undefined when `ip` is not one. */
const ipv4 = (ip: string): number[] | undefined => {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
};

const isPublicIpv4 = ([a, b, c]: number[]): boolean =>
  !(a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast and reserved
    (a === 100 && b >= 64 && b < 128) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, where a cloud's metadata service answers
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // protocol assignments, documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113));

/** The eight 16-bit groups of an IPv6 address, or undefined when `ip` is not one. */
const ipv6 = (ip: string): number[] | undefined => {
  let text = ip.toLowerCase();
  const dotted = text.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4(dotted[1]);
    if (!v4) return undefined;
    text = `${text.slice(0, -dotted[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const words = (half: string) => half === '' ? [] : half.split(':');
  const head = words(halves[0]);
  const tail = halves.length === 2 ? words(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => parseInt(group, 16));
};

/** The IPv4 address an IPv6 one stands for: IPv4-mapped, NAT64 or 6to4. */
const embeddedIpv4 = (groups: number[]): number[] | undefined => {
  const last = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return last;
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return last;
  if (groups[0] === 0x2002) return [groups[1] >> 8, groups[1] & 0xff, groups[2] >> 8, groups[2] & 0xff];
  return undefined;
};

const isPublicIpv6 = (groups: number[]): boolean => {
  if ((groups[0] & 0xe000) !== 0x2000) return false; // only global unicast, 2000::/3
  return !(groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0xdb8)); // Teredo, documentation
};

const bare = (host: string): string => host.replace(/^\[|\]$/g, '');

/** An address as the bits a network is matched against, 32 for IPv4 and an IPv6 address standing for one, else 128, and whether it is public. */
const bitsOf = (ip: string): { v4: boolean; bits: number[]; public: boolean } | undefined => {
  const v6 = ipv4(ip) ? undefined : ipv6(ip);
  const v4 = ipv4(ip) ?? (v6 && embeddedIpv4(v6));
  if (v4) return { v4: true, bits: v4.flatMap((octet) => Array.from({ length: 8 }, (_, i) => (octet >> (7 - i)) & 1)), public: isPublicIpv4(v4) };
  if (!v6) return undefined;
  return { v4: false, bits: v6.flatMap((group) => Array.from({ length: 16 }, (_, i) => (group >> (15 - i)) & 1)), public: isPublicIpv6(v6) };
};

/** A network an administrator named: its address's bits and how many of them it fixes. */
type Network = { v4: boolean; bits: number[]; prefix: number };

/** The networks of `text`, addresses or ranges (`192.168.1.0/24`, `192.168.1.20`, `fd00::/8`) separated by commas or spaces; throws naming one it cannot read. */
export const parseNetworks = (text: string): Network[] =>
  text.split(/[\s,]+/).filter(Boolean).map((entry) => {
    const [address, prefixText, ...rest] = entry.split('/');
    const at = bitsOf(bare(address));
    const prefix = prefixText === undefined ? at?.bits.length : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
    if (!at || rest.length || prefix === undefined || !(prefix <= at.bits.length)) throw new Error(`${entry} is not an address or a network such as 192.168.1.0/24`);
    return { v4: at.v4, bits: at.bits, prefix };
  });

/** Whether a host may be asked at `ip`: on the public internet, or in one of `networks`. */
export const allowsAddress = (networks: Network[], ip: string): boolean => {
  const at = bitsOf(bare(ip));
  if (!at) return false;
  return at.public || networks.some((network) => network.v4 === at.v4 && network.bits.slice(0, network.prefix).every((bit, i) => bit === at.bits[i]));
};

/** Exactly `n` bytes from `conn`. */
const readExactly = async (conn: Deno.Conn, n: number): Promise<Uint8Array> => {
  const bytes = new Uint8Array(n);
  for (let at = 0; at < n;) {
    const read = await conn.read(bytes.subarray(at));
    if (read === null) throw new Error('the client went away');
    at += read;
  }
  return bytes;
};

/** SOCKS5's replies (RFC 1928): succeeded, not allowed by the rules, host unreachable, command or address type not supported. */
const REPLY = { ok: 0, refused: 2, unreachable: 4, command: 7, addressType: 8 } as const;

const reply = (conn: Deno.Conn, code: number): Promise<number> => conn.write(new Uint8Array([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);

/**
 * The gate of one bridge: what `networks` lets it ask. Without a `fetcher` it asks with `fetch`
 * through its SOCKS5 proxy; with one, as a test gives, it asks with that alone, after the same checks.
 */
export class AddressGate {
  private readonly networks: Network[];
  private readonly fetcher: Fetch;
  private listener?: Deno.Listener;
  private client?: Deno.HttpClient;

  constructor(networks: string, fetcher?: Fetch) {
    this.networks = parseNetworks(networks);
    this.fetcher = fetcher ?? ((url, init) => fetch(url, { ...init, client: this.proxied() } as RequestInit));
  }

  /** Whether a host may be asked at `ip`. */
  allows(ip: string): boolean {
    return allowsAddress(this.networks, ip);
  }

  /** `host`'s addresses, an address standing for itself; throws when it has none, or one that may not be asked. */
  async check(host: string): Promise<string[]> {
    const name = bare(host);
    let addresses: string[];
    if (bitsOf(name)) addresses = [name];
    else {
      const found = await Promise.all((['A', 'AAAA'] as const).map((type) => Deno.resolveDns(name, type).catch(() => [] as string[])));
      addresses = found.flat();
      if (addresses.length === 0) throw new Error(`${host} has no address`);
    }
    const closed = addresses.find((address) => !this.allows(address));
    if (closed) {
      throw new Error(
        `${host}${
          closed === name ? '' : ` (${closed})`
        } is not on the public internet; an administrator lets devices be asked there by naming its network in ${NETWORKS_SETTING}`,
      );
    }
    return addresses;
  }

  /**
   * The answer to an http or https `address`, a redirect followed a hop at a time, each hop checked;
   * only a GET is followed, and the authorization goes no further than the origin it was given for.
   */
  readonly fetch: Fetch = async (address, init = {}) => {
    let target = new URL(address);
    const headers = new Headers(init.headers);
    const follows = (init.method ?? 'GET').toUpperCase() === 'GET';
    for (let hop = 0;; hop++) {
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error(`only http and https addresses are asked, not ${target.protocol}`);
      await this.check(target.hostname);
      const response = await this.fetcher(target.href, { ...init, headers, redirect: 'manual' });
      if (!follows || !isRedirect(response.status)) return response;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error(`${target.host} answered ${response.status} without saying where to`);
      if (hop >= MAX_REDIRECTS) throw new Error(`${target.host}: more than ${MAX_REDIRECTS} redirects`);
      const next = new URL(location, target);
      if (next.origin !== target.origin) headers.delete('authorization');
      target = next;
    }
  };

  /** Stops the proxy; a request made after asks anew through another. */
  close(): void {
    this.client?.close();
    this.listener?.close();
    this.client = undefined;
    this.listener = undefined;
  }

  /** An HTTP client whose every connection goes through the gate's proxy, started on first use. */
  private proxied(): Deno.HttpClient {
    if (this.client) return this.client;
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    listener.unref();
    (async () => {
      try {
        for await (const conn of listener) {
          conn.unref();
          this.pass(conn);
        }
      } catch {
        // Closed.
      }
    })();
    this.listener = listener;
    return this.client = Deno.createHttpClient({ proxy: { url: `socks5h://127.0.0.1:${listener.addr.port}` } });
  }

  /** One connection through the proxy: SOCKS5 without authentication, CONNECT only, to a host that may be asked only. */
  private async pass(conn: Deno.Conn): Promise<void> {
    let upstream: Deno.Conn | undefined;
    try {
      const [, methods] = await readExactly(conn, 2);
      await readExactly(conn, methods);
      await conn.write(new Uint8Array([5, 0]));
      const [, command, , addressType] = await readExactly(conn, 4);
      let host: string;
      if (addressType === 1) host = [...await readExactly(conn, 4)].join('.');
      else if (addressType === 3) host = new TextDecoder().decode(await readExactly(conn, (await readExactly(conn, 1))[0]));
      else if (addressType === 4) {
        const bytes = await readExactly(conn, 16);
        host = Array.from({ length: 8 }, (_, i) => ((bytes[2 * i] << 8) | bytes[2 * i + 1]).toString(16)).join(':');
      } else return void await reply(conn, REPLY.addressType);
      const [high, low] = await readExactly(conn, 2);
      if (command !== 1) return void await reply(conn, REPLY.command);
      let addresses: string[];
      try {
        addresses = await this.check(host);
      } catch {
        return void await reply(conn, REPLY.refused);
      }
      for (const hostname of addresses) {
        try {
          upstream = await Deno.connect({ hostname, port: (high << 8) | low });
          upstream.unref();
          break;
        } catch {
          // The next address, if the host has one.
        }
      }
      if (!upstream) return void await reply(conn, REPLY.unreachable);
      await reply(conn, REPLY.ok);
      await Promise.all([conn.readable.pipeTo(upstream.writable), upstream.readable.pipeTo(conn.writable)]);
    } catch {
      // Either side going away ends the connection; the client sees it fail.
    } finally {
      for (const end of [conn, upstream]) {
        try {
          end?.close();
        } catch {
          // Already closed by its stream.
        }
      }
    }
  }
}

/** The body of `response`, refused once it passes `limit` bytes, never read further. */
export const readAtMost = async (response: Response, limit: number, tooLong: () => Error): Promise<Uint8Array<ArrayBuffer>> => {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw tooLong();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw tooLong();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return body;
};

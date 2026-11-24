/**
 * Where the drivers that ask at an address a person gives may go: a web API's (`http`), a camera's
 * streams and still picture (`rtsp`, `onvif`). A host on the public internet always, and one on this
 * machine, a local network, the containers beside EiN or a cloud's metadata service only when it is
 * in a network an administrator names in `CFG_DEVICES_NETWORKS` (ein/core#1375). The gate is core's
 * (`AddressGate` in `@ein/client`): it checks a host before asking and again at each connection.
 */

import { AddressGate, type GateFetch, inNetworks } from '@ein/client';

/** The setting that names the local networks devices may be asked on. */
const NETWORKS_SETTING = 'CFG_DEVICES_NETWORKS';

/**
 * The gate of one bridge: what `networks`, the setting's value, lets it ask; throws naming an entry it
 * cannot read. Without a `fetcher` it asks through the gate's proxy; with one, as a test gives, it asks
 * with that alone, after the same checks.
 */
export const devicesGate = (networks: string, fetcher?: GateFetch): AddressGate =>
  new AddressGate({
    local: inNetworks(networks),
    refusal: `an administrator lets devices be asked there by naming its network in ${NETWORKS_SETTING}`,
    fetcher,
  });

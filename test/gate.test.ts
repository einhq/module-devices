/**
 * Where the http driver and the cameras may ask: the public internet, and off it only the networks
 * `CFG_DEVICES_NETWORKS` names, a refusal saying so. The gate itself is core's, tested there.
 */
import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { devicesGate } from '../lib/network/gate.ts';

Deno.test('the public internet always, and off it only the networks named', () => {
  const none = devicesGate('');
  for (const ip of ['93.184.216.34', '2606:4700::6810:84e5']) assertEquals(none.allows(ip), true, ip);
  for (const ip of ['127.0.0.1', '192.168.1.20', '169.254.169.254', 'fd00::1']) assertEquals(none.allows(ip), false, ip);
  const home = devicesGate('192.168.1.0/24, 127.0.0.1 fd00::/8');
  for (const ip of ['192.168.1.20', '::ffff:192.168.1.20', '127.0.0.1', 'fd00::1']) assertEquals(home.allows(ip), true, ip);
  for (const ip of ['192.168.2.1', '127.0.0.2', '169.254.169.254']) assertEquals(home.allows(ip), false, ip);
  assertThrows(() => devicesGate('lan'), Error, 'lan is not an address or a network');
});

Deno.test('a host is refused saying where to allow it, and asked with the fetcher given only once allowed', async () => {
  const asked: string[] = [];
  const gate = devicesGate('192.0.2.0/24', (url) => (asked.push(url), Promise.resolve(new Response('ok'))));
  for (const host of ['127.0.0.1', '[::1]', '169.254.169.254']) await assertRejects(() => gate.check(host), Error, 'naming its network in CFG_DEVICES_NETWORKS', host);
  await assertRejects(() => gate.fetch('http://192.168.1.20/'), Error, 'naming its network in CFG_DEVICES_NETWORKS');
  assertEquals(await (await gate.fetch('http://192.0.2.7/status')).text(), 'ok');
  assertEquals(asked, ['http://192.0.2.7/status']);
});

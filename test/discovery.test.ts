/**
 * The network listener against a broker of the test's own: what it reads back of the hosts an
 * earlier listener left retained, so a host unheard since before a restart is still forgotten.
 */

import { assertEquals } from '@std/assert';
import { retainedSeen } from '../sidecar/discovery.ts';
import { startStubBroker } from './stub-broker.ts';

Deno.test('the network listener reads when each retained host was last heard', async () => {
  const broker = startStubBroker();
  try {
    const seen = '2026-11-09T08:00:00.000Z';
    broker.publish('ein/discovery/host/020000000011', JSON.stringify({ ip: '192.168.1.40', mac: '02:00:00:00:00:11', names: [], seen }), { retain: true });
    broker.publish('ein/discovery/host/192.168.1.41', JSON.stringify({ ip: '192.168.1.41', names: [], seen: 'whenever' }), { retain: true });
    broker.publish('ein/discovery/host/192.168.1.42', JSON.stringify({ ip: '192.168.1.42', names: [], seen }), { retain: true });
    broker.publish('ein/discovery/host/192.168.1.42', '', { retain: true });
    broker.publish('ein/discovery/status', JSON.stringify({ round: seen, hosts: 1 }), { retain: true });
    broker.publish('ein/other/host/192.168.1.43', JSON.stringify({ ip: '192.168.1.43', names: [], seen }), { retain: true });

    const port = Number(new URL(broker.url).port);
    assertEquals(
      await retainedSeen({ hostname: '127.0.0.1', port }, 'ein/discovery'),
      new Map([['020000000011', Date.parse(seen)], ['192.168.1.41', 0]]),
    );
    assertEquals(await retainedSeen({ hostname: '127.0.0.1', port }, 'ein/nothing'), new Map());
  } finally {
    await broker.close();
  }
});

/**
 * A DLNA renderer, stood in for by a server on this machine's loopback that answers as the 2014
 * Philips TV of ein/core#1328 did: its services found from its description, given an address with
 * its title after a stop it holds its transport through, what it plays and how far in read back,
 * its volume set, and the type it plays picked from what it lists.
 */

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { clockSeconds, createDlna, didl, readDescription, sinkTypes, UpnpError } from '../lib/network/dlna.ts';
import { Unreachable } from '../lib/network/play.ts';
import { RENDERER_DESCRIPTION as DESCRIPTION, RENDERER_SINK as SINK, startRenderer } from './fixtures.ts';

Deno.test('what a renderer says of itself is read', () => {
  const services = readDescription(DESCRIPTION, 'http://192.168.1.50:2870/dmr.xml');
  assertEquals(services.AVTransport, { type: 'urn:schemas-upnp-org:service:AVTransport:3', control: 'http://192.168.1.50:2870/control/AVTransport' });
  assertEquals(services.RenderingControl.control, 'http://192.168.1.50:2870/control/RenderingControl');
  assertEquals(sinkTypes(SINK), ['image/jpeg', 'audio/l16', 'audio/mpeg', 'audio/mp4', 'video/mp4']);
  assertEquals([clockSeconds('0:01:02.500'), clockSeconds('NOT_IMPLEMENTED'), clockSeconds(undefined)], [62.5, undefined, undefined]);
  const metadata = didl({ url: 'http://ein/file/a.m4a?ticket=x&y', contentType: 'audio/x-m4a', title: 'Rock & roll' });
  assertStringIncludes(metadata, '<dc:title>Rock &amp; roll</dc:title>');
  assertStringIncludes(metadata, 'protocolInfo="http-get:*:audio/mp4:DLNA.ORG_OP=01;');
});

Deno.test('a renderer is played on and asked over UPnP AV', async (t) => {
  const renderer = startRenderer();
  const way = createDlna(fetch, renderer.location);
  const song = { url: 'http://192.168.1.10:8080/file/music/a.m4a?ticket=abc', contentType: 'audio/mp4', title: 'A song' };
  try {
    await t.step('given an address with its title once its transport is no longer held, then told to play', async () => {
      await way.load([{ ...song, url: 'http://elsewhere/no.m4a' }, song], 1, 0);
      assertEquals(renderer.asked.map((each) => each.action), ['Stop', 'SetAVTransportURI', 'SetAVTransportURI', 'Play']);
      assertEquals(renderer.asked[3].soapaction, '"urn:schemas-upnp-org:service:AVTransport:3#Play"');
      assertEquals(renderer.state.uri, song.url);
      assertStringIncludes(renderer.state.metadata, 'object.item.audioItem.musicTrack');
    });

    await t.step('it says what it plays, how far in, and its volume', async () => {
      assertEquals(await way.status(), { player: 'playing', playing: 'A song', volume: 0.12, muted: false, url: song.url, seconds: 62.5, duration: 200 });
    });

    await t.step('its volume is set, and it picks the type it plays', async () => {
      await way.command({ type: 'volume', level: 0.3 });
      assertEquals(renderer.state.volume, 30);
      assertEquals(await way.pick!(['audio/flac', 'audio/mpeg']), 'audio/mpeg');
      assertEquals(await way.pick!(['audio/flac']), undefined);
      assertEquals(await way.pick!(['audio/x-flac', 'audio/x-m4a']), 'audio/x-m4a');
    });

    await t.step('a refusal says why, and a renderer that is not there is unreachable', async () => {
      await assertRejects(() => way.command({ type: 'pause' }), UpnpError, '401');
      await assertRejects(() => createDlna(fetch, 'http://127.0.0.1:9/dmr.xml').status(), Unreachable);
    });
  } finally {
    await renderer.stop();
  }
});

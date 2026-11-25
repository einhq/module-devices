/**
 * A browser display, in a booted core with its driver registered as the bridge registers it: with no
 * browser showing it, what is written to its `show` is refused and it is offline; a browser that
 * reports to the device with its key, holding its report, is answered at once with what to show, on
 * paths of EiN's own address with a ticket, in a type it says it plays, and what is written resolves
 * once it says it took it; stop lets the tickets go; signed out, it is offline again; a report with
 * any other key is refused.
 */

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { DeviceKeyAnswer, DeviceValue } from '@ein/api';
import { ADMIN_ACCESS, SystemTestHarness } from '@ein/testing';
import type { DisplayReply, DisplayReport } from '../lib/api.ts';
import { createPolledDrivers, devicesGate } from '../lib/network/mod.ts';
import type { PolledDevice } from '../lib/network/polled.ts';

const harness = new SystemTestHarness({ boot: true, ssh: false });

Deno.test({ name: 'a browser display', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { baseUrl, devices, vfs } = await harness.start();
  const admin = await harness.createShellClient();
  await vfs.create(ADMIN_ACCESS, 'dir', '/', 'music', {});
  await vfs.create(ADMIN_ACCESS, 'file', '/music', 'song.mp3', { attrs: { name: 'song.mp3', mimetype: 'audio/mpeg' } });
  const handle = await vfs.open(ADMIN_ACCESS, '/music/song.mp3', { mode: 'w' });
  await handle.write(new TextEncoder().encode('the song'));
  await handle.close();

  const gate = devicesGate('');
  const browser = createPolledDrivers(fetch, gate, { vfs, devices, address: () => undefined }).find((driver) => driver.name === 'browser')!;
  const display: PolledDevice = { name: 'living-room', ip: '', config: {} };
  const unregister = devices.registerDriver('browser', {
    description: browser.description,
    config: browser.config,
    input: ({ device, attrs, bytes }) => browser.input!({ ...display, name: device }, attrs.label ?? device, bytes),
  });
  const show = (value: DeviceValue, endpoint = 'show') => browser.write!(display, endpoint, value, ADMIN_ACCESS);

  try {
    await admin.execString("device-create 'Living room' --driver browser --class screen");
    const key = new URL((await admin.execJson<DeviceKeyAnswer>('device-key living-room --new --origin https://ein.example')).url!).searchParams.get('key')!;
    const post = async (report: DisplayReport, secret = key): Promise<DisplayReply> => {
      const response = await fetch(`${baseUrl}/file/dev/living-room`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      return (await response.json()).reply;
    };
    const plays = ['audio/mpeg', 'audio/mp4', 'video/mp4', 'image/jpeg'];
    let epoch = '';
    let seen = 0;
    let given = '';

    await t.step('with no browser showing it, what is written to it is refused, and it is offline', async () => {
      await assertRejects(() => show('/music/song.mp3'), Error, 'no browser shows it now');
      await assertRejects(() => browser.poll(display), Error, 'no browser shows it now');
    });

    await t.step('a browser holding its report is answered with what to show, which resolves once it took it', async () => {
      const held = post({ seen, wait: true, player: 'idle', plays });
      // The report is held before anything is written.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const shown = show('/music/song.mp3');
      const reply = await held;
      assertEquals([reply.label, reply.messages.length], ['Living room', 1]);
      const [message] = reply.messages;
      if (message.type !== 'load') throw new Error(`a ${message.type}, not a load`);
      const [item] = message.items;
      assertEquals([item.contentType, item.title, message.start], ['audio/mpeg', 'song.mp3', 0]);
      assertStringIncludes(item.url, '/file/music/song.mp3?ticket=');
      assertEquals(item.url.startsWith('/'), true, 'a path on the address the browser reached EiN at');
      const file = await fetch(`${baseUrl}${item.url}`);
      assertEquals([file.status, await file.text()], [200, 'the song']);

      epoch = reply.epoch;
      seen = message.id;
      given = item.url;
      await post({ seen, epoch, player: 'playing', url: item.url, title: item.title, seconds: 1 });
      assertEquals(await shown, { message: 'playing song.mp3' });
      const polled = await browser.poll(display);
      assertEquals([polled.values.player, polled.values.playing, polled.values.show], ['playing', 'song.mp3', '/music/song.mp3']);
    });

    await t.step('a type the browser does not play is refused', async () => {
      await post({ seen, epoch, player: 'playing', plays: ['video/mp4'] });
      await assertRejects(() => show('/music/song.mp3'), Error, 'plays none of audio/mpeg');
      await post({ seen, epoch, player: 'playing', plays });
    });

    await t.step('stop is told to the browser, and what it was given is let go', async () => {
      const stopped = show(true, 'stop');
      const reply = await post({ seen, epoch, player: 'playing' });
      assertEquals(reply.messages.map((message) => message.type), ['stop']);
      seen = reply.messages[0].id;
      await post({ seen, epoch, player: 'idle' });
      await stopped;
      assertEquals((await browser.poll(display)).values.show, null);
      const file = await fetch(`${baseUrl}${given}`);
      await file.body?.cancel();
      assertEquals(file.status, 403);
    });

    await t.step('a report from before EiN started again takes the messages from the first', async () => {
      const reply = await post({ seen: 1000, epoch: 'another run', player: 'idle' });
      assertEquals(reply.epoch, epoch);
    });

    await t.step('signed out, it is offline', async () => {
      await post({ seen, epoch, player: 'idle', bye: true });
      await assertRejects(() => browser.poll(display), Error, 'no browser shows it now');
    });

    await t.step('a report with any other key is refused', async () => {
      await assertRejects(() => post({ seen: 0, player: 'idle' }, 'not-the-key'), Error, '403');
    });
  } finally {
    unregister();
    gate.close();
    admin.close();
    await harness.stop();
  }
});

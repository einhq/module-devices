/**
 * The camera drivers in a booted EiN, against a stub of the restreamer's API and a stand-in media
 * service. The rtsp driver: a camera made with its stream's address and password is given to the
 * restreamer with the password in the address and nowhere else, its stream nodes say their size and
 * codec and the MP4 ones that they are watched live, a picture node read is the media service's
 * first frame of its MPEG-TS node, a stream node read carries the restreamer's MPEG-TS, an MP4 one
 * its fragmented MP4 from its header, a stream the restreamer lost is given back when it is asked
 * for, and forgetting the camera takes its streams from the restreamer and ends its readers;
 * `devices-status --streams` says whether the restreamer answers EiN's account; without a
 * restreamer no stream is watched live, and a picture is the camera's still picture, or there is
 * none. The onvif driver, against a stub camera: its profiles become the stream nodes, its events
 * are logged, and its presets and moves are controls.
 */

import { assert, assertEquals } from '@std/assert';
import type { DeviceInfo } from '@ein/api';
import type { RestreamerStatus } from '../lib/api.ts';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { serveEmsFiles, startStubEms, type StubEms } from '@ems/testing';
import { jpegSize } from '../lib/cameras/restreamer.ts';
import { startOnvifCamera } from './onvif-camera.ts';
import { sourceName, withCredentials } from '../lib/cameras/camera.ts';
import { fragment, joined, mp4Header } from './mp4-boxes.ts';

/** A JPEG's start, a 640×360 frame header and its end: all a frame needs to say its size. */
const FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x68, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);

const until = async <T>(what: string, read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 10_000): Promise<T> => {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < end) {
    try {
      last = await read();
      if (check(last)) return last;
    } catch {
      // not there yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)}`);
};

/** An MPEG-TS packet as the stub sends it: its sync byte, then `n` over and over. */
const packet = (n: number) => {
  const bytes = new Uint8Array(188).fill(n);
  bytes[0] = 0x47;
  return bytes;
};

/** A media service whose first frame of any stream is `FRAME`, written where the request says. */
const stubEms = (): StubEms =>
  startStubEms({
    ops: {
      'video.poster': async (body) => {
        const target = (body.targets as { output: { path: string } }[])[0];
        await Deno.writeFile(target.output.path, FRAME);
        return { result: { frame: { width: 640, height: 360 }, targets: [{ path: target.output.path, width: 640, height: 360, bytes: FRAME.length }] } };
      },
    },
  });

/** The driver pointed at the stand-in media service, which an endpoint of this process serves its files. */
const useEms = async (admin: { execString(line: string): Promise<string> }, ems: StubEms): Promise<{ stop: () => Promise<void> }> => {
  const files = await serveEmsFiles(ems.url, '127.0.0.1', 0);
  await admin.execString(`config set CFG_EMS_URL ${ems.url}`);
  return files;
};

/** go2rtc's API as far as the driver uses it, behind the account `ein` and `password`; a camera's still picture at `/snapshot.jpg`, as anyone. */
const stubRestreamer = (password: string) => {
  const sources = new Map<string, string>();
  /** Each read of a source, its format and query, and whether its reader has let it go. */
  const read: { src: string; format: string; query: string; ended: boolean }[] = [];
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    const authorized = req.headers.get('authorization') === `Basic ${btoa(`ein:${password}`)}`;
    if (url.pathname === '/snapshot.jpg') return new Response(FRAME);
    if (!authorized) return new Response('', { status: 401 });
    const src = url.searchParams.get('src') ?? '';
    if (url.pathname === '/api/stream.mp4') {
      if (!sources.has(src)) return new Response('stream not found', { status: 404 });
      const reading = { src, format: 'mp4', query: url.search, ended: false };
      read.push(reading);
      let n = 0;
      let timer: ReturnType<typeof setInterval>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(mp4Header());
            // A keyframe's fragment every third, each cut across two chunks.
            timer = setInterval(() => {
              const one = fragment(n % 3 === 0, ++n);
              controller.enqueue(one.subarray(0, 30));
              controller.enqueue(one.subarray(30));
            }, 20);
          },
          cancel: () => {
            clearInterval(timer);
            reading.ended = true;
          },
        }),
        { headers: { 'content-type': 'video/mp4' } },
      );
    }
    if (url.pathname === '/api/stream.ts') {
      if (!sources.has(src)) return new Response('stream not found', { status: 404 });
      const reading = { src, format: 'ts', query: url.search, ended: false };
      read.push(reading);
      let n = 0;
      let timer: ReturnType<typeof setInterval>;
      // Packets cut across the chunks they come in, as a socket would cut them.
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            timer = setInterval(() => {
              const two = new Uint8Array(376);
              two.set(packet(++n));
              two.set(packet(++n), 188);
              controller.enqueue(two.subarray(0, 100));
              controller.enqueue(two.subarray(100));
            }, 20);
          },
          cancel: () => {
            clearInterval(timer);
            reading.ended = true;
          },
        }),
        { headers: { 'content-type': 'video/mp2t' } },
      );
    }
    if (url.pathname !== '/api/streams') return new Response('', { status: 404 });
    if (req.method === 'PUT') sources.set(url.searchParams.get('name') ?? src, src);
    else if (req.method === 'DELETE') sources.delete(src);
    else if (src) {
      return Response.json({
        producers: [{ receivers: [{ codec: { codec_name: 'h264', codec_type: 'video' } }, { codec: { codec_name: 'pcma', codec_type: 'audio' } }] }],
      });
    } else return Response.json(Object.fromEntries([...sources.keys()].map((name) => [name, { producers: [{ url: 'rtsp://***@camera' }] }])));
    return new Response(null);
  });
  return { server, sources, read, url: `http://127.0.0.1:${server.addr.port}` };
};

Deno.test('a camera address takes its user and password, unless it carries its own', () => {
  assertEquals(withCredentials('rtsp://192.0.2.10:554/live', 'viewer', 'p@ss word'), 'rtsp://viewer:p%40ss%20word@192.0.2.10:554/live');
  assertEquals(withCredentials('rtsp://own:one@192.0.2.10/live', 'viewer', 'x'), 'rtsp://own:one@192.0.2.10/live');
  assertEquals(withCredentials('rtsp://192.0.2.10/live'), 'rtsp://192.0.2.10/live');
  assertEquals(jpegSize(FRAME), { width: 640, height: 360 });
  assertEquals(jpegSize(new Uint8Array([1, 2, 3])), undefined);
});

Deno.test({ name: 'rtsp cameras are given to the restreamer and watched through core, live only with one', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const restreamer = stubRestreamer('streams-secret');
  const ems = stubEms();
  const testCtx = createTestContext({ modules: ['devices'], boot: true, env: { CFG_DEVICES_MQTT_URL: '' } });
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  let files: { stop: () => Promise<void> } | undefined;
  try {
    files = await useEms(admin, ems);
    await admin.execString(`config set CFG_DEVICES_STREAMS_URL ${restreamer.url} && config set CFG_DEVICES_STREAMS_KEY streams-secret`);
    await admin.execString('service restart devices-bridge');
    await until('the rtsp driver', () => admin.execString('devices --drivers'), (text) => /rtsp/.test(text));

    await t.step('a camera is given to the restreamer with its password in the address, and nowhere else', async () => {
      await admin.execString(
        "device-create 'Front door' --driver rtsp --config url=rtsp://192.0.2.10/main --config sub=rtsp://192.0.2.10/sub --config user=viewer --config password=s3cret",
      );
      assertEquals([...restreamer.sources], [
        [sourceName('front-door', 'main'), 'rtsp://viewer:s3cret@192.0.2.10/main'],
        [sourceName('front-door', 'sub'), 'rtsp://viewer:s3cret@192.0.2.10/sub'],
      ]);
      const info = await admin.execJson<DeviceInfo>('device-show front-door');
      assertEquals([info.class, info.online, info.config?.password], ['camera', true, undefined]);
      // The sizes are the media service's first pictures', made for streams of no known size.
      const stream = { codec: 'h264', width: 640, height: 360, audio: true };
      const picture = { mimetype: 'image/jpeg', width: 640, height: 360 };
      assertEquals(info.endpointList.map((endpoint) => [endpoint.name, endpoint.type, endpoint.stream, endpoint.live]), [
        ['main.jpg', 'stream', picture, undefined],
        ['main.mp4', 'stream', { mimetype: 'video/mp4', ...stream }, true],
        ['main.ts', 'stream', { mimetype: 'video/mp2t', ...stream }, undefined],
        ['sub.jpg', 'stream', picture, undefined],
        ['sub.mp4', 'stream', { mimetype: 'video/mp4', ...stream }, true],
        ['sub.ts', 'stream', { mimetype: 'video/mp2t', ...stream }, undefined],
      ]);
    });

    await t.step("a picture node read is the media service's first frame of the stream node, made when asked", async () => {
      // Past the last picture's freshness, so this read asks for one.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      const asked = ems.requests.length;
      const { cookie } = await testCtx.harness.createHttpSession();
      const response = await fetch(`${testCtx.harness.instance!.baseUrl}/file/dev/front-door/sub.jpg`, { headers: { cookie } });
      assertEquals([response.status, response.headers.get('content-type'), new Uint8Array(await response.arrayBuffer())], [200, 'image/jpeg', FRAME]);
      const made = ems.requests.slice(asked);
      assertEquals(made.map((request) => [request.op, (request.body.source as { path: string }).path]), [['video.poster', '/dev/front-door/sub.ts']]);
    });

    await t.step("a stream node read carries the restreamer's MPEG-TS, in whole packets, the source given back when it was lost", async () => {
      restreamer.sources.clear();
      const vfs = testCtx.harness.instance!.vfs;
      const reader = await vfs.open(ADMIN_ACCESS, '/dev/front-door/sub.ts', { mode: 'r' });
      const got: Uint8Array[] = [];
      try {
        for (let total = 0; total < 4 * 188;) {
          const chunk = await reader.read(64 * 1024);
          assert(chunk.length > 0, 'the stream ended');
          got.push(chunk);
          total += chunk.length;
        }
      } finally {
        await reader.close();
      }
      assert(got.every((chunk) => chunk.length % 188 === 0 && chunk[0] === 0x47), `chunks of ${got.map((chunk) => chunk.length)}`);
      assertEquals(restreamer.read.map((each) => [each.src, each.format]), [[sourceName('front-door', 'sub'), 'ts']]);
      assertEquals([...restreamer.sources.keys()], [sourceName('front-door', 'main'), sourceName('front-door', 'sub')]);
    });

    await t.step("an MP4 stream node read over HTTP is the restreamer's fragmented MP4, its header first and then from a keyframe", async () => {
      const { cookie } = await testCtx.harness.createHttpSession();
      const response = await fetch(`${testCtx.harness.instance!.baseUrl}/file/dev/front-door/main.mp4`, { headers: { cookie } });
      assertEquals([response.status, response.headers.get('content-type')], [200, 'video/mp4']);
      const reader = response.body!.getReader();
      const got: Uint8Array[] = [];
      for (let total = 0; total < mp4Header().length + 3 * fragment(true, 0).length;) {
        const { value, done } = await reader.read();
        assert(!done, 'the stream ended');
        got.push(value);
        total += value.length;
      }
      await reader.cancel();
      const bytes = joined(...got);
      assertEquals(bytes.subarray(0, mp4Header().length), mp4Header());
      // What follows the header is whole fragments, the first of them a keyframe's.
      const first = bytes.subarray(mp4Header().length, mp4Header().length + fragment(true, 0).length);
      assertEquals(new TextDecoder().decode(first.subarray(4, 8)), 'moof');
      assertEquals(first.subarray(0, first.length - 40), fragment(true, 0).subarray(0, first.length - 40));
      const mp4 = restreamer.read.find((each) => each.format === 'mp4')!;
      assertEquals([mp4.src, new URLSearchParams(mp4.query).get('mp4')], [sourceName('front-door', 'main'), 'flac']);
    });

    await t.step('forgetting the camera takes its streams from the restreamer, and ends what reads them', async () => {
      const reader = await testCtx.harness.instance!.vfs.open(ADMIN_ACCESS, '/dev/front-door/main.ts', { mode: 'r' });
      assert((await reader.read(64 * 1024)).length > 0);
      await admin.execString('device-forget front-door');
      assertEquals(restreamer.sources.size, 0);
      for (let chunk = await reader.read(64 * 1024); chunk.length > 0;) chunk = await reader.read(64 * 1024);
      await reader.close();
      await until('the restreamer let go', async () => restreamer.read, (read) => read.every((each) => each.ended));
    });

    await t.step('devices-status --streams says the restreamer answers its account, and refuses another password', async () => {
      assertEquals(await admin.execJson<RestreamerStatus>('devices-status --streams'), {
        configured: true,
        url: restreamer.url,
        answering: true,
        streams: 0,
      });
      await admin.execString('config set CFG_DEVICES_STREAMS_KEY another');
      const refused = await admin.execJson<RestreamerStatus>('devices-status --streams');
      assertEquals([refused.answering, refused.error], [false, 'the restreamer answered 401']);
    });

    await t.step('without a restreamer, a camera has no stream watched live, and its picture is its still picture or none', async () => {
      await admin.execString('config unset CFG_DEVICES_STREAMS_URL && service restart devices-bridge');
      await until('the rtsp driver', () => admin.execString('devices --drivers'), (text) => /rtsp/.test(text));
      await admin.execString('device-create Porch --driver rtsp --config url=rtsp://192.0.2.11/main');
      const info = await admin.execJson<DeviceInfo>('device-show porch');
      assertEquals(info.endpointList.map((endpoint) => [endpoint.name, endpoint.type, endpoint.live]), [['main.ts', 'stream', undefined]]);
      await admin.execString(`device-create Yard --driver rtsp --config url=rtsp://192.0.2.12/main --config snapshot=${restreamer.url}/snapshot.jpg`);
      const yard = await admin.execJson<DeviceInfo>('device-show yard');
      assertEquals(yard.endpointList.map((endpoint) => [endpoint.name, endpoint.stream]), [
        ['main.jpg', { mimetype: 'image/jpeg', width: 640, height: 360 }],
        ['main.ts', { mimetype: 'video/mp2t', width: 640, height: 360 }],
      ]);
      const reader = await testCtx.harness.instance!.vfs.open(ADMIN_ACCESS, '/dev/yard/main.jpg', { mode: 'r' });
      const read: number[] = [];
      for (let chunk = await reader.read(64 * 1024); chunk.length > 0; chunk = await reader.read(64 * 1024)) read.push(...chunk);
      await reader.close();
      assertEquals(new Uint8Array(read), FRAME);
    });
  } finally {
    admin.close();
    await testCtx.teardown();
    await restreamer.server.shutdown();
    await files?.stop();
    await ems.close();
  }
});

Deno.test({ name: 'onvif cameras give their profiles, events and turns', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const restreamer = stubRestreamer('streams-secret');
  const ems = stubEms();
  const camera = startOnvifCamera({ user: 'admin', password: 's3cret', clockOffsetMs: 5 * 60_000 });
  const testCtx = createTestContext({ modules: ['devices'], boot: true, env: { CFG_DEVICES_MQTT_URL: '' } });
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const show = () => admin.execJson<DeviceInfo>('device-show gate');
  const endpoint = (info: DeviceInfo, name: string) => info.endpointList.find((each) => each.name === name);
  let files: { stop: () => Promise<void> } | undefined;
  try {
    files = await useEms(admin, ems);
    await admin.execString(`config set CFG_DEVICES_STREAMS_URL ${restreamer.url} && config set CFG_DEVICES_STREAMS_KEY streams-secret`);
    await admin.execString('service restart devices-bridge');
    await until('the onvif driver', () => admin.execString('devices --drivers'), (text) => /onvif/.test(text));

    await t.step('its largest profile is the main stream and its smallest the sub, at the address it was reached at', async () => {
      await admin.execString(`device-create Gate --driver onvif --config address=${camera.address()} --config user=admin --config password=s3cret`);
      assertEquals([...restreamer.sources], [
        [sourceName('gate', 'main'), 'rtsp://admin:s3cret@127.0.0.1:554/main'],
        [sourceName('gate', 'sub'), 'rtsp://admin:s3cret@127.0.0.1:554/sub'],
      ]);
      const info = await show();
      assertEquals([info.class, info.online, info.config?.password], ['camera', true, undefined]);
      // The frame rate and the size are the camera's to say, and the codec and sound the restreamer's probe.
      assertEquals(endpoint(info, 'main.ts')?.stream, { mimetype: 'video/mp2t', codec: 'h264', width: 2560, height: 1440, fps: 25, audio: true });
      assertEquals(endpoint(info, 'sub.ts')?.stream, { mimetype: 'video/mp2t', codec: 'h264', width: 640, height: 360, fps: 25, audio: true });
    });

    await t.step('motion and a person seen are logged as the camera says them', async () => {
      await until('the event endpoints', show, (info) => !!endpoint(info, 'motion') && !!endpoint(info, 'person'));
      camera.events.push({ topic: 'tns1:RuleEngine/CellMotionDetector/Motion', name: 'IsMotion', value: 'true' });
      camera.events.push({ topic: 'tns1:RuleEngine/PeopleDetector/People', name: 'State', value: 'true' });
      const info = await until('the events', show, (info) => endpoint(info, 'motion')?.last?.value === true && endpoint(info, 'person')?.last?.value === true);
      assertEquals([endpoint(info, 'motion')?.deviceClass, endpoint(info, 'person')?.label], ['motion', 'Person']);
      camera.events.push({ topic: 'tns1:RuleEngine/CellMotionDetector/Motion', name: 'IsMotion', value: 'false' });
      await until('motion over', show, (info) => endpoint(info, 'motion')?.last?.value === false);
    });

    await t.step('tampering, a line crossed and the memory card failing are logged as the camera lists them', async () => {
      const listed = await until('their endpoints', show, (info) => ['tamper', 'line-crossing', 'storage-failure'].every((name) => !!endpoint(info, name)));
      assertEquals(endpoint(listed, 'sound'), undefined);
      camera.events.push({ topic: 'tns1:RuleEngine/TamperDetector/Tamper', name: 'IsTamper', value: 'true' });
      camera.events.push({ topic: 'tns1:RuleEngine/LineDetector/Crossed', name: 'ObjectId', value: '0' });
      camera.events.push({ topic: 'tns1:Device/HardwareFailure/StorageFailure', name: 'Failed', value: 'true' });
      const info = await until(
        'the events',
        show,
        (info) =>
          endpoint(info, 'tamper')?.last?.value === true && endpoint(info, 'line-crossing')?.last?.value === 'crossed' &&
          endpoint(info, 'storage-failure')?.last?.value === true,
      );
      assertEquals([endpoint(info, 'line-crossing')?.events, endpoint(info, 'storage-failure')?.category], [true, 'diagnostic']);
    });

    await t.step('a preset and a move are sent to the camera', async () => {
      const info = await until('the controls', show, (info) => !!endpoint(info, 'ptz-preset'));
      assertEquals(endpoint(info, 'ptz-preset')?.schema, { type: 'enum', options: ['Gate', 'Driveway'] });
      assertEquals(info.endpointList.filter((each) => each.schema?.type === 'momentary').map((each) => each.name).sort(), [
        'ptz-down',
        'ptz-left',
        'ptz-right',
        'ptz-up',
        'ptz-zoom-in',
        'ptz-zoom-out',
      ]);
      await admin.execString('echo Driveway > /dev/gate/ptz-preset && echo press > /dev/gate/ptz-left && echo press > /dev/gate/ptz-zoom-in');
      assertEquals(camera.ptz, ['goto 2', 'move -0.5,0 -', 'stop', 'move - 0.5', 'stop']);
      assertEquals(endpoint(await show(), 'ptz-preset')?.last?.value, 'Driveway');
    });

    await t.step('forgetting the camera takes its streams from the restreamer and lets its events go', async () => {
      await admin.execString('device-forget gate');
      assertEquals(restreamer.sources.size, 0);
      await until('the PullPoint let go', async () => camera.asked, (asked) => asked.includes('Unsubscribe'));
    });
  } finally {
    admin.close();
    await testCtx.teardown();
    await restreamer.server.shutdown();
    await camera.server.shutdown();
    await files?.stop();
    await ems.close();
  }
});

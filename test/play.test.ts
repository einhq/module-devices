/**
 * What is written to a speaker's or a screen's `show`, in a booted core with the device's ways and the media
 * service stood in for. Recordings:
 * each path given as an address with a ticket the device reads that file with, a recording's
 * `playback` rendition before its original unless the device plays only the original, what is not a
 * readable recording refused, the tickets kept while it plays and dropped when it is done, a queue a
 * Cast device let go of while it played given again from where it was, once, a renderer given the
 * next when one ended, and a TV whose Cast does not answer played on over its DLNA renderer. Videos:
 * an H.264 original within 1080p as it is, any other as HLS made segment by segment, EiN's AV1 copy
 * or the original as the device's setting says, one stream for a renderer or a video of no known
 * length. Pictures as their largest rendition, moved on from after their time. Any other path a
 * page, streamed live as the writer sees it, and stopped with the list. While the media service is
 * not there, only what the device plays as it is, and a page refused.
 */

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, GUEST_ACCESS, SystemTestHarness } from '@ein/testing';
import { DEFAULT_SETTINGS, type Media, mediaAddress, MediaPlayer, type Status, Unreachable, type VideoStreamRequest, type Way, type WayCommand } from '../lib/network/play.ts';

const harness = new SystemTestHarness({ ssh: false });

const write = async (vfs: Awaited<ReturnType<typeof harness.start>>['vfs'], dir: string, name: string, mimetype: string, text: string, mode?: number) => {
  await vfs.create(ADMIN_ACCESS, 'file', dir, name, { attrs: { name, mimetype }, ...(mode ? { props: { mode } } : {}) });
  const handle = await vfs.open(ADMIN_ACCESS, `${dir}/${name}`, { mode: 'w' });
  await handle.write(new TextEncoder().encode(text));
  await handle.close();
};

/** A way that records what it is given and answers as it is told. */
class FakeWay implements Way {
  loads: { items: Media[]; start: number; seconds: number }[] = [];
  commands: WayCommand[] = [];
  answers = true;
  constructor(readonly kind: Way['kind'], readonly queues: boolean, private readonly plays?: string[]) {}
  #reach() {
    if (!this.answers) throw new Unreachable(`${this.kind} does not answer`);
  }
  status(): Promise<Status> {
    this.#reach();
    return Promise.resolve({ player: 'idle', playing: null });
  }
  command(command: WayCommand): Promise<void> {
    this.#reach();
    this.commands.push(command);
    return Promise.resolve();
  }
  load(items: Media[], start: number, seconds: number): Promise<void> {
    this.#reach();
    this.loads.push({ items, start, seconds });
    return Promise.resolve();
  }
  get pick() {
    const plays = this.plays;
    return plays ? (types: string[]) => Promise.resolve(types.find((type) => plays.includes(type))) : undefined;
  }
}

Deno.test("EiN's address for devices is the setting, else the listener's host on EiN's port", () => {
  assertEquals(mediaAddress('http://ein.lan:8080/', '192.168.1.10:1883', '8080'), 'http://ein.lan:8080');
  assertEquals(mediaAddress('', '192.168.1.10:1883', '8090'), 'http://192.168.1.10:8090');
  assertEquals(mediaAddress(undefined, '192.168.1.10:1883', undefined), 'http://192.168.1.10:8080');
  assertEquals(mediaAddress('', undefined, '8080'), undefined);
});

Deno.test({ name: 'recordings written to a speaker or a screen', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { baseUrl, devices, vfs } = await harness.start();
  await vfs.create(ADMIN_ACCESS, 'dir', '/', 'music', {});
  await write(vfs, '/music', 'first song.mp3', 'audio/mpeg', 'the original');
  await vfs.create(ADMIN_ACCESS, 'dir', '/music/first song.mp3', 'thumbnails', {});
  await write(vfs, '/music/first song.mp3/thumbnails', '128k-44100.m4a', 'audio/mp4', 'the playback copy');
  await write(vfs, '/music', 'second.flac', 'audio/flac', 'the second');
  await write(vfs, '/music', 'notes.txt', 'text/plain', 'some words');
  await write(vfs, '/music', 'private.flac', 'audio/flac', 'not for guests', 0o600);
  await write(vfs, '/etc', 'renditions.yaml', 'text/yaml', 'audio:\n  playback: { bitrate: 128k, sampleRate: 44100 }\n');

  const woken: string[] = [];
  const player = new MediaPlayer({ vfs, devices, address: () => baseUrl, wake: (device) => woken.push(device) });
  const cast = new FakeWay('cast', true);
  /** What is written to a device's `show`, and as whom. */
  const input = (text: string, access = ADMIN_ACCESS) => [text, access] as const;
  const read = async (url: string) => {
    const res = await fetch(url);
    return [res.status, await res.text()];
  };
  const playing = (url: string | undefined, player: Status['player'] = 'playing', more: Partial<Status> = {}): Status => ({
    url,
    player,
    playing: null,
    seconds: 42,
    ...more,
  });

  try {
    await t.step('each path is given as an address with a ticket, the playback copy before the original', async () => {
      const answer = await player.play('hall-speaker', [cast], ...input('/music/first song.mp3\n/music/second.flac\n'));
      assertEquals(answer, { message: 'playing 2 things, from first song.mp3' });
      const [first, second] = cast.loads[0].items;
      assertEquals([first.contentType, first.title, second.contentType], ['audio/mp4', 'first song.mp3', 'audio/flac']);
      assertStringIncludes(first.url, `${baseUrl}/file/music/first%20song.mp3/thumbnails/128k-44100.m4a?ticket=`);
      assertEquals(await read(first.url), [200, 'the playback copy']);
      assertEquals(await read(second.url), [200, 'the second']);
      assertEquals((await read(first.url.replace('first%20song.mp3/thumbnails/128k-44100.m4a', 'second.flac')))[0], 403);
    });

    await t.step('what is not something to play the writer may read is refused', async () => {
      await assertRejects(() => player.play('hall-speaker', [cast], ...input('music/second.flac')), Error, 'write a path from /');
      await assertRejects(() => player.play('hall-speaker', [cast], ...input('/music/notes.txt')), Error, 'not a recording, a video or a picture');
      await assertRejects(() => player.play('hall-speaker', [cast], ...input('/music')), Error, 'find /music -type f');
      await assertRejects(() => player.play('hall-speaker', [cast], ...input('/music/gone.mp3')), Error, 'no such file');
      await assertRejects(() => player.play('hall-speaker', [cast], ...input('/dashboard-wall/Kitchen')), Error, 'pages are rendered by the media service');
      await assertRejects(() => player.play('hall-speaker', [cast], ...input('/music/private.flac', GUEST_ACCESS)));
      await assertRejects(() => player.play('hall-speaker', [cast], ...input('\n')), Error, 'one per line');
      assertEquals(cast.loads.length, 1);
    });

    await t.step('let go of while it played, it is given again from where it was, once', async () => {
      const [, second] = cast.loads[0].items;
      await player.polled('hall-speaker', cast, playing(second.url), Date.now());
      await player.polled('hall-speaker', cast, { player: 'idle', playing: 'Backdrop', letGo: true }, Date.now());
      assertEquals(cast.loads.length, 2);
      assertEquals([cast.loads[1].items.map((media) => media.title), cast.loads[1].seconds], [['second.flac'], 42]);
      assertEquals((await read(second.url))[0], 403);
      assertEquals(await read(cast.loads[1].items[0].url), [200, 'the second']);

      await player.polled('hall-speaker', cast, { player: 'idle', playing: null, letGo: true }, Date.now());
      assertEquals(cast.loads.length, 2);
      assertEquals((await read(cast.loads[1].items[0].url))[0], 403);
    });

    await t.step('a finished queue, or one another app took over, is let go', async () => {
      await player.play('hall-speaker', [cast], ...input('/music/second.flac'));
      await player.polled('hall-speaker', cast, playing(cast.loads[2].items[0].url), Date.now());
      assertEquals(await read(cast.loads[2].items[0].url), [200, 'the second']);
      await player.polled('hall-speaker', cast, playing(undefined, 'idle'), Date.now());
      assertEquals((await read(cast.loads[2].items[0].url))[0], 403);

      await player.play('hall-speaker', [cast], ...input('/music/second.flac'));
      await player.polled('hall-speaker', cast, { player: 'playing', playing: 'Spotify' }, Date.now());
      assertEquals(cast.loads.length, 4);
      assertEquals((await read(cast.loads[3].items[0].url))[0], 403);
    });

    const renderer = new FakeWay('dlna', false, ['audio/mp4', 'audio/mpeg']);

    await t.step('a renderer is given the files it plays, and refuses a recording it plays none of', async () => {
      await assertRejects(() => player.play('tv', [renderer], ...input('/music/second.flac')), Error, 'it plays none of audio/flac');
      const plainRenderer = new FakeWay('dlna', false, ['audio/mpeg']);
      await player.play('tv', [plainRenderer], ...input('/music/first song.mp3'));
      assertEquals(await read(plainRenderer.loads[0].items[0].url), [200, 'the original']);
      player.forget('tv');
    });

    await t.step('a renderer is given the next when the one it played ended, and asked again as it should end', async () => {
      await write(vfs, '/music', 'third.mp3', 'audio/mpeg', 'the third');
      await player.play('tv', [renderer], ...input('/music/first song.mp3\n/music/third.mp3'));
      assertEquals(renderer.loads.map((load) => load.start), [0]);
      const [first, third] = renderer.loads[0].items;
      await player.polled('tv', renderer, playing(first.url, 'playing', { seconds: 100, duration: 100.5 }), Date.now());
      await new Promise((resolve) => setTimeout(resolve, 2100));
      assertEquals(woken, ['tv']);
      await player.polled('tv', renderer, playing(first.url, 'idle'), Date.now());
      assertEquals(renderer.loads.map((load) => load.start), [0, 1]);
      assertEquals(await read(third.url), [200, 'the third']);

      await player.polled('tv', renderer, playing(third.url, 'playing', { seconds: 199, duration: 200 }), Date.now());
      await player.polled('tv', renderer, playing(third.url, 'idle'), Date.now());
      assertEquals(renderer.loads.length, 2);
      assertEquals((await read(third.url))[0], 403);
    });

    await t.step('a renderer that stays playing at the end of one, its position no longer moving, is given the next', async () => {
      await player.play('tv', [renderer], ...input('/music/first song.mp3\n/music/third.mp3'));
      const loaded = renderer.loads.length;
      const [first] = renderer.loads[loaded - 1].items;
      await player.polled('tv', renderer, playing(first.url, 'playing', { seconds: 23, duration: 25 }), Date.now());
      await player.polled('tv', renderer, playing(first.url, 'playing', { seconds: 24, duration: 25 }), Date.now());
      assertEquals(renderer.loads.length, loaded);
      await player.polled('tv', renderer, playing(first.url, 'playing', { seconds: 24, duration: 25 }), Date.now());
      assertEquals(renderer.loads.at(-1)?.start, 1);
      player.forget('tv');
    });

    await t.step('a renderer stopped before the end, or given something else, is let go', async () => {
      await player.play('tv', [renderer], ...input('/music/first song.mp3\n/music/third.mp3'));
      const [first] = renderer.loads.at(-1)!.items;
      await player.polled('tv', renderer, playing(first.url, 'playing', { seconds: 10, duration: 100 }), Date.now());
      await player.polled('tv', renderer, playing(undefined, 'idle'), Date.now());
      assertEquals(renderer.loads.length, 5);
      assertEquals((await read(first.url))[0], 403);

      await player.play('tv', [renderer], ...input('/music/third.mp3'));
      await player.polled('tv', renderer, playing('http://phone/song.mp3'), Date.now());
      assertEquals((await read(renderer.loads.at(-1)!.items[0].url))[0], 403);
    });

    await t.step('a TV whose Cast does not answer is played on, asked and told over its renderer', async () => {
      const tvCast = new FakeWay('cast', true);
      tvCast.answers = false;
      await player.play('living-room-tv', [tvCast, renderer], ...input('/music/third.mp3'));
      assertEquals([tvCast.loads.length, renderer.loads.length], [0, 7]);
      await player.command('living-room-tv', [tvCast, renderer], { type: 'pause' });
      assertEquals(renderer.commands, [{ type: 'pause' }]);
      tvCast.answers = true;
      await player.command('living-room-tv', [tvCast, renderer], { type: 'stop' });
      assertEquals([renderer.commands, tvCast.commands], [[{ type: 'pause' }, { type: 'stop' }], []]);
      assertEquals((await read(renderer.loads.at(-1)!.items[0].url))[0], 403);
      tvCast.answers = false;
      renderer.answers = false;
      await assertRejects(() => player.status('living-room-tv', [tvCast, renderer]), Unreachable);
    });
  } finally {
    await harness.stop();
  }
});

Deno.test({ name: 'videos, pictures and pages written to a screen', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { baseUrl, devices, vfs } = await harness.start();
  const file = async (dir: string, name: string, attrs: Record<string, unknown>, text = name) => {
    await vfs.create(ADMIN_ACCESS, 'file', dir, name, { attrs: { name, ...attrs } });
    const handle = await vfs.open(ADMIN_ACCESS, `${dir}/${name}`, { mode: 'w' });
    await handle.write(new TextEncoder().encode(text));
    await handle.close();
  };
  for (const dir of ['films', 'photos']) await vfs.create(ADMIN_ACCESS, 'dir', '/', dir, {});
  await file('/films', 'boat.mp4', { mimetype: 'video/mp4', codec: 'h264', width: 1920, height: 1080, duration: 10 });
  await file('/films', 'sea.mov', { mimetype: 'video/quicktime', codec: 'hevc', width: 1920, height: 1080, duration: 10 });
  await vfs.create(ADMIN_ACCESS, 'dir', '/films/sea.mov', 'thumbnails', {});
  await file('/films/sea.mov/thumbnails', '1920x1080.mp4', { mimetype: 'video/mp4' }, 'the AV1 copy');
  await file('/films', 'turned.mp4', { mimetype: 'video/mp4', codec: 'h264', width: 1920, height: 1080, duration: 10, angle: 90 });
  await file('/films', 'long.mov', { mimetype: 'video/quicktime', codec: 'hevc', width: 1920, height: 1080, duration: 60 });
  await file('/films', 'old.avi', { mimetype: 'video/x-msvideo', codec: 'mpeg4', width: 640, height: 480 });
  await file('/photos', 'a.jpg', { mimetype: 'image/jpeg' });
  await vfs.create(ADMIN_ACCESS, 'dir', '/photos/a.jpg', 'thumbnails', {});
  await file('/photos/a.jpg/thumbnails', '2560x2560.avif', { mimetype: 'image/avif', sourceId: 'a-jpg' }, 'the large rendition');
  await file('/photos', 'b.heic', { mimetype: 'image/heic' });
  await file('/photos', 'c.png', { mimetype: 'image/png' });
  await file(
    '/etc',
    'renditions.yaml',
    { mimetype: 'text/yaml' },
    'image:\n  large: { width: 2560, height: 2560, fit: contain, quality: 60, kinds: [photo] }\n  medium: { width: 1600, height: 1600, fit: contain, quality: 60 }\n' +
      'video:\n  playback: { width: 1920, height: 1080, crf: 32, preset: 8 }\n',
  );

  const streamed: { path: string; request: VideoStreamRequest }[] = [];
  const pages: { route: string; uid: number; stopped: boolean }[] = [];
  const woken: string[] = [];
  const text = (value: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    });
  /** What the media service makes, as the player asks it. */
  const service = { video: true, pages: true };
  const player = new MediaPlayer({
    vfs,
    devices,
    address: () => baseUrl,
    wake: (device) => woken.push(device),
    mediaService: () => Promise.resolve({ ...service }),
    streamVideo: (path, request) => {
      streamed.push({ path, request });
      return Promise.resolve(text(`${path} ${request.start ?? 0}+${request.duration ?? '∞'} ${request.format}`));
    },
    streamPage: (route, access) => {
      const page = { route, uid: access.uid, stopped: false };
      pages.push(page);
      const served = devices.serveLive((format) => Promise.resolve(text(`${route} as ${format}`)));
      return Promise.resolve({ path: served.path, stop: () => Promise.resolve(void (page.stopped = true, served.end())) });
    },
  });
  // As the Default Media Receiver: files, HLS and fragmented MP4, never MPEG-TS on its own.
  const cast = new FakeWay('cast', true, ['application/x-mpegurl', 'video/mp4', 'video/quicktime', 'image/avif', 'image/png', 'image/jpeg']);
  const renderer = new FakeWay('dlna', false, ['video/mp2t', 'video/mp4', 'image/jpeg', 'image/png']);
  /** What is written to the device's `show`, and as whom. */
  const input = (text: string) => [text, ADMIN_ACCESS] as const;
  const read = async (url: string) => {
    const res = await fetch(url);
    return [res.status, await res.text()];
  };
  const last = (way: FakeWay) => way.loads[way.loads.length - 1].items;

  try {
    await t.step('an H.264 original within 1080p goes as it is, any other video as HLS made while it plays', async () => {
      await player.play('tv', [cast], ...input('/films/boat.mp4\n/films/sea.mov\n/films/turned.mp4'));
      const [boat, sea, turned] = last(cast);
      assertEquals([boat.contentType, sea.contentType, turned.contentType], ['video/mp4', 'application/x-mpegurl', 'application/x-mpegurl']);
      assertEquals(await read(boat.url), [200, 'boat.mp4']);
      const [status, playlist] = await read(sea.url);
      assertEquals(status, 200);
      assertStringIncludes(String(playlist), '#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.000,\n0.ts\n#EXTINF:4.000,\n1.ts\n#EXTINF:2.000,\n2.ts\n#EXT-X-ENDLIST');
      assertEquals(streamed, []);
      assertEquals(await read(sea.url.replace('index.m3u8', '1.ts')), [200, '/films/sea.mov 4+4 mpegts']);
      assertEquals(streamed[0].request, { angle: 0, mirror: false, codec: 'hevc', start: 4, duration: 4, sourceClock: true, format: 'mpegts' });
      // The next is made while that one is sent; past the last there is none.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(streamed.map((each) => each.request.start), [4, 8]);
      assertEquals(await read(sea.url.replace('index.m3u8', '2.ts')), [200, '/films/sea.mov 8+2 mpegts']);
      assertEquals((await read(sea.url.replace('index.m3u8', '3.ts')))[0], 404);
      assertEquals(await read(turned.url.replace('index.m3u8', '0.ts')), [200, '/films/turned.mp4 0+4 mpegts']);
      assertEquals(streamed[2].request.angle, 90);

      player.forget('tv');
      assertEquals((await read(sea.url))[0], 404);
      assertEquals((await read(boat.url))[0], 403);
    });

    await t.step('the video the device starts on is begun before it asks, and so is where EiN tells it to seek', async () => {
      streamed.length = 0;
      await player.play('tv', [cast], ...input('/films/long.mov\n/films/sea.mov'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The first 16 s; the video after it waits to be asked for.
      assertEquals(streamed.map((each) => `${each.path} ${each.request.start ?? 0}`), ['/films/long.mov 0', '/films/long.mov 4', '/films/long.mov 8', '/films/long.mov 12']);
      const [long] = last(cast);
      assertEquals(await read(long.url.replace('index.m3u8', '0.ts')), [200, '/films/long.mov 0+4 mpegts']);
      assertEquals(streamed.length, 4);
      await player.command('tv', [cast], { type: 'seek', seconds: 30 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(streamed.slice(4).map((each) => each.request.start), [28, 32, 36, 40]);
      assertEquals(cast.commands, [{ type: 'seek', seconds: 30 }]);
      cast.commands.length = 0;
      player.forget('tv');
    });

    await t.step("video=av1 gives EiN's AV1 copy and video=original the original, else the stream", async () => {
      await player.play('tv', [cast], ...input('/films/sea.mov\n/films/old.avi'), { ...DEFAULT_SETTINGS, video: 'av1' });
      const [sea, old] = last(cast);
      assertEquals(await read(sea.url), [200, 'the AV1 copy']);
      // With no length known there is no playlist: one stream, as fragmented MP4.
      assertEquals(old.contentType, 'video/mp4');
      assertEquals(await read(old.url), [200, '/films/old.avi 0+∞ mp4']);
      await player.play('tv', [cast], ...input('/films/sea.mov'), { ...DEFAULT_SETTINGS, video: 'original' });
      assertEquals(last(cast)[0].contentType, 'video/quicktime');
      assertEquals(await read(last(cast)[0].url), [200, 'sea.mov']);
      assertEquals((await read(old.url))[0], 404);
    });

    await t.step('a renderer is given a video as one MPEG-TS stream', async () => {
      await player.play('tv', [renderer], ...input('/films/sea.mov'));
      const [sea] = last(renderer);
      assertEquals(sea.contentType, 'video/mp2t');
      assertEquals(await read(sea.url), [200, '/films/sea.mov 0+∞ mpegts']);
      player.forget('tv');
    });

    await t.step('a picture goes as its largest rendition, else a JPEG or PNG as it is, and is moved on from after its time', async () => {
      await assertRejects(() => player.play('tv', [cast], ...input('/photos/b.heic')), Error, 'no form of it');
      // As `find /photos -type f` lists them: a rendition beside originals is left out, one alone is played.
      // One thing each: a rendition beside its original is left out.
      assertEquals(/ things,/.test((await player.play('tv', [cast], ...input('/photos/a.jpg\n/photos/a.jpg/thumbnails/2560x2560.avif'))).message), false);
      assertEquals(/ things,/.test((await player.play('tv', [cast], ...input('/photos/a.jpg/thumbnails/2560x2560.avif'))).message), false);
      await player.play('tv', [cast], ...input('/photos/a.jpg\n/photos/c.png\n/films/boat.mp4'));
      const [a, c] = last(cast);
      assertEquals([a.contentType, c.contentType], ['image/avif', 'image/png']);
      assertEquals(await read(a.url), [200, 'the large rendition']);
      await player.polled('tv', cast, { player: 'paused', playing: null, url: a.url }, Date.now());
      assertEquals(cast.commands, []);
      await player.polled('tv', cast, { player: 'paused', playing: null, url: a.url }, Date.now() + 6000);
      assertEquals(cast.commands, [{ type: 'next' }]);
      // The next picture's time runs from when the device was moved on to it.
      await player.polled('tv', cast, { player: 'paused', playing: null, url: c.url }, Date.now() + 4000);
      assertEquals(cast.commands, [{ type: 'next' }]);
      await player.polled('tv', cast, { player: 'paused', playing: null, url: c.url }, Date.now() + 6000);
      assertEquals(cast.commands, [{ type: 'next' }, { type: 'next' }]);

      // The last picture stays; a renderer is given the next itself, and a poll asked for as the picture's time ends.
      await player.play('tv', [renderer], ...input('/photos/c.png\n/photos/a.jpg'), { ...DEFAULT_SETTINGS, pictureMs: 300 });
      assertEquals(last(renderer).map((item) => item.contentType), ['image/png', 'image/jpeg']);
      await new Promise((resolve) => setTimeout(resolve, 900));
      assertEquals(woken, ['tv']);
      await player.polled('tv', renderer, { player: 'playing', playing: null, url: last(renderer)[0].url }, Date.now());
      assertEquals(renderer.loads.map((load) => load.start).slice(-2), [0, 1]);
      await player.polled('tv', renderer, { player: 'playing', playing: null, url: last(renderer)[1].url }, Date.now() + 60_000);
      assertEquals(renderer.loads.map((load) => load.start).slice(-2), [0, 1]);
      player.forget('tv');
    });

    await t.step('any other path is a page, streamed live as the writer sees it, the last line only', async () => {
      await assertRejects(() => player.play('tv', [cast], ...input('/films/typo.mp4')), Error, 'no such file');
      await assertRejects(() => player.play('tv', [cast], ...input('/dashboard-wall/Kitchen\n/films/boat.mp4')), Error, 'only be the last line');
      assertEquals(pages, []);
      await player.play('tv', [cast], ...input('/films/boat.mp4\n/albums/Summer?slideshow=screen'));
      const [, page] = last(cast);
      assertEquals([page.contentType, page.live], ['video/mp4', true]);
      assertEquals(await read(page.url), [200, '/albums/Summer?slideshow=screen as mp4']);
      assertEquals(pages.map(({ route, uid, stopped }) => [route, uid, stopped]), [['/albums/Summer?slideshow=screen', ADMIN_ACCESS.uid, false]]);
      await player.play('tv', [renderer], ...input('/dashboard-wall/Kitchen'));
      assertEquals(pages[0].stopped, true);
      assertEquals(await read(last(renderer)[0].url), [200, '/dashboard-wall/Kitchen as ts']);
      await player.command('tv', [renderer], { type: 'stop' });
      assertEquals(pages[1].stopped, true);
    });

    await t.step('while the media service is not there, a screen is given what it plays as it is, and the rest refused saying so', async () => {
      Object.assign(service, { video: false, pages: false });
      streamed.length = 0;
      await player.play('tv', [cast], ...input('/photos/a.jpg\n/films/boat.mp4'));
      assertEquals(last(cast).map((item) => item.contentType), ['image/avif', 'video/mp4']);
      await assertRejects(
        () => player.play('tv', [cast], ...input('/films/sea.mov')),
        Error,
        '/films/sea.mov: a device is given it as H.264 by the media service, which is not there',
      );
      await player.play('tv', [cast], ...input('/films/sea.mov'), { ...DEFAULT_SETTINGS, video: 'original' });
      assertEquals(last(cast)[0].contentType, 'video/quicktime');
      await assertRejects(
        () => player.play('tv', [cast], ...input('/dashboard-wall/Kitchen')),
        Error,
        '/dashboard-wall/Kitchen: no such file, and pages are rendered by the media service, which is not there',
      );
      assertEquals([streamed.length, pages.length], [0, 2]);
      // It is asked again at each play, so a media service that came back is used.
      Object.assign(service, { video: true, pages: true });
      await player.play('tv', [cast], ...input('/films/sea.mov'));
      assertEquals(last(cast)[0].contentType, 'application/x-mpegurl');
      player.forget('tv');
    });
  } finally {
    await harness.stop();
  }
});

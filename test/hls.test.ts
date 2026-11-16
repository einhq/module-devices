/**
 * A video as HLS made while it plays: the playlist names every segment with its length, a segment
 * is made when asked for and the next three after it, one at a time, the segments from a second are
 * begun before they are asked for, a segment asked for out of turn drops what was made ahead, and a
 * closed video makes nothing more.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { HlsVideo } from '../lib/network/hls.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Long enough for every segment begun to be made. */
const made = () => new Promise((resolve) => setTimeout(resolve, 200));

/** A media service stand-in: each part asked for, how many run at once, and which were cancelled. */
const service = () => {
  const asked: number[] = [];
  const cancelled: number[] = [];
  let running = 0, most = 0;
  let failAt: number | undefined;
  const stream = async (start: number, duration: number): Promise<ReadableStream<Uint8Array>> => {
    asked.push(start);
    if (start === failAt) throw new Error('busy');
    running++;
    most = Math.max(most, running);
    await settle();
    let sent = false;
    return new ReadableStream({
      pull(controller) {
        if (sent) {
          running--;
          return controller.close();
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode(`${start}+${duration}`));
      },
      cancel() {
        running--;
        cancelled.push(start);
      },
    });
  };
  return { stream, asked, cancelled, most: () => most, fail: (at: number) => failAt = at };
};

const text = async (video: HlsVideo, name: string) => {
  const file = await video.get(name);
  return file && new TextDecoder().decode(file.body as Uint8Array);
};

Deno.test('the playlist names each segment with its length, the last one short', async () => {
  const video = new HlsVideo(service().stream, 9.5);
  const playlist = await text(video, 'index.m3u8');
  assertEquals(
    playlist,
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
      '#EXTINF:4.000,\n0.ts\n#EXTINF:4.000,\n1.ts\n#EXTINF:1.500,\n2.ts\n#EXT-X-ENDLIST\n',
  );
  assertEquals((await video.get('index.m3u8'))?.type, 'application/vnd.apple.mpegurl');
  for (const name of ['3.ts', '-1.ts', 'x.ts', 'index.m3u']) assertEquals(await video.get(name), undefined);
});

Deno.test('a segment is made when asked for and the next three after it, one at a time', async () => {
  const media = service();
  const video = new HlsVideo(media.stream, 60);
  assertEquals(await text(video, '0.ts'), '0+4');
  await made();
  assertEquals(media.asked, [0, 4, 8, 12]);
  assertEquals(media.most(), 1);
  assertEquals(await text(video, '1.ts'), '4+4');
  assertEquals(await text(video, '2.ts'), '8+4');
  await made();
  assertEquals(media.asked, [0, 4, 8, 12, 16, 20]);
});

Deno.test('the segments from a second are begun before they are asked for, and answered from what was made', async () => {
  const media = service();
  const video = new HlsVideo(media.stream, 600);
  video.prepare(0);
  await made();
  assertEquals(media.asked, [0, 4, 8, 12]);
  assertEquals(await text(video, '0.ts'), '0+4');
  assertEquals(await text(video, '1.ts'), '4+4');
  await made();
  assertEquals(media.asked, [0, 4, 8, 12, 16]);
  // A seek: what was made ahead is dropped, and the segment it lands in is begun, with the three after it.
  video.prepare(90);
  await made();
  assertEquals(media.asked.slice(-4), [88, 92, 96, 100]);
  assertEquals(media.most(), 1);
  const before = media.asked.length;
  assertEquals(await text(video, '22.ts'), '88+4');
  assertEquals(media.asked.length, before);
  // Past the end, the last is begun; closed, nothing.
  video.prepare(900);
  await made();
  assertEquals(media.asked.at(-1), 596);
  video.close();
  const closed = media.asked.length;
  video.prepare(0);
  await made();
  assertEquals(media.asked.length, closed);
});

Deno.test('a segment asked for out of turn drops what was made ahead, and a closed video makes nothing', async () => {
  const media = service();
  const video = new HlsVideo(media.stream, 600);
  await text(video, '0.ts');
  await settle();
  assertEquals(await text(video, '100.ts'), '400+4');
  await made();
  assertEquals(media.asked.slice(-4), [400, 404, 408, 412]);
  // What was made ahead of the first segment was dropped, so it is made again.
  const before = media.asked.filter((at) => at === 4).length;
  assertEquals(await text(video, '1.ts'), '4+4');
  assertEquals(media.asked.filter((at) => at === 4).length, before + 1);
  await settle();
  media.fail(412);
  await assertRejects(() => video.get('103.ts'), Error, 'busy');
  video.close();
  assertEquals(await video.get('101.ts'), undefined);
  assertEquals(await video.get('index.m3u8'), undefined);
});

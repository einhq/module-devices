/**
 * What a page reads of a live fragmented MP4, a camera's or a page's streamed as video: its
 * header's tracks named as a MediaSource is asked about them (H.264, HEVC, AAC from its
 * descriptors, FLAC), none for a codec it cannot name, and the stream cut into whole boxes however
 * its chunks cut them.
 */

import { assertEquals } from '@std/assert';
import { mediaTypeOf, Mp4Boxes } from '../ui/media/mp4.ts';
import { fragment, joined, mp4Header } from './mp4-boxes.ts';

const box = (kind: string, ...body: (Uint8Array | number[])[]): Uint8Array => {
  const inner = joined(...body.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part)));
  const out = new Uint8Array(8 + inner.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([...kind].map((char) => char.charCodeAt(0)), 4);
  out.set(inner, 8);
  return out;
};

/** A track whose one sample entry is `entry`. */
const trak = (entry: Uint8Array): Uint8Array => box('trak', box('mdia', box('minf', box('stbl', box('stsd', [0, 0, 0, 0, 0, 0, 0, 1], entry)))));

const visual = (kind: string, config: Uint8Array): Uint8Array => box(kind, new Uint8Array(78), config);
const audio = (kind: string, ...children: Uint8Array[]): Uint8Array => box(kind, new Uint8Array(28), ...children);

const header = (...traks: Uint8Array[]): Uint8Array => joined(box('ftyp', [0x69, 0x73, 0x6f, 0x6d]), box('moov', box('mvhd', [0, 0, 0, 0]), ...traks));

const avc = visual('avc1', box('avcC', [1, 0x64, 0x00, 0x29, 0xff]));
const hevc = visual('hvc1', box('hvcC', [1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 153]));
/** HE-AAC: an ES descriptor, its decoder config (MPEG-4 audio) and the config naming audio object type 5. */
const heAac = audio(
  'mp4a',
  box('esds', [0, 0, 0, 0], [0x03, 25, 0, 1, 0], [0x04, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0x05, 2, 0x2b, 0x10]),
);

Deno.test("a header's tracks are named as a MediaSource is asked", () => {
  assertEquals(mediaTypeOf(header(trak(avc), trak(heAac))), 'video/mp4; codecs="avc1.640029,mp4a.40.5"');
  assertEquals(mediaTypeOf(header(trak(hevc))), 'video/mp4; codecs="hvc1.1.6.L153.B0"');
  assertEquals(mediaTypeOf(header(trak(avc), trak(audio('fLaC')))), 'video/mp4; codecs="avc1.640029,flac"');
  assertEquals(mediaTypeOf(header(trak(avc), trak(audio('mp4a')))), 'video/mp4; codecs="avc1.640029,mp4a.40.2"');
  assertEquals(mediaTypeOf(header(trak(visual('vp08', new Uint8Array(0))))), undefined);
  assertEquals(mediaTypeOf(box('ftyp', [0, 0, 0, 0])), undefined);
});

Deno.test('a stream is cut into whole boxes however its chunks cut them', () => {
  const all = joined(mp4Header(), fragment(true, 1), fragment(false, 2));
  const boxes = new Mp4Boxes();
  const cut = [];
  for (let at = 0; at < all.length; at += 7) cut.push(...boxes.feed(all.subarray(at, at + 7)));
  assertEquals(cut.map((each) => each.kind), ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat']);
  assertEquals(joined(...cut.map((each) => each.bytes)), all);
});

/**
 * Fragmented MP4 as a page reads it from a live stream: cut into whole top-level boxes as its bytes
 * come, and its header's tracks named as a MediaSource is asked about them
 * (`video/mp4; codecs="avc1.640029,mp4a.40.2"`).
 */

const ascii = (data: Uint8Array, at: number): string => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);

const view = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);

/** A box's size, its 64-bit one when its 32-bit one is 1; 0 when there are too few bytes to tell. */
const boxSize = (data: Uint8Array, at: number): number => {
  const size = view(data).getUint32(at);
  if (size !== 1) return size;
  return at + 16 <= data.length ? Number(view(data).getBigUint64(at + 8)) : 0;
};

/** Each box in `data` from `start` to `end`: its type, offset and size. */
function* boxes(data: Uint8Array, start: number, end: number): Generator<[string, number, number]> {
  for (let at = start; at + 8 <= end;) {
    const size = boxSize(data, at);
    if (size < 8 || at + size > end) return;
    yield [ascii(data, at + 4), at, size];
    at += size;
  }
}

/** The first child of type `kind` of the box at `offset` whose children start `skip` bytes into it. */
const child = (data: Uint8Array, offset: number, size: number, kind: string, skip = 8): [number, number] | undefined => {
  for (const [found, at, length] of boxes(data, offset + skip, offset + size)) if (found === kind) return [at, length];
  return undefined;
};

/** The box at the end of `path` under the box at `offset`, each step its first child of that type. */
const descend = (data: Uint8Array, offset: number, size: number, ...path: string[]): [number, number] | undefined => {
  let found: [number, number] | undefined = [offset, size];
  for (const kind of path) found = found && child(data, ...found, kind);
  return found;
};

const hex = (value: number, width = 2): string => value.toString(16).padStart(width, '0');

/** A visual sample entry's children follow its 78 bytes of fields, an audio one's its 28. */
const VISUAL_FIELDS = 78;
const AUDIO_FIELDS = 28;

/** An MPEG-4 descriptor's tag, its size (1 to 4 bytes of 7 bits each) and where its body starts. */
const descriptor = (data: Uint8Array, at: number): { tag: number; size: number; body: number } => {
  let size = 0;
  let next = at + 1;
  for (let n = 0; n < 4; n++) {
    const byte = data[next++];
    size = (size << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return { tag: data[at], size, body: next };
};

/** AAC's codec from its `esds`: the object type and, for audio, the audio object type (`mp4a.40.2`). */
const aacCodec = (data: Uint8Array, esds: [number, number]): string => {
  try {
    const es = descriptor(data, esds[0] + 12);
    if (es.tag !== 0x03) return 'mp4a.40.2';
    const flags = data[es.body + 2];
    // After the ES's id and flags: the stream it depends on, a URL, and the clock's stream, each when flagged.
    let at = es.body + 3 + (flags & 0x80 ? 2 : 0);
    if (flags & 0x40) at += 1 + data[at];
    if (flags & 0x20) at += 2;
    const config = descriptor(data, at);
    if (config.tag !== 0x04) return 'mp4a.40.2';
    const objectType = data[config.body];
    const specific = descriptor(data, config.body + 13);
    if (specific.tag !== 0x05 || objectType !== 0x40) return `mp4a.${hex(objectType)}`;
    let audioType = data[specific.body] >> 3;
    if (audioType === 31) audioType = 32 + (((data[specific.body] & 0x07) << 3) | (data[specific.body + 1] >> 5));
    return `mp4a.40.${audioType}`;
  } catch {
    return 'mp4a.40.2';
  }
};

/** HEVC's codec from its `hvcC`, as RFC 6381 and ISO/IEC 14496-15 annex E say it (`hvc1.1.6.L153.B0`). */
const hevcCodec = (data: Uint8Array, kind: string, at: number): string => {
  const first = data[at + 1];
  const space = ['', 'A', 'B', 'C'][first >> 6];
  const compatible = view(data).getUint32(at + 2);
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++) if (compatible & (1 << bit)) reversed |= 1 << (31 - bit);
  const constraints = [...data.subarray(at + 6, at + 12)];
  while (constraints.length && constraints.at(-1) === 0) constraints.pop();
  const tail = constraints.map((byte) => `.${hex(byte).toUpperCase()}`).join('');
  return `${kind}.${space}${first & 0x1f}.${(reversed >>> 0).toString(16).toUpperCase()}.${first & 0x20 ? 'H' : 'L'}${data[at + 12]}${tail}`;
};

/** A track's codec from its first sample entry; undefined for one this page cannot name. */
const sampleCodec = (data: Uint8Array, entry: number, size: number): string | undefined => {
  const kind = ascii(data, entry + 4);
  if (kind === 'avc1' || kind === 'avc3') {
    const avcc = child(data, entry, size, 'avcC', 8 + VISUAL_FIELDS);
    return avcc && `${kind}.${hex(data[avcc[0] + 9])}${hex(data[avcc[0] + 10])}${hex(data[avcc[0] + 11])}`;
  }
  if (kind === 'hvc1' || kind === 'hev1') {
    const hvcc = child(data, entry, size, 'hvcC', 8 + VISUAL_FIELDS);
    return hvcc && hevcCodec(data, kind, hvcc[0] + 8);
  }
  if (kind === 'mp4a') {
    const esds = child(data, entry, size, 'esds', 8 + AUDIO_FIELDS);
    return esds ? aacCodec(data, esds) : 'mp4a.40.2';
  }
  if (kind === 'fLaC') return 'flac';
  if (kind === 'Opus') return 'opus';
  return undefined;
};

/**
 * What a MediaSource is asked to take for the stream whose header (`ftyp` and `moov`) is `header`:
 * its tracks' codecs in one MP4 type; undefined when a track's codec cannot be named here.
 */
export const mediaTypeOf = (header: Uint8Array): string | undefined => {
  const moov = [...boxes(header, 0, header.length)].find(([kind]) => kind === 'moov');
  if (!moov) return undefined;
  const codecs: string[] = [];
  for (const [kind, at, size] of boxes(header, moov[1] + 8, moov[1] + moov[2])) {
    if (kind !== 'trak') continue;
    const stsd = descend(header, at, size, 'mdia', 'minf', 'stbl', 'stsd');
    // stsd is a full box with an entry count before its entries.
    const entry = stsd && [...boxes(header, stsd[0] + 16, stsd[0] + stsd[1])][0];
    const codec = entry && sampleCodec(header, entry[1], entry[2]);
    if (!codec) return undefined;
    codecs.push(codec);
  }
  return codecs.length ? `video/mp4; codecs="${codecs.join(',')}"` : undefined;
};

/** A stream's bytes cut into whole top-level boxes as they come; throws on bytes that are not boxes. */
export class Mp4Boxes {
  #buffer = new Uint8Array(0);

  feed(data: Uint8Array): { kind: string; bytes: Uint8Array }[] {
    const buffer = new Uint8Array(this.#buffer.length + data.length);
    buffer.set(this.#buffer);
    buffer.set(data, this.#buffer.length);
    const out: { kind: string; bytes: Uint8Array }[] = [];
    let at = 0;
    while (buffer.length - at >= 8) {
      const size = boxSize(buffer, at);
      if (size === 0) break;
      if (size < 8) throw new Error(`an MP4 box of ${size} bytes`);
      if (buffer.length - at < size) break;
      out.push({ kind: ascii(buffer, at + 4), bytes: buffer.subarray(at, at + size) });
      at += size;
    }
    this.#buffer = buffer.slice(at);
    return out;
  }
}

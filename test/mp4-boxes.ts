/** Fragmented MP4 as the tests make it: a header, and fragments of one sample each. */

export const joined = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) (out.set(part, at), at += part.length);
  return out;
};

/** An MP4 box of `kind` holding `body`. */
const box = (kind: string, ...body: Uint8Array[]): Uint8Array => {
  const inner = joined(...body);
  const out = new Uint8Array(8 + inner.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set([...kind].map((char) => char.charCodeAt(0)), 4);
  out.set(inner, 8);
  return out;
};

const words = (...values: number[]): Uint8Array => {
  const out = new Uint8Array(values.length * 4);
  values.forEach((value, n) => new DataView(out.buffer).setUint32(n * 4, value));
  return out;
};

/** A header: `ftyp` and a `moov`. */
export const mp4Header = (): Uint8Array => joined(box('ftyp', new TextEncoder().encode('isom')), box('moov', box('mvhd', words(0))));

/** A fragment of one sample, a keyframe or not (its `trun`'s first-sample flags), its data `fill`. */
export const fragment = (key: boolean, fill: number): Uint8Array =>
  joined(
    box('moof', box('traf', box('tfhd', words(0, 1)), box('trun', words(0x4, 1, key ? 0 : 0x10000)))),
    box('mdat', new Uint8Array(40).fill(fill)),
  );

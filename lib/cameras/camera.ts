/**
 * What every camera driver does, whatever it asks the camera with: its profiles, `main` and, when it
 * has a second, smaller one, `sub`, are each given to the restreamer as `<device>-<profile>`, which
 * keeps one connection to the camera however many watch it, and are each two stream nodes the
 * driver writes from the restreamer while anyone reads them (`StreamFeed`): `main.ts`, MPEG-TS, which
 * the media service reads through a name it is granted, and `main.mp4`, fragmented MP4, which a
 * page reads over `GET /file/…` to watch it live. The restreamer is given the streams it lacks, as
 * after the sidecar started anew, every minute and whenever a reader asks for one it does not have.
 * Without a restreamer nothing is written to the nodes, and there is no MP4 node to watch.
 *
 * Each profile also has a picture node, `main.jpg` and `sub.jpg`: a stream of JPEGs, a read of
 * which is the latest picture, or the next when that is not fresh. The driver makes a picture only
 * when a reader waits for one (the node's `wanted`): the media service's first frame of the
 * profile's MPEG-TS node, or, without a restreamer, the camera's still picture.
 *
 * Every other minute the driver asks whether the camera answers: the restreamer's probe of its
 * smallest stream, which also says the stream's codec and sound, or without a restreamer its still
 * picture. The pictures say each stream's size where the camera did not; a stream whose size is
 * not known yet gets a picture made for it then.
 *
 * A kind of camera (`rtsp`, `onvif`) says where its streams and still picture are, and may keep
 * endpoints of its own beside them.
 */

import type { DeviceAttrs, DriverConfigField, EndpointAttrs, StreamInfo } from '@ein/api';
import { ADMIN_ACCESS, type Command, type Driver, isStreamWriter, type ModuleDevices, type StreamWriter } from '@ein/client';
import { DEV_PATH, devicePath } from '@ein/paths';
import { streamPoster } from '@ems/client';
import type { Fetch } from '../network/adopt.ts';
import type { NetworkHosts } from '../network/found.ts';
import { StreamFeed } from './feed.ts';
import { jpegSize, type Restreamer, type StreamFormat } from './restreamer.ts';

/** The profiles a camera's streams may be, largest first. */
const STREAM_PROFILES = ['main', 'sub'] as const;

/** Each profile's stream nodes: the format, which is the node's extension, and its media type. */
const STREAM_FORMATS: { format: StreamFormat; mimetype: string }[] = [
  { format: 'ts', mimetype: 'video/mp2t' },
  { format: 'mp4', mimetype: 'video/mp4' },
];

/** What a picture node carries: one JPEG a write. */
const PICTURE_MIMETYPE = 'image/jpeg';

const CHECK_EVERY_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;

/** How long after a picture could not be made the next is tried, while a reader still waits. */
const PICTURE_RETRY_MS = 5_000;

export type CameraOptions = {
  cmd: Command;
  devices: ModuleDevices;
  /** Unset when no restreamer is set (`CFG_DEVICES_STREAMS_URL`). */
  restreamer?: Restreamer;
  fetcher: Fetch;
  /** What the network listener heard, by which a camera found there is followed to a new address. */
  network?: NetworkHosts;
  log(line: string): void;
};

/** One of a camera's streams: its profile, and its address with the camera's credentials in it. */
export type CameraStream = { profile: (typeof STREAM_PROFILES)[number]; label: string; address: string; info?: StreamInfo };

/** Where a camera's still picture is, and who it is asked as. */
type CameraSnapshot = { url: string; user?: string; password?: string };

/** A kind of camera, as its driver asks it. */
export type CameraKind = {
  name: string;
  description: string;
  config: DriverConfigField[];
  /** The camera's streams, largest first; throws when the camera cannot say. */
  streams(device: string, attrs: DeviceAttrs): Promise<CameraStream[]>;
  /** Its still picture, when it has one. */
  snapshot(device: string, attrs: DeviceAttrs): Promise<CameraSnapshot | undefined>;
  /** Keeps what the camera has beside its streams, each minute and when it is made. */
  keep?(device: string, attrs: DeviceAttrs): Promise<void>;
  write?: Driver['write'];
  forget?(device: string): Promise<void>;
  /** The driver stops: let go of every camera. */
  stop?(): void;
};

/** An address with the camera's user and password in it, unless it carries its own. */
export const withCredentials = (address: string, user?: string, password?: string): string => {
  if (!user && !password) return address;
  const url = new URL(address);
  if (url.username || url.password) return address;
  url.username = encodeURIComponent(user ?? '');
  url.password = encodeURIComponent(password ?? '');
  return url.toString();
};

/** The restreamer's name for one of a device's streams. */
export const sourceName = (device: string, profile: string): string => `${device}-${profile}`;

/** A profile's stream node in `format`, `main.ts`. */
const streamNode = (profile: string, format: StreamFormat): string => `${profile}.${format}`;

/** A profile's picture node, `main.jpg`. */
const pictureNode = (profile: string): string => `${profile}.jpg`;

export const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Registers `kind`'s driver and keeps its cameras' streams with the restreamer; the answer stops it. */
export const startCameraDriver = (options: CameraOptions, kind: CameraKind): () => void => {
  const { cmd, devices, restreamer, fetcher, log } = options;
  /** When each camera was last asked for a frame. */
  const checked = new Map<string, number>();
  /** Cameras that did not answer last time, so it is said once. */
  const silent = new Set<string>();
  /** Cameras whose streams could not be kept last time, so it is said once. */
  const failing = new Set<string>();
  /** The address each source was given the restreamer with, so one that moved is given again. */
  const given = new Map<string, string>();
  /** Each stream node the driver writes, by its path. */
  const feeds = new Map<string, StreamFeed>();
  /** Stream nodes that could not be opened to write last time, so it is said once. */
  const unfed = new Set<string>();
  /** Each picture node the driver writes, by its path, with what stops it listening. */
  const painters = new Map<string, { writer: StreamWriter; unlisten: () => void }>();
  /** Picture nodes a picture is being made for now. */
  const painting = new Set<string>();
  /** Picture nodes whose picture could not be made last time, so it is said once. */
  const unpainted = new Set<string>();
  let busy = false;
  /** The formats its nodes are made in: without a restreamer nothing writes them, and the MP4 one, which a page would watch, is not offered. */
  const formats = restreamer ? STREAM_FORMATS : STREAM_FORMATS.filter((each) => each.format === 'ts');

  const cameras = async () =>
    (await cmd.sys.vfs.children<DeviceAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => []))
      .filter((child) => child.node.type === 'device' && child.node.attrs.driver === kind.name)
      .map((child) => ({ name: child.name, attrs: child.node.attrs }));

  const attrsOf = async (device: string): Promise<DeviceAttrs | undefined> =>
    (await cmd.sys.vfs.get(ADMIN_ACCESS, devicePath(device)).catch(() => undefined))?.attrs as DeviceAttrs | undefined;

  /**
   * The camera's endpoints, its streams given to the restreamer where it lacks them or has them at
   * another address, and each stream node fed.
   */
  const prepare = async (device: string, attrs: DeviceAttrs, have?: Set<string>): Promise<void> => {
    if (!attrs.class) await devices.ensureDevice(ADMIN_ACCESS, device, { class: 'camera' });
    // Without a restreamer a picture is the camera's still picture: a camera with none has no picture nodes.
    const pictured = restreamer !== undefined || (await kind.snapshot(device, attrs).catch(() => undefined)) !== undefined;
    for (const stream of await kind.streams(device, attrs)) {
      const paths = [];
      for (const { format, mimetype } of formats) {
        const path = await devices.ensureEndpoint(ADMIN_ACCESS, device, streamNode(stream.profile, format), 'stream', { label: stream.label, mimetype, ...stream.info });
        paths.push({ format, mimetype, path });
      }
      const mp4 = streamNode(stream.profile, 'mp4');
      if (!restreamer && await cmd.sys.vfs.get(ADMIN_ACCESS, `${devicePath(device)}/${mp4}`).then(() => true, () => false)) {
        await devices.removeEndpoint(ADMIN_ACCESS, device, mp4);
      }
      if (pictured) {
        const picture = await devices.ensureEndpoint(ADMIN_ACCESS, device, pictureNode(stream.profile), 'stream', {
          label: `${stream.label}, a picture`,
          mimetype: PICTURE_MIMETYPE,
        });
        await paintWhenAsked(device, stream.profile, picture);
      }
      const name = sourceName(device, stream.profile);
      if (!restreamer) continue;
      if (!have?.has(name) || given.get(name) !== stream.address) {
        await restreamer.put(name, stream.address);
        given.set(name, stream.address);
      }
      for (const { format, mimetype, path } of paths) await feed(device, stream.profile, format, mimetype, path);
    }
  };

  /**
   * The stream node at `path` written from the restreamer while it is read, the driver holding it
   * as its writer; a source the restreamer lost is given back when a reader comes for it.
   */
  const feed = async (device: string, profile: string, format: StreamFormat, mimetype: string, path: string): Promise<void> => {
    if (!restreamer || (feeds.has(path) && !feeds.get(path)!.closed)) return;
    try {
      const writer = await cmd.sys.vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
      if (!isStreamWriter(writer)) {
        await writer.close();
        throw new Error('not a stream');
      }
      feeds.set(
        path,
        new StreamFeed(path, writer, mimetype, async (signal) => {
          try {
            return await restreamer.stream(sourceName(device, profile), format, signal);
          } catch (error) {
            const attrs = await attrsOf(device);
            if (signal.aborted || !attrs || !await restate(device, attrs, profile)) throw error;
            return await restreamer.stream(sourceName(device, profile), format, signal);
          }
        }, log),
      );
      unfed.delete(path);
    } catch (error) {
      if (!unfed.has(path)) log(`${path}: not written: ${message(error)}`);
      unfed.add(path);
    }
  };

  /**
   * The picture node at `path` held as its writer, a picture made for it whenever a reader waits for
   * one, and none otherwise.
   */
  const paintWhenAsked = async (device: string, profile: string, path: string): Promise<void> => {
    if (painters.has(path) && !painters.get(path)!.writer.closed) return;
    try {
      const writer = await cmd.sys.vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
      if (!isStreamWriter(writer)) {
        await writer.close();
        throw new Error('not a stream');
      }
      const unlisten = writer.onWanted((wanted) => {
        if (wanted) void paint(device, profile, path, writer);
      });
      painters.set(path, { writer, unlisten });
      if (writer.wanted) void paint(device, profile, path, writer);
    } catch (error) {
      log(`${path}: not written: ${message(error)}`);
    }
  };

  /** Pictures written into `writer` for as long as a reader waits for one, tried again a while after one could not be made. */
  const paint = async (device: string, profile: string, path: string, writer: StreamWriter): Promise<void> => {
    if (painting.has(path)) return;
    painting.add(path);
    try {
      while (writer.wanted) {
        const attrs = await attrsOf(device);
        if (!attrs) return;
        try {
          await picture(device, attrs, profile, writer);
          unpainted.delete(path);
        } catch (error) {
          if (!unpainted.has(path)) log(`${path}: ${message(error)}`);
          unpainted.add(path);
          await new Promise((resolve) => setTimeout(resolve, PICTURE_RETRY_MS));
        }
      }
    } finally {
      painting.delete(path);
    }
  };

  /**
   * A picture of `profile` now, written into `writer`: the media service's first frame of its stream
   * node, or without a restreamer the camera's still picture. Its size is the stream's.
   */
  const picture = async (device: string, attrs: DeviceAttrs, profile: string, writer: StreamWriter): Promise<void> => {
    let bytes: Uint8Array;
    if (restreamer) {
      const file = await Deno.makeTempFile({ prefix: 'ein-camera-', suffix: '.jpg' });
      try {
        await streamPoster(cmd, `${devicePath(device)}/${streamNode(profile, 'ts')}`, [{ output: file, format: 'jpeg', quality: 85 }]);
        bytes = await Deno.readFile(file);
      } finally {
        await Deno.remove(file).catch(() => {});
      }
    } else {
      bytes = await snapshotOf(device, attrs);
    }
    if (bytes.length === 0) throw new Error('the picture came empty');
    if (writer.closed) return;
    await writer.write(bytes);
    const size = jpegSize(bytes);
    if (!size) return;
    for (const node of [...formats.map(({ format }) => streamNode(profile, format)), pictureNode(profile)]) {
      const known = (await cmd.sys.vfs.get(ADMIN_ACCESS, `${devicePath(device)}/${node}`).catch(() => undefined))?.attrs as EndpointAttrs | undefined;
      if (known && (known.width !== size.width || known.height !== size.height)) await devices.ensureEndpoint(ADMIN_ACCESS, device, node, 'stream', size);
    }
  };

  /** A picture of `profile` made now and written, when its picture node is held. */
  const paintNow = async (device: string, attrs: DeviceAttrs, profile: string): Promise<void> => {
    const held = painters.get(`${devicePath(device)}/${pictureNode(profile)}`);
    if (held && !held.writer.closed) await picture(device, attrs, profile, held.writer);
  };

  /** Stop writing the stream and picture nodes under `device`, or every one; their readers come to their end. */
  const unfeed = async (device?: string): Promise<void> => {
    const mine = (path: string) => device === undefined || path.startsWith(`${devicePath(device)}/`);
    for (const [path, each] of feeds) {
      if (!mine(path)) continue;
      feeds.delete(path);
      unfed.delete(path);
      await each.close().catch(() => {});
    }
    for (const [path, each] of painters) {
      if (!mine(path)) continue;
      painters.delete(path);
      unpainted.delete(path);
      each.unlisten();
      await each.writer.close().catch(() => {});
    }
  };

  /**
   * Whether the camera answers: the restreamer's probe of its smallest stream, which says each
   * stream's codec and sound, or without one its still picture. A stream whose size is not known
   * gets a picture made for it.
   */
  const check = async (device: string, attrs: DeviceAttrs): Promise<void> => {
    checked.set(device, Date.now());
    try {
      const streams = await kind.streams(device, attrs);
      const unsized: string[] = [];
      for (const stream of streams.toReversed()) {
        const path = `${devicePath(device)}/${streamNode(stream.profile, 'ts')}`;
        const known = (await cmd.sys.vfs.get(ADMIN_ACCESS, path).catch(() => undefined))?.attrs as EndpointAttrs | undefined;
        if (!known?.width) unsized.push(stream.profile);
        if (restreamer && (stream === streams.at(-1) || known?.audio === undefined)) {
          const info = await restreamer.probe(sourceName(device, stream.profile));
          for (const { format } of formats) await devices.ensureEndpoint(ADMIN_ACCESS, device, streamNode(stream.profile, format), 'stream', info);
        } else if (!restreamer && stream === streams.at(-1)) {
          await paintNow(device, attrs, stream.profile);
        }
      }
      await devices.online(ADMIN_ACCESS, device, true);
      silent.delete(device);
      // A picture that could not be made says nothing of whether the camera answers: the media service may be away.
      for (const profile of restreamer ? unsized : unsized.filter((profile) => profile !== streams.at(-1)?.profile)) {
        await paintNow(device, attrs, profile).catch((error) => log(`${device}/${pictureNode(profile)}: ${message(error)}`));
      }
    } catch (error) {
      if (!silent.has(device)) log(`${device}: ${message(error)}`);
      silent.add(device);
      await devices.online(ADMIN_ACCESS, device, false);
    }
  };

  /** The camera's streams given to the restreamer when it lacks `profile`'s; answers whether it did. */
  const restate = async (device: string, attrs: DeviceAttrs, profile: string): Promise<boolean> => {
    const have = await restreamer!.names();
    if (have.has(sourceName(device, profile))) return false;
    await prepare(device, attrs, have);
    return true;
  };

  /** The camera's still picture, asked of the camera itself. */
  const snapshotOf = async (device: string, attrs: DeviceAttrs): Promise<Uint8Array<ArrayBuffer>> => {
    const snapshot = await kind.snapshot(device, attrs);
    if (!snapshot) throw new Error(`${device} has no still picture to give without a restreamer (CFG_DEVICES_STREAMS_URL)`);
    const response = await fetcher(snapshot.url, {
      headers: snapshot.user || snapshot.password ? { authorization: `Basic ${btoa(`${snapshot.user ?? ''}:${snapshot.password ?? ''}`)}` } : {},
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`its still picture answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  /** Every camera's streams given to the restreamer where it lacks them, what else it has kept, and those due checked. */
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const have = restreamer ? await restreamer.names() : undefined;
      for (const camera of await cameras()) {
        try {
          await prepare(camera.name, camera.attrs, have);
          await kind.keep?.(camera.name, camera.attrs);
          failing.delete(camera.name);
        } catch (error) {
          if (!failing.has(camera.name)) log(`${camera.name}: ${message(error)}`);
          failing.add(camera.name);
        }
        if ((checked.get(camera.name) ?? 0) + 2 * CHECK_EVERY_MS <= Date.now()) await check(camera.name, camera.attrs);
      }
    } catch (error) {
      log(`cameras: ${message(error)}`);
    } finally {
      busy = false;
    }
  };

  const unregister = devices.registerDriver(kind.name, {
    description: kind.description,
    module: 'devices',
    config: kind.config,
    setup: async (device) => {
      const attrs = await attrsOf(device);
      if (!attrs) return;
      // A camera that does not answer yet is made all the same; the check says it is offline.
      await prepare(device, attrs).catch((error) => log(`${device}: ${message(error)}`));
      await kind.keep?.(device, attrs).catch((error) => log(`${device}: ${message(error)}`));
      await check(device, attrs);
    },
    forget: async (device) => {
      checked.delete(device);
      silent.delete(device);
      failing.delete(device);
      await unfeed(device);
      await kind.forget?.(device);
      if (!restreamer) return;
      for (const profile of STREAM_PROFILES) {
        given.delete(sourceName(device, profile));
        await restreamer.remove(sourceName(device, profile)).catch(() => {});
      }
    },
    ...(kind.write ? { write: kind.write } : {}),
  });

  const timer = setInterval(() => tick().catch(() => {}), CHECK_EVERY_MS);
  tick().catch(() => {});
  return () => {
    clearInterval(timer);
    unregister();
    void unfeed();
    kind.stop?.();
  };
};

/**
 * The `onvif` driver: a camera that speaks ONVIF, found on the network by WS-Discovery and added with
 * `automation-adopt <id> --user … --password …`, or made by hand (`device-create 'Front door'
 * --driver onvif --config address=192.0.2.10 --config user=admin --config password=…`). The password
 * is the device's secret.
 *
 * The camera says the rest itself: its largest profile is the `main` stream and its smallest the
 * `sub`, each with its codec, size and frame rate, given to the restreamer as `camera.ts` says. Its
 * profiles and their addresses are asked again every hour, and each minute while it is offline.
 *
 * Its events come by a PullPoint, asked for what it has, each request waiting up to ten seconds for
 * something to come, and renewed while it is asked. Each kind the camera lists becomes a log, on and
 * off: motion (`motion`), a person, a vehicle or an animal seen (`person`, `vehicle`, `animal`), the
 * camera covered, turned or its picture changed at once (`tamper`), a sound over its level (`sound`),
 * something inside a field drawn on its picture (`intrusion`) and its memory card failing
 * (`storage-failure`); and a line drawn on its picture crossed is a log of events (`line-crossing`),
 * one `crossed` each time. A PullPoint the camera dropped is made again, and the camera says each
 * state anew when it is.
 *
 * Where its main profile turns the camera, it has controls: `ptz-preset`, one of the camera's
 * presets, and a momentary control for each way it turns, `ptz-left`, `ptz-right`, `ptz-up`,
 * `ptz-down`, `ptz-zoom-in` and `ptz-zoom-out`, a press turning it a short step.
 *
 * A camera added from the network keeps the id it was found under (`config.found`), and is asked at
 * the address the network listener last heard it at.
 */

import type { DeviceAttrs, EndpointAttrs } from '@ein/api';
import { ADMIN_ACCESS } from '@ein/client';
import { type CameraKind, type CameraOptions, type CameraStream, message, withCredentials } from './camera.ts';
import { createOnvif, deviceServiceUrl, type Onvif, type OnvifMessage, type OnvifProfile, type OnvifSubscription } from './onvif.ts';

export const ONVIF_DRIVER = 'onvif';

/** How long a camera's profiles and addresses are kept before they are asked again. */
const PROFILES_TTL_MS = 3_600_000;
/** How long a PullPoint lives unless renewed, and how long each request for its events waits. */
const SUBSCRIPTION_S = 60;
const PULL_S = 10;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 300_000;
/** How long one press of a move turns the camera. */
const MOVE_MS = 400;
const MOVE_SPEED = 0.5;

/** The moves, by control: its label and its speed. */
const MOVES = {
  'ptz-left': { label: 'Turn left', speed: { pan: -MOVE_SPEED }, zoom: false },
  'ptz-right': { label: 'Turn right', speed: { pan: MOVE_SPEED }, zoom: false },
  'ptz-up': { label: 'Tilt up', speed: { tilt: MOVE_SPEED }, zoom: false },
  'ptz-down': { label: 'Tilt down', speed: { tilt: -MOVE_SPEED }, zoom: false },
  'ptz-zoom-in': { label: 'Zoom in', speed: { zoom: MOVE_SPEED }, zoom: true },
  'ptz-zoom-out': { label: 'Zoom out', speed: { zoom: -MOVE_SPEED }, zoom: true },
} as const;

const PRESET = 'ptz-preset';

/**
 * The kinds of event a camera says, each with the topics it is said under and its log. The first
 * that matches is the kind, so motion, the broadest, comes last.
 */
const EVENT_KINDS = [
  { kind: 'tamper', topic: /tamper|GlobalSceneChange/i, attrs: { label: 'Tampering', deviceClass: 'tamper' } },
  { kind: 'line-crossing', topic: /LineDetector|LineCross/i, attrs: { label: 'Line crossed', events: true } },
  { kind: 'intrusion', topic: /FieldDetector|intrusion/i, attrs: { label: 'Intrusion', deviceClass: 'occupancy' } },
  { kind: 'sound', topic: /sound|AudioAlarm|AudioSource\/TriggerLevel/i, attrs: { label: 'Sound', deviceClass: 'sound' } },
  { kind: 'storage-failure', topic: /StorageFailure/i, attrs: { label: 'Memory card failure', deviceClass: 'problem', category: 'diagnostic' } },
  { kind: 'person', topic: /people|person|human/i, attrs: { label: 'Person', deviceClass: 'occupancy' } },
  { kind: 'vehicle', topic: /vehicle/i, attrs: { label: 'Vehicle', deviceClass: 'occupancy' } },
  { kind: 'animal', topic: /animal|DogCat/i, attrs: { label: 'Animal', deviceClass: 'occupancy' } },
  { kind: 'motion', topic: /motion/i, attrs: { label: 'Motion', deviceClass: 'motion' } },
] as const satisfies readonly { kind: string; topic: RegExp; attrs: EndpointAttrs }[];

type EventKind = (typeof EVENT_KINDS)[number];

/** What a camera's event is about, by its topic; undefined for one EiN does not log. */
export const eventKind = (topic: string): EventKind | undefined => EVENT_KINDS.find((each) => each.topic.test(topic));

/** A message's state: the first of its data's items that says true or false. */
export const eventState = (message: OnvifMessage): boolean | undefined => {
  for (const value of Object.values(message.data)) {
    if (/^(true|1)$/i.test(value)) return true;
    if (/^(false|0)$/i.test(value)) return false;
  }
  return undefined;
};

/**
 * What a message appends to its kind's log: its state, or for a log of events `crossed`, unless an
 * item says false (a camera that also says when the crossing is over). An event's data is the
 * object's id, which may be 0 or 1, so it is not read as a state.
 */
export const eventValue = (kind: EventKind, message: OnvifMessage): boolean | string | undefined =>
  'events' in kind.attrs ? (Object.values(message.data).some((value) => /^false$/i.test(value)) ? undefined : 'crossed') : eventState(message);

type Camera = {
  /** What the client was made with, so a change makes a new one. */
  key: string;
  onvif: Onvif;
  user: string;
  password: string;
  streams?: { at: number; main: OnvifProfile; sub?: OnvifProfile; addresses: Map<string, string>; snapshot?: string };
  presets?: { at: number; list: { token: string; name: string }[] };
  /** Set while its events are followed; aborting it stops them. */
  events?: AbortController;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

export const onvifCamera = (options: CameraOptions): CameraKind => {
  const { devices, fetcher, network, log } = options;
  const cameras = new Map<string, Camera>();

  /** The camera's device service, at the address it was last heard at when it was found on the network. */
  const addressOf = (attrs: DeviceAttrs): string => {
    const config = attrs.config ?? {};
    if (!config.address) throw new Error('it has no address (config address)');
    const url = new URL(deviceServiceUrl(config.address));
    const heard = config.found ? network?.hosts.get(config.found) : undefined;
    if (heard?.ip) url.hostname = heard.ip;
    return url.toString();
  };

  const cameraOf = async (device: string, attrs: DeviceAttrs): Promise<Camera> => {
    const address = addressOf(attrs);
    const user = attrs.config?.user ?? '';
    const password = (await devices.secret(ADMIN_ACCESS, device)).password ?? '';
    const key = JSON.stringify([address, user, password]);
    const known = cameras.get(device);
    if (known?.key === key) return known;
    known?.events?.abort();
    const camera: Camera = { key, onvif: createOnvif(fetcher, address, user, password), user, password };
    cameras.set(device, camera);
    return camera;
  };

  /** The camera's main and smaller profile with their addresses, asked again when an hour old. */
  const streamsOf = async (camera: Camera): Promise<NonNullable<Camera['streams']>> => {
    if (camera.streams && Date.now() - camera.streams.at < PROFILES_TTL_MS) return camera.streams;
    const area = (profile: OnvifProfile) => (profile.width ?? 0) * (profile.height ?? 0);
    const profiles = (await camera.onvif.profiles()).toSorted((a, b) => area(b) - area(a));
    const main = profiles[0];
    if (!main) throw new Error('the camera has no profile that sends video');
    const smallest = profiles.at(-1)!;
    const sub = area(smallest) < area(main) ? smallest : undefined;
    const addresses = new Map<string, string>();
    for (const profile of sub ? [main, sub] : [main]) addresses.set(profile.token, await camera.onvif.streamUri(profile.token));
    const snapshot = await camera.onvif.snapshotUri(main.token).catch(() => undefined);
    camera.streams = { at: Date.now(), main, ...(sub ? { sub } : {}), addresses, ...(snapshot ? { snapshot } : {}) };
    return camera.streams;
  };

  /** What the camera says of its events, logged on its device as they come, until `signal` is aborted. */
  const follow = async (device: string, camera: Camera, signal: AbortSignal): Promise<void> => {
    let wait = RETRY_MIN_MS;
    let said = false;
    let topics: string[] | undefined;
    while (!signal.aborted) {
      let subscription: OnvifSubscription | undefined;
      try {
        topics ??= await camera.onvif.topics().catch(() => []);
        for (const each of new Set(topics.map(eventKind))) {
          if (each) await devices.ensureEndpoint(ADMIN_ACCESS, device, each.kind, 'log', each.attrs);
        }
        subscription = await camera.onvif.subscribe(SUBSCRIPTION_S);
        let renewed = Date.now();
        while (!signal.aborted) {
          const messages = await camera.onvif.pull(subscription, PULL_S, signal);
          wait = RETRY_MIN_MS;
          said = false;
          for (const each of messages) {
            const kind = eventKind(each.topic);
            const value = kind && eventValue(kind, each);
            if (!kind || value === undefined) continue;
            await devices.ensureEndpoint(ADMIN_ACCESS, device, kind.kind, 'log', kind.attrs);
            await devices.append(ADMIN_ACCESS, device, kind.kind, value);
          }
          if (Date.now() - renewed > (SUBSCRIPTION_S * 1000) / 2) {
            await camera.onvif.renew(subscription, SUBSCRIPTION_S);
            renewed = Date.now();
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        if (!said) log(`${device}: its events: ${message(error)}`);
        said = true;
        await sleep(wait, signal);
        wait = Math.min(wait * 2, RETRY_MAX_MS);
      } finally {
        if (subscription && signal.aborted) await camera.onvif.unsubscribe(subscription).catch(() => {});
      }
    }
  };

  /** The controls of a camera whose main profile turns it. */
  const keepPtz = async (device: string, camera: Camera, main: OnvifProfile): Promise<void> => {
    if (!main.ptz || !(await camera.onvif.services()).ptz) return;
    if (!camera.presets || Date.now() - camera.presets.at > PROFILES_TTL_MS) {
      camera.presets = { at: Date.now(), list: await camera.onvif.presets(main.token).catch(() => []) };
    }
    const names = [...new Set(camera.presets.list.map((preset) => preset.name))];
    if (names.length) await devices.ensureEndpoint(ADMIN_ACCESS, device, PRESET, 'control', { label: 'Preset', schema: { type: 'enum', options: names } });
    for (const [endpoint, move] of Object.entries(MOVES)) {
      if (move.zoom ? !main.ptz.zoom : !main.ptz.panTilt) continue;
      await devices.ensureEndpoint(ADMIN_ACCESS, device, endpoint, 'control', { label: move.label, schema: { type: 'momentary' } });
    }
  };

  return {
    name: ONVIF_DRIVER,
    description:
      'A camera that speaks ONVIF: its streams, its events (motion, people seen, tampering, sound, a line crossed and the like), and its presets and moves where it turns',
    config: [
      { name: 'address', label: 'Address, camera or http://camera/onvif/device_service', type: 'string', required: true },
      { name: 'user', label: 'User', type: 'string' },
      { name: 'password', label: 'Password', type: 'string', secret: true },
    ],

    streams: async (device, attrs) => {
      const camera = await cameraOf(device, attrs);
      // A camera that stopped answering may have moved its streams: asked again, at most each minute.
      if (attrs.online === false && camera.streams && Date.now() - camera.streams.at > 60_000) camera.streams = undefined;
      const streams = await streamsOf(camera);
      const out: CameraStream[] = [];
      for (const [endpoint, profile] of [['main', streams.main], ['sub', streams.sub]] as const) {
        if (!profile) continue;
        out.push({
          endpoint,
          label: endpoint === 'main' ? 'Main stream' : 'Smaller stream',
          address: withCredentials(streams.addresses.get(profile.token)!, camera.user, camera.password),
          info: {
            ...(profile.codec ? { codec: profile.codec } : {}),
            ...(profile.width ? { width: profile.width } : {}),
            ...(profile.height ? { height: profile.height } : {}),
            ...(profile.fps ? { fps: profile.fps } : {}),
          },
        });
      }
      return out;
    },

    snapshot: async (device, attrs) => {
      const camera = await cameraOf(device, attrs);
      const url = (await streamsOf(camera)).snapshot;
      return url ? { url, user: camera.user, password: camera.password } : undefined;
    },

    keep: async (device, attrs) => {
      const camera = await cameraOf(device, attrs);
      if (!camera.events && (await camera.onvif.services()).events) {
        const events = camera.events = new AbortController();
        follow(device, camera, events.signal).catch((error) => log(`${device}: its events: ${message(error)}`));
      }
      await keepPtz(device, camera, (await streamsOf(camera)).main);
    },

    write: async ({ device, endpoint, attrs, value, by }) => {
      const camera = await cameraOf(device, attrs);
      const { main } = await streamsOf(camera);
      if (endpoint === PRESET) {
        const preset = camera.presets?.list.find((each) => each.name === value);
        if (!preset) throw new Error(`the camera has no preset ${value}`);
        await camera.onvif.gotoPreset(main.token, preset.token);
        await devices.append(ADMIN_ACCESS, device, endpoint, String(value));
        log(`${device} turned to ${value} by ${by}`);
        return;
      }
      const move = MOVES[endpoint as keyof typeof MOVES];
      if (!move) throw new Error(`${device} has no control ${endpoint}`);
      await camera.onvif.move(main.token, move.speed);
      await new Promise((resolve) => setTimeout(resolve, MOVE_MS));
      await camera.onvif.stop(main.token);
    },

    forget: async (device) => {
      cameras.get(device)?.events?.abort();
      cameras.delete(device);
    },

    stop: () => {
      for (const camera of cameras.values()) camera.events?.abort();
      cameras.clear();
    },
  };
};

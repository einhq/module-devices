import { Box, Button, Stack, Text, Title } from '@mantine/core';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DISPLAY_TYPES, type DisplayItem, type DisplayMessage, type DisplayReply, type DisplayReport } from '@devices/api';
import { mediaSourceClass, playLive, readLive } from '../media/live-mp4.ts';

/** Open to anyone, outside the frame: the browser acts with the device key in its address, not as whoever is signed in. */
export const handle = { open: true, title: 'Display' };

/** Where the display keeps its device and key, so it stays the display when the page is opened again. */
const STORE_KEY = 'ein.devices.display';

type Held = { device: string; key: string };

const readHeld = (): Held | null => {
  try {
    const held = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Held | null;
    return held?.device && held.key ? held : null;
  } catch {
    return null;
  }
};

const keep = (held: Held | null) => {
  try {
    if (held) localStorage.setItem(STORE_KEY, JSON.stringify(held));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* a browser that keeps nothing asks for the address each time */ }
};

let plays: string[] | undefined;

/** The types of `DISPLAY_TYPES` this browser plays: pictures it draws, and what its player says it can play. */
const playable = (): string[] => {
  if (plays) return plays;
  const probe = document.createElement('video');
  return plays = DISPLAY_TYPES.filter((type) => type.startsWith('image/') || probe.canPlayType(type) !== '');
};

/** Whether `item` is read into a MediaSource rather than by the element: a page streamed as MP4, where the browser has one. */
const readsLive = (item: DisplayItem): boolean => item.live === true && item.contentType === 'video/mp4' && mediaSourceClass() !== undefined;

/** How long a refused or failed report waits before the next, growing to the last. */
const RETRY_MS = [1000, 2000, 5000, 10_000];
/** The pointer is hidden, and the sign-out button, after this long without it moving. */
const IDLE_MS = 3000;

type Shown = { items: DisplayItem[]; index: number; seconds: number };

/** The device the display is, or why it is none. */
type Link = { state: 'none' } | { state: 'refused' } | { state: 'connecting' } | { state: 'connected'; label: string };

/**
 * `/display`: a browser as a screen EiN shows on (the `browser` driver). Opened from the address a
 * browser display is given (`/display?device=<name>&key=<key>`), it keeps the device and its key in
 * the browser and takes them out of the address bar. It reports what it plays to its device and is
 * answered what to play, a report held until there is something (`DisplayReport`, `DisplayReply`),
 * and plays it full screen: a picture drawn, a recording or video played, a page streamed as video
 * read into a MediaSource and held at its newest frame, one after the other, the last picture kept
 * until it is stopped. With nothing to play it waits, saying which screen it is.
 *
 * A browser goes full screen and plays sound only after a tap, so the first tap anywhere does both;
 * until then a video plays muted. Sign out lets the device go and forgets the key here. It draws no
 * icons: the shell fetches them over its socket, which a browser that has not signed in may not use.
 */
export default function DisplayPage() {
  const [params, setParams] = useSearchParams();
  const [held, setHeld] = useState<Held | null>(() => {
    const device = params.get('device');
    const key = params.get('key');
    return device && key ? { device, key } : readHeld();
  });
  const [link, setLink] = useState<Link>({ state: held ? 'connecting' : 'none' });
  const [shown, setShown] = useState<Shown | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);
  const [tapped, setTapped] = useState(false);
  const [mutedForAutoplay, setMutedForAutoplay] = useState(false);
  const [idle, setIdle] = useState(false);
  const media = useRef<HTMLVideoElement>(null);
  /** What the next report says: the last message taken, the driver's epoch, and what plays. */
  const seen = useRef({ id: 0, epoch: undefined as string | undefined });
  const shownRef = useRef<Shown | null>(null);
  /** The report held open now, ended at a sign-out before the device is let go, so it is not asked for again. */
  const loop = useRef<AbortController | null>(null);
  const failedRef = useRef<string | null>(null);
  shownRef.current = shown;
  failedRef.current = failed;

  // The key leaves the address bar once it is kept.
  useEffect(() => {
    if (!params.has('key')) return;
    keep(held);
    setParams({}, { replace: true });
  }, []);

  const current = (): DisplayItem | undefined => {
    const now = shownRef.current;
    return now ? now.items[now.index] : undefined;
  };

  const report = useCallback((wait: boolean, bye = false): DisplayReport => {
    const item = current();
    const element = media.current;
    const picture = item?.contentType.startsWith('image/');
    const player: DisplayReport['player'] = !item
      ? 'idle'
      : failedRef.current
      ? 'idle'
      : picture
      ? 'playing'
      : !element || element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
      ? (element?.paused ? 'paused' : 'buffering')
      : element.paused
      ? 'paused'
      : 'playing';
    const playing = item && !picture && element;
    return {
      seen: seen.current.id,
      ...(seen.current.epoch ? { epoch: seen.current.epoch } : {}),
      ...(wait ? { wait } : {}),
      ...(bye ? { bye } : {}),
      plays: playable(),
      player,
      ...(item ? { url: item.url, title: item.title } : {}),
      ...(playing ? { seconds: element.currentTime } : {}),
      ...(playing && Number.isFinite(element.duration) ? { duration: element.duration } : {}),
      ...(element ? { volume: element.volume, muted: element.muted } : {}),
      ...(item && failedRef.current ? { failed: true } : {}),
    };
  }, []);

  const post = useCallback(async (body: DisplayReport, signal?: AbortSignal): Promise<DisplayReply | 'refused'> => {
    if (!held) throw new Error('no device');
    const response = await fetch(`/file/dev/${encodeURIComponent(held.device)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${held.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 403 || response.status === 404) return 'refused';
    if (!response.ok) throw new Error(await response.text() || response.statusText);
    return ((await response.json()) as { reply: DisplayReply }).reply;
  }, [held]);

  /** Play the item `index` of `items` from `seconds`, or wait when there is none. */
  const show = (items: DisplayItem[], index: number, seconds: number) => {
    setFailed(null);
    setShown(index < items.length ? { items, index, seconds } : null);
  };

  const take = (message: DisplayMessage) => {
    const element = media.current;
    const now = shownRef.current;
    switch (message.type) {
      case 'load':
        return show(message.items, message.start, message.seconds);
      case 'stop':
        return show([], 0, 0);
      case 'next':
        return now && show(now.items, now.index + 1, 0);
      case 'play':
        return void element?.play().catch(() => {});
      case 'pause':
        return element?.pause();
      case 'seek':
        if (element && !current()?.live) element.currentTime = message.seconds;
        return;
      case 'volume':
        if (element) element.volume = Math.min(1, Math.max(0, message.level));
        return;
      case 'mute':
        if (element) element.muted = message.muted;
        return;
    }
  };

  /** The messages of a reply that were not taken before, in order; a new epoch counts from the first. */
  const answered = (reply: DisplayReply) => {
    // Signed out since it was asked.
    if (!loop.current || loop.current.signal.aborted) return;
    if (reply.epoch !== seen.current.epoch) seen.current = { id: 0, epoch: reply.epoch };
    for (const message of reply.messages) {
      if (message.id <= seen.current.id) continue;
      seen.current.id = message.id;
      take(message);
    }
    setLink({ state: 'connected', label: reply.label });
  };

  // The report held open: asked again as soon as it is answered, for as long as the page is open.
  useEffect(() => {
    if (!held) return;
    const stop = new AbortController();
    loop.current = stop;
    let tries = 0;
    void (async () => {
      while (!stop.signal.aborted) {
        try {
          const reply = await post(report(true), stop.signal);
          if (reply === 'refused') {
            setShown(null);
            setLink({ state: 'refused' });
            return;
          }
          tries = 0;
          answered(reply);
        } catch {
          if (stop.signal.aborted) return;
          setLink((was) => was.state === 'connected' ? { state: 'connecting' } : was);
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]));
        }
      }
    })();
    return () => stop.abort();
  }, [held, post]);

  /** Say at once what changed: a play, a pause, an end, a failure. */
  const tell = useCallback(() => {
    if (!held) return;
    void post(report(false)).then((reply) => reply !== 'refused' && answered(reply), () => {});
  }, [held, post]);

  useEffect(() => {
    tell();
  }, [shown, failed]);

  // A recording or video plays as soon as it is given, muted when the browser will not let it play
  // sound before a tap, from where the player said.
  useEffect(() => {
    const element = media.current;
    const item = current();
    if (!element || !item || item.contentType.startsWith('image/')) return;
    const start = shown?.seconds ?? 0;
    const begin = () => {
      if (start > 0 && !item.live) element.currentTime = start;
      element.play().catch((error) => {
        if (!(error instanceof DOMException) || error.name !== 'NotAllowedError') return;
        element.muted = true;
        setMutedForAutoplay(true);
        void element.play().catch(() => {});
      });
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) begin();
    else element.addEventListener('loadedmetadata', begin, { once: true });
    return () => element.removeEventListener('loadedmetadata', begin);
  }, [shown]);

  // A page streamed as video is read as it comes, held at its newest frame, until it ends.
  useEffect(() => {
    const element = media.current;
    const item = current();
    const Source = mediaSourceClass();
    if (!element || !item || !readsLive(item) || !Source) return;
    const stop = new AbortController();
    void (async () => {
      try {
        while (true) {
          const response = await fetch(item.url, { signal: stop.signal, cache: 'no-store' });
          if (!response.ok || !response.body) throw new Error(`the stream answered ${response.status}`);
          const reading = await readLive(response.body.getReader());
          const { type } = reading;
          if (!type || !Source.isTypeSupported(type)) {
            await reading.reader.cancel();
            throw new Error(`this browser does not play ${type ?? 'its codecs'}`);
          }
          if (await playLive(element, { ...reading, type }, Source, stop.signal) === 'ended') break;
        }
        const now = shownRef.current;
        if (!stop.signal.aborted && now) show(now.items, now.index + 1, 0);
      } catch {
        if (!stop.signal.aborted) setFailed(item.url);
      }
    })();
    return () => stop.abort();
  }, [shown]);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  // The screen stays on while the page is shown.
  useEffect(() => {
    if (!held || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    const ask = () => {
      if (document.visibilityState === 'visible') navigator.wakeLock.request('screen').then((got) => lock = got, () => {});
    };
    ask();
    document.addEventListener('visibilitychange', ask);
    return () => {
      document.removeEventListener('visibilitychange', ask);
      void lock?.release().catch(() => {});
    };
  }, [held]);

  // The pointer, and the sign-out button with it, go once it rests.
  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), IDLE_MS);
    const moved = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    document.addEventListener('pointermove', moved);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointermove', moved);
    };
  }, []);

  /** The first tap: full screen, and sound for a video playing muted until it. */
  const tap = () => {
    setTapped(true);
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
    const element = media.current;
    if (element && mutedForAutoplay) {
      element.muted = false;
      setMutedForAutoplay(false);
      tell();
    }
  };

  const signOut = async () => {
    loop.current?.abort();
    const bye = report(false, true);
    keep(null);
    setHeld(null);
    setShown(null);
    setLink({ state: 'none' });
    await post(bye).catch(() => {});
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };

  const item = current();
  const picture = item?.contentType.startsWith('image/');
  const audio = item?.contentType.startsWith('audio/');
  const fill: CSSProperties = { position: 'fixed', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: 'black' };

  return (
    <Box onPointerDown={tap} style={{ position: 'fixed', inset: 0, background: 'black', color: 'white', cursor: idle ? 'none' : undefined, overflow: 'hidden' }}>
      {item && picture && <img key={item.url} src={item.url} alt={item.title} style={fill} onError={() => setFailed(item.url)} />}
      {item && !picture && (
        <video
          key={item.url}
          ref={media}
          src={readsLive(item) ? undefined : item.url}
          style={fill}
          playsInline
          preload='auto'
          onPlay={tell}
          onPause={tell}
          onPlaying={tell}
          onSeeked={tell}
          onEnded={() => shown && show(shown.items, shown.index + 1, 0)}
          onError={() => setFailed(item.url)}
        />
      )}
      {item && audio && (
        <Stack align='center' justify='center' gap='md' style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
          <Title order={1} c='white' ta='center' px='xl'>{item.title}</Title>
        </Stack>
      )}
      {(!item || failed) && (
        <Stack align='center' justify='center' gap='lg' p='xl' style={{ position: 'fixed', inset: 0, textAlign: 'center' }}>
          {link.state === 'none' && (
            <>
              <Title order={2} c='white'>Not a display yet</Title>
              <Text c='gray.5' maw={560}>
                Open the address EiN gives when you make a browser display, under Devices → Browser display, to show things on this screen.
              </Text>
            </>
          )}
          {link.state === 'refused' && (
            <>
              <Title order={2} c='white'>This display's key no longer works</Title>
              <Text c='gray.5' maw={560}>The device was forgotten, or given a new key. Open its new display address.</Text>
            </>
          )}
          {link.state === 'connecting' && <Title order={2} c='white'>Reaching EiN…</Title>}
          {link.state === 'connected' && (
            <>
              <Title order={1} c='white'>{link.label}</Title>
              <Text size='xl' c='gray.4'>{failed ? 'It could not show what it was given.' : 'Waiting for something to show'}</Text>
              <Text c='gray.6' maw={560}>Choose Show on, then {link.label}, in EiN on another device.</Text>
            </>
          )}
          {held && !fullscreen && !tapped && <Text c='gray.5' mt='md'>Tap anywhere to go full screen.</Text>}
        </Stack>
      )}
      {item && mutedForAutoplay && (
        <Box style={{ position: 'fixed', bottom: 24, left: 24, padding: '8px 12px', borderRadius: 8, background: 'rgba(0, 0, 0, 0.6)' }}>
          <Text size='sm' c='white'>Tap for sound</Text>
        </Box>
      )}
      {held && (
        <Button
          variant='subtle'
          color='gray'
          size='xs'
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void signOut()}
          style={{ position: 'fixed', bottom: 16, right: 16, opacity: idle ? 0 : 0.8, transition: 'opacity 300ms' }}
        >
          Sign out
        </Button>
      )}
    </Box>
  );
}

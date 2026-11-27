import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import { type CSSProperties, useEffect, useRef } from 'react';
import { type LiveReading, mediaSourceClass, playLive, readLive } from '../media/live-mp4.ts';

/** How long a transcode made for this page runs on once nobody reads it, in seconds. */
const TRANSCODE_IDLE_S = 15;

export type LiveStatus = { state: 'connecting' | 'playing' | 'ended' | 'failed'; reason?: string };

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A stream node's bytes as they come, over `GET /file/…`; throws with what EiN answered when it cannot be read. */
const openStream = async (path: string, signal: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
  const response = await fetch(`/file${path.split('/').map(encodeURIComponent).join('/')}`, { signal, cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error((await response.text().catch(() => '')).trim() || `the stream answered ${response.status}`);
  return response.body.getReader();
};

/**
 * A stream played as it comes: the stream node `/dev/<device>/<stream>`, fragmented MP4, read over
 * `GET /file/…` into a MediaSource, its header first. When the browser does not play its codecs (a
 * camera's HEVC in most browsers), the media service transcodes it into a node made for this page
 * (`stream-transcode`), which is read instead and stopped when the page lets go. It keeps a few
 * seconds and stays at the newest frame; a new header, as when the camera's stream started anew,
 * starts the picture over.
 */
export function LivePlayer({ device, stream, onStatus, controls, style }: {
  device: string;
  stream: string;
  onStatus: (status: LiveStatus) => void;
  /** The browser's own play and full-screen buttons. */
  controls?: boolean;
  style?: CSSProperties;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    const Source = mediaSourceClass();
    if (!element) return;
    if (!Source) {
      onStatus({ state: 'failed', reason: 'this browser cannot play a live stream (no Media Source Extensions)' });
      return;
    }
    const stop = new AbortController();
    /** What is read: the stream, or the transcode of it made for this page. */
    let path = `/dev/${device}/${stream}`;
    let transcode: string | undefined;
    element.disableRemotePlayback = true;

    /** What is read, up to its header, the stream moved to its transcode when the browser does not play its own codecs. */
    const open = async (): Promise<LiveReading & { type: string }> => {
      const reading = await readLive(await openStream(path, stop.signal));
      const { type } = reading;
      if (type && Source.isTypeSupported(type)) return { ...reading, type };
      await reading.reader.cancel();
      if (transcode) throw new Error(`this browser does not play the transcoded stream (${type ?? 'an unknown codec'})`);
      onStatus({ state: 'connecting', reason: 'Transcoding for this browser…' });
      try {
        const started = await execCommand<{ id: string; output: string }>(
          `stream-transcode start ${shq(path)} --idle=${TRANSCODE_IDLE_S}`,
          { signal: stop.signal },
        );
        transcode = started.id;
        path = started.output;
        return await open();
      } catch (error) {
        if (stop.signal.aborted) throw error;
        throw new Error(`this browser does not play the camera's video (${type ?? 'an unknown codec'}), and it could not be transcoded: ${message(error)}`);
      }
    };

    /** Play from one reading of the stream until it ends or sends a new header: whether it did. */
    const play = async (): Promise<'ended' | 'header'> =>
      await playLive(element, await open(), Source, stop.signal, () => {
        element.play().then(() => onStatus({ state: 'playing' })).catch(() => onStatus({ state: 'playing', reason: 'press play' }));
      });

    void (async () => {
      onStatus({ state: 'connecting' });
      try {
        while (await play() === 'header') {
          if (stop.signal.aborted) return;
        }
        if (!stop.signal.aborted) onStatus({ state: 'ended' });
      } catch (error) {
        if (!stop.signal.aborted) onStatus({ state: 'failed', reason: message(error) });
      }
    })();

    return () => {
      stop.abort();
      if (transcode) void execCommand(`stream-transcode stop ${shq(transcode)}`).catch(() => {});
      element.removeAttribute('src');
      element.load();
    };
  }, [device, stream, onStatus]);
  return <video ref={video} muted playsInline controls={controls} style={{ background: 'black', ...style }} />;
}

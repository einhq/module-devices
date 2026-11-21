import { Skeleton, Stack, Text, UnstyledButton } from '@mantine/core';
import type { DeviceInfo, DeviceValue, EndpointSummary } from '@ein/api';
import { TablerIcon } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { agoText, readingText, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { type ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** How long a press must be followed by another before a button that asks first forgets it. */
const ARMED_MS = 4_000;

/** How long a pressed momentary button stays lit. */
const PRESSED_MS = 1_500;

/** What pressing the button does to its control. */
type Action =
  /** A momentary control: a press. */
  | { kind: 'press' }
  /** On and off: the other of what it is. */
  | { kind: 'toggle' }
  /** Any other: this value, which it is lit at. */
  | { kind: 'set'; value: string };

/** What pressing does to `endpoint`, or why the button cannot press it. */
const actionOf = (endpoint: EndpointSummary, value: string): Action | string => {
  if (endpoint.type !== 'control') return `${endpoint.label} is a reading, not something to press or switch`;
  const type = endpoint.schema?.type ?? 'text';
  if (type === 'momentary') return { kind: 'press' };
  if (value !== '') return { kind: 'set', value };
  if (type === 'bool') return { kind: 'toggle' };
  return `Set what the button sets ${endpoint.label} to in the card's settings`;
};

/** Whether what a control is now is the value a button sets it to, read as the device says it. */
const isValue = (now: DeviceValue | undefined, value: string): boolean => {
  if (now === undefined || now === null) return false;
  if (typeof now === 'boolean') return now === ['on', 'true', '1'].includes(value.toLowerCase());
  if (typeof now === 'number') return value.trim() !== '' && Number(value) === now;
  return String(now) === value;
};

/** The control's value as the button shows it: what was asked while the device has not said it yet. */
const shownValue = (endpoint: EndpointSummary): DeviceValue | undefined => {
  const { requested, last } = endpoint;
  if (requested && (!last || Date.parse(last.at) < Date.parse(requested.at))) return requested.value;
  return last?.value;
};

/** What a tile says in place of its button, in the middle. */
function Quiet({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <Stack h='100%' align='center' justify='center' gap={6} p='sm' ta='center'>
      <TablerIcon name={icon} size={26} stroke={1.5} />
      <Text size='sm' c='dimmed' maw={260}>{children}</Text>
    </Stack>
  );
}

/**
 * The button's look: the card is the button, a round knob in the middle of it carries the state,
 * and its label and state stand under it, or beside it in a wide and short card. The knob is a dark
 * disc ringed in the card's colour (`--dash-accent`, the app's accent outside a dashboard); lit, that
 * colour in a gradient with a glow; asking for a second press, ringed in yellow and pulsing; waiting
 * for the device, pulsing slowly. The card is a size container, so the knob and the words scale
 * with the room it has, and the state goes where there is none for it.
 */
const STYLE = `
.devices-button-card {
  --button-accent: var(--dash-accent, var(--mantine-primary-color-filled));
  container-type: size;
  width: 100%;
  height: 100%;
  color: var(--mantine-color-text);
}
.devices-button-face {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6em;
  height: 100%;
  font-size: clamp(0.8rem, 7cqmin, 1.6rem);
  text-align: center;
}
.devices-button-knob {
  flex: none;
  display: grid;
  place-items: center;
  width: clamp(30px, 56cqmin, 176px);
  aspect-ratio: 1;
  border-radius: 50%;
  color: color-mix(in srgb, var(--button-accent) 65%, white);
  background: color-mix(in srgb, var(--button-accent) 14%, rgba(7, 10, 16, 0.55));
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--button-accent) 50%, transparent);
  transition: background 200ms, box-shadow 200ms, color 200ms, transform 80ms, filter 160ms;
}
.devices-button-words {
  display: grid;
  gap: 0.15em;
  min-width: 0;
}
.devices-button-state {
  color: var(--mantine-color-dimmed);
  font-size: 0.72em;
}
.devices-button-card[data-lit] .devices-button-knob {
  color: color-mix(in srgb, var(--button-accent) 22%, black);
  background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--button-accent) 40%, white), var(--button-accent) 70%);
  box-shadow: 0 0 0 0.3em color-mix(in srgb, var(--button-accent) 18%, transparent), 0 0 1.8em color-mix(in srgb, var(--button-accent) 45%, transparent);
}
.devices-button-card[data-lit] .devices-button-state {
  color: color-mix(in srgb, var(--button-accent) 70%, white);
}
.devices-button-card[data-armed] .devices-button-knob {
  box-shadow: inset 0 0 0 2px var(--mantine-color-yellow-5), 0 0 0 0.3em color-mix(in srgb, var(--mantine-color-yellow-5) 22%, transparent);
  animation: devices-button-pulse 0.8s ease-in-out infinite alternate;
}
.devices-button-card[data-armed] .devices-button-state {
  color: var(--mantine-color-yellow-4);
}
.devices-button-card[data-pending] .devices-button-knob {
  animation: devices-button-pulse 1.2s ease-in-out infinite alternate;
}
.devices-button-card:not(:disabled):hover .devices-button-knob {
  filter: brightness(1.15);
}
.devices-button-card:not(:disabled):active .devices-button-knob {
  transform: scale(0.95);
}
.devices-button-card:disabled:not([data-pending]) {
  opacity: 0.75;
}
@container (min-aspect-ratio: 11 / 5) {
  .devices-button-face {
    flex-direction: row;
    gap: 0.9em;
    text-align: start;
  }
  .devices-button-knob {
    width: clamp(30px, 78cqh, 176px);
  }
}
@container (max-height: 120px) and (max-aspect-ratio: 11 / 5) {
  .devices-button-state {
    display: none;
  }
}
@keyframes devices-button-pulse {
  to {
    opacity: 0.6;
  }
}
@media (prefers-reduced-motion: reduce) {
  .devices-button-knob {
    animation: none !important;
    transition: none;
  }
}
`;

/**
 * `/cards/devices/button`: one large button for a device's control (`device`, `endpoint`), lit
 * while the control is what it sets. A momentary control is pressed; on and off is switched to the
 * other, or to `value` when one is given; any other control is set to `value`, as for a scene or a
 * mode. With `confirm` the first press only asks for a second. A button whose control its viewer may
 * not write, as on a screen that only shows, shows the state and does nothing.
 */
export default function ButtonCard() {
  const [params] = useSearchParams();
  const device = params.get('device') ?? '';
  const name = params.get('endpoint') ?? '';
  const value = params.get('value') ?? '';
  const confirm = params.get('confirm') === 'true';
  const info = usePolledCommand<DeviceInfo>(`device-show ${shq(device)}`, device !== '');
  const [busy, setBusy] = useState(false);
  const [armedAt, setArmedAt] = useState<number>();
  const [pressedAt, setPressedAt] = useState<number>();

  useEffect(() => {
    if (armedAt === undefined) return;
    const timer = setTimeout(() => setArmedAt(undefined), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);
  useEffect(() => {
    if (pressedAt === undefined) return;
    const timer = setTimeout(() => setPressedAt(undefined), PRESSED_MS);
    return () => clearTimeout(timer);
  }, [pressedAt]);

  if (!info.data) return info.error ? <Quiet icon='plug-x'>{info.error.message}</Quiet> : <Skeleton h='100%' radius='md' />;
  const endpoint = info.data.endpointList.find((each) => each.name === name);
  if (!endpoint) return <Quiet icon='plug-x'>{info.data.label} has no {name || 'control chosen'}.</Quiet>;
  const action = actionOf(endpoint, value);
  if (typeof action === 'string') return <Quiet icon='adjustments'>{action}</Quiet>;

  const now = shownValue(endpoint);
  const pending = action.kind !== 'press' && now !== endpoint.last?.value;
  const lit = action.kind === 'press' ? pressedAt !== undefined : action.kind === 'toggle' ? now === true : isValue(now, action.value);
  const label = params.get('label') || endpoint.label;
  const icon = params.get('icon') || (action.kind === 'press' ? 'hand-finger' : action.kind === 'toggle' ? 'power' : 'player-play');
  const disabled = !endpoint.writable || busy;

  const write = async () => {
    const written = action.kind === 'press' ? 'press' : action.kind === 'toggle' ? (now === true ? 'off' : 'on') : action.value;
    setBusy(true);
    try {
      await execCommand(`echo ${shq(written)} > ${shq(endpoint.path)}`);
      if (action.kind === 'press') setPressedAt(Date.now());
      await info.refetch();
    } catch (error) {
      notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });
    } finally {
      setBusy(false);
    }
  };
  const press = () => {
    if (confirm && armedAt === undefined) return setArmedAt(Date.now());
    setArmedAt(undefined);
    void write();
  };

  const state = armedAt !== undefined
    ? 'Press again'
    : pending
    ? 'Waiting for the device…'
    : action.kind === 'press'
    ? endpoint.requested ? `Pressed ${agoText(endpoint.requested.at)}` : 'Not pressed yet'
    : action.kind === 'toggle'
    ? now === true ? 'On' : now === false ? 'Off' : 'Not known'
    : now === undefined
    ? 'Not known'
    : readingText(now, endpoint.unit);

  return (
    <UnstyledButton
      onClick={press}
      disabled={disabled}
      aria-pressed={action.kind === 'press' ? undefined : lit}
      title={endpoint.writable ? undefined : 'You may not use this button'}
      className='devices-button-card'
      data-lit={lit || undefined}
      data-armed={armedAt !== undefined || undefined}
      data-pending={pending || busy || undefined}
      style={{
        // On a dashboard of hat pieces the button fills the piece and what it says keeps clear of the edge.
        padding: 'var(--dash-inset-top, 0.6em) var(--dash-inset-right, 0.6em) var(--dash-inset-bottom, 0.6em) var(--dash-inset-left, 0.6em)',
        cursor: endpoint.writable ? 'pointer' : 'default',
      }}
    >
      <span className='devices-button-face'>
        <span className='devices-button-knob'>
          <TablerIcon name={icon} size='46%' stroke={1.8} />
        </span>
        <span className='devices-button-words'>
          <Text className='devices-button-label' inherit fw={650} lineClamp={2}>{label}</Text>
          <Text className='devices-button-state' inherit>{state}</Text>
        </span>
      </span>
      <style>{STYLE}</style>
    </UnstyledButton>
  );
}

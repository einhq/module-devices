import { TablerIcon } from '@ein/ui/components';
import { copyText, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { ActionIcon, Button, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import type { DeviceKeyAnswer } from '@ein/api';
import { useCallback, useEffect, useRef, useState } from 'react';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The display page's address for `device`, from its key's answer: the key is what lets the browser act as the device. */
const displayAddress = (device: string, answer: DeviceKeyAnswer): string | undefined => {
  const key = answer.url ? new URL(answer.url, globalThis.location.origin).searchParams.get('key') : null;
  if (!key) return undefined;
  return `${globalThis.location.origin}/display?${new URLSearchParams({ device, key })}`;
};

/**
 * The address a browser opens to be the display `device`: made from its key (`device-key`), with
 * copy, Open here, and a new address in its place (after a confirm, since a browser showing the old
 * one stops). Only whoever may change the device sees it; anyone else is shown why not. A display
 * just made (`fresh`) is given its address at once.
 */
export function DisplayAddress({ device, fresh = false }: { device: string; fresh?: boolean }) {
  const [answer, setAnswer] = useState<DeviceKeyAnswer>();
  const [refused, setRefused] = useState<string>();
  const [pending, setPending] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const run = useCallback(async (renew: boolean) => {
    const next = await execCommand<DeviceKeyAnswer>(`device-key ${shq(device)} --origin ${shq(globalThis.location.origin)}${renew ? ' --new' : ''}`);
    setAnswer(next);
  }, [device]);

  useEffect(() => {
    run(fresh).catch((error) => setRefused(messageOf(error)));
  }, [run]);

  const renew = async () => {
    setPending(true);
    try {
      await run(true);
      setConfirmNew(false);
    } catch (error) {
      notify({ message: messageOf(error), color: 'red' });
    } finally {
      setPending(false);
    }
  };

  if (refused) return <Text size='sm' c='dimmed'>{refused}</Text>;
  if (!answer) return null;
  const address = displayAddress(device, answer);

  if (!address) {
    return (
      <Group justify='space-between' wrap='nowrap'>
        <Text size='sm' c='dimmed'>The display has no address yet: make one to open in the browser that is to show things.</Text>
        <Button leftSection={<TablerIcon name='key' size={16} />} loading={pending} onClick={() => void renew()} style={{ flexShrink: 0 }}>
          Make the address
        </Button>
      </Group>
    );
  }

  const copy = async () => {
    if (!(await copyText(address, input.current))) {
      notify({ message: 'The browser would not copy the address: it is selected for you to copy.', color: 'yellow' });
      return;
    }
    notify({ message: 'Display address copied' });
  };

  return (
    <Stack gap='sm'>
      <Text size='sm' c='dimmed'>
        Open this address in the browser that is to be the screen: a computer by the TV, a tablet, a second monitor. It goes full screen at the first tap and waits there;
        choose Show on in EiN on any other device to show something on it.
      </Text>
      <TextInput
        ref={input}
        size='xs'
        readOnly
        label='Display address'
        value={address}
        onClick={() => void copy()}
        rightSectionPointerEvents='all'
        rightSection={
          <Tooltip label='Copy' withArrow>
            <ActionIcon variant='subtle' color='gray' size='sm' onClick={() => void copy()} aria-label='Copy the display address'>
              <TablerIcon name='copy' size={14} />
            </ActionIcon>
          </Tooltip>
        }
        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', cursor: 'pointer' } }}
      />
      <Text size='xs' c='dimmed'>Anyone who has the address can show it as this display: make a new address if it got out.</Text>
      <Group gap='xs'>
        <Button size='xs' leftSection={<TablerIcon name='external-link' size={14} />} component='a' href={address} target='_blank' rel='noreferrer'>
          Open here
        </Button>
        {confirmNew
          ? (
            <>
              <Text size='sm'>A browser showing the old address stops.</Text>
              <Button size='xs' color='red' loading={pending} onClick={() => void renew()}>Make a new address</Button>
              <Button size='xs' variant='default' onClick={() => setConfirmNew(false)}>Cancel</Button>
            </>
          )
          : (
            <Button size='xs' variant='default' leftSection={<TablerIcon name='refresh' size={14} />} onClick={() => setConfirmNew(true)}>
              New address
            </Button>
          )}
      </Group>
    </Stack>
  );
}

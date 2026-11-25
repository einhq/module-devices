import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { useAccessIds, useCommand } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { ActionIcon, Button, Stack, Text, TextInput } from '@mantine/core';
import type { DeviceCreated, GroupEntry } from '@ein/api';
import { useState } from 'react';
import { DisplayAddress } from '../display/DisplayAddress.tsx';

/** The group whose members make devices: core's `DEVICES_GROUPNAME`, which a page imports only as a type. */
const DEVICES_GROUPNAME = 'devices';

/** Whether the reader may make devices: an administrator, or a member of the `devices` group. Only what to offer; the commands decide. */
function useDevicesMember(): boolean {
  const access = useAccessIds();
  const { data: groups } = useCommand<GroupEntry[]>('group-list');
  if (access?.admin === true) return true;
  const gid = groups?.find((group) => group.groupname === DEVICES_GROUPNAME)?.gid;
  return gid !== undefined && access !== null && access.gids.includes(gid);
}

/**
 * The Devices page's way to make a browser a screen (a `devices.header` panel): a name, then a
 * device of the `browser` driver (`device-create --driver browser --class screen`) and the address
 * that browser opens, with its key in it. For whoever may make devices.
 */
export default function BrowserDisplayButton() {
  const member = useDevicesMember();
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [made, setMade] = useState<string>();
  if (!member) return null;

  const open = () => {
    setName('');
    setProblem(undefined);
    setMade(undefined);
    setOpened(true);
  };

  const make = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const created = await execCommand<DeviceCreated>(`device-create ${shq(name.trim())} --driver browser --class screen`);
      setMade(created.device);
    } catch (error) {
      setProblem(error instanceof Error ? error.message.replace(/^device-create: /, '') : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button className='mrx-header-wide' variant='default' leftSection={<TablerIcon name='device-desktop' size={16} />} onClick={open}>
        Browser display
      </Button>
      <ActionIcon className='mrx-header-narrow' variant='default' size='lg' aria-label='Browser display' onClick={open}>
        <TablerIcon name='device-desktop' size={18} />
      </ActionIcon>
      <Dialog
        opened={opened}
        onClose={() => !busy && setOpened(false)}
        title='Browser display'
        subtitle='A browser as a screen to show on'
        icon='device-desktop'
        size='md'
        onSubmit={made ? undefined : () => void make()}
      >
        {made ? <DisplayAddress device={made} fresh /> : (
          <Stack gap='sm'>
            <Text size='sm' c='dimmed'>
              Name the screen. EiN gives an address to open in its browser, which then shows what anyone chooses with Show on, full screen.
            </Text>
            <TextInput
              label='Name'
              placeholder='Living room TV'
              required
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              error={problem}
              data-autofocus
            />
          </Stack>
        )}
        <DialogActions>
          {made ? <Button onClick={() => setOpened(false)}>Done</Button> : (
            <>
              <Button variant='default' onClick={() => setOpened(false)} disabled={busy}>Cancel</Button>
              <Button type='submit' loading={busy} disabled={!name.trim()}>Make</Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}

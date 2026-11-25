import { useSearchParams } from 'react-router-dom';
import { DisplayAddress } from '../display/DisplayAddress.tsx';

/** A browser display's page's Display tab (a `device.tabs` panel): the address its browser opens. */
export default function DisplayAddressTab() {
  const [params] = useSearchParams();
  const device = (params.get('device') ?? '').split('/').filter(Boolean).pop() ?? '';
  return <DisplayAddress device={device} />;
}

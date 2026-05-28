import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { createDriver, getDrivers } from '../api';
import { Badge } from '../components/primitives';
import type { BootstrapPayload, DriverDto } from '../types';
import { readErrorMessage } from '../utils/format';

export function DriversPage({ bootstrap, setError }: { bootstrap: BootstrapPayload; setError(error: string | null): void }): ReactElement {
  const [drivers, setDrivers] = useState<DriverDto[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const refresh = (): void => {
    getDrivers().then((payload) => setDrivers(payload.drivers)).catch((error: unknown) => setError(readErrorMessage(error)));
  };
  useEffect(refresh, [setError]);
  const submit = async (): Promise<void> => {
    try {
      const payload = await createDriver({ csrfToken: bootstrap.csrfToken, displayName: displayName || null, phone });
      setDrivers(payload.drivers);
      setDisplayName('');
      setPhone('');
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    }
  };
  return (
    <section className="workspace-grid compact">
      <article className="panel"><span className="eyebrow">Drivers</span><h2>Driver management</h2><table className="ops-table"><thead><tr><th>Driver</th><th>Status</th><th>Phone</th><th>Auth</th></tr></thead><tbody>{drivers.map((driver) => <tr key={driver.id}><td><strong>{driver.displayName}</strong></td><td><Badge>{driver.status}</Badge></td><td>{driver.phone ?? '—'}</td><td>{driver.authStatus}</td></tr>)}</tbody></table></article>
      <aside className="panel side-panel"><span className="eyebrow">Invite</span><h2>Create pending driver</h2><label>Name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} /></label><button className="primary full" onClick={() => void submit()} type="button">Create driver invite</button><p className="muted">Vehicles are not configured yet; driver assignment works from Route Builder.</p></aside>
    </section>
  );
}

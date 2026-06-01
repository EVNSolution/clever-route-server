import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { createDriver, getDrivers, regenerateDriverInviteCode } from '../api';
import { Badge, Kpi } from '../components/primitives';
import type { BootstrapPayload, DriverDto } from '../types';
import { readErrorMessage } from '../utils/format';

const DRIVER_APP_DOWNLOAD_LINK_PLACEHOLDER = 'Driver app download link: ask CLEVER admin';

export function DriversPage({ bootstrap, setError }: { bootstrap: BootstrapPayload; setError(error: string | null): void }): ReactElement {
  const [drivers, setDrivers] = useState<DriverDto[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [savingDriver, setSavingDriver] = useState(false);
  const [regeneratingDriverId, setRegeneratingDriverId] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    getDrivers()
      .then((payload) => {
        setDrivers(payload.drivers);
        setError(null);
      })
      .catch((error: unknown) => setError(readErrorMessage(error)));
  }, [setError]);

  useEffect(refresh, [refresh]);

  const submit = async (): Promise<void> => {
    if (savingDriver || phone.trim() === '') return;
    setSavingDriver(true);
    try {
      const payload = await createDriver({
        csrfToken: bootstrap.csrfToken,
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        phone: phone.trim(),
      });
      setDrivers(payload.drivers);
      setDisplayName('');
      setPhone('');
      setNotice('Driver invite created. Share the app code with the driver, then assign routes any time.');
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setSavingDriver(false);
    }
  };

  const regenerate = async (driverId: string): Promise<void> => {
    if (regeneratingDriverId !== null) return;
    setRegeneratingDriverId(driverId);
    try {
      const payload = await regenerateDriverInviteCode({ csrfToken: bootstrap.csrfToken, driverId });
      setDrivers(payload.drivers);
      setNotice('Driver app code regenerated. Previous app sessions were invalidated by the server.');
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setRegeneratingDriverId(null);
    }
  };

  const copyInvite = async (driver: DriverDto): Promise<void> => {
    if (driver.inviteCode === null) return;
    const message = buildDriverInviteMessage(driver);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(message);
        setNotice(`Invite copied for ${driver.displayName}.`);
      } else {
        setNotice(message);
      }
      setError(null);
    } catch {
      setNotice(message);
    }
  };

  const pendingCount = drivers.filter((driver) => driver.authStatus === 'INVITE_PENDING').length;
  const linkedCount = drivers.filter((driver) => driver.appLinked).length;

  return (
    <section className="workspace-grid compact drivers-workspace">
      <article className="panel drivers-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Drivers</span>
            <h2>Driver management</h2>
            <p className="muted">Create a driver invite, share the six-character app code, and assign routes before app verification.</p>
          </div>
        </div>
        <div className="summary-strip compact-kpis driver-kpis" aria-label="Driver summary">
          <Kpi label="Drivers" value={drivers.length} />
          <Kpi label="Invite pending" value={pendingCount} />
          <Kpi label="App linked" value={linkedCount} />
        </div>
        {notice === null ? null : <p className="alert success driver-notice">{notice}</p>}
        <DriverTable
          drivers={drivers}
          onCopyInvite={(driver) => void copyInvite(driver)}
          onRegenerateInvite={(driverId) => void regenerate(driverId)}
          regeneratingDriverId={regeneratingDriverId}
        />
      </article>
      <aside className="panel side-panel driver-invite-panel">
        <span className="eyebrow">Invite</span>
        <h2>Create pending driver</h2>
        <label>
          Driver name
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alex Driver" />
        </label>
        <label>
          Phone
          <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+14165550123" />
          <small>Use E.164 format. The driver verifies this phone with the app code.</small>
        </label>
        <button className="primary full" disabled={savingDriver || phone.trim() === ''} onClick={() => void submit()} type="button">
          {savingDriver ? 'Creating…' : 'Create driver invite'}
        </button>
        <p className="muted">Pending drivers can be assigned in Route Builder now. They will see route details only after app authentication.</p>
      </aside>
    </section>
  );
}

export function DriverTable(input: {
  drivers: DriverDto[];
  onCopyInvite?: (driver: DriverDto) => void;
  onRegenerateInvite?: (driverId: string) => void;
  regeneratingDriverId?: string | null;
}): ReactElement {
  if (input.drivers.length === 0) {
    return <p className="empty-state">No drivers yet. Create the first pending driver invite.</p>;
  }
  return (
    <div className="table-scroll" data-driver-table="true">
      <table className="ops-table driver-table">
        <thead>
          <tr>
            <th>Driver</th>
            <th>Phone</th>
            <th>Status</th>
            <th>App access</th>
            <th>Invite code / action</th>
            <th>Last seen / joined</th>
            <th>Recent events</th>
          </tr>
        </thead>
        <tbody>
          {input.drivers.map((driver) => (
            <tr key={driver.id}>
              <td>
                <strong>{driver.displayName}</strong>
                <small>{driver.appLinked ? 'App linked' : 'Can be assigned before app verification'}</small>
              </td>
              <td>{driver.phone ?? '—'}</td>
              <td><Badge>{formatDriverStatus(driver)}</Badge></td>
              <td><span className={driver.appLinked ? 'status-pill ok' : 'status-pill warn'}>{formatDriverAuthLabel(driver)}</span></td>
              <td>
                <DriverInviteActions
                  driver={driver}
                  onCopyInvite={input.onCopyInvite}
                  onRegenerateInvite={input.onRegenerateInvite}
                  regeneratingDriverId={input.regeneratingDriverId ?? null}
                />
              </td>
              <td>
                <span>{driver.lastSeenAt === null ? 'Not seen yet' : formatDriverDate(driver.lastSeenAt)}</span>
                <small>Joined {formatDriverDate(driver.createdAt)}</small>
              </td>
              <td>{driver.recentEventsCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DriverInviteActions(input: {
  driver: DriverDto;
  onCopyInvite?: (driver: DriverDto) => void;
  onRegenerateInvite?: (driverId: string) => void;
  regeneratingDriverId: string | null;
}): ReactElement {
  const { driver } = input;
  const isRegenerating = input.regeneratingDriverId === driver.id;
  return (
    <div className="driver-invite-actions">
      {driver.inviteCode === null ? <span className="muted">No active code</span> : <span className="invite-code">{driver.inviteCode}</span>}
      <small>{driver.inviteCodeExpiresAt === null ? 'No expiry' : `Expires ${formatDriverDate(driver.inviteCodeExpiresAt)}`}</small>
      <div className="button-row compact-actions">
        <button disabled={driver.inviteCode === null} onClick={() => input.onCopyInvite?.(driver)} type="button">Copy invite</button>
        <button disabled={isRegenerating} onClick={() => input.onRegenerateInvite?.(driver.id)} type="button">
          {isRegenerating ? 'Regenerating…' : driver.appLinked ? 'Re-login code' : 'Regenerate'}
        </button>
      </div>
    </div>
  );
}

export function buildDriverInviteMessage(driver: DriverDto): string {
  return [
    DRIVER_APP_DOWNLOAD_LINK_PLACEHOLDER,
    `Authentication code: ${driver.inviteCode ?? ''}`,
  ].join('\n');
}

export function formatDriverAuthLabel(driver: Pick<DriverDto, 'appLinked' | 'authStatus'>): string {
  if (driver.appLinked || driver.authStatus === 'APP_LINKED') return 'App linked';
  return 'Invite pending';
}

export function formatDriverStatus(driver: Pick<DriverDto, 'status'>): string {
  return driver.status === 'PENDING' ? 'Pending' : driver.status;
}

export function formatDriverDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

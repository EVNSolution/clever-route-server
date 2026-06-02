import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  getCountryCallingCode,
  getCountries,
  parsePhoneNumberFromString,
} from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';

import { createDriver, deleteDriver, getDrivers, regenerateDriverInviteCode } from '../api';
import { Badge, Kpi } from '../components/primitives';
import type { BootstrapPayload, DriverDto } from '../types';
import { readErrorMessage } from '../utils/format';

const DRIVER_APP_DOWNLOAD_LINK_PLACEHOLDER = 'Driver app download link: ask CLEVER admin';
const DEFAULT_COUNTRY: CountryCode = 'US';
const COUNTRY_RESULT_LIMIT = 12;

export type CountrySearchOption = {
  callingCode: string;
  countryCode: CountryCode;
  label: string;
  name: string;
  searchText: string;
};

const countryNameFormatter =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

function normalizeCountryQuery(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function getCountryName(countryCode: CountryCode): string {
  return countryNameFormatter?.of(countryCode) ?? countryCode;
}

export function buildCountrySearchOption(countryCode: CountryCode): CountrySearchOption {
  const callingCode = getCountryCallingCode(countryCode);
  const name = getCountryName(countryCode);
  const label = `${name} (${countryCode} +${callingCode})`;
  return {
    callingCode,
    countryCode,
    label,
    name,
    searchText: normalizeCountryQuery(`${name} ${countryCode} +${callingCode} ${callingCode}`),
  };
}

function buildCountrySearchOptions(countries: readonly CountryCode[]): CountrySearchOption[] {
  return countries
    .map((countryCode) => buildCountrySearchOption(countryCode))
    .sort((left, right) => left.name.localeCompare(right.name) || left.countryCode.localeCompare(right.countryCode));
}

export function filterCountrySearchOptions(
  options: readonly CountrySearchOption[],
  query: string,
  limit = COUNTRY_RESULT_LIMIT,
): CountrySearchOption[] {
  const normalizedQuery = normalizeCountryQuery(query);
  if (normalizedQuery === '') return options.slice(0, limit);
  return options
    .filter((option) => option.searchText.includes(normalizedQuery))
    .slice(0, limit);
}

export function matchCountrySearchInput(
  options: readonly CountrySearchOption[],
  value: string,
): CountrySearchOption | null {
  const normalizedValue = normalizeCountryQuery(value);
  if (normalizedValue === '') return null;
  return options.find((option) => (
    normalizeCountryQuery(option.label) === normalizedValue
      || normalizeCountryQuery(option.countryCode) === normalizedValue
      || normalizeCountryQuery(option.name) === normalizedValue
  )) ?? null;
}

export function buildCanonicalPhone(countryCode: CountryCode, nationalPhone: string): string {
  const normalizedNational = nationalPhone.trim();
  if (normalizedNational === '') return '';

  const parsed = parsePhoneNumberFromString(normalizedNational, countryCode);
  if (parsed === undefined || !parsed.isValid()) return '';

  return parsed.number;
}

export function DriversPage({ bootstrap, setError }: { bootstrap: BootstrapPayload; setError(error: string | null): void }): ReactElement {
  const [drivers, setDrivers] = useState<DriverDto[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [phoneCountryCode, setPhoneCountryCode] = useState<CountryCode>(DEFAULT_COUNTRY);
  const [phoneNational, setPhoneNational] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [savingDriver, setSavingDriver] = useState(false);
  const [regeneratingDriverId, setRegeneratingDriverId] = useState<string | null>(null);
  const [deletingDriverId, setDeletingDriverId] = useState<string | null>(null);
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const countryOptions = useMemo(() => buildCountrySearchOptions(getCountries()), []);
  const selectedCountryOption = useMemo(
    () => countryOptions.find((option) => option.countryCode === phoneCountryCode) ?? buildCountrySearchOption(phoneCountryCode),
    [countryOptions, phoneCountryCode],
  );
  const [countrySearch, setCountrySearch] = useState(selectedCountryOption.label);
  const visibleCountryOptions = useMemo(
    () => filterCountrySearchOptions(countryOptions, countrySearch),
    [countryOptions, countrySearch],
  );
  const canonicalPhone = buildCanonicalPhone(phoneCountryCode, phoneNational);

  const canSubmitDriver = canonicalPhone !== '' && !savingDriver;

  const refresh = useCallback((): void => {
    getDrivers()
      .then((payload) => {
        setDrivers(payload.drivers);
        setError(null);
      })
      .catch((error: unknown) => setError(readErrorMessage(error)));
  }, [setError]);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (!countryPickerOpen) setCountrySearch(selectedCountryOption.label);
  }, [countryPickerOpen, selectedCountryOption.label]);

  const selectCountry = (option: CountrySearchOption): void => {
    setPhoneCountryCode(option.countryCode);
    setCountrySearch(option.label);
    setCountryPickerOpen(false);
  };

  const updateCountrySearch = (value: string): void => {
    setCountrySearch(value);
    setCountryPickerOpen(true);
    const exactMatch = matchCountrySearchInput(countryOptions, value);
    if (exactMatch !== null) setPhoneCountryCode(exactMatch.countryCode);
  };

  const submit = async (): Promise<void> => {
    if (savingDriver || canonicalPhone === '') return;
    setSavingDriver(true);
    try {
      const payload = await createDriver({
        csrfToken: bootstrap.csrfToken,
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        phone: canonicalPhone,
      });
      setDrivers(payload.drivers);
      setDisplayName('');
      setPhoneNational('');
      setNotice('Driver invite created. Share the app code with the driver, then assign routes any time.');
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setSavingDriver(false);
    }
  };

  const regenerate = async (driverId: string): Promise<void> => {
    if (regeneratingDriverId !== null || deletingDriverId !== null) return;
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

  const removeDriver = async (driver: DriverDto): Promise<void> => {
    if (deletingDriverId !== null || regeneratingDriverId !== null) return;
    const confirmed = window.confirm(
      `Delete ${driver.displayName}? This removes the driver invite/app access from CLEVER Route.`,
    );
    if (!confirmed) return;
    setDeletingDriverId(driver.id);
    try {
      const payload = await deleteDriver({ csrfToken: bootstrap.csrfToken, driverId: driver.id });
      setDrivers(payload.drivers);
      setNotice(`Driver deleted: ${driver.displayName}.`);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setDeletingDriverId(null);
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
          <Kpi label="Linked" value={linkedCount} />
        </div>
        {notice === null ? null : <p className="alert success driver-notice">{notice}</p>}
        <DriverTable
          drivers={drivers}
          onCopyInvite={(driver) => void copyInvite(driver)}
          onDelete={(driver) => void removeDriver(driver)}
          onRegenerateInvite={(driverId) => void regenerate(driverId)}
          deletingDriverId={deletingDriverId}
          regeneratingDriverId={regeneratingDriverId}
        />
      </article>
      <aside className="panel side-panel driver-invite-panel">
        <span className="eyebrow">Invite</span>
        <h2>Create pending driver</h2>
        <label>
          Driver name
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          Phone
          <div className="driver-phone-inputs">
            <label className="driver-country-field">
              <span className="muted">Country</span>
              <div className="driver-country-combobox">
                <input
                  aria-autocomplete="list"
                  aria-controls="driver-country-options"
                  aria-expanded={countryPickerOpen}
                  aria-label="Search country"
                  autoComplete="off"
                  role="combobox"
                  spellCheck={false}
                  value={countrySearch}
                  onBlur={() => setCountryPickerOpen(false)}
                  onChange={(event) => updateCountrySearch(event.target.value)}
                  onFocus={(event) => {
                    setCountryPickerOpen(true);
                    event.currentTarget.select();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setCountryPickerOpen(false);
                      return;
                    }
                    if (event.key !== 'Enter') return;
                    const firstOption = visibleCountryOptions[0];
                    if (firstOption === undefined) return;
                    event.preventDefault();
                    selectCountry(firstOption);
                  }}
                />
                {countryPickerOpen ? (
                  <div className="driver-country-results" id="driver-country-options" role="listbox">
                    {visibleCountryOptions.length === 0 ? (
                      <span className="driver-country-empty">No country match</span>
                    ) : visibleCountryOptions.map((option) => (
                      <button
                        key={option.countryCode}
                        aria-selected={option.countryCode === phoneCountryCode}
                        className="driver-country-option"
                        onClick={() => selectCountry(option)}
                        onMouseDown={(event) => event.preventDefault()}
                        role="option"
                        type="button"
                      >
                        <span>{option.name}</span>
                        <small>{option.countryCode} +{option.callingCode}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </label>
            <label className="driver-national-field">
              <span className="muted">National number</span>
              <input
                type="tel"
                value={phoneNational}
                onChange={(event) => setPhoneNational(event.target.value)}
              />
            </label>
          </div>
          <small>
            {canonicalPhone === ''
              ? 'Enter a valid number in national format to preview E.164.'
              : `E.164 preview: ${canonicalPhone}`}
          </small>
        </label>
        <button className="primary full" disabled={!canSubmitDriver} onClick={() => void submit()} type="button">
          {savingDriver ? 'Creating…' : 'Create driver invite'}
        </button>
        <p className="muted">Pending drivers can be assigned in Route Builder now. They will see route details only after app authentication.</p>
      </aside>
    </section>
  );
}

export function DriverTable(input: {
  deletingDriverId?: string | null;
  drivers: DriverDto[];
  onCopyInvite?: (driver: DriverDto) => void;
  onDelete?: (driver: DriverDto) => void;
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
          </tr>
        </thead>
        <tbody>
          {input.drivers.map((driver) => (
            <tr key={driver.id}>
              <td>
                <strong>{driver.displayName}</strong>
                <small>{driver.appLinked ? 'Linked' : 'Can be assigned before app verification'}</small>
              </td>
              <td>{driver.phone ?? '—'}</td>
              <td><Badge>{formatDriverStatus(driver)}</Badge></td>
              <td><span className={driver.appLinked ? 'status-pill ok' : 'status-pill warn'}>{formatDriverAuthLabel(driver)}</span></td>
              <td>
                <DriverInviteActions
                  driver={driver}
                  deletingDriverId={input.deletingDriverId ?? null}
                  onDelete={input.onDelete}
                  onCopyInvite={input.onCopyInvite}
                  onRegenerateInvite={input.onRegenerateInvite}
                  regeneratingDriverId={input.regeneratingDriverId ?? null}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DriverInviteActions(input: {
  deletingDriverId: string | null;
  driver: DriverDto;
  onCopyInvite?: (driver: DriverDto) => void;
  onDelete?: (driver: DriverDto) => void;
  onRegenerateInvite?: (driverId: string) => void;
  regeneratingDriverId: string | null;
}): ReactElement {
  const { driver } = input;
  const isRegenerating = input.regeneratingDriverId === driver.id;
  const isDeleting = input.deletingDriverId === driver.id;
  return (
    <div className="driver-invite-actions">
      <div className="driver-invite-row">
        <span className="driver-invite-meta">
          {driver.inviteCode === null ? <span className="muted">No active code</span> : <span className="invite-code">{driver.inviteCode}</span>}
        </span>
        <div className="driver-invite-controls">
          <button disabled={driver.inviteCode === null} onClick={() => input.onCopyInvite?.(driver)} type="button">copy</button>
          <button disabled={isRegenerating || isDeleting} onClick={() => input.onRegenerateInvite?.(driver.id)} type="button">
            {isRegenerating ? 're-login…' : 're-login'}
          </button>
        </div>
      </div>
      <div className="driver-invite-row">
        <small className="driver-invite-meta">{driver.inviteCodeExpiresAt === null ? 'No expiry' : `Expires ${formatDriverDate(driver.inviteCodeExpiresAt)}`}</small>
        <div className="driver-invite-controls">
          <button className="danger subtle" disabled={isDeleting || isRegenerating} onClick={() => input.onDelete?.(driver)} type="button">
            {isDeleting ? 'delete…' : 'delete'}
          </button>
        </div>
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
  if (driver.appLinked || driver.authStatus === 'APP_LINKED') return 'Linked';
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

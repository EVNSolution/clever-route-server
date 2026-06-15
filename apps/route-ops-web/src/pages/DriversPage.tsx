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
import { getDriversCopy, resolveLocale } from '../i18n';
import type { BootstrapPayload, DriverDto } from '../types';
import { readErrorMessage } from '../utils/format';

const DEFAULT_COUNTRY: CountryCode = 'US';
const COUNTRY_RESULT_LIMIT = 12;

export type CountrySearchOption = {
  callingCode: string;
  countryCode: CountryCode;
  label: string;
  name: string;
  searchText: string;
};

function normalizeCountryQuery(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function createCountryDisplayNames(locale: string | null | undefined = 'en-CA'): Intl.DisplayNames | null {
  if (typeof Intl === 'undefined' || !('DisplayNames' in Intl)) return null;
  return new Intl.DisplayNames([resolveLocale(locale)], { type: 'region' });
}

function getCountryName(countryCode: CountryCode, locale: string | null | undefined = 'en-CA', displayNames = createCountryDisplayNames(locale)): string {
  return displayNames?.of(countryCode) ?? countryCode;
}

export function buildCountrySearchOption(countryCode: CountryCode, locale: string | null | undefined = 'en-CA', displayNames = createCountryDisplayNames(locale)): CountrySearchOption {
  const callingCode = getCountryCallingCode(countryCode);
  const name = getCountryName(countryCode, locale, displayNames);
  const label = `${name} (${countryCode} +${callingCode})`;
  return {
    callingCode,
    countryCode,
    label,
    name,
    searchText: normalizeCountryQuery(`${name} ${countryCode} +${callingCode} ${callingCode}`),
  };
}

function buildCountrySearchOptions(countries: readonly CountryCode[], locale: string | null | undefined): CountrySearchOption[] {
  const displayNames = createCountryDisplayNames(locale);
  return countries
    .map((countryCode) => buildCountrySearchOption(countryCode, locale, displayNames))
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
  const locale = resolveLocale(bootstrap.locale);
  const t = getDriversCopy(locale);
  const [drivers, setDrivers] = useState<DriverDto[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [phoneCountryCode, setPhoneCountryCode] = useState<CountryCode>(DEFAULT_COUNTRY);
  const [phoneNational, setPhoneNational] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [savingDriver, setSavingDriver] = useState(false);
  const [regeneratingDriverId, setRegeneratingDriverId] = useState<string | null>(null);
  const [deletingDriverId, setDeletingDriverId] = useState<string | null>(null);
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const countryOptions = useMemo(() => buildCountrySearchOptions(getCountries(), locale), [locale]);
  const selectedCountryOption = useMemo(
    () => countryOptions.find((option) => option.countryCode === phoneCountryCode) ?? buildCountrySearchOption(phoneCountryCode, locale),
    [countryOptions, locale, phoneCountryCode],
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
      setNotice(t.createdNotice);
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
      setNotice(t.regeneratedNotice);
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
      t.deleteConfirm(driver.displayName),
    );
    if (!confirmed) return;
    setDeletingDriverId(driver.id);
    try {
      const payload = await deleteDriver({ csrfToken: bootstrap.csrfToken, driverId: driver.id });
      setDrivers(payload.drivers);
      setNotice(t.deletedNotice(driver.displayName));
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setDeletingDriverId(null);
    }
  };

  const copyInvite = async (driver: DriverDto): Promise<void> => {
    if (driver.inviteCode === null) return;
    const message = buildDriverInviteMessage(driver, locale);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(message);
        setNotice(t.copiedNotice(driver.displayName));
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
            <span className="eyebrow">{t.eyebrow}</span>
            <h2>{t.title}</h2>
            <p className="muted">{t.description}</p>
          </div>
        </div>
        <div className="summary-strip compact-kpis driver-kpis" aria-label={t.summaryLabel}>
          <Kpi label={t.drivers} value={drivers.length} />
          <Kpi label={t.invitePending} value={pendingCount} />
          <Kpi label={t.linked} value={linkedCount} />
        </div>
        {notice === null ? null : <p className="alert success driver-notice">{notice}</p>}
        <DriverTable
          drivers={drivers}
          onCopyInvite={(driver) => void copyInvite(driver)}
          onDelete={(driver) => void removeDriver(driver)}
          onRegenerateInvite={(driverId) => void regenerate(driverId)}
          deletingDriverId={deletingDriverId}
          locale={locale}
          regeneratingDriverId={regeneratingDriverId}
        />
      </article>
      <aside className="panel side-panel driver-invite-panel">
        <span className="eyebrow">{t.inviteEyebrow}</span>
        <h2>{t.createPendingDriver}</h2>
        <label>
          {t.driverName}
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          {t.phone}
          <div className="driver-phone-inputs">
            <label className="driver-country-field">
              <span className="muted">{t.country}</span>
              <div className="driver-country-combobox">
                <input
                  aria-autocomplete="list"
                  aria-controls="driver-country-options"
                  aria-expanded={countryPickerOpen}
                  aria-label={t.searchCountry}
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
                      <span className="driver-country-empty">{t.noCountryMatch}</span>
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
              <span className="muted">{t.nationalNumber}</span>
              <input
                type="tel"
                value={phoneNational}
                onChange={(event) => setPhoneNational(event.target.value)}
              />
            </label>
          </div>
          {canonicalPhone === '' ? null : <small>{t.e164Preview(canonicalPhone)}</small>}
        </label>
        <button className="primary full" disabled={!canSubmitDriver} onClick={() => void submit()} type="button">
          {savingDriver ? t.creating : t.createInvite}
        </button>
      </aside>
    </section>
  );
}

export function DriverTable(input: {
  deletingDriverId?: string | null;
  drivers: DriverDto[];
  locale?: string | null;
  onCopyInvite?: (driver: DriverDto) => void;
  onDelete?: (driver: DriverDto) => void;
  onRegenerateInvite?: (driverId: string) => void;
  regeneratingDriverId?: string | null;
}): ReactElement {
  const t = getDriversCopy(input.locale);
  if (input.drivers.length === 0) {
    return <p className="empty-state">{t.noDrivers}</p>;
  }
  return (
    <div className="table-scroll" data-driver-table="true">
      <table className="ops-table driver-table">
        <thead>
          <tr>
            <th>{t.table.driver}</th>
            <th>{t.table.phone}</th>
            <th>{t.table.status}</th>
            <th>{t.table.appAccess}</th>
            <th className="driver-invite-action-column">{t.table.inviteAction}</th>
          </tr>
        </thead>
        <tbody>
          {input.drivers.map((driver) => (
            <tr key={driver.id}>
              <td>
                <strong>{driver.displayName}</strong>
                <small>{driver.appLinked ? t.linked : t.canAssignBeforeVerification}</small>
              </td>
              <td>{driver.phone ?? '—'}</td>
              <td><Badge>{formatDriverStatus(driver, input.locale)}</Badge></td>
              <td><span className={driver.appLinked ? 'status-pill ok' : 'status-pill warn'}>{formatDriverAuthLabel(driver, input.locale)}</span></td>
              <td className="driver-invite-action-column">
                <DriverInviteActions
                  driver={driver}
                  deletingDriverId={input.deletingDriverId ?? null}
                  locale={input.locale}
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
  locale?: string | null;
  onCopyInvite?: (driver: DriverDto) => void;
  onDelete?: (driver: DriverDto) => void;
  onRegenerateInvite?: (driverId: string) => void;
  regeneratingDriverId: string | null;
}): ReactElement {
  const { driver } = input;
  const t = getDriversCopy(input.locale);
  const isRegenerating = input.regeneratingDriverId === driver.id;
  const isDeleting = input.deletingDriverId === driver.id;
  return (
    <div className="driver-invite-actions">
      <div className="driver-invite-meta-stack">
        <span className="driver-invite-meta">
          {driver.inviteCode === null ? <span className="muted">{t.noActiveCode}</span> : <span className="invite-code">{driver.inviteCode}</span>}
        </span>
        <small className="driver-invite-meta">{driver.inviteCodeExpiresAt === null ? t.noExpiry : t.expires(formatDriverDate(driver.inviteCodeExpiresAt))}</small>
      </div>
      <div className="driver-invite-controls">
        <button disabled={driver.inviteCode === null} onClick={() => input.onCopyInvite?.(driver)} type="button">{t.copy}</button>
        <button disabled={isRegenerating || isDeleting} onClick={() => input.onRegenerateInvite?.(driver.id)} type="button">
          {isRegenerating ? t.reLoginBusy : t.reLogin}
        </button>
        <button className="danger subtle" disabled={isDeleting || isRegenerating} onClick={() => input.onDelete?.(driver)} type="button">
          {isDeleting ? t.deleteBusy : t.delete}
        </button>
      </div>
    </div>
  );
}

export function buildDriverInviteMessage(driver: DriverDto, locale: string | null | undefined = 'en-CA'): string {
  const t = getDriversCopy(locale);
  return [
    t.inviteMessageLink,
    `${t.authenticationCode}: ${driver.inviteCode ?? ''}`,
  ].join('\n');
}

export function formatDriverAuthLabel(driver: Pick<DriverDto, 'appLinked' | 'authStatus'>, locale: string | null | undefined = 'en-CA'): string {
  const t = getDriversCopy(locale);
  if (driver.appLinked || driver.authStatus === 'APP_LINKED') return t.linked;
  return t.invitePending;
}

export function formatDriverStatus(driver: Pick<DriverDto, 'status'>, locale: string | null | undefined = 'en-CA'): string {
  const t = getDriversCopy(locale);
  if (driver.status === 'PENDING') return t.statusLabel.pending;
  if (driver.status === 'ACTIVE') return t.statusLabel.active;
  return driver.status;
}

export function formatDriverDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

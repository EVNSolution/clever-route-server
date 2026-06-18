import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { geocodeSettings, getSettings, saveSettings } from '../api';
import { RouteOpsMap } from '../components/maps/RouteOpsMap';
import { resolveLocale, settingsCopy } from '../i18n';
import type {
  BootstrapPayload,
  CanonicalOrderDto,
  StoreSettingsDto
} from '../types';
import { emptySettings, readErrorMessage, toNullableNumber } from '../utils/format';

export function SettingsPage({ bootstrap, setError }: { bootstrap: BootstrapPayload; setError(error: string | null): void }): ReactElement {
  const [settings, setSettingsState] = useState<StoreSettingsDto | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings().then((payload) => setSettingsState(payload.settings)).catch((error: unknown) => setError(readErrorMessage(error)));
  }, [setError]);

  const draft = settings ?? emptySettings(bootstrap);
  const locale = resolveLocale(draft.locale);
  const t = settingsCopy[locale];

  const updateDraft = (patch: Partial<StoreSettingsDto>): void => {
    setSettingsState({ ...draft, ...patch, locale: resolveLocale(patch.locale ?? draft.locale) });
    setNotice(null);
  };


  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const payload = await saveSettings(buildSettingsSaveInput({
        csrfToken: bootstrap.csrfToken,
        draft
      }));
      setSettingsState(payload.settings);
      setNotice(t.saved);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const geocodeAndSave = async (): Promise<void> => {
    const defaultDepotAddress = draft.defaultDepotAddress?.trim() ?? '';
    if (defaultDepotAddress === '') {
      setError(t.blankAddress);
      return;
    }
    setGeocoding(true);
    try {
      const payload = await geocodeSettings({
        csrfToken: bootstrap.csrfToken,
        defaultDepotAddress,
        locale: resolveLocale(draft.locale)
      });
      setSettingsState(payload.settings);
      setNotice(payload.geocode.cached ? t.remembered : t.geocodeSaved(payload.geocode.result.latitude, payload.geocode.result.longitude));
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setGeocoding(false);
    }
  };

  const depotOrders = depotAsOrders(draft, t.depot, t.defaultDepot);
  return (
    <section className="workspace-grid compact settings-workspace" data-settings-layout="category-sections">
      <article className="panel settings-main-panel">
        <div className="settings-category-stack">
          <SettingsCategorySection
            description={t.depotMapSubtitle}
            eyebrow={t.settingsEyebrow}
            title={t.settingsTitle}
          >
            <div className="settings-field-stack">
              <label className="settings-field settings-field--full">
                {t.storeAddress}
                <input value={draft.defaultDepotAddress ?? ''} onChange={(event) => updateDraft({ defaultDepotAddress: event.target.value })} />
              </label>
              <div className="settings-field-grid">
                <label className="settings-field">
                  {t.latitude}
                  <input value={draft.defaultDepotLatitude?.toString() ?? ''} onChange={(event) => updateDraft({ defaultDepotLatitude: toNullableNumber(event.target.value) })} />
                </label>
                <label className="settings-field">
                  {t.longitude}
                  <input value={draft.defaultDepotLongitude?.toString() ?? ''} onChange={(event) => updateDraft({ defaultDepotLongitude: toNullableNumber(event.target.value) })} />
                </label>
                <label className="settings-field">
                  {t.language}
                  <select value={locale} onChange={(event) => updateDraft({ locale: resolveLocale(event.target.value) })}>
                    <option value="en-CA">{t.english}</option>
                    <option value="ko-KR">{t.korean}</option>
                  </select>
                </label>
              </div>
              <div className="settings-action-row">
                <button disabled={geocoding} onClick={() => void geocodeAndSave()} type="button">{geocoding ? t.geocoding : t.geocodeAndSave}</button>
              </div>
            </div>
          </SettingsCategorySection>


          <div className="settings-save-row">
            <button className="primary" disabled={saving} onClick={() => void save()} type="button">{saving ? t.saving : t.saveSettings}</button>
            {notice === null ? null : <p className="muted">{notice}</p>}
          </div>
        </div>
      </article>
      <aside className="side-panel settings-side-panel">
        <RouteOpsMap
          bootstrap={bootstrap}
          onMapClickCoordinate={(coordinate) => updateDraft({ defaultDepotLatitude: coordinate.latitude, defaultDepotLongitude: coordinate.longitude })}
          orders={depotOrders}
          subtitle={t.depotMapSubtitle}
          title={t.depotMapTitle}
        />
        <article className="panel settings-provider-panel">
          <div className="settings-category-header">
            <span className="eyebrow">{t.providersEyebrow}</span>
            <h2>{t.providersTitle}</h2>
          </div>
          <dl className="settings-status-list">
            <div>
              <dt>{t.mapProvider}</dt>
              <dd>{formatProviderStatus(bootstrap.mapConfig.status, t)}</dd>
            </div>
            <div>
              <dt>{t.providerMode}</dt>
              <dd>{formatProviderMode(bootstrap.mapConfig.providerMode, t)}</dd>
            </div>
            <div>
              <dt>{t.routeGeometryProvider}</dt>
              <dd>{formatProviderStatus(bootstrap.routerConfig.status, t)}</dd>
            </div>
          </dl>
          <p className="muted">{t.noProviderSecrets}</p>
        </article>
      </aside>
    </section>
  );
}

type SettingsLabels = (typeof settingsCopy)[keyof typeof settingsCopy];

export function buildSettingsSaveInput(input: {
  csrfToken: string;
  draft: StoreSettingsDto;
}): Parameters<typeof saveSettings>[0] {
  const { routeScopeConfig: _routeScopeConfig, ...settingsWithoutRouteScopeConfig } = input.draft;
  return {
    ...settingsWithoutRouteScopeConfig,
    csrfToken: input.csrfToken,
    locale: resolveLocale(input.draft.locale)
  };
}

function SettingsCategorySection({
  children,
  description,
  eyebrow,
  title
}: {
  children: ReactElement | ReactElement[];
  description?: string;
  eyebrow: string;
  title: string;
}): ReactElement {
  return (
    <section className="settings-category">
      <div className="settings-category-header">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        {description === undefined ? null : <p className="muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function depotAsOrders(settings: StoreSettingsDto, depotName: string, fallbackAddress: string): CanonicalOrderDto[] {
  if (settings.defaultDepotLatitude === null || settings.defaultDepotLongitude === null) return [];
  return [{
    blockerReasons: [],
    coordinates: { latitude: settings.defaultDepotLatitude, longitude: settings.defaultDepotLongitude },
    deliveryArea: null,
    deliveryDate: null,
    deliverySession: null,
    deliveryStatus: 'depot',
    geocodeStatus: 'RESOLVED',
    health: 'normal',
    orderId: 'settings-depot',
    orderName: depotName,
    phone: null,
    planningStatus: 'UNPLANNED',
    recipientName: settings.defaultDepotAddress ?? fallbackAddress,
    routeEligible: false,
    routePlanId: null,
    routePlanName: null,
    serviceType: 'DELIVERY',
    shippingAddress: { address1: null, address2: null, city: null, countryCode: null, postalCode: null, province: null },
    sourceOrderId: 'settings-depot',
    sourceOrderNumber: null,
    sourceCreatedAt: null,
    sourceCreatedDate: null,
    sourcePlatform: 'SETTINGS',
    sourceUpdatedAt: null,
    sourceUpdatedDate: null,
    status: null,
    stopId: null,
    timeWindowEnd: null,
    timeWindowStart: null
  }];
}


function formatProviderStatus(status: BootstrapPayload['mapConfig']['status'], labels: SettingsLabels): string {
  return status === 'configured' ? labels.configured : labels.notConfigured;
}

function formatProviderMode(mode: BootstrapPayload['mapConfig']['providerMode'], labels: SettingsLabels): string {
  if (mode === 'public_allowlisted') return labels.publicAllowlisted;
  if (mode === 'self_hosted') return labels.selfHosted;
  return labels.none;
}

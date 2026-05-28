import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { geocodeSettings, getSettings, saveSettings } from '../api';
import { RouteOpsMap } from '../components/maps/RouteOpsMap';
import { resolveLocale, settingsCopy } from '../i18n';
import type { BootstrapPayload, CanonicalOrderDto, StoreSettingsDto } from '../types';
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
      const payload = await saveSettings({ ...draft, locale: resolveLocale(draft.locale), csrfToken: bootstrap.csrfToken });
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
    <section className="workspace-grid compact">
      <article className="panel">
        <span className="eyebrow">{t.settingsEyebrow}</span>
        <h2>{t.settingsTitle}</h2>
        <label>
          {t.storeAddress}
          <input value={draft.defaultDepotAddress ?? ''} onChange={(event) => updateDraft({ defaultDepotAddress: event.target.value })} />
        </label>
        <div className="form-grid">
          <label>
            {t.latitude}
            <input value={draft.defaultDepotLatitude?.toString() ?? ''} onChange={(event) => updateDraft({ defaultDepotLatitude: toNullableNumber(event.target.value) })} />
          </label>
          <label>
            {t.longitude}
            <input value={draft.defaultDepotLongitude?.toString() ?? ''} onChange={(event) => updateDraft({ defaultDepotLongitude: toNullableNumber(event.target.value) })} />
          </label>
        </div>
        <label>
          {t.language}
          <select value={locale} onChange={(event) => updateDraft({ locale: resolveLocale(event.target.value) })}>
            <option value="en-CA">{t.english}</option>
            <option value="ko-KR">{t.korean}</option>
          </select>
        </label>
        <div className="button-row">
          <button className="primary" disabled={saving} onClick={() => void save()} type="button">{saving ? t.saving : t.saveSettings}</button>
          <button disabled={geocoding} onClick={() => void geocodeAndSave()} type="button">{geocoding ? t.geocoding : t.geocodeAndSave}</button>
        </div>
        {notice === null ? null : <p className="muted">{notice}</p>}
      </article>
      <aside className="side-panel">
        <RouteOpsMap
          bootstrap={bootstrap}
          onMapClickCoordinate={(coordinate) => updateDraft({ defaultDepotLatitude: coordinate.latitude, defaultDepotLongitude: coordinate.longitude })}
          orders={depotOrders}
          subtitle={t.depotMapSubtitle}
          title={t.depotMapTitle}
        />
        <article className="panel">
          <span className="eyebrow">{t.providersEyebrow}</span>
          <h2>{t.providersTitle}</h2>
          <p>{t.mapProvider}: <strong>{bootstrap.mapConfig.status}</strong></p>
          <p>{t.providerMode}: <strong>{bootstrap.mapConfig.providerMode ?? t.none}</strong></p>
          <p>{t.routeGeometryProvider}: <strong>{bootstrap.routerConfig.status}</strong></p>
          <p className="muted">{t.noProviderSecrets}</p>
        </article>
      </aside>
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
    routePlanId: null,
    routePlanName: null,
    serviceType: 'DELIVERY',
    shippingAddress: { address1: null, address2: null, city: null, countryCode: null, postalCode: null, province: null },
    sourceOrderId: 'settings-depot',
    sourceOrderNumber: null,
    sourcePlatform: 'SETTINGS',
    status: null,
    stopId: null,
    timeWindowEnd: null,
    timeWindowStart: null
  }];
}

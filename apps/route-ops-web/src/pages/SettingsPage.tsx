import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { geocodeSettings, getSettings, saveSettings } from '../api';
import { RouteOpsMap } from '../components/maps/RouteOpsMap';
import { resolveLocale, settingsCopy } from '../i18n';
import { normalizeRouteScopeConfig } from '../routeScopeConfig';
import type {
  BootstrapPayload,
  CanonicalOrderDto,
  RouteScopeConfigDto,
  RouteScopeValueDto,
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
  const routeScopeConfig = normalizeRouteScopeConfig(draft.routeScopeConfig);
  const locale = resolveLocale(draft.locale);
  const t = settingsCopy[locale];

  const updateDraft = (patch: Partial<StoreSettingsDto>): void => {
    setSettingsState({ ...draft, ...patch, locale: resolveLocale(patch.locale ?? draft.locale) });
    setNotice(null);
  };

  const updateRouteScopeConfig = (next: RouteScopeConfigDto): void => {
    updateDraft({ routeScopeConfig: next });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const payload = await saveSettings(buildSettingsSaveInput({
        csrfToken: bootstrap.csrfToken,
        draft,
        routeScopeConfig
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

        <RouteScopeSettingsEditor
          config={routeScopeConfig}
          labels={t}
          onChange={updateRouteScopeConfig}
        />

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

type SettingsLabels = (typeof settingsCopy)[keyof typeof settingsCopy];

export type RouteScopeKind = 'serviceTypes' | 'deliverySessions';

export function buildSettingsSaveInput(input: {
  csrfToken: string;
  draft: StoreSettingsDto;
  routeScopeConfig: RouteScopeConfigDto;
}): Parameters<typeof saveSettings>[0] {
  return {
    ...input.draft,
    csrfToken: input.csrfToken,
    locale: resolveLocale(input.draft.locale),
    routeScopeConfig: input.routeScopeConfig
  };
}

export function addRouteScopeValue(config: RouteScopeConfigDto, kind: RouteScopeKind): RouteScopeConfigDto {
  const suffix = config[kind].filter((value) => !value.builtIn).length + 1;
  return {
    ...config,
    [kind]: [
      ...config[kind],
      {
        builtIn: false,
        description: null,
        enabled: true,
        example: null,
        label: 'Custom value',
        value: kind === 'serviceTypes' ? `CUSTOM_SERVICE_${suffix}` : `CUSTOM_SESSION_${suffix}`
      }
    ]
  };
}

export function updateRouteScopeValue(
  config: RouteScopeConfigDto,
  kind: RouteScopeKind,
  index: number,
  patch: Partial<RouteScopeValueDto>
): RouteScopeConfigDto {
  return {
    ...config,
    [kind]: config[kind].map((value, valueIndex) => (valueIndex === index ? { ...value, ...patch } : value))
  };
}

export function removeRouteScopeValue(config: RouteScopeConfigDto, kind: RouteScopeKind, index: number): RouteScopeConfigDto {
  return {
    ...config,
    [kind]: config[kind].filter((_, valueIndex) => valueIndex !== index)
  };
}

function RouteScopeSettingsEditor({
  config,
  labels,
  onChange
}: {
  config: RouteScopeConfigDto;
  labels: SettingsLabels;
  onChange(config: RouteScopeConfigDto): void;
}): ReactElement {
  const addValue = (kind: RouteScopeKind): void => {
    onChange(addRouteScopeValue(config, kind));
  };
  const updateValue = (kind: RouteScopeKind, index: number, patch: Partial<RouteScopeValueDto>): void => {
    onChange(updateRouteScopeValue(config, kind, index, patch));
  };
  const removeValue = (kind: RouteScopeKind, index: number): void => {
    onChange(removeRouteScopeValue(config, kind, index));
  };

  return (
    <section className="route-scope-settings" aria-label={labels.routeScopeTitle}>
      <span className="eyebrow">{labels.routeScopeEyebrow}</span>
      <h3>{labels.routeScopeTitle}</h3>
      <p className="muted">{labels.routeScopeDescription}</p>
      <RouteScopeValueList
        addLabel={labels.addServiceType}
        kind="serviceTypes"
        labels={labels}
        onAdd={() => addValue('serviceTypes')}
        onRemove={(index) => removeValue('serviceTypes', index)}
        onUpdate={(index, patch) => updateValue('serviceTypes', index, patch)}
        title={labels.serviceTypes}
        values={config.serviceTypes}
      />
      <RouteScopeValueList
        addLabel={labels.addDeliverySession}
        kind="deliverySessions"
        labels={labels}
        onAdd={() => addValue('deliverySessions')}
        onRemove={(index) => removeValue('deliverySessions', index)}
        onUpdate={(index, patch) => updateValue('deliverySessions', index, patch)}
        title={labels.deliverySessions}
        values={config.deliverySessions}
      />
      <div className="route-scope-time-window">
        <h4>{labels.timeWindowHelp}</h4>
        <label>
          {labels.timeWindowHelp}
          <input value={config.timeWindow.helpText} onChange={(event) => onChange({ ...config, timeWindow: { ...config.timeWindow, helpText: event.target.value } })} />
        </label>
        <div className="form-grid">
          <label>
            {labels.startExample}
            <input value={config.timeWindow.startExample} onChange={(event) => onChange({ ...config, timeWindow: { ...config.timeWindow, startExample: event.target.value } })} />
          </label>
          <label>
            {labels.endExample}
            <input value={config.timeWindow.endExample} onChange={(event) => onChange({ ...config, timeWindow: { ...config.timeWindow, endExample: event.target.value } })} />
          </label>
        </div>
      </div>
    </section>
  );
}

function RouteScopeValueList({
  addLabel,
  kind,
  labels,
  onAdd,
  onRemove,
  onUpdate,
  title,
  values
}: {
  addLabel: string;
  kind: RouteScopeKind;
  labels: SettingsLabels;
  onAdd(): void;
  onRemove(index: number): void;
  onUpdate(index: number, patch: Partial<RouteScopeValueDto>): void;
  title: string;
  values: RouteScopeValueDto[];
}): ReactElement {
  return (
    <section className="route-scope-value-list" aria-label={title}>
      <div className="panel-heading compact-heading">
        <h4>{title}</h4>
        <button onClick={onAdd} type="button">{addLabel}</button>
      </div>
      <div className="route-scope-rows">
        {values.map((value, index) => (
          <div className="route-scope-row" key={`${kind}-${value.value}-${index}`}>
            <label>
              {labels.routeScopeValue}
              <input disabled={value.builtIn} value={value.value} onChange={(event) => onUpdate(index, { value: event.target.value.toUpperCase() })} />
            </label>
            <label>
              {labels.routeScopeLabel}
              <input value={value.label} onChange={(event) => onUpdate(index, { label: event.target.value })} />
            </label>
            <label>
              {labels.routeScopeDescriptionField}
              <input value={value.description ?? ''} onChange={(event) => onUpdate(index, { description: event.target.value })} />
            </label>
            <label>
              {labels.routeScopeExample}
              <input value={value.example ?? ''} onChange={(event) => onUpdate(index, { example: event.target.value })} />
            </label>
            <label className="route-scope-checkbox">
              <input checked={value.enabled} disabled={value.builtIn} onChange={(event) => onUpdate(index, { enabled: event.target.checked })} type="checkbox" />
              {value.builtIn ? labels.builtIn : labels.routeScopeEnabled}
            </label>
            {value.builtIn ? null : <button onClick={() => onRemove(index)} type="button">{labels.remove}</button>}
          </div>
        ))}
      </div>
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
    sourcePlatform: 'SETTINGS',
    status: null,
    stopId: null,
    timeWindowEnd: null,
    timeWindowStart: null
  }];
}

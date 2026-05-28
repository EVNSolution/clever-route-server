import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getSettings, saveSettings } from '../api';
import { RouteOpsMap } from '../components/maps/RouteOpsMap';
import type { BootstrapPayload, CanonicalOrderDto, StoreSettingsDto } from '../types';
import { emptySettings, readErrorMessage, toNullableNumber } from '../utils/format';

export function SettingsPage({ bootstrap, setError }: { bootstrap: BootstrapPayload; setError(error: string | null): void }): ReactElement {
  const [settings, setSettingsState] = useState<StoreSettingsDto | null>(null);
  useEffect(() => {
    getSettings().then((payload) => setSettingsState(payload.settings)).catch((error: unknown) => setError(readErrorMessage(error)));
  }, [setError]);
  const save = async (): Promise<void> => {
    if (settings === null) return;
    try {
      const payload = await saveSettings({ ...settings, csrfToken: bootstrap.csrfToken });
      setSettingsState(payload.settings);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    }
  };
  const depotOrders = settings === null ? [] : depotAsOrders(settings);
  return (
    <section className="workspace-grid compact">
      <article className="panel"><span className="eyebrow">Settings</span><h2>Store settings</h2><label>Store address<input value={settings?.defaultDepotAddress ?? ''} onChange={(event) => setSettingsState({ ...(settings ?? emptySettings(bootstrap)), defaultDepotAddress: event.target.value })} /></label><div className="form-grid"><label>Latitude<input value={settings?.defaultDepotLatitude?.toString() ?? ''} onChange={(event) => setSettingsState({ ...(settings ?? emptySettings(bootstrap)), defaultDepotLatitude: toNullableNumber(event.target.value) })} /></label><label>Longitude<input value={settings?.defaultDepotLongitude?.toString() ?? ''} onChange={(event) => setSettingsState({ ...(settings ?? emptySettings(bootstrap)), defaultDepotLongitude: toNullableNumber(event.target.value) })} /></label></div><label>Language<select value={settings?.locale ?? 'en-CA'} onChange={(event) => setSettingsState({ ...(settings ?? emptySettings(bootstrap)), locale: event.target.value })}><option value="en-CA">English (Canada)</option><option value="fr-CA">Français (Canada)</option><option value="ko-KR">한국어</option></select></label><button className="primary" onClick={() => void save()} type="button">Save settings</button></article>
      <aside className="side-panel">
        <RouteOpsMap
          bootstrap={bootstrap}
          onMapClickCoordinate={(coordinate) => setSettingsState({ ...(settings ?? emptySettings(bootstrap)), defaultDepotLatitude: coordinate.latitude, defaultDepotLongitude: coordinate.longitude })}
          orders={depotOrders}
          subtitle="Click the configured map to update the depot draft; manual fields remain authoritative."
          title="Depot map"
        />
        <article className="panel"><span className="eyebrow">Providers</span><h2>Map/router status</h2><p>Map provider: <strong>{bootstrap.mapConfig.status}</strong></p><p>Provider mode: <strong>{bootstrap.mapConfig.providerMode ?? 'none'}</strong></p><p>Route geometry provider: <strong>{bootstrap.routerConfig.status}</strong></p><p className="muted">No provider secrets are displayed in the browser. Unconfigured mode never calls public tile/router hosts.</p></article>
      </aside>
    </section>
  );
}

function depotAsOrders(settings: StoreSettingsDto): CanonicalOrderDto[] {
  if (settings.defaultDepotLatitude === null || settings.defaultDepotLongitude === null) return [];
  return [{
    blockerReasons: [],
    coordinates: { latitude: settings.defaultDepotLatitude, longitude: settings.defaultDepotLongitude },
    deliveryArea: null,
    deliveryDate: null,
    deliverySession: null,
    deliveryStatus: 'depot',
    health: 'normal',
    orderId: 'settings-depot',
    orderName: 'Depot',
    phone: null,
    planningStatus: 'UNPLANNED',
    recipientName: settings.defaultDepotAddress ?? 'Default depot',
    routePlanId: null,
    routePlanName: null,
    sourceOrderId: 'settings-depot',
    sourceOrderNumber: null,
    sourcePlatform: 'SETTINGS',
    status: null,
    stopId: null
  }];
}

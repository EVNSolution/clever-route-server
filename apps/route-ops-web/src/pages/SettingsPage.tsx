import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import { geocodeSettings, getSettings, saveSettings } from "../api";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import { resolveLocale, settingsCopy } from "../i18n";
import {
  TEMPLATE_VARIABLES,
  createReminderPlan,
  hasReminderDuplicate,
  insertTemplateToken,
  listUnknownTemplateTokens,
  normalizeRouteOpsUiSettings,
  type TemplateVariableKey,
} from "../settingsUi";
import type {
  BootstrapPayload,
  CanonicalOrderDto,
  RouteOpsUiReminderPlanDto,
  StoreSettingsDto,
} from "../types";
import {
  emptySettings,
  readErrorMessage,
  toNullableNumber,
} from "../utils/format";

export function SettingsPage({
  bootstrap,
  setError,
}: {
  bootstrap: BootstrapPayload;
  setError(error: string | null): void;
}): ReactElement {
  const [settings, setSettingsState] = useState<StoreSettingsDto | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings()
      .then((payload) => setSettingsState(payload.settings))
      .catch((error: unknown) => setError(readErrorMessage(error)));
  }, [setError]);

  const draft = settings ?? emptySettings(bootstrap);
  const normalizedUiSettings = normalizeRouteOpsUiSettings(
    draft.routeOpsUiSettings,
  );
  const locale = resolveLocale(draft.locale);
  const t = settingsCopy[locale];
  const reminderDuplicate = hasReminderDuplicate(
    normalizedUiSettings.emailNotifications.reminderPlans,
  );
  const unknownTokens = [
    ...listUnknownTemplateTokens(
      normalizedUiSettings.emailNotifications.template.subject,
    ),
    ...listUnknownTemplateTokens(
      normalizedUiSettings.emailNotifications.template.body,
    ),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const canSave = !reminderDuplicate && unknownTokens.length === 0;

  const updateDraft = (patch: Partial<StoreSettingsDto>): void => {
    setSettingsState((current) => {
      const base = current ?? draft;
      return {
        ...base,
        ...patch,
        locale: resolveLocale(patch.locale ?? base.locale),
      };
    });
    setNotice(null);
  };

  const updateUiSettings = (
    patch: Partial<StoreSettingsDto["routeOpsUiSettings"]>,
  ): void => {
    updateDraft({
      routeOpsUiSettings: { ...normalizedUiSettings, ...patch, version: 1 },
    });
  };

  const updateEmailSettings = (
    patch: Partial<
      StoreSettingsDto["routeOpsUiSettings"]["emailNotifications"]
    >,
  ): void => {
    updateUiSettings({
      emailNotifications: {
        ...normalizedUiSettings.emailNotifications,
        ...patch,
      },
    });
  };

  const updateTemplate = (
    patch: Partial<
      StoreSettingsDto["routeOpsUiSettings"]["emailNotifications"]["template"]
    >,
  ): void => {
    updateEmailSettings({
      template: {
        ...normalizedUiSettings.emailNotifications.template,
        ...patch,
      },
    });
  };

  const updateReminderPlan = (
    id: string,
    patch: Partial<RouteOpsUiReminderPlanDto>,
  ): void => {
    updateEmailSettings({
      reminderPlans: normalizedUiSettings.emailNotifications.reminderPlans.map(
        (plan) => (plan.id === id ? { ...plan, ...patch } : plan),
      ),
    });
  };

  const save = async (): Promise<void> => {
    if (!canSave) {
      setError(
        reminderDuplicate
          ? t.duplicateReminder
          : t.unknownTemplateTokens(unknownTokens),
      );
      return;
    }
    setSaving(true);
    try {
      const payload = await saveSettings(
        buildSettingsSaveInput({
          csrfToken: bootstrap.csrfToken,
          draft: { ...draft, routeOpsUiSettings: normalizedUiSettings },
        }),
      );
      setSettingsState(payload.settings);
      setNotice(t.saved);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const geocodeDraftAddress = async (): Promise<void> => {
    const defaultDepotAddress = draft.defaultDepotAddress?.trim() ?? "";
    if (defaultDepotAddress === "") return;
    setGeocoding(true);
    try {
      const payload = await geocodeSettings({
        csrfToken: bootstrap.csrfToken,
        defaultDepotAddress,
        locale,
      });
      updateDraft({
        defaultDepotLatitude: payload.geocode.result.latitude,
        defaultDepotLongitude: payload.geocode.result.longitude,
      });
      setNotice(
        t.geocodeDraftUpdated(
          payload.geocode.result.latitude,
          payload.geocode.result.longitude,
        ),
      );
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setGeocoding(false);
    }
  };

  const depotOrders = depotAsOrders(draft, t.depot, t.defaultDepot);
  return (
    <section
      className="workspace-grid compact settings-workspace"
      data-settings-layout="category-sections"
    >
      <article className="panel settings-main-panel">
        <div className="settings-category-stack">
          <SettingsCategorySection
            description={t.storeSettingsDescription}
            eyebrow={t.settingsEyebrow}
            title={t.settingsTitle}
          >
            <div className="settings-field-stack">
              <label className="settings-field settings-field--full">
                {t.storeAddress}
                <input
                  value={draft.defaultDepotAddress ?? ""}
                  onBlur={() => void geocodeDraftAddress()}
                  onChange={(event) =>
                    updateDraft({ defaultDepotAddress: event.target.value })
                  }
                />
              </label>
              <div className="settings-field-grid">
                <label className="settings-field">
                  {t.latitude}
                  <input
                    value={draft.defaultDepotLatitude?.toString() ?? ""}
                    onChange={(event) =>
                      updateDraft({
                        defaultDepotLatitude: toNullableNumber(
                          event.target.value,
                        ),
                      })
                    }
                  />
                </label>
                <label className="settings-field">
                  {t.longitude}
                  <input
                    value={draft.defaultDepotLongitude?.toString() ?? ""}
                    onChange={(event) =>
                      updateDraft({
                        defaultDepotLongitude: toNullableNumber(
                          event.target.value,
                        ),
                      })
                    }
                  />
                </label>
              </div>
              {geocoding ? <p className="muted">{t.geocoding}</p> : null}
            </div>
          </SettingsCategorySection>

          <details className="settings-category settings-disclosure" open>
            <summary>
              <span className="eyebrow">{t.languageEyebrow}</span>
              <strong>{t.languageTitle}</strong>
            </summary>
            <label className="settings-field settings-field--wide">
              {t.language}
              <select
                value={locale}
                onChange={(event) =>
                  updateDraft({ locale: resolveLocale(event.target.value) })
                }
              >
                <option value="en-CA">{t.english}</option>
                <option value="ko-KR">{t.korean}</option>
              </select>
            </label>
          </details>

          <SettingsCategorySection
            description={t.deliveryDefaultsDescription}
            eyebrow={t.deliveryDefaultsEyebrow}
            title={t.deliveryDefaultsTitle}
          >
            <label className="settings-field settings-field--wide">
              {t.destinationDwellMinutes}
              <input
                min={0}
                max={240}
                step={1}
                type="number"
                value={
                  normalizedUiSettings.destinationDwellMinutes?.toString() ?? ""
                }
                onChange={(event) =>
                  updateUiSettings({
                    destinationDwellMinutes: toNullableNumber(
                      event.target.value,
                    ),
                  })
                }
              />
            </label>
          </SettingsCategorySection>

          <SettingsCategorySection
            description={t.emailDescription}
            eyebrow={t.emailEyebrow}
            title={t.emailTitle}
          >
            <div className="settings-field-stack">
              <label className="settings-inline-check">
                <input
                  checked={normalizedUiSettings.emailNotifications.enabled}
                  type="checkbox"
                  onChange={(event) =>
                    updateEmailSettings({ enabled: event.target.checked })
                  }
                />
                <span>{t.emailEnabled}</span>
              </label>
              <div className="settings-subsection">
                <div className="settings-subsection-header">
                  <h3>{t.reminderPlans}</h3>
                  <button
                    type="button"
                    onClick={() =>
                      updateEmailSettings({
                        reminderPlans: [
                          ...normalizedUiSettings.emailNotifications
                            .reminderPlans,
                          createReminderPlan(
                            normalizedUiSettings.emailNotifications
                              .reminderPlans,
                          ),
                        ],
                      })
                    }
                  >
                    {t.addReminder}
                  </button>
                </div>
                <div className="settings-reminder-list">
                  {normalizedUiSettings.emailNotifications.reminderPlans
                    .length === 0 ? (
                    <p className="muted">{t.noReminderPlans}</p>
                  ) : null}
                  {normalizedUiSettings.emailNotifications.reminderPlans.map(
                    (plan) => (
                      <div className="settings-reminder-row" key={plan.id}>
                        <label className="settings-field">
                          {t.daysBefore}
                          <input
                            min={0}
                            max={30}
                            step={1}
                            type="number"
                            value={plan.daysBefore}
                            onChange={(event) =>
                              updateReminderPlan(plan.id, {
                                daysBefore: Number(event.target.value),
                              })
                            }
                          />
                        </label>
                        <label className="settings-field">
                          {t.timeOfDay}
                          <input
                            type="time"
                            value={plan.timeOfDay}
                            onChange={(event) =>
                              updateReminderPlan(plan.id, {
                                timeOfDay: event.target.value,
                              })
                            }
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            updateEmailSettings({
                              reminderPlans:
                                normalizedUiSettings.emailNotifications.reminderPlans.filter(
                                  (item) => item.id !== plan.id,
                                ),
                            })
                          }
                        >
                          {t.remove}
                        </button>
                      </div>
                    ),
                  )}
                </div>
                {reminderDuplicate ? (
                  <p className="error-text">{t.duplicateReminder}</p>
                ) : null}
              </div>
              <div className="settings-subsection">
                <h3>{t.emailTemplate}</h3>
                <label className="settings-field settings-field--wide">
                  {t.templateSubject}
                  <input
                    value={
                      normalizedUiSettings.emailNotifications.template.subject
                    }
                    onChange={(event) =>
                      updateTemplate({ subject: event.target.value })
                    }
                  />
                </label>
                <label className="settings-field settings-field--wide">
                  {t.templateBody}
                  <textarea
                    rows={5}
                    value={
                      normalizedUiSettings.emailNotifications.template.body
                    }
                    onChange={(event) =>
                      updateTemplate({ body: event.target.value })
                    }
                  />
                </label>
                <div
                  className="settings-token-picker"
                  aria-label={t.variablePicker}
                >
                  {TEMPLATE_VARIABLES.map((variable) => (
                    <button
                      key={variable.key}
                      title={variable.example}
                      type="button"
                      onClick={() =>
                        updateTemplate({
                          body: insertTemplateToken(
                            normalizedUiSettings.emailNotifications.template
                              .body,
                            variable.key as TemplateVariableKey,
                          ),
                        })
                      }
                    >
                      {"{{"}
                      {variable.key}
                      {"}}"}
                    </button>
                  ))}
                </div>
                {unknownTokens.length === 0 ? null : (
                  <p className="error-text">
                    {t.unknownTemplateTokens(unknownTokens)}
                  </p>
                )}
              </div>
            </div>
          </SettingsCategorySection>

          <div className="settings-save-row">
            <button
              className="primary"
              disabled={saving || !canSave}
              onClick={() => void save()}
              type="button"
            >
              {saving ? t.saving : t.saveSettings}
            </button>
            {notice === null ? null : <p className="muted">{notice}</p>}
          </div>
        </div>
      </article>
      <aside className="side-panel settings-side-panel">
        <RouteOpsMap
          bootstrap={bootstrap}
          onMapClickCoordinate={(coordinate) =>
            updateDraft({
              defaultDepotLatitude: coordinate.latitude,
              defaultDepotLongitude: coordinate.longitude,
            })
          }
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
  const {
    routeScopeConfig: _routeScopeConfig,
    ...settingsWithoutRouteScopeConfig
  } = input.draft;
  return {
    ...settingsWithoutRouteScopeConfig,
    csrfToken: input.csrfToken,
    locale: resolveLocale(input.draft.locale),
  };
}

function SettingsCategorySection({
  children,
  description,
  eyebrow,
  title,
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
        {description === undefined ? null : (
          <p className="muted">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function depotAsOrders(
  settings: StoreSettingsDto,
  depotName: string,
  fallbackAddress: string,
): CanonicalOrderDto[] {
  if (
    settings.defaultDepotLatitude === null ||
    settings.defaultDepotLongitude === null
  )
    return [];
  return [
    {
      blockerReasons: [],
      coordinates: {
        latitude: settings.defaultDepotLatitude,
        longitude: settings.defaultDepotLongitude,
      },
      deliveryArea: null,
      deliveryDate: null,
      deliverySession: null,
      deliveryStatus: "depot",
      geocodeStatus: "RESOLVED",
      health: "normal",
      orderId: "settings-depot",
      orderName: depotName,
      phone: null,
      planningStatus: "UNPLANNED",
      recipientName: settings.defaultDepotAddress ?? fallbackAddress,
      routeEligible: false,
      routePlanId: null,
      routePlanName: null,
      serviceType: "DELIVERY",
      shippingAddress: {
        address1: null,
        address2: null,
        city: null,
        countryCode: null,
        postalCode: null,
        province: null,
      },
      sourceOrderId: "settings-depot",
      sourceOrderNumber: null,
      sourceCreatedAt: null,
      sourceCreatedDate: null,
      sourcePlatform: "SETTINGS",
      sourceUpdatedAt: null,
      sourceUpdatedDate: null,
      status: null,
      stopId: null,
      timeWindowEnd: null,
      timeWindowStart: null,
    },
  ];
}

function formatProviderStatus(
  status: BootstrapPayload["mapConfig"]["status"],
  labels: SettingsLabels,
): string {
  return status === "configured" ? labels.configured : labels.notConfigured;
}

function formatProviderMode(
  mode: BootstrapPayload["mapConfig"]["providerMode"],
  labels: SettingsLabels,
): string {
  if (mode === "public_allowlisted") return labels.publicAllowlisted;
  if (mode === "self_hosted") return labels.selfHosted;
  return labels.none;
}

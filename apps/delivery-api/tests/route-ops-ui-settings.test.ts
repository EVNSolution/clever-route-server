import { describe, expect, test } from "vitest";

import {
  defaultRouteOpsUiSettings,
  normalizeRouteOpsUiSettings,
  validateRouteOpsUiSettingsPayload,
} from "../src/modules/route-ops/route-ops-ui-settings.js";

describe("route ops UI settings", () => {
  test("defaults nearby stop threshold for existing v1 payloads", () => {
    expect(defaultRouteOpsUiSettings().nearbyStopsThreshold).toBe(3);
    expect(
      normalizeRouteOpsUiSettings({
        destinationDwellMinutes: 7,
        etaDelayMinutes: 12,
        forwardDelayAlerts: false,
        gpsSilenceSeconds: 60,
        loadingStartTime: "08:00",
        plannedDepartureTime: "09:00",
        recordMissingProof: true,
        showTemperatureAlerts: false,
        temperatureLimit: 4,
        version: 1,
      }),
    ).toMatchObject({
      destinationDwellMinutes: 7,
      nearbyStopsThreshold: 3,
      version: 1,
    });
  });

  test("accepts nearby stop threshold only from 1 through 25", () => {
    expect(
      validateRouteOpsUiSettingsPayload({
        ...defaultRouteOpsUiSettings(),
        nearbyStopsThreshold: 25,
      }).nearbyStopsThreshold,
    ).toBe(25);
    expect(() =>
      validateRouteOpsUiSettingsPayload({
        ...defaultRouteOpsUiSettings(),
        nearbyStopsThreshold: 0,
      }),
    ).toThrow(/Nearby stops threshold must be an integer from 1 through 25/u);
    expect(() =>
      validateRouteOpsUiSettingsPayload({
        ...defaultRouteOpsUiSettings(),
        nearbyStopsThreshold: 26,
      }),
    ).toThrow(/Nearby stops threshold must be an integer from 1 through 25/u);
  });
});

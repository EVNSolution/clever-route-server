import { describe, expect, test, vi } from 'vitest';

import { createPinnedLookup, UvisClient } from '../src/modules/uvis/uvis-client.js';
import { loadUvisClientConfig, loadUvisRuntimeConfig } from '../src/modules/uvis/uvis-config.js';
import {
  parseUvisLocationResponse,
  parseUvisAccessKeyResponse,
  parseUvisTemperatureResponse,
  UvisClientError,
} from '../src/modules/uvis/uvis-contract.js';

const config = {
  accessKeyUrl: 'https://uvis.test/access-key',
  allowedOutboundUrls: [
    { host: 'uvis.test', pathname: '/access-key', protocol: 'https:' },
    { host: 'uvis.test', pathname: '/telematics', protocol: 'https:' },
  ],
  companySerialKey: 'fake-company-serial-key',
  locationGubun: 'LOC_KIND',
  telemetryUrl: 'https://uvis.test/telematics',
  temperatureGubun: 'TEMP_KIND',
  timeoutMs: 1000,
};
const publicResolver = () => Promise.resolve(['8.8.8.8']);

describe('UVIS client', () => {
  test('loads the simplified explicit env contract and treats all blank UVIS env as disabled', () => {
    expect(loadUvisClientConfig({})).toBeNull();
    expect(loadUvisClientConfig({
      UVIS_ACCESS_KEY_URL: 'https://uvis.test/access-key',
      UVIS_ALLOWED_OUTBOUND_URLS: 'https://uvis.test/access-key, https://uvis.test/telematics',
      UVIS_COMPANY_SERIAL_KEY: 'fake-company-serial-key',
      UVIS_LOCATION_GUBUN: 'LOC_KIND',
      UVIS_TELEMETRY_URL: 'https://uvis.test/telematics',
      UVIS_TEMPERATURE_GUBUN: 'TEMP_KIND',
      UVIS_TIMEOUT_MS: '1000',
    })).toEqual(config);
    expect(() => loadUvisClientConfig({ UVIS_ACCESS_KEY_URL: 'https://uvis.test/access-key' })).toThrow(
      'UVIS_ALLOWED_OUTBOUND_URLS must be configured for UVIS integration.'
    );
  });

  test('keeps the polling runtime disabled by default and requires explicit tenant settings when enabled', () => {
    expect(loadUvisRuntimeConfig({})).toBeNull();
    expect(loadUvisRuntimeConfig({ UVIS_ENABLED: 'false', UVIS_ACCESS_KEY_URL: 'https://unused.test' })).toBeNull();
    expect(loadUvisRuntimeConfig({
      UVIS_ACCESS_KEY_URL: 'https://uvis.test/access-key',
      UVIS_ALLOWED_OUTBOUND_URLS: 'https://uvis.test/access-key,https://uvis.test/telematics',
      UVIS_APP_ID: 'clever',
      UVIS_COMPANY_SERIAL_KEY: 'fake-company-serial-key',
      UVIS_ENABLED: 'true',
      UVIS_LOCATION_GUBUN: 'LOC_KIND',
      UVIS_LOCATION_POLL_INTERVAL_MS: '60000',
      UVIS_SHOP_DOMAIN: 'dsv-demo.local',
      UVIS_TELEMETRY_URL: 'https://uvis.test/telematics',
      UVIS_TEMPERATURE_GUBUN: 'TEMP_KIND',
      UVIS_TEMPERATURE_POLL_INTERVAL_MS: '300000',
    })).toMatchObject({
      appId: 'clever',
      locationPollIntervalMs: 60000,
      shopDomain: 'dsv-demo.local',
      temperaturePollIntervalMs: 300000,
    });
    expect(() => loadUvisRuntimeConfig({ UVIS_ENABLED: 'true' })).toThrow('UVIS client settings must be configured');
    expect(() => loadUvisRuntimeConfig({ UVIS_ENABLED: 'sometimes' })).toThrow('UVIS_ENABLED must be true or false');
  });

  test('fails closed on unsafe UVIS endpoints, invalid timeouts, and too-fast poll intervals', () => {
    expect(() => new UvisClient({
      ...config,
      accessKeyUrl: 'https://uvis.test/other-path',
    })).toThrow('UVIS_ACCESS_KEY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => new UvisClient({
      ...config,
      accessKeyUrl: 'https://user:pass@uvis.test/access-key',
    })).toThrow('UVIS_ACCESS_KEY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => new UvisClient({
      ...config,
      telemetryUrl: 'https://uvis.test/telematics#fragment',
    })).toThrow('UVIS_TELEMETRY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => new UvisClient({
      ...config,
      allowedOutboundUrls: [{ host: '169.254.169.254', pathname: '/access-key', protocol: 'https:' }],
      accessKeyUrl: 'https://169.254.169.254/access-key',
    })).toThrow('UVIS_ACCESS_KEY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => new UvisClient({
      ...config,
      allowedOutboundUrls: [{ host: '[::1]', pathname: '/access-key', protocol: 'https:' }],
      accessKeyUrl: 'https://[::1]/access-key',
    })).toThrow('UVIS_ACCESS_KEY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => new UvisClient({
      ...config,
      allowedOutboundUrls: [{ host: '[2001:db8::1]', pathname: '/access-key', protocol: 'https:' }],
      accessKeyUrl: 'https://[2001:db8::1]/access-key',
    })).toThrow('UVIS_ACCESS_KEY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => new UvisClient({
      ...config,
      allowedOutboundUrls: [{ host: '[::ffff:c000:0201]', pathname: '/access-key', protocol: 'https:' }],
      accessKeyUrl: 'https://[::ffff:c000:0201]/access-key',
    })).toThrow('UVIS_ACCESS_KEY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => new UvisClient({
      ...config,
      allowedOutboundUrls: [{ host: '[ff02::1]', pathname: '/access-key', protocol: 'https:' }],
      accessKeyUrl: 'https://[ff02::1]/access-key',
    })).toThrow('UVIS_ACCESS_KEY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => new UvisClient({
      ...config,
      allowedOutboundUrls: [{ host: '[3000::1]', pathname: '/access-key', protocol: 'https:' }],
      accessKeyUrl: 'https://[3000::1]/access-key',
    })).toThrow('UVIS_ACCESS_KEY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => new UvisClient({
      ...config,
      allowedOutboundUrls: [{ host: '[2001:10::1]', pathname: '/access-key', protocol: 'https:' }],
      accessKeyUrl: 'https://[2001:10::1]/access-key',
    })).toThrow('UVIS_ACCESS_KEY_URL is not an allowed UVIS outbound endpoint.');
    expect(() => loadUvisClientConfig({
      UVIS_ACCESS_KEY_URL: 'https://uvis.test/access-key',
      UVIS_ALLOWED_OUTBOUND_URLS: 'https://uvis.test/access-key,https://uvis.test/telematics',
      UVIS_COMPANY_SERIAL_KEY: 'fake-company-serial-key',
      UVIS_LOCATION_GUBUN: 'LOC_KIND',
      UVIS_TELEMETRY_URL: 'https://uvis.test/telematics',
      UVIS_TEMPERATURE_GUBUN: 'TEMP_KIND',
      UVIS_TIMEOUT_MS: '30001',
    })).toThrow('UVIS_TIMEOUT_MS must be an integer between 1000 and 30000.');
    expect(() => loadUvisRuntimeConfig({
      UVIS_ACCESS_KEY_URL: 'https://uvis.test/access-key',
      UVIS_ALLOWED_OUTBOUND_URLS: 'https://uvis.test/access-key,https://uvis.test/telematics',
      UVIS_COMPANY_SERIAL_KEY: 'fake-company-serial-key',
      UVIS_ENABLED: 'true',
      UVIS_LOCATION_GUBUN: 'LOC_KIND',
      UVIS_LOCATION_POLL_INTERVAL_MS: '59999',
      UVIS_SHOP_DOMAIN: 'dsv-demo.local',
      UVIS_TELEMETRY_URL: 'https://uvis.test/telematics',
      UVIS_TEMPERATURE_GUBUN: 'TEMP_KIND',
    })).toThrow('UVIS_LOCATION_POLL_INTERVAL_MS must be an integer between 60000');
    expect(() => loadUvisRuntimeConfig({
      UVIS_ACCESS_KEY_URL: 'https://uvis.test/access-key',
      UVIS_ALLOWED_OUTBOUND_URLS: 'https://uvis.test/access-key,https://uvis.test/telematics',
      UVIS_COMPANY_SERIAL_KEY: 'fake-company-serial-key',
      UVIS_ENABLED: 'true',
      UVIS_LOCATION_GUBUN: 'LOC_KIND',
      UVIS_SHOP_DOMAIN: 'dsv-demo.local',
      UVIS_TELEMETRY_URL: 'https://uvis.test/telematics',
      UVIS_TEMPERATURE_GUBUN: 'TEMP_KIND',
      UVIS_TEMPERATURE_POLL_INTERVAL_MS: '299999',
    })).toThrow('UVIS_TEMPERATURE_POLL_INTERVAL_MS must be an integer between 300000');
    expect(() => loadUvisRuntimeConfig({
      UVIS_ACCESS_KEY_URL: 'https://uvis.test/access-key',
      UVIS_ALLOWED_OUTBOUND_URLS: 'https://uvis.test/access-key,https://uvis.test/telematics',
      UVIS_COMPANY_SERIAL_KEY: 'fake-company-serial-key',
      UVIS_ENABLED: 'true',
      UVIS_LOCATION_DORMANT_GRACE_PERIOD_MS: '59999',
      UVIS_LOCATION_GUBUN: 'LOC_KIND',
      UVIS_SHOP_DOMAIN: 'dsv-demo.local',
      UVIS_TELEMETRY_URL: 'https://uvis.test/telematics',
      UVIS_TEMPERATURE_GUBUN: 'TEMP_KIND',
    })).toThrow('UVIS_LOCATION_DORMANT_GRACE_PERIOD_MS must be an integer between 60000');
    expect(loadUvisRuntimeConfig({
      UVIS_ACCESS_KEY_URL: 'https://uvis.test/access-key',
      UVIS_ALLOWED_OUTBOUND_URLS: 'https://uvis.test/access-key,https://uvis.test/telematics',
      UVIS_COMPANY_SERIAL_KEY: 'fake-company-serial-key',
      UVIS_ENABLED: 'true',
      UVIS_LOCATION_GUBUN: 'LOC_KIND',
      UVIS_SHOP_DOMAIN: 'dsv-demo.local',
      UVIS_TELEMETRY_URL: 'https://uvis.test/telematics',
      UVIS_TEMPERATURE_GUBUN: 'TEMP_KIND',
    })).toMatchObject({
      locationDormantGracePeriodMs: 600_000,
      locationDormantHeartbeatIntervalMs: 300_000,
    });
  });

  test('rejects DNS results that resolve allowed hostnames to private or reserved addresses', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ AccessKey: 'unused' }));
    const privateDnsClient = new UvisClient({
      ...config,
      fetchImpl: fetch,
      resolveHostAddresses: () => Promise.resolve(['10.0.0.5']),
    });

    await expect(privateDnsClient.getAccessKey()).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'UVIS access-key request target is not allowed.',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects malformed DNS results instead of passing them to the pinned transport', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ AccessKey: 'unused' }));
    const client = new UvisClient({
      ...config,
      fetchImpl: fetch,
      resolveHostAddresses: () => Promise.resolve(['not-an-ip-address']),
    });

    await expect(client.getAccessKey()).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'UVIS access-key request target is not allowed.',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects DNS results that resolve allowed hostnames to unsafe IPv6 ranges', async () => {
    for (const address of ['::', '::1', '::ffff:192.0.2.1', 'ff02::1', 'fe80::1', 'fc00::1', '2001:db8::1', '2001:2::1', '2001:10::1', '3000::1', '3fff::1']) {
      const fetch = vi.fn().mockResolvedValue(jsonResponse({ AccessKey: 'unused' }));
      const client = new UvisClient({
        ...config,
        fetchImpl: fetch,
        resolveHostAddresses: () => Promise.resolve([address]),
      });

      await expect(client.getAccessKey()).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
        message: 'UVIS access-key request target is not allowed.',
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  test('pins each request to the public addresses that passed DNS validation', async () => {
    const addresses = ['8.8.8.8', '1.1.1.1'];
    const pinnedFetch = vi.fn().mockResolvedValue(jsonResponse({ AccessKey: 'fake-access-key' }));
    const client = new UvisClient({
      ...config,
      fetchImpl: pinnedFetch,
      resolveHostAddresses: () => Promise.resolve(addresses),
    });

    await expect(client.getAccessKey()).resolves.toBe('fake-access-key');
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
    expect(pinnedFetch.mock.calls[0]?.[2]).toEqual(addresses);
  });

  test('returns the callback shape requested by Node 22 pinned HTTPS lookups', () => {
    const lookup = createPinnedLookup('8.8.8.8');
    const allCallback = vi.fn();
    const singleCallback = vi.fn();

    lookup('uvis.test', { all: true }, allCallback);
    lookup('uvis.test', { all: false }, singleCallback);

    expect(allCallback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(singleCallback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });

  test('requests UVIS with manual redirects and rejects 3xx responses without following them', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, {
      headers: { Location: 'https://uvis.test/telematics' },
      status: 302,
    }));
    const client = new UvisClient({ ...config, fetchImpl: fetch, resolveHostAddresses: publicResolver });

    await expect(client.getAccessKey()).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      message: 'UVIS access-key request failed with HTTP 302.',
      status: 302,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'manual' });
  });

  test('issues one shared access key request for concurrent company-wide telemetry arrays', async () => {
    let resolveAccessKey: (response: Response) => void = () => undefined;
    const accessKeyResponse = new Promise<Response>((resolve) => {
      resolveAccessKey = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(accessKeyResponse)
      .mockResolvedValueOnce(jsonResponse({ Data: [locationRow()] }))
      .mockResolvedValueOnce(jsonResponse({ Result: [temperatureRow()] }));
    const client = new UvisClient({ ...config, fetchImpl: fetch, resolveHostAddresses: publicResolver });

    const locationsPromise = client.getLatestLocations();
    const temperaturesPromise = client.getLatestTemperatures();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    resolveAccessKey(jsonResponse({ AccessKey: 'fake-access-key' }));

    await expect(locationsPromise).resolves.toEqual([{
      dayDistanceKm: 82.4,
      deviceId: 'TID-001',
      gpsSpeedKph: 42.1,
      ignitionOn: true,
      latitude: 37.4923433,
      longitude: 127.04661,
      plateNumber: '21사6101',
      recordedAt: new Date('2026-08-04T12:30:15+09:00'),
    }]);
    await expect(temperaturesPromise).resolves.toEqual([{
      deviceId: 'TID-001',
      latitude: 37.4923,
      longitude: 127.0466,
      plateNumber: '21사6101',
      recordedAt: new Date('2026-08-04T12:31:10+09:00'),
      temperatureA: -18.5,
      temperatureB: 4,
    }]);
    expect(fetch).toHaveBeenCalledTimes(3);

    const accessUrl = fetch.mock.calls[0]?.[0] as URL;
    const locationUrl = fetch.mock.calls[1]?.[0] as URL;
    const temperatureUrl = fetch.mock.calls[2]?.[0] as URL;
    expect(accessUrl.origin + accessUrl.pathname).toBe('https://uvis.test/access-key');
    expect(Object.fromEntries(accessUrl.searchParams)).toEqual({
      SerialKey: 'fake-company-serial-key',
    });
    expect(Object.fromEntries(locationUrl.searchParams)).toEqual({
      AccessKey: 'fake-access-key',
      GUBUN: 'LOC_KIND',
    });
    expect(Object.fromEntries(temperatureUrl.searchParams)).toEqual({
      AccessKey: 'fake-access-key',
      GUBUN: 'TEMP_KIND',
    });
    for (const call of fetch.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: 'manual' });
    }
  });

  test('refreshes access keys before expiry and once after telemetry auth failure', async () => {
    let now = 1_000;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessKey: 'fake-access-key-1' }))
      .mockResolvedValueOnce(jsonResponse([locationRow({ TID_ID: 'TID-001' })]))
      .mockResolvedValueOnce(jsonResponse({ ACCESS_KEY: 'fake-access-key-2' }))
      .mockResolvedValueOnce(jsonResponse([locationRow({ TID_ID: 'TID-002' })]))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ AccessKey: 'fake-access-key-3' }))
      .mockResolvedValueOnce(jsonResponse([locationRow({ TID_ID: 'TID-003' })]));
    const client = new UvisClient({ ...config, fetchImpl: fetch, now: () => now, resolveHostAddresses: publicResolver });

    await expect(client.getLatestLocations()).resolves.toMatchObject([{ deviceId: 'TID-001' }]);
    now += (5 * 60 * 1000) - 29_000;
    await expect(client.getLatestLocations()).resolves.toMatchObject([{ deviceId: 'TID-002' }]);
    await expect(client.getLatestLocations()).resolves.toMatchObject([{ deviceId: 'TID-003' }]);

    const urls = fetch.mock.calls.map((call) => call[0] as URL);
    expect(urls.filter((url) => url.pathname === '/access-key')).toHaveLength(3);
    expect(urls.at(-1)?.searchParams.get('AccessKey')).toBe('fake-access-key-3');
  });

  test('retries limited 429/5xx failures with jitter and never exposes full query strings in errors', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ AccessKey: 'fake-access-key-after-retry' }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse([temperatureRow()]));
    const client = new UvisClient({
      ...config,
      fetchImpl: fetch,
      random: () => 0.5,
      resolveHostAddresses: publicResolver,
      sleep,
    });

    await expect(client.getLatestTemperatures()).resolves.toMatchObject([{ temperatureA: -18.5 }]);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledWith(125);
    expect(sleep).toHaveBeenCalledWith(225);

    const failingFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ AccessKey: 'fake-visible-access-key' }))
      .mockResolvedValue(new Response(null, { status: 400 }));
    const failingClient = new UvisClient({ ...config, fetchImpl: failingFetch, resolveHostAddresses: publicResolver });
    await expect(failingClient.getLatestLocations()).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      message: 'UVIS location request failed with HTTP 400.',
      status: 400,
    });
    try {
      await failingClient.getLatestLocations();
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain('fake-company-serial-key');
      expect(serialized).not.toContain('fake-visible-access-key');
      expect(serialized).not.toContain('?');
    }
  });

  test('parses only UVIS allowlisted fields and validates coordinates, datetime, and signed temperatures', () => {
    expect(parseUvisAccessKeyResponse([{ AccessKey: 'fake-array-access-key' }])).toBe('fake-array-access-key');
    expect(parseUvisLocationResponse({
      Data: [locationRow({ BI_DATE: '20260804', BI_TIME: '091500' })],
    })).toEqual([{
      dayDistanceKm: 82.4,
      deviceId: 'TID-001',
      gpsSpeedKph: 42.1,
      ignitionOn: true,
      latitude: 37.4923433,
      longitude: 127.04661,
      plateNumber: '21사6101',
      recordedAt: new Date('2026-08-04T09:15:00+09:00'),
    }]);
    expect(parseUvisTemperatureResponse({
      Result: [temperatureRow({ TPL_SIGNAL_A: '-', TPL_DEGREE_A: '0.5', TPL_SIGNAL_B: '+', TPL_DEGREE_B: '4.0' })],
    })).toMatchObject([{ temperatureA: -0.5, temperatureB: 4 }]);
    expect(() => parseUvisLocationResponse({
      Data: [locationRow({ BI_X_POSITION: '91' })],
    })).toThrow(UvisClientError);
    expect(() => parseUvisTemperatureResponse({
      Result: [temperatureRow({ TPL_DATE: '2026-08-04' })],
    })).toThrow(UvisClientError);
    expect(() => parseUvisTemperatureResponse({
      Result: [temperatureRow({ TPL_DATE: '20260231' })],
    })).toThrow(UvisClientError);
    expect(() => parseUvisTemperatureResponse({
      Result: [temperatureRow({ TPL_SIGNAL_A: 'BAD', TPL_DEGREE_A: '4.5' })],
    })).toThrow(UvisClientError);
    expect(() => parseUvisLocationResponse({
      Data: [{ latitude: '37.1', longitude: '127.1', recordedAt: '2026-08-04 10:00:00' }],
    })).toThrow(UvisClientError);
  });
});

function locationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BI_DATE: '20260804',
    BI_DAY_DISTANCE: '82.40',
    BI_GPS_SPEED: '42.10',
    BI_TIME: '123015',
    BI_TURN_ONOFF: 'ON',
    BI_X_POSITION: '37.4923433',
    BI_Y_POSITION: '127.0466100',
    CM_NUMBER: '21사6101',
    TID_ID: 'TID-001',
    ...overrides,
  };
}

function temperatureRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    CM_NUMBER: '21사6101',
    TID_ID: 'TID-001',
    TPL_DATE: '20260804',
    TPL_DEGREE_A: '18.5',
    TPL_DEGREE_B: '4.0',
    TPL_SIGNAL_A: '-',
    TPL_SIGNAL_B: '+',
    TPL_TIME: '123110',
    TPL_X_POSITION: '37.4923000',
    TPL_Y_POSITION: '127.0466000',
    ...overrides,
  };
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return Response.json(payload, init);
}

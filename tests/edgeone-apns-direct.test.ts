import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@rstest/core';
import { API } from '../src/core/api';
import { push } from '../src/core/apns';
import {
  APNS_DIRECT_HTTP_VERSION,
  APNS_PROBE_DEVICE_TOKEN,
  buildDirectApnsRequest,
  executeDirectApnsRequest,
  sanitizeTransportDetail,
} from '../src/core/apns-direct';
import type { BasicEnv, DBAdapter } from '../src/core/type';
import {
  handleApnsTransportDiag,
  isApnsTransportDiagPath,
} from '../src/entry/edgeone-diag';
import {
  edgeFunctionRelativePath,
  normalizeUrlPrefix,
} from '../src/entry/edgeone-layout';

const DEVICE_TOKEN = 'abc123device';
const PROVIDER_TOKEN = 'fixture-provider-token';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const textResponse = (status: number, body: string) =>
  new Response(body, { status });

function createDb(overrides: Partial<DBAdapter> = {}): DBAdapter {
  return {
    countAll: async () => 0,
    deviceTokenByKey: async () => 'stored-device-token',
    saveDeviceTokenByKey: async () => undefined,
    deleteDeviceByKey: async () => undefined,
    saveAuthorizationToken: async () => undefined,
    getAuthorizationToken: async () => PROVIDER_TOKEN,
    ...overrides,
  };
}

test('direct APNs request uses HTTP/2.0, TLS fetch options, and auth headers', () => {
  const { url, init } = buildDirectApnsRequest(
    'api.push.apple.com',
    DEVICE_TOKEN,
    {
      authorization: `bearer ${PROVIDER_TOKEN}`,
      'apns-topic': 'me.fin.bark',
      'apns-push-type': 'alert',
      'content-type': 'application/json',
    },
    { aps: { alert: { body: 'fixture-body' } } },
  );

  expect(url).toBe(`https://api.push.apple.com/3/device/${DEVICE_TOKEN}`);
  expect(init.method).toBe('POST');
  expect(init.version).toBe(APNS_DIRECT_HTTP_VERSION);
  expect(init.version).toBe('HTTP/2.0');
  expect(init.redirect).toBe('manual');
  expect(init.headers.authorization).toBe(`bearer ${PROVIDER_TOKEN}`);
  expect(init.headers['apns-topic']).toBe('me.fin.bark');
  expect(init.headers['apns-push-type']).toBe('alert');
  expect(init.headers['content-type']).toBe('application/json');
  expect(init.headers['x-token']).toBeUndefined();
  expect('tls' in init.eo).toBe(false);
  expect(init.eo.timeoutSetting).toEqual({
    connectTimeout: 10000,
    readTimeout: 20000,
    writeTimeout: 20000,
  });
  expect(JSON.parse(init.body)).toEqual({
    aps: { alert: { body: 'fixture-body' } },
  });
  expect(url).not.toContain('api.day.app');
  expect(url).not.toContain('apns-proxy');
  expect(url).not.toContain('bark-node');
});

test('direct APNs request keeps an explicit APNs port on the hostname', () => {
  const { url } = buildDirectApnsRequest(
    'api.push.apple.com:2197',
    DEVICE_TOKEN,
    {},
    {},
  );

  expect(url).toBe(`https://api.push.apple.com:2197/3/device/${DEVICE_TOKEN}`);
});

test('direct APNs request refuses relay hosts and proxy paths', () => {
  expect(() =>
    buildDirectApnsRequest('api.day.app', DEVICE_TOKEN, {}, {}),
  ).toThrow(/relay/i);
  expect(() =>
    buildDirectApnsRequest(
      'api.push.apple.com',
      `../apns-proxy/${DEVICE_TOKEN}`,
      {},
      {},
    ),
  ).toThrow(/proxy/i);
  expect(() =>
    buildDirectApnsRequest('https://api.push.apple.com', DEVICE_TOKEN, {}, {}),
  ).toThrow(/hostname/i);
});

test('direct APNs request passes through APNs error reasons', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    expect(String(input)).toBe(
      `https://api.push.apple.com/3/device/${DEVICE_TOKEN}`,
    );
    expect(init).toMatchObject({
      method: 'POST',
      version: 'HTTP/2.0',
    });
    return jsonResponse(400, { reason: 'BadDeviceToken' });
  };

  const result = await executeDirectApnsRequest(
    'api.push.apple.com',
    DEVICE_TOKEN,
    { authorization: `bearer ${PROVIDER_TOKEN}` },
    { aps: { alert: { body: 'fixture-body' } } },
    fetchImpl,
  );

  expect(result).toEqual({ status: 400, message: 'BadDeviceToken' });
});

test('direct APNs request keeps a non-JSON error body', async () => {
  const fetchImpl: typeof fetch = async () =>
    textResponse(500, 'connection reset by peer');

  const result = await executeDirectApnsRequest(
    'api.push.apple.com',
    DEVICE_TOKEN,
    {},
    {},
    fetchImpl,
  );

  expect(result).toEqual({
    status: 500,
    message: 'connection reset by peer',
  });
});

test('push sends the direct request and does not call a relay', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return jsonResponse(403, { reason: 'ExpiredProviderToken' });
  };

  const result = await push(
    {
      db: createDb(),
      allowNewDevice: true,
      allowQueryNums: false,
      maxBatchPushCount: 0,
      requestAPNs: (deviceToken, headers, aps) =>
        executeDirectApnsRequest(
          'api.push.apple.com',
          deviceToken,
          headers,
          aps,
          fetchImpl,
        ),
    },
    'stored-device-token',
    { 'apns-push-type': 'alert' },
    { aps: { alert: { body: 'fixture-body' } } },
  );

  expect(result).toEqual({
    status: 403,
    message: 'ExpiredProviderToken',
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(
    'https://api.push.apple.com/3/device/stored-device-token',
  );
  expect(calls[0]?.url).not.toContain('/apns-proxy');
  expect(calls[0]?.url).not.toContain('/bark-node');
  expect(calls[0]?.url).not.toContain('api.day.app');
  const headers = new Headers(calls[0]?.init.headers);
  expect(headers.get('authorization')).toBe(`bearer ${PROVIDER_TOKEN}`);
  expect(headers.get('apns-topic')).toBe('me.fin.bark');
  expect(headers.get('content-type')).toBe('application/json');
  expect(headers.get('x-token')).toBeNull();
  expect(calls[0]?.init).toMatchObject({ version: 'HTTP/2.0' });
});

test('API surfaces the APNs reason from the direct request', async () => {
  let removed = false;
  const api = new API({
    db: createDb({
      deviceTokenByKey: async () => DEVICE_TOKEN,
      deleteDeviceByKey: async () => {
        removed = true;
      },
    }),
    allowNewDevice: true,
    allowQueryNums: false,
    maxBatchPushCount: 0,
    requestAPNs: (deviceToken, headers, aps) =>
      executeDirectApnsRequest(
        'api.push.apple.com',
        deviceToken,
        headers,
        aps,
        async () => jsonResponse(400, { reason: 'BadDeviceToken' }),
      ),
  });

  await expect(
    api.push({ device_key: 'device-key-fixture', body: 'fixture-body' }),
  ).rejects.toMatchObject({
    code: 400,
    message: 'push failed: BadDeviceToken',
  });
  expect(removed).toBe(true);
});

test('expired provider token retry surfaces the second APNs result', async () => {
  let attempts = 0;
  let removed = false;
  const api = new API({
    db: createDb({
      deviceTokenByKey: async () => DEVICE_TOKEN,
      deleteDeviceByKey: async () => {
        removed = true;
      },
    }),
    allowNewDevice: true,
    allowQueryNums: false,
    maxBatchPushCount: 0,
    requestAPNs: async () => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 403, message: 'ExpiredProviderToken' };
      }
      return { status: 400, message: 'BadDeviceToken' };
    },
  });

  await expect(
    api.push({ device_key: 'device-key-fixture', body: 'fixture-body' }),
  ).rejects.toMatchObject({
    code: 400,
    message: 'push failed: BadDeviceToken',
  });
  expect(attempts).toBe(2);
  expect(removed).toBe(true);
});

test('transport detail redacts tokens', () => {
  const detail = sanitizeTransportDetail(
    `fetch https://api.push.apple.com/3/device/${APNS_PROBE_DEVICE_TOKEN} bearer ${PROVIDER_TOKEN}.a.b failed`,
    [APNS_PROBE_DEVICE_TOKEN, PROVIDER_TOKEN],
  );

  expect(detail).not.toContain(APNS_PROBE_DEVICE_TOKEN);
  expect(detail).not.toContain(PROVIDER_TOKEN);
  expect(detail).not.toContain('bearer');
});

test('diagnostic does not contact APNs until the probe is enabled', async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return jsonResponse(403, { reason: 'MissingProviderToken' });
  };

  const response = await handleApnsTransportDiag(
    {},
    new Request('https://example.com/_diag/apns-transport'),
    fetchImpl,
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(called).toBe(false);
  expect(body).toMatchObject({
    experimental: true,
    mode: 'edgeone-direct',
    relay: false,
    requestedHttpVersion: 'HTTP/2.0',
    probe: 'disabled',
    deliveryVerified: false,
  });
  expect(JSON.stringify(body)).not.toContain(APNS_PROBE_DEVICE_TOKEN);
  expect(JSON.stringify(body)).not.toContain('bearer');
});

test('enabled probe calls APNs directly without a provider token or relay', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return jsonResponse(403, { reason: 'MissingProviderToken' });
  };
  const env: BasicEnv = { APNS_TRANSPORT_PROBE: 'true' };

  const idle = await handleApnsTransportDiag(
    env,
    new Request('https://example.com/_diag/apns-transport'),
    fetchImpl,
  );
  expect(idle.status).toBe(200);
  expect(calls).toHaveLength(0);
  expect(await idle.json()).toMatchObject({ probe: 'disabled', relay: false });

  const response = await handleApnsTransportDiag(
    env,
    new Request('https://example.com/_diag/apns-transport', { method: 'POST' }),
    fetchImpl,
  );
  const body = await response.json();
  const serialized = JSON.stringify(body);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(
    `https://api.push.apple.com/3/device/${APNS_PROBE_DEVICE_TOKEN}`,
  );
  expect(calls[0]?.url).not.toContain('api.day.app');
  expect(calls[0]?.url).not.toContain('apns-proxy');
  const headers = new Headers(calls[0]?.init.headers);
  expect(headers.get('authorization')).toBeNull();
  expect(headers.get('apns-topic')).toBe('me.fin.bark');
  expect(calls[0]?.init).toMatchObject({
    method: 'POST',
    version: 'HTTP/2.0',
    redirect: 'manual',
  });
  expect(body).toMatchObject({
    experimental: true,
    relay: false,
    probe: 'performed',
    deliveryVerified: false,
    authenticated: false,
    transport: 'apns-response',
    httpStatus: 403,
    apnsReason: 'MissingProviderToken',
  });
  expect(serialized).not.toContain(APNS_PROBE_DEVICE_TOKEN);
  expect(serialized).not.toContain('bearer');
});

test('enabled probe reports a network error without calling a relay', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error(
      `net_exception protocol error while connecting to /3/device/${APNS_PROBE_DEVICE_TOKEN}`,
    );
  };

  const response = await handleApnsTransportDiag(
    { APNS_TRANSPORT_PROBE: 'true', APNS_URL: 'api.push.apple.com' },
    new Request('https://example.com/_diag/apns-transport', { method: 'POST' }),
    fetchImpl,
  );
  const body = await response.json();

  expect(body).toMatchObject({
    probe: 'performed',
    relay: false,
    deliveryVerified: false,
    transport: 'network-error',
  });
  expect(JSON.stringify(body)).not.toContain(APNS_PROBE_DEVICE_TOKEN);
  expect(String(body.detail)).toContain('protocol error');
});

test('enabled probe keeps basic auth in front of the APNs call', async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return jsonResponse(403, { reason: 'MissingProviderToken' });
  };
  const env: BasicEnv = {
    APNS_TRANSPORT_PROBE: 'true',
    BASIC_AUTH: 'diag-user:diag-pass',
  };

  const denied = await handleApnsTransportDiag(
    env,
    new Request('https://example.com/_diag/apns-transport', { method: 'POST' }),
    fetchImpl,
  );
  expect(denied.status).toBe(401);
  expect(called).toBe(false);

  const allowed = await handleApnsTransportDiag(
    env,
    new Request('https://example.com/_diag/apns-transport', {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa('diag-user:diag-pass')}`,
      },
    }),
    fetchImpl,
  );
  expect(allowed.status).toBe(200);
  expect(called).toBe(true);
});

test('EdgeOne layout no longer emits a node proxy and allows the site root', () => {
  expect(normalizeUrlPrefix(undefined)).toBe('/');
  expect(normalizeUrlPrefix('/')).toBe('/');
  expect(edgeFunctionRelativePath(undefined)).toBe(
    'edge-functions/[[default]].js',
  );
  expect(edgeFunctionRelativePath('/bark')).toBe(
    'edge-functions/bark/[[default]].js',
  );
  expect(edgeFunctionRelativePath('/bark')).not.toContain('node-functions');
  expect(() => normalizeUrlPrefix('/../etc')).toThrow(/invalid/i);
  expect(() => normalizeUrlPrefix('bark')).toThrow(/start/i);
});

test('diagnostic path follows URL_PREFIX and stays off the push routes', () => {
  expect(isApnsTransportDiagPath('/_diag/apns-transport', undefined)).toBe(
    true,
  );
  expect(isApnsTransportDiagPath('/bark/_diag/apns-transport', '/bark')).toBe(
    true,
  );
  expect(isApnsTransportDiagPath('/_diag/apns-transport', '/bark')).toBe(false);
  expect(isApnsTransportDiagPath('/info', '/')).toBe(false);
});

test('EdgeOne entry and build no longer reference the node proxy', () => {
  const entry = readFileSync(
    path.join(process.cwd(), 'src/entry/edgeone.ts'),
    'utf8',
  );
  const build = readFileSync(
    path.join(process.cwd(), 'rsbuild.config.ts'),
    'utf8',
  );
  const combined = `${entry}\n${build}`;

  expect(combined).not.toContain('apns-proxy');
  expect(combined).not.toContain('bark-node');
  expect(combined).not.toContain('PROXY_TOKEN');
  expect(combined).not.toContain('api.day.app');
  expect(combined).not.toContain('node-functions');
  expect(entry).toContain('executeDirectApnsRequest');
  expect(entry).toContain('isApnsTransportDiagPath');
});

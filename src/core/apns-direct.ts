import type { APNsResponse } from './type';

/**
 * Experimental direct APNs request for the EdgeOne edge runtime.
 *
 * APNs requires HTTP/2 and TLS 1.2 or later on port 443 (2197 is optional):
 * https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
 *
 * EdgeOne documents `RequestInit.version` as `HTTP/1.0`, `HTTP/1.1`, or
 * `HTTP/2.0`, defaulting to HTTP/1.1, for a Request used with fetch:
 * https://cloud.tencent.com/document/product/1552/81902
 * The international copy of that page was marked updated on 2026-11-04 and
 * AI-reviewed. Listing the option does not prove the edge runtime negotiates
 * outbound HTTP/2 to an arbitrary host. Client HTTP/2 and HTTP/2 origin-pull
 * are separate product features and are not used here.
 *
 * A Tencent reply on the Jan 20 V2EX thread (year not printed on the page;
 * the upstream proxy landed on 2026-01-24 for the same limitation) said edge
 * fetch HTTP/2 was still in planning. The upstream wiki on 2026-01-24 still
 * required a Node Functions proxy. No later official notice was found that
 * says this limitation has been removed or that APNs delivery was verified.
 *
 * `eo.tls` in the same Request docs is client-certificate material, not a
 * minimum protocol version, so this request does not claim to set TLS 1.2.
 * There is no relay fallback.
 */
export const APNS_DIRECT_HTTP_VERSION = 'HTTP/2.0' as const;

/** Fixed invalid token used only by the opt-in transport probe. */
export const APNS_PROBE_DEVICE_TOKEN = '0'.repeat(64);

const BLOCKED_RELAY_HOSTS = new Set(['api.day.app']);
const HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

export const DIRECT_APNS_TIMEOUT = {
  connectTimeout: 10000,
  readTimeout: 20000,
  writeTimeout: 20000,
} as const;

export type DirectApnsRequestInit = {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  redirect: 'manual';
  version: typeof APNS_DIRECT_HTTP_VERSION;
  eo: {
    timeoutSetting: {
      connectTimeout: number;
      readTimeout: number;
      writeTimeout: number;
    };
  };
};

const assertDirectApnsTarget = (url: string) => {
  const parsed = new URL(url);
  if (BLOCKED_RELAY_HOSTS.has(parsed.hostname)) {
    throw new Error('Refusing to relay APNs through a third-party host');
  }
  const haystack = `${parsed.pathname} ${parsed.href}`;
  if (haystack.includes('apns-proxy') || haystack.includes('bark-node')) {
    throw new Error('Refusing to relay APNs through the EdgeOne node proxy');
  }
};

export const buildDirectApnsRequest = (
  domain: string,
  deviceToken: string,
  headers: Record<string, string>,
  aps: unknown,
): { url: string; init: DirectApnsRequestInit } => {
  if (!HOST_PATTERN.test(domain)) {
    throw new Error('APNs host must be a hostname, not a URL');
  }
  if (!deviceToken) {
    throw new Error('APNs device token is empty');
  }

  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) {
      continue;
    }
    normalizedHeaders[key] = String(value);
  }

  const url = `https://${domain}/3/device/${encodeURIComponent(deviceToken)}`;
  assertDirectApnsTarget(url);

  return {
    url,
    init: {
      method: 'POST',
      headers: normalizedHeaders,
      body: JSON.stringify(aps),
      redirect: 'manual',
      version: APNS_DIRECT_HTTP_VERSION,
      eo: {
        timeoutSetting: DIRECT_APNS_TIMEOUT,
      },
    },
  };
};

export const executeDirectApnsRequest = async (
  domain: string,
  deviceToken: string,
  headers: Record<string, string>,
  aps: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<APNsResponse> => {
  const { url, init } = buildDirectApnsRequest(
    domain,
    deviceToken,
    headers,
    aps,
  );
  const response = await fetchImpl(url, init as RequestInit);
  const responseText = await response.text();
  let message = responseText;
  try {
    const reason = JSON.parse(responseText).reason;
    if (typeof reason === 'string') {
      message = reason;
    }
  } catch {
    message = responseText;
  }

  return {
    status: response.status,
    message,
  };
};

const BEARER_RE = /bearer\s+\S+/gi;
const JWT_RE =
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export const sanitizeTransportDetail = (
  detail: string,
  redactions: string[] = [],
): string => {
  let sanitized = detail;
  for (const secret of redactions) {
    if (!secret) {
      continue;
    }
    sanitized = sanitized.split(secret).join('[redacted]');
  }
  sanitized = sanitized.replace(BEARER_RE, '[redacted]');
  sanitized = sanitized.replace(JWT_RE, '[redacted]');
  if (sanitized.length > 300) {
    sanitized = `${sanitized.slice(0, 300)}…`;
  }
  return sanitized;
};

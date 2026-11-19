import { APNS_DEFAULT_TOPIC, APNS_HOST_NAME } from '../core/apns';
import {
  APNS_DIRECT_HTTP_VERSION,
  APNS_PROBE_DEVICE_TOKEN,
  executeDirectApnsRequest,
  sanitizeTransportDetail,
} from '../core/apns-direct';
import type { BasicEnv } from '../core/type';
import { validateBasicAuth } from '../core/utils';
import { normalizeUrlPrefix } from './edgeone-layout';

export const APNS_TRANSPORT_DIAG_PATH = '/_diag/apns-transport';

const DIAG_NOTE =
  'Experimental direct fetch with RequestInit.version HTTP/2.0. deliveryVerified is always false. An APNs HTTP status does not prove the negotiated protocol, TLS version, or that a device showed a notification.';

export const apnsTransportDiagPath = (urlPrefix?: string): string => {
  const prefix = normalizeUrlPrefix(urlPrefix);
  if (prefix === '/') {
    return APNS_TRANSPORT_DIAG_PATH;
  }
  return `${prefix}${APNS_TRANSPORT_DIAG_PATH}`;
};

export const isApnsTransportDiagPath = (
  pathname: string,
  urlPrefix?: string,
): boolean => pathname === apnsTransportDiagPath(urlPrefix);

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export const handleApnsTransportDiag = async (
  env: BasicEnv,
  request: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> => {
  const base = {
    code: 200,
    experimental: true,
    mode: 'edgeone-direct',
    relay: false,
    requestedHttpVersion: APNS_DIRECT_HTTP_VERSION,
    customApnsHost: Boolean(env.APNS_URL),
    deliveryVerified: false,
  };

  if (env.APNS_TRANSPORT_PROBE !== 'true' || request.method !== 'POST') {
    return json({
      ...base,
      probe: 'disabled',
      note: 'Set APNS_TRANSPORT_PROBE=true and POST to this path to send one unauthenticated request with a fixed invalid device token. GET does not contact APNs.',
    });
  }

  if (
    env.BASIC_AUTH &&
    !validateBasicAuth(
      request.headers.get('Authorization') ?? undefined,
      env.BASIC_AUTH,
    )
  ) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'content-type': 'text/plain',
        'WWW-Authenticate': 'Basic',
      },
    });
  }

  const domain = env.APNS_URL || APNS_HOST_NAME;
  const redactions = [APNS_PROBE_DEVICE_TOKEN, env.APNS_URL || ''].filter(
    Boolean,
  );

  try {
    const result = await executeDirectApnsRequest(
      domain,
      APNS_PROBE_DEVICE_TOKEN,
      {
        'apns-topic': APNS_DEFAULT_TOPIC,
        'apns-push-type': 'background',
        'content-type': 'application/json',
      },
      { aps: { 'content-available': 1 } },
      fetchImpl,
    );
    return json({
      ...base,
      probe: 'performed',
      authenticated: false,
      transport: 'apns-response',
      httpStatus: result.status,
      apnsReason: sanitizeTransportDetail(result.message || '', redactions),
      note: DIAG_NOTE,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({
      ...base,
      probe: 'performed',
      authenticated: false,
      transport: 'network-error',
      detail: sanitizeTransportDetail(message, redactions),
      note: DIAG_NOTE,
    });
  }
};

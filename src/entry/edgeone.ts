import type { Env, Hono } from 'hono';
import { APNS_HOST_NAME } from '../core/apns';
import { executeDirectApnsRequest } from '../core/apns-direct';
import { KVAdapter } from '../core/db/kv-adapter';
import { createHono } from '../core/hono';
import type { BasicEnv } from '../core/type';
import {
  handleApnsTransportDiag,
  isApnsTransportDiagPath,
} from './edgeone-diag';

interface EOEventContext {
  params: any;
  request: Request;
  env: BasicEnv;
}

interface EOHonoEnv extends Env {
  Bindings: BasicEnv;
}

let hono: Hono<EOHonoEnv>;

export const onRequest = async (ctx: EOEventContext) => {
  const url = new URL(ctx.request.url);
  if (isApnsTransportDiagPath(url.pathname, ctx.env.URL_PREFIX)) {
    return handleApnsTransportDiag(ctx.env, ctx.request);
  }

  if (!hono) {
    hono = createHono({
      db: new KVAdapter((globalThis as any)[ctx.env.DB_NAME || 'BARK_KV']),
      allowNewDevice: ctx.env.ALLOW_NEW_DEVICE !== 'false',
      allowQueryNums: ctx.env.ALLOW_QUERY_NUMS !== 'false',
      maxBatchPushCount: Number(ctx.env.MAX_BATCH_PUSH_COUNT),
      urlPrefix: ctx.env.URL_PREFIX || '/',
      basicAuth: ctx.env.BASIC_AUTH,
      apnsUrl: ctx.env.APNS_URL,
      requestAPNs: (deviceToken, headers, aps, reqCtx) => {
        const env = (reqCtx?.env as BasicEnv | undefined) ?? ctx.env;
        return executeDirectApnsRequest(
          env.APNS_URL || APNS_HOST_NAME,
          deviceToken,
          headers,
          aps,
        );
      },
    });
  }
  return hono.fetch(ctx.request, ctx.env);
};

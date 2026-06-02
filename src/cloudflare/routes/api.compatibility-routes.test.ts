import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import * as schema from '../../server/db/schema.js';
import { registerCoreApiRoutes } from './api.js';
import type { CloudflareHonoEnv } from '../shared/http.js';

function createCompatibilityDb() {
  const updates: Array<{ table: unknown; payload: Record<string, unknown> }> = [];
  const account = {
    id: 1,
    siteId: 1,
    username: 'managed',
    accessToken: 'session-token',
    apiToken: null,
    extraConfig: JSON.stringify({ credentialMode: 'session' }),
    oauthProvider: null,
  };
  const site = {
    id: 1,
    name: 'Site A',
    url: 'https://site.example.com',
    platform: 'new-api',
  };
  const accountToken = {
    id: 5,
    accountId: 1,
    name: 'default',
    token: 'sk-default-token-secret',
    tokenGroup: null,
    isDefault: true,
    enabled: true,
    valueStatus: 'ready',
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
  };

  const makeSelectBuilder = () => {
    let table: unknown = null;
    let joined = false;
    const builder: any = {
      from(nextTable: unknown) {
        table = nextTable;
        return builder;
      },
      innerJoin() {
        joined = true;
        return builder;
      },
      leftJoin() {
        joined = true;
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      async all() {
        return [];
      },
      async get() {
        if (table === schema.accountTokens && joined) {
          return {
            account_tokens: accountToken,
            accounts: account,
            sites: site,
          };
        }
        if (table === schema.oauthRouteUnits) {
          return {
            id: 9,
            name: 'Old Unit',
            strategy: 'round_robin',
          };
        }
        if (table === schema.oauthRouteUnitMembers) {
          return { count: 2 };
        }
        return undefined;
      },
    };
    return builder;
  };

  return {
    updates,
    select() {
      return makeSelectBuilder();
    },
    update(table?: unknown) {
      return {
        set(payload?: Record<string, unknown>) {
          updates.push({ table, payload: payload || {} });
          return {
            where() {
              return {
                async run() {
                  return { changes: 1 };
                },
              };
            },
          };
        },
      };
    },
  };
}

function createTestApp() {
  const app = new Hono<CloudflareHonoEnv>();
  const fakeDb = createCompatibilityDb();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb as never);
    await next();
  });
  registerCoreApiRoutes(app);
  return { app, fakeDb };
}

async function fetchApp(app: Hono<CloudflareHonoEnv>, path: string, init?: RequestInit) {
  return app.fetch(
    new Request(`https://metapi.test${path}`, init),
    {
      METAPI_DB: {} as never,
      METAPI_FILES: {} as never,
      AUTH_TOKEN: '',
      PROXY_TOKEN: '',
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    } as never,
  );
}

describe('cloudflare compatibility routes', () => {
  it('returns the masked default account token by account id', async () => {
    const { app } = createTestApp();
    const response = await fetchApp(app, '/api/account-tokens/account/1/default');
    const payload = await response.json() as { success?: boolean; token?: { token?: string; tokenMasked?: string } | null };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.token?.token).toBeUndefined();
    expect(payload.token?.tokenMasked).toContain('sk-');
  });

  it('accepts PATCH for oauth route unit updates', async () => {
    const { app, fakeDb } = createTestApp();
    const response = await fetchApp(app, '/api/oauth/route-units/9', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Updated Unit',
        strategy: 'stick_until_unavailable',
      }),
    });
    const payload = await response.json() as { success?: boolean; routeUnit?: { strategy?: string; memberCount?: number } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.routeUnit?.strategy).toBe('stick_until_unavailable');
    expect(payload.routeUnit?.memberCount).toBe(2);
    expect(fakeDb.updates.some((item) => item.table === schema.oauthRouteUnits)).toBe(true);
  });
});

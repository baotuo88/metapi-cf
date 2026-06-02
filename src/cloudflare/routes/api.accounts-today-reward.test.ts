import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import * as schema from '../../server/db/schema.js';
import { getLocalDayRangeUtc } from '../../server/services/localTimeService.js';
import { registerCoreApiRoutes } from './api.js';
import type { CloudflareHonoEnv } from '../shared/http.js';

function createAccountsTodayRewardDb() {
  const { localDay, startUtc } = getLocalDayRangeUtc();
  const siteRow = {
    id: 1,
    name: 'Reward Site',
    url: 'https://reward.example.com',
    platform: 'new-api',
    status: 'active',
    apiKey: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    isPinned: false,
    sortOrder: 0,
    proxyUrl: null,
    useSystemProxy: false,
    customHeaders: null,
    externalCheckinUrl: null,
    globalWeight: 1,
    postRefreshProbeEnabled: false,
    postRefreshProbeModel: '',
    postRefreshProbeScope: 'single',
    postRefreshProbeLatencyThresholdMs: 0,
  };
  const accountRows = [
    {
      id: 1,
      siteId: 1,
      username: 'direct-reward',
      accessToken: 'session=direct',
      apiToken: null,
      balance: 8,
      balanceUsed: 0,
      quota: 0,
      unitCost: null,
      valueScore: 0,
      status: 'active',
      checkinEnabled: true,
      lastCheckinAt: startUtc,
      lastBalanceRefresh: null,
      extraConfig: null,
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
      isPinned: false,
      sortOrder: 0,
      oauthProvider: null,
      oauthAccountKey: null,
      oauthProjectId: null,
    },
    {
      id: 2,
      siteId: 1,
      username: 'fallback-reward',
      accessToken: 'session=fallback',
      apiToken: null,
      balance: 12.5,
      balanceUsed: 0,
      quota: 0,
      unitCost: null,
      valueScore: 0,
      status: 'active',
      checkinEnabled: true,
      lastCheckinAt: startUtc,
      lastBalanceRefresh: null,
      extraConfig: JSON.stringify({
        todayIncomeSnapshot: {
          day: localDay,
          baseline: 12.5,
          latest: 12.5,
          updatedAt: new Date().toISOString(),
        },
      }),
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
      isPinned: false,
      sortOrder: 1,
      oauthProvider: null,
      oauthAccountKey: null,
      oauthProjectId: null,
    },
  ];
  const checkinRows = [
    {
      accountId: 1,
      status: 'success',
      reward: '2.5',
      message: '签到成功',
      createdAt: startUtc,
    },
    {
      accountId: 2,
      status: 'success',
      reward: '',
      message: '签到成功',
      createdAt: startUtc,
    },
  ];
  const spendRows = [
    {
      accountId: 1,
      totalSpend: 0.25,
    },
  ];

  const makeSelectBuilder = () => {
    let table: unknown = null;
    const builder: any = {
      from(nextTable: unknown) {
        table = nextTable;
        return builder;
      },
      innerJoin() {
        return builder;
      },
      leftJoin() {
        return builder;
      },
      where() {
        return builder;
      },
      groupBy() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      offset() {
        return builder;
      },
      async all() {
        if (table === schema.accounts) return accountRows;
        if (table === schema.sites) return [siteRow];
        if (table === schema.proxyLogs) return spendRows;
        if (table === schema.checkinLogs) return checkinRows;
        return [];
      },
      async get() {
        const rows = await builder.all();
        return rows[0];
      },
    };
    return builder;
  };

  return {
    select() {
      return makeSelectBuilder();
    },
  };
}

function createTestApp() {
  const app = new Hono<CloudflareHonoEnv>();
  const fakeDb = createAccountsTodayRewardDb();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb as never);
    await next();
  });
  registerCoreApiRoutes(app);
  return app;
}

async function getJson(app: Hono<CloudflareHonoEnv>, path: string) {
  return app.fetch(
    new Request(`https://metapi.test${path}`),
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

describe('cloudflare /api/accounts today reward', () => {
  it('returns today reward and spend values for account list display', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/api/accounts');
    const payload = await response.json() as {
      accounts: Array<{ id: number; todayReward?: number; todaySpend?: number }>;
    };

    expect(response.status).toBe(200);
    expect(payload.accounts.find((account) => account.id === 1)?.todayReward).toBe(2.5);
    expect(payload.accounts.find((account) => account.id === 1)?.todaySpend).toBe(0.25);
    expect(payload.accounts.find((account) => account.id === 2)?.todayReward).toBe(12.5);
  });
});

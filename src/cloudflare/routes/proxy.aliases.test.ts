import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as schema from '../../server/db/schema.js';
import { registerProxyRoutes } from './proxy.js';
import type { CloudflareHonoEnv } from '../shared/http.js';

function createProxyAliasDb() {
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
      orderBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      async all() {
        if (table === schema.routeGroupSources) return [];
        if (table === schema.tokenRoutes) {
          return [{
            id: 1,
            modelPattern: 'gpt-test',
            displayName: null,
            routeMode: 'model',
            modelMapping: null,
          }];
        }
        if (table === schema.routeChannels) {
          return [{
            channelId: 7,
            routeId: 1,
            channelTokenId: null,
            channelSourceModel: null,
            channelPriority: 0,
            channelEnabled: true,
            channelCooldownUntil: null,
            accountId: 11,
            accountStatus: 'active',
            accountAccessToken: 'upstream-token',
            accountApiToken: null,
            siteId: 22,
            siteStatus: 'active',
            siteUrl: 'https://upstream.example.com',
            tokenId: null,
            tokenValue: null,
            tokenName: null,
            tokenEnabled: null,
            tokenValueStatus: null,
          }];
        }
        return [];
      },
      async get() {
        return undefined;
      },
    };
    return builder;
  };

  return {
    select() {
      return makeSelectBuilder();
    },
    update() {
      return {
        set() {
          return {
            where() {
              return {
                async run() {
                  return { changes: 0 };
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
  const fakeDb = createProxyAliasDb();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb as never);
    await next();
  });
  registerProxyRoutes(app);
  return app;
}

async function fetchApp(app: Hono<CloudflareHonoEnv>, path: string, init?: RequestInit) {
  return app.fetch(
    new Request(`https://metapi.test${path}`, init),
    {
      METAPI_DB: {} as never,
      METAPI_FILES: {} as never,
      AUTH_TOKEN: '',
      PROXY_TOKEN: 'sk-test',
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    } as never,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cloudflare proxy aliases', () => {
  it('maps /chat/completions to the /v1/chat/completions upstream path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const app = createTestApp();

    const response = await fetchApp(app, '/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-test', messages: [] }),
    });

    expect(response.status).toBe(200);
    expect((fetchMock.mock.calls as unknown[][])[0]?.[0]).toBe('https://upstream.example.com/v1/chat/completions');
  });

  it('maps /responses/compact to the /v1/responses/compact upstream path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const app = createTestApp();

    const response = await fetchApp(app, '/responses/compact', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' }),
    });

    expect(response.status).toBe(200);
    expect((fetchMock.mock.calls as unknown[][])[0]?.[0]).toBe('https://upstream.example.com/v1/responses/compact');
  });

  it('returns websocket upgrade hint for GET /responses alias', async () => {
    const app = createTestApp();
    const response = await fetchApp(app, '/responses', {
      method: 'GET',
      headers: {
        authorization: 'Bearer sk-test',
      },
    });
    const payload = await response.json() as { error?: { message?: string } };

    expect(response.status).toBe(426);
    expect(payload.error?.message).toContain('/v1/responses');
  });
});

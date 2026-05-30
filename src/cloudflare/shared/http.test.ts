import { describe, expect, it } from 'vitest';
import { requireAdminAuth, sanitizeCloudflareSettingSnapshot } from './http.js';

type FakeDb = {
  select: (selection: { value: unknown }) => {
    from: (table: unknown) => {
      where: (clause: unknown) => {
        get: () => Promise<{ value: string } | undefined>;
      };
    };
  };
};

function createFakeDb(valuesInOrder: Array<string | undefined>): FakeDb {
  let index = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => {
            const value = valuesInOrder[index];
            index += 1;
            return value === undefined ? undefined : { value };
          },
        }),
      }),
    }),
  };
}

function createContext(input: {
  settings: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
}) {
  const headerMap = new Map<string, string>();
  for (const [key, value] of Object.entries(input.headers || {})) {
    if (value !== undefined) {
      headerMap.set(key.toLowerCase(), value);
    }
  }

  let jsonResponse: Response | null = null;
  const fakeDb = createFakeDb([
    input.settings.admin_ip_allowlist,
    input.settings.auth_token,
  ]);

  const context = {
    env: {
      METAPI_DB: {},
      METAPI_FILES: {},
      AUTH_TOKEN: 'env-admin-token',
    },
    req: {
      header(name: string) {
        return headerMap.get(name.toLowerCase());
      },
    },
    get(name: string) {
      if (name === 'db') {
        return fakeDb;
      }
      return undefined;
    },
    set() {
      // No-op in tests because db is injected via get().
    },
    json(payload: unknown, status = 200) {
      jsonResponse = new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
      return jsonResponse;
    },
  };

  return {
    context,
    getJsonResponse: () => jsonResponse,
  };
}

describe('cloudflare admin auth', () => {
  it('rejects request when client IP is outside the configured allowlist', async () => {
    const { context, getJsonResponse } = createContext({
      settings: {
        auth_token: JSON.stringify('admin-token'),
        admin_ip_allowlist: JSON.stringify(['198.51.100.0/24']),
      },
      headers: {
        authorization: 'Bearer admin-token',
        'cf-connecting-ip': '203.0.113.9',
      },
    });

    let nextCalled = false;
    const response = await requireAdminAuth(context as never, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(response?.status).toBe(403);
    expect(await getJsonResponse()?.json()).toEqual({ error: 'IP not allowed' });
  });

  it('allows request when token and IP allowlist both match', async () => {
    const { context } = createContext({
      settings: {
        auth_token: JSON.stringify('admin-token'),
        admin_ip_allowlist: JSON.stringify(['198.51.100.0/24']),
      },
      headers: {
        authorization: 'Bearer admin-token',
        'cf-connecting-ip': '198.51.100.23',
      },
    });

    let nextCalled = false;
    const response = await requireAdminAuth(context as never, async () => {
      nextCalled = true;
    });

    expect(response).toBeUndefined();
    expect(nextCalled).toBe(true);
  });
});

describe('cloudflare setting snapshot sanitization', () => {
  it('masks direct token-like settings', () => {
    expect(sanitizeCloudflareSettingSnapshot('auth_token', JSON.stringify('super-secret-admin-token'))).toBe('supe****oken');
    expect(sanitizeCloudflareSettingSnapshot('proxy_token', JSON.stringify('sk-secret-proxy-token'))).toBe('sk-s****oken');
  });

  it('masks credentials embedded in url settings', () => {
    expect(
      sanitizeCloudflareSettingSnapshot(
        'db_url',
        JSON.stringify('postgres://metapi:super-secret@db.example.com:5432/metapi'),
      ),
    ).toBe('postgres://****:supe****cret@db.example.com:5432/metapi');
  });

  it('masks nested password and token fields in object settings', () => {
    expect(
      sanitizeCloudflareSettingSnapshot(
        'backup_webdav_config_v1',
        JSON.stringify({
          username: 'alice',
          password: 'secret-pass',
          fileUrl: 'https://user:raw-pass@example.com/backup.json',
          nested: {
            telegram_bot_token: 'telegram-secret-token',
          },
        }),
      ),
    ).toEqual({
      username: 'alice',
      password: 'secr****pass',
      fileUrl: 'https://****:****@example.com/backup.json',
      nested: {
        telegram_bot_token: 'tele****oken',
      },
    });
  });
});

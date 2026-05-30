import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/db/schema.js';
import {
  getCloudflareDb,
  sanitizeCloudflareSettingSnapshot,
  type CloudflareHonoEnv,
} from '../shared/http.js';

export function registerCoreApiRoutes(app: Hono<CloudflareHonoEnv>) {
  app.get('/api/cloudflare/config', async (c) => {
    const db = getCloudflareDb(c);
    const systemSettings = await db
      .select()
      .from(schema.settings)
      .all();
      
    return c.json({
      success: true,
      timestamp: new Date().toISOString(),
      settings: systemSettings.map((setting) => ({
        key: setting.key,
        value: sanitizeCloudflareSettingSnapshot(setting.key, setting.value),
      })),
    });
  });

  app.get('/api/cloudflare/accounts/snapshot', async (c) => {
    const db = getCloudflareDb(c);
    const activeAccounts = await db
      .select({
        id: schema.accounts.id,
        username: schema.accounts.username,
        siteId: schema.accounts.siteId,
        status: schema.accounts.status,
        updatedAt: schema.accounts.updatedAt,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.status, 'active'))
      .limit(100)
      .all();

    return c.json({
      success: true,
      count: activeAccounts.length,
      data: activeAccounts.map((account) => ({
        ...account,
        isActive: account.status === 'active',
      })),
    });
  });
}

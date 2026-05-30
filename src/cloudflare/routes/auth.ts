import type { Hono } from 'hono';
import { events } from '../../server/db/schema.js';
import { parseAuthChangePayload } from '../../server/contracts/supportRoutePayloads.js';
import {
  formatUtcSqlDateTime,
  getCloudflareDb,
  maskSecret,
  readJsonBody,
  resolveAdminToken,
  withHttpErrors,
  writeSetting,
  type CloudflareHonoEnv,
} from '../shared/http.js';

export function registerAuthRoutes(app: Hono<CloudflareHonoEnv>) {
  app.get('/api/settings/auth/info', async (c) => {
    const token = await resolveAdminToken(c);
    return c.json({ masked: maskSecret(token) });
  });

  app.post('/api/settings/auth/change', withHttpErrors(async (c) => {
    const body = await readJsonBody(c);
    const parsedBody = parseAuthChangePayload(body);
    if (!parsedBody.success) {
      return c.json({ success: false, message: parsedBody.error }, 400);
    }

    const oldToken = typeof parsedBody.data.oldToken === 'string' ? parsedBody.data.oldToken.trim() : '';
    const newToken = typeof parsedBody.data.newToken === 'string' ? parsedBody.data.newToken.trim() : '';
    if (!oldToken || !newToken) {
      return c.json({ success: false, message: '请填写所有字段' }, 400);
    }
    if (newToken.length < 6) {
      return c.json({ success: false, message: '新 Token 至少 6 个字符' }, 400);
    }

    const current = await resolveAdminToken(c);
    if (oldToken !== current) {
      return c.json({ success: false, message: '旧 Token 验证失败' }, 403);
    }

    const db = getCloudflareDb(c);
    await writeSetting(db, 'auth_token', newToken);
    await db.insert(events).values({
      type: 'token',
      title: '管理员登录令牌已更新',
      message: '管理员登录 Token 已被修改，请使用新 Token 登录。',
      level: 'warning',
      relatedType: 'settings',
      createdAt: formatUtcSqlDateTime(),
    }).run().catch(() => undefined);

    return c.json({ success: true, message: 'Token 已更新' });
  }));
}

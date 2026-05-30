import type { Context, Next } from 'hono';
import { createD1Db, type CloudflareD1Db } from '../db/d1.js';
import type { CloudflareEnv } from '../env.js';
import { settings } from '../../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { extractClientIp, isIpAllowed } from '../../server/shared/ipAllowlist.js';

export type CloudflareHonoEnv = {
  Bindings: CloudflareEnv;
  Variables: {
    db: CloudflareD1Db;
    proxyAuth?: {
      token: string;
      source: 'managed' | 'global';
      keyId: number | null;
      keyName: string;
      policy: {
        supportedModels: string[];
        allowedRouteIds: number[];
        siteWeightMultipliers: Record<number, number>;
        excludedSiteIds: number[];
        excludedCredentialRefs: unknown[];
        denyAllWhenEmpty?: boolean;
      };
    };
  };
};

export function getCloudflareDb(c: Context<CloudflareHonoEnv>): CloudflareD1Db {
  const existing = c.get('db');
  if (existing) return existing;
  const db = createD1Db(c.env.METAPI_DB);
  c.set('db', db);
  return db;
}

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function maskUrlCredentials(rawValue: string): string {
  const value = rawValue.trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.username) {
      parsed.username = maskSecret(decodeURIComponent(parsed.username));
    }
    if (parsed.password) {
      parsed.password = maskSecret(decodeURIComponent(parsed.password));
    }
    return parsed.toString();
  } catch {
    return maskSecret(value);
  }
}

function isSensitiveSettingName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('cookie')
    || normalized.includes('passwd');
}

function shouldMaskUrlSetting(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized.includes('url');
}

function sanitizeSettingValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (isSensitiveSettingName(key)) {
      return maskSecret(value);
    }
    if (shouldMaskUrlSetting(key)) {
      return maskUrlCredentials(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSettingValue(key, item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeSettingValue(entryKey, entryValue),
      ]),
    );
  }

  return value;
}

export function sanitizeCloudflareSettingSnapshot(key: string, rawValue: string | null): unknown {
  if (rawValue == null) {
    return null;
  }
  let parsed: unknown = rawValue;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    parsed = rawValue;
  }
  return sanitizeSettingValue(key, parsed);
}

export function isPublicCloudflareApiRoute(pathname: string): boolean {
  return pathname === '/api/cloudflare/health' || pathname.startsWith('/api/oauth/callback/');
}

export function formatUtcSqlDateTime(value = new Date()): string {
  const pad = (item: number) => String(item).padStart(2, '0');
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

export async function readJsonBody(c: Context): Promise<unknown> {
  const contentType = c.req.header('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return {};
  }
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function jsonNotImplemented(feature: string) {
  return {
    error: 'not_implemented',
    feature,
    message: 'This endpoint still depends on the Node/Fastify runtime and has not been ported to Cloudflare Workers yet.',
  };
}

export async function readSetting(db: CloudflareD1Db, key: string): Promise<unknown> {
  const row = await db.select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  if (!row || row.value == null || row.value === '') return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export async function writeSetting(db: CloudflareD1Db, key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  await db
    .insert(settings)
    .values({ key, value: serialized })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: serialized },
    })
    .run();
}

export function readD1LastInsertId(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const direct = (result as { lastInsertRowid?: unknown }).lastInsertRowid;
  if (typeof direct === 'number' && Number.isFinite(direct)) return Math.trunc(direct);

  const meta = (result as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return 0;

  for (const key of ['last_row_id', 'lastRowId', 'last_insert_rowid']) {
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  }

  return 0;
}

export function normalizePositiveInt(input: unknown): number | null {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

export function normalizeBoolean(input: unknown, fallback = false): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

export function normalizeString(input: unknown, fallback = ''): string {
  return typeof input === 'string' ? input.trim() : fallback;
}

export async function resolveAdminToken(c: Context<CloudflareHonoEnv>): Promise<string> {
  const db = getCloudflareDb(c);
  const stored = await readSetting(db, 'auth_token');
  return normalizeString(stored, '') || normalizeString(c.env.AUTH_TOKEN, '') || 'change-me-admin-token';
}

export async function resolveAdminIpAllowlist(c: Context<CloudflareHonoEnv>): Promise<string[]> {
  const db = getCloudflareDb(c);
  const stored = await readSetting(db, 'admin_ip_allowlist');
  if (Array.isArray(stored)) {
    return stored
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof stored === 'string') {
    return stored
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

export async function requireAdminAuth(c: Context<CloudflareHonoEnv>, next: Next) {
  const clientIp = extractClientIp(
    c.req.header('CF-Connecting-IP') || '',
    c.req.header('X-Forwarded-For') || undefined,
  );
  const allowlist = await resolveAdminIpAllowlist(c);
  if (!isIpAllowed(clientIp, allowlist)) {
    return c.json({ error: 'IP not allowed' }, 403);
  }

  const authHeader = c.req.header('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const provided = match?.[1]?.trim() || '';
  if (!provided) {
    return c.json({ error: 'Missing Authorization header' }, 401);
  }
  const expected = await resolveAdminToken(c);
  if (provided !== expected) {
    return c.json({ error: 'Invalid token' }, 403);
  }
  await next();
}

export function withHttpErrors(handler: (c: Context<CloudflareHonoEnv>) => Promise<Response> | Response) {
  return async (c: Context<CloudflareHonoEnv>) => {
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof HttpError) {
        return c.json({ success: false, message: error.message }, error.status as never);
      }
      throw error;
    }
  };
}

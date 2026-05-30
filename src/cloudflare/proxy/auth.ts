import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../../server/db/schema.js';
import type { CloudflareD1Db } from '../db/d1.js';
import { normalizeString, readSetting } from '../shared/http.js';

export type DownstreamRoutingPolicy = {
  supportedModels: string[];
  allowedRouteIds: number[];
  siteWeightMultipliers: Record<number, number>;
  excludedSiteIds: number[];
  excludedCredentialRefs: Array<{
    kind: 'default_api_key' | 'account_token';
    siteId: number;
    accountId: number;
    tokenId?: number;
  }>;
  denyAllWhenEmpty?: boolean;
};

const EMPTY_DOWNSTREAM_ROUTING_POLICY: DownstreamRoutingPolicy = {
  supportedModels: [],
  allowedRouteIds: [],
  siteWeightMultipliers: {},
  excludedSiteIds: [],
  excludedCredentialRefs: [],
  denyAllWhenEmpty: false,
};

export type CloudflareProxyAuthContext = {
  token: string;
  source: 'managed' | 'global';
  keyId: number | null;
  keyName: string;
  policy: DownstreamRoutingPolicy;
};

type CloudflareDownstreamAuthResult =
  | { ok: true; context: CloudflareProxyAuthContext }
  | { ok: false; status: number; error: string };

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeStringList(input: unknown): string[] {
  if (Array.isArray(input)) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of input) {
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }

  if (typeof input === 'string') {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input.split(/\r?\n|,/g)) {
      const value = raw.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }

  return [];
}

function normalizeNumberList(input: unknown): number[] {
  const rawValues = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/\r?\n|,/g) : []);
  const out: number[] = [];
  for (const value of rawValues) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    const normalized = Math.trunc(parsed);
    if (normalized <= 0 || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

function normalizeSiteWeightMultipliers(input: unknown): Record<number, number> {
  const raw = typeof input === 'string' ? parseJson(input) : input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const out: Record<number, number> = {};
  for (const [siteIdRaw, multiplierRaw] of Object.entries(raw as Record<string, unknown>)) {
    const siteId = Math.trunc(Number(siteIdRaw));
    const multiplier = Number(multiplierRaw);
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    if (!Number.isFinite(multiplier) || multiplier <= 0) continue;
    out[siteId] = multiplier;
  }
  return out;
}

function normalizeExcludedCredentialRefs(input: unknown): DownstreamRoutingPolicy['excludedCredentialRefs'] {
  const raw = typeof input === 'string' ? parseJson(input) : input;
  if (!Array.isArray(raw)) return [];

  const out: DownstreamRoutingPolicy['excludedCredentialRefs'] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const kind = String(record.kind || '').trim();
    const siteId = Math.trunc(Number(record.siteId));
    const accountId = Math.trunc(Number(record.accountId));
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    if (!Number.isFinite(accountId) || accountId <= 0) continue;

    if (kind === 'default_api_key') {
      const dedupe = `${kind}:${siteId}:${accountId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ kind: 'default_api_key', siteId, accountId });
      continue;
    }

    if (kind === 'account_token') {
      const tokenId = Math.trunc(Number(record.tokenId));
      if (!Number.isFinite(tokenId) || tokenId <= 0) continue;
      const dedupe = `${kind}:${siteId}:${accountId}:${tokenId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ kind: 'account_token', siteId, accountId, tokenId });
    }
  }

  return out;
}

function extractProxyToken(request: {
  header(name: string): string | undefined;
  query(name: string): string | undefined;
}): string {
  const auth = request.header('authorization') || '';
  const apiKey = request.header('x-api-key') || '';
  const googApiKey = request.header('x-goog-api-key') || '';
  const queryKey = request.query('key') || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  return bearer || apiKey.trim() || googApiKey.trim() || queryKey.trim();
}

async function resolveProxyToken(db: CloudflareD1Db, envToken: string | undefined): Promise<string> {
  const stored = await readSetting(db, 'proxy_token');
  return normalizeString(stored, '') || normalizeString(envToken, '') || 'change-me-proxy-sk-token';
}

function toPolicy(row: typeof schema.downstreamApiKeys.$inferSelect): DownstreamRoutingPolicy {
  return {
    supportedModels: normalizeStringList(parseJson(row.supportedModels)),
    allowedRouteIds: normalizeNumberList(parseJson(row.allowedRouteIds)),
    siteWeightMultipliers: normalizeSiteWeightMultipliers(parseJson(row.siteWeightMultipliers)),
    excludedSiteIds: normalizeNumberList(parseJson(row.excludedSiteIds)),
    excludedCredentialRefs: normalizeExcludedCredentialRefs(parseJson(row.excludedCredentialRefs)),
    denyAllWhenEmpty: true,
  };
}

export async function authorizeCloudflareProxyRequest(input: {
  db: CloudflareD1Db;
  envProxyToken?: string;
  request: {
    header(name: string): string | undefined;
    query(name: string): string | undefined;
  };
  now?: () => Date;
}): Promise<CloudflareDownstreamAuthResult> {
  const token = extractProxyToken(input.request);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: 'Missing Authorization, x-api-key, x-goog-api-key, or key query parameter',
    };
  }

  const managed = await input.db.select().from(schema.downstreamApiKeys)
    .where(eq(schema.downstreamApiKeys.key, token))
    .get();

  if (managed) {
    if (!managed.enabled) {
      return { ok: false, status: 403, error: 'API key is disabled' };
    }
    if (managed.expiresAt) {
      const expiresAtTs = Date.parse(managed.expiresAt);
      const nowTs = input.now?.().getTime() ?? Date.now();
      if (Number.isFinite(expiresAtTs) && expiresAtTs <= nowTs) {
        return { ok: false, status: 403, error: 'API key is expired' };
      }
    }
    if (managed.maxCost !== null && Number(managed.usedCost || 0) >= managed.maxCost) {
      return { ok: false, status: 403, error: 'API key has exceeded max cost' };
    }
    if (managed.maxRequests !== null && Number(managed.usedRequests || 0) >= managed.maxRequests) {
      return { ok: false, status: 403, error: 'API key has exceeded max requests' };
    }

    await input.db.update(schema.downstreamApiKeys).set({
      usedRequests: sql`coalesce(${schema.downstreamApiKeys.usedRequests}, 0) + 1`,
      lastUsedAt: (input.now?.() ?? new Date()).toISOString(),
      updatedAt: (input.now?.() ?? new Date()).toISOString(),
    }).where(and(
      eq(schema.downstreamApiKeys.id, managed.id),
      eq(schema.downstreamApiKeys.key, token),
    )).run();

    return {
      ok: true,
      context: {
        token,
        source: 'managed',
        keyId: managed.id,
        keyName: managed.name || 'managed',
        policy: toPolicy(managed),
      },
    };
  }

  const globalToken = await resolveProxyToken(input.db, input.envProxyToken);
  if (token === globalToken) {
    return {
      ok: true,
      context: {
        token,
        source: 'global',
        keyId: null,
        keyName: 'global',
        policy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      },
    };
  }

  return { ok: false, status: 403, error: 'Invalid API key' };
}

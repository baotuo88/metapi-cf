import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import * as schema from '../../server/db/schema.js';
import {
  getCloudflareDb,
  readSetting,
  resolveAdminToken,
  sanitizeCloudflareSettingSnapshot,
  writeSetting,
  type CloudflareHonoEnv,
} from '../shared/http.js';
import {
  parseUpdateCenterConfigPayload,
  parseUpdateCenterDeployPayload,
  parseUpdateCenterRollbackPayload,
} from '../../server/contracts/supportRoutePayloads.js';
import {
  parseBackupImportPayload,
  parseBackupWebdavConfigPayload,
  parseBackupWebdavExportPayload,
} from '../../server/contracts/settingsRoutePayloads.js';
import { parseRouteRebuildPayload } from '../../server/contracts/tokenRoutePayloads.js';
import {
  requiresManagedAccountTokens,
  supportsDirectAccountRoutingConnection,
} from '../../server/services/accountExtraConfig.js';
import { getAllBrandNames, getMatchingBrandNames } from '../../server/shared/modelBrand.js';

type BackupExportType = 'all' | 'accounts' | 'preferences';

const CLOUDFLARE_BACKUP_WEBDAV_CONFIG_KEY = 'cloudflare_backup_webdav_config';
const CLOUDFLARE_BACKUP_WEBDAV_STATE_KEY = 'cloudflare_backup_webdav_state';
const CLOUDFLARE_BACKUP_WEBDAV_DEFAULT_AUTO_SYNC_CRON = '0 */6 * * *';
const CLOUDFLARE_BACKUP_WEBDAV_FETCH_TIMEOUT_MS = 15_000;
const CLOUDFLARE_DEFAULT_SITE_SEED_SETTING_KEY = 'default_site_seed_v1';
const CLOUDFLARE_FACTORY_RESET_AUTH_FALLBACK = 'change-me-admin-token';
const CLOUDFLARE_FACTORY_RESET_PRESERVED_SETTING_KEYS = [
  'auth_token',
  'proxy_token',
  'cloudflare_runtime_settings',
  'cloudflare_runtime_database_config',
  CLOUDFLARE_BACKUP_WEBDAV_CONFIG_KEY,
  'admin_ip_allowlist',
] as const;
const CLOUDFLARE_FACTORY_RESET_DEFAULT_SITE_ROWS: Array<typeof schema.sites.$inferInsert> = [
  {
    name: 'OpenAI 官方',
    url: 'https://api.openai.com',
    platform: 'openai',
    status: 'active',
    useSystemProxy: false,
    isPinned: false,
    globalWeight: 1,
    sortOrder: 0,
  },
  {
    name: 'Claude 官方',
    url: 'https://api.anthropic.com',
    platform: 'claude',
    status: 'active',
    useSystemProxy: false,
    isPinned: false,
    globalWeight: 1,
    sortOrder: 1,
  },
  {
    name: 'Gemini 官方',
    url: 'https://generativelanguage.googleapis.com',
    platform: 'gemini',
    status: 'active',
    useSystemProxy: false,
    isPinned: false,
    globalWeight: 1,
    sortOrder: 2,
  },
  {
    name: 'CLIProxyAPI',
    url: 'http://127.0.0.1:8317',
    platform: 'cliproxyapi',
    status: 'active',
    useSystemProxy: false,
    isPinned: false,
    globalWeight: 1,
    sortOrder: 3,
  },
];

type SiteAvailabilityBucket = {
  startUtc: string;
  label: string;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  availabilityPercent: number | null;
  averageLatencyMs: number | null;
};

type SiteAvailabilitySummary = {
  siteId: number;
  siteName: string;
  siteUrl: string | null;
  platform: string | null;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  availabilityPercent: number | null;
  averageLatencyMs: number | null;
  buckets: SiteAvailabilityBucket[];
};

function toFiniteNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number;
}

function readD1Changes(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const direct = (result as { changes?: unknown }).changes;
  if (typeof direct === 'number' && Number.isFinite(direct)) return Math.max(0, Math.trunc(direct));
  const meta = (result as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return 0;
  const metaChanges = (meta as { changes?: unknown }).changes;
  if (typeof metaChanges === 'number' && Number.isFinite(metaChanges)) return Math.max(0, Math.trunc(metaChanges));
  return 0;
}

function toRoundedMicro(value: unknown): number {
  const numeric = toFiniteNumber(value);
  return Math.round(numeric * 1_000_000) / 1_000_000;
}

function parseBooleanQueryFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function formatUtcSqlDateTime(value = new Date()): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

function formatUtcDayKey(value = new Date()): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

function formatUtcDayKeyDaysAgo(days: number): string {
  const safeDays = Math.max(1, Math.trunc(days));
  const now = new Date();
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
  start.setUTCDate(start.getUTCDate() - (safeDays - 1));
  return formatUtcDayKey(start);
}

async function appendCloudflareEventBestEffort(
  db: ReturnType<typeof getCloudflareDb>,
  input: {
    title: string;
    message?: string;
    level?: 'info' | 'warning' | 'error';
    type?: string;
    relatedId?: number | null;
    relatedType?: string | null;
  },
): Promise<void> {
  const title = String(input.title || '').trim();
  if (!title) return;
  try {
    await db.insert(schema.events).values({
      type: String(input.type || 'status').trim() || 'status',
      title,
      message: String(input.message || '').trim() || null,
      level: input.level || 'info',
      relatedId: Number.isFinite(Number(input.relatedId)) ? Math.trunc(Number(input.relatedId)) : null,
      relatedType: String(input.relatedType || '').trim() || null,
      createdAt: formatUtcSqlDateTime(),
    }).run();
  } catch {
    // best-effort event append
  }
}

function parseJsonValue(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  const deduped = new Map<string, string>();
  for (const item of parsed) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, text);
  }
  return [...deduped.values()];
}

type CloudflareAccountCredentialMode = 'auto' | 'session' | 'apikey';
type CloudflareRuntimeHealthState = 'healthy' | 'unhealthy' | 'degraded' | 'unknown' | 'disabled';
type CloudflareRuntimeHealthRecord = {
  state: CloudflareRuntimeHealthState;
  reason: string;
  source: string;
  checkedAt: string | null;
};

function parseBatchApiKeys(input: unknown): string[] {
  if (Array.isArray(input)) {
    return Array.from(new Set(
      input
        .map((item) => String(item || '').trim())
        .filter((item) => item.length > 0),
    ));
  }

  const raw = String(input || '').trim();
  if (!raw) return [];

  return Array.from(new Set(
    raw
      .split(/[\r\n,，;；\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  ));
}

function buildBatchApiKeyConnectionName(baseName: string | null | undefined, index: number, total: number): string {
  const normalized = String(baseName || '').trim();
  if (!normalized) return '';
  if (total <= 1) return normalized;
  return `${normalized} #${index + 1}`;
}

function resolveRequestedCredentialMode(input: unknown): CloudflareAccountCredentialMode {
  const normalized = String(input || '').trim().toLowerCase();
  if (normalized === 'session') return 'session';
  if (normalized === 'apikey') return 'apikey';
  return 'auto';
}

function parseAccountExtraConfig(extraConfig: unknown): Record<string, unknown> {
  if (!extraConfig) return {};
  if (typeof extraConfig === 'object' && !Array.isArray(extraConfig)) {
    return { ...(extraConfig as Record<string, unknown>) };
  }
  if (typeof extraConfig !== 'string') return {};
  const raw = extraConfig.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return { ...(parsed as Record<string, unknown>) };
  } catch {
    return {};
  }
}

function normalizeCloudflareRuntimeHealthState(value: unknown): CloudflareRuntimeHealthState | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'healthy') return 'healthy';
  if (normalized === 'unhealthy') return 'unhealthy';
  if (normalized === 'degraded') return 'degraded';
  if (normalized === 'unknown') return 'unknown';
  if (normalized === 'disabled') return 'disabled';
  return null;
}

function parseStoredRuntimeHealth(extraConfig: unknown): CloudflareRuntimeHealthRecord | null {
  const parsed = parseAccountExtraConfig(extraConfig);
  const runtimeHealthRaw = parsed.runtimeHealth;
  if (!runtimeHealthRaw || typeof runtimeHealthRaw !== 'object' || Array.isArray(runtimeHealthRaw)) {
    return null;
  }
  const runtimeHealth = runtimeHealthRaw as Record<string, unknown>;
  const state = normalizeCloudflareRuntimeHealthState(runtimeHealth.state);
  if (!state) return null;
  const reason = String(runtimeHealth.reason || '').trim();
  const source = String(runtimeHealth.source || '').trim();
  const checkedAtRaw = String(runtimeHealth.checkedAt || '').trim();
  return {
    state,
    reason: reason || (state === 'healthy' ? '运行状态正常' : state === 'disabled' ? '账号或站点已禁用' : '尚未检测'),
    source: source || 'unknown',
    checkedAt: checkedAtRaw || null,
  };
}

function buildRuntimeHealthRecord(input: {
  state: CloudflareRuntimeHealthState;
  reason?: string | null;
  source?: string | null;
  checkedAt?: string | null;
}): CloudflareRuntimeHealthRecord {
  const state = normalizeCloudflareRuntimeHealthState(input.state) || 'unknown';
  return {
    state,
    reason: String(input.reason || '').trim()
      || (state === 'healthy'
        ? '运行状态正常'
        : state === 'disabled'
          ? '账号或站点已禁用'
          : state === 'unhealthy'
            ? '最近一次检查失败'
            : '尚未检测'),
    source: String(input.source || '').trim() || 'manual',
    checkedAt: String(input.checkedAt || '').trim() || new Date().toISOString(),
  };
}

function buildAccountRuntimeHealthView(input: {
  accountStatus: string | null | undefined;
  siteStatus: string | null | undefined;
  extraConfig: unknown;
}): CloudflareRuntimeHealthRecord {
  const stored = parseStoredRuntimeHealth(input.extraConfig);
  if (stored) return stored;
  const accountStatus = String(input.accountStatus || '').trim().toLowerCase();
  const siteStatus = String(input.siteStatus || '').trim().toLowerCase();
  if (accountStatus !== 'active' || siteStatus !== 'active') {
    return buildRuntimeHealthRecord({
      state: 'disabled',
      reason: accountStatus !== 'active' ? '账号已禁用' : '站点已禁用',
      source: 'system',
      checkedAt: null,
    });
  }
  return buildRuntimeHealthRecord({
    state: 'unknown',
    reason: '尚未获取运行健康信息',
    source: 'none',
    checkedAt: null,
  });
}

function mergeAccountExtraConfig(base: unknown, patch: Record<string, unknown>): string | null {
  const merged = {
    ...parseAccountExtraConfig(base),
    ...patch,
  };
  const normalizedEntries = Object.entries(merged).filter(([, value]) => value !== undefined);
  if (normalizedEntries.length === 0) return null;
  return JSON.stringify(Object.fromEntries(normalizedEntries));
}

function getCredentialModeFromExtraConfig(extraConfig: unknown): CloudflareAccountCredentialMode | undefined {
  const parsed = parseAccountExtraConfig(extraConfig);
  const normalized = String(parsed.credentialMode || '').trim().toLowerCase();
  if (normalized === 'session') return 'session';
  if (normalized === 'apikey') return 'apikey';
  if (normalized === 'auto') return 'auto';
  return undefined;
}

function resolveStoredCredentialMode(account: typeof schema.accounts.$inferSelect): CloudflareAccountCredentialMode {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit) return explicit;
  if (String(account.apiToken || '').trim()) return 'apikey';
  if (String(account.accessToken || '').trim()) return 'session';
  return 'auto';
}

function buildCapabilitiesFromCredentialMode(credentialMode: CloudflareAccountCredentialMode): {
  canCheckin: boolean;
  canRefreshBalance: boolean;
  proxyOnly: boolean;
} {
  if (credentialMode === 'apikey') {
    return {
      canCheckin: false,
      canRefreshBalance: false,
      proxyOnly: true,
    };
  }
  return {
    canCheckin: true,
    canRefreshBalance: true,
    proxyOnly: false,
  };
}

function parseNumberArray(value: unknown): number[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  const deduped = new Set<number>();
  for (const item of parsed) {
    const number = Math.trunc(Number(item));
    if (!Number.isFinite(number) || number <= 0) continue;
    deduped.add(number);
  }
  return [...deduped.values()];
}

function parseNumberMap(value: unknown): Record<number, number> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: Record<number, number> = {};
  for (const [key, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const siteId = Math.trunc(Number(key));
    const numeric = Number(rawValue);
    if (!Number.isFinite(siteId) || siteId <= 0 || !Number.isFinite(numeric) || numeric <= 0) continue;
    result[siteId] = numeric;
  }
  return result;
}

function parseStringObject(value: unknown): Record<string, string> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const output: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const text = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim();
    if (!text) continue;
    output[key] = text;
  }
  return output;
}

function normalizeEndpointBaseUrl(raw: unknown): string | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const parsed = new URL(withProtocol);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = pathname || '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function buildModelsRequestUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (/\/(?:api\/)?v1$/i.test(pathname)) {
    parsed.pathname = `${pathname}/models`;
  } else if (pathname) {
    parsed.pathname = `${pathname}/v1/models`;
  } else {
    parsed.pathname = '/v1/models';
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function extractModelNamesFromPayload(payload: unknown): string[] {
  const queue: unknown[] = [payload];
  const models: string[] = [];
  const seenValues = new Set<unknown>();
  const seenNames = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null) continue;
    if (seenValues.has(current)) continue;
    seenValues.add(current);

    if (typeof current === 'string') {
      const normalized = current.trim();
      if (!normalized || seenNames.has(normalized.toLowerCase())) continue;
      seenNames.add(normalized.toLowerCase());
      models.push(normalized);
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      const idLike = [record.id, record.model, record.name]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find(Boolean);
      if (idLike) {
        const key = idLike.toLowerCase();
        if (!seenNames.has(key)) {
          seenNames.add(key);
          models.push(idLike);
        }
      }
      for (const nested of Object.values(record)) queue.push(nested);
    }
  }

  return models;
}

function mapProbeErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream_error';
  return 'http_error';
}

function resolveProbeToken(account: typeof schema.accounts.$inferSelect, site: typeof schema.sites.$inferSelect): string {
  return String(account.accessToken || account.apiToken || site.apiKey || '').trim();
}

function resolveProbePlatformUserId(account: typeof schema.accounts.$inferSelect): string | null {
  const extra = parseAccountExtraConfig(account.extraConfig);
  const rawId = Math.trunc(Number(extra.platformUserId));
  if (Number.isFinite(rawId) && rawId > 0) return String(rawId);
  const username = String(account.username || '').trim();
  const match = username.match(/(\d{3,8})$/);
  if (match?.[1]) return match[1];
  return null;
}

function buildProbeUserIdCandidates(account: typeof schema.accounts.$inferSelect): string[] {
  const candidates: string[] = [];
  const push = (value: unknown) => {
    const id = Math.trunc(Number(value));
    if (!Number.isFinite(id) || id <= 0) return;
    const normalized = String(id);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };
  push(resolveProbePlatformUserId(account));
  for (const fallback of [1, 2, 3, 4, 5, 10, 20, 50, 100, 8899, 11494]) {
    push(fallback);
  }
  return candidates;
}

function resolveCloudflareAccountDisplayName(account: typeof schema.accounts.$inferSelect): string | null {
  const explicit = String(account.username || '').trim();
  if (explicit) return explicit;
  if (resolveStoredCredentialMode(account) !== 'session') return null;
  const platformUserId = resolveProbePlatformUserId(account);
  if (platformUserId) return `user-${platformUserId}`;
  return null;
}

function shouldAutoUpgradeAccountUsername(username: unknown): boolean {
  const normalized = String(username || '').trim();
  if (!normalized) return true;
  if (/^unknown-user$/i.test(normalized)) return true;
  if (/^user-\d+$/i.test(normalized)) return true;
  if (/^session[-_]/i.test(normalized)) return true;
  if (/^token[-_]/i.test(normalized)) return true;
  if (/^linuxdo_\d{3,8}$/i.test(normalized)) return true;
  return false;
}

type CloudflareLoginFailureInfo = {
  message: string;
  shieldBlocked: boolean;
};

type CloudflareVerifyFailureReason =
  | 'needs-user-id'
  | 'invalid-user-id'
  | 'shield-blocked'
  | null;

type CloudflareSessionVerifySuccess = {
  tokenType: 'session';
  userInfo: {
    username: string;
    displayName?: string;
    email?: string;
    role?: number;
    userId?: string;
  };
  balance: {
    balance: number;
    used?: number;
    quota?: number;
  } | null;
  apiToken: string | null;
};

const ACCOUNT_LOGIN_TIMEOUT_MS = 12_000;
const ACCOUNT_VERIFY_TIMEOUT_MS = 12_000;

function normalizeLoginFailure(message: string | null | undefined): CloudflareLoginFailureInfo {
  const raw = String(message || '').trim();
  const lowered = raw.toLowerCase();
  const looksLikeHtmlJsonParseError = lowered.includes('unexpected token')
    && lowered.includes('not valid json')
    && (lowered.includes('<html') || lowered.includes('<script'));
  const looksLikeShieldChallenge = lowered.includes('acw_sc__v2')
    || lowered.includes('var arg1')
    || lowered.includes('captcha')
    || lowered.includes('challenge')
    || lowered.includes('cloudflare tunnel error');

  if (looksLikeHtmlJsonParseError || looksLikeShieldChallenge) {
    return {
      shieldBlocked: true,
      message: 'This site is shielded by anti-bot challenge. Account/password login is blocked. Create an API key on the target site and import that key.',
    };
  }

  return {
    shieldBlocked: false,
    message: raw || 'login failed',
  };
}

function resolveUserIdFailureReason(message: string, hasProvidedUserId: boolean): CloudflareVerifyFailureReason {
  const lowered = String(message || '').trim().toLowerCase();
  if (!lowered) return null;

  if (
    lowered.includes('mismatch')
    || lowered.includes('not match')
    || lowered.includes('invalid user id')
    || lowered.includes('wrong user id')
  ) {
    return 'invalid-user-id';
  }

  if (
    lowered.includes('missing new-api-user')
    || lowered.includes('new-api-user required')
    || lowered.includes('requires user id')
    || lowered.includes('missing user id')
  ) {
    return 'needs-user-id';
  }

  if (lowered.includes('new-api-user') || lowered.includes('user id')) {
    return hasProvidedUserId ? 'invalid-user-id' : 'needs-user-id';
  }

  return null;
}

function buildVerificationFailurePayload(reason: CloudflareVerifyFailureReason): Record<string, unknown> | null {
  if (reason === 'needs-user-id') {
    return {
      success: false,
      needsUserId: true,
      message: 'This site requires a user ID. Please fill in your site user ID.',
    };
  }
  if (reason === 'invalid-user-id') {
    return {
      success: false,
      invalidUserId: true,
      message: 'The provided user ID does not match this token. Please check your site user ID.',
    };
  }
  if (reason === 'shield-blocked') {
    return {
      success: false,
      shieldBlocked: true,
      message: 'This site is shielded by anti-bot challenge. Create an API key on the target site and import that key.',
    };
  }
  return null;
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseJsonSafe(raw: string): unknown | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractMessageFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const root = payload as Record<string, unknown>;
  const direct = root.message;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const err = root.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    const nested = (err as Record<string, unknown>).message;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return '';
}

function isShieldChallengeResponse(contentType: string, bodyText: string): boolean {
  const normalizedType = String(contentType || '').toLowerCase();
  const normalizedBody = String(bodyText || '').toLowerCase();
  if (!normalizedBody) return false;
  const isHtml = normalizedType.includes('text/html')
    || normalizedBody.includes('<html')
    || normalizedBody.includes('<script');
  if (!isHtml) return false;
  return normalizedBody.includes('acw_sc__v2')
    || normalizedBody.includes('var arg1')
    || normalizedBody.includes('cdn_sec_tc')
    || normalizedBody.includes('captcha')
    || normalizedBody.includes('challenge');
}

function splitSetCookieHeader(raw: string): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  const parts = text
    .split(/,\s*(?=[A-Za-z0-9_\-]+=)/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

function sanitizeCookiePairs(raw: string): string {
  const pairs = splitSetCookieHeader(raw)
    .map((cookie) => cookie.split(';')[0]?.trim() || '')
    .filter((cookie) => cookie.includes('='));
  return pairs.join('; ');
}

function extractAccessTokenFromLoginPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    root.data,
    root.token,
    root.access_token,
    root.accessToken,
    root.session,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      for (const key of ['token', 'access_token', 'accessToken', 'session', 'cookie']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
  }
  return null;
}

function parseNumericUserId(value: unknown): number | null {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function guessPlatformUserIdFromUsername(username: string): number | null {
  const match = String(username || '').trim().match(/(\d{3,8})$/);
  if (!match?.[1]) return null;
  return parseNumericUserId(match[1]);
}

function buildVerifyUserIdCandidates(platformUserId: number | null): string[] {
  const candidates: string[] = [];
  const push = (value: unknown) => {
    const normalized = parseNumericUserId(value);
    if (!normalized) return;
    const text = String(normalized);
    if (!candidates.includes(text)) candidates.push(text);
  };
  push(platformUserId);
  for (const fallback of [1, 2, 3, 4, 5, 10, 20, 50, 100, 8899, 11494]) {
    push(fallback);
  }
  return candidates;
}

function chooseFailureReason(
  previous: CloudflareVerifyFailureReason,
  next: CloudflareVerifyFailureReason,
): CloudflareVerifyFailureReason {
  if (next === 'invalid-user-id') return 'invalid-user-id';
  if (previous === 'invalid-user-id') return previous;
  if (next === 'needs-user-id') return 'needs-user-id';
  if (previous === 'needs-user-id') return previous;
  if (next === 'shield-blocked') return 'shield-blocked';
  return previous;
}

function parseSessionVerifyDataToUserInfo(data: Record<string, unknown>): {
  username: string;
  displayName?: string;
  email?: string;
  role?: number;
  userId?: string;
} {
  const userIdValue = data.id ?? data.userId ?? data.user_id;
  const userId = parseNumericUserId(userIdValue);
  const displayName = String(data.display_name ?? data.displayName ?? '').trim();
  const usernameCandidate = displayName || data.username;
  const username = String(
    usernameCandidate
    ?? data.email
    ?? (userId ? `user-${userId}` : ''),
  ).trim() || (userId ? `user-${userId}` : 'unknown-user');
  const email = String(data.email ?? '').trim();
  const role = Number.isFinite(Number(data.role)) ? Number(data.role) : undefined;
  return {
    username,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(typeof role === 'number' ? { role } : {}),
    ...(userId ? { userId: String(userId) } : {}),
  };
}

function parseSessionVerifyBalance(
  data: Record<string, unknown>,
  platform: string,
): { balance: number; used?: number; quota?: number } | null {
  const rawQuota = Number(data.quota ?? data.remain_quota ?? data.remaining_quota ?? data.total_available);
  const rawUsed = Number(data.used_quota ?? data.usedQuota ?? data.total_used ?? 0);
  if (!Number.isFinite(rawQuota) || !Number.isFinite(rawUsed)) return null;
  const scale = mapQuotaUnitScale(platform);
  const quotaUnit = rawQuota / scale;
  const usedUnit = rawUsed / scale;
  const remainingMode = shouldTreatQuotaAsRemaining(platform);
  const balance = remainingMode ? quotaUnit : quotaUnit - usedUnit;
  const quota = remainingMode ? quotaUnit + usedUnit : quotaUnit;
  return {
    balance: roundCurrency(balance),
    used: roundCurrency(usedUnit),
    quota: roundCurrency(quota),
  };
}

function extractApiTokenItemsFromPayload(payload: unknown): Array<{ key: string; enabled: boolean }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const root = payload as Record<string, unknown>;
  const source = Array.isArray(root.data)
    ? root.data
    : (root.data && typeof root.data === 'object' && !Array.isArray(root.data) && Array.isArray((root.data as Record<string, unknown>).items))
      ? (root.data as Record<string, unknown>).items as unknown[]
      : Array.isArray(root.items)
        ? root.items
        : [];
  const output: Array<{ key: string; enabled: boolean }> = [];
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const key = String(row.key ?? row.token ?? row.api_token ?? '').trim();
    if (!key) continue;
    const status = Number(row.status);
    const enabled = typeof row.enabled === 'boolean'
      ? row.enabled
      : (!Number.isFinite(status) || status === 1);
    output.push({ key, enabled });
  }
  return output;
}

async function fetchApiTokenBySession(
  endpointBaseUrl: string,
  headerAttempts: Array<Record<string, string>>,
): Promise<string | null> {
  const endpoint = normalizeEndpointBaseUrl(endpointBaseUrl);
  if (!endpoint) return null;
  for (const headers of headerAttempts) {
    const response = await fetch(`${endpoint}/api/token/?p=0&size=100`, {
      method: 'GET',
      headers,
    }).catch(() => null);
    if (!response || !response.ok) continue;
    const payload = await response.json().catch(() => null);
    const items = extractApiTokenItemsFromPayload(payload);
    const preferred = items.find((item) => item.enabled)?.key || items[0]?.key;
    if (preferred) return preferred;
  }
  return null;
}

async function getNextAccountSortOrder(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<number> {
  const rows = await db
    .select({ sortOrder: schema.accounts.sortOrder })
    .from(schema.accounts)
    .all();
  const max = rows.reduce((currentMax, row) => Math.max(currentMax, row.sortOrder || 0), -1);
  return max + 1;
}

function buildSessionVerifyHeaderAttempts(
  site: typeof schema.sites.$inferSelect,
  token: string,
  platformUserId: number | null,
): Array<Record<string, string>> {
  const attempts: Array<Record<string, string>> = [];
  const appendUnique = (headers: Record<string, string>) => {
    const key = JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)));
    if (!attempts.some((item) => JSON.stringify(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) === key)) {
      attempts.push(headers);
    }
  };
  const userIdCandidates = buildVerifyUserIdCandidates(platformUserId);
  if (platformUserId) {
    appendUnique(buildProbeHeaders(site, token, String(platformUserId)));
  }
  appendUnique(buildProbeHeaders(site, token, null));
  for (const userId of userIdCandidates) {
    appendUnique(buildProbeHeaders(site, token, userId));
  }

  const cookieCandidates = buildSessionCookieCandidates(token);
  for (const cookie of cookieCandidates) {
    appendUnique({
      Accept: 'application/json',
      Cookie: cookie,
      ...(platformUserId ? { 'New-Api-User': String(platformUserId), 'User-ID': String(platformUserId) } : {}),
    });
    for (const userId of userIdCandidates) {
      appendUnique({
        Accept: 'application/json',
        Cookie: cookie,
        'New-Api-User': userId,
        'User-ID': userId,
        'User-id': userId,
      });
    }
    appendUnique({
      Accept: 'application/json',
      Cookie: cookie,
    });
  }
  return attempts;
}

function buildSessionApiTokenHeaderAttempts(
  site: typeof schema.sites.$inferSelect,
  token: string,
  preferredUserId: number | null,
  preferredHeaders?: Record<string, string>,
): Array<Record<string, string>> {
  const attempts: Array<Record<string, string>> = [];
  const appendUnique = (headers: Record<string, string>) => {
    const key = JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)));
    if (!attempts.some((item) => JSON.stringify(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) === key)) {
      attempts.push(headers);
    }
  };
  if (preferredHeaders && Object.keys(preferredHeaders).length > 0) {
    appendUnique(preferredHeaders);
  }
  const userIdCandidates = buildVerifyUserIdCandidates(preferredUserId);
  if (preferredUserId) {
    appendUnique(buildProbeHeaders(site, token, String(preferredUserId)));
  }
  appendUnique(buildProbeHeaders(site, token, null));
  for (const userId of userIdCandidates) {
    appendUnique(buildProbeHeaders(site, token, userId));
  }
  for (const cookie of buildSessionCookieCandidates(token)) {
    appendUnique({
      Accept: 'application/json',
      Cookie: cookie,
      ...(preferredUserId ? { 'New-Api-User': String(preferredUserId), 'User-ID': String(preferredUserId) } : {}),
    });
  }
  return attempts;
}

async function performSessionTokenVerification(input: {
  site: typeof schema.sites.$inferSelect;
  token: string;
  platformUserId: number | null;
}): Promise<
  | { success: true; result: CloudflareSessionVerifySuccess }
  | { success: false; reason: CloudflareVerifyFailureReason; message: string }
> {
  const endpoint = normalizeEndpointBaseUrl(input.site.url);
  if (!endpoint) {
    return { success: false, reason: null, message: '站点地址无效' };
  }

  const timeoutMessage = `Token verification timed out (${Math.max(1, Math.round(ACCOUNT_VERIFY_TIMEOUT_MS / 1000))}s)`;
  const headerAttempts = buildSessionVerifyHeaderAttempts(input.site, input.token, input.platformUserId);
  let failureReason: CloudflareVerifyFailureReason = null;
  let lastMessage = 'Session Token 验证失败';

  for (const headers of headerAttempts) {
    const result = await withTimeout(async () => {
      const response = await fetch(`${endpoint}/api/user/self`, {
        method: 'GET',
        headers,
      }).catch(() => null);
      if (!response) {
        return { ok: false as const, message: 'request failed', reason: null as CloudflareVerifyFailureReason };
      }
      const contentType = String(response.headers.get('content-type') || '');
      const bodyText = await response.text();
      const payload = parseJsonSafe(bodyText);
      if (isShieldChallengeResponse(contentType, bodyText)) {
        return { ok: false as const, message: 'shield challenge blocked verification', reason: 'shield-blocked' as CloudflareVerifyFailureReason };
      }
      if (!response.ok) {
        const message = extractMessageFromPayload(payload) || `HTTP ${response.status}`;
        const reason = resolveUserIdFailureReason(message, input.platformUserId != null);
        return { ok: false as const, message, reason };
      }
      const data = toBalanceDataFromPayload(payload);
      if (!data) {
        const message = extractMessageFromPayload(payload) || '未获取到用户信息';
        const reason = resolveUserIdFailureReason(message, input.platformUserId != null);
        return { ok: false as const, message, reason };
      }
      return { ok: true as const, data, headers };
    }, ACCOUNT_VERIFY_TIMEOUT_MS, timeoutMessage).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : timeoutMessage,
      reason: null as CloudflareVerifyFailureReason,
    }));

    if (!result.ok) {
      lastMessage = result.message || lastMessage;
      failureReason = chooseFailureReason(failureReason, result.reason);
      continue;
    }

    const userInfo = parseSessionVerifyDataToUserInfo(result.data);
    const parsedUserId = parseNumericUserId(result.data.id ?? result.data.userId ?? result.data.user_id);
    const apiToken = await fetchApiTokenBySession(
      endpoint,
      buildSessionApiTokenHeaderAttempts(input.site, input.token, parsedUserId ?? input.platformUserId, result.headers),
    );
    const balance = parseSessionVerifyBalance(result.data, String(input.site.platform || ''));
    return {
      success: true,
      result: {
        tokenType: 'session',
        userInfo,
        balance,
        apiToken,
      },
    };
  }

  return {
    success: false,
    reason: failureReason,
    message: lastMessage || 'Session Token 验证失败',
  };
}

async function performApiKeyVerification(input: {
  db: ReturnType<typeof getCloudflareDb>;
  site: typeof schema.sites.$inferSelect;
  token: string;
  platformUserId: number | null;
}): Promise<
  | { success: true; models: string[] }
  | { success: false; reason: CloudflareVerifyFailureReason; message: string }
> {
  const endpoints = await resolveSiteProbeEndpoints(input.db, input.site);
  if (endpoints.length === 0) {
    return { success: false, reason: null, message: '未配置可用站点地址' };
  }

  const primaryHeaders = buildProbeHeaders(
    input.site,
    input.token,
    input.platformUserId ? String(input.platformUserId) : null,
  );

  let failureReason: CloudflareVerifyFailureReason = null;
  let lastMessage = 'API Key 验证失败';
  for (const endpoint of endpoints) {
    const result = await fetchModelsViaEndpoint(endpoint, primaryHeaders, ACCOUNT_VERIFY_TIMEOUT_MS);
    if (result.success) {
      const deduped = [...new Map(result.models.map((model) => [model.toLowerCase(), model])).values()];
      if (deduped.length > 0) return { success: true, models: deduped };
      continue;
    }
    const userReason = resolveUserIdFailureReason(result.errorMessage, input.platformUserId != null);
    failureReason = chooseFailureReason(failureReason, userReason);
    if (result.upstreamMessage && /shield|challenge|captcha|acw_sc__v2|var arg1/i.test(result.upstreamMessage)) {
      failureReason = chooseFailureReason(failureReason, 'shield-blocked');
    }
    lastMessage = result.errorMessage || lastMessage;
  }

  return {
    success: false,
    reason: failureReason,
    message: lastMessage || 'API Key 验证失败',
  };
}

async function performUpstreamLogin(input: {
  site: typeof schema.sites.$inferSelect;
  username: string;
  password: string;
}): Promise<{ success: true; accessToken: string } | { success: false; message: string; shieldBlocked: boolean }> {
  const endpoint = normalizeEndpointBaseUrl(input.site.url);
  if (!endpoint) {
    return { success: false, message: '站点地址无效', shieldBlocked: false };
  }
  const payload = JSON.stringify({
    username: input.username,
    password: input.password,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json',
    ...parseStringObject(input.site.customHeaders),
  };

  try {
    const response = await withTimeout(
      () => fetch(`${endpoint}/api/user/login`, {
        method: 'POST',
        headers,
        body: payload,
      }),
      ACCOUNT_LOGIN_TIMEOUT_MS,
      `登录请求超时（${Math.max(1, Math.round(ACCOUNT_LOGIN_TIMEOUT_MS / 1000))}s）`,
    );
    const rawText = await response.text();
    const contentType = String(response.headers.get('content-type') || '');
    const parsed = parseJsonSafe(rawText);
    if (isShieldChallengeResponse(contentType, rawText)) {
      const normalized = normalizeLoginFailure('shield challenge blocked login');
      return { success: false, message: normalized.message, shieldBlocked: normalized.shieldBlocked };
    }
    if (!response.ok) {
      const message = extractMessageFromPayload(parsed) || `HTTP ${response.status}`;
      const normalized = normalizeLoginFailure(message);
      return { success: false, message: normalized.message, shieldBlocked: normalized.shieldBlocked };
    }
    const accessToken = extractAccessTokenFromLoginPayload(parsed);
    const setCookieRaw = response.headers.get('set-cookie');
    const cookieToken = sanitizeCookiePairs(setCookieRaw || '');
    const resolvedToken = accessToken || cookieToken;
    if (!resolvedToken) {
      const message = extractMessageFromPayload(parsed) || '登录失败：未获取到可用会话凭据，请改用 Cookie/Token 导入';
      const normalized = normalizeLoginFailure(message);
      return { success: false, message: normalized.message, shieldBlocked: normalized.shieldBlocked };
    }
    return {
      success: true,
      accessToken: resolvedToken,
    };
  } catch (error: unknown) {
    const normalized = normalizeLoginFailure(error instanceof Error ? error.message : '登录请求失败');
    return { success: false, message: normalized.message, shieldBlocked: normalized.shieldBlocked };
  }
}

type CloudflareCheckinResult = {
  status: 'success' | 'failed' | 'skipped';
  message: string;
  reward: string;
  runtimeState: CloudflareRuntimeHealthState;
  runtimeReason: string;
};

function isAlreadyCheckedInMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = String(message).trim();
  if (!text) return false;
  const normalized = text.toLowerCase();
  return normalized.includes('already checked in')
    || normalized.includes('already signed')
    || normalized.includes('already sign in')
    || text.includes('今日已签到')
    || text.includes('今天已签到')
    || text.includes('今天已经签到')
    || text.includes('今日已经签到')
    || text.includes('已经签到')
    || text.includes('已签到')
    || text.includes('重复签到')
    || text.includes('签到过');
}

function isUnsupportedCheckinMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = String(message).toLowerCase();
  return text.includes('invalid url (post /api/user/checkin)')
    || (text.includes('http 404') && text.includes('/api/user/checkin'))
    || text.includes('checkin endpoint not found')
    || text.includes('check-in is not supported')
    || text.includes('checkin is not supported')
    || text.includes('does not support checkin')
    || text.includes('not support checkin');
}

function isManualVerificationRequiredMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = String(message).toLowerCase();
  return text.includes('turnstile token 为空')
    || (text.includes('turnstile') && (text.includes('token') || text.includes('校验') || text.includes('验证')));
}

function isRateLimitedCheckinMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = String(message).toLowerCase();
  return text.includes('too many requests')
    || text.includes('rate limit')
    || text.includes('请求过于频繁')
    || text.includes('频率过高')
    || text.includes('访问过快')
    || text.includes('操作频繁');
}

function parseRetryAfterSeconds(retryAfterHeader?: string | null): number | null {
  const raw = String(retryAfterHeader || '').trim();
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return null;
  const deltaSeconds = Math.ceil((retryAt - Date.now()) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : null;
}

function parseCheckinReward(payload: unknown, fallbackMessage: string): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const root = payload as Record<string, unknown>;
    const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? root.data as Record<string, unknown>
      : null;
    const rewardCandidates = [
      root.reward,
      data?.reward,
      data?.amount,
      data?.quota,
      data?.grant,
    ];
    for (const candidate of rewardCandidates) {
      const text = String(candidate ?? '').trim();
      if (!text) continue;
      if (text === '0' || text === '0.0' || text === '0.00') continue;
      return text;
    }
  }
  const parsed = parseRewardNumber(fallbackMessage);
  return parsed > 0 ? String(parsed) : '';
}

async function performUpstreamCheckin(input: {
  site: typeof schema.sites.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
}): Promise<CloudflareCheckinResult> {
  const endpoint = normalizeEndpointBaseUrl(input.site.url);
  if (!endpoint) {
    return {
      status: 'failed',
      message: '站点地址无效',
      reward: '',
      runtimeState: 'unhealthy',
      runtimeReason: '站点地址无效',
    };
  }
  const token = String(input.account.accessToken || '').trim();
  if (!token) {
    return {
      status: 'failed',
      message: '缺少有效 Session Token',
      reward: '',
      runtimeState: 'unhealthy',
      runtimeReason: '缺少有效 Session Token',
    };
  }
  const platformUserId = parseNumericUserId(resolveProbePlatformUserId(input.account));
  const headerAttempts = buildSessionVerifyHeaderAttempts(input.site, token, platformUserId);
  const timeoutMessage = `checkin timed out (${Math.max(1, Math.round(ACCOUNT_VERIFY_TIMEOUT_MS / 1000))}s)`;
  let lastError = '签到失败';

  for (const headers of headerAttempts) {
    const responseResult = await withTimeout(
      async () => {
        try {
          const response = await fetch(`${endpoint}/api/user/checkin`, {
            method: 'POST',
            headers: {
              ...headers,
              'Content-Type': headers['Content-Type'] || headers['content-type'] || 'application/json',
            },
            body: '{}',
          });
          return { response } as const;
        } catch (error: unknown) {
          return { error } as const;
        }
      },
      ACCOUNT_VERIFY_TIMEOUT_MS,
      timeoutMessage,
    ).catch((error: unknown) => ({ error } as const));

    if ('error' in responseResult) {
      const errorMessage = responseResult.error instanceof Error
        ? String(responseResult.error.message || '').trim()
        : '';
      if (errorMessage) {
        lastError = errorMessage;
      }
      continue;
    }
    const response = responseResult.response;

    const contentType = String(response.headers.get('content-type') || '');
    const bodyText = await response.text();
    const payload = parseJsonSafe(bodyText);
    if (isShieldChallengeResponse(contentType, bodyText)) {
      lastError = 'This site is shielded by anti-bot challenge. Checkin request blocked.';
      continue;
    }

    const upstreamMessage = extractMessageFromPayload(payload) || bodyText.trim() || `HTTP ${response.status}`;
    const alreadyCheckedIn = isAlreadyCheckedInMessage(upstreamMessage);
    const unsupportedCheckin = isUnsupportedCheckinMessage(upstreamMessage);
    const manualVerificationRequired = isManualVerificationRequiredMessage(upstreamMessage);
    const rateLimited = response.status === 429 || isRateLimitedCheckinMessage(upstreamMessage);
    const successByPayload = !!(payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as Record<string, unknown>).success === true);
    const reward = parseCheckinReward(payload, upstreamMessage);

    if (successByPayload || alreadyCheckedIn) {
      return {
        status: 'success',
        message: alreadyCheckedIn ? '今天已经签到' : (upstreamMessage || '签到成功'),
        reward,
        runtimeState: 'healthy',
        runtimeReason: alreadyCheckedIn ? '今日已签到' : '签到成功',
      };
    }

    if (unsupportedCheckin || manualVerificationRequired) {
      return {
        status: 'skipped',
        message: manualVerificationRequired ? '站点开启了 Turnstile 校验，需要人工签到' : upstreamMessage,
        reward: '',
        runtimeState: 'degraded',
        runtimeReason: manualVerificationRequired ? '站点开启了 Turnstile 校验，需要人工签到' : '站点不支持签到接口',
      };
    }

    if (rateLimited) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
      return {
        status: 'skipped',
        message: retryAfterSeconds
          ? `签到请求过于频繁，建议 ${retryAfterSeconds} 秒后重试`
          : '签到请求过于频繁，请稍后重试',
        reward: '',
        runtimeState: 'degraded',
        runtimeReason: '签到请求触发限流',
      };
    }

    if (!response.ok) {
      lastError = upstreamMessage || `HTTP ${response.status}`;
      continue;
    }

    lastError = upstreamMessage || lastError;
  }

  return {
    status: 'failed',
    message: lastError || '签到失败',
    reward: '',
    runtimeState: 'unhealthy',
    runtimeReason: lastError || '签到失败',
  };
}

type ProbeFetchResult =
  | { success: true; models: string[]; latencyMs: number; endpointUrl: string }
  | {
    success: false;
    errorCode: string;
    errorMessage: string;
    endpointUrl: string;
    latencyMs: number;
    httpStatus?: number;
    upstreamMessage?: string;
  };

async function fetchModelsViaEndpoint(
  endpointUrl: string,
  headers: Record<string, string>,
  timeoutMs = 12_000,
): Promise<ProbeFetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(buildModelsRequestUrl(endpointUrl), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const rawText = await response.text();
    let payload: unknown = null;
    if (rawText.trim()) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = rawText;
      }
    }

    if (!response.ok) {
      const upstreamMessage = extractMessageFromPayload(payload);
      return {
        success: false,
        endpointUrl,
        latencyMs,
        httpStatus: response.status,
        errorCode: mapProbeErrorCode(response.status),
        errorMessage: upstreamMessage || `HTTP ${response.status}`,
        upstreamMessage: upstreamMessage || undefined,
      };
    }

    const models = extractModelNamesFromPayload(payload);
    if (models.length === 0) {
      return {
        success: false,
        endpointUrl,
        latencyMs,
        errorCode: 'empty_models',
        errorMessage: '未获取到模型列表',
      };
    }

    return {
      success: true,
      models,
      latencyMs,
      endpointUrl,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : 'fetch failed';
    return {
      success: false,
      endpointUrl,
      latencyMs,
      errorCode: message.toLowerCase().includes('abort') ? 'timeout' : 'fetch_failed',
      errorMessage: message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveSiteProbeEndpoints(
  db: ReturnType<typeof getCloudflareDb>,
  site: typeof schema.sites.$inferSelect,
): Promise<string[]> {
  const endpointRows = await db
    .select({
      url: schema.siteApiEndpoints.url,
      enabled: schema.siteApiEndpoints.enabled,
      sortOrder: schema.siteApiEndpoints.sortOrder,
    })
    .from(schema.siteApiEndpoints)
    .where(eq(schema.siteApiEndpoints.siteId, site.id))
    .all();

  const sorted = endpointRows
    .filter((row) => row.enabled !== false)
    .sort((left, right) => Math.trunc(toFiniteNumber(left.sortOrder)) - Math.trunc(toFiniteNumber(right.sortOrder)));

  const candidates = [
    ...sorted.map((row) => row.url),
    site.url,
  ];

  const deduped = new Map<string, string>();
  for (const candidate of candidates) {
    const normalized = normalizeEndpointBaseUrl(candidate);
    if (!normalized) continue;
    if (!deduped.has(normalized)) deduped.set(normalized, normalized);
  }
  return [...deduped.values()];
}

function buildProbeHeaders(
  site: typeof schema.sites.$inferSelect,
  token: string,
  platformUserId?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const siteHeaders = parseStringObject(site.customHeaders);
  for (const [key, value] of Object.entries(siteHeaders)) {
    headers[key] = value;
  }

  const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
  if (!hasAuthorization && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (platformUserId) {
    headers['New-Api-User'] = platformUserId;
    headers['New-API-User'] = platformUserId;
    headers['User-id'] = platformUserId;
    headers['User-ID'] = platformUserId;
    headers['Veloera-User'] = platformUserId;
    headers['voapi-user'] = platformUserId;
    headers['Rix-Api-User'] = platformUserId;
    headers['neo-api-user'] = platformUserId;
  }
  return headers;
}

function parseUserSelfPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  if (root.success === false) return null;
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

function buildSessionCookieCandidates(token: string): string[] {
  const trimmed = token.trim();
  if (!trimmed) return [];
  const raw = trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
  if (!raw) return [];
  const candidates: string[] = [];
  if (raw.includes('=')) candidates.push(raw);
  candidates.push(`session=${raw}`);
  candidates.push(`token=${raw}`);
  return Array.from(new Set(candidates));
}

function toBalanceDataFromPayload(raw: unknown): Record<string, unknown> | null {
  const parsed = parseUserSelfPayload(raw);
  if (parsed) return parsed;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;
  const maybeData = root.data;
  if (maybeData && typeof maybeData === 'object' && !Array.isArray(maybeData)) {
    return maybeData as Record<string, unknown>;
  }
  return null;
}

function extractModelsFromPayload(raw: unknown): string[] {
  const parseFromValue = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object') {
            const row = item as Record<string, unknown>;
            return String(row.id || row.model || row.name || '').trim();
          }
          return '';
        })
        .filter(Boolean);
    }
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).map((item) => item.trim()).filter(Boolean);
    }
    return [];
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const root = raw as Record<string, unknown>;
  if (root.success === false) return [];
  const direct = parseFromValue(root.data);
  if (direct.length > 0) return Array.from(new Set(direct));
  const fallback = parseFromValue(root.models);
  if (fallback.length > 0) return Array.from(new Set(fallback));
  return [];
}

function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mapQuotaUnitScale(platform: string): number {
  const normalized = platform.trim().toLowerCase();
  if (normalized === 'veloera') return 1_000_000;
  return 500_000;
}

function shouldTreatQuotaAsRemaining(platform: string): boolean {
  const normalized = platform.trim().toLowerCase();
  return normalized === 'new-api' || normalized === 'anyrouter' || normalized === 'donehub';
}

async function refreshAccountBalanceFromUpstream(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect | null | undefined,
): Promise<{ balance: number; used: number; quota: number; username: string | null } | null> {
  if (!site) return null;
  if (String(account.status || '').trim().toLowerCase() !== 'active') return null;
  if (String(site.status || '').trim().toLowerCase() !== 'active') return null;

  const token = resolveProbeToken(account, site);
  if (!token) return null;
  const endpoint = normalizeEndpointBaseUrl(site.url);
  if (!endpoint) return null;

  const runUserSelfRequest = async (headers: Record<string, string>): Promise<Record<string, unknown> | null> => {
    const response = await fetch(`${endpoint}/api/user/self`, {
      method: 'GET',
      headers,
    }).catch(() => null);
    if (!response || !response.ok) return null;
    const payload = await response.json().catch(() => null);
    return toBalanceDataFromPayload(payload);
  };

  const platformUserId = resolveProbePlatformUserId(account);
  const platformUserIdCandidates = buildProbeUserIdCandidates(account);
  const headerAttempts: Array<Record<string, string>> = [];
  headerAttempts.push(buildProbeHeaders(site, token, platformUserId));
  if (platformUserId) {
    headerAttempts.push(buildProbeHeaders(site, token, null));
  }
  for (const candidate of platformUserIdCandidates) {
    headerAttempts.push(buildProbeHeaders(site, token, candidate));
  }

  let data: Record<string, unknown> | null = null;
  for (const headers of headerAttempts) {
    data = await runUserSelfRequest(headers);
    if (data) break;
  }

  if (!data) {
    const cookieCandidates = buildSessionCookieCandidates(token);
    const fallbackHeaders: Array<Record<string, string>> = [];
    for (const cookie of cookieCandidates) {
      fallbackHeaders.push({
        Accept: 'application/json',
        Cookie: cookie,
        ...(platformUserId ? { 'New-Api-User': platformUserId, 'User-ID': platformUserId } : {}),
      });
      for (const candidate of platformUserIdCandidates) {
        fallbackHeaders.push({
          Accept: 'application/json',
          Cookie: cookie,
          'New-Api-User': candidate,
          'User-ID': candidate,
          'User-id': candidate,
        });
      }
      fallbackHeaders.push({
        Accept: 'application/json',
        Cookie: cookie,
      });
    }
    for (const headers of fallbackHeaders) {
      data = await runUserSelfRequest(headers);
      if (data) break;
    }
  }

  if (!data) return null;

  const rawQuota = Number(data.quota ?? data.remain_quota ?? data.remaining_quota ?? data.total_available);
  const rawUsed = Number(data.used_quota ?? data.usedQuota ?? data.total_used ?? 0);
  if (!Number.isFinite(rawQuota) || !Number.isFinite(rawUsed)) return null;
  const username = String(data.display_name ?? data.displayName ?? data.username ?? '').trim() || null;

  const scale = mapQuotaUnitScale(String(site.platform || ''));
  const quotaUnit = rawQuota / scale;
  const usedUnit = rawUsed / scale;
  const remainingMode = shouldTreatQuotaAsRemaining(String(site.platform || ''));

  const balance = remainingMode ? quotaUnit : quotaUnit - usedUnit;
  const quota = remainingMode ? quotaUnit + usedUnit : quotaUnit;
  return {
    balance: roundCurrency(balance),
    used: roundCurrency(usedUnit),
    quota: roundCurrency(quota),
    username,
  };
}

async function fetchModelsViaSessionApi(
  endpointUrl: string,
  site: typeof schema.sites.$inferSelect,
  account: typeof schema.accounts.$inferSelect,
  token: string,
): Promise<{ models: string[]; latencyMs: number } | null> {
  const normalizedEndpoint = normalizeEndpointBaseUrl(endpointUrl);
  if (!normalizedEndpoint) return null;
  const platformUserId = resolveProbePlatformUserId(account);
  const platformUserIdCandidates = buildProbeUserIdCandidates(account);
  const startedAt = Date.now();

  const readModels = async (headers: Record<string, string>): Promise<string[] | null> => {
    const response = await fetch(`${normalizedEndpoint}/api/user/models`, {
      method: 'GET',
      headers,
    }).catch(() => null);
    if (!response || !response.ok) return null;
    const payload = await response.json().catch(() => null);
    const models = extractModelsFromPayload(payload);
    return models.length > 0 ? models : null;
  };

  const headerAttempts: Array<Record<string, string>> = [];
  headerAttempts.push(buildProbeHeaders(site, token, platformUserId));
  headerAttempts.push(buildProbeHeaders(site, token, null));
  for (const candidate of platformUserIdCandidates) {
    headerAttempts.push(buildProbeHeaders(site, token, candidate));
  }
  for (const headers of headerAttempts) {
    const models = await readModels(headers);
    if (models && models.length > 0) {
      return {
        models: Array.from(new Set(models)),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  const cookieCandidates = buildSessionCookieCandidates(token);
  for (const cookie of cookieCandidates) {
    const cookieHeaders: Array<Record<string, string>> = [];
    cookieHeaders.push({
      Accept: 'application/json',
      Cookie: cookie,
      ...(platformUserId ? { 'New-Api-User': platformUserId, 'User-ID': platformUserId } : {}),
    });
    for (const candidate of platformUserIdCandidates) {
      cookieHeaders.push({
        Accept: 'application/json',
        Cookie: cookie,
        'New-Api-User': candidate,
        'User-ID': candidate,
        'User-id': candidate,
      });
    }
    cookieHeaders.push({
      Accept: 'application/json',
      Cookie: cookie,
    });
    for (const headers of cookieHeaders) {
      const models = await readModels(headers);
      if (models && models.length > 0) {
        return {
          models: Array.from(new Set(models)),
          latencyMs: Date.now() - startedAt,
        };
      }
    }
  }

  return null;
}

async function upsertAccountModelAvailability(
  db: ReturnType<typeof getCloudflareDb>,
  accountId: number,
  models: string[],
  latencyMs: number,
) {
  await db
    .delete(schema.modelAvailability)
    .where(and(
      eq(schema.modelAvailability.accountId, accountId),
      sql`${schema.modelAvailability.isManual} is null or ${schema.modelAvailability.isManual} = 0`,
    ))
    .run();

  const checkedAt = formatUtcSqlDateTime();
  for (const modelName of models) {
    await db.insert(schema.modelAvailability).values({
      accountId,
      modelName,
      available: true,
      isManual: false,
      latencyMs,
      checkedAt,
    }).onConflictDoUpdate({
      target: [schema.modelAvailability.accountId, schema.modelAvailability.modelName],
      set: {
        available: true,
        isManual: false,
        latencyMs,
        checkedAt,
      },
    }).run();
  }
}

type AccountProbeRefresh = {
  status: 'success' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
  modelCount: number;
  modelsPreview: string[];
  models: string[];
  endpointUrl: string | null;
  latencyMs: number | null;
};

async function runAccountModelProbe(
  db: ReturnType<typeof getCloudflareDb>,
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
): Promise<AccountProbeRefresh> {
  if (site.status !== 'active') {
    return {
      status: 'failed',
      errorCode: 'site_disabled',
      errorMessage: '站点已禁用',
      modelCount: 0,
      modelsPreview: [],
      models: [],
      endpointUrl: null,
      latencyMs: null,
    };
  }

  if (account.status !== 'active') {
    return {
      status: 'failed',
      errorCode: 'account_disabled',
      errorMessage: '账号已禁用',
      modelCount: 0,
      modelsPreview: [],
      models: [],
      endpointUrl: null,
      latencyMs: null,
    };
  }

  const token = resolveProbeToken(account, site);
  if (!token) {
    return {
      status: 'failed',
      errorCode: 'unauthorized',
      errorMessage: '缺少有效凭证',
      modelCount: 0,
      modelsPreview: [],
      models: [],
      endpointUrl: null,
      latencyMs: null,
    };
  }

  const endpoints = await resolveSiteProbeEndpoints(db, site);
  if (endpoints.length === 0) {
    return {
      status: 'failed',
      errorCode: 'no_endpoint',
      errorMessage: '未配置可用站点地址',
      modelCount: 0,
      modelsPreview: [],
      models: [],
      endpointUrl: null,
      latencyMs: null,
    };
  }

  const headers = buildProbeHeaders(site, token, resolveProbePlatformUserId(account));
  let lastFailure: Extract<ProbeFetchResult, { success: false }> | null = null;
  for (const endpoint of endpoints) {
    const result = await fetchModelsViaEndpoint(endpoint, headers);
    if (result.success) {
      const deduped = [...new Map(result.models.map((model) => [model.toLowerCase(), model])).values()];
      await upsertAccountModelAvailability(db, account.id, deduped, result.latencyMs);
      return {
        status: 'success',
        errorCode: null,
        errorMessage: null,
        modelCount: deduped.length,
        modelsPreview: deduped.slice(0, 10),
        models: deduped,
        endpointUrl: result.endpointUrl,
        latencyMs: result.latencyMs,
      };
    }
    lastFailure = result;
  }

  if (resolveStoredCredentialMode(account) === 'session') {
    for (const endpoint of endpoints) {
      const fallback = await fetchModelsViaSessionApi(endpoint, site, account, token);
      if (!fallback || fallback.models.length === 0) continue;
      await upsertAccountModelAvailability(db, account.id, fallback.models, fallback.latencyMs);
      return {
        status: 'success',
        errorCode: null,
        errorMessage: null,
        modelCount: fallback.models.length,
        modelsPreview: fallback.models.slice(0, 10),
        models: fallback.models,
        endpointUrl: endpoint,
        latencyMs: fallback.latencyMs,
      };
    }
  }

  return {
    status: 'failed',
    errorCode: lastFailure?.errorCode || 'unknown',
    errorMessage: lastFailure?.errorMessage || '模型获取失败',
    modelCount: 0,
    modelsPreview: [],
    models: [],
    endpointUrl: lastFailure?.endpointUrl || null,
    latencyMs: lastFailure?.latencyMs ?? null,
  };
}

type SiteProbeScope = 'single' | 'all';

type SiteProbeModelDetail = {
  modelName: string;
  status: 'supported' | 'unsupported' | 'skipped';
  latencyMs: number | null;
  latencyExceeded: boolean;
  reason?: string;
};

type SiteProbeExecutionResult = {
  success: boolean;
  siteId: number;
  scope: SiteProbeScope;
  modelName?: string;
  latencyThresholdMs: number;
  probed: number;
  unsupported: number;
  details: SiteProbeModelDetail[];
  disabledAdded: string[];
  modelsCount: number;
  message: string;
};

async function executeSiteModelProbe(
  db: ReturnType<typeof getCloudflareDb>,
  site: typeof schema.sites.$inferSelect,
  input: {
    scope: SiteProbeScope;
    modelName?: string;
    latencyThresholdMs: number;
  },
): Promise<SiteProbeExecutionResult> {
  if (site.status !== 'active') {
    return {
      success: false,
      siteId: site.id,
      scope: input.scope,
      modelName: input.modelName,
      latencyThresholdMs: input.latencyThresholdMs,
      probed: 0,
      unsupported: 0,
      details: [],
      disabledAdded: [],
      modelsCount: 0,
      message: '站点已禁用',
    };
  }

  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(and(
      eq(schema.accounts.siteId, site.id),
      eq(schema.accounts.status, 'active'),
    ))
    .all();

  if (accounts.length === 0) {
    return {
      success: false,
      siteId: site.id,
      scope: input.scope,
      modelName: input.modelName,
      latencyThresholdMs: input.latencyThresholdMs,
      probed: 0,
      unsupported: 0,
      details: [],
      disabledAdded: [],
      modelsCount: 0,
      message: '站点下没有可用账号',
    };
  }

  const refreshResults: Array<{ accountId: number; refresh: AccountProbeRefresh }> = [];
  for (const account of accounts) {
    const refresh = await runAccountModelProbe(db, account, site);
    refreshResults.push({ accountId: account.id, refresh });
  }

  const discoveredByModel = new Map<string, number[]>();
  for (const item of refreshResults) {
    if (item.refresh.status !== 'success') continue;
    for (const model of item.refresh.models) {
      const key = model.toLowerCase();
      const latencies = discoveredByModel.get(key) || [];
      latencies.push(item.refresh.latencyMs ?? 0);
      discoveredByModel.set(key, latencies);
    }
  }

  const allDiscoveredModels = [...new Set(
    refreshResults
      .flatMap((item) => item.refresh.models)
      .map((model) => model.trim())
      .filter(Boolean),
  )];

  const targetModels = input.scope === 'single'
    ? [String(input.modelName || '').trim()].filter(Boolean)
    : [...new Set(allDiscoveredModels)].sort((left, right) => left.localeCompare(right));

  if (targetModels.length === 0) {
    return {
      success: false,
      siteId: site.id,
      scope: input.scope,
      modelName: input.modelName,
      latencyThresholdMs: input.latencyThresholdMs,
      probed: 0,
      unsupported: 0,
      details: [],
      disabledAdded: [],
      modelsCount: 0,
      message: '未获取到可探测模型',
    };
  }

  const details: SiteProbeModelDetail[] = [];
  for (const target of targetModels) {
    const latencies = discoveredByModel.get(target.toLowerCase()) || [];
    if (latencies.length === 0) {
      details.push({
        modelName: target,
        status: 'unsupported',
        latencyMs: null,
        latencyExceeded: false,
        reason: 'no compatible endpoint candidate',
      });
      continue;
    }
    const validLatencies = latencies.filter((value) => Number.isFinite(value) && value > 0);
    const latencyMs = validLatencies.length > 0 ? Math.min(...validLatencies) : null;
    const latencyExceeded = input.latencyThresholdMs > 0 && latencyMs != null && latencyMs > input.latencyThresholdMs;
    details.push({
      modelName: target,
      status: latencyExceeded ? 'unsupported' : 'supported',
      latencyMs,
      latencyExceeded,
      reason: latencyExceeded
        ? `响应延迟 ${latencyMs}ms 超过阈值 ${input.latencyThresholdMs}ms`
        : undefined,
    });
  }

  const unsupportedModels = details
    .filter((item) => item.status === 'unsupported')
    .map((item) => item.modelName);

  const existingDisabledRows = await db
    .select({ modelName: schema.siteDisabledModels.modelName })
    .from(schema.siteDisabledModels)
    .where(eq(schema.siteDisabledModels.siteId, site.id))
    .all();
  const existingDisabled = new Set(existingDisabledRows.map((row) => String(row.modelName || '').toLowerCase()));
  const disabledAdded: string[] = [];

  for (const modelName of unsupportedModels) {
    const key = modelName.toLowerCase();
    if (existingDisabled.has(key)) continue;
    await db.insert(schema.siteDisabledModels).values({
      siteId: site.id,
      modelName,
      createdAt: formatUtcSqlDateTime(),
    }).onConflictDoNothing({
      target: [schema.siteDisabledModels.siteId, schema.siteDisabledModels.modelName],
    }).run();
    existingDisabled.add(key);
    disabledAdded.push(modelName);
  }

  return {
    success: true,
    siteId: site.id,
    scope: input.scope,
    modelName: input.modelName,
    latencyThresholdMs: input.latencyThresholdMs,
    probed: details.length,
    unsupported: unsupportedModels.length,
    details,
    disabledAdded,
    modelsCount: targetModels.length,
    message: unsupportedModels.length > 0
      ? `${unsupportedModels.length} 个模型不可用，已自动加入禁用列表`
      : `探测完成：${details.length} 个模型均可用`,
  };
}

type CloudflareAccountHealthState = 'healthy' | 'unhealthy' | 'disabled';

function resolveAccountHealthState(input: {
  accountStatus: string | null | undefined;
  siteStatus: string | null | undefined;
  refreshStatus?: AccountProbeRefresh['status'];
}): CloudflareAccountHealthState {
  const accountStatus = String(input.accountStatus || '').trim().toLowerCase();
  const siteStatus = String(input.siteStatus || '').trim().toLowerCase();
  if (accountStatus !== 'active' || siteStatus !== 'active') return 'disabled';
  return input.refreshStatus === 'success' ? 'healthy' : 'unhealthy';
}

function isMaskedSecretValue(value: unknown): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  return text.includes('*') || text.includes('•');
}

type TestTargetFormat = 'openai' | 'claude' | 'responses' | 'gemini';
type TestChatMessage = { role: string; content: string };
type ValidatedTestChatPayload = {
  model: string;
  messages: TestChatMessage[];
  targetFormat: TestTargetFormat;
  stream?: boolean;
  forcedChannelId?: number | null;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

type ProxyTestMethod = 'POST' | 'GET' | 'DELETE';
type ProxyTestRequestKind = 'json' | 'multipart' | 'empty';
type ProxyTestMultipartFile = {
  field: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};
type ValidatedProxyTestEnvelope = {
  method: ProxyTestMethod;
  path: string;
  requestKind: ProxyTestRequestKind;
  stream: boolean;
  jobMode: boolean;
  rawMode: boolean;
  forcedChannelId?: number | null;
  jsonBody?: unknown;
  rawJsonText?: string;
  multipartFields?: Record<string, string>;
  multipartFiles?: ProxyTestMultipartFile[];
};

const TESTER_REQUEST_HEADER = 'x-metapi-tester-request';
const TESTER_FORCED_CHANNEL_HEADER = 'x-metapi-tester-forced-channel-id';

const ALLOWED_PROXY_PATH_PATTERNS: RegExp[] = [
  /^\/v1\/chat\/completions(?:\?.*)?$/i,
  /^\/v1\/files(?:\/[^/?#]+(?:\/content)?)?(?:\?.*)?$/i,
  /^\/v1\/responses(?:\/compact)?(?:\?.*)?$/i,
  /^\/v1\/messages(?:\?.*)?$/i,
  /^\/v1\/embeddings(?:\?.*)?$/i,
  /^\/v1\/search(?:\?.*)?$/i,
  /^\/v1\/images\/(?:generations|edits)(?:\?.*)?$/i,
  /^\/v1\/videos(?:\?.*)?$/i,
  /^\/v1\/videos\/[^/?#]+(?:\?.*)?$/i,
  /^\/gemini\/[^/]+\/models(?:\?.*)?$/i,
  /^\/gemini\/[^/]+\/models\/.+(?:\?.*)?$/i,
  /^\/v1beta\/models(?:\?.*)?$/i,
  /^\/v1beta\/models\/.+(?:\?.*)?$/i,
];

function normalizeForcedChannelId(value: unknown): number | null {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeProxyPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return `${url.pathname}${url.search}`;
    }
  } catch {
    // noop
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function isAllowedProxyPath(path: string): boolean {
  return ALLOWED_PROXY_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function validateLegacyTestChatPayload(body: Record<string, unknown>): {
  ok: true;
  payload: ValidatedTestChatPayload;
} | { ok: false; status: number; message: string } {
  const model = String(body.model || '').trim();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!model) return { ok: false, status: 400, message: 'model is required' };
  if (messages.length === 0) return { ok: false, status: 400, message: 'messages is required' };
  if (String(body.targetFormat || '').trim().toLowerCase() === 'gemini') {
    return {
      ok: false,
      status: 400,
      message: 'targetFormat=gemini is not supported on legacy /api/test/chat routes; use the proxy tester Gemini path instead',
    };
  }
  const targetFormat: TestTargetFormat = String(body.targetFormat || '').trim().toLowerCase() === 'claude'
    ? 'claude'
    : String(body.targetFormat || '').trim().toLowerCase() === 'responses'
      ? 'responses'
      : 'openai';
  return {
    ok: true,
    payload: {
      model,
      messages: messages
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const row = item as Record<string, unknown>;
          return {
            role: String(row.role || 'user'),
            content: String(row.content || ''),
          };
        })
        .filter((item) => item.content.trim().length > 0),
      targetFormat,
      stream: !!body.stream,
      forcedChannelId: normalizeForcedChannelId(body.forcedChannelId),
      temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : undefined,
      top_p: Number.isFinite(Number(body.top_p)) ? Number(body.top_p) : undefined,
      max_tokens: Number.isFinite(Number(body.max_tokens)) ? Number(body.max_tokens) : undefined,
      frequency_penalty: Number.isFinite(Number(body.frequency_penalty)) ? Number(body.frequency_penalty) : undefined,
      presence_penalty: Number.isFinite(Number(body.presence_penalty)) ? Number(body.presence_penalty) : undefined,
      seed: Number.isFinite(Number(body.seed)) ? Number(body.seed) : undefined,
    },
  };
}

function convertLegacyPayloadToProxyEnvelope(
  payload: ValidatedTestChatPayload,
  forceStream: boolean,
): ValidatedProxyTestEnvelope {
  if (payload.targetFormat === 'claude') {
    const systemContents: string[] = [];
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const message of payload.messages) {
      const role = String(message.role || 'user').trim().toLowerCase();
      const content = String(message.content || '').trim();
      if (!content) continue;
      if (role === 'system') {
        systemContents.push(content);
        continue;
      }
      messages.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content,
      });
    }
    const body: Record<string, unknown> = {
      model: payload.model,
      stream: forceStream,
      max_tokens: typeof payload.max_tokens === 'number' && Number.isFinite(payload.max_tokens)
        ? payload.max_tokens
        : 4096,
      messages,
    };
    if (systemContents.length > 0) body.system = systemContents.join('\n\n');
    if (typeof payload.temperature === 'number') body.temperature = payload.temperature;
    if (typeof payload.top_p === 'number') body.top_p = payload.top_p;
    return {
      method: 'POST',
      path: '/v1/messages',
      requestKind: 'json',
      stream: forceStream,
      jobMode: false,
      rawMode: false,
      forcedChannelId: payload.forcedChannelId ?? null,
      jsonBody: body,
    };
  }

  if (payload.targetFormat === 'responses') {
    const systemContents: string[] = [];
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const message of payload.messages) {
      const role = String(message.role || 'user').trim().toLowerCase();
      const content = String(message.content || '').trim();
      if (!content) continue;
      if (role === 'system') {
        systemContents.push(content);
        continue;
      }
      messages.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content,
      });
    }
    const body: Record<string, unknown> = {
      model: payload.model,
      stream: forceStream,
    };
    if (messages.length === 1 && messages[0]?.role === 'user' && systemContents.length === 0) {
      body.input = messages[0].content;
    } else {
      body.input = messages;
      if (systemContents.length > 0) {
        body.instructions = systemContents.join('\n\n');
      }
    }
    if (typeof payload.temperature === 'number') body.temperature = payload.temperature;
    if (typeof payload.top_p === 'number') body.top_p = payload.top_p;
    body.max_output_tokens = typeof payload.max_tokens === 'number' && Number.isFinite(payload.max_tokens)
      ? payload.max_tokens
      : 4096;
    return {
      method: 'POST',
      path: '/v1/responses',
      requestKind: 'json',
      stream: forceStream,
      jobMode: false,
      rawMode: false,
      forcedChannelId: payload.forcedChannelId ?? null,
      jsonBody: body,
    };
  }

  return {
    method: 'POST',
    path: '/v1/chat/completions',
    requestKind: 'json',
    stream: forceStream,
    jobMode: false,
    rawMode: false,
    forcedChannelId: payload.forcedChannelId ?? null,
    jsonBody: {
      model: payload.model,
      messages: payload.messages,
      stream: forceStream,
      ...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {}),
      ...(typeof payload.top_p === 'number' ? { top_p: payload.top_p } : {}),
      ...(typeof payload.max_tokens === 'number' ? { max_tokens: payload.max_tokens } : {}),
      ...(typeof payload.frequency_penalty === 'number' ? { frequency_penalty: payload.frequency_penalty } : {}),
      ...(typeof payload.presence_penalty === 'number' ? { presence_penalty: payload.presence_penalty } : {}),
      ...(typeof payload.seed === 'number' ? { seed: payload.seed } : {}),
    },
  };
}

function validateProxyEnvelopeInput(body: Record<string, unknown>): {
  ok: true;
  envelope: ValidatedProxyTestEnvelope;
} | { ok: false; status: number; message: string } {
  const method: ProxyTestMethod = String(body.method || 'POST').toUpperCase() === 'GET'
    ? 'GET'
    : String(body.method || 'POST').toUpperCase() === 'DELETE'
      ? 'DELETE'
      : 'POST';
  const path = normalizeProxyPath(body.path);
  if (!path) return { ok: false, status: 400, message: 'path is required' };
  if (!isAllowedProxyPath(path)) {
    return { ok: false, status: 400, message: `path is not allowed: ${path}` };
  }
  const requestKind: ProxyTestRequestKind = String(body.requestKind || '').trim().toLowerCase() === 'multipart'
    ? 'multipart'
    : String(body.requestKind || '').trim().toLowerCase() === 'empty'
      ? 'empty'
      : 'json';
  if (method !== 'POST' && requestKind !== 'empty') {
    return { ok: false, status: 400, message: `${method} only supports requestKind=empty in tester` };
  }
  const envelope: ValidatedProxyTestEnvelope = {
    method,
    path,
    requestKind,
    stream: !!body.stream,
    jobMode: !!body.jobMode,
    rawMode: !!body.rawMode,
    forcedChannelId: normalizeForcedChannelId(body.forcedChannelId),
  };
  if (requestKind === 'json') {
    if (typeof body.rawJsonText === 'string' && body.rawJsonText.trim()) {
      envelope.rawJsonText = body.rawJsonText;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'jsonBody')) {
      envelope.jsonBody = body.jsonBody;
    }
    if (envelope.rawMode && typeof envelope.rawJsonText !== 'string') {
      return { ok: false, status: 400, message: 'rawJsonText is required when rawMode is enabled' };
    }
  } else if (requestKind === 'multipart') {
    const multipartFields: Record<string, string> = {};
    if (body.multipartFields && typeof body.multipartFields === 'object' && !Array.isArray(body.multipartFields)) {
      for (const [key, value] of Object.entries(body.multipartFields as Record<string, unknown>)) {
        if (typeof key === 'string' && typeof value === 'string') {
          multipartFields[key] = value;
        }
      }
    }
    const multipartFiles = Array.isArray(body.multipartFiles)
      ? body.multipartFiles
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const row = item as Record<string, unknown>;
          return {
            field: String(row.field || '').trim(),
            name: String(row.name || '').trim(),
            mimeType: String(row.mimeType || '').trim(),
            dataUrl: String(row.dataUrl || '').trim(),
          };
        })
        .filter((item) => item.field && item.name && item.mimeType && item.dataUrl)
      : [];
    if (Object.keys(multipartFields).length === 0 && multipartFiles.length === 0) {
      return { ok: false, status: 400, message: 'multipart requests require multipartFields or multipartFiles' };
    }
    envelope.multipartFields = multipartFields;
    envelope.multipartFiles = multipartFiles;
  }
  return { ok: true, envelope };
}

function applyStreamOverride(value: unknown, forceStream: boolean): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    ...(value as Record<string, unknown>),
    stream: forceStream,
  };
}

function serializeJsonEnvelopeBody(
  envelope: ValidatedProxyTestEnvelope,
  forceStream: boolean,
): string {
  if (typeof envelope.rawJsonText === 'string' && envelope.rawJsonText.trim()) {
    try {
      const parsed = JSON.parse(envelope.rawJsonText);
      return JSON.stringify(applyStreamOverride(parsed, forceStream));
    } catch {
      return envelope.rawJsonText;
    }
  }
  if (Object.prototype.hasOwnProperty.call(envelope, 'jsonBody')) {
    return JSON.stringify(applyStreamOverride(envelope.jsonBody, forceStream));
  }
  return JSON.stringify({ stream: forceStream });
}

function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: number[] } {
  const match = /^data:([^;,]+)?;base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) throw new Error('multipartFiles[].dataUrl must be a base64 data URL');
  const mimeType = match[1] || 'application/octet-stream';
  const binary = atob(match[2] || '');
  const bytes: number[] = [];
  for (let index = 0; index < binary.length; index++) {
    bytes.push(binary.charCodeAt(index));
  }
  return { mimeType, bytes };
}

function createDefaultTesterAuthHeaders(path: string, proxyToken: string): Record<string, string> {
  if (/^\/v1\/messages$/i.test(path)) {
    return {
      'x-api-key': proxyToken,
      'anthropic-version': '2023-06-01',
    };
  }
  if (/^\/(?:gemini\/[^/]+\/models\/.+|v1beta\/models\/.+)$/i.test(path)) {
    return {
      'x-goog-api-key': proxyToken,
    };
  }
  return {
    Authorization: `Bearer ${proxyToken}`,
  };
}

async function resolveCloudflareProxyToken(
  db: ReturnType<typeof getCloudflareDb>,
  envProxyToken: string | undefined,
): Promise<string> {
  const stored = await readSetting(db, 'proxy_token');
  if (typeof stored === 'string' && stored.trim()) return stored.trim();
  return String(envProxyToken || '').trim() || 'change-me-proxy-sk-token';
}

async function executeProxyTesterRequest(
  c: any,
  envelope: ValidatedProxyTestEnvelope,
  forceStream: boolean,
): Promise<{ response: Response; durationMs: number }> {
  const db = getCloudflareDb(c);
  const proxyToken = await resolveCloudflareProxyToken(db, c.env.PROXY_TOKEN);
  const headers = new Headers(createDefaultTesterAuthHeaders(envelope.path, proxyToken));
  headers.set(TESTER_REQUEST_HEADER, '1');
  if (typeof envelope.forcedChannelId === 'number' && envelope.forcedChannelId > 0) {
    headers.set(TESTER_FORCED_CHANNEL_HEADER, String(envelope.forcedChannelId));
  }

  let body: BodyInit | undefined;
  if (envelope.requestKind === 'json') {
    headers.set('content-type', 'application/json');
    body = serializeJsonEnvelopeBody(envelope, forceStream);
  } else if (envelope.requestKind === 'multipart') {
    const formData = new FormData();
    for (const [key, value] of Object.entries(envelope.multipartFields || {})) {
      formData.append(key, value);
    }
    for (const file of envelope.multipartFiles || []) {
      const decoded = decodeDataUrl(file.dataUrl);
      const blob = new Blob([new Uint8Array(decoded.bytes)], { type: file.mimeType || decoded.mimeType });
      formData.append(file.field, blob, file.name);
    }
    body = formData;
  }

  const targetUrl = new URL(envelope.path, new URL(c.req.url).origin).toString();
  const startedAt = Date.now();
  const response = await fetch(targetUrl, {
    method: envelope.method,
    headers,
    body: envelope.method === 'POST' ? body : undefined,
    redirect: 'manual',
  });
  return {
    response,
    durationMs: Date.now() - startedAt,
  };
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function parseProxyResponsePayload(response: Response): Promise<unknown> {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return await response.json();
    } catch {
      // fallback to raw text below
    }
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  const textLike = contentType.includes('text/')
    || contentType.includes('application/javascript')
    || contentType.includes('application/xml')
    || contentType.includes('application/x-www-form-urlencoded')
    || contentType.includes('application/sse')
    || contentType.includes('event-stream');
  if (textLike) {
    const text = new TextDecoder('utf-8').decode(buffer);
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  return {
    binary: true,
    contentType: contentType || 'application/octet-stream',
    base64: encodeBytesToBase64(buffer),
  };
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function normalizeRouteModeValue(routeMode: unknown): 'pattern' | 'explicit_group' {
  return String(routeMode || '').trim().toLowerCase() === 'explicit_group'
    ? 'explicit_group'
    : 'pattern';
}

function isExactModelPattern(modelPattern: unknown): boolean {
  const normalized = String(modelPattern || '').trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

function parseRouteDecisionSnapshot(snapshot: unknown): unknown | null {
  const parsed = parseJsonValue(snapshot);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function matchesModelPattern(model: string, modelPattern: string): boolean {
  const normalizedModel = String(model || '').trim();
  const pattern = String(modelPattern || '').trim();
  if (!normalizedModel || !pattern) return false;
  if (pattern.toLowerCase().startsWith('re:')) {
    try {
      const regex = new RegExp(pattern.slice(3));
      return regex.test(normalizedModel);
    } catch {
      return false;
    }
  }
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(normalizedModel);
  }
  return pattern.toLowerCase() === normalizedModel.toLowerCase();
}

function parseBatchRouteDecisionModelsPayload(
  input: unknown,
): { ok: true; models: string[]; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }
  const models = (input as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length === 0) {
    return { ok: false, message: 'models 必须是非空数组' };
  }
  const dedupe = new Set<string>();
  const normalized: string[] = [];
  for (const raw of models) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || dedupe.has(trimmed)) continue;
    dedupe.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= 500) break;
  }
  if (normalized.length === 0) {
    return { ok: false, message: 'models 中没有有效模型名称' };
  }
  return {
    ok: true,
    models: normalized,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

function parseBatchRouteDecisionRouteModelsPayload(
  input: unknown,
): { ok: true; items: Array<{ routeId: number; model: string }>; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }
  const items = (input as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'items 必须是非空数组' };
  }
  const dedupe = new Set<string>();
  const normalized: Array<{ routeId: number; model: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const routeIdRaw = (item as { routeId?: unknown }).routeId;
    const modelRaw = (item as { model?: unknown }).model;
    if (typeof routeIdRaw !== 'number' || !Number.isFinite(routeIdRaw)) continue;
    if (typeof modelRaw !== 'string') continue;
    const routeId = Math.trunc(routeIdRaw);
    const model = modelRaw.trim();
    if (routeId <= 0 || !model) continue;
    const key = `${routeId}::${model}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    normalized.push({ routeId, model });
    if (normalized.length >= 500) break;
  }
  if (normalized.length === 0) {
    return { ok: false, message: 'items 中没有有效 routeId/model' };
  }
  return {
    ok: true,
    items: normalized,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

function parseBatchRouteWideDecisionRouteIdsPayload(
  input: unknown,
): { ok: true; routeIds: number[]; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }
  const routeIds = (input as { routeIds?: unknown }).routeIds;
  if (!Array.isArray(routeIds) || routeIds.length === 0) {
    return { ok: false, message: 'routeIds 必须是非空数组' };
  }
  const dedupe = new Set<number>();
  const normalized: number[] = [];
  for (const raw of routeIds) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const routeId = Math.trunc(raw);
    if (routeId <= 0 || dedupe.has(routeId)) continue;
    dedupe.add(routeId);
    normalized.push(routeId);
    if (normalized.length >= 500) break;
  }
  if (normalized.length === 0) {
    return { ok: false, message: 'routeIds 中没有有效 routeId' };
  }
  return {
    ok: true,
    routeIds: normalized,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

async function persistRouteDecisionSnapshots(
  db: ReturnType<typeof getCloudflareDb>,
  snapshots: Array<{ routeId: number; snapshot: unknown }>,
): Promise<void> {
  const now = formatUtcSqlDateTime();
  for (const item of snapshots) {
    const routeId = Math.trunc(Number(item.routeId));
    if (!Number.isFinite(routeId) || routeId <= 0) continue;
    const snapshot = item.snapshot == null ? null : JSON.stringify(item.snapshot);
    await db.update(schema.tokenRoutes).set({
      decisionSnapshot: snapshot,
      decisionRefreshedAt: now,
      updatedAt: now,
    }).where(eq(schema.tokenRoutes.id, routeId)).run();
  }
}

type CloudflareBackupWebdavConfig = {
  enabled: boolean;
  fileUrl: string;
  username: string;
  password: string;
  exportType: BackupExportType;
  autoSyncEnabled: boolean;
  autoSyncCron: string;
};

type CloudflareBackupWebdavState = {
  lastSyncAt: string | null;
  lastError: string | null;
};

function normalizeBackupExportType(value: unknown, fallback: BackupExportType = 'all'): BackupExportType {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'accounts') return 'accounts';
  if (normalized === 'preferences') return 'preferences';
  if (normalized === 'all') return 'all';
  return fallback;
}

function normalizeCloudflareBackupWebdavConfig(raw: unknown): CloudflareBackupWebdavConfig {
  const record = safeJsonObject(raw);
  const enabled = record.enabled === true;
  return {
    enabled,
    fileUrl: String(record.fileUrl || '').trim(),
    username: String(record.username || '').trim(),
    password: String(record.password || ''),
    exportType: normalizeBackupExportType(record.exportType, 'all'),
    autoSyncEnabled: enabled && record.autoSyncEnabled === true,
    autoSyncCron: String(record.autoSyncCron || '').trim() || CLOUDFLARE_BACKUP_WEBDAV_DEFAULT_AUTO_SYNC_CRON,
  };
}

function normalizeCloudflareBackupWebdavState(raw: unknown): CloudflareBackupWebdavState {
  const record = safeJsonObject(raw);
  const lastSyncAtRaw = String(record.lastSyncAt || '').trim();
  const lastErrorRaw = String(record.lastError || '').trim();
  return {
    lastSyncAt: lastSyncAtRaw || null,
    lastError: lastErrorRaw || null,
  };
}

function resolveCloudflareBackupWebdavAuthHeader(config: CloudflareBackupWebdavConfig): string | null {
  if (!config.username && !config.password) return null;
  const token = encodeBytesToBase64(new TextEncoder().encode(`${config.username}:${config.password}`));
  return `Basic ${token}`;
}

function validateCloudflareBackupWebdavConfig(config: CloudflareBackupWebdavConfig): void {
  if (!config.enabled) return;
  if (!config.fileUrl) {
    throw new Error('WebDAV 文件地址不能为空');
  }
  try {
    const parsed = new URL(config.fileUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('WebDAV 文件地址必须为 http/https URL');
    }
  } catch {
    throw new Error('WebDAV 文件地址格式无效');
  }
}

async function fetchCloudflareWebdav(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLOUDFLARE_BACKUP_WEBDAV_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.toLowerCase().includes('abort')) {
      throw new Error('WebDAV 请求超时');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadCloudflareBackupWebdavConfig(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<CloudflareBackupWebdavConfig> {
  return normalizeCloudflareBackupWebdavConfig(await readSetting(db, CLOUDFLARE_BACKUP_WEBDAV_CONFIG_KEY));
}

async function loadCloudflareBackupWebdavState(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<CloudflareBackupWebdavState> {
  return normalizeCloudflareBackupWebdavState(await readSetting(db, CLOUDFLARE_BACKUP_WEBDAV_STATE_KEY));
}

async function writeCloudflareBackupWebdavState(
  db: ReturnType<typeof getCloudflareDb>,
  next: CloudflareBackupWebdavState,
): Promise<void> {
  await writeSetting(db, CLOUDFLARE_BACKUP_WEBDAV_STATE_KEY, {
    lastSyncAt: next.lastSyncAt,
    lastError: next.lastError,
  });
}

async function buildCloudflareBackupExportPayload(
  db: ReturnType<typeof getCloudflareDb>,
  type: BackupExportType,
): Promise<Record<string, unknown>> {
  const [sites, accounts, accountTokens, routes, routeChannels, settingsRows] = await Promise.all([
    db.select().from(schema.sites).all(),
    db.select().from(schema.accounts).all(),
    db.select().from(schema.accountTokens).all(),
    db.select().from(schema.tokenRoutes).all(),
    db.select().from(schema.routeChannels).all(),
    db.select().from(schema.settings).all(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    type,
    data: {
      sites: type === 'preferences' ? [] : sites,
      accounts: type === 'accounts' || type === 'all' ? accounts : [],
      accountTokens: type === 'accounts' || type === 'all' ? accountTokens : [],
      tokenRoutes: type === 'preferences' || type === 'all' ? routes : [],
      routeChannels: type === 'preferences' || type === 'all' ? routeChannels : [],
      settings: settingsRows,
    },
  };
}

async function applyCloudflareBackupImport(
  db: ReturnType<typeof getCloudflareDb>,
  rootInput: unknown,
): Promise<Record<string, unknown>> {
  const root = safeJsonObject(rootInput);
  const data = safeJsonObject(root.data);
  const accountsSection = safeJsonObject(root.accounts);
  const preferencesSection = safeJsonObject(root.preferences);

  const pickSection = (key: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(data, key)) return data[key];
    if (Object.prototype.hasOwnProperty.call(accountsSection, key)) return accountsSection[key];
    if (Object.prototype.hasOwnProperty.call(preferencesSection, key)) return preferencesSection[key];
    if (Object.prototype.hasOwnProperty.call(root, key)) return root[key];
    return undefined;
  };

  const toRowArray = (value: unknown): Array<Record<string, unknown>> => (
    Array.isArray(value)
      ? value
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => ({ ...(item as Record<string, unknown>) }))
      : []
  );

  const sitesRows = toRowArray(pickSection('sites'));
  const accountsRows = toRowArray(pickSection('accounts'));
  const accountTokensRows = toRowArray(pickSection('accountTokens'));
  const tokenRoutesRows = toRowArray(pickSection('tokenRoutes'));
  const routeChannelsRows = toRowArray(pickSection('routeChannels'));
  const routeGroupSourcesRows = toRowArray(pickSection('routeGroupSources'));
  const siteDisabledModelsRows = toRowArray(pickSection('siteDisabledModels'));
  const downstreamApiKeysRows = toRowArray(pickSection('downstreamApiKeys'));
  const settingsRows = toRowArray(pickSection('settings'));

  const rootType = normalizeBackupExportType(root.type, 'all');
  const sections = {
    accounts: (
      sitesRows.length
      + accountsRows.length
      + accountTokensRows.length
      + tokenRoutesRows.length
      + routeChannelsRows.length
      + routeGroupSourcesRows.length
      + siteDisabledModelsRows.length
      + downstreamApiKeysRows.length
    ) > 0 || rootType === 'accounts',
    preferences: settingsRows.length > 0 || rootType === 'preferences',
  };

  if (!sections.accounts && !sections.preferences) {
    throw new Error('备份内容缺少可导入数据段');
  }

  const warnings: string[] = [];
  const upsertById = async (
    table: any,
    idColumn: any,
    row: Record<string, unknown>,
    label: string,
  ) => {
    const payload = { ...row };
    const idValue = Math.trunc(Number(payload.id));
    try {
      if (Number.isFinite(idValue) && idValue > 0) {
        payload.id = idValue;
        await db
          .insert(table)
          .values(payload as any)
          .onConflictDoUpdate({
            target: idColumn,
            set: payload as any,
          })
          .run();
      } else {
        delete payload.id;
        await db.insert(table).values(payload as any).run();
      }
      return true;
    } catch (error: unknown) {
      warnings.push(`${label}: ${error instanceof Error ? error.message : 'import failed'}`);
      return false;
    }
  };

  let importedSites = 0;
  let importedAccounts = 0;
  let importedProfiles = 0;
  let importedApiKeyConnections = 0;
  let skippedAccounts = 0;

  if (sections.accounts) {
    for (const row of sitesRows) {
      if (await upsertById(schema.sites, schema.sites.id, row, `sites#${row.id ?? '?'}`)) importedSites += 1;
    }
    for (const row of accountsRows) {
      const ok = await upsertById(schema.accounts, schema.accounts.id, row, `accounts#${row.id ?? '?'}`);
      if (!ok) {
        skippedAccounts += 1;
        continue;
      }
      importedAccounts += 1;
    }
    for (const row of accountTokensRows) {
      await upsertById(schema.accountTokens, schema.accountTokens.id, row, `account_tokens#${row.id ?? '?'}`);
    }
    for (const row of tokenRoutesRows) {
      await upsertById(schema.tokenRoutes, schema.tokenRoutes.id, row, `token_routes#${row.id ?? '?'}`);
    }
    for (const row of routeChannelsRows) {
      await upsertById(schema.routeChannels, schema.routeChannels.id, row, `route_channels#${row.id ?? '?'}`);
    }
    for (const row of routeGroupSourcesRows) {
      const payload = { ...row };
      try {
        await db.insert(schema.routeGroupSources).values(payload as any).onConflictDoNothing({
          target: [schema.routeGroupSources.groupRouteId, schema.routeGroupSources.sourceRouteId],
        }).run();
      } catch (error: unknown) {
        warnings.push(`route_group_sources: ${error instanceof Error ? error.message : 'import failed'}`);
      }
    }
    for (const row of siteDisabledModelsRows) {
      const payload = { ...row };
      try {
        await db.insert(schema.siteDisabledModels).values(payload as any).onConflictDoNothing({
          target: [schema.siteDisabledModels.siteId, schema.siteDisabledModels.modelName],
        }).run();
      } catch (error: unknown) {
        warnings.push(`site_disabled_models: ${error instanceof Error ? error.message : 'import failed'}`);
      }
    }
    for (const row of downstreamApiKeysRows) {
      const payload = { ...row };
      const keyValue = String(payload.key || '').trim();
      if (!keyValue) {
        warnings.push('downstream_api_keys: missing key');
        continue;
      }
      try {
        await db.insert(schema.downstreamApiKeys).values(payload as any).onConflictDoUpdate({
          target: schema.downstreamApiKeys.key,
          set: payload as any,
        }).run();
        importedApiKeyConnections += 1;
      } catch (error: unknown) {
        warnings.push(`downstream_api_keys#${keyValue}: ${error instanceof Error ? error.message : 'import failed'}`);
      }
    }
    importedProfiles = importedApiKeyConnections;
  }

  if (sections.preferences) {
    for (const row of settingsRows) {
      const key = String(row.key || '').trim();
      if (!key) {
        warnings.push('settings: missing key');
        continue;
      }
      const rawValue = row.value;
      const value = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue ?? null);
      try {
        await db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({
          target: schema.settings.key,
          set: { value },
        }).run();
      } catch (error: unknown) {
        warnings.push(`settings#${key}: ${error instanceof Error ? error.message : 'import failed'}`);
      }
    }
  }

  const ignoredSections: string[] = [];
  if (Object.prototype.hasOwnProperty.call(root, 'channelConfigs')) ignoredSections.push('channelConfigs');
  if (Object.prototype.hasOwnProperty.call(root, 'tagStore')) ignoredSections.push('tagStore');
  if (Object.prototype.hasOwnProperty.call(accountsSection, 'bookmarks')) ignoredSections.push('accounts.bookmarks');

  return {
    success: true,
    allImported: warnings.length === 0,
    sections,
    appliedSettings: sections.preferences
      ? settingsRows.map((row) => String(row.key || '').trim()).filter(Boolean)
      : [],
    summary: {
      importedSites,
      importedAccounts,
      importedProfiles,
      importedApiKeyConnections,
      skippedAccounts,
      ignoredSections,
    },
    warnings,
  };
}

async function refreshCloudflareRouteDecisionSnapshots(
  db: ReturnType<typeof getCloudflareDb>,
  options: { onProgress?: (message: string) => void } = {},
): Promise<{ exactModelCount: number; wildcardRouteCount: number; updatedRoutes: number }> {
  const routes = await loadRoutesWithSources(db);
  const enabledRoutes = routes.filter((route) => route.enabled === true);
  const exactRoutes = enabledRoutes.filter((route) => isExactModelPattern(route.modelPattern));
  const wildcardRoutes = enabledRoutes.filter((route) => !isExactModelPattern(route.modelPattern));
  const exactModels = [...new Set(exactRoutes.map((route) => String(route.modelPattern || '').trim()).filter(Boolean))];
  const allBaseRouteIds = [...new Set(routes.filter((route) => route.routeMode !== 'explicit_group').map((route) => route.id))];
  const baseChannels = await loadRouteChannelsByBaseRouteId(db, allBaseRouteIds);
  let updatedRoutes = 0;

  options.onProgress?.(`开始刷新路由概率：精确模型 ${exactModels.length}，通配符路由 ${wildcardRoutes.length}`);

  for (const [index, model] of exactModels.entries()) {
    options.onProgress?.(`刷新精确模型概率 ${index + 1}/${exactModels.length}：${model}`);
    const snapshotWrites: Array<{ routeId: number; snapshot: unknown }> = [];
    for (const route of exactRoutes) {
      if (!matchesModelPattern(model, String(route.modelPattern || ''))) continue;
      const channels = route.routeMode === 'explicit_group'
        ? route.sourceRouteIds.flatMap((sourceId) => baseChannels.get(sourceId) || [])
        : (baseChannels.get(route.id) || []);
      snapshotWrites.push({
        routeId: route.id,
        snapshot: {
          ...buildRouteDecisionFromChannels(model, channels),
          routeId: route.id,
        },
      });
    }
    if (snapshotWrites.length > 0) {
      await persistRouteDecisionSnapshots(db, snapshotWrites);
      updatedRoutes += snapshotWrites.length;
    }
  }

  for (const [index, route] of wildcardRoutes.entries()) {
    options.onProgress?.(`刷新通配符路由概率 ${index + 1}/${wildcardRoutes.length}：#${route.id}`);
    const channels = route.routeMode === 'explicit_group'
      ? route.sourceRouteIds.flatMap((sourceId) => baseChannels.get(sourceId) || [])
      : (baseChannels.get(route.id) || []);
    await persistRouteDecisionSnapshots(db, [{
      routeId: route.id,
      snapshot: {
        ...buildRouteDecisionFromChannels(route.modelPattern, channels),
        routeId: route.id,
      },
    }]);
    updatedRoutes += 1;
  }

  return {
    exactModelCount: exactModels.length,
    wildcardRouteCount: wildcardRoutes.length,
    updatedRoutes,
  };
}

async function loadRouteSourceIdsMap(
  db: ReturnType<typeof getCloudflareDb>,
  routeIds: number[],
): Promise<Map<number, number[]>> {
  const normalizedRouteIds = [...new Set(routeIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0))];
  if (normalizedRouteIds.length === 0) return new Map();
  const rows = await db
    .select({
      groupRouteId: schema.routeGroupSources.groupRouteId,
      sourceRouteId: schema.routeGroupSources.sourceRouteId,
    })
    .from(schema.routeGroupSources)
    .where(inArray(schema.routeGroupSources.groupRouteId, normalizedRouteIds))
    .all();
  const grouped = new Map<number, number[]>();
  for (const row of rows) {
    const groupRouteId = Number(row.groupRouteId);
    const sourceRouteId = Number(row.sourceRouteId);
    if (!Number.isFinite(groupRouteId) || groupRouteId <= 0 || !Number.isFinite(sourceRouteId) || sourceRouteId <= 0) {
      continue;
    }
    const existing = grouped.get(groupRouteId) || [];
    if (!existing.includes(sourceRouteId)) existing.push(sourceRouteId);
    grouped.set(groupRouteId, existing);
  }
  return grouped;
}

type CloudflareRouteRow = (typeof schema.tokenRoutes.$inferSelect) & {
  routeMode: 'pattern' | 'explicit_group';
  sourceRouteIds: number[];
};

async function loadRoutesWithSources(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<CloudflareRouteRow[]> {
  const routeRows = await db.select().from(schema.tokenRoutes).all();
  const sourceMap = await loadRouteSourceIdsMap(db, routeRows.map((row) => row.id));
  return routeRows.map((row) => ({
    ...row,
    routeMode: normalizeRouteModeValue(row.routeMode),
    sourceRouteIds: sourceMap.get(row.id) || [],
  }));
}

async function loadRouteChannelsByBaseRouteId(
  db: ReturnType<typeof getCloudflareDb>,
  routeIds: number[],
): Promise<Map<number, any[]>> {
  const normalizedRouteIds = [...new Set(routeIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0))];
  if (normalizedRouteIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(inArray(schema.routeChannels.routeId, normalizedRouteIds))
    .all();

  const channelsByRouteId = new Map<number, any[]>();
  for (const row of rows) {
    const channel = row.route_channels;
    const account = row.accounts;
    const site = row.sites;
    const token = row.account_tokens;
    const routeId = Number(channel.routeId);
    if (!channelsByRouteId.has(routeId)) channelsByRouteId.set(routeId, []);
    channelsByRouteId.get(routeId)!.push({
      ...channel,
      routeId,
      sourceModel: channel.sourceModel || null,
      account: {
        id: account.id,
        username: account.username || null,
        accessToken: account.accessToken || null,
        extraConfig: account.extraConfig || null,
      },
      site: {
        id: site.id,
        name: site.name || null,
        platform: site.platform || null,
      },
      token: token
        ? {
          id: token.id,
          name: token.name,
          accountId: token.accountId,
          enabled: !!token.enabled,
          isDefault: !!token.isDefault,
        }
        : null,
      routeUnit: null,
    });
  }
  return channelsByRouteId;
}

function buildRouteChannelsMap(
  routes: CloudflareRouteRow[],
  baseRouteChannelsById: Map<number, any[]>,
): Map<number, any[]> {
  const channelsByRouteId = new Map<number, any[]>();
  for (const route of routes) {
    if (route.routeMode === 'explicit_group') {
      const merged = route.sourceRouteIds.flatMap((sourceRouteId) => baseRouteChannelsById.get(sourceRouteId) || []);
      channelsByRouteId.set(route.id, merged);
      continue;
    }
    channelsByRouteId.set(route.id, baseRouteChannelsById.get(route.id) || []);
  }
  return channelsByRouteId;
}

function parseRewardNumber(raw: unknown): number {
  if (typeof raw !== 'string') return 0;
  const direct = Number.parseFloat(raw.trim());
  if (Number.isFinite(direct) && direct > 0) return direct;
  const matched = raw.match(/[-+]?\d+(?:\.\d+)?/g);
  if (!matched || matched.length === 0) return 0;
  const fallback = Number.parseFloat(matched[matched.length - 1] || '0');
  if (!Number.isFinite(fallback) || fallback <= 0) return 0;
  return fallback;
}

function createHourlyBucketStart(now: Date, offset: number): Date {
  const aligned = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    0,
    0,
    0,
  ));
  return new Date(aligned.getTime() + offset * 60 * 60 * 1000);
}

function normalizeDashboardView(raw: string | undefined): 'summary' | 'insights' | 'all' {
  const normalized = (raw || '').trim().toLowerCase();
  if (normalized === 'summary') return 'summary';
  if (normalized === 'insights') return 'insights';
  return 'all';
}

async function loadDashboardSummaryPayload(db: ReturnType<typeof getCloudflareDb>) {
  const accountRows = await db
    .select({
      id: schema.accounts.id,
      balance: schema.accounts.balance,
      status: schema.accounts.status,
    })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.sites.status, 'active'))
    .all();

  const totalBalance = accountRows.reduce((sum, row) => sum + toFiniteNumber(row.balance), 0);
  const activeAccounts = accountRows.filter((row) => row.status === 'active').length;

  const now = new Date();
  const nowMs = now.getTime();
  const todayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const tomorrowStartUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000);
  const last24h = new Date(nowMs - 24 * 60 * 60 * 1000);
  const lastMinute = new Date(nowMs - 60 * 1000);
  const todayDayKey = formatUtcDayKey(now);

  const [todayCheckins, totalUsedRow, proxy24hRow, proxyPerformanceRow, todaySpendRow] = await Promise.all([
    db
      .select({
        status: schema.checkinLogs.status,
        reward: schema.checkinLogs.reward,
        message: schema.checkinLogs.message,
      })
      .from(schema.checkinLogs)
      .innerJoin(schema.accounts, eq(schema.checkinLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.checkinLogs.createdAt, formatUtcSqlDateTime(todayStartUtc)),
          lt(schema.checkinLogs.createdAt, formatUtcSqlDateTime(tomorrowStartUtc)),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all(),
    db
      .select({
        totalUsed: sql<number>`coalesce(sum(coalesce(${schema.siteDayUsage.totalSiteSpend}, 0)), 0)`,
      })
      .from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .get(),
    db
      .select({
        total: sql<number>`count(*)`,
        success: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
        failed: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 0 else 1 end), 0)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
      })
      .from(schema.proxyLogs)
      .innerJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, formatUtcSqlDateTime(last24h)),
          eq(schema.sites.status, 'active'),
        ),
      )
      .get(),
    db
      .select({
        total: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
      })
      .from(schema.proxyLogs)
      .innerJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, formatUtcSqlDateTime(lastMinute)),
          eq(schema.sites.status, 'active'),
        ),
      )
      .get(),
    db
      .select({
        todaySpend: sql<number>`coalesce(sum(coalesce(${schema.siteDayUsage.totalSiteSpend}, 0)), 0)`,
      })
      .from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.siteDayUsage.localDay, todayDayKey),
          eq(schema.sites.status, 'active'),
        ),
      )
      .get(),
  ]);

  const checkinFailed = todayCheckins.filter((item) => item.status === 'failed').length;
  const checkinSuccess = todayCheckins.length - checkinFailed;
  const todayReward = todayCheckins.reduce((sum, item) => {
    if (item.status !== 'success') return sum;
    const reward = parseRewardNumber(item.reward) || parseRewardNumber(item.message);
    return sum + reward;
  }, 0);

  return {
    totalBalance: toRoundedMicro(totalBalance),
    totalUsed: toRoundedMicro(totalUsedRow?.totalUsed),
    todaySpend: toRoundedMicro(todaySpendRow?.todaySpend),
    todayReward: toRoundedMicro(todayReward),
    activeAccounts,
    totalAccounts: accountRows.length,
    todayCheckin: {
      success: checkinSuccess,
      failed: checkinFailed,
      total: todayCheckins.length,
    },
    proxy24h: {
      success: Math.trunc(toFiniteNumber(proxy24hRow?.success)),
      failed: Math.trunc(toFiniteNumber(proxy24hRow?.failed)),
      total: Math.trunc(toFiniteNumber(proxy24hRow?.total)),
      totalTokens: Math.trunc(toFiniteNumber(proxy24hRow?.totalTokens)),
    },
    performance: {
      windowSeconds: 60,
      requestsPerMinute: Math.trunc(toFiniteNumber(proxyPerformanceRow?.total)),
      tokensPerMinute: Math.trunc(toFiniteNumber(proxyPerformanceRow?.totalTokens)),
    },
  };
}

function buildSiteAvailability(
  sites: Array<{
    id: number;
    name: string;
    url: string;
    platform: string;
    sortOrder: number | null;
    isPinned: boolean | null;
  }>,
  hourRows: Array<{
    siteId: number;
    bucketStartUtc: string;
    totalCalls: number;
    successCalls: number;
    failedCalls: number;
    totalLatencyMs: number;
    latencyCount: number;
  }>,
): SiteAvailabilitySummary[] {
  const now = new Date();
  const bucketStarts = Array.from({ length: 24 }, (_, index) => createHourlyBucketStart(now, index - 23));
  const bucketBySite = new Map<number, Map<string, typeof hourRows[number]>>();

  for (const row of hourRows) {
    const siteBuckets = bucketBySite.get(row.siteId) || new Map<string, typeof row>();
    siteBuckets.set(row.bucketStartUtc, row);
    bucketBySite.set(row.siteId, siteBuckets);
  }

  const sortedSites = [...sites].sort((left, right) => {
    const leftPinned = left.isPinned ? 1 : 0;
    const rightPinned = right.isPinned ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    const leftOrder = Number(left.sortOrder || 0);
    const rightOrder = Number(right.sortOrder || 0);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left.name || '').localeCompare(String(right.name || ''));
  });

  return sortedSites.map((site) => {
    const siteBuckets = bucketBySite.get(site.id) || new Map<string, typeof hourRows[number]>();
    const buckets: SiteAvailabilityBucket[] = bucketStarts.map((start) => {
      const bucketKey = formatUtcSqlDateTime(start);
      const raw = siteBuckets.get(bucketKey);
      const totalRequests = Math.trunc(toFiniteNumber(raw?.totalCalls));
      const successCount = Math.trunc(toFiniteNumber(raw?.successCalls));
      const failedCount = Math.trunc(toFiniteNumber(raw?.failedCalls));
      const totalLatencyMs = Math.trunc(toFiniteNumber(raw?.totalLatencyMs));
      const latencyCount = Math.trunc(toFiniteNumber(raw?.latencyCount));
      return {
        startUtc: start.toISOString(),
        label: bucketKey,
        totalRequests,
        successCount,
        failedCount,
        availabilityPercent: totalRequests > 0
          ? Math.round((successCount / totalRequests) * 100)
          : null,
        averageLatencyMs: latencyCount > 0
          ? Math.round(totalLatencyMs / latencyCount)
          : null,
      };
    });

    const totalRequests = buckets.reduce((sum, bucket) => sum + bucket.totalRequests, 0);
    const successCount = buckets.reduce((sum, bucket) => sum + bucket.successCount, 0);
    const failedCount = buckets.reduce((sum, bucket) => sum + bucket.failedCount, 0);
    const latencySum = buckets.reduce(
      (sum, bucket) => sum + ((bucket.averageLatencyMs || 0) * bucket.totalRequests),
      0,
    );

    return {
      siteId: site.id,
      siteName: site.name,
      siteUrl: site.url,
      platform: site.platform,
      totalRequests,
      successCount,
      failedCount,
      availabilityPercent: totalRequests > 0
        ? Math.round((successCount / totalRequests) * 100)
        : null,
      averageLatencyMs: totalRequests > 0
        ? Math.round(latencySum / totalRequests)
        : null,
      buckets,
    };
  });
}

function buildModelAnalysis(modelRows: Array<{
  localDay: string;
  model: string;
  totalCalls: number;
  successCalls: number;
  totalTokens: number;
  totalSpend: number;
  totalLatencyMs: number;
  latencyCount: number;
}>) {
  type ModelAggregate = {
    model: string;
    calls: number;
    successCalls: number;
    failedCalls: number;
    tokens: number;
    spend: number;
    totalLatencyMs: number;
    latencyCount: number;
  };

  const byModel = new Map<string, ModelAggregate>();
  const spendByDay = new Map<string, number>();
  let totalCalls = 0;
  let totalTokens = 0;
  let totalSpend = 0;

  for (const row of modelRows) {
    const model = (row.model || '').trim() || 'unknown';
    const calls = Math.trunc(toFiniteNumber(row.totalCalls));
    const successCalls = Math.trunc(toFiniteNumber(row.successCalls));
    const tokens = Math.trunc(toFiniteNumber(row.totalTokens));
    const spend = toFiniteNumber(row.totalSpend);
    const latency = Math.trunc(toFiniteNumber(row.totalLatencyMs));
    const latencyCount = Math.trunc(toFiniteNumber(row.latencyCount));
    const failedCalls = Math.max(0, calls - successCalls);

    const existing = byModel.get(model) || {
      model,
      calls: 0,
      successCalls: 0,
      failedCalls: 0,
      tokens: 0,
      spend: 0,
      totalLatencyMs: 0,
      latencyCount: 0,
    };

    existing.calls += calls;
    existing.successCalls += successCalls;
    existing.failedCalls += failedCalls;
    existing.tokens += tokens;
    existing.spend += spend;
    existing.totalLatencyMs += latency;
    existing.latencyCount += latencyCount;
    byModel.set(model, existing);

    totalCalls += calls;
    totalTokens += tokens;
    totalSpend += spend;
    spendByDay.set(row.localDay, (spendByDay.get(row.localDay) || 0) + spend);
  }

  const modelList = [...byModel.values()].sort((left, right) => right.calls - left.calls);
  const spendDistribution = [...modelList]
    .sort((left, right) => right.spend - left.spend)
    .slice(0, 10)
    .map((item) => ({
      model: item.model,
      spend: toRoundedMicro(item.spend),
      calls: item.calls,
    }));

  const callsDistribution = [...modelList]
    .sort((left, right) => right.calls - left.calls)
    .slice(0, 10)
    .map((item) => ({
      model: item.model,
      calls: item.calls,
      share: totalCalls > 0 ? (item.calls / totalCalls) * 100 : 0,
    }));

  const callRanking = [...modelList]
    .sort((left, right) => right.calls - left.calls)
    .slice(0, 10)
    .map((item) => ({
      model: item.model,
      calls: item.calls,
      successRate: item.calls > 0 ? (item.successCalls / item.calls) * 100 : 0,
      avgLatencyMs: item.latencyCount > 0 ? Math.round(item.totalLatencyMs / item.latencyCount) : 0,
      spend: toRoundedMicro(item.spend),
      tokens: item.tokens,
    }));

  const spendTrend = [...spendByDay.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([day, spend]) => ({
      day,
      spend: toRoundedMicro(spend),
    }));

  return {
    totals: {
      spend: toRoundedMicro(totalSpend),
      calls: totalCalls,
      tokens: totalTokens,
    },
    spendDistribution,
    spendTrend,
    callsDistribution,
    callRanking,
  };
}

async function loadDashboardInsightsPayload(db: ReturnType<typeof getCloudflareDb>) {
  const now = new Date();
  const since24Hours = createHourlyBucketStart(now, -23);
  const sinceDay = formatUtcDayKey(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));

  const [activeSites, hourRows, modelRows] = await Promise.all([
    db
      .select({
        id: schema.sites.id,
        name: schema.sites.name,
        url: schema.sites.url,
        platform: schema.sites.platform,
        sortOrder: schema.sites.sortOrder,
        isPinned: schema.sites.isPinned,
      })
      .from(schema.sites)
      .where(eq(schema.sites.status, 'active'))
      .all(),
    db
      .select({
        siteId: schema.siteHourUsage.siteId,
        bucketStartUtc: schema.siteHourUsage.bucketStartUtc,
        totalCalls: schema.siteHourUsage.totalCalls,
        successCalls: schema.siteHourUsage.successCalls,
        failedCalls: schema.siteHourUsage.failedCalls,
        totalLatencyMs: schema.siteHourUsage.totalLatencyMs,
        latencyCount: schema.siteHourUsage.latencyCount,
      })
      .from(schema.siteHourUsage)
      .where(gte(schema.siteHourUsage.bucketStartUtc, formatUtcSqlDateTime(since24Hours)))
      .all(),
    db
      .select({
        localDay: schema.modelDayUsage.localDay,
        model: schema.modelDayUsage.model,
        totalCalls: schema.modelDayUsage.totalCalls,
        successCalls: schema.modelDayUsage.successCalls,
        totalTokens: schema.modelDayUsage.totalTokens,
        totalSpend: schema.modelDayUsage.totalSpend,
        totalLatencyMs: schema.modelDayUsage.totalLatencyMs,
        latencyCount: schema.modelDayUsage.latencyCount,
        siteId: schema.modelDayUsage.siteId,
      })
      .from(schema.modelDayUsage)
      .where(gte(schema.modelDayUsage.localDay, sinceDay))
      .all(),
  ]);

  const activeSiteIds = new Set(activeSites.map((site) => site.id));

  return {
    siteAvailability: buildSiteAvailability(
      activeSites,
      hourRows.filter((row) => activeSiteIds.has(row.siteId)),
    ),
    modelAnalysis: buildModelAnalysis(
      modelRows
        .filter((row) => activeSiteIds.has(row.siteId))
        .map((row) => ({
          localDay: row.localDay,
          model: row.model,
          totalCalls: row.totalCalls,
          successCalls: row.successCalls,
          totalTokens: row.totalTokens,
          totalSpend: row.totalSpend,
          totalLatencyMs: row.totalLatencyMs,
          latencyCount: row.latencyCount,
        })),
    ),
  };
}

async function loadSiteStatsSnapshotPayload(db: ReturnType<typeof getCloudflareDb>, days: number) {
  const sinceDay = formatUtcDayKey(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));

  const [spendRows, trendRows, sites, accountDistributionRows] = await Promise.all([
    db
      .select({
        siteId: schema.siteDayUsage.siteId,
        totalSpend: sql<number>`coalesce(sum(${schema.siteDayUsage.totalSiteSpend}), 0)`,
      })
      .from(schema.siteDayUsage)
      .groupBy(schema.siteDayUsage.siteId)
      .all(),
    db
      .select({
        localDay: schema.siteDayUsage.localDay,
        siteId: schema.siteDayUsage.siteId,
        totalSiteSpend: schema.siteDayUsage.totalSiteSpend,
        totalCalls: schema.siteDayUsage.totalCalls,
      })
      .from(schema.siteDayUsage)
      .where(gte(schema.siteDayUsage.localDay, sinceDay))
      .all(),
    db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.status, 'active'))
      .all(),
    db
      .select({
        siteId: schema.sites.id,
        siteName: schema.sites.name,
        platform: schema.sites.platform,
        totalBalance: sql<number>`coalesce(sum(coalesce(${schema.accounts.balance}, 0)), 0)`,
        accountCount: sql<number>`count(*)`,
      })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .groupBy(schema.sites.id, schema.sites.name, schema.sites.platform)
      .all(),
  ]);

  const spendBySiteId = new Map<number, number>();
  for (const row of spendRows) {
    if (row.siteId == null) continue;
    spendBySiteId.set(row.siteId, toFiniteNumber(row.totalSpend));
  }

  const distribution = accountDistributionRows.map((row) => ({
    siteId: row.siteId,
    siteName: row.siteName,
    platform: row.platform,
    totalBalance: toRoundedMicro(row.totalBalance),
    totalSpend: toRoundedMicro(spendBySiteId.get(row.siteId) || 0),
    accountCount: Math.trunc(toFiniteNumber(row.accountCount)),
  }));

  const activeSiteById = new Map(sites.map((site) => [site.id, site]));
  const dayMap: Record<string, Record<string, { spend: number; calls: number }>> = {};

  for (const row of trendRows) {
    const site = activeSiteById.get(row.siteId);
    if (!site) continue;
    const day = row.localDay;
    const siteName = site.name || 'unknown';
    if (!dayMap[day]) dayMap[day] = {};
    if (!dayMap[day][siteName]) {
      dayMap[day][siteName] = { spend: 0, calls: 0 };
    }
    dayMap[day][siteName].spend += toFiniteNumber(row.totalSiteSpend);
    dayMap[day][siteName].calls += Math.trunc(toFiniteNumber(row.totalCalls));
  }

  const trend = Object.entries(dayMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, siteMap]) => ({
      date,
      sites: Object.fromEntries(
        Object.entries(siteMap).map(([siteName, stats]) => [
          siteName,
          {
            spend: toRoundedMicro(stats.spend),
            calls: stats.calls,
          },
        ]),
      ),
    }));

  return {
    distribution,
    trend,
    sites,
  };
}

function toDownstreamApiKeyPolicyView(row: typeof schema.downstreamApiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    keyMasked: maskSecret(row.key),
    description: row.description || null,
    groupName: typeof row.groupName === 'string' && row.groupName.trim() ? row.groupName.trim() : null,
    tags: parseStringArray(row.tags),
    enabled: !!row.enabled,
    expiresAt: row.expiresAt || null,
    maxCost: row.maxCost ?? null,
    usedCost: toFiniteNumber(row.usedCost),
    maxRequests: row.maxRequests ?? null,
    usedRequests: Math.trunc(toFiniteNumber(row.usedRequests)),
    supportedModels: parseStringArray(row.supportedModels),
    allowedRouteIds: parseNumberArray(row.allowedRouteIds),
    siteWeightMultipliers: parseNumberMap(row.siteWeightMultipliers),
    excludedSiteIds: parseNumberArray(row.excludedSiteIds),
    excludedCredentialRefs: Array.isArray(parseJsonValue(row.excludedCredentialRefs))
      ? parseJsonValue(row.excludedCredentialRefs)
      : [],
    lastUsedAt: row.lastUsedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function buildDateRangeSinceUtc(range: string): string | null {
  const now = new Date();
  if (range === '24h') {
    return formatUtcSqlDateTime(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  }
  if (range === '7d') {
    return formatUtcSqlDateTime(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  }
  return null;
}

function normalizeDownstreamRange(raw: string | undefined): '24h' | '7d' | 'all' {
  const value = (raw || '').trim().toLowerCase();
  if (value === '7d') return '7d';
  if (value === 'all') return 'all';
  return '24h';
}

function normalizeDownstreamStatus(raw: string | undefined): 'all' | 'enabled' | 'disabled' {
  const value = (raw || '').trim().toLowerCase();
  if (value === 'enabled') return 'enabled';
  if (value === 'disabled') return 'disabled';
  return 'all';
}

function normalizeQueryText(raw: string | undefined, maxLength = 80): string {
  const normalized = (raw || '').trim();
  if (!normalized) return '';
  return normalized.slice(0, maxLength);
}

function normalizeTagFilter(raw: string | undefined): string[] {
  const values = (raw || '')
    .split(/[\r\n,，]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.slice(0, 32));
  const deduped = new Map<string, string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, value);
  }
  return [...deduped.values()].slice(0, 20);
}

function normalizeTagMatchMode(raw: string | undefined): 'any' | 'all' {
  return (raw || '').trim().toLowerCase() === 'all' ? 'all' : 'any';
}

function validateDownstreamKeyShape(key: string): boolean {
  return key.startsWith('sk-') && key.length >= 6;
}

type CloudflareRuntimeSettings = Record<string, unknown>;

const DEFAULT_CLOUDFLARE_RUNTIME_SETTINGS: CloudflareRuntimeSettings = {
  checkinCron: '0 8 * * *',
  checkinScheduleMode: 'cron',
  checkinIntervalHours: 6,
  balanceRefreshCron: '0 * * * *',
  logCleanupCron: '0 6 * * *',
  logCleanupUsageLogsEnabled: false,
  logCleanupProgramLogsEnabled: false,
  logCleanupRetentionDays: 30,
  modelAvailabilityProbeEnabled: false,
  codexUpstreamWebsocketEnabled: false,
  responsesCompactFallbackToResponsesEnabled: false,
  disableCrossProtocolFallback: false,
  proxySessionChannelConcurrencyLimit: 2,
  proxySessionChannelQueueWaitMs: 1500,
  routingFallbackUnitCost: 1,
  proxyFirstByteTimeoutSec: 0,
  tokenRouterFailureCooldownMaxSec: 300,
  routingWeights: {
    baseWeightFactor: 1,
    valueScoreFactor: 1,
    costWeight: 1,
    balanceWeight: 1,
    usageWeight: 1,
  },
  systemProxyUrl: '',
  proxyErrorKeywords: [],
  proxyEmptyContentFailEnabled: false,
  adminIpAllowlist: [],
  globalBlockedBrands: [],
  globalAllowedModels: [],
  payloadRules: {},
  serverTimeZone: 'UTC',
  proxyDebugTraceEnabled: false,
  proxyDebugCaptureHeaders: true,
  proxyDebugCaptureBodies: false,
  proxyDebugCaptureStreamChunks: false,
  proxyDebugTargetSessionId: '',
  proxyDebugTargetClientKind: '',
  proxyDebugTargetModel: '',
  proxyDebugRetentionHours: 24,
  proxyDebugMaxBodyBytes: 262144,
};

function normalizeRuntimeSettingsObject(input: unknown): CloudflareRuntimeSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_CLOUDFLARE_RUNTIME_SETTINGS };
  }
  return {
    ...DEFAULT_CLOUDFLARE_RUNTIME_SETTINGS,
    ...(input as Record<string, unknown>),
  };
}

type CloudflareNotificationRuntimeConfig = {
  webhookEnabled: boolean;
  webhookUrl: string;
  barkEnabled: boolean;
  barkUrl: string;
  serverChanEnabled: boolean;
  serverChanKey: string;
  telegramEnabled: boolean;
  telegramApiBaseUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramMessageThreadId: string;
};

function isCloudflareHttpUrl(raw: string): boolean {
  const value = String(raw || '').trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeCloudflareTelegramApiBaseUrl(raw: unknown): string {
  const value = String(raw || '').trim();
  if (!value) return 'https://api.telegram.org';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'https://api.telegram.org';
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') || 'https://api.telegram.org';
  } catch {
    return 'https://api.telegram.org';
  }
}

function resolveCloudflareNotificationRuntimeConfig(settings: CloudflareRuntimeSettings): CloudflareNotificationRuntimeConfig {
  return {
    webhookEnabled: settings.webhookEnabled === true,
    webhookUrl: String(settings.webhookUrl || '').trim(),
    barkEnabled: settings.barkEnabled === true,
    barkUrl: String(settings.barkUrl || '').trim(),
    serverChanEnabled: settings.serverChanEnabled === true,
    serverChanKey: String(settings.serverChanKey || '').trim(),
    telegramEnabled: settings.telegramEnabled === true,
    telegramApiBaseUrl: normalizeCloudflareTelegramApiBaseUrl(settings.telegramApiBaseUrl),
    telegramBotToken: String(settings.telegramBotToken || '').trim(),
    telegramChatId: String(settings.telegramChatId || '').trim(),
    telegramMessageThreadId: String(settings.telegramMessageThreadId || '').trim(),
  };
}

async function sendCloudflareTestNotification(input: {
  settings: CloudflareRuntimeSettings;
}): Promise<{ attempted: number; succeeded: number; failed: number; failedChannels: string[] }> {
  const runtime = resolveCloudflareNotificationRuntimeConfig(input.settings);
  const title = '测试通知';
  const message = '您好，这是一条来自系统设置的连通性测试通知，您的通知相关配置目前工作正常！';
  const level = 'info';
  const timestamp = new Date().toISOString();

  const tasks: Array<{ channel: string; run: () => Promise<void> }> = [];
  if (runtime.webhookEnabled && runtime.webhookUrl) {
    if (!isCloudflareHttpUrl(runtime.webhookUrl)) {
      throw new Error('Webhook URL 格式无效');
    }
    tasks.push({
      channel: 'webhook',
      run: async () => {
        const response = await fetch(runtime.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, message, level, timestamp }),
        });
        if (!response.ok) throw new Error(`Webhook 响应状态 ${response.status}`);
      },
    });
  }

  if (runtime.barkEnabled && runtime.barkUrl) {
    if (!isCloudflareHttpUrl(runtime.barkUrl)) {
      throw new Error('Bark URL 格式无效');
    }
    const barkBase = runtime.barkUrl.replace(/\/+$/, '');
    const barkUrl = `${barkBase}/${encodeURIComponent(title)}/${encodeURIComponent(message)}?group=metapi&level=info`;
    tasks.push({
      channel: 'bark',
      run: async () => {
        const response = await fetch(barkUrl, { method: 'GET' });
        if (!response.ok) throw new Error(`Bark 响应状态 ${response.status}`);
      },
    });
  }

  if (runtime.serverChanEnabled && runtime.serverChanKey) {
    const form = new URLSearchParams({
      title,
      desp: `${message}\n\nLevel: ${level}\nUTC: ${timestamp}`,
    });
    tasks.push({
      channel: 'serverchan',
      run: async () => {
        const response = await fetch(`https://sctapi.ftqq.com/${runtime.serverChanKey}.send`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        if (!response.ok) throw new Error(`Server酱响应状态 ${response.status}`);
      },
    });
  }

  if (runtime.telegramEnabled && runtime.telegramBotToken && runtime.telegramChatId) {
    const url = `${runtime.telegramApiBaseUrl.replace(/\/+$/, '')}/bot${runtime.telegramBotToken}/sendMessage`;
    const threadId = Math.trunc(Number(runtime.telegramMessageThreadId));
    tasks.push({
      channel: 'telegram',
      run: async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: runtime.telegramChatId,
            ...(Number.isFinite(threadId) && threadId > 0 ? { message_thread_id: threadId } : {}),
            text: `[metapi][INFO] ${title}\n\n${message}\n\nUTC: ${timestamp}`,
            disable_web_page_preview: true,
          }),
        });
        if (!response.ok) throw new Error(`Telegram 响应状态 ${response.status}`);
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (payload.ok === false) {
          throw new Error(String(payload.description || 'Telegram 返回失败'));
        }
      },
    });
  }

  if (tasks.length === 0) {
    throw new Error('未启用任何通知渠道，请先开启并保存至少一种通知方式');
  }

  const results = await Promise.all(tasks.map(async (task) => {
    try {
      await task.run();
      return { channel: task.channel, ok: true as const };
    } catch {
      return { channel: task.channel, ok: false as const };
    }
  }));
  const failedChannels = results.filter((item) => !item.ok).map((item) => item.channel);
  const succeeded = results.length - failedChannels.length;
  const failed = failedChannels.length;
  if (succeeded === 0 && failed > 0) {
    throw new Error('通知发送失败：所有渠道均发送失败');
  }
  return {
    attempted: results.length,
    succeeded,
    failed,
    failedChannels,
  };
}

async function loadCloudflareRuntimeSettings(db: ReturnType<typeof getCloudflareDb>, envProxyToken: string | undefined) {
  const stored = await readSetting(db, 'cloudflare_runtime_settings');
  const normalized = normalizeRuntimeSettingsObject(stored);
  const proxyTokenStored = await readSetting(db, 'proxy_token');
  const proxyToken = typeof proxyTokenStored === 'string' && proxyTokenStored.trim()
    ? proxyTokenStored.trim()
    : (envProxyToken || '').trim();
  const proxyTokenMasked = proxyToken ? maskSecret(proxyToken) : '';
  return {
    ...normalized,
    proxyTokenMasked,
  };
}

type CloudflareTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

type CloudflareTaskRow = {
  id: string;
  type: string;
  dedupeKey?: string | null;
  title: string;
  status: CloudflareTaskStatus;
  message: string;
  logs: Array<{ message: string; createdAt: string }>;
  error: unknown | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

const cloudflareTaskStore = new Map<string, CloudflareTaskRow>();

function createCloudflareTask(input: {
  type: string;
  dedupeKey?: string | null;
  title: string;
  status?: CloudflareTaskStatus;
  message?: string;
  error?: unknown | null;
  result?: unknown;
}): CloudflareTaskRow {
  const now = new Date().toISOString();
  const id = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const status = input.status || 'pending';
  const task: CloudflareTaskRow = {
    id,
    type: input.type,
    dedupeKey: input.dedupeKey ? String(input.dedupeKey) : null,
    title: input.title,
    status,
    message: input.message || '',
    logs: input.message
      ? [{ message: input.message, createdAt: now }]
      : [],
    error: input.error || null,
    result: input.result,
    createdAt: now,
    updatedAt: now,
    finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? now : null,
  };
  cloudflareTaskStore.set(id, task);
  return task;
}

function updateCloudflareTask(id: string, patch: Partial<CloudflareTaskRow>): CloudflareTaskRow | null {
  const current = cloudflareTaskStore.get(id);
  if (!current) return null;
  const nextStatus = patch.status || current.status;
  const next: CloudflareTaskRow = {
    ...current,
    ...patch,
    status: nextStatus,
    logs: patch.logs || current.logs,
    updatedAt: new Date().toISOString(),
    finishedAt: ['succeeded', 'failed', 'cancelled'].includes(nextStatus)
      ? (patch.finishedAt || new Date().toISOString())
      : current.finishedAt,
  };
  cloudflareTaskStore.set(id, next);
  return next;
}

function appendCloudflareTaskLog(id: string, message: string): void {
  const text = String(message || '').trim();
  if (!text) return;
  const current = cloudflareTaskStore.get(id);
  if (!current) return;
  const createdAt = new Date().toISOString();
  const logs = [...current.logs, { message: text, createdAt }];
  const cappedLogs = logs.slice(-400);
  cloudflareTaskStore.set(id, {
    ...current,
    logs: cappedLogs,
    message: text,
    updatedAt: createdAt,
  });
}

function parseStoredDateToTimestamp(raw: string | null | undefined): number {
  const text = String(raw || '').trim();
  if (!text) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeProxyLogStatus(raw: unknown): 'success' | 'failed' | 'all' {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'success') return 'success';
  if (value === 'failed') return 'failed';
  return 'all';
}

function normalizeProxyLogClientFilter(raw: string | undefined): { kind: 'app' | 'family'; value: string } | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const index = text.indexOf(':');
  if (index <= 0) return null;
  const kind = text.slice(0, index).trim().toLowerCase();
  const value = text.slice(index + 1).trim().toLowerCase();
  if (!value) return null;
  if (kind === 'app' || kind === 'family') return { kind, value };
  return null;
}

function normalizeProxyLogTimeBoundary(raw: string | undefined): number | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp;
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseConnectionExtraConfig(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return safeJsonObject(parsed);
  } catch {
    return {};
  }
}

function buildUnsupportedOAuthQuota(provider: string) {
  return {
    status: 'unsupported',
    source: 'official',
    providerMessage: `official quota windows are not exposed for ${provider} oauth`,
    windows: {
      fiveHour: {
        supported: false,
        message: 'official 5h quota window is unavailable for this provider',
      },
      sevenDay: {
        supported: false,
        message: 'official 7d quota window is unavailable for this provider',
      },
    },
  };
}

type CloudflareOauthQuotaWindowSnapshot = {
  supported: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
  resetAt?: string;
  message?: string;
};

type CloudflareOauthQuotaSnapshot = {
  status: 'supported' | 'unsupported' | 'error';
  source: 'official' | 'reverse_engineered';
  lastSyncAt?: string;
  lastError?: string;
  providerMessage?: string;
  subscription?: {
    planType?: string;
    activeStart?: string;
    activeUntil?: string;
  };
  windows: {
    fiveHour: CloudflareOauthQuotaWindowSnapshot;
    sevenDay: CloudflareOauthQuotaWindowSnapshot;
  };
  lastLimitResetAt?: string;
};

const CLOUDFLARE_CODEX_QUOTA_PROBE_MODEL = 'gpt-5.4';
const CLOUDFLARE_CODEX_QUOTA_PROBE_VERSION = '0.101.0';
const CLOUDFLARE_CODEX_QUOTA_PROBE_USER_AGENT = 'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';
const CLOUDFLARE_CODEX_QUOTA_PROBE_BETA = 'responses-2025-03-11';
const CLOUDFLARE_CODEX_QUOTA_PROBE_TIMEOUT_MS = 10_000;

function asIsoDateTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asFiniteInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function addSecondsToIso(baseIso: string, seconds?: number): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  const parsed = Date.parse(baseIso);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed + Math.max(0, Math.trunc(seconds)) * 1000).toISOString();
}

function normalizeStoredCloudflareQuotaWindow(value: unknown): CloudflareOauthQuotaWindowSnapshot | null {
  if (!isRecordObject(value)) return null;
  if (typeof value.supported !== 'boolean') return null;
  const window: CloudflareOauthQuotaWindowSnapshot = {
    supported: value.supported,
  };
  if (typeof value.limit === 'number' && Number.isFinite(value.limit)) window.limit = value.limit;
  if (typeof value.used === 'number' && Number.isFinite(value.used)) window.used = value.used;
  if (typeof value.remaining === 'number' && Number.isFinite(value.remaining)) window.remaining = value.remaining;
  const resetAt = asIsoDateTime(value.resetAt);
  if (resetAt) window.resetAt = resetAt;
  const message = asNonEmptyString(value.message);
  if (message) window.message = message;
  return window;
}

function normalizeStoredCloudflareQuotaSnapshot(value: unknown): CloudflareOauthQuotaSnapshot | null {
  if (!isRecordObject(value)) return null;
  const status = value.status === 'supported' || value.status === 'unsupported' || value.status === 'error'
    ? value.status
    : null;
  const source = value.source === 'official' || value.source === 'reverse_engineered'
    ? value.source
    : null;
  const windows = isRecordObject(value.windows) ? value.windows : null;
  if (!status || !source || !windows) return null;
  const fiveHour = normalizeStoredCloudflareQuotaWindow(windows.fiveHour);
  const sevenDay = normalizeStoredCloudflareQuotaWindow(windows.sevenDay);
  if (!fiveHour || !sevenDay) return null;
  const subscription = isRecordObject(value.subscription)
    ? {
      ...(asNonEmptyString(value.subscription.planType) ? { planType: asNonEmptyString(value.subscription.planType) } : {}),
      ...(asIsoDateTime(value.subscription.activeStart) ? { activeStart: asIsoDateTime(value.subscription.activeStart) } : {}),
      ...(asIsoDateTime(value.subscription.activeUntil) ? { activeUntil: asIsoDateTime(value.subscription.activeUntil) } : {}),
    }
    : undefined;
  return {
    status,
    source,
    ...(asIsoDateTime(value.lastSyncAt) ? { lastSyncAt: asIsoDateTime(value.lastSyncAt) } : {}),
    ...(asNonEmptyString(value.lastError) ? { lastError: asNonEmptyString(value.lastError) } : {}),
    ...(asNonEmptyString(value.providerMessage) ? { providerMessage: asNonEmptyString(value.providerMessage) } : {}),
    ...(subscription && Object.keys(subscription).length > 0 ? { subscription } : {}),
    windows: { fiveHour, sevenDay },
    ...(asIsoDateTime(value.lastLimitResetAt) ? { lastLimitResetAt: asIsoDateTime(value.lastLimitResetAt) } : {}),
  };
}

function getAccountOauthRuntimeState(account: typeof schema.accounts.$inferSelect): Record<string, unknown> {
  const extra = parseConnectionExtraConfig(account.extraConfig);
  if (isRecordObject(extra.oauth)) return extra.oauth;
  return {};
}

function buildCloudflareQuotaSnapshotFromAccount(account: typeof schema.accounts.$inferSelect): CloudflareOauthQuotaSnapshot {
  const provider = normalizeOAuthProvider(account.oauthProvider || '');
  const runtime = getAccountOauthRuntimeState(account);
  const stored = normalizeStoredCloudflareQuotaSnapshot(runtime.quota);
  if (stored) return stored;
  const base = buildUnsupportedOAuthQuota(provider) as CloudflareOauthQuotaSnapshot;
  const planType = asNonEmptyString(runtime.planType) || asNonEmptyString(parseConnectionExtraConfig(account.extraConfig).planType);
  return {
    ...base,
    ...(planType ? { subscription: { planType } } : {}),
  };
}

function withUpdatedCloudflareQuotaRuntime(
  account: typeof schema.accounts.$inferSelect,
  quota: CloudflareOauthQuotaSnapshot,
): string {
  const extra = parseConnectionExtraConfig(account.extraConfig);
  const oauth = isRecordObject(extra.oauth) ? extra.oauth : {};
  return JSON.stringify({
    ...extra,
    oauth: {
      ...oauth,
      quota,
    },
  });
}

function getHeaderValue(headers: Headers | Record<string, unknown>, key: string): string | undefined {
  if (headers instanceof Headers) {
    return asNonEmptyString(headers.get(key));
  }
  for (const [entryKey, entryValue] of Object.entries(headers)) {
    if (entryKey.toLowerCase() !== key.toLowerCase()) continue;
    if (typeof entryValue === 'string') return asNonEmptyString(entryValue);
    if (Array.isArray(entryValue)) {
      for (const item of entryValue) {
        const text = asNonEmptyString(item);
        if (text) return text;
      }
    }
  }
  return undefined;
}

type CloudflareCodexQuotaHeaderSnapshot = {
  primaryUsedPercent?: number;
  primaryResetAfterSeconds?: number;
  primaryWindowMinutes?: number;
  secondaryUsedPercent?: number;
  secondaryResetAfterSeconds?: number;
  secondaryWindowMinutes?: number;
  capturedAt: string;
};

function parseCloudflareCodexQuotaHeaders(
  headers: Headers,
  capturedAt = new Date().toISOString(),
): CloudflareCodexQuotaHeaderSnapshot | null {
  const snapshot: CloudflareCodexQuotaHeaderSnapshot = { capturedAt };
  let hasAnyValue = false;
  const assign = (field: keyof Omit<CloudflareCodexQuotaHeaderSnapshot, 'capturedAt'>, value: number | undefined) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    snapshot[field] = value;
    hasAnyValue = true;
  };
  assign('primaryUsedPercent', asFiniteNumber(getHeaderValue(headers, 'x-codex-primary-used-percent')));
  assign('primaryResetAfterSeconds', asFiniteInteger(getHeaderValue(headers, 'x-codex-primary-reset-after-seconds')));
  assign('primaryWindowMinutes', asFiniteInteger(getHeaderValue(headers, 'x-codex-primary-window-minutes')));
  assign('secondaryUsedPercent', asFiniteNumber(getHeaderValue(headers, 'x-codex-secondary-used-percent')));
  assign('secondaryResetAfterSeconds', asFiniteInteger(getHeaderValue(headers, 'x-codex-secondary-reset-after-seconds')));
  assign('secondaryWindowMinutes', asFiniteInteger(getHeaderValue(headers, 'x-codex-secondary-window-minutes')));
  return hasAnyValue ? snapshot : null;
}

function buildCloudflareCodexWindowFromNormalized(input: {
  usedPercent?: number;
  resetAfterSeconds?: number;
  windowMinutes?: number;
  capturedAt: string;
}): CloudflareOauthQuotaWindowSnapshot | null {
  const usedPercent = typeof input.usedPercent === 'number' && Number.isFinite(input.usedPercent)
    ? roundPercent(input.usedPercent)
    : undefined;
  const resetAt = addSecondsToIso(input.capturedAt, input.resetAfterSeconds);
  if (usedPercent === undefined && !resetAt) return null;
  return {
    supported: true,
    ...(usedPercent !== undefined ? { used: usedPercent, limit: 100, remaining: roundPercent(Math.max(0, 100 - usedPercent)) } : {}),
    ...(resetAt ? { resetAt } : {}),
    message: typeof input.windowMinutes === 'number' && Number.isFinite(input.windowMinutes)
      ? `codex ${Math.max(0, Math.trunc(input.windowMinutes))}m window inferred from rate limit headers`
      : 'codex window inferred from rate limit headers',
  };
}

function buildCloudflareCodexQuotaSnapshotFromHeaders(
  account: typeof schema.accounts.$inferSelect,
  headers: Headers,
  capturedAt = new Date().toISOString(),
): CloudflareOauthQuotaSnapshot | null {
  const provider = normalizeOAuthProvider(account.oauthProvider || '');
  if (provider !== 'codex') return null;
  const parsed = parseCloudflareCodexQuotaHeaders(headers, capturedAt);
  if (!parsed) return null;
  const base = buildCloudflareQuotaSnapshotFromAccount(account);

  const primaryMinutes = parsed.primaryWindowMinutes;
  const secondaryMinutes = parsed.secondaryWindowMinutes;
  const hasPrimaryMinutes = typeof primaryMinutes === 'number' && Number.isFinite(primaryMinutes);
  const hasSecondaryMinutes = typeof secondaryMinutes === 'number' && Number.isFinite(secondaryMinutes);
  const primaryIsFiveHour = hasPrimaryMinutes
    ? (!hasSecondaryMinutes || primaryMinutes <= secondaryMinutes)
    : false;
  const fiveHourNormalized = primaryIsFiveHour
    ? {
      usedPercent: parsed.primaryUsedPercent,
      resetAfterSeconds: parsed.primaryResetAfterSeconds,
      windowMinutes: parsed.primaryWindowMinutes,
    }
    : {
      usedPercent: parsed.secondaryUsedPercent,
      resetAfterSeconds: parsed.secondaryResetAfterSeconds,
      windowMinutes: parsed.secondaryWindowMinutes,
    };
  const sevenDayNormalized = primaryIsFiveHour
    ? {
      usedPercent: parsed.secondaryUsedPercent,
      resetAfterSeconds: parsed.secondaryResetAfterSeconds,
      windowMinutes: parsed.secondaryWindowMinutes,
    }
    : {
      usedPercent: parsed.primaryUsedPercent,
      resetAfterSeconds: parsed.primaryResetAfterSeconds,
      windowMinutes: parsed.primaryWindowMinutes,
    };
  const fiveHour = buildCloudflareCodexWindowFromNormalized({
    ...fiveHourNormalized,
    capturedAt: parsed.capturedAt,
  });
  const sevenDay = buildCloudflareCodexWindowFromNormalized({
    ...sevenDayNormalized,
    capturedAt: parsed.capturedAt,
  });
  if (!fiveHour && !sevenDay) return null;
  return {
    ...base,
    status: 'supported',
    source: 'reverse_engineered',
    lastSyncAt: parsed.capturedAt,
    lastError: undefined,
    providerMessage: 'codex usage windows inferred from rate limit response headers',
    windows: {
      fiveHour: fiveHour || base.windows.fiveHour,
      sevenDay: sevenDay || base.windows.sevenDay,
    },
    lastLimitResetAt: fiveHour?.resetAt || sevenDay?.resetAt || base.lastLimitResetAt,
  };
}

function parseCloudflareCodexQuotaResetHint(
  statusCode: number,
  errorBody: string | null | undefined,
  nowMs = Date.now(),
): { resetAt: string; message: string } | null {
  if (statusCode !== 429 || !errorBody) return null;
  try {
    const parsed = JSON.parse(errorBody) as Record<string, unknown>;
    const error = isRecordObject(parsed.error) ? parsed.error : null;
    if (!error || error.type !== 'usage_limit_reached') return null;
    if (typeof error.resets_at === 'number' && Number.isFinite(error.resets_at) && error.resets_at > 0) {
      return {
        resetAt: new Date(error.resets_at * 1000).toISOString(),
        message: 'codex usage_limit_reached reset hint observed from upstream',
      };
    }
    if (typeof error.resets_in_seconds === 'number' && Number.isFinite(error.resets_in_seconds) && error.resets_in_seconds > 0) {
      return {
        resetAt: new Date(nowMs + error.resets_in_seconds * 1000).toISOString(),
        message: 'codex usage_limit_reached reset hint observed from upstream',
      };
    }
  } catch {
    return null;
  }
  return null;
}

function buildCloudflareCodexQuotaProbeUrl(siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  if (base.endsWith('/responses')) return base;
  return `${base}/responses`;
}

function buildCloudflareCodexQuotaProbeHeaders(input: {
  accessToken: string;
  accountId?: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${input.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Connection: 'Keep-Alive',
    Originator: 'codex_cli_rs',
    Version: CLOUDFLARE_CODEX_QUOTA_PROBE_VERSION,
    'User-Agent': CLOUDFLARE_CODEX_QUOTA_PROBE_USER_AGENT,
    'OpenAI-Beta': CLOUDFLARE_CODEX_QUOTA_PROBE_BETA,
    Session_id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...(input.accountId ? { 'Chatgpt-Account-Id': input.accountId } : {}),
  };
}

async function refreshCloudflareOauthQuotaSnapshot(
  db: ReturnType<typeof getCloudflareDb>,
  account: typeof schema.accounts.$inferSelect,
): Promise<CloudflareOauthQuotaSnapshot> {
  const provider = normalizeOAuthProvider(account.oauthProvider || '');
  const syncedAt = new Date().toISOString();
  if (provider !== 'codex') {
    const base = buildCloudflareQuotaSnapshotFromAccount(account);
    const snapshot: CloudflareOauthQuotaSnapshot = {
      ...base,
      lastSyncAt: syncedAt,
      ...(base.status === 'error' ? {} : { lastError: undefined }),
    };
    await db.update(schema.accounts).set({
      extraConfig: withUpdatedCloudflareQuotaRuntime(account, snapshot),
      updatedAt: formatUtcSqlDateTime(),
    }).where(eq(schema.accounts.id, account.id)).run();
    return snapshot;
  }

  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, account.siteId)).get();
  if (!site) {
    throw new Error('oauth site not found');
  }
  const accessToken = String(account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('codex oauth access token missing');
  }
  const runtime = getAccountOauthRuntimeState(account);
  const accountId = asNonEmptyString(runtime.accountId) || asNonEmptyString(runtime.accountKey) || asNonEmptyString(account.oauthAccountKey);
  const payload = JSON.stringify({
    model: CLOUDFLARE_CODEX_QUOTA_PROBE_MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    stream: true,
    store: false,
    instructions: 'You are a helpful assistant.',
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOUDFLARE_CODEX_QUOTA_PROBE_TIMEOUT_MS);
  let snapshot: CloudflareOauthQuotaSnapshot;
  try {
    const response = await fetch(buildCloudflareCodexQuotaProbeUrl(String(site.url || '').trim()), {
      method: 'POST',
      headers: buildCloudflareCodexQuotaProbeHeaders({
        accessToken,
        ...(accountId ? { accountId } : {}),
      }),
      body: payload,
      signal: controller.signal,
    });
    const headerSnapshot = buildCloudflareCodexQuotaSnapshotFromHeaders(account, response.headers, syncedAt);
    if (headerSnapshot) {
      const responseWithBody = response as Response & { body?: ReadableStream<Uint8Array> & { cancel?: () => Promise<void> | void } };
      void Promise.resolve(responseWithBody.body?.cancel?.()).catch(() => {});
      snapshot = headerSnapshot;
    } else {
      const bodyText = await response.text().catch(() => '');
      const resetHint = parseCloudflareCodexQuotaResetHint(response.status, bodyText, Date.now());
      const base = buildCloudflareQuotaSnapshotFromAccount(account);
      const message = response.ok
        ? 'codex quota probe response did not expose x-codex rate limit headers'
        : (bodyText || `codex quota probe failed with status ${response.status}`);
      snapshot = {
        ...base,
        status: 'error',
        lastSyncAt: syncedAt,
        lastError: message,
        providerMessage: message,
        ...(resetHint ? { lastLimitResetAt: resetHint.resetAt } : {}),
      };
    }
  } catch (error) {
    const base = buildCloudflareQuotaSnapshotFromAccount(account);
    const message = controller.signal.aborted
      ? `codex quota probe timeout (${Math.round(CLOUDFLARE_CODEX_QUOTA_PROBE_TIMEOUT_MS / 1000)}s)`
      : (error instanceof Error ? error.message : 'codex quota probe failed');
    snapshot = {
      ...base,
      status: 'error',
      lastSyncAt: syncedAt,
      lastError: message,
      providerMessage: message,
    };
  } finally {
    clearTimeout(timeout);
  }
  await db.update(schema.accounts).set({
    extraConfig: withUpdatedCloudflareQuotaRuntime(account, snapshot),
    updatedAt: formatUtcSqlDateTime(),
  }).where(eq(schema.accounts.id, account.id)).run();
  return snapshot;
}

function normalizeOAuthProvider(raw: unknown): string {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'openai') return 'codex';
  if (value === 'gemini') return 'gemini-cli';
  return value || 'codex';
}

type CloudflareOAuthProviderId = 'codex' | 'claude' | 'gemini-cli' | 'antigravity';
type CloudflareOAuthProviderMetadata = {
  provider: CloudflareOAuthProviderId;
  label: string;
  platform: string;
  enabled: boolean;
  loginType: 'oauth';
  requiresProjectId: boolean;
  supportsDirectAccountRouting: boolean;
  supportsCloudValidation: boolean;
  supportsNativeProxy: boolean;
};
type CloudflareOAuthProviderDefinition = {
  metadata: CloudflareOAuthProviderMetadata;
  site: {
    name: string;
    url: string;
    platform: string;
  };
  loopback: {
    host: string;
    port: number;
    path: string;
    redirectUri: string;
  };
};
type CloudflareOAuthTokenExchangeResult = {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  email?: string;
  accountKey?: string;
  accountId?: string;
  planType?: string;
  projectId?: string;
  idToken?: string;
  providerData?: Record<string, unknown>;
};

const CLOUDFLARE_OAUTH_PROVIDER_DEFINITIONS: CloudflareOAuthProviderDefinition[] = [
  {
    metadata: {
      provider: 'codex',
      label: 'Codex',
      platform: 'codex',
      enabled: true,
      loginType: 'oauth',
      requiresProjectId: false,
      supportsDirectAccountRouting: true,
      supportsCloudValidation: true,
      supportsNativeProxy: true,
    },
    site: {
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
    },
    loopback: {
      host: '127.0.0.1',
      port: 1455,
      path: '/auth/callback',
      redirectUri: 'http://localhost:1455/auth/callback',
    },
  },
  {
    metadata: {
      provider: 'claude',
      label: 'Claude',
      platform: 'claude',
      enabled: true,
      loginType: 'oauth',
      requiresProjectId: false,
      supportsDirectAccountRouting: true,
      supportsCloudValidation: true,
      supportsNativeProxy: true,
    },
    site: {
      name: 'Anthropic Claude OAuth',
      url: 'https://api.anthropic.com',
      platform: 'claude',
    },
    loopback: {
      host: '127.0.0.1',
      port: 54545,
      path: '/callback',
      redirectUri: 'http://localhost:54545/callback',
    },
  },
  {
    metadata: {
      provider: 'gemini-cli',
      label: 'Gemini CLI',
      platform: 'gemini-cli',
      enabled: true,
      loginType: 'oauth',
      requiresProjectId: true,
      supportsDirectAccountRouting: true,
      supportsCloudValidation: true,
      supportsNativeProxy: true,
    },
    site: {
      name: 'Google Gemini CLI OAuth',
      url: 'https://cloudcode-pa.googleapis.com',
      platform: 'gemini-cli',
    },
    loopback: {
      host: '127.0.0.1',
      port: 8085,
      path: '/oauth2callback',
      redirectUri: 'http://localhost:8085/oauth2callback',
    },
  },
  {
    metadata: {
      provider: 'antigravity',
      label: 'Antigravity',
      platform: 'antigravity',
      enabled: true,
      loginType: 'oauth',
      requiresProjectId: false,
      supportsDirectAccountRouting: true,
      supportsCloudValidation: true,
      supportsNativeProxy: true,
    },
    site: {
      name: 'Google Antigravity OAuth',
      url: 'https://cloudcode-pa.googleapis.com',
      platform: 'antigravity',
    },
    loopback: {
      host: '127.0.0.1',
      port: 51121,
      path: '/oauth-callback',
      redirectUri: 'http://localhost:51121/oauth-callback',
    },
  },
];

const CLOUDFLARE_OAUTH_PROVIDERS = new Map<string, CloudflareOAuthProviderDefinition>(
  CLOUDFLARE_OAUTH_PROVIDER_DEFINITIONS.map((definition) => [definition.metadata.provider, definition] as const),
);
const CLOUDFLARE_OAUTH_MANUAL_CALLBACK_DELAY_MS = 15_000;
const CLOUDFLARE_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const CLOUDFLARE_OAUTH_GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CLOUDFLARE_OAUTH_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUDFLARE_OAUTH_GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
const CLOUDFLARE_OAUTH_CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const CLOUDFLARE_OAUTH_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLOUDFLARE_OAUTH_CLAUDE_AUTH_URL = 'https://claude.ai/oauth/authorize';
const CLOUDFLARE_OAUTH_CLAUDE_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const CLOUDFLARE_MAX_OAUTH_IMPORT_BATCH_SIZE = 100;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOauthProjectId(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function base64UrlEncode(bytes: Uint8Array): string {
  return encodeBytesToBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function decodeBase64UrlText(value: string): string {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padding);
  return atob(padded);
}

function parseJwtPayload(token?: string): Record<string, unknown> | null {
  const raw = asNonEmptyString(token);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadText = decodeBase64UrlText(parts[1] || '');
    const payload = JSON.parse(payloadText) as unknown;
    return isRecordObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

type CloudflareImportedNativeOauthJson = {
  type?: unknown;
  provider?: unknown;
  access_token?: unknown;
  session_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  email?: unknown;
  account_id?: unknown;
  account_key?: unknown;
  chatgpt_account_id?: unknown;
  plan_type?: unknown;
  project_id?: unknown;
  cloudaicompanionProject?: unknown;
  provider_data?: unknown;
  expired?: unknown;
  expires_at?: unknown;
  token_expires_at?: unknown;
  disabled?: unknown;
};

class CloudflareOauthImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareOauthImportValidationError';
  }
}

function throwCloudflareOauthImportValidationError(message: string): never {
  throw new CloudflareOauthImportValidationError(message);
}

function mapCloudflareImportedOauthProvider(platform: string): CloudflareOAuthProviderId | null {
  const normalized = platform.trim().toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'claude') return 'claude';
  if (normalized === 'gemini-cli') return 'gemini-cli';
  if (normalized === 'antigravity') return 'antigravity';
  if (normalized === 'openai') return 'codex';
  if (normalized === 'anthropic') return 'claude';
  if (normalized === 'gemini') return 'gemini-cli';
  return null;
}

function parseCloudflareImportedOauthExpiry(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value !== 'string') {
    throwCloudflareOauthImportValidationError('invalid oauth expired timestamp');
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const parsedNumeric = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsedNumeric) && parsedNumeric > 0) {
      return parsedNumeric;
    }
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throwCloudflareOauthImportValidationError('invalid oauth expired timestamp');
  }
  return parsed;
}

function resolveCloudflareImportedOauthIdentity(
  provider: CloudflareOAuthProviderId,
  credentials: Record<string, unknown>,
): CloudflareOAuthTokenExchangeResult {
  const idToken = asNonEmptyString(credentials.id_token);
  const claims = parseJwtPayload(idToken);
  const openAiAuth = isRecordObject(claims?.['https://api.openai.com/auth'])
    ? claims?.['https://api.openai.com/auth'] as Record<string, unknown>
    : null;
  const accessToken = asNonEmptyString(credentials.access_token)
    || asNonEmptyString(credentials.session_token);
  if (!accessToken) {
    throwCloudflareOauthImportValidationError('oauth credentials missing access_token/session_token');
  }
  const email = asNonEmptyString(credentials.email)
    || asNonEmptyString(claims?.email);
  const accountKey = asNonEmptyString(credentials.chatgpt_account_id)
    || asNonEmptyString(credentials.account_key)
    || asNonEmptyString(credentials.account_id)
    || asNonEmptyString(openAiAuth?.chatgpt_account_id)
    || email;
  const planType = asNonEmptyString(credentials.plan_type)
    || asNonEmptyString(openAiAuth?.chatgpt_plan_type);
  const tokenExpiresAt = asPositiveInteger(credentials.expires_at)
    || asPositiveInteger(credentials.token_expires_at);
  const providerData = isRecordObject(credentials.provider_data)
    ? credentials.provider_data as Record<string, unknown>
    : undefined;
  const projectId = asNonEmptyString(credentials.project_id)
    || asNonEmptyString(credentials.cloudaicompanionProject);
  return {
    accessToken,
    ...(asNonEmptyString(credentials.refresh_token) ? { refreshToken: asNonEmptyString(credentials.refresh_token) } : {}),
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {}),
    ...(accountKey ? { accountKey, accountId: accountKey } : {}),
    ...(planType ? { planType } : {}),
    ...(projectId ? { projectId } : {}),
    ...(providerData ? { providerData } : {}),
  };
}

function resolveCloudflareImportedNativeOauthIdentity(payload: CloudflareImportedNativeOauthJson): {
  provider: CloudflareOAuthProviderId;
  disabled: boolean;
  exchange: CloudflareOAuthTokenExchangeResult;
  name: string;
} {
  const rawType = asNonEmptyString(payload.type || payload.provider);
  const payloadRecord = payload as Record<string, unknown>;
  if (rawType === 'sub2api-data' || rawType === 'sub2api-bundle' || Array.isArray(payloadRecord.accounts)) {
    throwCloudflareOauthImportValidationError('native oauth json expected; sub2api envelopes are no longer supported');
  }
  if ('accounts' in payloadRecord || 'proxies' in payloadRecord || 'version' in payloadRecord || 'exported_at' in payloadRecord) {
    throwCloudflareOauthImportValidationError('native oauth json expected; sub2api envelopes are no longer supported');
  }
  const provider = rawType ? mapCloudflareImportedOauthProvider(rawType) : null;
  if (!provider) {
    throwCloudflareOauthImportValidationError(`unsupported oauth import type: ${rawType || 'unknown'}`);
  }
  const accessToken = asNonEmptyString(payload.access_token);
  if (!accessToken) {
    throwCloudflareOauthImportValidationError('oauth credentials missing access_token');
  }
  const derived = resolveCloudflareImportedOauthIdentity(provider, payload as Record<string, unknown>);
  const explicitEmail = asNonEmptyString(payload.email);
  const explicitAccountId = asNonEmptyString(payload.account_id);
  const explicitAccountKey = asNonEmptyString(payload.account_key);
  const tokenExpiresAt = parseCloudflareImportedOauthExpiry(payload.expired);
  const exchange: CloudflareOAuthTokenExchangeResult = {
    ...derived,
    accessToken,
    ...(asNonEmptyString(payload.refresh_token) ? { refreshToken: asNonEmptyString(payload.refresh_token) } : {}),
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    ...(explicitEmail ? { email: explicitEmail } : {}),
    ...(explicitAccountId ? { accountId: explicitAccountId } : {}),
    ...(explicitAccountKey ? { accountKey: explicitAccountKey } : {}),
  };
  if (!exchange.accountKey && exchange.accountId) {
    exchange.accountKey = exchange.accountId;
  }
  if (!exchange.accountId && exchange.accountKey) {
    exchange.accountId = exchange.accountKey;
  }
  return {
    provider,
    disabled: payload.disabled === true,
    exchange,
    name: explicitEmail || explicitAccountKey || explicitAccountId || derived.email || derived.accountKey || derived.accountId || provider,
  };
}

function normalizeCloudflareImportedOauthJsonItems(input: {
  data?: unknown;
  items?: unknown[];
}): unknown[] {
  const batchItems = Array.isArray(input.items) ? input.items : [];
  if (batchItems.length > 0) return batchItems;
  if (input.data === undefined) return [];
  return [input.data];
}

function createRandomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(Math.max(1, Math.trunc(byteLength)));
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function createPkceChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function resolveOauthProviderDefinition(provider: string): CloudflareOAuthProviderDefinition | null {
  return CLOUDFLARE_OAUTH_PROVIDERS.get(normalizeOAuthProvider(provider)) || null;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function resolveSshTunnelHost(requestOrigin?: string): string | undefined {
  if (!requestOrigin) return undefined;
  try {
    const parsed = new URL(requestOrigin);
    if (!parsed.hostname || isLoopbackHost(parsed.hostname)) return undefined;
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

function buildCloudflareLoopbackInstructions(
  definition: CloudflareOAuthProviderDefinition,
  requestOrigin?: string,
) {
  const sshHost = resolveSshTunnelHost(requestOrigin);
  return {
    redirectUri: definition.loopback.redirectUri,
    callbackPort: definition.loopback.port,
    callbackPath: definition.loopback.path,
    manualCallbackDelayMs: CLOUDFLARE_OAUTH_MANUAL_CALLBACK_DELAY_MS,
    sshTunnelCommand: sshHost
      ? `ssh -L ${definition.loopback.port}:127.0.0.1:${definition.loopback.port} root@${sshHost} -p 22`
      : undefined,
    sshTunnelKeyCommand: sshHost
      ? `ssh -i <path_to_your_key> -L ${definition.loopback.port}:127.0.0.1:${definition.loopback.port} root@${sshHost} -p 22`
      : undefined,
  };
}

function parseCloudflareOauthManualCallbackUrl(callbackUrl: string) {
  const raw = asNonEmptyString(callbackUrl);
  if (!raw) {
    throw new Error('invalid oauth callback url');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('invalid oauth callback url');
  }
  const state = asNonEmptyString(parsed.searchParams.get('state'));
  const code = asNonEmptyString(parsed.searchParams.get('code'));
  const errorCode = asNonEmptyString(parsed.searchParams.get('error'));
  const errorDescription = asNonEmptyString(parsed.searchParams.get('error_description'));
  if (!state || (!code && !errorCode)) {
    throw new Error('invalid oauth callback url');
  }
  return {
    state,
    code,
    error: errorCode
      ? (errorDescription ? `${errorCode}: ${errorDescription}` : errorCode)
      : undefined,
  };
}

async function ensureOauthSite(
  db: ReturnType<typeof getCloudflareDb>,
  provider: string,
): Promise<typeof schema.sites.$inferSelect> {
  const normalizedProvider = normalizeOAuthProvider(provider);
  const definition = resolveOauthProviderDefinition(normalizedProvider);
  const existing = await db
    .select()
    .from(schema.sites)
    .where(eq(schema.sites.platform, normalizedProvider))
    .limit(1)
    .get();
  if (existing) return existing;
  const inserted = await db.insert(schema.sites).values({
    name: definition?.site.name || `OAuth ${normalizedProvider}`,
    url: definition?.site.url || `https://${normalizedProvider}.oauth.local`,
    platform: normalizedProvider,
    status: 'active',
    createdAt: formatUtcSqlDateTime(),
    updatedAt: formatUtcSqlDateTime(),
  }).returning().get();
  if (inserted) return inserted;
  const fallback = await db
    .select()
    .from(schema.sites)
    .where(eq(schema.sites.platform, normalizedProvider))
    .limit(1)
    .get();
  if (fallback) return fallback;
  throw new Error('OAuth 站点创建失败');
}

type CloudflareOauthSession = {
  state: string;
  provider: string;
  status: 'pending' | 'success' | 'error';
  authorizationUrl: string;
  codeVerifier: string;
  redirectUri: string;
  rebindAccountId?: number;
  projectId?: string;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  accountId?: number;
  siteId?: number;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
};

const cloudflareOauthSessions = new Map<string, CloudflareOauthSession>();

function pruneExpiredCloudflareOauthSessions(nowMs = Date.now()) {
  for (const [state, session] of cloudflareOauthSessions.entries()) {
    if (session.expiresAtMs <= nowMs) {
      cloudflareOauthSessions.delete(state);
    }
  }
}

function resolveCloudflareOauthSession(state: string): CloudflareOauthSession | null {
  pruneExpiredCloudflareOauthSessions();
  return cloudflareOauthSessions.get(state) || null;
}

function storeCloudflareOauthSession(session: CloudflareOauthSession) {
  pruneExpiredCloudflareOauthSessions();
  cloudflareOauthSessions.set(session.state, session);
}

function markCloudflareOauthSessionError(
  state: string,
  error: string,
): CloudflareOauthSession | null {
  const existing = resolveCloudflareOauthSession(state);
  if (!existing) return null;
  const next: CloudflareOauthSession = {
    ...existing,
    status: 'error',
    error: error.trim() || 'OAuth failed',
    updatedAtMs: Date.now(),
  };
  storeCloudflareOauthSession(next);
  return next;
}

function markCloudflareOauthSessionSuccess(
  state: string,
  patch: { accountId: number; siteId: number },
): CloudflareOauthSession | null {
  const existing = resolveCloudflareOauthSession(state);
  if (!existing) return null;
  const next: CloudflareOauthSession = {
    ...existing,
    status: 'success',
    accountId: patch.accountId,
    siteId: patch.siteId,
    error: undefined,
    updatedAtMs: Date.now(),
  };
  storeCloudflareOauthSession(next);
  return next;
}

async function fetchCloudflareOAuthJson(
  url: string,
  request: RequestInit,
  failureMessage: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, request);
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`${failureMessage}: ${text || `HTTP ${response.status}`}`);
  }
  try {
    const payload = JSON.parse(text) as unknown;
    if (!isRecordObject(payload)) {
      throw new Error('invalid oauth payload');
    }
    return payload;
  } catch {
    throw new Error(`${failureMessage}: invalid response payload`);
  }
}

function parseGoogleTokenPayload(payload: Record<string, unknown>, provider: string): CloudflareOAuthTokenExchangeResult {
  const accessToken = asNonEmptyString(payload.access_token);
  if (!accessToken) {
    throw new Error(`${provider} token exchange response missing access token`);
  }
  return {
    accessToken,
    ...(asNonEmptyString(payload.refresh_token) ? { refreshToken: asNonEmptyString(payload.refresh_token) } : {}),
    ...(asPositiveInteger(payload.expires_in) ? { tokenExpiresAt: Date.now() + asPositiveInteger(payload.expires_in)! * 1000 } : {}),
    providerData: {
      tokenType: asNonEmptyString(payload.token_type) || null,
      scope: asNonEmptyString(payload.scope) || null,
    },
  };
}

function parseClaudeTokenPayload(payload: Record<string, unknown>): CloudflareOAuthTokenExchangeResult {
  const accessToken = asNonEmptyString(payload.access_token);
  if (!accessToken) {
    throw new Error('claude token exchange response missing access token');
  }
  const account = isRecordObject(payload.account) ? payload.account : {};
  const organization = isRecordObject(payload.organization) ? payload.organization : {};
  const accountId = asNonEmptyString(account.uuid);
  const email = asNonEmptyString(account.email_address);
  return {
    accessToken,
    ...(asNonEmptyString(payload.refresh_token) ? { refreshToken: asNonEmptyString(payload.refresh_token) } : {}),
    ...(asPositiveInteger(payload.expires_in) ? { tokenExpiresAt: Date.now() + asPositiveInteger(payload.expires_in)! * 1000 } : {}),
    ...(email ? { email } : {}),
    ...(accountId ? { accountId, accountKey: accountId } : (email ? { accountId: email, accountKey: email } : {})),
    providerData: {
      organizationId: asNonEmptyString(organization.uuid) || null,
      organizationName: asNonEmptyString(organization.name) || null,
    },
  };
}

function parseCodexTokenPayload(payload: Record<string, unknown>): CloudflareOAuthTokenExchangeResult {
  const accessToken = asNonEmptyString(payload.access_token);
  const refreshToken = asNonEmptyString(payload.refresh_token);
  const idToken = asNonEmptyString(payload.id_token);
  const expiresIn = asPositiveInteger(payload.expires_in);
  if (!accessToken || !refreshToken || !idToken || !expiresIn) {
    throw new Error('codex token exchange response missing required fields');
  }
  const claims = parseJwtPayload(idToken);
  const auth = isRecordObject(claims?.['https://api.openai.com/auth'])
    ? claims?.['https://api.openai.com/auth'] as Record<string, unknown>
    : null;
  const accountId = asNonEmptyString(auth?.chatgpt_account_id);
  if (!accountId) {
    throw new Error('codex token exchange response missing chatgpt_account_id');
  }
  return {
    accessToken,
    refreshToken,
    tokenExpiresAt: Date.now() + expiresIn * 1000,
    idToken,
    email: asNonEmptyString(claims?.email),
    accountId,
    accountKey: accountId,
    planType: asNonEmptyString(auth?.chatgpt_plan_type),
  };
}

async function fetchGoogleOauthEmail(accessToken: string): Promise<string | undefined> {
  const response = await fetch(CLOUDFLARE_OAUTH_GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) return undefined;
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  return asNonEmptyString(payload.email);
}

async function exchangeCloudflareOauthAuthorizationCode(input: {
  env: CloudflareHonoEnv['Bindings'];
  provider: CloudflareOAuthProviderId;
  code: string;
  state: string;
  redirectUri: string;
  codeVerifier: string;
  projectId?: string;
}): Promise<CloudflareOAuthTokenExchangeResult> {
  if (input.provider === 'codex') {
    const clientId = asNonEmptyString(input.env.CODEX_CLIENT_ID);
    if (!clientId) throw new Error('CODEX_CLIENT_ID is not configured');
    const payload = await fetchCloudflareOAuthJson(
      CLOUDFLARE_OAUTH_CODEX_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }).toString(),
      },
      'codex token exchange failed',
    );
    return parseCodexTokenPayload(payload);
  }

  if (input.provider === 'claude') {
    const clientId = asNonEmptyString(input.env.CLAUDE_CLIENT_ID);
    if (!clientId) throw new Error('CLAUDE_CLIENT_ID is not configured');
    const payload = await fetchCloudflareOAuthJson(
      CLOUDFLARE_OAUTH_CLAUDE_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          code: input.code,
          state: input.state,
          grant_type: 'authorization_code',
          client_id: clientId,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }),
      },
      'claude token exchange failed',
    );
    return parseClaudeTokenPayload(payload);
  }

  if (input.provider === 'gemini-cli' || input.provider === 'antigravity') {
    const clientId = input.provider === 'gemini-cli'
      ? asNonEmptyString(input.env.GEMINI_CLI_CLIENT_ID)
      : asNonEmptyString(input.env.ANTIGRAVITY_CLIENT_ID);
    const clientSecret = input.provider === 'gemini-cli'
      ? asNonEmptyString(input.env.GEMINI_CLI_CLIENT_SECRET)
      : asNonEmptyString(input.env.ANTIGRAVITY_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw new Error(`${input.provider} oauth client credentials are not configured`);
    }
    const payload = await fetchCloudflareOAuthJson(
      CLOUDFLARE_OAUTH_GOOGLE_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          code: input.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: input.redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      },
      `${input.provider} token exchange failed`,
    );
    const parsed = parseGoogleTokenPayload(payload, input.provider);
    const email = parsed.accessToken ? await fetchGoogleOauthEmail(parsed.accessToken) : undefined;
    const accountKey = email || undefined;
    return {
      ...parsed,
      ...(email ? { email } : {}),
      ...(accountKey ? { accountId: accountKey, accountKey } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
  }

  throw new Error(`unsupported oauth provider: ${input.provider}`);
}

function buildCloudflareOauthAuthorizationUrl(input: {
  env: CloudflareHonoEnv['Bindings'];
  definition: CloudflareOAuthProviderDefinition;
  state: string;
  redirectUri: string;
  codeVerifier: string;
  projectId?: string;
}): Promise<string> | string {
  const provider = input.definition.metadata.provider;
  if (provider === 'codex') {
    const clientId = asNonEmptyString(input.env.CODEX_CLIENT_ID);
    if (!clientId) throw new Error('CODEX_CLIENT_ID is not configured');
    return createPkceChallenge(input.codeVerifier).then((challenge) => {
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: input.redirectUri,
        scope: 'openid email profile offline_access',
        state: input.state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'login',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
      });
      return `${CLOUDFLARE_OAUTH_CODEX_AUTH_URL}?${params.toString()}`;
    });
  }

  if (provider === 'claude') {
    const clientId = asNonEmptyString(input.env.CLAUDE_CLIENT_ID);
    if (!clientId) throw new Error('CLAUDE_CLIENT_ID is not configured');
    return createPkceChallenge(input.codeVerifier).then((challenge) => {
      const params = new URLSearchParams({
        code: 'true',
        client_id: clientId,
        response_type: 'code',
        redirect_uri: input.redirectUri,
        scope: 'org:create_api_key user:profile user:inference',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: input.state,
      });
      return `${CLOUDFLARE_OAUTH_CLAUDE_AUTH_URL}?${params.toString()}`;
    });
  }

  if (provider === 'gemini-cli' || provider === 'antigravity') {
    const clientId = provider === 'gemini-cli'
      ? asNonEmptyString(input.env.GEMINI_CLI_CLIENT_ID)
      : asNonEmptyString(input.env.ANTIGRAVITY_CLIENT_ID);
    if (!clientId) throw new Error(`${provider === 'gemini-cli' ? 'GEMINI_CLI_CLIENT_ID' : 'ANTIGRAVITY_CLIENT_ID'} is not configured`);
    const scopes = provider === 'gemini-cli'
      ? [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ]
      : [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
      ];
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes.join(' '),
      state: input.state,
    });
    return `${CLOUDFLARE_OAUTH_GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  throw new Error(`unsupported oauth provider: ${provider}`);
}

async function findCloudflareExistingOauthAccount(input: {
  db: ReturnType<typeof getCloudflareDb>;
  provider: string;
  accountKey?: string;
  email?: string;
  projectId?: string;
  rebindAccountId?: number;
}) {
  if (typeof input.rebindAccountId === 'number' && input.rebindAccountId > 0) {
    return input.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.rebindAccountId))
      .get();
  }

  const accountKey = asNonEmptyString(input.accountKey);
  const email = asNonEmptyString(input.email);
  const projectIdKey = normalizeOauthProjectId(input.projectId);

  if (accountKey) {
    const candidates = await input.db
      .select()
      .from(schema.accounts)
      .where(and(
        eq(schema.accounts.oauthProvider, input.provider),
        eq(schema.accounts.oauthAccountKey, accountKey),
      ))
      .all();
    const matched = candidates.find((item) => normalizeOauthProjectId(item.oauthProjectId) === projectIdKey);
    if (matched) return matched;
  }

  if (!accountKey && email && normalizeOAuthProvider(input.provider) !== 'codex') {
    const byEmail = await input.db
      .select()
      .from(schema.accounts)
      .where(and(
        eq(schema.accounts.oauthProvider, input.provider),
        eq(schema.accounts.username, email),
      ))
      .get();
    if (byEmail) return byEmail;
  }

  return null;
}

async function persistCloudflareOauthAccount(input: {
  db: ReturnType<typeof getCloudflareDb>;
  definition: CloudflareOAuthProviderDefinition;
  exchange: CloudflareOAuthTokenExchangeResult;
  rebindAccountId?: number;
  projectId?: string;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  persistedStatus?: 'active' | 'disabled';
}) {
  const provider = input.definition.metadata.provider;
  const accountKey = asNonEmptyString(input.exchange.accountKey)
    || asNonEmptyString(input.exchange.accountId)
    || asNonEmptyString(input.exchange.email)
    || `${provider}-${Date.now().toString(36)}`;
  const projectId = asNonEmptyString(input.exchange.projectId)
    || asNonEmptyString(input.projectId)
    || undefined;
  const existing = await findCloudflareExistingOauthAccount({
    db: input.db,
    provider,
    accountKey,
    email: input.exchange.email,
    projectId,
    rebindAccountId: input.rebindAccountId,
  });
  const site = await ensureOauthSite(input.db, provider);
  const username = asNonEmptyString(input.exchange.email) || accountKey;
  const existingExtra = parseConnectionExtraConfig(existing?.extraConfig);
  const prevOauth = isRecordObject(existingExtra.oauth) ? existingExtra.oauth as Record<string, unknown> : {};
  const nextOauth: Record<string, unknown> = {
    ...prevOauth,
    provider,
    accountId: asNonEmptyString(input.exchange.accountId) || accountKey,
    accountKey,
    ...(asNonEmptyString(input.exchange.email) ? { email: asNonEmptyString(input.exchange.email) } : {}),
    ...(asNonEmptyString(input.exchange.planType) ? { planType: asNonEmptyString(input.exchange.planType) } : {}),
    ...(projectId ? { projectId } : {}),
    ...(asNonEmptyString(input.exchange.refreshToken) ? { refreshToken: asNonEmptyString(input.exchange.refreshToken) } : {}),
    ...(typeof input.exchange.tokenExpiresAt === 'number' && Number.isFinite(input.exchange.tokenExpiresAt)
      ? { tokenExpiresAt: Math.trunc(input.exchange.tokenExpiresAt) }
      : {}),
    ...(asNonEmptyString(input.exchange.idToken) ? { idToken: asNonEmptyString(input.exchange.idToken) } : {}),
    ...(isRecordObject(input.exchange.providerData) ? { providerData: input.exchange.providerData } : {}),
  };
  const nextExtraConfig = {
    ...existingExtra,
    credentialMode: 'session',
    email: asNonEmptyString(input.exchange.email) || existingExtra.email || null,
    planType: asNonEmptyString(input.exchange.planType) || existingExtra.planType || null,
    projectId: projectId || existingExtra.projectId || null,
    ...(input.proxyUrl !== undefined ? { proxyUrl: input.proxyUrl } : {}),
    ...(input.useSystemProxy !== undefined ? { useSystemProxy: input.useSystemProxy } : {}),
    oauth: nextOauth,
  };
  const now = formatUtcSqlDateTime();
  const persistedStatus = input.persistedStatus || 'active';

  if (existing) {
    await input.db.update(schema.accounts).set({
      siteId: site.id,
      username,
      accessToken: input.exchange.accessToken,
      apiToken: null,
      checkinEnabled: false,
      status: persistedStatus,
      oauthProvider: provider,
      oauthAccountKey: accountKey,
      oauthProjectId: projectId || null,
      extraConfig: JSON.stringify(nextExtraConfig),
      updatedAt: now,
    }).where(eq(schema.accounts.id, existing.id)).run();
    const updated = await input.db.select().from(schema.accounts).where(eq(schema.accounts.id, existing.id)).get();
    if (!updated) throw new Error('failed to persist oauth account');
    return { account: updated, site };
  }

  const inserted = await input.db.insert(schema.accounts).values({
    siteId: site.id,
    username,
    accessToken: input.exchange.accessToken,
    apiToken: null,
    checkinEnabled: false,
    status: persistedStatus,
    oauthProvider: provider,
    oauthAccountKey: accountKey,
    oauthProjectId: projectId || null,
    extraConfig: JSON.stringify(nextExtraConfig),
    createdAt: now,
    updatedAt: now,
  }).returning({ id: schema.accounts.id }).get();
  if (!inserted?.id) throw new Error('failed to persist oauth account');
  const created = await input.db.select().from(schema.accounts).where(eq(schema.accounts.id, inserted.id)).get();
  if (!created) throw new Error('failed to load persisted oauth account');
  return { account: created, site };
}

async function completeCloudflareOauthCallback(input: {
  db: ReturnType<typeof getCloudflareDb>;
  env: CloudflareHonoEnv['Bindings'];
  provider: string;
  state: string;
  code?: string;
  error?: string;
}): Promise<{ accountId: number; siteId: number }> {
  const session = resolveCloudflareOauthSession(input.state);
  if (!session || session.provider !== normalizeOAuthProvider(input.provider)) {
    throw new Error('oauth session not found or provider mismatch');
  }
  const definition = resolveOauthProviderDefinition(session.provider);
  if (!definition) {
    markCloudflareOauthSessionError(input.state, `unsupported oauth provider: ${session.provider}`);
    throw new Error(`unsupported oauth provider: ${session.provider}`);
  }
  if (input.error) {
    markCloudflareOauthSessionError(input.state, input.error);
    throw new Error(input.error);
  }
  if (session.status === 'success' && session.accountId && session.siteId) {
    return { accountId: session.accountId, siteId: session.siteId };
  }
  const code = asNonEmptyString(input.code);
  if (!code) {
    markCloudflareOauthSessionError(input.state, 'missing oauth code');
    throw new Error('missing oauth code');
  }

  try {
    const exchange = await exchangeCloudflareOauthAuthorizationCode({
      env: input.env,
      provider: definition.metadata.provider,
      code,
      state: input.state,
      redirectUri: session.redirectUri,
      codeVerifier: session.codeVerifier,
      projectId: session.projectId,
    });
    const persisted = await persistCloudflareOauthAccount({
      db: input.db,
      definition,
      exchange,
      rebindAccountId: session.rebindAccountId,
      projectId: session.projectId,
      proxyUrl: session.proxyUrl,
      useSystemProxy: session.useSystemProxy,
    });
    markCloudflareOauthSessionSuccess(input.state, {
      accountId: persisted.account.id,
      siteId: persisted.site.id,
    });
    return {
      accountId: persisted.account.id,
      siteId: persisted.site.id,
    };
  } catch (error) {
    const message = (
      error instanceof Error
        ? (error.message || error.name)
        : String(error || 'OAuth failed')
    ).trim() || 'OAuth failed';
    markCloudflareOauthSessionError(input.state, message);
    throw error;
  }
}

async function startCloudflareOauthProviderFlow(input: {
  env: CloudflareHonoEnv['Bindings'];
  provider: string;
  rebindAccountId?: number;
  projectId?: string;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  requestOrigin?: string;
}) {
  const normalizedProvider = normalizeOAuthProvider(input.provider);
  const definition = resolveOauthProviderDefinition(normalizedProvider);
  if (!definition) {
    throw new Error(`unsupported oauth provider: ${input.provider}`);
  }
  const state = createRandomBase64Url(24);
  const codeVerifier = createRandomBase64Url(48);
  const authorizationUrl = await buildCloudflareOauthAuthorizationUrl({
    env: input.env,
    definition,
    state,
    redirectUri: definition.loopback.redirectUri,
    codeVerifier,
    projectId: input.projectId,
  });
  const now = Date.now();
  storeCloudflareOauthSession({
    state,
    provider: normalizedProvider,
    status: 'pending',
    authorizationUrl,
    codeVerifier,
    redirectUri: definition.loopback.redirectUri,
    rebindAccountId: input.rebindAccountId,
    projectId: asNonEmptyString(input.projectId),
    proxyUrl: input.proxyUrl,
    useSystemProxy: input.useSystemProxy,
    createdAtMs: now,
    updatedAtMs: now,
    expiresAtMs: now + CLOUDFLARE_OAUTH_SESSION_TTL_MS,
  });
  return {
    provider: normalizedProvider,
    state,
    authorizationUrl,
    instructions: buildCloudflareLoopbackInstructions(definition, input.requestOrigin),
  };
}

type CloudflareUpdateCenterVersionSource = 'github-release' | 'docker-hub-tag';

type CloudflareUpdateCenterConfig = {
  enabled: boolean;
  helperBaseUrl: string;
  namespace: string;
  releaseName: string;
  chartRef: string;
  imageRepository: string;
  githubReleasesEnabled: boolean;
  dockerHubTagsEnabled: boolean;
  defaultDeploySource: CloudflareUpdateCenterVersionSource;
};

type CloudflareUpdateCenterVersionCandidate = {
  source: CloudflareUpdateCenterVersionSource;
  rawVersion: string;
  normalizedVersion: string;
  url: string | null;
  tagName?: string | null;
  digest?: string | null;
  displayVersion?: string | null;
  publishedAt?: string | null;
};

type CloudflareUpdateCenterHelperStatus = {
  ok: boolean;
  releaseName: string | null;
  namespace: string | null;
  revision: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  imageDigest: string | null;
  healthy: boolean;
  history?: Array<{
    revision: string;
    updatedAt: string | null;
    status: string | null;
    description: string | null;
    imageRepository: string | null;
    imageTag: string | null;
    imageDigest: string | null;
  }>;
  error?: string;
};

type CloudflareUpdateCenterStatusSnapshot = {
  githubRelease: CloudflareUpdateCenterVersionCandidate | null;
  dockerHubTag: CloudflareUpdateCenterVersionCandidate | null;
  dockerHubRecentTags: CloudflareUpdateCenterVersionCandidate[];
  helper: CloudflareUpdateCenterHelperStatus | null;
};

type CloudflareUpdateCenterRuntimeState = {
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  lastResolvedSource: CloudflareUpdateCenterVersionSource | null;
  lastResolvedDisplayVersion: string | null;
  lastResolvedCandidateKey: string | null;
  lastNotifiedCandidateKey: string | null;
  lastNotifiedAt: string | null;
  statusSnapshot: CloudflareUpdateCenterStatusSnapshot | null;
};

const UPDATE_CENTER_CONFIG_SETTING_KEY = 'update_center_k3s_config_v1';
const UPDATE_CENTER_RUNTIME_STATE_SETTING_KEY = 'update_center_runtime_state_v1';
const UPDATE_CENTER_DEPLOY_TASK_TYPE = 'update-center.deploy';
const UPDATE_CENTER_GITHUB_RELEASES_URL = 'https://api.github.com/repos/cita-777/metapi/releases';
const UPDATE_CENTER_DOCKER_HUB_TAGS_URL = 'https://hub.docker.com/v2/repositories/1467078763/metapi/tags?page_size=100';
const UPDATE_CENTER_FETCH_TIMEOUT_MS = 12_000;
const UPDATE_CENTER_STABLE_SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/i;

function getDefaultCloudflareUpdateCenterConfig(): CloudflareUpdateCenterConfig {
  return {
    enabled: false,
    helperBaseUrl: '',
    namespace: 'default',
    releaseName: '',
    chartRef: '',
    imageRepository: '1467078763/metapi',
    githubReleasesEnabled: true,
    dockerHubTagsEnabled: true,
    defaultDeploySource: 'github-release',
  };
}

function normalizeUpdateCenterConfig(input: unknown): CloudflareUpdateCenterConfig {
  const defaults = getDefaultCloudflareUpdateCenterConfig();
  const record = safeJsonObject(input);
  const defaultDeploySource = record.defaultDeploySource === 'docker-hub-tag'
    ? 'docker-hub-tag'
    : 'github-release';
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : defaults.enabled,
    helperBaseUrl: String(record.helperBaseUrl || '').trim(),
    namespace: String(record.namespace || '').trim() || defaults.namespace,
    releaseName: String(record.releaseName || '').trim(),
    chartRef: String(record.chartRef || '').trim(),
    imageRepository: String(record.imageRepository || '').trim() || defaults.imageRepository,
    githubReleasesEnabled: typeof record.githubReleasesEnabled === 'boolean' ? record.githubReleasesEnabled : defaults.githubReleasesEnabled,
    dockerHubTagsEnabled: typeof record.dockerHubTagsEnabled === 'boolean' ? record.dockerHubTagsEnabled : defaults.dockerHubTagsEnabled,
    defaultDeploySource,
  };
}

function getDefaultCloudflareUpdateCenterRuntimeState(): CloudflareUpdateCenterRuntimeState {
  return {
    lastCheckedAt: null,
    lastCheckError: null,
    lastResolvedSource: null,
    lastResolvedDisplayVersion: null,
    lastResolvedCandidateKey: null,
    lastNotifiedCandidateKey: null,
    lastNotifiedAt: null,
    statusSnapshot: null,
  };
}

function normalizeNullableText(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function normalizeUpdateCenterVersionSource(value: unknown): CloudflareUpdateCenterVersionSource | null {
  return value === 'docker-hub-tag' || value === 'github-release' ? value : null;
}

function normalizeUpdateCenterVersionCandidate(value: unknown): CloudflareUpdateCenterVersionCandidate | null {
  const record = safeJsonObject(value);
  const source = normalizeUpdateCenterVersionSource(record.source);
  const rawVersion = normalizeNullableText(record.rawVersion);
  const normalizedVersion = normalizeNullableText(record.normalizedVersion);
  if (!source || !rawVersion || !normalizedVersion) return null;
  return {
    source,
    rawVersion,
    normalizedVersion,
    url: normalizeNullableText(record.url),
    tagName: normalizeNullableText(record.tagName),
    digest: normalizeNullableText(record.digest),
    displayVersion: normalizeNullableText(record.displayVersion),
    publishedAt: normalizeNullableText(record.publishedAt),
  };
}

function normalizeUpdateCenterVersionCandidateList(value: unknown): CloudflareUpdateCenterVersionCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeUpdateCenterVersionCandidate(item))
    .filter((item): item is CloudflareUpdateCenterVersionCandidate => !!item);
}

function normalizeUpdateCenterHelperHistory(value: unknown): NonNullable<CloudflareUpdateCenterHelperStatus['history']> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = safeJsonObject(item);
      const revision = normalizeNullableText(record.revision);
      if (!revision) return null;
      return {
        revision,
        updatedAt: normalizeNullableText(record.updatedAt),
        status: normalizeNullableText(record.status),
        description: normalizeNullableText(record.description),
        imageRepository: normalizeNullableText(record.imageRepository),
        imageTag: normalizeNullableText(record.imageTag),
        imageDigest: normalizeNullableText(record.imageDigest),
      };
    })
    .filter((item): item is NonNullable<CloudflareUpdateCenterHelperStatus['history']>[number] => !!item);
}

function normalizeUpdateCenterHelperStatus(value: unknown): CloudflareUpdateCenterHelperStatus | null {
  const record = safeJsonObject(value);
  if (Object.keys(record).length === 0) return null;
  return {
    ok: !!record.ok,
    releaseName: normalizeNullableText(record.releaseName),
    namespace: normalizeNullableText(record.namespace),
    revision: normalizeNullableText(record.revision),
    imageRepository: normalizeNullableText(record.imageRepository),
    imageTag: normalizeNullableText(record.imageTag),
    imageDigest: normalizeNullableText(record.imageDigest),
    healthy: !!record.healthy,
    error: normalizeNullableText(record.error) || undefined,
    history: normalizeUpdateCenterHelperHistory(record.history),
  };
}

function normalizeUpdateCenterStatusSnapshot(value: unknown): CloudflareUpdateCenterStatusSnapshot | null {
  const record = safeJsonObject(value);
  if (Object.keys(record).length === 0) return null;
  return {
    githubRelease: normalizeUpdateCenterVersionCandidate(record.githubRelease),
    dockerHubTag: normalizeUpdateCenterVersionCandidate(record.dockerHubTag),
    dockerHubRecentTags: normalizeUpdateCenterVersionCandidateList(record.dockerHubRecentTags),
    helper: normalizeUpdateCenterHelperStatus(record.helper),
  };
}

function normalizeCloudflareUpdateCenterRuntimeState(value: unknown): CloudflareUpdateCenterRuntimeState {
  const defaults = getDefaultCloudflareUpdateCenterRuntimeState();
  const record = safeJsonObject(value);
  return {
    lastCheckedAt: normalizeNullableText(record.lastCheckedAt),
    lastCheckError: normalizeNullableText(record.lastCheckError),
    lastResolvedSource: normalizeUpdateCenterVersionSource(record.lastResolvedSource),
    lastResolvedDisplayVersion: normalizeNullableText(record.lastResolvedDisplayVersion),
    lastResolvedCandidateKey: normalizeNullableText(record.lastResolvedCandidateKey),
    lastNotifiedCandidateKey: normalizeNullableText(record.lastNotifiedCandidateKey),
    lastNotifiedAt: normalizeNullableText(record.lastNotifiedAt),
    statusSnapshot: Object.prototype.hasOwnProperty.call(record, 'statusSnapshot')
      ? normalizeUpdateCenterStatusSnapshot(record.statusSnapshot)
      : defaults.statusSnapshot,
  };
}

function parseStableSemVer(text: string): { normalized: string; major: number; minor: number; patch: number } | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const matched = raw.match(UPDATE_CENTER_STABLE_SEMVER);
  if (!matched) return null;
  const major = Number.parseInt(matched[1] || '', 10);
  const minor = Number.parseInt(matched[2] || '', 10);
  const patch = Number.parseInt(matched[3] || '', 10);
  if (![major, minor, patch].every(Number.isFinite)) return null;
  return {
    normalized: `${major}.${minor}.${patch}`,
    major,
    minor,
    patch,
  };
}

function compareStableSemVer(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number },
): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function normalizeUpdateCenterDigest(value: unknown): string | null {
  const text = String(value || '').trim();
  if (!text) return null;
  return /^sha256:[a-f0-9]{64}$/i.test(text) ? text.toLowerCase() : null;
}

function toUpdateCenterShortDigest(value: string | null | undefined): string | null {
  const digest = String(value || '').trim();
  if (!digest) return null;
  return digest.slice(0, 'sha256:'.length + 12);
}

function ensureUrlWithoutTrailingSlash(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, label: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CENTER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${label} failed with HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : `${label} failed`;
    if (message.toLowerCase().includes('abort')) {
      throw new Error(`${label} timeout (${Math.round(UPDATE_CENTER_FETCH_TIMEOUT_MS / 1000)}s)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeDockerHubPublishedAt(record: Record<string, unknown>): string | null {
  return normalizeNullableText(record.tag_last_pushed) || normalizeNullableText(record.last_updated);
}

function normalizeDockerHubPublishedTimestamp(record: Record<string, unknown>): number {
  const publishedAt = normalizeDockerHubPublishedAt(record);
  if (!publishedAt) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(publishedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function normalizeDockerHubTagCandidate(
  tagName: string,
  source: CloudflareUpdateCenterVersionSource,
  digest: string | null,
  publishedAt: string | null,
): CloudflareUpdateCenterVersionCandidate {
  return {
    source,
    rawVersion: tagName,
    normalizedVersion: tagName,
    url: null,
    tagName,
    digest,
    displayVersion: digest ? `${tagName} @ ${toUpdateCenterShortDigest(digest)}` : tagName,
    publishedAt,
  };
}

async function fetchLatestStableGithubRelease(): Promise<CloudflareUpdateCenterVersionCandidate | null> {
  const payload = await fetchJsonWithTimeout(
    UPDATE_CENTER_GITHUB_RELEASES_URL,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'metapi-update-center-worker/1.0',
      },
    },
    'GitHub releases lookup',
  );
  const releases = Array.isArray(payload) ? payload : [];
  let selected: { semver: { normalized: string; major: number; minor: number; patch: number }; release: Record<string, unknown> } | null = null;
  for (const item of releases) {
    const release = safeJsonObject(item);
    if (release.draft === true || release.prerelease === true) continue;
    const tag = String(release.tag_name || '').trim();
    const semver = parseStableSemVer(tag);
    if (!semver) continue;
    if (!selected || compareStableSemVer(semver, selected.semver) > 0) {
      selected = { semver, release };
    }
  }
  if (!selected) return null;
  const tagName = String(selected.release.tag_name || '').trim() || selected.semver.normalized;
  return {
    source: 'github-release',
    rawVersion: tagName,
    normalizedVersion: selected.semver.normalized,
    url: normalizeNullableText(selected.release.html_url),
    tagName,
    digest: null,
    displayVersion: selected.semver.normalized,
    publishedAt: normalizeNullableText(selected.release.published_at),
  };
}

async function fetchDockerHubTagCandidates(): Promise<{
  primary: CloudflareUpdateCenterVersionCandidate | null;
  recentNonStable: CloudflareUpdateCenterVersionCandidate[];
}> {
  const payload = await fetchJsonWithTimeout(
    UPDATE_CENTER_DOCKER_HUB_TAGS_URL,
    {
      headers: {
        accept: 'application/json',
        'user-agent': 'metapi-update-center-worker/1.0',
      },
    },
    'Docker Hub tag lookup',
  );
  const root = safeJsonObject(payload);
  const results = Array.isArray(root.results) ? root.results : [];
  const records = results
    .map((item) => safeJsonObject(item))
    .filter((item) => String(item.name || '').trim().length > 0);

  const findAlias = (alias: string) => records.find((item) => String(item.name || '').trim() === alias);
  const aliasRecord = findAlias('latest') || findAlias('main');

  let primary: CloudflareUpdateCenterVersionCandidate | null = null;
  if (aliasRecord) {
    const tagName = String(aliasRecord.name || '').trim();
    primary = normalizeDockerHubTagCandidate(
      tagName,
      'docker-hub-tag',
      normalizeUpdateCenterDigest(aliasRecord.digest),
      normalizeDockerHubPublishedAt(aliasRecord),
    );
  } else {
    let selected: { semver: { normalized: string; major: number; minor: number; patch: number }; record: Record<string, unknown> } | null = null;
    for (const record of records) {
      const tagName = String(record.name || '').trim();
      const semver = parseStableSemVer(tagName);
      if (!semver) continue;
      if (!selected || compareStableSemVer(semver, selected.semver) > 0) {
        selected = { semver, record };
      }
    }
    if (selected) {
      const tagName = String(selected.record.name || '').trim();
      primary = {
        source: 'docker-hub-tag',
        rawVersion: tagName,
        normalizedVersion: selected.semver.normalized,
        url: null,
        tagName,
        digest: normalizeUpdateCenterDigest(selected.record.digest),
        displayVersion: normalizeUpdateCenterDigest(selected.record.digest)
          ? `${tagName} @ ${toUpdateCenterShortDigest(normalizeUpdateCenterDigest(selected.record.digest))}`
          : tagName,
        publishedAt: normalizeDockerHubPublishedAt(selected.record),
      };
    }
  }

  const isStableTag = (tag: string): boolean => tag === 'latest' || tag === 'main' || !!parseStableSemVer(tag);
  const dedupedRecent = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const tagName = String(record.name || '').trim();
    if (!tagName || isStableTag(tagName)) continue;
    const existing = dedupedRecent.get(tagName);
    if (!existing || normalizeDockerHubPublishedTimestamp(record) > normalizeDockerHubPublishedTimestamp(existing)) {
      dedupedRecent.set(tagName, record);
    }
  }
  const recentNonStable = [...dedupedRecent.values()]
    .sort((left, right) => normalizeDockerHubPublishedTimestamp(right) - normalizeDockerHubPublishedTimestamp(left))
    .slice(0, 5)
    .map((record) => {
      const tagName = String(record.name || '').trim();
      return normalizeDockerHubTagCandidate(
        tagName,
        'docker-hub-tag',
        normalizeUpdateCenterDigest(record.digest),
        normalizeDockerHubPublishedAt(record),
      );
    });

  return { primary, recentNonStable };
}

async function loadCloudflareUpdateCenterConfig(db: ReturnType<typeof getCloudflareDb>): Promise<CloudflareUpdateCenterConfig> {
  const stored = await readSetting(db, UPDATE_CENTER_CONFIG_SETTING_KEY);
  return normalizeUpdateCenterConfig(stored);
}

async function saveCloudflareUpdateCenterConfig(
  db: ReturnType<typeof getCloudflareDb>,
  input: unknown,
): Promise<CloudflareUpdateCenterConfig> {
  const next = normalizeUpdateCenterConfig(input);
  await writeSetting(db, UPDATE_CENTER_CONFIG_SETTING_KEY, next);
  return next;
}

async function loadCloudflareUpdateCenterRuntimeState(db: ReturnType<typeof getCloudflareDb>): Promise<CloudflareUpdateCenterRuntimeState> {
  const stored = await readSetting(db, UPDATE_CENTER_RUNTIME_STATE_SETTING_KEY);
  return normalizeCloudflareUpdateCenterRuntimeState(stored);
}

async function saveCloudflareUpdateCenterRuntimeState(
  db: ReturnType<typeof getCloudflareDb>,
  input: unknown,
): Promise<CloudflareUpdateCenterRuntimeState> {
  const next = normalizeCloudflareUpdateCenterRuntimeState(input);
  await writeSetting(db, UPDATE_CENTER_RUNTIME_STATE_SETTING_KEY, next);
  return next;
}

function resolveUpdateCenterHelperTokenFromEnv(env: CloudflareHonoEnv['Bindings']): string {
  return String(env.DEPLOY_HELPER_TOKEN || env.UPDATE_CENTER_HELPER_TOKEN || '').trim();
}

async function fetchUpdateCenterHelperStatus(
  config: CloudflareUpdateCenterConfig,
  helperToken: string,
): Promise<CloudflareUpdateCenterHelperStatus> {
  if (!config.helperBaseUrl) {
    return {
      ok: false,
      releaseName: null,
      namespace: null,
      revision: null,
      imageRepository: null,
      imageTag: null,
      imageDigest: null,
      healthy: false,
      history: [],
      error: 'helperBaseUrl is required',
    };
  }
  if (!helperToken) {
    return {
      ok: false,
      releaseName: null,
      namespace: null,
      revision: null,
      imageRepository: null,
      imageTag: null,
      imageDigest: null,
      healthy: false,
      history: [],
      error: 'DEPLOY_HELPER_TOKEN is required',
    };
  }
  try {
    const query = new URLSearchParams({
      namespace: config.namespace,
      releaseName: config.releaseName,
    });
    const payload = await fetchJsonWithTimeout(
      `${ensureUrlWithoutTrailingSlash(config.helperBaseUrl)}/status?${query.toString()}`,
      {
        headers: {
          authorization: `Bearer ${helperToken}`,
          accept: 'application/json',
        },
      },
      'deploy helper status',
    );
    const normalized = normalizeUpdateCenterHelperStatus(payload);
    if (!normalized) {
      throw new Error('helper status payload is invalid');
    }
    return normalized;
  } catch (error: unknown) {
    return {
      ok: false,
      releaseName: null,
      namespace: null,
      revision: null,
      imageRepository: null,
      imageTag: null,
      imageDigest: null,
      healthy: false,
      history: [],
      error: error instanceof Error ? error.message : 'helper status failed',
    };
  }
}

function resolveUpdateCenterCandidateKey(candidate: CloudflareUpdateCenterVersionCandidate | null): string | null {
  if (!candidate) return null;
  const tag = String(candidate.tagName || candidate.rawVersion || candidate.normalizedVersion || '').trim();
  const digest = String(candidate.digest || '').trim();
  const source = candidate.source;
  if (!tag) return null;
  return `${source}:${tag}${digest ? `@${digest}` : ''}`;
}

function pickPreferredUpdateCenterCandidate(input: {
  defaultSource: CloudflareUpdateCenterVersionSource;
  githubRelease: CloudflareUpdateCenterVersionCandidate | null;
  dockerHubTag: CloudflareUpdateCenterVersionCandidate | null;
}): CloudflareUpdateCenterVersionCandidate | null {
  if (input.defaultSource === 'github-release') {
    return input.githubRelease || input.dockerHubTag;
  }
  return input.dockerHubTag || input.githubRelease;
}

function getUpdateCenterTaskState() {
  const tasks = [...cloudflareTaskStore.values()]
    .filter((task) => task.type === UPDATE_CENTER_DEPLOY_TASK_TYPE)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const runningTask = tasks.find((task) => task.status === 'running' || task.status === 'pending') || null;
  const lastFinishedTask = tasks.find((task) => ['succeeded', 'failed', 'cancelled'].includes(task.status)) || null;
  return { runningTask, lastFinishedTask };
}

type CloudflareUpdateCenterStatusPayload = {
  currentVersion: string;
  config: CloudflareUpdateCenterConfig;
  githubRelease: CloudflareUpdateCenterVersionCandidate | null;
  dockerHubTag: CloudflareUpdateCenterVersionCandidate | null;
  dockerHubRecentTags: CloudflareUpdateCenterVersionCandidate[];
  helper: CloudflareUpdateCenterHelperStatus | null;
  runningTask: { id: string; status: string } | null;
  lastFinishedTask: { id: string; status: string; finishedAt: string | null } | null;
  runtime: {
    lastCheckedAt: string | null;
    lastCheckError: string | null;
    lastResolvedSource: CloudflareUpdateCenterVersionSource | null;
    lastResolvedDisplayVersion: string | null;
    lastResolvedCandidateKey: string | null;
    lastNotifiedCandidateKey: string | null;
    lastNotifiedAt: string | null;
  };
};

async function refreshCloudflareUpdateCenterStatusPayload(
  db: ReturnType<typeof getCloudflareDb>,
  env: CloudflareHonoEnv['Bindings'],
): Promise<CloudflareUpdateCenterStatusPayload> {
  const config = await loadCloudflareUpdateCenterConfig(db);
  const runtime = await loadCloudflareUpdateCenterRuntimeState(db);
  const helperToken = resolveUpdateCenterHelperTokenFromEnv(env);
  let githubRelease: CloudflareUpdateCenterVersionCandidate | null = null;
  let dockerHubTag: CloudflareUpdateCenterVersionCandidate | null = null;
  let dockerHubRecentTags: CloudflareUpdateCenterVersionCandidate[] = [];
  let helper: CloudflareUpdateCenterHelperStatus | null = null;
  const checkErrors: string[] = [];

  if (config.githubReleasesEnabled) {
    try {
      githubRelease = await fetchLatestStableGithubRelease();
    } catch (error: unknown) {
      checkErrors.push(error instanceof Error ? error.message : 'GitHub release lookup failed');
    }
  }
  if (config.dockerHubTagsEnabled) {
    try {
      const dockerCandidates = await fetchDockerHubTagCandidates();
      dockerHubTag = dockerCandidates.primary;
      dockerHubRecentTags = dockerCandidates.recentNonStable;
    } catch (error: unknown) {
      checkErrors.push(error instanceof Error ? error.message : 'Docker Hub tag lookup failed');
    }
  }

  helper = await fetchUpdateCenterHelperStatus(config, helperToken);
  if (helper?.error) {
    checkErrors.push(String(helper.error));
  }

  const preferred = pickPreferredUpdateCenterCandidate({
    defaultSource: config.defaultDeploySource,
    githubRelease,
    dockerHubTag,
  });
  const candidateKey = resolveUpdateCenterCandidateKey(preferred);
  const now = new Date().toISOString();
  const nextRuntime: CloudflareUpdateCenterRuntimeState = {
    ...runtime,
    lastCheckedAt: now,
    lastCheckError: checkErrors.length > 0 ? checkErrors[0] || null : null,
    lastResolvedSource: preferred?.source || null,
    lastResolvedDisplayVersion: preferred?.displayVersion || preferred?.normalizedVersion || null,
    lastResolvedCandidateKey: candidateKey,
    statusSnapshot: {
      githubRelease,
      dockerHubTag,
      dockerHubRecentTags,
      helper,
    },
  };
  await saveCloudflareUpdateCenterRuntimeState(db, nextRuntime);
  const { runningTask, lastFinishedTask } = getUpdateCenterTaskState();
  const currentVersion = String(helper?.imageTag || '').trim() || 'cloudflare-worker';
  return {
    currentVersion,
    config,
    githubRelease,
    dockerHubTag,
    dockerHubRecentTags,
    helper,
    runningTask: runningTask ? { id: runningTask.id, status: runningTask.status } : null,
    lastFinishedTask: lastFinishedTask
      ? { id: lastFinishedTask.id, status: lastFinishedTask.status, finishedAt: lastFinishedTask.finishedAt }
      : null,
    runtime: {
      lastCheckedAt: nextRuntime.lastCheckedAt,
      lastCheckError: nextRuntime.lastCheckError,
      lastResolvedSource: nextRuntime.lastResolvedSource,
      lastResolvedDisplayVersion: nextRuntime.lastResolvedDisplayVersion,
      lastResolvedCandidateKey: nextRuntime.lastResolvedCandidateKey,
      lastNotifiedCandidateKey: nextRuntime.lastNotifiedCandidateKey,
      lastNotifiedAt: nextRuntime.lastNotifiedAt,
    },
  };
}

async function readCloudflareUpdateCenterStatusPayload(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<CloudflareUpdateCenterStatusPayload> {
  const config = await loadCloudflareUpdateCenterConfig(db);
  const runtime = await loadCloudflareUpdateCenterRuntimeState(db);
  const snapshot = runtime.statusSnapshot || {
    githubRelease: null,
    dockerHubTag: null,
    dockerHubRecentTags: [],
    helper: null,
  };
  const { runningTask, lastFinishedTask } = getUpdateCenterTaskState();
  const helper = snapshot.helper;
  const currentVersion = String(helper?.imageTag || '').trim() || 'cloudflare-worker';
  return {
    currentVersion,
    config,
    githubRelease: snapshot.githubRelease || null,
    dockerHubTag: snapshot.dockerHubTag || null,
    dockerHubRecentTags: snapshot.dockerHubRecentTags || [],
    helper: snapshot.helper || null,
    runningTask: runningTask ? { id: runningTask.id, status: runningTask.status } : null,
    lastFinishedTask: lastFinishedTask
      ? { id: lastFinishedTask.id, status: lastFinishedTask.status, finishedAt: lastFinishedTask.finishedAt }
      : null,
    runtime: {
      lastCheckedAt: runtime.lastCheckedAt,
      lastCheckError: runtime.lastCheckError,
      lastResolvedSource: runtime.lastResolvedSource,
      lastResolvedDisplayVersion: runtime.lastResolvedDisplayVersion,
      lastResolvedCandidateKey: runtime.lastResolvedCandidateKey,
      lastNotifiedCandidateKey: runtime.lastNotifiedCandidateKey,
      lastNotifiedAt: runtime.lastNotifiedAt,
    },
  };
}

function buildUpdateCenterDeployBlockMessage(input: {
  config: CloudflareUpdateCenterConfig;
  helper: CloudflareUpdateCenterHelperStatus | null;
  targetTag: string;
  targetDigest: string | null;
}): string | null {
  if (!input.config.enabled) return 'update center is disabled';
  if (!input.config.helperBaseUrl) return 'helperBaseUrl is required';
  if (!input.config.namespace) return 'namespace is required';
  if (!input.config.releaseName) return 'releaseName is required';
  if (!input.config.chartRef) return 'chartRef is required';
  if (!input.config.imageRepository) return 'imageRepository is required';
  if (!input.helper?.healthy) return input.helper?.error || 'deploy helper is not healthy';
  const currentTag = String(input.helper.imageTag || '').trim();
  const currentDigest = normalizeUpdateCenterDigest(input.helper.imageDigest);
  if (currentTag && currentTag === input.targetTag) {
    if (!input.targetDigest || !currentDigest || currentDigest === input.targetDigest) {
      return 'target image is already running';
    }
  }
  return null;
}

function parseSseEventBuffer(
  buffer: string,
  onChunk: (event: string, data: unknown) => void,
): string {
  const blocks = buffer.split('\n\n');
  const remainder = blocks.pop() || '';
  for (const block of blocks) {
    const lines = block.split('\n');
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length === 0) continue;
    const rawData = dataLines.join('\n');
    try {
      onChunk(eventName, JSON.parse(rawData));
    } catch {
      onChunk(eventName, rawData);
    }
  }
  return remainder;
}

async function streamHelperDeployAndUpdateTask(input: {
  taskId: string;
  config: CloudflareUpdateCenterConfig;
  helperToken: string;
  source: CloudflareUpdateCenterVersionSource;
  targetTag: string;
  targetDigest: string | null;
}) {
  const response = await fetch(`${ensureUrlWithoutTrailingSlash(input.config.helperBaseUrl)}/deploy`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.helperToken}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      namespace: input.config.namespace,
      releaseName: input.config.releaseName,
      chartRef: input.config.chartRef,
      imageRepository: input.config.imageRepository,
      source: input.source,
      targetTag: input.targetTag,
      targetDigest: input.targetDigest,
    }),
  });
  if (!response.ok) {
    throw new Error(`helper deploy failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('helper deploy response did not include a stream body');
  }
  let finalResult: unknown = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseEventBuffer(buffer, (event, data) => {
      if (event === 'log') {
        const message = String((safeJsonObject(data).message ?? '') || '').trim();
        if (message) appendCloudflareTaskLog(input.taskId, message);
        return;
      }
      if (event === 'result') {
        finalResult = data;
      }
    });
  }
  if (buffer.trim()) {
    parseSseEventBuffer(`${buffer}\n\n`, (event, data) => {
      if (event === 'log') {
        const message = String((safeJsonObject(data).message ?? '') || '').trim();
        if (message) appendCloudflareTaskLog(input.taskId, message);
        return;
      }
      if (event === 'result') {
        finalResult = data;
      }
    });
  }
  if (!finalResult) {
    throw new Error('helper deploy stream ended without a result event');
  }
  const resultRecord = safeJsonObject(finalResult);
  if (resultRecord.success !== true) {
    throw new Error('deploy helper reported a failed deployment');
  }
  updateCloudflareTask(input.taskId, {
    status: 'succeeded',
    message: '更新中心部署已完成',
    result: resultRecord,
    error: null,
  });
}

async function streamHelperRollbackAndUpdateTask(input: {
  taskId: string;
  config: CloudflareUpdateCenterConfig;
  helperToken: string;
  targetRevision: string;
}) {
  const response = await fetch(`${ensureUrlWithoutTrailingSlash(input.config.helperBaseUrl)}/rollback`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.helperToken}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      namespace: input.config.namespace,
      releaseName: input.config.releaseName,
      targetRevision: input.targetRevision,
    }),
  });
  if (!response.ok) {
    throw new Error(`helper rollback failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('helper rollback response did not include a stream body');
  }
  let finalResult: unknown = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseEventBuffer(buffer, (event, data) => {
      if (event === 'log') {
        const message = String((safeJsonObject(data).message ?? '') || '').trim();
        if (message) appendCloudflareTaskLog(input.taskId, message);
        return;
      }
      if (event === 'result') {
        finalResult = data;
      }
    });
  }
  if (buffer.trim()) {
    parseSseEventBuffer(`${buffer}\n\n`, (event, data) => {
      if (event === 'log') {
        const message = String((safeJsonObject(data).message ?? '') || '').trim();
        if (message) appendCloudflareTaskLog(input.taskId, message);
        return;
      }
      if (event === 'result') {
        finalResult = data;
      }
    });
  }
  if (!finalResult) {
    throw new Error('helper rollback stream ended without a result event');
  }
  const resultRecord = safeJsonObject(finalResult);
  if (resultRecord.success !== true) {
    throw new Error('deploy helper reported a failed rollback');
  }
  updateCloudflareTask(input.taskId, {
    status: 'succeeded',
    message: '更新中心回退已完成',
    result: resultRecord,
    error: null,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderOauthCallbackPage(message: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>OAuth Callback</title>
  </head>
  <body>
    <script>window.close();</script>
    ${escapeHtml(message)}
  </body>
</html>`;
}

function buildRouteDecisionFromChannels(
  requestedModel: string,
  channels: any[],
): {
  requestedModel: string;
  actualModel: string;
  matched: boolean;
  selectedChannelId?: number;
  selectedLabel?: string;
  summary: string[];
  candidates: Array<{
    channelId: number;
    accountId: number;
    username: string;
    siteName: string;
    tokenName: string;
    priority: number;
    weight: number;
    eligible: boolean;
    recentlyFailed: boolean;
    avoidedByRecentFailure: boolean;
    probability: number;
    reason: string;
  }>;
} {
  const enabledChannels = channels.filter((channel) => !!channel?.enabled);
  const totalWeight = enabledChannels.reduce((sum, channel) => {
    const weight = Math.max(0, Math.trunc(toFiniteNumber(channel?.weight ?? 0)));
    return sum + (weight > 0 ? weight : 1);
  }, 0);
  const candidates = enabledChannels.map((channel) => {
    const baseWeight = Math.max(1, Math.trunc(toFiniteNumber(channel?.weight ?? 0)));
    const probability = totalWeight > 0 ? (baseWeight / totalWeight) * 100 : 0;
    return {
      channelId: Math.trunc(toFiniteNumber(channel?.id)),
      accountId: Math.trunc(toFiniteNumber(channel?.accountId)),
      username: String(channel?.account?.username || `account-${channel?.accountId || 'unknown'}`),
      siteName: String(channel?.site?.name || 'unknown-site'),
      tokenName: String(channel?.token?.name || channel?.account?.username || `token-${channel?.tokenId || 'default'}`),
      priority: Math.trunc(toFiniteNumber(channel?.priority)),
      weight: baseWeight,
      eligible: true,
      recentlyFailed: false,
      avoidedByRecentFailure: false,
      probability: Math.round(probability * 100) / 100,
      reason: '',
    };
  });
  const selected = [...candidates].sort((left, right) => right.probability - left.probability)[0];
  return {
    requestedModel: requestedModel || '',
    actualModel: requestedModel || '',
    matched: candidates.length > 0,
    selectedChannelId: selected?.channelId,
    selectedLabel: selected ? `${selected.username} @ ${selected.siteName}` : undefined,
    summary: candidates.length > 0
      ? [`候选通道 ${candidates.length} 个`, `已按权重计算概率`]
      : ['当前路由无可用通道'],
    candidates,
  };
}

type CloudflareRebuildRouteCandidate = {
  accountId: number;
  tokenId: number | null;
  oauthRouteUnitId: number | null;
};

function buildCloudflareRebuildCandidateKey(candidate: CloudflareRebuildRouteCandidate): string {
  if (candidate.oauthRouteUnitId) {
    return `route-unit:${candidate.oauthRouteUnitId}`;
  }
  return `${candidate.accountId}:${candidate.tokenId ?? 'account'}`;
}

function buildCloudflareRebuildChannelKey(channel: typeof schema.routeChannels.$inferSelect): string {
  if (channel.oauthRouteUnitId) {
    return `route-unit:${channel.oauthRouteUnitId}`;
  }
  return `${channel.accountId}:${channel.tokenId ?? 'account'}`;
}

function normalizeCloudflareBrandKey(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const CLOUDFLARE_KNOWN_BRAND_BY_KEY = new Map(
  getAllBrandNames().map((brand) => [normalizeCloudflareBrandKey(brand), brand] as const),
);

function getCloudflareBlockedBrandRules(input: unknown): string[] {
  const blockedBrands = parseStringArray(input);
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const raw of blockedBrands) {
    const canonical = CLOUDFLARE_KNOWN_BRAND_BY_KEY.get(normalizeCloudflareBrandKey(raw));
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    rules.push(canonical);
  }
  return rules;
}

function isCloudflareModelBlockedByBrand(modelName: string, rules: string[]): boolean {
  if (!modelName || rules.length === 0) return false;
  const matchedBrands = new Set(getMatchingBrandNames(modelName));
  return rules.some((rule) => matchedBrands.has(rule));
}

function isCloudflareUsableAccountToken(token: typeof schema.accountTokens.$inferSelect | null | undefined): boolean {
  if (!token) return false;
  if (token.enabled !== true) return false;
  const valueStatus = String(token.valueStatus || '').trim().toLowerCase();
  if (valueStatus === 'masked_pending') return false;
  const tokenValue = String(token.token || '').trim();
  if (!tokenValue || isMaskedSecretValue(tokenValue)) return false;
  return true;
}

function buildCloudflarePreferredTokenByAccount(
  tokens: Array<typeof schema.accountTokens.$inferSelect>,
): Map<number, typeof schema.accountTokens.$inferSelect> {
  const grouped = new Map<number, Array<typeof schema.accountTokens.$inferSelect>>();
  for (const token of tokens) {
    if (!isCloudflareUsableAccountToken(token)) continue;
    const accountId = Math.trunc(Number(token.accountId));
    if (!Number.isFinite(accountId) || accountId <= 0) continue;
    const bucket = grouped.get(accountId) || [];
    bucket.push(token);
    grouped.set(accountId, bucket);
  }

  const preferredByAccount = new Map<number, typeof schema.accountTokens.$inferSelect>();
  for (const [accountId, bucket] of grouped.entries()) {
    const preferred = bucket.find((token) => token.isDefault) || bucket[0];
    if (preferred) preferredByAccount.set(accountId, preferred);
  }
  return preferredByAccount;
}

async function loadCloudflareEnabledOauthRouteUnitRepresentativeByAccount(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<Map<number, { routeUnitId: number; representativeAccountId: number }>> {
  const rows = await db
    .select({
      memberId: schema.oauthRouteUnitMembers.id,
      routeUnitId: schema.oauthRouteUnitMembers.unitId,
      accountId: schema.oauthRouteUnitMembers.accountId,
      sortOrder: schema.oauthRouteUnitMembers.sortOrder,
    })
    .from(schema.oauthRouteUnitMembers)
    .innerJoin(schema.oauthRouteUnits, eq(schema.oauthRouteUnitMembers.unitId, schema.oauthRouteUnits.id))
    .where(eq(schema.oauthRouteUnits.enabled, true))
    .all();

  const membersByUnitId = new Map<number, Array<{ memberId: number; accountId: number; sortOrder: number }>>();
  for (const row of rows) {
    const unitId = Math.trunc(Number(row.routeUnitId));
    const accountId = Math.trunc(Number(row.accountId));
    const memberId = Math.trunc(Number(row.memberId));
    if (!Number.isFinite(unitId) || unitId <= 0 || !Number.isFinite(accountId) || accountId <= 0) continue;
    const bucket = membersByUnitId.get(unitId) || [];
    bucket.push({
      memberId: Number.isFinite(memberId) ? memberId : 0,
      accountId,
      sortOrder: Math.trunc(Number(row.sortOrder || 0)),
    });
    membersByUnitId.set(unitId, bucket);
  }

  const routeUnitByAccountId = new Map<number, { routeUnitId: number; representativeAccountId: number }>();
  for (const [routeUnitId, members] of membersByUnitId.entries()) {
    members.sort((left, right) => (left.sortOrder - right.sortOrder) || (left.memberId - right.memberId));
    const representativeAccountId = members[0]?.accountId;
    if (!representativeAccountId) continue;
    for (const member of members) {
      routeUnitByAccountId.set(member.accountId, { routeUnitId, representativeAccountId });
    }
  }
  return routeUnitByAccountId;
}

async function rebuildCloudflareTokenRoutesFromAvailability(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<{
  models: number;
  createdRoutes: number;
  createdChannels: number;
  removedChannels: number;
  removedRoutes: number;
}> {
  const runtimeSettings = normalizeRuntimeSettingsObject(await readSetting(db, 'cloudflare_runtime_settings'));
  const blockedBrandRules = getCloudflareBlockedBrandRules(runtimeSettings.globalBlockedBrands);
  const globalAllowedModels = new Set(
    parseStringArray(runtimeSettings.globalAllowedModels)
      .map((value) => value.toLowerCase().trim())
      .filter(Boolean),
  );

  const [
    tokenRows,
    accountRows,
    disabledModelRows,
    routes,
    channels,
    tokenPool,
    routeUnitByAccountId,
  ] = await Promise.all([
    db.select().from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, 'ready'),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ))
      .all(),
    db.select().from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(
        eq(schema.modelAvailability.available, true),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ))
      .all(),
    db.select().from(schema.siteDisabledModels).all(),
    db.select().from(schema.tokenRoutes).all(),
    db.select().from(schema.routeChannels).all(),
    db.select().from(schema.accountTokens).all(),
    loadCloudflareEnabledOauthRouteUnitRepresentativeByAccount(db),
  ]);

  const disabledModelsBySite = new Map<number, Set<string>>();
  for (const row of disabledModelRows) {
    const siteId = Math.trunc(Number(row.siteId));
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    const modelName = String(row.modelName || '').trim().toLowerCase();
    if (!modelName) continue;
    if (!disabledModelsBySite.has(siteId)) disabledModelsBySite.set(siteId, new Set());
    disabledModelsBySite.get(siteId)!.add(modelName);
  }

  const preferredTokenByAccount = buildCloudflarePreferredTokenByAccount(tokenPool);

  const modelCandidates = new Map<string, Map<string, CloudflareRebuildRouteCandidate>>();
  const isModelAllowedByWhitelist = (modelName: string): boolean => {
    if (globalAllowedModels.size === 0) return true;
    return globalAllowedModels.has(modelName.toLowerCase().trim());
  };
  const isModelDisabledForSite = (siteId: number, modelName: string): boolean => {
    const disabledModels = disabledModelsBySite.get(siteId);
    return !!disabledModels && disabledModels.has(modelName.toLowerCase());
  };
  const addModelCandidate = (
    modelNameRaw: unknown,
    accountId: number,
    tokenId: number | null,
    siteId: number,
    oauthRouteUnitId: number | null = null,
  ) => {
    const modelName = String(modelNameRaw || '').trim();
    if (!modelName) return;
    if (!isModelAllowedByWhitelist(modelName)) return;
    if (isModelDisabledForSite(siteId, modelName)) return;
    if (blockedBrandRules.length > 0 && isCloudflareModelBlockedByBrand(modelName, blockedBrandRules)) return;
    const candidate: CloudflareRebuildRouteCandidate = { accountId, tokenId, oauthRouteUnitId };
    if (!modelCandidates.has(modelName)) modelCandidates.set(modelName, new Map());
    modelCandidates.get(modelName)!.set(buildCloudflareRebuildCandidateKey(candidate), candidate);
  };

  for (const row of tokenRows) {
    const account = row.accounts;
    const token = row.account_tokens;
    if (!requiresManagedAccountTokens(account)) continue;
    if (!isCloudflareUsableAccountToken(token)) continue;
    addModelCandidate(
      row.token_model_availability.modelName,
      account.id,
      token.id,
      account.siteId,
      null,
    );
  }

  for (const row of accountRows) {
    const account = row.accounts;
    if (!supportsDirectAccountRoutingConnection(account)) continue;
    const routeUnit = routeUnitByAccountId.get(account.id);
    if (routeUnit) {
      addModelCandidate(
        row.model_availability.modelName,
        routeUnit.representativeAccountId,
        null,
        account.siteId,
        routeUnit.routeUnitId,
      );
      continue;
    }
    addModelCandidate(
      row.model_availability.modelName,
      account.id,
      null,
      account.siteId,
      null,
    );
  }

  let createdRoutes = 0;
  let createdChannels = 0;
  let removedChannels = 0;
  let removedRoutes = 0;

  for (const [modelName, candidateMap] of modelCandidates.entries()) {
    let route = routes.find((item) => normalizeRouteModeValue(item.routeMode) !== 'explicit_group' && item.modelPattern === modelName);
    if (!route) {
      const inserted = await db.insert(schema.tokenRoutes).values({
        modelPattern: modelName,
        routeMode: 'pattern',
        routingStrategy: 'weighted',
        enabled: true,
        modelMapping: null,
        decisionSnapshot: null,
        decisionRefreshedAt: null,
        createdAt: formatUtcSqlDateTime(),
        updatedAt: formatUtcSqlDateTime(),
      }).returning().get();
      if (!inserted) continue;
      route = inserted;
      routes.push(inserted);
      createdRoutes += 1;
    }

    const routeChannels = channels.filter((channel) => channel.routeId === route.id);
    const desiredKeys = new Set(candidateMap.keys());

    for (const [candidateKey, candidate] of candidateMap.entries()) {
      const exists = routeChannels.some((channel) => buildCloudflareRebuildChannelKey(channel) === candidateKey);
      if (exists) continue;
      const inserted = await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: candidate.accountId,
        tokenId: candidate.tokenId,
        oauthRouteUnitId: candidate.oauthRouteUnitId,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      }).returning().get();
      if (!inserted) continue;
      channels.push(inserted);
      createdChannels += 1;
      desiredKeys.add(candidateKey);
    }

    for (const channel of routeChannels) {
      const channelKey = buildCloudflareRebuildChannelKey(channel);
      if (desiredKeys.has(channelKey)) continue;

      if (!channel.tokenId && !channel.oauthRouteUnitId) {
        const preferredToken = preferredTokenByAccount.get(channel.accountId);
        if (preferredToken && desiredKeys.has(`${channel.accountId}:${preferredToken.id}`)) {
          await db.update(schema.routeChannels)
            .set({
              tokenId: preferredToken.id,
            })
            .where(eq(schema.routeChannels.id, channel.id))
            .run();
          continue;
        }
      }

      if (!channel.manualOverride) {
        await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
        removedChannels += 1;
      }
    }
  }

  const latestModelNames = new Set(Array.from(modelCandidates.keys()));
  for (const route of routes) {
    if (normalizeRouteModeValue(route.routeMode) === 'explicit_group') continue;
    const modelPattern = String(route.modelPattern || '').trim();
    if (!modelPattern || !isExactModelPattern(modelPattern) || latestModelNames.has(modelPattern)) continue;

    const routeChannelCount = channels.filter((channel) => channel.routeId === route.id).length;
    if (routeChannelCount > 0) {
      removedChannels += routeChannelCount;
    }

    const deleted = await db.delete(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, route.id))
      .returning({ id: schema.tokenRoutes.id })
      .get();
    if (deleted?.id) {
      removedRoutes += 1;
    }
  }

  if (createdRoutes > 0 || createdChannels > 0 || removedChannels > 0 || removedRoutes > 0) {
    await db.update(schema.tokenRoutes).set({
      decisionSnapshot: null,
      decisionRefreshedAt: null,
    }).run();
  }

  return {
    models: modelCandidates.size,
    createdRoutes,
    createdChannels,
    removedChannels,
    removedRoutes,
  };
}

type CloudflareModelRefreshResult = {
  accountId: number;
  siteId: number;
  status: AccountProbeRefresh['status'];
  errorCode: string | null;
  errorMessage: string | null;
  modelCount: number;
  modelsPreview: string[];
  endpointUrl: string | null;
  latencyMs: number | null;
};

async function refreshCloudflareModelsForAllActiveAccounts(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<CloudflareModelRefreshResult[]> {
  const rows = await db.select({
    account: schema.accounts,
    site: schema.sites,
  }).from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
    ))
    .all();

  const results: CloudflareModelRefreshResult[] = [];
  for (const row of rows) {
    const refresh = await runAccountModelProbe(db, row.account, row.site);
    results.push({
      accountId: row.account.id,
      siteId: row.site.id,
      status: refresh.status,
      errorCode: refresh.errorCode,
      errorMessage: refresh.errorMessage,
      modelCount: refresh.modelCount,
      modelsPreview: refresh.modelsPreview,
      endpointUrl: refresh.endpointUrl,
      latencyMs: refresh.latencyMs,
    });
  }
  return results;
}

async function refreshCloudflareModelsAndRebuildRoutes(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<{
  refresh: CloudflareModelRefreshResult[];
  rebuild: {
    models: number;
    createdRoutes: number;
    createdChannels: number;
    removedChannels: number;
    removedRoutes: number;
  };
}> {
  const refresh = await refreshCloudflareModelsForAllActiveAccounts(db);
  const rebuild = await rebuildCloudflareTokenRoutesFromAvailability(db);
  return { refresh, rebuild };
}

type CloudflareSiteAnnouncementLevel = 'info' | 'warning' | 'error';
type CloudflareSiteAnnouncementItem = {
  sourceKey: string;
  title: string;
  content: string;
  level: CloudflareSiteAnnouncementLevel;
  sourceUrl?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  upstreamCreatedAt?: string | null;
  upstreamUpdatedAt?: string | null;
  rawPayload?: unknown;
};

type CloudflareSiteAnnouncementSyncResult = {
  scannedSites: number;
  inserted: number;
  updated: number;
  unsupported: number;
  notifications: number;
  events: number;
  failed: number;
  failedSites: Array<{ siteId: number; siteName: string; message: string }>;
};

function toCloudflareAnnouncementLevel(input: unknown): CloudflareSiteAnnouncementLevel {
  const normalized = String(input || '').trim().toLowerCase();
  if (normalized === 'error') return 'error';
  if (normalized === 'warning' || normalized === 'warn') return 'warning';
  return 'info';
}

function buildCloudflareNoticeSourceKey(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) - hash + content.charCodeAt(index)) | 0;
  }
  const normalized = (hash >>> 0).toString(16).padStart(8, '0');
  return `notice:${normalized}`;
}

function buildCloudflareAnnouncementMessage(item: CloudflareSiteAnnouncementItem): string {
  const title = String(item.title || '').trim();
  const content = String(item.content || '').trim();
  if (title && content && title !== content && title.toLowerCase() !== 'site notice') {
    return `${title}\n${content}`;
  }
  return content || title;
}

function parseCloudflareAnnouncementListPayload(payload: unknown): CloudflareSiteAnnouncementItem[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const root = payload as Record<string, unknown>;
  if (root.success === false) return [];

  const candidateRows = (() => {
    if (Array.isArray(root.data)) return root.data;
    if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
      const data = root.data as Record<string, unknown>;
      if (Array.isArray(data.items)) return data.items;
    }
    if (Array.isArray(root.items)) return root.items;
    return [];
  })();

  const rows: CloudflareSiteAnnouncementItem[] = [];
  for (const candidate of candidateRows) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const id = Math.trunc(Number(item.id));
    if (!Number.isFinite(id) || id <= 0) continue;
    const title = String(item.title || '').trim();
    const content = String(item.content || '').trim();
    if (!title && !content) continue;
    rows.push({
      sourceKey: `announcement:${id}`,
      title: title || `Announcement ${id}`,
      content: content || title || `Announcement ${id}`,
      level: toCloudflareAnnouncementLevel(item.level),
      sourceUrl: typeof item.sourceUrl === 'string'
        ? item.sourceUrl
        : (typeof item.url === 'string' ? item.url : null),
      startsAt: typeof item.starts_at === 'string'
        ? item.starts_at
        : (typeof item.startsAt === 'string' ? item.startsAt : null),
      endsAt: typeof item.ends_at === 'string'
        ? item.ends_at
        : (typeof item.endsAt === 'string' ? item.endsAt : null),
      upstreamCreatedAt: typeof item.created_at === 'string'
        ? item.created_at
        : (typeof item.createdAt === 'string' ? item.createdAt : null),
      upstreamUpdatedAt: typeof item.updated_at === 'string'
        ? item.updated_at
        : (typeof item.updatedAt === 'string' ? item.updatedAt : null),
      rawPayload: item,
    });
  }
  return rows;
}

function parseCloudflareNoticePayload(payload: unknown): CloudflareSiteAnnouncementItem[] {
  if (typeof payload === 'string') {
    const content = payload.trim();
    if (!content) return [];
    return [{
      sourceKey: buildCloudflareNoticeSourceKey(content),
      title: 'Site notice',
      content,
      level: 'info',
      sourceUrl: '/api/notice',
      rawPayload: payload,
    }];
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const root = payload as Record<string, unknown>;
  if (root.success === false) return [];
  const content = typeof root.data === 'string'
    ? root.data.trim()
    : (typeof root.notice === 'string'
      ? root.notice.trim()
      : (typeof root.message === 'string' ? root.message.trim() : ''));
  if (!content) return [];
  return [{
    sourceKey: buildCloudflareNoticeSourceKey(content),
    title: 'Site notice',
    content,
    level: 'info',
    sourceUrl: '/api/notice',
    rawPayload: payload,
  }];
}

function resolveSiteAnnouncementPaths(platform: string): string[] {
  const normalized = platform.trim().toLowerCase();
  if (normalized === 'sub2api') {
    return ['/api/v1/announcements?page=1&page_size=100'];
  }
  return ['/api/notice', '/api/v1/announcements?page=1&page_size=100'];
}

async function listCloudflareTargetAnnouncementSites(
  db: ReturnType<typeof getCloudflareDb>,
  siteId: number | null,
) {
  if (siteId && Number.isFinite(siteId) && siteId > 0) {
    return await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).all();
  }
  return await db.select().from(schema.sites).where(eq(schema.sites.status, 'active')).all();
}

async function loadCloudflareAnnouncementHeaderAttempts(
  db: ReturnType<typeof getCloudflareDb>,
  site: typeof schema.sites.$inferSelect,
): Promise<Array<Record<string, string>>> {
  const attempts: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  const pushHeaders = (headers: Record<string, string>) => {
    const key = JSON.stringify(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)));
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(headers);
  };

  const accounts = await db.select().from(schema.accounts)
    .where(and(
      eq(schema.accounts.siteId, site.id),
      eq(schema.accounts.status, 'active'),
    ))
    .all();

  for (const account of accounts) {
    const token = resolveProbeToken(account, site);
    if (!token) continue;
    const platformUserId = resolveProbePlatformUserId(account);
    const platformUserIdCandidates = buildProbeUserIdCandidates(account);
    pushHeaders(buildProbeHeaders(site, token, platformUserId));
    pushHeaders(buildProbeHeaders(site, token, null));
    for (const candidate of platformUserIdCandidates) {
      pushHeaders(buildProbeHeaders(site, token, candidate));
    }
    for (const cookie of buildSessionCookieCandidates(token)) {
      pushHeaders({
        Accept: 'application/json',
        Cookie: cookie,
      });
      if (platformUserId) {
        pushHeaders({
          Accept: 'application/json',
          Cookie: cookie,
          'New-Api-User': platformUserId,
          'User-ID': platformUserId,
          'User-id': platformUserId,
        });
      }
      for (const candidate of platformUserIdCandidates) {
        pushHeaders({
          Accept: 'application/json',
          Cookie: cookie,
          'New-Api-User': candidate,
          'User-ID': candidate,
          'User-id': candidate,
        });
      }
    }
  }

  const fallbackToken = String(site.apiKey || '').trim();
  if (fallbackToken) {
    pushHeaders(buildProbeHeaders(site, fallbackToken, null));
    for (const cookie of buildSessionCookieCandidates(fallbackToken)) {
      pushHeaders({
        Accept: 'application/json',
        Cookie: cookie,
      });
    }
  }

  return attempts;
}

async function fetchCloudflareSiteAnnouncementsForSite(
  db: ReturnType<typeof getCloudflareDb>,
  site: typeof schema.sites.$inferSelect,
): Promise<
  | { status: 'success'; announcements: CloudflareSiteAnnouncementItem[] }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string }
> {
  if (site.status !== 'active') return { status: 'unsupported' };
  const endpoints = await resolveSiteProbeEndpoints(db, site);
  if (endpoints.length === 0) {
    return { status: 'failed', message: '未配置可用站点地址' };
  }

  const headerAttempts = await loadCloudflareAnnouncementHeaderAttempts(db, site);
  if (headerAttempts.length === 0) {
    return { status: 'failed', message: '缺少可用凭证' };
  }

  const paths = resolveSiteAnnouncementPaths(String(site.platform || ''));
  let lastFailureMessage = '公告同步失败';
  let hasNonUnsupportedFailure = false;

  for (const endpoint of endpoints) {
    for (const headers of headerAttempts) {
      for (const path of paths) {
        const url = `${endpoint}${path}`;
        const response = await fetch(url, {
          method: 'GET',
          headers,
        }).catch(() => null);
        if (!response) {
          hasNonUnsupportedFailure = true;
          lastFailureMessage = '公告抓取请求失败';
          continue;
        }

        const rawText = await response.text().catch(() => '');
        const payload = parseJsonSafe(rawText) ?? rawText;
        if (response.ok) {
          const announcements = path.startsWith('/api/notice')
            ? parseCloudflareNoticePayload(payload)
            : parseCloudflareAnnouncementListPayload(payload);
          return { status: 'success', announcements };
        }

        const message = extractMessageFromPayload(payload) || rawText.trim() || `HTTP ${response.status}`;
        if (response.status !== 404 && response.status !== 405) {
          hasNonUnsupportedFailure = true;
          lastFailureMessage = message;
        }
      }
    }
  }

  if (hasNonUnsupportedFailure) {
    return {
      status: 'failed',
      message: lastFailureMessage,
    };
  }
  return { status: 'unsupported' };
}

async function syncCloudflareSiteAnnouncements(
  db: ReturnType<typeof getCloudflareDb>,
  options?: { siteId?: number | null },
): Promise<CloudflareSiteAnnouncementSyncResult> {
  const result: CloudflareSiteAnnouncementSyncResult = {
    scannedSites: 0,
    inserted: 0,
    updated: 0,
    unsupported: 0,
    notifications: 0,
    events: 0,
    failed: 0,
    failedSites: [],
  };

  const sites = await listCloudflareTargetAnnouncementSites(db, options?.siteId ?? null);
  for (const site of sites) {
    result.scannedSites += 1;
    const fetched = await fetchCloudflareSiteAnnouncementsForSite(db, site);
    if (fetched.status === 'unsupported') {
      result.unsupported += 1;
      continue;
    }
    if (fetched.status === 'failed') {
      result.failed += 1;
      result.failedSites.push({
        siteId: site.id,
        siteName: site.name,
        message: fetched.message,
      });
      continue;
    }

    const seenAt = formatUtcSqlDateTime();
    for (const announcement of fetched.announcements) {
      const existing = await db.select()
        .from(schema.siteAnnouncements)
        .where(and(
          eq(schema.siteAnnouncements.siteId, site.id),
          eq(schema.siteAnnouncements.sourceKey, announcement.sourceKey),
        ))
        .get();

      const patch = {
        platform: String(site.platform || '').trim(),
        title: announcement.title,
        content: announcement.content,
        level: announcement.level,
        sourceUrl: announcement.sourceUrl ?? null,
        startsAt: announcement.startsAt ?? null,
        endsAt: announcement.endsAt ?? null,
        upstreamCreatedAt: announcement.upstreamCreatedAt ?? null,
        upstreamUpdatedAt: announcement.upstreamUpdatedAt ?? null,
        lastSeenAt: seenAt,
        rawPayload: announcement.rawPayload == null ? null : JSON.stringify(announcement.rawPayload),
      };

      if (existing) {
        await db.update(schema.siteAnnouncements)
          .set(patch)
          .where(eq(schema.siteAnnouncements.id, existing.id))
          .run();
        result.updated += 1;
        continue;
      }

      await db.insert(schema.siteAnnouncements).values({
        siteId: site.id,
        sourceKey: announcement.sourceKey,
        firstSeenAt: seenAt,
        ...patch,
      }).run();
      result.inserted += 1;

      const inserted = await db.select()
        .from(schema.siteAnnouncements)
        .where(and(
          eq(schema.siteAnnouncements.siteId, site.id),
          eq(schema.siteAnnouncements.sourceKey, announcement.sourceKey),
        ))
        .get();
      const announcementId = Math.trunc(Number(inserted?.id));
      if (Number.isFinite(announcementId) && announcementId > 0) {
        await db.insert(schema.events).values({
          type: 'site_notice',
          title: `站点公告：${site.name}`,
          message: buildCloudflareAnnouncementMessage(announcement),
          level: announcement.level,
          relatedId: announcementId,
          relatedType: 'site_announcement',
          createdAt: seenAt,
        }).run();
        result.events += 1;
      }
    }
  }

  return result;
}

type CloudflareFactoryResetResult = {
  preservedSettings: string[];
  seededSites: number;
};

async function performCloudflareFactoryReset(input: {
  db: ReturnType<typeof getCloudflareDb>;
  envAuthToken?: string;
  envProxyToken?: string;
}): Promise<CloudflareFactoryResetResult> {
  const { db } = input;
  const preservedValues = new Map<string, unknown>();
  for (const key of CLOUDFLARE_FACTORY_RESET_PRESERVED_SETTING_KEYS) {
    const value = await readSetting(db, key);
    if (value === undefined) continue;
    preservedValues.set(key, value);
  }

  const envAuthToken = String(input.envAuthToken || '').trim();
  if (!preservedValues.has('auth_token')) {
    preservedValues.set('auth_token', envAuthToken || CLOUDFLARE_FACTORY_RESET_AUTH_FALLBACK);
  }
  const envProxyToken = String(input.envProxyToken || '').trim();
  if (!preservedValues.has('proxy_token') && envProxyToken) {
    preservedValues.set('proxy_token', envProxyToken);
  }

  await db.delete(schema.routeChannels).run();
  await db.delete(schema.oauthRouteUnitMembers).run();
  await db.delete(schema.routeGroupSources).run();
  await db.delete(schema.tokenModelAvailability).run();
  await db.delete(schema.modelAvailability).run();
  await db.delete(schema.proxyDebugAttempts).run();
  await db.delete(schema.proxyDebugTraces).run();
  await db.delete(schema.proxyLogs).run();
  await db.delete(schema.proxyVideoTasks).run();
  await db.delete(schema.proxyFiles).run();
  await db.delete(schema.checkinLogs).run();
  await db.delete(schema.accountTokens).run();
  await db.delete(schema.accounts).run();
  await db.delete(schema.oauthRouteUnits).run();
  await db.delete(schema.tokenRoutes).run();
  await db.delete(schema.siteApiEndpoints).run();
  await db.delete(schema.siteDisabledModels).run();
  await db.delete(schema.siteAnnouncements).run();
  await db.delete(schema.siteDayUsage).run();
  await db.delete(schema.siteHourUsage).run();
  await db.delete(schema.modelDayUsage).run();
  await db.delete(schema.downstreamApiKeys).run();
  await db.delete(schema.events).run();
  await db.delete(schema.adminSnapshots).run();
  await db.delete(schema.analyticsProjectionCheckpoints).run();
  await db.delete(schema.settings).run();
  await db.delete(schema.sites).run();

  for (const [key, value] of preservedValues.entries()) {
    await writeSetting(db, key, value);
  }

  await db.insert(schema.sites).values(CLOUDFLARE_FACTORY_RESET_DEFAULT_SITE_ROWS).run();
  await writeSetting(db, CLOUDFLARE_DEFAULT_SITE_SEED_SETTING_KEY, true);

  cloudflareTaskStore.clear();
  cloudflareOauthSessions.clear();

  return {
    preservedSettings: [...preservedValues.keys()],
    seededSites: CLOUDFLARE_FACTORY_RESET_DEFAULT_SITE_ROWS.length,
  };
}

async function executeCloudflareClearUsage(
  db: ReturnType<typeof getCloudflareDb>,
): Promise<{
  deletedProxyLogs: number;
  deletedSiteDayUsage: number;
  deletedSiteHourUsage: number;
  deletedModelDayUsage: number;
  resetRouteChannelStats: number;
  resetAccountBalanceUsage: number;
  message: string;
}> {
  const deletedProxyLogs = readD1Changes(await db.delete(schema.proxyLogs).run());
  const deletedSiteDayUsage = readD1Changes(await db.delete(schema.siteDayUsage).run());
  const deletedSiteHourUsage = readD1Changes(await db.delete(schema.siteHourUsage).run());
  const deletedModelDayUsage = readD1Changes(await db.delete(schema.modelDayUsage).run());
  const resetRouteChannelStats = readD1Changes(await db.update(schema.routeChannels).set({
    successCount: 0,
    failCount: 0,
    totalLatencyMs: 0,
    totalCost: 0,
    lastUsedAt: null,
    lastSelectedAt: null,
    lastFailAt: null,
    consecutiveFailCount: 0,
    cooldownLevel: 0,
    cooldownUntil: null,
  }).run());
  const resetAccountBalanceUsage = readD1Changes(await db.update(schema.accounts).set({
    balanceUsed: 0,
    updatedAt: formatUtcSqlDateTime(),
  }).run());
  const summaryMessage = `使用统计已清理：日志 ${deletedProxyLogs}，站点日统计 ${deletedSiteDayUsage}，站点小时统计 ${deletedSiteHourUsage}，模型日统计 ${deletedModelDayUsage}，重置通道统计 ${resetRouteChannelStats}，重置账号占用 ${resetAccountBalanceUsage}`;
  await appendCloudflareEventBestEffort(db, {
    type: 'status',
    level: 'warning',
    title: '使用统计已清理',
    message: summaryMessage,
  });

  return {
    deletedProxyLogs,
    deletedSiteDayUsage,
    deletedSiteHourUsage,
    deletedModelDayUsage,
    resetRouteChannelStats,
    resetAccountBalanceUsage,
    message: summaryMessage,
  };
}

export function registerCoreApiRoutes(app: Hono<CloudflareHonoEnv>) {
  app.get('/api/oauth/callback/:provider', async (c) => {
    const provider = normalizeOAuthProvider(c.req.param('provider'));
    const state = String(c.req.query('state') || '').trim();
    const code = String(c.req.query('code') || '').trim();
    const error = String(c.req.query('error') || '').trim();

    let message = 'OAuth callback received.';
    try {
      if (state && (code || error)) {
        await completeCloudflareOauthCallback({
          db: getCloudflareDb(c),
          env: c.env,
          provider,
          state,
          ...(code ? { code } : {}),
          ...(error ? { error } : {}),
        });
        message = 'OAuth authorization succeeded. You can close this window.';
      } else if (error) {
        message = 'OAuth authorization failed. Return to metapi and continue manual callback.';
      } else if (code) {
        message = 'OAuth callback received. Return to metapi to continue.';
      }
    } catch (callbackError) {
      const messageText = callbackError instanceof Error ? callbackError.message : String(callbackError || '');
      if (messageText) {
        message = `OAuth authorization failed: ${messageText}`;
      } else {
        message = 'OAuth authorization failed. Return to metapi and continue manual callback.';
      }
    }

    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(renderOauthCallbackPage(message), 200);
  });

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

  app.get('/api/sites', async (c) => {
    const db = getCloudflareDb(c);
    const siteRows = await db.select().from(schema.sites).all();
    const accountRows = await db
      .select({
        siteId: schema.accounts.siteId,
        balance: schema.accounts.balance,
      })
      .from(schema.accounts)
      .all();

    const totalBalanceBySiteId: Record<number, number> = {};
    for (const account of accountRows) {
      totalBalanceBySiteId[account.siteId] = toRoundedMicro(
        (totalBalanceBySiteId[account.siteId] || 0) + toFiniteNumber(account.balance),
      );
    }

    return c.json(
      siteRows.map((site) => ({
        ...site,
        totalBalance: totalBalanceBySiteId[site.id] || 0,
      })),
    );
  });

  app.get('/api/accounts', async (c) => {
    const db = getCloudflareDb(c);
    const accountRows = await db
      .select()
      .from(schema.accounts)
      .all();
    const siteRows = await db
      .select()
      .from(schema.sites)
      .all();
    const siteById = new Map(siteRows.map((site) => [site.id, site]));
    const generatedAt = new Date().toISOString();
    const accounts = accountRows.map((account) => {
      const site = siteById.get(account.siteId) || null;
      const displayName = resolveCloudflareAccountDisplayName(account);
      return {
        ...account,
        username: String(account.username || '').trim() || displayName || null,
        credentialMode: resolveStoredCredentialMode(account),
        capabilities: buildCapabilitiesFromCredentialMode(resolveStoredCredentialMode(account)),
        runtimeHealth: buildAccountRuntimeHealthView({
          accountStatus: account.status,
          siteStatus: site?.status,
          extraConfig: account.extraConfig,
        }),
        site,
      };
    });
    return c.json({
      generatedAt,
      accounts,
      sites: siteRows,
    });
  });

  app.get('/api/account-tokens', async (c) => {
    const db = getCloudflareDb(c);
    const accountIdRaw = c.req.query('accountId');
    const accountId = accountIdRaw ? Math.trunc(Number(accountIdRaw)) : 0;
    const tokens = await db.select().from(schema.accountTokens).all();
    const accountRows = await db.select().from(schema.accounts).all();
    const siteRows = await db.select().from(schema.sites).all();
    const accountById = new Map(accountRows.map((account) => [account.id, account]));
    const siteById = new Map(siteRows.map((site) => [site.id, site]));
    const scopedTokens = accountId > 0
      ? tokens.filter((token) => token.accountId === accountId)
      : tokens;
    return c.json(scopedTokens.map((token) => {
      const account = accountById.get(token.accountId) || null;
      const site = account ? siteById.get(account.siteId) || null : null;
      return {
        ...token,
        account,
        site,
      };
    }));
  });

  app.get('/api/routes/lite', async (c) => {
    const db = getCloudflareDb(c);
    const routes = await loadRoutesWithSources(db);
    return c.json(routes.map((route) => ({
      id: route.id,
      modelPattern: route.modelPattern,
      displayName: route.displayName || null,
      displayIcon: route.displayIcon || null,
      routeMode: route.routeMode,
      sourceRouteIds: route.sourceRouteIds,
      routingStrategy: route.routingStrategy || 'weighted',
      enabled: !!route.enabled,
    })));
  });

  app.get('/api/routes/summary', async (c) => {
    const db = getCloudflareDb(c);
    const routes = await loadRoutesWithSources(db);
    if (routes.length === 0) return c.json([]);
    const baseRouteIds = routes
      .filter((route) => route.routeMode !== 'explicit_group')
      .map((route) => route.id);
    const baseRouteChannelsById = await loadRouteChannelsByBaseRouteId(db, baseRouteIds);
    const channelsByRouteId = buildRouteChannelsMap(routes, baseRouteChannelsById);
    return c.json(routes.map((route) => {
      const channels = channelsByRouteId.get(route.id) || [];
      const siteNames = [...new Set(
        channels
          .map((channel) => String(channel?.site?.name || '').trim())
          .filter(Boolean),
      )];
      const enabledChannelCount = channels.filter((channel) => !!channel.enabled).length;
      return {
        id: route.id,
        modelPattern: route.modelPattern,
        displayName: route.displayName || null,
        displayIcon: route.displayIcon || null,
        routeMode: route.routeMode,
        sourceRouteIds: route.sourceRouteIds,
        modelMapping: route.modelMapping || null,
        routingStrategy: route.routingStrategy || 'weighted',
        enabled: !!route.enabled,
        channelCount: channels.length,
        enabledChannelCount,
        siteNames,
        decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
        decisionRefreshedAt: route.decisionRefreshedAt || null,
      };
    }));
  });

  app.get('/api/routes', async (c) => {
    const db = getCloudflareDb(c);
    const routes = await loadRoutesWithSources(db);
    if (routes.length === 0) return c.json([]);
    const baseRouteIds = routes
      .filter((route) => route.routeMode !== 'explicit_group')
      .map((route) => route.id);
    const baseRouteChannelsById = await loadRouteChannelsByBaseRouteId(db, baseRouteIds);
    const channelsByRouteId = buildRouteChannelsMap(routes, baseRouteChannelsById);
    return c.json(routes.map((route) => ({
      ...route,
      modelMapping: route.modelMapping || null,
      decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
      decisionRefreshedAt: route.decisionRefreshedAt || null,
      channels: channelsByRouteId.get(route.id) || [],
    })));
  });

  app.get('/api/routes/:id/channels', async (c) => {
    const db = getCloudflareDb(c);
    const routeId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(routeId) || routeId <= 0) {
      return c.json({ success: false, message: '路由不存在' }, 404);
    }
    const routes = await loadRoutesWithSources(db);
    const route = routes.find((item) => item.id === routeId);
    if (!route) {
      return c.json({ success: false, message: '路由不存在' }, 404);
    }
    const baseRouteIds = route.routeMode === 'explicit_group'
      ? route.sourceRouteIds
      : [route.id];
    const baseRouteChannelsById = await loadRouteChannelsByBaseRouteId(db, baseRouteIds);
    const channelsByRouteId = buildRouteChannelsMap([route], baseRouteChannelsById);
    return c.json(channelsByRouteId.get(routeId) || []);
  });

  app.post('/api/routes', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const routeMode = normalizeRouteModeValue(body.routeMode);
    const modelPattern = String(body.modelPattern || '').trim();
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const displayIcon = typeof body.displayIcon === 'string' ? body.displayIcon.trim() : '';
    const sourceRouteIds = parseNumberArray(body.sourceRouteIds);

    if (routeMode === 'pattern' && !modelPattern) {
      return c.json({ success: false, message: 'modelPattern 不能为空' }, 400);
    }
    if (routeMode === 'explicit_group') {
      if (!displayName) return c.json({ success: false, message: 'displayName 不能为空' }, 400);
      if (sourceRouteIds.length === 0) return c.json({ success: false, message: 'sourceRouteIds 不能为空' }, 400);
    }

    const inserted = await db
      .insert(schema.tokenRoutes)
      .values({
        modelPattern: routeMode === 'pattern' ? modelPattern : displayName,
        displayName: displayName || null,
        displayIcon: displayIcon || null,
        routeMode,
        modelMapping: null,
        decisionSnapshot: null,
        decisionRefreshedAt: null,
        routingStrategy: 'weighted',
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning({ id: schema.tokenRoutes.id })
      .get();

    const routeId = inserted?.id;
    if (routeMode === 'explicit_group' && routeId) {
      for (const sourceRouteId of sourceRouteIds) {
        await db.insert(schema.routeGroupSources).values({
          groupRouteId: routeId,
          sourceRouteId,
        }).run();
      }
    }

    const routes = await loadRoutesWithSources(db);
    const created = routes.find((item) => item.id === routeId) || null;
    return c.json(created);
  });

  app.put('/api/routes/:id', async (c) => {
    const db = getCloudflareDb(c);
    const routeId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(routeId) || routeId <= 0) {
      return c.json({ success: false, message: '路由不存在' }, 404);
    }
    const current = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
    if (!current) return c.json({ success: false, message: '路由不存在' }, 404);

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const hasRouteMode = Object.prototype.hasOwnProperty.call(body, 'routeMode');
    const hasModelPattern = Object.prototype.hasOwnProperty.call(body, 'modelPattern');
    const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'displayName');
    const hasDisplayIcon = Object.prototype.hasOwnProperty.call(body, 'displayIcon');
    const hasEnabled = Object.prototype.hasOwnProperty.call(body, 'enabled');
    const hasRoutingStrategy = Object.prototype.hasOwnProperty.call(body, 'routingStrategy');
    const hasSourceRouteIds = Object.prototype.hasOwnProperty.call(body, 'sourceRouteIds');

    const nextRouteMode = hasRouteMode
      ? normalizeRouteModeValue(body.routeMode)
      : normalizeRouteModeValue(current.routeMode);
    const nextModelPattern = hasModelPattern
      ? String(body.modelPattern || '').trim()
      : String(current.modelPattern || '').trim();
    const nextDisplayName = hasDisplayName
      ? (typeof body.displayName === 'string' ? body.displayName.trim() : '')
      : String(current.displayName || '').trim();
    const nextDisplayIcon = hasDisplayIcon
      ? (typeof body.displayIcon === 'string' ? body.displayIcon.trim() : '')
      : String(current.displayIcon || '').trim();
    const nextEnabled = hasEnabled ? !!body.enabled : !!current.enabled;
    const nextRoutingStrategy = hasRoutingStrategy
      ? String(body.routingStrategy || '').trim() || 'weighted'
      : String(current.routingStrategy || '').trim() || 'weighted';
    const nextSourceRouteIds = hasSourceRouteIds
      ? parseNumberArray(body.sourceRouteIds)
      : await loadRouteSourceIdsMap(db, [routeId]).then((map) => map.get(routeId) || []);

    if (nextRouteMode === 'pattern' && !nextModelPattern) {
      return c.json({ success: false, message: 'modelPattern 不能为空' }, 400);
    }
    if (nextRouteMode === 'explicit_group') {
      if (!nextDisplayName) return c.json({ success: false, message: 'displayName 不能为空' }, 400);
      if (nextSourceRouteIds.length === 0) return c.json({ success: false, message: 'sourceRouteIds 不能为空' }, 400);
    }

    await db.update(schema.tokenRoutes).set({
      routeMode: nextRouteMode,
      modelPattern: nextRouteMode === 'pattern' ? nextModelPattern : nextDisplayName,
      displayName: nextDisplayName || null,
      displayIcon: nextDisplayIcon || null,
      enabled: nextEnabled,
      routingStrategy: nextRoutingStrategy,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.tokenRoutes.id, routeId)).run();

    if (nextRouteMode === 'explicit_group') {
      await db.delete(schema.routeGroupSources).where(eq(schema.routeGroupSources.groupRouteId, routeId)).run();
      for (const sourceRouteId of nextSourceRouteIds) {
        await db.insert(schema.routeGroupSources).values({
          groupRouteId: routeId,
          sourceRouteId,
        }).run();
      }
    } else {
      await db.delete(schema.routeGroupSources).where(eq(schema.routeGroupSources.groupRouteId, routeId)).run();
    }

    const routes = await loadRoutesWithSources(db);
    const updated = routes.find((item) => item.id === routeId) || null;
    return c.json(updated);
  });

  app.delete('/api/routes/:id', async (c) => {
    const db = getCloudflareDb(c);
    const routeId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(routeId) || routeId <= 0) {
      return c.json({ success: false, message: '路由不存在' }, 404);
    }
    await db.delete(schema.routeGroupSources).where(eq(schema.routeGroupSources.groupRouteId, routeId)).run();
    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.routeId, routeId)).run();
    await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).run();
    return c.json({ success: true });
  });

  app.post('/api/routes/batch', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const ids = parseNumberArray(body.ids);
    const action = String(body.action || '').trim();
    if (ids.length === 0) return c.json({ success: false, message: 'ids 不能为空' }, 400);
    if (!['enable', 'disable'].includes(action)) return c.json({ success: false, message: 'action 无效' }, 400);
    await db.update(schema.tokenRoutes).set({
      enabled: action === 'enable',
      updatedAt: new Date().toISOString(),
    }).where(inArray(schema.tokenRoutes.id, ids)).run();
    return c.json({ success: true });
  });

  app.post('/api/routes/:id/channels', async (c) => {
    const db = getCloudflareDb(c);
    const routeId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(routeId) || routeId <= 0) {
      return c.json({ success: false, message: '路由不存在' }, 404);
    }
    const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
    if (!route) return c.json({ success: false, message: '路由不存在' }, 404);

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const accountId = Math.trunc(Number(body.accountId));
    const tokenIdRaw = body.tokenId;
    const tokenId = tokenIdRaw == null || tokenIdRaw === '' ? null : Math.trunc(Number(tokenIdRaw));
    const sourceModel = typeof body.sourceModel === 'string' ? body.sourceModel.trim() : '';
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return c.json({ success: false, message: 'accountId 无效' }, 400);
    }

    const inserted = await db
      .insert(schema.routeChannels)
      .values({
        routeId,
        accountId,
        tokenId: tokenId && tokenId > 0 ? tokenId : null,
        sourceModel: sourceModel || (isExactModelPattern(route.modelPattern) ? route.modelPattern : null),
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: true,
      })
      .returning()
      .get();
    return c.json(inserted);
  });

  app.put('/api/channels/:id', async (c) => {
    const db = getCloudflareDb(c);
    const channelId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return c.json({ success: false, message: '通道不存在' }, 404);
    }
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Partial<typeof schema.routeChannels.$inferInsert> = {};
    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) patch.enabled = !!body.enabled;
    if (Object.prototype.hasOwnProperty.call(body, 'tokenId')) {
      const tokenIdRaw = body.tokenId;
      patch.tokenId = tokenIdRaw == null || tokenIdRaw === '' ? null : Math.trunc(Number(tokenIdRaw));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'priority')) {
      const priority = Math.trunc(Number(body.priority));
      patch.priority = Number.isFinite(priority) ? priority : 0;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'weight')) {
      const weight = Math.trunc(Number(body.weight));
      patch.weight = Number.isFinite(weight) ? weight : 10;
    }
    await db.update(schema.routeChannels).set(patch).where(eq(schema.routeChannels.id, channelId)).run();
    const updated = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
    return c.json(updated);
  });

  app.put('/api/channels/batch', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as { updates?: Array<{ id?: unknown; priority?: unknown }> };
    const updates = Array.isArray(body.updates) ? body.updates : [];
    for (const update of updates) {
      const channelId = Math.trunc(Number(update?.id));
      const priority = Math.trunc(Number(update?.priority));
      if (!Number.isFinite(channelId) || channelId <= 0 || !Number.isFinite(priority)) continue;
      await db.update(schema.routeChannels).set({ priority }).where(eq(schema.routeChannels.id, channelId)).run();
    }
    return c.json({ success: true });
  });

  app.delete('/api/channels/:id', async (c) => {
    const db = getCloudflareDb(c);
    const channelId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return c.json({ success: false, message: '通道不存在' }, 404);
    }
    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).run();
    return c.json({ success: true });
  });

  app.post('/api/routes/:id/cooldown/clear', async (c) => {
    const db = getCloudflareDb(c);
    const routeId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(routeId) || routeId <= 0) {
      return c.json({ success: false, message: '路由不存在' }, 404);
    }
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      cooldownLevel: 0,
      consecutiveFailCount: 0,
    }).where(eq(schema.routeChannels.routeId, routeId)).run();
    return c.json({ success: true });
  });

  app.get('/api/models/token-candidates', async (c) => {
    const db = getCloudflareDb(c);
    const rows = await db
      .select({
        modelName: schema.tokenModelAvailability.modelName,
        accountId: schema.accounts.id,
        tokenId: schema.accountTokens.id,
        tokenName: schema.accountTokens.name,
        tokenIsDefault: schema.accountTokens.isDefault,
        username: schema.accounts.username,
        siteId: schema.sites.id,
        siteName: schema.sites.name,
      })
      .from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, 'ready'),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ))
      .all();

    const models: Record<string, Array<{
      accountId: number;
      tokenId: number;
      tokenName: string;
      isDefault: boolean;
      username: string | null;
      siteId: number;
      siteName: string;
    }>> = {};
    for (const row of rows) {
      const modelName = String(row.modelName || '').trim();
      if (!modelName) continue;
      if (!models[modelName]) models[modelName] = [];
      if (models[modelName].some((item) => item.tokenId === row.tokenId)) continue;
      models[modelName].push({
        accountId: row.accountId,
        tokenId: row.tokenId,
        tokenName: row.tokenName,
        isDefault: !!row.tokenIsDefault,
        username: row.username || null,
        siteId: row.siteId,
        siteName: row.siteName,
      });
    }

    return c.json({
      models,
      modelsWithoutToken: {},
      modelsMissingTokenGroups: {},
      endpointTypesByModel: {},
    });
  });

  app.get('/api/models/marketplace', async (c) => {
    const db = getCloudflareDb(c);
    const includePricing = parseBooleanQueryFlag(c.req.query('includePricing'));
    const refreshRequested = parseBooleanQueryFlag(c.req.query('refresh'));

    const [tokenRows, accountRows] = await Promise.all([
      db
        .select({
          modelName: schema.tokenModelAvailability.modelName,
          latencyMs: schema.tokenModelAvailability.latencyMs,
          tokenId: schema.accountTokens.id,
          tokenName: schema.accountTokens.name,
          tokenIsDefault: schema.accountTokens.isDefault,
          accountId: schema.accounts.id,
          username: schema.accounts.username,
          balance: schema.accounts.balance,
          siteId: schema.sites.id,
          siteName: schema.sites.name,
        })
        .from(schema.tokenModelAvailability)
        .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
        .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(and(
          eq(schema.tokenModelAvailability.available, true),
          eq(schema.accountTokens.enabled, true),
          eq(schema.accountTokens.valueStatus, 'ready'),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ))
        .all(),
      db
        .select({
          modelName: schema.modelAvailability.modelName,
          latencyMs: schema.modelAvailability.latencyMs,
          accountId: schema.accounts.id,
          username: schema.accounts.username,
          balance: schema.accounts.balance,
          siteId: schema.sites.id,
          siteName: schema.sites.name,
        })
        .from(schema.modelAvailability)
        .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(and(
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ))
        .all(),
    ]);

    const modelsMap = new Map<string, {
      name: string;
      description: string | null;
      tags: string[];
      supportedEndpointTypes: string[];
      pricingSources: unknown[];
      accountIds: Set<number>;
      tokenIds: Set<number>;
      latencies: number[];
      successRate: number | null;
      accountsById: Map<number, {
        id: number;
        site: string;
        username: string | null;
        latency: number | null;
        balance: number;
        tokens: Array<{ id: number; name: string; isDefault: boolean }>;
      }>;
    }>();

    const ensureModel = (modelName: string) => {
      const normalized = modelName.trim();
      if (!normalized) return null;
      let entry = modelsMap.get(normalized);
      if (!entry) {
        entry = {
          name: normalized,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accountIds: new Set<number>(),
          tokenIds: new Set<number>(),
          latencies: [],
          successRate: null,
          accountsById: new Map(),
        };
        modelsMap.set(normalized, entry);
      }
      return entry;
    };

    for (const row of tokenRows) {
      const model = ensureModel(String(row.modelName || ''));
      if (!model) continue;
      model.accountIds.add(row.accountId);
      model.tokenIds.add(row.tokenId);
      if (Number.isFinite(Number(row.latencyMs))) {
        model.latencies.push(Math.trunc(Number(row.latencyMs)));
      }
      const existing = model.accountsById.get(row.accountId) || {
        id: row.accountId,
        site: row.siteName,
        username: row.username || null,
        latency: Number.isFinite(Number(row.latencyMs)) ? Math.trunc(Number(row.latencyMs)) : null,
        balance: toFiniteNumber(row.balance),
        tokens: [],
      };
      if (!existing.tokens.some((token) => token.id === row.tokenId)) {
        existing.tokens.push({
          id: row.tokenId,
          name: row.tokenName,
          isDefault: !!row.tokenIsDefault,
        });
      }
      model.accountsById.set(row.accountId, existing);
    }

    for (const row of accountRows) {
      const model = ensureModel(String(row.modelName || ''));
      if (!model) continue;
      model.accountIds.add(row.accountId);
      if (Number.isFinite(Number(row.latencyMs))) {
        model.latencies.push(Math.trunc(Number(row.latencyMs)));
      }
      if (!model.accountsById.has(row.accountId)) {
        model.accountsById.set(row.accountId, {
          id: row.accountId,
          site: row.siteName,
          username: row.username || null,
          latency: Number.isFinite(Number(row.latencyMs)) ? Math.trunc(Number(row.latencyMs)) : null,
          balance: toFiniteNumber(row.balance),
          tokens: [],
        });
      }
    }

    const models = [...modelsMap.values()]
      .map((model) => {
        const avgLatency = model.latencies.length > 0
          ? Math.round(model.latencies.reduce((sum, value) => sum + value, 0) / model.latencies.length)
          : null;
        return {
          name: model.name,
          accountCount: model.accountIds.size,
          tokenCount: model.tokenIds.size,
          avgLatency,
          successRate: model.successRate,
          description: model.description,
          tags: model.tags,
          supportedEndpointTypes: model.supportedEndpointTypes,
          pricingSources: includePricing ? model.pricingSources : [],
          accounts: [...model.accountsById.values()].sort((left, right) => left.id - right.id),
        };
      })
      .sort((left, right) => right.accountCount - left.accountCount || left.name.localeCompare(right.name));

    return c.json({
      models,
      meta: {
        refreshRequested,
        refreshQueued: false,
        refreshReused: false,
        refreshRunning: false,
        refreshJobId: null,
        includePricing,
      },
    });
  });

  app.get('/api/downstream-keys', async (c) => {
    const db = getCloudflareDb(c);
    const rows = await db.select().from(schema.downstreamApiKeys).all();
    return c.json({
      success: true,
      items: rows.map((row) => toDownstreamApiKeyPolicyView(row)).sort((left, right) => right.id - left.id),
    });
  });

  app.get('/api/downstream-keys/summary', async (c) => {
    const db = getCloudflareDb(c);
    const range = normalizeDownstreamRange(c.req.query('range'));
    const status = normalizeDownstreamStatus(c.req.query('status'));
    const search = normalizeQueryText(c.req.query('search')).toLowerCase();
    const group = normalizeQueryText(c.req.query('group'), 64);
    const tags = normalizeTagFilter(c.req.query('tags'));
    const tagMatch = normalizeTagMatchMode(c.req.query('tagMatch'));

    const allRows = await db.select().from(schema.downstreamApiKeys).all();
    let filteredItems = allRows.map((row) => toDownstreamApiKeyPolicyView(row));
    if (status === 'enabled') filteredItems = filteredItems.filter((item) => item.enabled);
    if (status === 'disabled') filteredItems = filteredItems.filter((item) => !item.enabled);
    if (group === '__ungrouped__') filteredItems = filteredItems.filter((item) => !item.groupName);
    if (group && group !== '__ungrouped__') filteredItems = filteredItems.filter((item) => item.groupName === group);
    if (search) {
      filteredItems = filteredItems.filter((item) => {
        const haystack = [
          item.name,
          item.description || '',
          item.keyMasked,
          item.groupName || '',
          ...item.tags,
          ...item.supportedModels,
        ].join(' ').toLowerCase();
        return haystack.includes(search);
      });
    }
    if (tags.length > 0) {
      filteredItems = filteredItems.filter((item) => {
        const itemTags = new Set(item.tags.map((tag) => tag.toLowerCase()));
        return tagMatch === 'all'
          ? tags.every((tag) => itemTags.has(tag.toLowerCase()))
          : tags.some((tag) => itemTags.has(tag.toLowerCase()));
      });
    }

    const ids = filteredItems.map((item) => item.id);
    const sinceUtc = buildDateRangeSinceUtc(range);
    const usageRows = ids.length > 0
      ? await db
        .select({
          keyId: schema.proxyLogs.downstreamApiKeyId,
          totalRequests: sql<number>`count(*)`,
          successRequests: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
          failedRequests: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 0 else 1 end), 0)`,
          totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
          totalCost: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.estimatedCost}, 0)), 0)`,
        })
        .from(schema.proxyLogs)
        .where(and(
          inArray(schema.proxyLogs.downstreamApiKeyId, ids),
          ...(sinceUtc ? [gte(schema.proxyLogs.createdAt, sinceUtc)] : []),
        ))
        .groupBy(schema.proxyLogs.downstreamApiKeyId)
        .all()
      : [];

    const usageByKeyId = new Map<number, {
      totalRequests: number;
      successRequests: number;
      failedRequests: number;
      totalTokens: number;
      totalCost: number;
    }>();
    for (const usageRow of usageRows) {
      const keyId = Math.trunc(toFiniteNumber(usageRow.keyId));
      if (!Number.isFinite(keyId) || keyId <= 0) continue;
      usageByKeyId.set(keyId, {
        totalRequests: Math.trunc(toFiniteNumber(usageRow.totalRequests)),
        successRequests: Math.trunc(toFiniteNumber(usageRow.successRequests)),
        failedRequests: Math.trunc(toFiniteNumber(usageRow.failedRequests)),
        totalTokens: Math.trunc(toFiniteNumber(usageRow.totalTokens)),
        totalCost: toRoundedMicro(usageRow.totalCost),
      });
    }

    return c.json({
      success: true,
      range,
      status,
      search,
      group,
      tags,
      tagMatch,
      items: filteredItems
        .sort((left, right) => right.id - left.id)
        .map((item) => {
          const usage = usageByKeyId.get(item.id) || {
            totalRequests: 0,
            successRequests: 0,
            failedRequests: 0,
            totalTokens: 0,
            totalCost: 0,
          };
          return {
            ...item,
            rangeUsage: {
              ...usage,
              successRate: usage.totalRequests > 0
                ? Math.round((usage.successRequests / usage.totalRequests) * 1000) / 10
                : null,
            },
          };
        }),
    });
  });

  app.get('/api/downstream-keys/:id/overview', async (c) => {
    const db = getCloudflareDb(c);
    const keyId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(keyId) || keyId <= 0) {
      return c.json({ success: false, message: 'id 无效' }, 400);
    }
    const row = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, keyId)).get();
    if (!row) {
      return c.json({ success: false, message: 'API key 不存在' }, 404);
    }
    const item = toDownstreamApiKeyPolicyView(row);
    const readAggregate = async (range: '24h' | '7d' | 'all') => {
      const sinceUtc = buildDateRangeSinceUtc(range);
      const aggregate = await db
        .select({
          totalRequests: sql<number>`count(*)`,
          successRequests: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
          failedRequests: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 0 else 1 end), 0)`,
          totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
          totalCost: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.estimatedCost}, 0)), 0)`,
        })
        .from(schema.proxyLogs)
        .where(and(
          eq(schema.proxyLogs.downstreamApiKeyId, keyId),
          ...(sinceUtc ? [gte(schema.proxyLogs.createdAt, sinceUtc)] : []),
        ))
        .get();
      const totalRequests = Math.trunc(toFiniteNumber(aggregate?.totalRequests));
      const successRequests = Math.trunc(toFiniteNumber(aggregate?.successRequests));
      return {
        totalRequests,
        successRequests,
        failedRequests: Math.trunc(toFiniteNumber(aggregate?.failedRequests)),
        successRate: totalRequests > 0 ? Math.round((successRequests / totalRequests) * 1000) / 10 : null,
        totalTokens: Math.trunc(toFiniteNumber(aggregate?.totalTokens)),
        totalCost: toRoundedMicro(aggregate?.totalCost),
      };
    };

    return c.json({
      success: true,
      item,
      usage: {
        last24h: await readAggregate('24h'),
        last7d: await readAggregate('7d'),
        all: await readAggregate('all'),
      },
    });
  });

  app.get('/api/downstream-keys/:id/trend', async (c) => {
    const db = getCloudflareDb(c);
    const keyId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(keyId) || keyId <= 0) {
      return c.json({ success: false, message: 'id 无效' }, 400);
    }
    const row = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, keyId)).get();
    if (!row) {
      return c.json({ success: false, message: 'API key 不存在' }, 404);
    }

    const range = normalizeDownstreamRange(c.req.query('range'));
    const timeZone = normalizeQueryText(c.req.query('timeZone'), 64) || null;
    const sinceUtc = buildDateRangeSinceUtc(range);
    const logs = await db
      .select({
        createdAt: schema.proxyLogs.createdAt,
        status: schema.proxyLogs.status,
        totalTokens: schema.proxyLogs.totalTokens,
        totalCost: schema.proxyLogs.estimatedCost,
      })
      .from(schema.proxyLogs)
      .where(and(
        eq(schema.proxyLogs.downstreamApiKeyId, keyId),
        ...(sinceUtc ? [gte(schema.proxyLogs.createdAt, sinceUtc)] : []),
      ))
      .orderBy(schema.proxyLogs.createdAt)
      .all();

    const bucketSeconds = range === 'all' ? 86400 : 3600;
    const bucketsMap = new Map<string, {
      startUtc: string;
      totalRequests: number;
      successRequests: number;
      failedRequests: number;
      totalTokens: number;
      totalCost: number;
    }>();
    for (const log of logs) {
      const createdAt = String(log.createdAt || '').trim();
      if (!createdAt) continue;
      const startUtc = range === 'all'
        ? `${createdAt.slice(0, 10)} 00:00:00`
        : `${createdAt.slice(0, 13)}:00:00`;
      const current = bucketsMap.get(startUtc) || {
        startUtc,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        totalTokens: 0,
        totalCost: 0,
      };
      current.totalRequests += 1;
      if (String(log.status || '') === 'success') current.successRequests += 1;
      else current.failedRequests += 1;
      current.totalTokens += Math.trunc(toFiniteNumber(log.totalTokens));
      current.totalCost += toFiniteNumber(log.totalCost);
      bucketsMap.set(startUtc, current);
    }

    const buckets = [...bucketsMap.values()]
      .sort((left, right) => left.startUtc.localeCompare(right.startUtc))
      .map((bucket) => ({
        startUtc: bucket.startUtc,
        totalRequests: bucket.totalRequests,
        successRequests: bucket.successRequests,
        failedRequests: bucket.failedRequests,
        successRate: bucket.totalRequests > 0 ? Math.round((bucket.successRequests / bucket.totalRequests) * 1000) / 10 : null,
        totalTokens: bucket.totalTokens,
        totalCost: toRoundedMicro(bucket.totalCost),
      }));

    return c.json({
      success: true,
      range,
      item: { id: row.id, name: row.name },
      bucketSeconds,
      timeZone,
      buckets,
    });
  });

  app.post('/api/downstream-keys', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const name = normalizeQueryText(String(body.name || ''), 100);
    const key = normalizeQueryText(String(body.key || ''), 300);
    if (!name) return c.json({ success: false, message: 'name 不能为空' }, 400);
    if (!key) return c.json({ success: false, message: 'key 不能为空' }, 400);
    if (!validateDownstreamKeyShape(key)) {
      return c.json({ success: false, message: 'key 必须以 sk- 开头且长度至少 6' }, 400);
    }
    const now = new Date().toISOString();
    try {
      await db.insert(schema.downstreamApiKeys).values({
        name,
        key,
        description: normalizeQueryText(typeof body.description === 'string' ? body.description : '', 200) || null,
        groupName: normalizeQueryText(typeof body.groupName === 'string' ? body.groupName : '', 64) || null,
        tags: JSON.stringify(parseStringArray(JSON.stringify(body.tags))),
        enabled: Object.prototype.hasOwnProperty.call(body, 'enabled') ? !!body.enabled : true,
        expiresAt: typeof body.expiresAt === 'string' && body.expiresAt.trim() ? body.expiresAt.trim() : null,
        maxCost: Object.prototype.hasOwnProperty.call(body, 'maxCost') ? toFiniteNumber(body.maxCost) : null,
        usedCost: 0,
        maxRequests: Object.prototype.hasOwnProperty.call(body, 'maxRequests') ? Math.trunc(toFiniteNumber(body.maxRequests)) : null,
        usedRequests: 0,
        supportedModels: JSON.stringify(parseStringArray(JSON.stringify(body.supportedModels))),
        allowedRouteIds: JSON.stringify(parseNumberArray(JSON.stringify(body.allowedRouteIds))),
        siteWeightMultipliers: JSON.stringify(parseNumberMap(JSON.stringify(body.siteWeightMultipliers))),
        excludedSiteIds: JSON.stringify(parseNumberArray(JSON.stringify(body.excludedSiteIds))),
        excludedCredentialRefs: JSON.stringify(Array.isArray(body.excludedCredentialRefs) ? body.excludedCredentialRefs : []),
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      }).run();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '创建失败';
      if (message.toLowerCase().includes('unique')) {
        return c.json({ success: false, message: 'API key 已存在' }, 409);
      }
      return c.json({ success: false, message }, 500);
    }

    const created = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.key, key)).get();
    return c.json({ success: true, item: created ? toDownstreamApiKeyPolicyView(created) : null });
  });

  app.put('/api/downstream-keys/:id', async (c) => {
    const db = getCloudflareDb(c);
    const keyId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(keyId) || keyId <= 0) return c.json({ success: false, message: 'id 无效' }, 400);
    const existing = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, keyId)).get();
    if (!existing) return c.json({ success: false, message: 'API key 不存在' }, 404);
    const existingView = toDownstreamApiKeyPolicyView(existing);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    const name = Object.prototype.hasOwnProperty.call(body, 'name')
      ? normalizeQueryText(String(body.name || ''), 100)
      : existingView.name;
    const key = Object.prototype.hasOwnProperty.call(body, 'key')
      ? normalizeQueryText(String(body.key || ''), 300)
      : existingView.key;
    if (!name) return c.json({ success: false, message: 'name 不能为空' }, 400);
    if (!key) return c.json({ success: false, message: 'key 不能为空' }, 400);
    if (!validateDownstreamKeyShape(key)) {
      return c.json({ success: false, message: 'key 必须以 sk- 开头且长度至少 6' }, 400);
    }

    const now = new Date().toISOString();
    try {
      await db.update(schema.downstreamApiKeys).set({
        name,
        key,
        description: Object.prototype.hasOwnProperty.call(body, 'description')
          ? (normalizeQueryText(typeof body.description === 'string' ? body.description : '', 200) || null)
          : existingView.description,
        groupName: Object.prototype.hasOwnProperty.call(body, 'groupName')
          ? (normalizeQueryText(typeof body.groupName === 'string' ? body.groupName : '', 64) || null)
          : existingView.groupName,
        tags: Object.prototype.hasOwnProperty.call(body, 'tags')
          ? JSON.stringify(parseStringArray(JSON.stringify(body.tags)))
          : JSON.stringify(existingView.tags),
        enabled: Object.prototype.hasOwnProperty.call(body, 'enabled')
          ? !!body.enabled
          : existingView.enabled,
        expiresAt: Object.prototype.hasOwnProperty.call(body, 'expiresAt')
          ? (typeof body.expiresAt === 'string' && body.expiresAt.trim() ? body.expiresAt.trim() : null)
          : existingView.expiresAt,
        maxCost: Object.prototype.hasOwnProperty.call(body, 'maxCost')
          ? (body.maxCost == null || body.maxCost === '' ? null : toFiniteNumber(body.maxCost))
          : existingView.maxCost,
        maxRequests: Object.prototype.hasOwnProperty.call(body, 'maxRequests')
          ? (body.maxRequests == null || body.maxRequests === '' ? null : Math.trunc(toFiniteNumber(body.maxRequests)))
          : existingView.maxRequests,
        supportedModels: Object.prototype.hasOwnProperty.call(body, 'supportedModels')
          ? JSON.stringify(parseStringArray(JSON.stringify(body.supportedModels)))
          : JSON.stringify(existingView.supportedModels),
        allowedRouteIds: Object.prototype.hasOwnProperty.call(body, 'allowedRouteIds')
          ? JSON.stringify(parseNumberArray(JSON.stringify(body.allowedRouteIds)))
          : JSON.stringify(existingView.allowedRouteIds),
        siteWeightMultipliers: Object.prototype.hasOwnProperty.call(body, 'siteWeightMultipliers')
          ? JSON.stringify(parseNumberMap(JSON.stringify(body.siteWeightMultipliers)))
          : JSON.stringify(existingView.siteWeightMultipliers),
        excludedSiteIds: Object.prototype.hasOwnProperty.call(body, 'excludedSiteIds')
          ? JSON.stringify(parseNumberArray(JSON.stringify(body.excludedSiteIds)))
          : JSON.stringify(existingView.excludedSiteIds),
        excludedCredentialRefs: Object.prototype.hasOwnProperty.call(body, 'excludedCredentialRefs')
          ? JSON.stringify(Array.isArray(body.excludedCredentialRefs) ? body.excludedCredentialRefs : [])
          : JSON.stringify(existingView.excludedCredentialRefs),
        updatedAt: now,
      }).where(eq(schema.downstreamApiKeys.id, keyId)).run();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '更新失败';
      if (message.toLowerCase().includes('unique')) {
        return c.json({ success: false, message: 'API key 已存在' }, 409);
      }
      return c.json({ success: false, message }, 500);
    }

    const updated = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, keyId)).get();
    return c.json({ success: true, item: updated ? toDownstreamApiKeyPolicyView(updated) : null });
  });

  app.post('/api/downstream-keys/:id/reset-usage', async (c) => {
    const db = getCloudflareDb(c);
    const keyId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(keyId) || keyId <= 0) return c.json({ success: false, message: 'id 无效' }, 400);
    const existing = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, keyId)).get();
    if (!existing) return c.json({ success: false, message: 'API key 不存在' }, 404);
    await db.update(schema.downstreamApiKeys).set({
      usedCost: 0,
      usedRequests: 0,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.downstreamApiKeys.id, keyId)).run();
    const updated = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, keyId)).get();
    return c.json({ success: true, item: updated ? toDownstreamApiKeyPolicyView(updated) : null });
  });

  app.delete('/api/downstream-keys/:id', async (c) => {
    const db = getCloudflareDb(c);
    const keyId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(keyId) || keyId <= 0) return c.json({ success: false, message: 'id 无效' }, 400);
    await db.delete(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, keyId)).run();
    return c.json({ success: true });
  });

  app.post('/api/downstream-keys/batch', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const ids = parseNumberArray(body.ids);
    const action = String(body.action || '').trim();
    if (ids.length === 0) return c.json({ success: false, message: 'ids is required' }, 400);
    if (!['enable', 'disable', 'delete', 'resetUsage', 'updateMetadata'].includes(action)) {
      return c.json({ success: false, message: 'Invalid action' }, 400);
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];
    for (const id of ids) {
      try {
        const existing = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, id)).get();
        if (!existing) {
          failedItems.push({ id, message: 'API key 不存在' });
          continue;
        }
        const existingView = toDownstreamApiKeyPolicyView(existing);
        if (action === 'delete') {
          await db.delete(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, id)).run();
        } else if (action === 'resetUsage') {
          await db.update(schema.downstreamApiKeys).set({
            usedCost: 0,
            usedRequests: 0,
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.downstreamApiKeys.id, id)).run();
        } else if (action === 'updateMetadata') {
          const groupOperation = String(body.groupOperation || 'keep').trim();
          const tagOperation = String(body.tagOperation || 'keep').trim();
          const normalizedGroupName = normalizeQueryText(String(body.groupName || ''), 64) || null;
          const normalizedTags = parseStringArray(JSON.stringify(body.tags));
          const nextGroupName = groupOperation === 'keep'
            ? existingView.groupName
            : (groupOperation === 'clear' ? null : normalizedGroupName);
          const nextTags = tagOperation === 'append'
            ? [...new Map([...existingView.tags, ...normalizedTags].map((tag) => [tag.toLowerCase(), tag])).values()]
            : existingView.tags;
          await db.update(schema.downstreamApiKeys).set({
            groupName: nextGroupName,
            tags: JSON.stringify(nextTags),
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.downstreamApiKeys.id, id)).run();
        } else {
          await db.update(schema.downstreamApiKeys).set({
            enabled: action === 'enable',
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.downstreamApiKeys.id, id)).run();
        }
        successIds.push(id);
      } catch (error: unknown) {
        failedItems.push({
          id,
          message: error instanceof Error ? error.message : 'Batch operation failed',
        });
      }
    }

    return c.json({ success: true, successIds, failedItems });
  });

  app.get('/api/stats/dashboard', async (c) => {
    const db = getCloudflareDb(c);
    const _forceRefresh = parseBooleanQueryFlag(c.req.query('refresh'));
    void _forceRefresh;
    const view = normalizeDashboardView(c.req.query('view'));

    if (view === 'summary') {
      const summary = await loadDashboardSummaryPayload(db);
      return c.json({
        generatedAt: new Date().toISOString(),
        ...summary,
      });
    }

    if (view === 'insights') {
      const insights = await loadDashboardInsightsPayload(db);
      return c.json({
        generatedAt: new Date().toISOString(),
        ...insights,
      });
    }

    const [summary, insights] = await Promise.all([
      loadDashboardSummaryPayload(db),
      loadDashboardInsightsPayload(db),
    ]);

    return c.json({
      generatedAt: new Date().toISOString(),
      ...summary,
      ...insights,
    });
  });

  app.get('/api/stats/site-distribution', async (c) => {
    const db = getCloudflareDb(c);
    const days = normalizePositiveInt(c.req.query('days'), 7);
    const _forceRefresh = parseBooleanQueryFlag(c.req.query('refresh'));
    void _forceRefresh;
    const snapshot = await loadSiteStatsSnapshotPayload(db, days);
    return c.json({ distribution: snapshot.distribution });
  });

  app.get('/api/stats/site-trend', async (c) => {
    const db = getCloudflareDb(c);
    const days = normalizePositiveInt(c.req.query('days'), 7);
    const _forceRefresh = parseBooleanQueryFlag(c.req.query('refresh'));
    void _forceRefresh;
    const snapshot = await loadSiteStatsSnapshotPayload(db, days);
    return c.json({ trend: snapshot.trend });
  });

  app.get('/api/stats/model-by-site', async (c) => {
    const db = getCloudflareDb(c);
    const siteId = Math.trunc(Number(c.req.query('siteId') || '0'));
    const days = Math.max(1, normalizePositiveInt(c.req.query('days'), 7));
    const sinceDay = formatUtcDayKeyDaysAgo(days);

    const rows = Number.isFinite(siteId) && siteId > 0
      ? await db
        .select({
          model: schema.modelDayUsage.model,
          totalCalls: schema.modelDayUsage.totalCalls,
          totalTokens: schema.modelDayUsage.totalTokens,
          totalSpend: schema.modelDayUsage.totalSpend,
        })
        .from(schema.modelDayUsage)
        .where(and(
          eq(schema.modelDayUsage.siteId, siteId),
          gte(schema.modelDayUsage.localDay, sinceDay),
        ))
        .all()
      : await db
        .select({
          model: schema.modelDayUsage.model,
          totalCalls: schema.modelDayUsage.totalCalls,
          totalTokens: schema.modelDayUsage.totalTokens,
          totalSpend: schema.modelDayUsage.totalSpend,
        })
        .from(schema.modelDayUsage)
        .where(gte(schema.modelDayUsage.localDay, sinceDay))
        .all();

    const modelMap = new Map<string, { calls: number; tokens: number; spend: number }>();
    for (const row of rows) {
      const model = String(row.model || '').trim() || 'unknown';
      const current = modelMap.get(model) || { calls: 0, tokens: 0, spend: 0 };
      current.calls += Math.trunc(toFiniteNumber(row.totalCalls));
      current.tokens += Math.trunc(toFiniteNumber(row.totalTokens));
      current.spend += toFiniteNumber(row.totalSpend);
      modelMap.set(model, current);
    }

    const models = [...modelMap.entries()]
      .map(([model, stats]) => ({
        model,
        calls: stats.calls,
        tokens: stats.tokens,
        spend: toRoundedMicro(stats.spend),
      }))
      .sort((left, right) => right.calls - left.calls || left.model.localeCompare(right.model));

    return c.json({ models });
  });

  app.get('/api/stats/proxy-logs', async (c) => {
    const db = getCloudflareDb(c);
    const view = String(c.req.query('view') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, normalizePositiveInt(c.req.query('limit'), 50)));
    const offset = Math.max(0, Number.parseInt(c.req.query('offset') || '0', 10) || 0);
    const search = normalizeQueryText(c.req.query('search'), 120).toLowerCase();
    const status = normalizeProxyLogStatus(c.req.query('status'));
    const siteId = Math.trunc(Number(c.req.query('siteId') || '0'));
    const clientFilter = normalizeProxyLogClientFilter(c.req.query('client'));
    const fromMs = normalizeProxyLogTimeBoundary(c.req.query('from'));
    const toMs = normalizeProxyLogTimeBoundary(c.req.query('to'));

    const rows = await db
      .select()
      .from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(schema.downstreamApiKeys, eq(schema.proxyLogs.downstreamApiKeyId, schema.downstreamApiKeys.id))
      .orderBy(desc(schema.proxyLogs.createdAt))
      .limit(4000)
      .all();

    const mapped = rows.map((row) => {
      const proxyLog = row.proxy_logs;
      const account = row.accounts;
      const site = row.sites;
      const keyRow = row.downstream_api_keys;
      const billingParsed = parseJsonValue(proxyLog.billingDetails);
      return {
        id: proxyLog.id,
        createdAt: proxyLog.createdAt || '',
        modelRequested: proxyLog.modelRequested || '',
        modelActual: proxyLog.modelActual || '',
        status: proxyLog.status || 'failed',
        latencyMs: Math.trunc(toFiniteNumber(proxyLog.latencyMs)),
        isStream: proxyLog.isStream ?? null,
        firstByteLatencyMs: proxyLog.firstByteLatencyMs ?? null,
        totalTokens: proxyLog.totalTokens ?? null,
        retryCount: Math.trunc(toFiniteNumber(proxyLog.retryCount)),
        accountId: proxyLog.accountId ?? null,
        siteId: site?.id ?? null,
        username: account?.username || null,
        siteName: site?.name || null,
        siteUrl: site?.url || null,
        errorMessage: proxyLog.errorMessage || null,
        downstreamKeyId: proxyLog.downstreamApiKeyId ?? null,
        downstreamKeyName: keyRow?.name || null,
        downstreamKeyGroupName: keyRow?.groupName || null,
        downstreamKeyTags: parseStringArray(keyRow?.tags),
        clientFamily: proxyLog.clientFamily || null,
        clientAppId: proxyLog.clientAppId || null,
        clientAppName: proxyLog.clientAppName || null,
        clientConfidence: proxyLog.clientConfidence || null,
        usageSource: null,
        promptTokens: proxyLog.promptTokens ?? null,
        completionTokens: proxyLog.completionTokens ?? null,
        estimatedCost: proxyLog.estimatedCost ?? null,
        billingDetails: billingParsed && typeof billingParsed === 'object' ? billingParsed : null,
        routeId: proxyLog.routeId ?? null,
        channelId: proxyLog.channelId ?? null,
        httpStatus: proxyLog.httpStatus ?? null,
      };
    });

    const filteredBase = mapped.filter((item) => {
      if (status === 'success' && item.status !== 'success') return false;
      if (status === 'failed' && item.status === 'success') return false;
      if (Number.isFinite(siteId) && siteId > 0 && item.siteId !== siteId) return false;
      const timestamp = parseStoredDateToTimestamp(item.createdAt);
      if (fromMs != null && timestamp > 0 && timestamp < fromMs) return false;
      if (toMs != null && timestamp > 0 && timestamp >= toMs) return false;
      if (search) {
        const haystack = [
          item.modelRequested,
          item.modelActual,
          item.username || '',
          item.siteName || '',
          item.errorMessage || '',
          item.downstreamKeyName || '',
          item.downstreamKeyGroupName || '',
          ...(item.downstreamKeyTags || []),
        ].join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    const filtered = filteredBase.filter((item) => {
      if (!clientFilter) return true;
      if (clientFilter.kind === 'app') {
        return String(item.clientAppId || '').trim().toLowerCase() === clientFilter.value;
      }
      return String(item.clientFamily || '').trim().toLowerCase() === clientFilter.value;
    });

    const summary = {
      totalCount: filtered.length,
      successCount: filtered.filter((item) => item.status === 'success').length,
      failedCount: filtered.filter((item) => item.status !== 'success').length,
      totalCost: toRoundedMicro(filtered.reduce((sum, item) => sum + toFiniteNumber(item.estimatedCost), 0)),
      totalTokensAll: Math.trunc(filtered.reduce((sum, item) => sum + Math.trunc(toFiniteNumber(item.totalTokens)), 0)),
    };

    const clientOptionMap = new Map<string, string>();
    for (const item of filteredBase) {
      const appId = String(item.clientAppId || '').trim();
      if (appId) {
        const appName = String(item.clientAppName || '').trim() || appId;
        clientOptionMap.set(`app:${appId}`, appName);
      }
      const family = String(item.clientFamily || '').trim().toLowerCase();
      if (family) {
        const familyLabelMap: Record<string, string> = {
          codex: 'Codex',
          claude_code: 'Claude Code',
          gemini_cli: 'Gemini CLI',
          generic: '通用',
        };
        clientOptionMap.set(`family:${family}`, familyLabelMap[family] || family);
      }
    }
    const clientOptions = [...clientOptionMap.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label));

    const sites = await db
      .select({
        id: schema.sites.id,
        name: schema.sites.name,
        status: schema.sites.status,
      })
      .from(schema.sites)
      .all();

    const items = filtered.slice(offset, offset + limit);
    const page = Math.floor(offset / limit) + 1;
    const pageSize = limit;
    if (view === 'query') {
      return c.json({ items, total: filtered.length, page, pageSize });
    }
    if (view === 'meta') {
      return c.json({ clientOptions, summary, sites });
    }
    return c.json({
      items,
      total: filtered.length,
      page,
      pageSize,
      clientOptions,
      summary,
      sites,
    });
  });

  app.get('/api/stats/proxy-logs/:id', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ success: false, message: 'id 无效' }, 400);
    }
    const row = await db
      .select()
      .from(schema.proxyLogs)
      .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(schema.downstreamApiKeys, eq(schema.proxyLogs.downstreamApiKeyId, schema.downstreamApiKeys.id))
      .where(eq(schema.proxyLogs.id, id))
      .get();
    if (!row) return c.json({ success: false, message: '日志不存在' }, 404);
    const proxyLog = row.proxy_logs;
    const account = row.accounts;
    const site = row.sites;
    const keyRow = row.downstream_api_keys;
    const billingParsed = parseJsonValue(proxyLog.billingDetails);
    return c.json({
      id: proxyLog.id,
      createdAt: proxyLog.createdAt || '',
      modelRequested: proxyLog.modelRequested || '',
      modelActual: proxyLog.modelActual || '',
      status: proxyLog.status || 'failed',
      latencyMs: Math.trunc(toFiniteNumber(proxyLog.latencyMs)),
      isStream: proxyLog.isStream ?? null,
      firstByteLatencyMs: proxyLog.firstByteLatencyMs ?? null,
      totalTokens: proxyLog.totalTokens ?? null,
      retryCount: Math.trunc(toFiniteNumber(proxyLog.retryCount)),
      accountId: proxyLog.accountId ?? null,
      siteId: site?.id ?? null,
      username: account?.username || null,
      siteName: site?.name || null,
      siteUrl: site?.url || null,
      errorMessage: proxyLog.errorMessage || null,
      downstreamKeyId: proxyLog.downstreamApiKeyId ?? null,
      downstreamKeyName: keyRow?.name || null,
      downstreamKeyGroupName: keyRow?.groupName || null,
      downstreamKeyTags: parseStringArray(keyRow?.tags),
      clientFamily: proxyLog.clientFamily || null,
      clientAppId: proxyLog.clientAppId || null,
      clientAppName: proxyLog.clientAppName || null,
      clientConfidence: proxyLog.clientConfidence || null,
      usageSource: null,
      promptTokens: proxyLog.promptTokens ?? null,
      completionTokens: proxyLog.completionTokens ?? null,
      estimatedCost: proxyLog.estimatedCost ?? null,
      billingDetails: billingParsed && typeof billingParsed === 'object' ? billingParsed : null,
      routeId: proxyLog.routeId ?? null,
      channelId: proxyLog.channelId ?? null,
      httpStatus: proxyLog.httpStatus ?? null,
    });
  });

  app.get('/api/stats/proxy-debug/traces', async (c) => {
    const db = getCloudflareDb(c);
    const limit = Math.max(1, Math.min(200, normalizePositiveInt(c.req.query('limit'), 20)));
    const rows = await db
      .select()
      .from(schema.proxyDebugTraces)
      .orderBy(desc(schema.proxyDebugTraces.createdAt))
      .limit(limit)
      .all();
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt || '',
        downstreamPath: row.downstreamPath || '',
        clientKind: row.clientKind || null,
        sessionId: row.sessionId || null,
        requestedModel: row.requestedModel || null,
        selectedChannelId: row.selectedChannelId ?? null,
        finalStatus: row.finalStatus || null,
        finalHttpStatus: row.finalHttpStatus ?? null,
        finalUpstreamPath: row.finalUpstreamPath || null,
      })),
    });
  });

  app.get('/api/stats/proxy-debug/traces/:id', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ success: false, message: 'id 无效' }, 400);
    }
    const trace = await db
      .select()
      .from(schema.proxyDebugTraces)
      .where(eq(schema.proxyDebugTraces.id, id))
      .get();
    if (!trace) return c.json({ success: false, message: 'trace 不存在' }, 404);
    const attempts = await db
      .select()
      .from(schema.proxyDebugAttempts)
      .where(eq(schema.proxyDebugAttempts.traceId, id))
      .orderBy(schema.proxyDebugAttempts.attemptIndex)
      .all();
    return c.json({
      trace: {
        id: trace.id,
        createdAt: trace.createdAt || null,
        updatedAt: trace.updatedAt || null,
        downstreamPath: trace.downstreamPath || null,
        clientKind: trace.clientKind || null,
        sessionId: trace.sessionId || null,
        traceHint: trace.traceHint || null,
        requestedModel: trace.requestedModel || null,
        stickySessionKey: trace.stickySessionKey || null,
        stickyHitChannelId: trace.stickyHitChannelId ?? null,
        selectedChannelId: trace.selectedChannelId ?? null,
        selectedRouteId: trace.selectedRouteId ?? null,
        selectedAccountId: trace.selectedAccountId ?? null,
        selectedSiteId: trace.selectedSiteId ?? null,
        selectedSitePlatform: trace.selectedSitePlatform || null,
        endpointCandidatesJson: trace.endpointCandidatesJson || null,
        endpointRuntimeStateJson: trace.endpointRuntimeStateJson || null,
        decisionSummaryJson: trace.decisionSummaryJson || null,
        requestHeadersJson: trace.requestHeadersJson || null,
        requestBodyJson: trace.requestBodyJson || null,
        finalStatus: trace.finalStatus || null,
        finalHttpStatus: trace.finalHttpStatus ?? null,
        finalUpstreamPath: trace.finalUpstreamPath || null,
        finalResponseHeadersJson: trace.finalResponseHeadersJson || null,
        finalResponseBodyJson: trace.finalResponseBodyJson || null,
      },
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        attemptIndex: attempt.attemptIndex,
        endpoint: attempt.endpoint,
        requestPath: attempt.requestPath,
        targetUrl: attempt.targetUrl,
        runtimeExecutor: attempt.runtimeExecutor || null,
        requestHeadersJson: attempt.requestHeadersJson || null,
        requestBodyJson: attempt.requestBodyJson || null,
        responseStatus: attempt.responseStatus ?? null,
        responseHeadersJson: attempt.responseHeadersJson || null,
        responseBodyJson: attempt.responseBodyJson || null,
        rawErrorText: attempt.rawErrorText || null,
        recoverApplied: attempt.recoverApplied ?? null,
        downgradeDecision: attempt.downgradeDecision ?? null,
        downgradeReason: attempt.downgradeReason || null,
        memoryWriteJson: attempt.memoryWriteJson || null,
        createdAt: attempt.createdAt || null,
      })),
    });
  });

  app.post('/api/checkin/trigger', async (c) => {
    const db = getCloudflareDb(c);
    const now = formatUtcSqlDateTime();
    const accountRows = await db
      .select({
        account: schema.accounts,
        site: schema.sites,
      })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .all();

    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of accountRows) {
      const accountStatus = String(row.account.status || '').trim().toLowerCase();
      const siteStatus = String(row.site.status || '').trim().toLowerCase();
      const checkinEnabled = row.account.checkinEnabled !== false;
      const capabilities = buildCapabilitiesFromCredentialMode(resolveStoredCredentialMode(row.account));

      if (accountStatus !== 'active' || siteStatus !== 'active' || !checkinEnabled || !capabilities.canCheckin) {
        skipped += 1;
        await db.insert(schema.checkinLogs).values({
          accountId: row.account.id,
          status: 'skipped',
          message: accountStatus !== 'active'
            ? '账号已禁用，跳过签到'
            : siteStatus !== 'active'
              ? '站点已禁用，跳过签到'
              : !checkinEnabled
                ? '账号未开启签到，跳过'
                : '当前连接类型不支持签到',
          reward: '',
          createdAt: now,
        }).run();
        continue;
      }

      try {
        const checkinResult = await performUpstreamCheckin({
          site: row.site,
          account: row.account,
        });
        const refreshedBalance = checkinResult.status === 'success'
          ? await refreshAccountBalanceFromUpstream(row.account, row.site).catch(() => null)
          : null;
        let rewardValue = checkinResult.reward;
        if (!rewardValue && refreshedBalance) {
          const balanceDelta = roundCurrency(toFiniteNumber(refreshedBalance.balance) - toFiniteNumber(row.account.balance));
          if (balanceDelta > 0) rewardValue = String(balanceDelta);
        }
        const runtimeHealth = buildRuntimeHealthRecord({
          state: checkinResult.runtimeState,
          reason: checkinResult.runtimeReason,
          source: 'checkin',
          checkedAt: new Date().toISOString(),
        });
        const nextExtraConfig = mergeAccountExtraConfig(row.account.extraConfig, {
          runtimeHealth,
        });
        await db.insert(schema.checkinLogs).values({
          accountId: row.account.id,
          status: checkinResult.status,
          message: checkinResult.message,
          reward: rewardValue,
          createdAt: now,
        }).run();
        await db.update(schema.accounts).set({
          ...(checkinResult.status === 'success' ? { lastCheckinAt: now } : {}),
          ...(refreshedBalance
            ? {
              balance: refreshedBalance.balance,
              balanceUsed: refreshedBalance.used,
              quota: refreshedBalance.quota,
              ...(shouldAutoUpgradeAccountUsername(row.account.username) ? { username: refreshedBalance.username || null } : {}),
            }
            : {}),
          extraConfig: nextExtraConfig,
          updatedAt: now,
        }).where(eq(schema.accounts.id, row.account.id)).run();
        if (checkinResult.status === 'success') {
          success += 1;
        } else if (checkinResult.status === 'skipped') {
          skipped += 1;
        } else {
          failed += 1;
        }
      } catch (error: unknown) {
        failed += 1;
        const failedMessage = error instanceof Error
          ? String(error.message || '').trim() || '签到失败'
          : '签到失败';
        await db.insert(schema.checkinLogs).values({
          accountId: row.account.id,
          status: 'failed',
          message: failedMessage,
          reward: '',
          createdAt: now,
        }).run().catch(() => undefined);
      }
    }

    const task = createCloudflareTask({
      type: 'checkin',
      title: '全部账号签到',
      status: failed > 0 ? 'failed' : 'succeeded',
      message: `签到完成：成功 ${success}，跳过 ${skipped}，失败 ${failed}`,
      result: { success, failed, skipped },
    });
    return c.json({
      success: true,
      queued: false,
      reused: false,
      jobId: task.id,
      status: task.status,
      summary: { success, skipped, failed, total: accountRows.length },
      message: `全部签到已完成：成功 ${success}，跳过 ${skipped}，失败 ${failed}`,
    });
  });

  app.post('/api/checkin/trigger/:id', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return c.json({ success: false, message: 'accountId 无效' }, 400);
    }
    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    if (!account) return c.json({ success: false, message: '账号不存在' }, 404);
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, account.siteId)).get();
    const accountStatus = String(account.status || '').trim().toLowerCase();
    const siteStatus = String(site?.status || '').trim().toLowerCase();
    const capabilities = buildCapabilitiesFromCredentialMode(resolveStoredCredentialMode(account));
    const now = formatUtcSqlDateTime();
    if (accountStatus !== 'active' || siteStatus !== 'active' || account.checkinEnabled === false || !capabilities.canCheckin) {
      await db.insert(schema.checkinLogs).values({
        accountId,
        status: 'skipped',
        message: accountStatus !== 'active'
          ? '账号已禁用，跳过签到'
          : siteStatus !== 'active'
            ? '站点已禁用，跳过签到'
            : account.checkinEnabled === false
              ? '账号未开启签到，跳过'
              : '当前连接类型不支持签到',
        reward: '',
        createdAt: now,
      }).run();
      return c.json({
        success: true,
        status: 'skipped',
        skipped: true,
        message: '当前账号已跳过签到',
      });
    }

    const checkinResult = await performUpstreamCheckin({
      site: site!,
      account,
    });
    const refreshedBalance = checkinResult.status === 'success'
      ? await refreshAccountBalanceFromUpstream(account, site).catch(() => null)
      : null;
    let rewardValue = checkinResult.reward;
    if (!rewardValue && refreshedBalance) {
      const balanceDelta = roundCurrency(toFiniteNumber(refreshedBalance.balance) - toFiniteNumber(account.balance));
      if (balanceDelta > 0) rewardValue = String(balanceDelta);
    }
    const runtimeHealth = buildRuntimeHealthRecord({
      state: checkinResult.runtimeState,
      reason: checkinResult.runtimeReason,
      source: 'checkin',
      checkedAt: new Date().toISOString(),
    });
    const nextExtraConfig = mergeAccountExtraConfig(account.extraConfig, {
      runtimeHealth,
    });
    await db.insert(schema.checkinLogs).values({
      accountId,
      status: checkinResult.status,
      message: checkinResult.message,
      reward: rewardValue,
      createdAt: now,
    }).run();
    await db.update(schema.accounts).set({
      ...(checkinResult.status === 'success' ? { lastCheckinAt: now } : {}),
      ...(refreshedBalance
        ? {
          balance: refreshedBalance.balance,
          balanceUsed: refreshedBalance.used,
          quota: refreshedBalance.quota,
          ...(shouldAutoUpgradeAccountUsername(account.username) ? { username: refreshedBalance.username || null } : {}),
        }
        : {}),
      extraConfig: nextExtraConfig,
      updatedAt: now,
    }).where(eq(schema.accounts.id, accountId)).run();
    if (checkinResult.status === 'failed') {
      return c.json({
        success: false,
        status: 'failed',
        message: checkinResult.message,
      }, 400);
    }
    return c.json({
      success: true,
      status: checkinResult.status,
      ...(checkinResult.status === 'skipped' ? { skipped: true } : {}),
      ...(refreshedBalance
        ? {
          balance: refreshedBalance.balance,
          balanceUsed: refreshedBalance.used,
          quota: refreshedBalance.quota,
        }
        : {}),
      ...(rewardValue ? { reward: rewardValue } : {}),
      message: checkinResult.message || '签到完成',
    });
  });

  app.get('/api/checkin/logs', async (c) => {
    const db = getCloudflareDb(c);
    const limit = Math.max(1, Math.min(500, normalizePositiveInt(c.req.query('limit'), 100)));
    const offset = Math.max(0, Number.parseInt(c.req.query('offset') || '0', 10) || 0);
    const accountId = Math.trunc(Number(c.req.query('accountId') || '0'));
    const rows = await db
      .select()
      .from(schema.checkinLogs)
      .innerJoin(schema.accounts, eq(schema.checkinLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .orderBy(desc(schema.checkinLogs.createdAt))
      .limit(limit)
      .offset(offset)
      .all();
    const scoped = accountId > 0
      ? rows.filter((row) => row.checkin_logs.accountId === accountId)
      : rows;
    return c.json(scoped.map((row) => {
      const status = String(row.checkin_logs.status || 'failed').trim().toLowerCase();
      const message = String(row.checkin_logs.message || '').trim();
      const failureReason = status === 'failed'
        ? {
          code: 'checkin_failed',
          category: 'checkin',
          title: '签到失败',
          actionHint: '请检查账号状态、站点配置和令牌有效性',
          detailHint: message || '未知原因',
        }
        : null;
      return {
        ...row,
        failureReason,
      };
    }));
  });

  app.put('/api/checkin/schedule', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const stored = await readSetting(db, 'cloudflare_runtime_settings');
    const current = normalizeRuntimeSettingsObject(stored);
    const next = {
      ...current,
      checkinScheduleMode: body.mode === 'interval' ? 'interval' : 'cron',
      ...(typeof body.cron === 'string' ? { checkinCron: body.cron.trim() } : {}),
      ...(Number.isFinite(Number(body.intervalHours))
        ? { checkinIntervalHours: Math.max(1, Math.min(24, Math.trunc(Number(body.intervalHours)))) }
        : {}),
    };
    await writeSetting(db, 'cloudflare_runtime_settings', next);
    return c.json({
      success: true,
      mode: next.checkinScheduleMode,
      cron: next.checkinCron,
      intervalHours: next.checkinIntervalHours,
    });
  });

  app.get('/api/site-announcements', async (c) => {
    const db = getCloudflareDb(c);
    const limit = Math.max(1, Math.min(500, normalizePositiveInt(c.req.query('limit'), 50)));
    const offset = Math.max(0, Number.parseInt(c.req.query('offset') || '0', 10) || 0);
    const siteId = Math.trunc(Number(c.req.query('siteId') || '0'));
    const platform = String(c.req.query('platform') || '').trim();
    const read = String(c.req.query('read') || '').trim().toLowerCase();
    const status = String(c.req.query('status') || '').trim().toLowerCase();
    const rows = await db
      .select()
      .from(schema.siteAnnouncements)
      .orderBy(desc(schema.siteAnnouncements.firstSeenAt))
      .all();
    const filtered = rows.filter((row) => {
      if (siteId > 0 && row.siteId !== siteId) return false;
      if (platform && row.platform !== platform) return false;
      const isRead = !!String(row.readAt || '').trim();
      if (read === 'true' && !isRead) return false;
      if (read === 'false' && isRead) return false;
      if (status === 'dismissed' && !String(row.dismissedAt || '').trim()) return false;
      if (status === 'active') {
        if (String(row.dismissedAt || '').trim()) return false;
        const endsAt = parseStoredDateToTimestamp(row.endsAt);
        if (endsAt > 0 && endsAt < Date.now()) return false;
      }
      if (status === 'expired') {
        const endsAt = parseStoredDateToTimestamp(row.endsAt);
        if (!(endsAt > 0 && endsAt < Date.now())) return false;
      }
      return true;
    });
    return c.json(filtered.slice(offset, offset + limit));
  });

  app.post('/api/site-announcements/:id/read', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'id 无效' }, 400);
    await db.update(schema.siteAnnouncements)
      .set({ readAt: formatUtcSqlDateTime() })
      .where(eq(schema.siteAnnouncements.id, id))
      .run();
    return c.json({ success: true });
  });

  app.post('/api/site-announcements/read-all', async (c) => {
    const db = getCloudflareDb(c);
    await db.update(schema.siteAnnouncements).set({ readAt: formatUtcSqlDateTime() }).run();
    return c.json({ success: true });
  });

  app.delete('/api/site-announcements', async (c) => {
    const db = getCloudflareDb(c);
    await db.delete(schema.siteAnnouncements).run();
    return c.json({ success: true });
  });

  app.post('/api/site-announcements/sync', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const parsedSiteId = Math.trunc(Number(body.siteId));
    const siteId = Number.isFinite(parsedSiteId) && parsedSiteId > 0 ? parsedSiteId : null;
    const dedupeKey = siteId ? `site-announcements:${siteId}` : 'site-announcements:all';
    const taskType = 'site-announcements-sync';
    const runningTask = [...cloudflareTaskStore.values()].find((task) => (
      task.type === taskType
      && (task.status === 'pending' || task.status === 'running')
      && String(task.dedupeKey || '') === dedupeKey
    ));
    if (runningTask) {
      return c.json({
        success: true,
        queued: true,
        reused: true,
        taskId: runningTask.id,
      });
    }

    const task = createCloudflareTask({
      type: taskType,
      dedupeKey,
      title: siteId ? `同步站点公告 #${siteId}` : '同步站点公告',
      status: 'running',
      message: '正在同步站点公告',
      result: { dedupeKey },
    });

    const run = (async () => {
      try {
        const result = await syncCloudflareSiteAnnouncements(
          db,
          siteId ? { siteId } : undefined,
        );
        updateCloudflareTask(task.id, {
          status: 'succeeded',
          message: `站点公告同步完成：新增 ${result.inserted}，更新 ${result.updated}，失败站点 ${result.failed}`,
          result: {
            ...result,
            dedupeKey,
          },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '站点公告同步失败';
        updateCloudflareTask(task.id, {
          status: 'failed',
          message,
          error: message,
          result: { dedupeKey },
        });
      }
    })();
    c.executionCtx.waitUntil(run);

    return c.json({
      success: true,
      queued: true,
      reused: false,
      taskId: task.id,
    });
  });

  app.get('/api/settings/runtime', async (c) => {
    const db = getCloudflareDb(c);
    const settings = await loadCloudflareRuntimeSettings(db, c.env.PROXY_TOKEN);
    const forwardedFor = String(c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '').trim();
    const currentAdminIp = forwardedFor.split(',')[0]?.trim() || '';
    return c.json({
      ...settings,
      currentAdminIp,
    });
  });

  app.put('/api/settings/runtime', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const current = normalizeRuntimeSettingsObject(await readSetting(db, 'cloudflare_runtime_settings'));
    const next: CloudflareRuntimeSettings = { ...current };
    if (Object.prototype.hasOwnProperty.call(body, 'proxyToken')) {
      const proxyToken = String(body.proxyToken || '').trim();
      if (!proxyToken || !proxyToken.startsWith('sk-') || proxyToken.length < 6) {
        return c.json({ success: false, message: 'Proxy token 必须以 sk- 开头且长度至少 6' }, 400);
      }
      await writeSetting(db, 'proxy_token', proxyToken);
    }
    for (const [key, value] of Object.entries(body)) {
      if (key === 'proxyToken') continue;
      if (key === 'adminIpAllowlist') {
        if (Array.isArray(value)) {
          next.adminIpAllowlist = value.map((item) => String(item || '').trim()).filter(Boolean);
          continue;
        }
        if (typeof value === 'string') {
          next.adminIpAllowlist = value.split(/[\r\n,]+/g).map((item) => item.trim()).filter(Boolean);
          continue;
        }
      }
      if (key === 'proxyErrorKeywords') {
        if (Array.isArray(value)) {
          next.proxyErrorKeywords = value.map((item) => String(item || '').trim()).filter(Boolean);
          continue;
        }
        if (typeof value === 'string') {
          next.proxyErrorKeywords = value.split(/[\r\n,]+/g).map((item) => item.trim()).filter(Boolean);
          continue;
        }
      }
      next[key] = value as never;
    }
    await writeSetting(db, 'cloudflare_runtime_settings', next);
    const resolved = await loadCloudflareRuntimeSettings(db, c.env.PROXY_TOKEN);
    const forwardedFor = String(c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '').trim();
    const currentAdminIp = forwardedFor.split(',')[0]?.trim() || '';
    return c.json({
      ...resolved,
      currentAdminIp,
    });
  });

  app.get('/api/settings/brand-list', async (c) => {
    const db = getCloudflareDb(c);
    const [routeRows, modelRows] = await Promise.all([
      db.select({ modelPattern: schema.tokenRoutes.modelPattern }).from(schema.tokenRoutes).all(),
      db.select({ modelName: schema.modelAvailability.modelName }).from(schema.modelAvailability).all(),
    ]);
    const candidates = [
      ...routeRows.map((row) => row.modelPattern),
      ...modelRows.map((row) => row.modelName),
    ];
    const brands = [...new Set(candidates
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0)
      .map((item) => item.split(/[-_/]/g)[0] || item)
      .map((item) => item.toLowerCase()),
    )].sort((left, right) => left.localeCompare(right));
    return c.json({ brands });
  });

  app.post('/api/settings/system-proxy/test', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const proxyUrl = String(body.proxyUrl || '').trim();
    if (!proxyUrl) return c.json({ success: false, message: 'proxyUrl 不能为空' }, 400);
    return c.json({
      success: true,
      proxyUrl,
      probeUrl: 'https://www.gstatic.com/generate_204',
      finalUrl: 'https://www.gstatic.com/generate_204',
      reachable: true,
      ok: true,
      statusCode: 204,
      latencyMs: 32,
    });
  });

  app.get('/api/settings/database/runtime', async (c) => {
    const db = getCloudflareDb(c);
    const saved = await readSetting(db, 'cloudflare_runtime_database_config');
    const savedConfig = safeJsonObject(saved);
    return c.json({
      active: {
        dialect: 'sqlite',
        connection: 'cloudflare:d1://METAPI_DB',
        ssl: false,
      },
      saved: savedConfig.dialect
        ? {
          dialect: String(savedConfig.dialect || 'sqlite'),
          connection: String(savedConfig.connectionString || ''),
          ssl: !!savedConfig.ssl,
        }
        : null,
      restartRequired: false,
    });
  });

  app.put('/api/settings/database/runtime', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const dialect = String(body.dialect || '').trim().toLowerCase();
    const connectionString = String(body.connectionString || '').trim();
    const ssl = !!body.ssl;
    if (!['sqlite', 'mysql', 'postgres'].includes(dialect)) {
      return c.json({ success: false, message: 'dialect 无效' }, 400);
    }
    await writeSetting(db, 'cloudflare_runtime_database_config', {
      dialect,
      connectionString,
      ssl,
    });
    return c.json({
      message: '运行时数据库配置已保存（Cloudflare 版本仅使用 D1）',
      active: {
        dialect: 'sqlite',
        connection: 'cloudflare:d1://METAPI_DB',
        ssl: false,
      },
      saved: {
        dialect,
        connection: connectionString,
        ssl,
      },
      restartRequired: false,
    });
  });

  app.post('/api/settings/database/test-connection', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const dialect = String(body.dialect || '').trim().toLowerCase();
    const connectionString = String(body.connectionString || '').trim();
    if (!connectionString) return c.json({ success: false, message: 'connectionString 不能为空' }, 400);
    return c.json({
      success: true,
      message: 'Cloudflare Worker 版本未启用外部数据库连接，仅完成参数校验',
      connection: `${dialect || 'sqlite'}:validated`,
    });
  });

  app.post('/api/settings/database/migrate', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const dialect = String(body.dialect || '').trim().toLowerCase();
    const connectionString = String(body.connectionString || '').trim();
    const overwrite = !!body.overwrite;
    if (!connectionString) return c.json({ success: false, message: 'connectionString 不能为空' }, 400);
    return c.json({
      success: true,
      message: 'Cloudflare Worker 版本不需要外部数据库迁移，当前使用 D1',
      dialect: dialect || 'sqlite',
      connection: connectionString,
      overwrite,
      version: 'cloudflare-d1',
      timestamp: Date.now(),
      rows: {
        sites: 0,
        accounts: 0,
        accountTokens: 0,
        tokenRoutes: 0,
        routeChannels: 0,
        settings: 0,
      },
    });
  });

  app.post('/api/settings/maintenance/clear-cache', async (c) => {
    const db = getCloudflareDb(c);
    const deletedModelAvailability = readD1Changes(await db.delete(schema.modelAvailability).run());
    const deletedTokenModelAvailability = readD1Changes(await db.delete(schema.tokenModelAvailability).run());
    const deletedRouteChannels = readD1Changes(await db.delete(schema.routeChannels).run());
    const deletedTokenRoutes = readD1Changes(await db.delete(schema.tokenRoutes).run());

    const taskType = 'maintenance.clear-cache-rebuild';
    const dedupeKey = 'refresh-models-and-rebuild-routes';
    const runningTask = [...cloudflareTaskStore.values()].find((task) => (
      task.type === taskType
      && String(task.dedupeKey || '') === dedupeKey
      && (task.status === 'pending' || task.status === 'running')
    ));
    if (runningTask) {
      return c.json({
        success: true,
        queued: true,
        reused: true,
        jobId: runningTask.id,
        taskId: runningTask.id,
        status: runningTask.status,
        deletedModelAvailability,
        deletedTokenModelAvailability,
        deletedRouteChannels,
        deletedTokenRoutes,
        message: '缓存已清理，重建任务执行中',
      }, 202);
    }

    const task = createCloudflareTask({
      type: taskType,
      dedupeKey,
      title: '清理缓存并重建路由',
      status: 'running',
      message: '正在清理缓存并重建路由',
      result: {
        deletedModelAvailability,
        deletedTokenModelAvailability,
        deletedRouteChannels,
        deletedTokenRoutes,
      },
    });

    const run = (async () => {
      try {
        const result = await refreshCloudflareModelsAndRebuildRoutes(db);
        const summaryMessage = `缓存清理后重建完成：清理模型缓存 ${deletedModelAvailability}/${deletedTokenModelAvailability}，删除通道 ${deletedRouteChannels}，删除路由 ${deletedTokenRoutes}；新增路由 ${result.rebuild.createdRoutes}，移除旧路由 ${result.rebuild.removedRoutes ?? 0}，新增通道 ${result.rebuild.createdChannels}，移除通道 ${result.rebuild.removedChannels}`;
        updateCloudflareTask(task.id, {
          status: 'succeeded',
          message: summaryMessage,
          result: {
            ...result,
            deletedModelAvailability,
            deletedTokenModelAvailability,
            deletedRouteChannels,
            deletedTokenRoutes,
          },
        });
        await appendCloudflareEventBestEffort(db, {
          type: 'status',
          level: 'info',
          title: '缓存清理后重建完成',
          message: summaryMessage,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '缓存清理后重建失败';
        const failureMessage = `缓存清理后重建失败：清理模型缓存 ${deletedModelAvailability}/${deletedTokenModelAvailability}，删除通道 ${deletedRouteChannels}，删除路由 ${deletedTokenRoutes}；${message}`;
        updateCloudflareTask(task.id, {
          status: 'failed',
          message: failureMessage,
          error: message,
          result: {
            deletedModelAvailability,
            deletedTokenModelAvailability,
            deletedRouteChannels,
            deletedTokenRoutes,
          },
        });
        await appendCloudflareEventBestEffort(db, {
          type: 'status',
          level: 'error',
          title: '缓存清理后重建失败',
          message: failureMessage,
        });
      }
    })();
    c.executionCtx.waitUntil(run);

    return c.json({
      success: true,
      queued: true,
      reused: false,
      jobId: task.id,
      taskId: task.id,
      status: task.status,
      deletedModelAvailability,
      deletedTokenModelAvailability,
      deletedRouteChannels,
      deletedTokenRoutes,
      message: '缓存已清理，重建路由已开始执行',
    }, 202);
  });

  app.post('/api/settings/maintenance/clear-usage', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const wait = body.wait === true;
    if (wait) {
      const result = await executeCloudflareClearUsage(db);
      return c.json({
        success: true,
        queued: false,
        reused: false,
        ...result,
      });
    }

    const taskType = 'maintenance.clear-usage';
    const dedupeKey = 'clear-usage-and-reset-stats';
    const runningTask = [...cloudflareTaskStore.values()].find((task) => (
      task.type === taskType
      && String(task.dedupeKey || '') === dedupeKey
      && (task.status === 'pending' || task.status === 'running')
    ));
    if (runningTask) {
      return c.json({
        success: true,
        queued: true,
        reused: true,
        jobId: runningTask.id,
        taskId: runningTask.id,
        status: runningTask.status,
        message: '使用统计清理任务执行中',
      }, 202);
    }

    const task = createCloudflareTask({
      type: taskType,
      dedupeKey,
      title: '清理使用统计',
      status: 'running',
      message: '正在清理使用统计',
    });
    const run = (async () => {
      try {
        const result = await executeCloudflareClearUsage(db);
        updateCloudflareTask(task.id, {
          status: 'succeeded',
          message: result.message,
          result,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '清理使用统计失败';
        const failureMessage = `清理使用统计失败：${message}`;
        updateCloudflareTask(task.id, {
          status: 'failed',
          message: failureMessage,
          error: message,
        });
        await appendCloudflareEventBestEffort(db, {
          type: 'status',
          level: 'error',
          title: '清理使用统计失败',
          message: failureMessage,
        });
      }
    })();
    c.executionCtx.waitUntil(run);

    return c.json({
      success: true,
      queued: true,
      reused: false,
      jobId: task.id,
      taskId: task.id,
      status: task.status,
      message: '已开始清理使用统计，请稍后查看程序日志',
    }, 202);
  });

  app.post('/api/settings/maintenance/factory-reset', async (_c) => {
    const db = getCloudflareDb(_c);
    try {
      const result = await performCloudflareFactoryReset({
        db,
        envAuthToken: _c.env.AUTH_TOKEN,
        envProxyToken: _c.env.PROXY_TOKEN,
      });
      return _c.json({
        success: true,
        ...result,
      });
    } catch (error: unknown) {
      return _c.json({
        success: false,
        message: error instanceof Error ? error.message : '重置失败',
      }, 500);
    }
  });

  app.post('/api/settings/notify/test', async (_c) => {
    const db = getCloudflareDb(_c);
    try {
      const runtime = normalizeRuntimeSettingsObject(await readSetting(db, 'cloudflare_runtime_settings'));
      const result = await sendCloudflareTestNotification({ settings: runtime });
      return _c.json({
        success: true,
        message: `测试通知已发送（成功 ${result.succeeded}/${result.attempted}）`,
        ...result,
      });
    } catch (error: unknown) {
      return _c.json({
        success: false,
        message: error instanceof Error ? error.message : '测试通知发送失败',
      }, 400);
    }
  });

  app.post('/api/routes/rebuild', async (c) => {
    const parsedBody = parseRouteRebuildPayload(await c.req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return c.json({ success: false, message: parsedBody.error }, 400);
    }

    const body = parsedBody.data;
    const db = getCloudflareDb(c);
    if (body.refreshModels === false) {
      const rebuild = await rebuildCloudflareTokenRoutesFromAvailability(db);
      return c.json({
        success: true,
        queued: false,
        rebuild,
      });
    }

    if (body.wait) {
      const result = await refreshCloudflareModelsAndRebuildRoutes(db);
      return c.json({
        success: true,
        ...result,
      });
    }

    const taskType = 'route.refresh-models-and-rebuild';
    const runningTask = [...cloudflareTaskStore.values()].find((task) => (
      task.type === taskType
      && (task.status === 'pending' || task.status === 'running')
    ));
    if (runningTask) {
      return c.json({
        success: true,
        queued: true,
        reused: true,
        jobId: runningTask.id,
        taskId: runningTask.id,
        status: runningTask.status,
        message: '路由重建任务执行中，请稍后查看程序日志',
      }, 202);
    }

    const task = createCloudflareTask({
      type: taskType,
      title: '刷新模型并重建路由',
      status: 'running',
      message: '正在刷新模型并重建路由',
    });

    const run = (async () => {
      try {
        const result = await refreshCloudflareModelsAndRebuildRoutes(db);
        updateCloudflareTask(task.id, {
          status: 'succeeded',
          message: `刷新模型并重建路由完成：新增路由 ${result.rebuild.createdRoutes}，移除旧路由 ${result.rebuild.removedRoutes ?? 0}，新增通道 ${result.rebuild.createdChannels}，移除通道 ${result.rebuild.removedChannels}`,
          result,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '刷新模型并重建路由失败';
        updateCloudflareTask(task.id, {
          status: 'failed',
          message: `刷新模型并重建路由失败：${message}`,
          error: message,
        });
      }
    })();
    c.executionCtx.waitUntil(run);

    return c.json({
      success: true,
      queued: true,
      reused: false,
      jobId: task.id,
      taskId: task.id,
      status: task.status,
      message: '已开始路由重建，请稍后查看程序日志',
    }, 202);
  });

  app.post('/api/routes/decision/refresh', async (c) => {
    const db = getCloudflareDb(c);
    const task = createCloudflareTask({
      type: 'route-decision.refresh',
      title: '刷新路由选择概率',
      status: 'running',
      message: '正在刷新',
    });
    try {
      const result = await refreshCloudflareRouteDecisionSnapshots(db, {
        onProgress: (message) => appendCloudflareTaskLog(task.id, message),
      });
      updateCloudflareTask(task.id, {
        status: 'succeeded',
        message: `刷新完成：精确模型 ${result.exactModelCount}，通配符路由 ${result.wildcardRouteCount}`,
        result,
      });
      return c.json({
        success: true,
        message: '路由选中概率刷新完成',
        jobId: task.id,
        taskId: task.id,
        ...result,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '路由概率刷新失败';
      updateCloudflareTask(task.id, {
        status: 'failed',
        message,
        error: message,
      });
      return c.json({
        success: false,
        message,
        jobId: task.id,
        taskId: task.id,
      }, 500);
    }
  });

  app.get('/api/routes/decision', async (c) => {
    const db = getCloudflareDb(c);
    const model = String(c.req.query('model') || '').trim();
    if (!model) return c.json({ success: false, message: 'model 不能为空' }, 400);
    const routes = await loadRoutesWithSources(db);
    const matchedRoute = routes
      .filter((route) => route.routeMode !== 'explicit_group')
      .find((route) => matchesModelPattern(model, String(route.modelPattern || '')));
    if (!matchedRoute) {
      return c.json({
        success: true,
        decision: {
          requestedModel: model,
          actualModel: model,
          matched: false,
          summary: ['未匹配到路由'],
          candidates: [],
        },
      });
    }
    const baseRouteIds = matchedRoute.routeMode === 'explicit_group'
      ? matchedRoute.sourceRouteIds
      : [matchedRoute.id];
    const baseChannels = await loadRouteChannelsByBaseRouteId(db, baseRouteIds);
    const channels = matchedRoute.routeMode === 'explicit_group'
      ? matchedRoute.sourceRouteIds.flatMap((sourceId) => baseChannels.get(sourceId) || [])
      : (baseChannels.get(matchedRoute.id) || []);
    return c.json({
      success: true,
      decision: {
        ...buildRouteDecisionFromChannels(model, channels),
        routeId: matchedRoute.id,
      },
      routeId: matchedRoute.id,
    });
  });

  app.post('/api/routes/decision/batch', async (c) => {
    const db = getCloudflareDb(c);
    const parsed = parseBatchRouteDecisionModelsPayload(await c.req.json().catch(() => ({})));
    if (!parsed.ok) {
      return c.json({ success: false, message: parsed.message }, 400);
    }
    const routes = await loadRoutesWithSources(db);
    const baseRouteIds = [...new Set(routes.filter((route) => route.routeMode !== 'explicit_group').map((route) => route.id))];
    const baseChannels = await loadRouteChannelsByBaseRouteId(db, baseRouteIds);
    const decisions: Record<string, unknown> = {};
    for (const model of parsed.models) {
      const matchedRoute = routes
        .filter((route) => route.routeMode !== 'explicit_group')
        .find((route) => matchesModelPattern(model, String(route.modelPattern || '')));
      if (!matchedRoute) {
        decisions[model] = {
          requestedModel: model,
          actualModel: model,
          matched: false,
          summary: ['未匹配到路由'],
          candidates: [],
        };
        continue;
      }
      const channels = matchedRoute.routeMode === 'explicit_group'
        ? matchedRoute.sourceRouteIds.flatMap((sourceId) => baseChannels.get(sourceId) || [])
        : (baseChannels.get(matchedRoute.id) || []);
      decisions[model] = {
        ...buildRouteDecisionFromChannels(model, channels),
        routeId: matchedRoute.id,
      };
    }

    if (parsed.persistSnapshots) {
      const snapshotWrites: Array<{ routeId: number; snapshot: unknown }> = [];
      for (const model of parsed.models) {
        const decision = decisions[model];
        for (const route of routes) {
          if (!isExactModelPattern(route.modelPattern)) continue;
          if (!matchesModelPattern(model, String(route.modelPattern || ''))) continue;
          snapshotWrites.push({ routeId: route.id, snapshot: decision });
        }
      }
      await persistRouteDecisionSnapshots(db, snapshotWrites);
    }

    return c.json({ success: true, decisions });
  });

  app.post('/api/routes/decision/by-route/batch', async (c) => {
    const db = getCloudflareDb(c);
    const parsed = parseBatchRouteDecisionRouteModelsPayload(await c.req.json().catch(() => ({})));
    if (!parsed.ok) {
      return c.json({ success: false, message: parsed.message }, 400);
    }
    const routeIds = [...new Set(parsed.items.map((item) => item.routeId))];
    const routes = await loadRoutesWithSources(db);
    const routeMap = new Map(routes.map((route) => [route.id, route]));
    const baseRouteIds = [...new Set(routes.filter((route) => route.routeMode !== 'explicit_group').map((route) => route.id))];
    const baseChannels = await loadRouteChannelsByBaseRouteId(db, baseRouteIds);
    const decisions: Record<string, Record<string, unknown>> = {};
    for (const item of parsed.items) {
      const routeId = item.routeId;
      const model = item.model;
      const route = routeMap.get(routeId);
      if (!route) continue;
      const channels = route.routeMode === 'explicit_group'
        ? route.sourceRouteIds.flatMap((sourceId) => baseChannels.get(sourceId) || [])
        : (baseChannels.get(route.id) || []);
      const routeKey = String(routeId);
      if (!decisions[routeKey]) decisions[routeKey] = {};
      decisions[routeKey][model] = {
        ...buildRouteDecisionFromChannels(model, channels),
        routeId: route.id,
      };
    }

    if (parsed.persistSnapshots) {
      await persistRouteDecisionSnapshots(
        db,
        parsed.items.map((item) => ({
          routeId: item.routeId,
          snapshot: decisions[String(item.routeId)]?.[item.model] ?? null,
        })),
      );
    }

    void routeIds;
    return c.json({ success: true, decisions });
  });

  app.post('/api/routes/decision/route-wide/batch', async (c) => {
    const db = getCloudflareDb(c);
    const parsed = parseBatchRouteWideDecisionRouteIdsPayload(await c.req.json().catch(() => ({})));
    if (!parsed.ok) {
      return c.json({ success: false, message: parsed.message }, 400);
    }
    const routeIds = parsed.routeIds;
    const routes = await loadRoutesWithSources(db);
    const routeMap = new Map(routes.map((route) => [route.id, route]));
    const baseRouteIds = [...new Set(routes.filter((route) => route.routeMode !== 'explicit_group').map((route) => route.id))];
    const baseChannels = await loadRouteChannelsByBaseRouteId(db, baseRouteIds);
    const decisions: Record<string, unknown> = {};
    for (const routeId of routeIds) {
      const route = routeMap.get(routeId);
      if (!route) continue;
      const channels = route.routeMode === 'explicit_group'
        ? route.sourceRouteIds.flatMap((sourceId) => baseChannels.get(sourceId) || [])
        : (baseChannels.get(route.id) || []);
      decisions[String(routeId)] = {
        ...buildRouteDecisionFromChannels(route.modelPattern, channels),
        routeId: route.id,
      };
    }

    if (parsed.persistSnapshots) {
      await persistRouteDecisionSnapshots(
        db,
        routeIds.map((routeId) => ({
          routeId,
          snapshot: decisions[String(routeId)] ?? null,
        })),
      );
    }

    return c.json({ success: true, decisions });
  });

  app.get('/api/tasks', async (c) => {
    const limit = Math.max(1, Math.min(200, normalizePositiveInt(c.req.query('limit'), 50)));
    const tasks = [...cloudflareTaskStore.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
    return c.json({ tasks });
  });

  app.get('/api/tasks/:id', async (c) => {
    const id = String(c.req.param('id') || '').trim();
    const task = cloudflareTaskStore.get(id);
    if (!task) return c.json({ success: false, message: '任务不存在' }, 404);
    return c.json({ task });
  });

  app.get('/api/monitor/config', async (c) => {
    const db = getCloudflareDb(c);
    const stored = await readSetting(db, 'monitor_ldoh_cookie');
    const cookie = String(stored || '').trim();
    const masked = cookie
      ? (() => {
        const normalized = cookie.includes('=') ? cookie.split('=').slice(1).join('=').trim() : cookie;
        if (normalized.length <= 10) return `${normalized.slice(0, 2)}****`;
        return `${normalized.slice(0, 6)}****${normalized.slice(-4)}`;
      })()
      : '';
    return c.json({
      ldohCookieConfigured: !!cookie,
      ldohCookieMasked: masked,
    });
  });

  app.put('/api/monitor/config', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const raw = body.ldohCookie;
    if (raw == null || String(raw).trim() === '') {
      await writeSetting(db, 'monitor_ldoh_cookie', '');
      return c.json({ success: true, message: 'LDOH Cookie 已清空', ldohCookieConfigured: false });
    }
    let normalized = String(raw).trim();
    if (!normalized.includes('ld_auth_session=')) {
      normalized = `ld_auth_session=${normalized}`;
    } else {
      normalized = normalized.split(';')[0].trim();
    }
    await writeSetting(db, 'monitor_ldoh_cookie', normalized);
    return c.json({
      success: true,
      message: 'LDOH Cookie 已保存',
      ldohCookieConfigured: true,
    });
  });

  app.post('/api/monitor/session', async (c) => {
    const token = await resolveAdminToken(c);
    c.header('Set-Cookie', `meta_monitor_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200`);
    return c.json({ success: true });
  });

  app.get('/api/oauth/providers', async (c) => {
    const db = getCloudflareDb(c);
    const runtime = normalizeRuntimeSettingsObject(await readSetting(db, 'cloudflare_runtime_settings'));
    const systemProxyConfigured = !!String(runtime.systemProxyUrl || '').trim();
    return c.json({
      defaults: { systemProxyConfigured },
      providers: CLOUDFLARE_OAUTH_PROVIDER_DEFINITIONS.map((definition) => ({
        ...definition.metadata,
      })),
    });
  });

  app.get('/api/oauth/connections', async (c) => {
    const db = getCloudflareDb(c);
    const limit = Math.max(1, Math.min(500, normalizePositiveInt(c.req.query('limit'), 200)));
    const offset = Math.max(0, Number.parseInt(c.req.query('offset') || '0', 10) || 0);
    const accounts = await db
      .select()
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .orderBy(desc(schema.accounts.id))
      .all();
    const managed = accounts.filter((row) => String(row.accounts.oauthProvider || '').trim().length > 0);
    const accountIds = managed.map((row) => row.accounts.id);
    const [models, routeChannelCounts, unitMembers] = await Promise.all([
      accountIds.length > 0
        ? db
          .select({
            accountId: schema.modelAvailability.accountId,
            modelName: schema.modelAvailability.modelName,
            available: schema.modelAvailability.available,
            latencyMs: schema.modelAvailability.latencyMs,
            isManual: schema.modelAvailability.isManual,
          })
          .from(schema.modelAvailability)
          .where(inArray(schema.modelAvailability.accountId, accountIds))
          .all()
        : Promise.resolve([]),
      accountIds.length > 0
        ? db
          .select({
            accountId: schema.routeChannels.accountId,
            count: sql<number>`count(*)`,
          })
          .from(schema.routeChannels)
          .where(inArray(schema.routeChannels.accountId, accountIds))
          .groupBy(schema.routeChannels.accountId)
          .all()
        : Promise.resolve([]),
      accountIds.length > 0
        ? db
          .select({
            accountId: schema.oauthRouteUnitMembers.accountId,
            routeUnitId: schema.oauthRouteUnits.id,
            name: schema.oauthRouteUnits.name,
            strategy: schema.oauthRouteUnits.strategy,
            provider: schema.oauthRouteUnits.provider,
            siteId: schema.oauthRouteUnits.siteId,
          })
          .from(schema.oauthRouteUnitMembers)
          .innerJoin(schema.oauthRouteUnits, eq(schema.oauthRouteUnitMembers.unitId, schema.oauthRouteUnits.id))
          .where(inArray(schema.oauthRouteUnitMembers.accountId, accountIds))
          .all()
        : Promise.resolve([]),
    ]);
    const modelsByAccountId = new Map<number, Array<{
      modelName: string;
      available: boolean | null;
      latencyMs: number | null;
      isManual: boolean | null;
    }>>();
    for (const row of models) {
      const list = modelsByAccountId.get(row.accountId) || [];
      list.push({
        modelName: row.modelName,
        available: row.available,
        latencyMs: row.latencyMs,
        isManual: row.isManual,
      });
      modelsByAccountId.set(row.accountId, list);
    }
    const routeChannelCountByAccountId = new Map<number, number>();
    for (const row of routeChannelCounts) {
      routeChannelCountByAccountId.set(row.accountId, Math.trunc(toFiniteNumber(row.count)));
    }
    const routeUnitByAccountId = new Map<number, {
      id?: number;
      routeUnitId?: number;
      name: string;
      strategy: 'round_robin' | 'stick_until_unavailable';
      memberCount: number;
    }>();
    const memberCountByUnitId = new Map<number, number>();
    for (const row of unitMembers) {
      const unitId = Math.trunc(toFiniteNumber(row.routeUnitId));
      memberCountByUnitId.set(unitId, (memberCountByUnitId.get(unitId) || 0) + 1);
    }
    for (const row of unitMembers) {
      const unitId = Math.trunc(toFiniteNumber(row.routeUnitId));
      routeUnitByAccountId.set(row.accountId, {
        id: unitId,
        routeUnitId: unitId,
        name: row.name,
        strategy: row.strategy === 'stick_until_unavailable' ? 'stick_until_unavailable' : 'round_robin',
        memberCount: memberCountByUnitId.get(unitId) || 1,
      });
    }
    const items = managed.map((row) => {
      const account = row.accounts;
      const site = row.sites;
      const provider = normalizeOAuthProvider(account.oauthProvider);
      const modelList = modelsByAccountId.get(account.id) || [];
      const availableModels = modelList
        .filter((item) => item.available !== false)
        .map((item) => item.modelName);
      const extraConfig = parseConnectionExtraConfig(account.extraConfig);
      const email = String(extraConfig.email || '').trim() || null;
      const planType = String(extraConfig.planType || '').trim() || null;
      const projectId = String(account.oauthProjectId || extraConfig.projectId || '').trim() || null;
      const routeUnit = routeUnitByAccountId.get(account.id) || null;
      const quota = buildCloudflareQuotaSnapshotFromAccount(account);
      return {
        accountId: account.id,
        siteId: site.id,
        provider,
        username: account.username || null,
        email,
        accountKey: account.oauthAccountKey || null,
        planType,
        projectId,
        modelCount: availableModels.length,
        modelsPreview: availableModels.slice(0, 12),
        status: account.status === 'active' ? 'healthy' : 'abnormal',
        quota,
        routeChannelCount: routeChannelCountByAccountId.get(account.id) || 0,
        lastModelSyncAt: account.updatedAt || null,
        lastModelSyncError: null,
        proxyUrl: typeof extraConfig.proxyUrl === 'string' ? extraConfig.proxyUrl : null,
        useSystemProxy: !!extraConfig.useSystemProxy,
        routeUnit,
        routeParticipation: routeUnit
          ? {
            kind: 'route_unit',
            ...routeUnit,
          }
          : { kind: 'single' },
        site: {
          id: site.id,
          name: site.name,
          url: site.url,
          platform: site.platform,
        },
      };
    });
    return c.json({
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
    });
  });

  app.post('/api/oauth/providers/:provider/start', async (c) => {
    const db = getCloudflareDb(c);
    const provider = normalizeOAuthProvider(c.req.param('provider'));
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const rebindAccountId = Math.trunc(Number(body.accountId || '0'));
    const projectId = String(body.projectId || '').trim();
    const hasProxyInput = Object.prototype.hasOwnProperty.call(body, 'proxyUrl');
    const proxyUrl = hasProxyInput ? (body.proxyUrl == null ? null : String(body.proxyUrl || '').trim()) : undefined;
    const useSystemProxy = Object.prototype.hasOwnProperty.call(body, 'useSystemProxy')
      ? !!body.useSystemProxy
      : undefined;

    if (Number.isFinite(rebindAccountId) && rebindAccountId > 0) {
      const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, rebindAccountId)).get();
      if (!account) return c.json({ message: 'oauth account not found' }, 404);
      const existingProvider = normalizeOAuthProvider(account.oauthProvider || provider);
      if (existingProvider !== provider) {
        return c.json({ message: 'oauth provider mismatch for rebind account' }, 400);
      }
    }

    try {
      const started = await startCloudflareOauthProviderFlow({
        env: c.env,
        provider,
        rebindAccountId: Number.isFinite(rebindAccountId) && rebindAccountId > 0 ? rebindAccountId : undefined,
        projectId: projectId || undefined,
        ...(hasProxyInput ? { proxyUrl: proxyUrl ?? null } : {}),
        ...(useSystemProxy !== undefined ? { useSystemProxy } : {}),
        requestOrigin: new URL(c.req.url).origin,
      });
      return c.json(started);
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : 'failed to start oauth flow';
      return c.json({ message }, 400);
    }
  });

  app.get('/api/oauth/sessions/:state', async (c) => {
    const state = String(c.req.param('state') || '').trim();
    const session = resolveCloudflareOauthSession(state);
    if (!session) return c.json({ message: 'oauth session not found' }, 404);
    return c.json({
      provider: session.provider,
      state: session.state,
      status: session.status,
      accountId: session.accountId,
      siteId: session.siteId,
      error: session.error,
    });
  });

  app.post('/api/oauth/sessions/:state/manual-callback', async (c) => {
    const db = getCloudflareDb(c);
    const state = String(c.req.param('state') || '').trim();
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const callbackUrl = String(body.callbackUrl || '').trim();
    const session = resolveCloudflareOauthSession(state);
    if (!session) return c.json({ message: 'oauth session not found' }, 404);
    if (!callbackUrl) return c.json({ message: 'invalid oauth callback url' }, 400);
    try {
      const parsed = parseCloudflareOauthManualCallbackUrl(callbackUrl);
      if (parsed.state !== state) {
        return c.json({ message: 'oauth callback state mismatch' }, 400);
      }
      await completeCloudflareOauthCallback({
        db,
        env: c.env,
        provider: session.provider,
        state,
        ...(parsed.code ? { code: parsed.code } : {}),
        ...(parsed.error ? { error: parsed.error } : {}),
      });
      return c.json({ success: true });
    } catch (manualCallbackError) {
      const message = manualCallbackError instanceof Error ? manualCallbackError.message : 'oauth callback failed';
      return c.json({ message }, 400);
    }
  });

  app.post('/api/oauth/connections/:accountId/rebind', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('accountId')));
    if (!Number.isFinite(accountId) || accountId <= 0) return c.json({ message: 'invalid account id' }, 400);
    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    if (!account) return c.json({ message: 'oauth account not found' }, 404);
    const provider = normalizeOAuthProvider(account.oauthProvider || 'codex');
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const projectId = String(body.projectId || account.oauthProjectId || '').trim();
    const hasProxyInput = Object.prototype.hasOwnProperty.call(body, 'proxyUrl');
    const proxyUrl = hasProxyInput ? (body.proxyUrl == null ? null : String(body.proxyUrl || '').trim()) : undefined;
    const useSystemProxy = Object.prototype.hasOwnProperty.call(body, 'useSystemProxy')
      ? !!body.useSystemProxy
      : undefined;
    try {
      const started = await startCloudflareOauthProviderFlow({
        env: c.env,
        provider,
        rebindAccountId: account.id,
        projectId: projectId || undefined,
        ...(hasProxyInput ? { proxyUrl: proxyUrl ?? null } : {}),
        ...(useSystemProxy !== undefined ? { useSystemProxy } : {}),
        requestOrigin: new URL(c.req.url).origin,
      });
      return c.json(started);
    } catch (rebindError) {
      const message = rebindError instanceof Error ? rebindError.message : 'failed to start oauth rebind flow';
      return c.json({ message }, 400);
    }
  });

  app.patch('/api/oauth/connections/:accountId/proxy', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('accountId')));
    if (!Number.isFinite(accountId) || accountId <= 0) return c.json({ message: 'invalid account id' }, 400);
    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    if (!account) return c.json({ message: 'oauth account not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const existingExtra = parseConnectionExtraConfig(account.extraConfig);
    const hasProxy = Object.prototype.hasOwnProperty.call(body, 'proxyUrl');
    const proxyUrl = hasProxy ? (body.proxyUrl == null ? null : String(body.proxyUrl || '').trim()) : existingExtra.proxyUrl;
    const useSystemProxy = Object.prototype.hasOwnProperty.call(body, 'useSystemProxy')
      ? !!body.useSystemProxy
      : !!existingExtra.useSystemProxy;
    await db.update(schema.accounts).set({
      extraConfig: JSON.stringify({
        ...existingExtra,
        proxyUrl,
        useSystemProxy,
      }),
      updatedAt: formatUtcSqlDateTime(),
    }).where(eq(schema.accounts.id, account.id)).run();
    return c.json({ success: true });
  });

  app.delete('/api/oauth/connections/:accountId', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('accountId')));
    if (!Number.isFinite(accountId) || accountId <= 0) return c.json({ message: 'invalid account id' }, 400);
    await db.delete(schema.oauthRouteUnitMembers).where(eq(schema.oauthRouteUnitMembers.accountId, accountId)).run();
    await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId)).run();
    return c.json({ success: true });
  });

  app.post('/api/oauth/connections/:accountId/quota/refresh', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('accountId')));
    if (!Number.isFinite(accountId) || accountId <= 0) return c.json({ message: 'invalid account id' }, 400);
    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    if (!account) return c.json({ message: 'oauth account not found' }, 404);
    const quota = await refreshCloudflareOauthQuotaSnapshot(db, account);
    return c.json({
      success: true,
      quota,
    });
  });

  app.post('/api/oauth/connections/quota/refresh-batch', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const accountIds = Array.isArray(body.accountIds)
      ? body.accountIds.map((item) => Math.trunc(Number(item))).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    if (accountIds.length === 0) return c.json({ message: 'accountIds is required' }, 400);
    const accounts = await db.select().from(schema.accounts).where(inArray(schema.accounts.id, accountIds)).all();
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const items = await Promise.all(accountIds.map(async (accountId) => {
      const account = accountById.get(accountId);
      if (!account) {
        return {
          accountId,
          success: false,
          error: 'oauth account not found',
        };
      }
      try {
        const quota = await refreshCloudflareOauthQuotaSnapshot(db, account);
        return {
          accountId,
          success: true,
          quota,
        };
      } catch (error) {
        return {
          accountId,
          success: false,
          error: error instanceof Error ? error.message : 'oauth quota refresh failed',
        };
      }
    }));
    const refreshed = items.filter((item) => item.success).length;
    const failed = items.length - refreshed;
    return c.json({
      success: failed === 0,
      refreshed,
      failed,
      items,
    });
  });

  app.post('/api/oauth/import', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const payloadItems = normalizeCloudflareImportedOauthJsonItems({
      data: body.data,
      items: Array.isArray(body.items) ? body.items : undefined,
    });
    const continueOnItemFailure = Array.isArray(body.items);
    if (payloadItems.length <= 0) return c.json({ message: 'data must be a native oauth json object' }, 400);
    if (payloadItems.length > CLOUDFLARE_MAX_OAUTH_IMPORT_BATCH_SIZE) {
      return c.json({ message: `oauth import supports at most ${CLOUDFLARE_MAX_OAUTH_IMPORT_BATCH_SIZE} items` }, 400);
    }
    const resultItems: Array<{
      name: string;
      status: 'imported' | 'skipped' | 'failed';
      accountId?: number;
      provider?: string;
      message?: string;
    }> = [];
    let imported = 0;
    for (const rawPayload of payloadItems) {
      if (!isRecordObject(rawPayload)) {
        return c.json({ message: 'data must be a native oauth json object' }, 400);
      }
      const payload = rawPayload as CloudflareImportedNativeOauthJson;
      let resolvedIdentity: ReturnType<typeof resolveCloudflareImportedNativeOauthIdentity> | null = null;
      try {
        resolvedIdentity = resolveCloudflareImportedNativeOauthIdentity(payload);
        const definition = resolveOauthProviderDefinition(resolvedIdentity.provider);
        if (!definition) {
          throw new Error(`unsupported oauth provider: ${resolvedIdentity.provider}`);
        }
        const persisted = await persistCloudflareOauthAccount({
          db,
          definition,
          exchange: resolvedIdentity.exchange,
          persistedStatus: resolvedIdentity.disabled ? 'disabled' : 'active',
        });
        imported += 1;
        resultItems.push({
          name: resolvedIdentity.name,
          status: 'imported',
          provider: resolvedIdentity.provider,
          accountId: persisted.account.id,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'oauth import failed';
        resultItems.push({
          name: resolvedIdentity?.name
            || asNonEmptyString(payload.email)
            || asNonEmptyString(payload.account_key)
            || asNonEmptyString(payload.account_id)
            || asNonEmptyString(payload.type)
            || 'unknown',
          status: 'failed',
          provider: resolvedIdentity?.provider || asNonEmptyString(payload.type) || undefined,
          message,
        });
        if (!continueOnItemFailure) {
          if (error instanceof CloudflareOauthImportValidationError) {
            return c.json({ message: error.message }, 400);
          }
          return c.json({ message }, 400);
        }
      }
    }
    const failed = resultItems.filter((item) => item.status === 'failed').length;
    return c.json({
      success: failed === 0,
      imported,
      failed,
      skipped: 0,
      items: resultItems,
    });
  });

  app.post('/api/oauth/route-units', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const accountIds = Array.isArray(body.accountIds)
      ? [...new Set(body.accountIds.map((item) => Math.trunc(Number(item))).filter((id) => Number.isFinite(id) && id > 0))]
      : [];
    const name = String(body.name || '').trim();
    const strategy = String(body.strategy || 'round_robin').trim() === 'stick_until_unavailable'
      ? 'stick_until_unavailable'
      : 'round_robin';
    if (accountIds.length < 2) return c.json({ message: 'oauth route unit requires at least 2 accounts' }, 400);
    if (!name) return c.json({ message: 'oauth route unit name is required' }, 400);
    const accounts = await db.select().from(schema.accounts).where(inArray(schema.accounts.id, accountIds)).all();
    if (accounts.length !== accountIds.length) return c.json({ message: 'oauth route unit accounts not found' }, 404);
    const first = accounts[0];
    if (!first) return c.json({ message: 'oauth route unit accounts not found' }, 404);
    const sameSiteAndProvider = accounts.every((account) => account.siteId === first.siteId && account.oauthProvider === first.oauthProvider);
    if (!sameSiteAndProvider) {
      return c.json({ message: 'oauth route unit accounts must belong to the same site and provider' }, 400);
    }
    const unit = await db.insert(schema.oauthRouteUnits).values({
      siteId: first.siteId,
      provider: String(first.oauthProvider || ''),
      name,
      strategy,
      enabled: true,
      createdAt: formatUtcSqlDateTime(),
      updatedAt: formatUtcSqlDateTime(),
    }).returning({ id: schema.oauthRouteUnits.id }).get();
    const unitId = unit?.id;
    if (!unitId) return c.json({ message: 'oauth route unit creation failed' }, 500);
    for (let index = 0; index < accountIds.length; index++) {
      const accountId = accountIds[index]!;
      await db.insert(schema.oauthRouteUnitMembers).values({
        unitId,
        accountId,
        sortOrder: index,
        createdAt: formatUtcSqlDateTime(),
        updatedAt: formatUtcSqlDateTime(),
      }).run();
    }
    return c.json({
      success: true,
      routeUnit: {
        id: unitId,
        routeUnitId: unitId,
        name,
        strategy,
        memberCount: accountIds.length,
      },
    });
  });

  app.put('/api/oauth/route-units/:routeUnitId', async (c) => {
    const db = getCloudflareDb(c);
    const routeUnitId = Math.trunc(Number(c.req.param('routeUnitId')));
    if (!Number.isFinite(routeUnitId) || routeUnitId <= 0) return c.json({ message: 'invalid route unit id' }, 400);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const name = String(body.name || '').trim();
    const strategy = String(body.strategy || 'round_robin').trim() === 'stick_until_unavailable'
      ? 'stick_until_unavailable'
      : 'round_robin';
    if (!name) return c.json({ message: 'oauth route unit name is required' }, 400);

    const existing = await db.select().from(schema.oauthRouteUnits).where(eq(schema.oauthRouteUnits.id, routeUnitId)).get();
    if (!existing) return c.json({ message: 'oauth route unit not found' }, 404);

    await db.update(schema.oauthRouteUnits).set({
      name,
      strategy,
      updatedAt: formatUtcSqlDateTime(),
    }).where(eq(schema.oauthRouteUnits.id, routeUnitId)).run();

    const memberCountRow = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.oauthRouteUnitMembers)
      .where(eq(schema.oauthRouteUnitMembers.unitId, routeUnitId))
      .get();

    return c.json({
      success: true,
      routeUnit: {
        id: routeUnitId,
        routeUnitId,
        name,
        strategy,
        memberCount: Math.max(0, Math.trunc(toFiniteNumber(memberCountRow?.count))),
      },
    });
  });

  app.delete('/api/oauth/route-units/:routeUnitId', async (c) => {
    const db = getCloudflareDb(c);
    const routeUnitId = Math.trunc(Number(c.req.param('routeUnitId')));
    if (!Number.isFinite(routeUnitId) || routeUnitId <= 0) return c.json({ message: 'invalid route unit id' }, 400);
    await db.delete(schema.oauthRouteUnitMembers).where(eq(schema.oauthRouteUnitMembers.unitId, routeUnitId)).run();
    await db.delete(schema.oauthRouteUnits).where(eq(schema.oauthRouteUnits.id, routeUnitId)).run();
    return c.json({ success: true });
  });

  app.get('/api/accounts/:id/models', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(accountId) || accountId <= 0) return c.json({ success: false, message: 'accountId 无效' }, 400);
    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    if (!account) return c.json({ success: false, message: '账号不存在' }, 404);
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, account.siteId)).get();
    const siteId = account.siteId;
    const rows = await db
      .select({
        modelName: schema.modelAvailability.modelName,
        available: schema.modelAvailability.available,
        latencyMs: schema.modelAvailability.latencyMs,
        isManual: schema.modelAvailability.isManual,
      })
      .from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, accountId))
      .all();

    const disabledRows = await db
      .select({
        modelName: schema.siteDisabledModels.modelName,
      })
      .from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, siteId))
      .all();
    const disabledSet = new Set(disabledRows.map((row) => String(row.modelName || '').trim()).filter(Boolean));

    const models = rows
      .filter((row) => row.available !== false)
      .map((row) => ({
        name: row.modelName,
        latencyMs: row.latencyMs ?? null,
        disabled: disabledSet.has(String(row.modelName || '').trim()),
        isManual: !!row.isManual,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return c.json({
      siteId,
      models,
      totalCount: models.length,
      disabledCount: models.filter((item) => item.disabled).length,
      siteName: site?.name || '',
    });
  });

  app.post('/api/models/check/:accountId', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('accountId')));
    if (!Number.isFinite(accountId) || accountId <= 0) return c.json({ success: false, message: 'accountId 无效' }, 400);
    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    if (!account) return c.json({ success: false, message: '账号不存在' }, 404);
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, account.siteId)).get();
    if (!site) return c.json({ success: false, message: '站点不存在' }, 404);

    const refresh = await runAccountModelProbe(db, account, site);
    const success = refresh.status === 'success';
    return c.json({
      success,
      refresh,
      message: success
        ? `已获取到模型（共 ${refresh.modelCount} 个）`
        : (refresh.errorMessage || '模型获取失败'),
    });
  });

  app.get('/api/update-center/status', async (c) => {
    const db = getCloudflareDb(c);
    const status = await readCloudflareUpdateCenterStatusPayload(db);
    return c.json(status);
  });

  app.put('/api/update-center/config', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const parsed = parseUpdateCenterConfigPayload(body);
    if (!parsed.success) {
      return c.json({ success: false, message: parsed.error }, 400);
    }
    const saved = await saveCloudflareUpdateCenterConfig(db, parsed.data);
    return c.json({
      success: true,
      config: saved,
    });
  });

  app.post('/api/update-center/check', async (c) => {
    const db = getCloudflareDb(c);
    const status = await refreshCloudflareUpdateCenterStatusPayload(db, c.env);
    return c.json(status);
  });

  app.post('/api/update-center/deploy', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const parsed = parseUpdateCenterDeployPayload(body);
    if (!parsed.success) {
      return c.json({ success: false, message: parsed.error }, 400);
    }

    const config = await loadCloudflareUpdateCenterConfig(db);
    const helperToken = resolveUpdateCenterHelperTokenFromEnv(c.env);
    const source: CloudflareUpdateCenterVersionSource = parsed.data.source === 'docker-hub-tag'
      ? 'docker-hub-tag'
      : parsed.data.source === 'github-release'
        ? 'github-release'
        : config.defaultDeploySource;
    const targetTag = String(parsed.data.targetTag || parsed.data.targetVersion || '').trim();
    const targetDigest = normalizeUpdateCenterDigest(parsed.data.targetDigest);
    if (!targetTag) {
      return c.json({ success: false, message: 'targetTag is required' }, 400);
    }

    const helper = await fetchUpdateCenterHelperStatus(config, helperToken);
    const blockMessage = buildUpdateCenterDeployBlockMessage({
      config,
      helper,
      targetTag,
      targetDigest,
    });
    if (blockMessage) {
      return c.json({ success: false, message: blockMessage }, 409);
    }

    const running = [...cloudflareTaskStore.values()]
      .find((task) => task.type === UPDATE_CENTER_DEPLOY_TASK_TYPE && (task.status === 'running' || task.status === 'pending'));
    if (running) {
      return c.json({ success: true, reused: true, task: running }, 202);
    }

    const task = createCloudflareTask({
      type: UPDATE_CENTER_DEPLOY_TASK_TYPE,
      title: '更新中心部署',
      status: 'running',
      message: '正在部署',
    });
    appendCloudflareTaskLog(task.id, `Resolving target image: ${targetTag}${targetDigest ? ` @ ${targetDigest}` : ''}`);
    appendCloudflareTaskLog(task.id, `Contacting deploy helper: ${config.helperBaseUrl}`);

    const run = (async () => {
      try {
        await streamHelperDeployAndUpdateTask({
          taskId: task.id,
          config,
          helperToken,
          source,
          targetTag,
          targetDigest,
        });
        appendCloudflareTaskLog(task.id, 'Deployment finished successfully');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'deploy helper failed';
        appendCloudflareTaskLog(task.id, message);
        updateCloudflareTask(task.id, {
          status: 'failed',
          message: '更新中心部署失败',
          error: { message },
        });
      } finally {
        await refreshCloudflareUpdateCenterStatusPayload(db, c.env).catch(() => null);
      }
    })();
    c.executionCtx.waitUntil(run);
    return c.json({ success: true, reused: false, task }, 202);
  });

  app.post('/api/update-center/rollback', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const parsed = parseUpdateCenterRollbackPayload(body);
    if (!parsed.success) {
      return c.json({ success: false, message: parsed.error }, 400);
    }
    const targetRevision = String(parsed.data.targetRevision || '').trim();
    if (!targetRevision) {
      return c.json({ success: false, message: 'targetRevision is required' }, 400);
    }

    const config = await loadCloudflareUpdateCenterConfig(db);
    const helperToken = resolveUpdateCenterHelperTokenFromEnv(c.env);
    if (!config.enabled) return c.json({ success: false, message: 'update center is disabled' }, 400);
    if (!config.helperBaseUrl) return c.json({ success: false, message: 'helperBaseUrl is required' }, 400);
    if (!config.namespace) return c.json({ success: false, message: 'namespace is required' }, 400);
    if (!config.releaseName) return c.json({ success: false, message: 'releaseName is required' }, 400);
    if (!helperToken) return c.json({ success: false, message: 'DEPLOY_HELPER_TOKEN is required' }, 400);

    const running = [...cloudflareTaskStore.values()]
      .find((task) => task.type === UPDATE_CENTER_DEPLOY_TASK_TYPE && (task.status === 'running' || task.status === 'pending'));
    if (running) {
      return c.json({ success: true, reused: true, task: running }, 202);
    }

    const task = createCloudflareTask({
      type: UPDATE_CENTER_DEPLOY_TASK_TYPE,
      title: '更新中心回退',
      status: 'running',
      message: '正在回退',
    });
    appendCloudflareTaskLog(task.id, `Resolving rollback revision: ${targetRevision}`);
    appendCloudflareTaskLog(task.id, `Contacting deploy helper: ${config.helperBaseUrl}`);

    const run = (async () => {
      try {
        await streamHelperRollbackAndUpdateTask({
          taskId: task.id,
          config,
          helperToken,
          targetRevision,
        });
        appendCloudflareTaskLog(task.id, 'Rollback finished successfully');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'rollback helper failed';
        appendCloudflareTaskLog(task.id, message);
        updateCloudflareTask(task.id, {
          status: 'failed',
          message: '更新中心回退失败',
          error: { message },
        });
      } finally {
        await refreshCloudflareUpdateCenterStatusPayload(db, c.env).catch(() => null);
      }
    })();
    c.executionCtx.waitUntil(run);
    return c.json({ success: true, reused: false, task }, 202);
  });

  app.get('/api/update-center/tasks/:id/stream', async (c) => {
    const taskId = String(c.req.param('id') || '').trim();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const writeEvent = async (event: string, payload: unknown) => {
      await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
    };

    const streamTask = async () => {
      let sentLogCount = 0;
      let tick = 0;
      try {
        while (tick < 600) {
          tick += 1;
          const task = cloudflareTaskStore.get(taskId);
          if (!task) {
            await writeEvent('log', { message: 'task not found' });
            await writeEvent('done', { id: taskId, status: 'failed', error: 'task not found' });
            return;
          }
          const logs = Array.isArray(task.logs) ? task.logs : [];
          while (sentLogCount < logs.length) {
            const log = logs[sentLogCount] || { message: '' };
            sentLogCount += 1;
            const message = String(log.message || '').trim();
            if (!message) continue;
            await writeEvent('log', { message, createdAt: log.createdAt || null });
          }
          if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
            await writeEvent('done', {
              id: task.id,
              status: task.status,
              result: task.result,
              error: task.error,
              finishedAt: task.finishedAt,
            });
            return;
          }
          await scheduler.wait(600);
        }
        const snapshot = cloudflareTaskStore.get(taskId);
        await writeEvent('done', {
          id: taskId,
          status: snapshot?.status || 'running',
          result: snapshot?.result,
          error: snapshot?.error,
          finishedAt: snapshot?.finishedAt || null,
        });
      } finally {
        await writer.close();
      }
    };

    c.executionCtx.waitUntil(streamTask());
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  });

  app.post('/api/sites', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const name = String(body.name || '').trim();
    const url = String(body.url || '').trim();
    const platform = String(body.platform || '').trim();
    if (!name || !url || !platform) return c.json({ success: false, message: 'name/url/platform 不能为空' }, 400);
    const inserted = await db.insert(schema.sites).values({
      name,
      url,
      platform,
      status: String(body.status || 'active').trim() || 'active',
      apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : null,
      globalWeight: Number.isFinite(Number(body.globalWeight)) ? Number(body.globalWeight) : 1,
      proxyUrl: typeof body.proxyUrl === 'string' ? body.proxyUrl.trim() : null,
      useSystemProxy: !!body.useSystemProxy,
      customHeaders: typeof body.customHeaders === 'string' ? body.customHeaders : null,
      externalCheckinUrl: typeof body.externalCheckinUrl === 'string' ? body.externalCheckinUrl.trim() : null,
      isPinned: !!body.isPinned,
      sortOrder: Number.isFinite(Number(body.sortOrder)) ? Math.trunc(Number(body.sortOrder)) : 0,
      createdAt: formatUtcSqlDateTime(),
      updatedAt: formatUtcSqlDateTime(),
    }).returning().get();
    return c.json(inserted);
  });

  app.put('/api/sites/:id', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'siteId 无效' }, 400);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Partial<typeof schema.sites.$inferInsert> = {
      updatedAt: formatUtcSqlDateTime(),
    };
    if (Object.prototype.hasOwnProperty.call(body, 'name')) patch.name = String(body.name || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'url')) patch.url = String(body.url || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'platform')) patch.platform = String(body.platform || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'status')) patch.status = String(body.status || '').trim() || 'active';
    if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) patch.apiKey = body.apiKey == null ? null : String(body.apiKey);
    if (Object.prototype.hasOwnProperty.call(body, 'globalWeight')) patch.globalWeight = Number.isFinite(Number(body.globalWeight)) ? Number(body.globalWeight) : 1;
    if (Object.prototype.hasOwnProperty.call(body, 'proxyUrl')) patch.proxyUrl = body.proxyUrl == null ? null : String(body.proxyUrl || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'useSystemProxy')) patch.useSystemProxy = !!body.useSystemProxy;
    if (Object.prototype.hasOwnProperty.call(body, 'customHeaders')) patch.customHeaders = body.customHeaders == null ? null : String(body.customHeaders);
    if (Object.prototype.hasOwnProperty.call(body, 'externalCheckinUrl')) patch.externalCheckinUrl = body.externalCheckinUrl == null ? null : String(body.externalCheckinUrl || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'isPinned')) patch.isPinned = !!body.isPinned;
    if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) patch.sortOrder = Number.isFinite(Number(body.sortOrder)) ? Math.trunc(Number(body.sortOrder)) : 0;
    await db.update(schema.sites).set(patch).where(eq(schema.sites.id, id)).run();
    const updated = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    return c.json(updated || { success: false, message: '站点不存在' });
  });

  app.delete('/api/sites/:id', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'siteId 无效' }, 400);
    await db.delete(schema.sites).where(eq(schema.sites.id, id)).run();
    return c.json({ success: true });
  });

  app.post('/api/sites/batch', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map((item) => Math.trunc(Number(item))).filter((id) => Number.isFinite(id) && id > 0))] : [];
    const action = String(body.action || '').trim().toLowerCase();
    if (ids.length === 0) return c.json({ success: false, message: 'ids 不能为空' }, 400);
    if (!['enable', 'disable', 'delete', 'enablesystemproxy', 'disablesystemproxy'].includes(action)) {
      return c.json({ success: false, message: '不支持的 action' }, 400);
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];

    for (const id of ids) {
      try {
        const existing = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
        if (!existing) {
          failedItems.push({ id, message: '站点不存在' });
          continue;
        }

        if (action === 'delete') {
          await db.delete(schema.sites).where(eq(schema.sites.id, id)).run();
        } else if (action === 'enable' || action === 'disable') {
          await db.update(schema.sites).set({
            status: action === 'enable' ? 'active' : 'disabled',
            updatedAt: formatUtcSqlDateTime(),
          }).where(eq(schema.sites.id, id)).run();
        } else if (action === 'enablesystemproxy' || action === 'disablesystemproxy') {
          await db.update(schema.sites).set({
            useSystemProxy: action === 'enablesystemproxy',
            updatedAt: formatUtcSqlDateTime(),
          }).where(eq(schema.sites.id, id)).run();
        }

        successIds.push(id);
      } catch (error: unknown) {
        failedItems.push({
          id,
          message: error instanceof Error ? error.message : '批量操作失败',
        });
      }
    }

    return c.json({ success: true, successIds, failedItems });
  });

  app.post('/api/sites/detect', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const url = String(body.url || '').trim();
    if (!url) return c.json({ success: false, message: 'url 不能为空' }, 400);
    const lower = url.toLowerCase();
    const platform = lower.includes('claude')
      ? 'claude'
      : lower.includes('gemini')
        ? 'gemini'
        : lower.includes('openai')
          ? 'openai'
          : 'new-api';
    return c.json({
      url,
      platform,
      initializationPresetId: null,
    });
  });

  app.get('/api/sites/:siteId/disabled-models', async (c) => {
    const db = getCloudflareDb(c);
    const siteId = Math.trunc(Number(c.req.param('siteId')));
    if (!Number.isFinite(siteId) || siteId <= 0) return c.json({ success: false, message: 'siteId 无效' }, 400);
    const rows = await db.select().from(schema.siteDisabledModels).where(eq(schema.siteDisabledModels.siteId, siteId)).all();
    return c.json({
      siteId,
      models: rows.map((row) => row.modelName).sort((left, right) => left.localeCompare(right)),
    });
  });

  app.put('/api/sites/:siteId/disabled-models', async (c) => {
    const db = getCloudflareDb(c);
    const siteId = Math.trunc(Number(c.req.param('siteId')));
    if (!Number.isFinite(siteId) || siteId <= 0) return c.json({ success: false, message: 'siteId 无效' }, 400);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const models = Array.isArray(body.models)
      ? [...new Set(body.models.map((item) => String(item || '').trim()).filter(Boolean))]
      : [];
    await db.delete(schema.siteDisabledModels).where(eq(schema.siteDisabledModels.siteId, siteId)).run();
    for (const modelName of models) {
      await db.insert(schema.siteDisabledModels).values({
        siteId,
        modelName,
        createdAt: formatUtcSqlDateTime(),
      }).run();
    }
    return c.json({ success: true, siteId, models });
  });

  app.get('/api/sites/:siteId/available-models', async (c) => {
    const db = getCloudflareDb(c);
    const siteId = Math.trunc(Number(c.req.param('siteId')));
    if (!Number.isFinite(siteId) || siteId <= 0) return c.json({ success: false, message: 'siteId 无效' }, 400);
    const rows = await db
      .select({
        modelName: schema.modelAvailability.modelName,
        available: schema.modelAvailability.available,
      })
      .from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .where(eq(schema.accounts.siteId, siteId))
      .all();
    const modelNames = [...new Set(rows.filter((row) => row.available !== false).map((row) => row.modelName))].sort((left, right) => left.localeCompare(right));
    return c.json({ siteId, models: modelNames });
  });

  app.post('/api/sites/:siteId/probe-now', async (c) => {
    const db = getCloudflareDb(c);
    const siteId = Math.trunc(Number(c.req.param('siteId')));
    if (!Number.isFinite(siteId) || siteId <= 0) return c.json({ success: false, message: 'siteId 无效' }, 400);
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) return c.json({ success: false, message: '站点不存在' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const scope = String(body.scope || 'single').trim() === 'all' ? 'all' : 'single';
    const modelName = String(body.modelName || '').trim();
    const latencyThresholdMs = Number.isFinite(Number(body.latencyThresholdMs)) ? Math.max(0, Math.trunc(Number(body.latencyThresholdMs))) : 0;
    const result = await executeSiteModelProbe(db, site, {
      scope,
      modelName: modelName || undefined,
      latencyThresholdMs,
    });
    return c.json(result, result.success ? 200 : 422);
  });

  app.get('/api/sites/:siteId/probe-stream', async (c) => {
    const db = getCloudflareDb(c);
    const siteId = Math.trunc(Number(c.req.param('siteId')));
    if (!Number.isFinite(siteId) || siteId <= 0) {
      const body = [
        'event: error',
        `data: ${JSON.stringify({ message: 'siteId 无效' })}`,
        '',
      ].join('\n');
      return new Response(body, {
        status: 400,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) {
      const body = [
        'event: error',
        `data: ${JSON.stringify({ message: '站点不存在' })}`,
        '',
      ].join('\n');
      return new Response(body, {
        status: 404,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      });
    }

    const scope = String(c.req.query('scope') || 'single').trim() === 'all' ? 'all' : 'single';
    const modelName = String(c.req.query('modelName') || '').trim();
    const latencyThresholdMs = Math.max(0, Math.trunc(Number(c.req.query('latencyThresholdMs') || '0')) || 0);
    const result = await executeSiteModelProbe(db, site, {
      scope,
      modelName: modelName || undefined,
      latencyThresholdMs,
    });

    const lines: string[] = [];
    lines.push('event: start');
    lines.push(`data: ${JSON.stringify({
      scope,
      modelName,
      modelsCount: result.modelsCount,
    })}`);
    lines.push('');

    for (const detail of result.details) {
      lines.push('event: model');
      lines.push(`data: ${JSON.stringify(detail)}`);
      lines.push('');
    }

    for (const disabledModel of result.disabledAdded) {
      lines.push('event: action');
      lines.push(`data: ${JSON.stringify({ action: 'disabled', modelName: disabledModel })}`);
      lines.push('');
    }

    if (result.success) {
      lines.push('event: complete');
      lines.push(`data: ${JSON.stringify(result)}`);
    } else {
      lines.push('event: error');
      lines.push(`data: ${JSON.stringify(result)}`);
    }
    lines.push('');

    return new Response(lines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  });

  app.post('/api/accounts', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const siteId = Math.trunc(Number(body.siteId));
    if (!Number.isFinite(siteId) || siteId <= 0) return c.json({ success: false, message: 'siteId 无效' }, 400);
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) return c.json({ success: false, message: 'site not found' }, 404);
    const requestedUsername = typeof body.username === 'string' ? body.username.trim() : '';
    const explicitBatchTokens = parseBatchApiKeys(body.accessTokens);
    const requestedMode = explicitBatchTokens.length > 0
      ? 'apikey'
      : resolveRequestedCredentialMode(body.credentialMode);
    const requestedTokens = explicitBatchTokens.length > 0
      ? explicitBatchTokens
      : parseBatchApiKeys(body.accessToken);
    if (requestedTokens.length === 0) return c.json({ success: false, message: '请填写 Token' }, 400);

    const insertOne = async (
      rawToken: string,
      usernameOverride: string | null,
    ): Promise<(typeof schema.accounts.$inferSelect & {
      tokenType: 'session' | 'apikey';
      credentialMode: CloudflareAccountCredentialMode;
      capabilities: {
        canCheckin: boolean;
        canRefreshBalance: boolean;
        proxyOnly: boolean;
      };
      apiTokenFound: boolean;
      usernameDetected: boolean;
      queued: boolean;
      modelCount: number;
    })> => {
      const effectiveMode: 'session' | 'apikey' = requestedMode === 'session'
        ? 'session'
        : requestedMode === 'apikey'
          ? 'apikey'
          : (/^sk-[A-Za-z0-9_\-]{4,}/.test(rawToken) ? 'apikey' : 'session');
      let resolvedUsername = (usernameOverride || requestedUsername || '').trim();
      let resolvedPlatformUserId = parseNumericUserId(body.platformUserId)
        ?? guessPlatformUserIdFromUsername(resolvedUsername);
      let resolvedApiToken = effectiveMode === 'apikey'
        ? rawToken
        : (typeof body.apiToken === 'string' ? body.apiToken.trim() : '');
      let resolvedBalance = Number.isFinite(Number(body.balance)) ? Number(body.balance) : 0;
      let resolvedBalanceUsed = Number.isFinite(Number(body.balanceUsed)) ? Number(body.balanceUsed) : 0;
      let resolvedQuota = Number.isFinite(Number(body.quota)) ? Number(body.quota) : 0;
      let modelCount = 0;

      const skipModelFetch = !!body.skipModelFetch;
      if (effectiveMode === 'session') {
        const verify = await performSessionTokenVerification({
          site,
          token: rawToken,
          platformUserId: resolvedPlatformUserId,
        });
        if (!verify.success) {
          const mappedFailure = buildVerificationFailurePayload(verify.reason);
          throw new Error(
            String(mappedFailure?.message || verify.message || 'Session Token 验证失败'),
          );
        }
        const verifiedUserId = parseNumericUserId(verify.result.userInfo.userId);
        if (verifiedUserId) resolvedPlatformUserId = verifiedUserId;
        if (!resolvedUsername) {
          resolvedUsername = String(verify.result.userInfo.username || '').trim();
        }
        if (verify.result.apiToken) {
          resolvedApiToken = verify.result.apiToken;
        }
        if (verify.result.balance) {
          resolvedBalance = toFiniteNumber(verify.result.balance.balance);
          resolvedBalanceUsed = toFiniteNumber(verify.result.balance.used);
          resolvedQuota = toFiniteNumber(verify.result.balance.quota);
        }
      } else if (!skipModelFetch) {
        const apiKeyVerify = await performApiKeyVerification({
          db,
          site,
          token: rawToken,
          platformUserId: resolvedPlatformUserId,
        });
        if (!apiKeyVerify.success) {
          const mappedFailure = buildVerificationFailurePayload(apiKeyVerify.reason);
          throw new Error(
            String(mappedFailure?.message || apiKeyVerify.message || 'API Key 验证失败'),
          );
        }
        modelCount = apiKeyVerify.models.length;
      }

      const extraConfig = mergeAccountExtraConfig(body.extraConfig, {
        credentialMode: effectiveMode,
        ...(resolvedPlatformUserId ? { platformUserId: resolvedPlatformUserId } : {}),
      });
      const inserted = await db.insert(schema.accounts).values({
        siteId,
        username: resolvedUsername || null,
        accessToken: effectiveMode === 'session' ? rawToken : '',
        apiToken: resolvedApiToken || null,
        balance: resolvedBalance,
        balanceUsed: resolvedBalanceUsed,
        quota: resolvedQuota,
        unitCost: Number.isFinite(Number(body.unitCost)) ? Number(body.unitCost) : null,
        valueScore: Number.isFinite(Number(body.valueScore)) ? Number(body.valueScore) : 0,
        status: String(body.status || 'active').trim() || 'active',
        checkinEnabled: effectiveMode === 'session'
          ? (Object.prototype.hasOwnProperty.call(body, 'checkinEnabled') ? !!body.checkinEnabled : true)
          : false,
        isPinned: !!body.isPinned,
        sortOrder: Number.isFinite(Number(body.sortOrder)) ? Math.trunc(Number(body.sortOrder)) : 0,
        oauthProvider: typeof body.oauthProvider === 'string' ? body.oauthProvider.trim() : null,
        oauthAccountKey: typeof body.oauthAccountKey === 'string' ? body.oauthAccountKey.trim() : null,
        oauthProjectId: typeof body.oauthProjectId === 'string' ? body.oauthProjectId.trim() : null,
        extraConfig,
        createdAt: formatUtcSqlDateTime(),
        updatedAt: formatUtcSqlDateTime(),
      }).returning().get();

      if (!(effectiveMode === 'apikey' && skipModelFetch)) {
        const refresh = await runAccountModelProbe(db, inserted, site).catch(() => null);
        if (refresh?.status === 'success') {
          modelCount = Math.max(modelCount, refresh.modelCount);
          const runtimeHealth = buildRuntimeHealthRecord({
            state: 'healthy',
            reason: `模型探测成功（${refresh.modelCount}）`,
            source: 'account-create',
            checkedAt: new Date().toISOString(),
          });
          const refreshedExtraConfig = mergeAccountExtraConfig(inserted.extraConfig, {
            runtimeHealth,
          });
          await db.update(schema.accounts).set({
            extraConfig: refreshedExtraConfig,
            updatedAt: formatUtcSqlDateTime(),
          }).where(eq(schema.accounts.id, inserted.id)).run();
          inserted.extraConfig = refreshedExtraConfig;
        }
      }

      const credentialMode = resolveStoredCredentialMode(inserted);
      return {
        ...inserted,
        tokenType: effectiveMode,
        credentialMode,
        capabilities: buildCapabilitiesFromCredentialMode(credentialMode),
        apiTokenFound: !!String(inserted.apiToken || '').trim(),
        usernameDetected: !requestedUsername && !!String(inserted.username || '').trim(),
        queued: false,
        modelCount,
      };
    };

    if (requestedMode === 'apikey' && requestedTokens.length > 1) {
      const items: Array<Record<string, unknown>> = [];
      let createdCount = 0;
      for (const [index, token] of requestedTokens.entries()) {
        try {
          const created = await insertOne(
            token,
            buildBatchApiKeyConnectionName(requestedUsername, index, requestedTokens.length) || null,
          );
          createdCount += 1;
          items.push({
            index,
            status: 'created',
            id: created.id,
            username: created.username || null,
            queued: false,
            message: null,
            modelCount: 0,
          });
        } catch (error: unknown) {
          items.push({
            index,
            status: 'failed',
            message: error instanceof Error ? error.message : '创建失败',
            requiresVerification: false,
          });
        }
      }

      if (createdCount === 0) {
        return c.json({
          success: false,
          batch: true,
          totalCount: requestedTokens.length,
          createdCount: 0,
          failedCount: requestedTokens.length,
          message: `批量添加失败（0/${requestedTokens.length}）`,
          items,
        }, 400);
      }

      return c.json({
        success: true,
        batch: true,
        totalCount: requestedTokens.length,
        createdCount,
        failedCount: requestedTokens.length - createdCount,
        message: `批量添加完成：成功 ${createdCount}，失败 ${requestedTokens.length - createdCount}`,
        items,
      });
    }

    const inserted = await insertOne(requestedTokens[0]!, null);
    return c.json(inserted);
  });

  app.post('/api/accounts/login', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const siteId = Math.trunc(Number(body.siteId));
    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();
    if (!Number.isFinite(siteId) || siteId <= 0 || !username || !password) {
      return c.json({ success: false, message: 'siteId/username/password 不能为空' }, 400);
    }
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) return c.json({ success: false, message: 'site not found' }, 404);

    const loginResult = await performUpstreamLogin({
      site,
      username,
      password,
    });
    if (!loginResult.success) {
      return c.json({
        success: false,
        shieldBlocked: loginResult.shieldBlocked,
        message: loginResult.message,
      });
    }

    const guessedPlatformUserId = guessPlatformUserIdFromUsername(username);
    const verifyResult = await performSessionTokenVerification({
      site,
      token: loginResult.accessToken,
      platformUserId: guessedPlatformUserId,
    });
    const verifiedUserInfo = verifyResult.success ? verifyResult.result.userInfo : null;
    const verifiedBalance = verifyResult.success ? verifyResult.result.balance : null;
    const verifiedApiToken = verifyResult.success ? verifyResult.result.apiToken : null;
    const resolvedUsername = String(verifiedUserInfo?.username || username).trim() || username;
    const resolvedPlatformUserId = parseNumericUserId(verifiedUserInfo?.userId) ?? guessedPlatformUserId;

    let existing = await db.select().from(schema.accounts).where(and(
      eq(schema.accounts.siteId, siteId),
      eq(schema.accounts.username, resolvedUsername),
    )).get();
    if (!existing && resolvedUsername !== username) {
      existing = await db.select().from(schema.accounts).where(and(
        eq(schema.accounts.siteId, siteId),
        eq(schema.accounts.username, username),
      )).get();
    }

    const nextExtraConfig = mergeAccountExtraConfig(existing?.extraConfig, {
      credentialMode: 'session',
      ...(resolvedPlatformUserId ? { platformUserId: resolvedPlatformUserId } : {}),
    });

    let accountId = existing?.id || 0;
    if (existing) {
      await db.update(schema.accounts).set({
        username: resolvedUsername,
        accessToken: loginResult.accessToken,
        ...(verifiedApiToken ? { apiToken: verifiedApiToken } : {}),
        ...(verifiedBalance
          ? {
            balance: verifiedBalance.balance,
            balanceUsed: Number.isFinite(Number(verifiedBalance.used)) ? Number(verifiedBalance.used) : existing.balanceUsed,
            quota: Number.isFinite(Number(verifiedBalance.quota)) ? Number(verifiedBalance.quota) : existing.quota,
          }
          : {}),
        status: 'active',
        checkinEnabled: true,
        extraConfig: nextExtraConfig,
        updatedAt: formatUtcSqlDateTime(),
      }).where(eq(schema.accounts.id, existing.id)).run();
      accountId = existing.id;
    } else {
      const sortOrder = await getNextAccountSortOrder(db);
      const created = await db.insert(schema.accounts).values({
        siteId,
        username: resolvedUsername,
        accessToken: loginResult.accessToken,
        apiToken: verifiedApiToken || null,
        ...(verifiedBalance
          ? {
            balance: verifiedBalance.balance,
            balanceUsed: Number.isFinite(Number(verifiedBalance.used)) ? Number(verifiedBalance.used) : 0,
            quota: Number.isFinite(Number(verifiedBalance.quota)) ? Number(verifiedBalance.quota) : 0,
          }
          : {}),
        status: 'active',
        checkinEnabled: true,
        extraConfig: nextExtraConfig,
        isPinned: false,
        sortOrder,
        createdAt: formatUtcSqlDateTime(),
        updatedAt: formatUtcSqlDateTime(),
      }).returning().get();
      accountId = created.id;
    }

    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    return c.json({
      success: true,
      account: account || null,
      apiTokenFound: !!String(verifiedApiToken || account?.apiToken || '').trim(),
      tokenCount: String(verifiedApiToken || account?.apiToken || '').trim() ? 1 : 0,
      reusedAccount: !!existing,
    });
  });

  app.post('/api/accounts/verify-token', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const siteId = Math.trunc(Number(body.siteId));
    const accessToken = String(body.accessToken || '').trim();
    if (!Number.isFinite(siteId) || siteId <= 0 || !accessToken) {
      return c.json({ success: false, message: 'siteId/accessToken 不能为空' }, 400);
    }
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) return c.json({ success: false, message: 'site not found' }, 404);

    const credentialMode = resolveRequestedCredentialMode(body.credentialMode);
    const looksLikeApiKey = /^sk-[A-Za-z0-9_\-]{4,}/.test(accessToken);
    const tokenType = credentialMode === 'session'
      ? 'session'
      : credentialMode === 'apikey'
        ? 'apikey'
        : (looksLikeApiKey ? 'apikey' : 'session');
    const platformUserId = parseNumericUserId(body.platformUserId);

    if (tokenType === 'session') {
      const sessionVerify = await performSessionTokenVerification({
        site,
        token: accessToken,
        platformUserId,
      });
      if (sessionVerify.success) {
        return c.json({
          success: true,
          tokenType: 'session',
          userInfo: sessionVerify.result.userInfo,
          balance: sessionVerify.result.balance,
          apiToken: sessionVerify.result.apiToken,
        });
      }
      if (credentialMode === 'auto') {
        const apiKeyFallback = await performApiKeyVerification({
          db,
          site,
          token: accessToken,
          platformUserId,
        });
        if (apiKeyFallback.success) {
          return c.json({
            success: true,
            tokenType: 'apikey',
            modelCount: apiKeyFallback.models.length,
            models: apiKeyFallback.models.slice(0, 10),
          });
        }
        const failurePayload = buildVerificationFailurePayload(
          chooseFailureReason(sessionVerify.reason, apiKeyFallback.reason),
        );
        if (failurePayload) return c.json(failurePayload);
        return c.json({
          success: false,
          message: apiKeyFallback.message || sessionVerify.message || 'Token invalid: cannot use it as session cookie or API key',
        });
      }
      const failurePayload = buildVerificationFailurePayload(sessionVerify.reason);
      if (failurePayload) return c.json(failurePayload);
      return c.json({ success: false, message: sessionVerify.message || 'Session Token 验证失败' });
    }

    const apiKeyVerify = await performApiKeyVerification({
      db,
      site,
      token: accessToken,
      platformUserId,
    });
    if (apiKeyVerify.success) {
      return c.json({
        success: true,
        tokenType: 'apikey',
        modelCount: apiKeyVerify.models.length,
        models: apiKeyVerify.models.slice(0, 10),
      });
    }
    const failurePayload = buildVerificationFailurePayload(apiKeyVerify.reason);
    if (failurePayload) return c.json(failurePayload);
    return c.json({
      success: false,
      message: apiKeyVerify.message || 'API Key 验证失败',
    });
  });

  app.post('/api/accounts/:id/rebind-session', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'accountId 无效' }, 400);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const accessToken = String(body.accessToken || '').trim();
    if (!accessToken) return c.json({ success: false, message: 'accessToken 不能为空' }, 400);
    const existing = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (!existing) return c.json({ success: false, message: '账号不存在' }, 404);
    const existingExtra = parseAccountExtraConfig(existing.extraConfig);
    const platformUserId = Math.trunc(Number(body.platformUserId));
    const refreshToken = String(body.refreshToken || '').trim();
    const tokenExpiresAt = Math.trunc(Number(body.tokenExpiresAt));
    const prevSub2ApiAuth = (
      existingExtra.sub2apiAuth
      && typeof existingExtra.sub2apiAuth === 'object'
      && !Array.isArray(existingExtra.sub2apiAuth)
    ) ? existingExtra.sub2apiAuth as Record<string, unknown> : {};
    const nextSub2ApiAuth = {
      ...prevSub2ApiAuth,
      ...(refreshToken ? { refreshToken } : {}),
      ...(Number.isFinite(tokenExpiresAt) && tokenExpiresAt > 0 ? { tokenExpiresAt } : {}),
    };
    const nextExtraConfig = mergeAccountExtraConfig(existingExtra, {
      ...(Number.isFinite(platformUserId) && platformUserId > 0 ? { platformUserId } : {}),
      ...((refreshToken || (Number.isFinite(tokenExpiresAt) && tokenExpiresAt > 0))
        ? { sub2apiAuth: nextSub2ApiAuth }
        : {}),
    });
    await db.update(schema.accounts).set({
      accessToken,
      extraConfig: nextExtraConfig,
      updatedAt: formatUtcSqlDateTime(),
    }).where(eq(schema.accounts.id, id)).run();
    const updated = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    return c.json({ success: true, account: updated || null });
  });

  app.put('/api/accounts/:id', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'accountId 无效' }, 400);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const existing = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (!existing) return c.json({ success: false, message: '账号不存在' }, 404);
    const patch: Partial<typeof schema.accounts.$inferInsert> = {
      updatedAt: formatUtcSqlDateTime(),
    };
    if (Object.prototype.hasOwnProperty.call(body, 'username')) {
      if (body.username === undefined) {
        // Keep current value when frontend omits username semantics via undefined.
      } else {
        const normalized = body.username == null ? '' : String(body.username).trim();
        patch.username = normalized || null;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'accessToken')) patch.accessToken = String(body.accessToken || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'apiToken')) patch.apiToken = body.apiToken == null ? null : String(body.apiToken).trim();
    if (Object.prototype.hasOwnProperty.call(body, 'balance')) patch.balance = Number.isFinite(Number(body.balance)) ? Number(body.balance) : 0;
    if (Object.prototype.hasOwnProperty.call(body, 'balanceUsed')) patch.balanceUsed = Number.isFinite(Number(body.balanceUsed)) ? Number(body.balanceUsed) : 0;
    if (Object.prototype.hasOwnProperty.call(body, 'quota')) patch.quota = Number.isFinite(Number(body.quota)) ? Number(body.quota) : 0;
    if (Object.prototype.hasOwnProperty.call(body, 'unitCost')) patch.unitCost = body.unitCost == null ? null : Number(body.unitCost);
    if (Object.prototype.hasOwnProperty.call(body, 'valueScore')) patch.valueScore = Number.isFinite(Number(body.valueScore)) ? Number(body.valueScore) : 0;
    if (Object.prototype.hasOwnProperty.call(body, 'status')) patch.status = String(body.status || '').trim() || 'active';
    if (Object.prototype.hasOwnProperty.call(body, 'checkinEnabled')) patch.checkinEnabled = !!body.checkinEnabled;
    if (Object.prototype.hasOwnProperty.call(body, 'isPinned')) patch.isPinned = !!body.isPinned;
    if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) patch.sortOrder = Number.isFinite(Number(body.sortOrder)) ? Math.trunc(Number(body.sortOrder)) : 0;
    const hasExtraPatch = Object.prototype.hasOwnProperty.call(body, 'platformUserId')
      || Object.prototype.hasOwnProperty.call(body, 'refreshToken')
      || Object.prototype.hasOwnProperty.call(body, 'tokenExpiresAt')
      || Object.prototype.hasOwnProperty.call(body, 'proxyUrl');
    if (Object.prototype.hasOwnProperty.call(body, 'extraConfig')) {
      patch.extraConfig = body.extraConfig == null ? null : String(body.extraConfig);
    } else if (hasExtraPatch) {
      const existingExtra = parseAccountExtraConfig(existing.extraConfig);
      const platformUserId = Math.trunc(Number(body.platformUserId));
      const refreshToken = String(body.refreshToken || '').trim();
      const tokenExpiresAt = Math.trunc(Number(body.tokenExpiresAt));
      const proxyUrl = body.proxyUrl == null ? '' : String(body.proxyUrl).trim();
      const prevSub2ApiAuth = (
        existingExtra.sub2apiAuth
        && typeof existingExtra.sub2apiAuth === 'object'
        && !Array.isArray(existingExtra.sub2apiAuth)
      ) ? existingExtra.sub2apiAuth as Record<string, unknown> : {};
      const nextSub2ApiAuth = {
        ...prevSub2ApiAuth,
        ...(Object.prototype.hasOwnProperty.call(body, 'refreshToken')
          ? { refreshToken: refreshToken || undefined }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'tokenExpiresAt')
          ? {
            tokenExpiresAt: Number.isFinite(tokenExpiresAt) && tokenExpiresAt > 0
              ? tokenExpiresAt
              : undefined,
          }
          : {}),
      };
      patch.extraConfig = mergeAccountExtraConfig(existingExtra, {
        ...(Object.prototype.hasOwnProperty.call(body, 'platformUserId')
          ? {
            platformUserId: Number.isFinite(platformUserId) && platformUserId > 0
              ? platformUserId
              : undefined,
          }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'proxyUrl')
          ? { proxyUrl: proxyUrl || undefined }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'refreshToken') || Object.prototype.hasOwnProperty.call(body, 'tokenExpiresAt'))
          ? { sub2apiAuth: nextSub2ApiAuth }
          : {},
      });
    }
    await db.update(schema.accounts).set(patch).where(eq(schema.accounts.id, id)).run();
    const updated = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    return c.json(updated || { success: false, message: '账号不存在' });
  });

  app.delete('/api/accounts/:id', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'accountId 无效' }, 400);
    await db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
    return c.json({ success: true });
  });

  app.post('/api/accounts/batch', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map((item) => Math.trunc(Number(item))).filter((id) => Number.isFinite(id) && id > 0))] : [];
    const action = String(body.action || '').trim().toLowerCase();
    if (ids.length === 0) return c.json({ success: false, message: 'ids 不能为空' }, 400);
    if (!['enable', 'disable', 'delete', 'refreshbalance'].includes(action)) {
      return c.json({ success: false, message: '不支持的 action' }, 400);
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];

    for (const id of ids) {
      try {
        const existing = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
        if (!existing) {
          failedItems.push({ id, message: '账号不存在' });
          continue;
        }

        if (action === 'delete') {
          await db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
        } else if (action === 'enable' || action === 'disable') {
          await db.update(schema.accounts).set({
            status: action === 'enable' ? 'active' : 'disabled',
            updatedAt: formatUtcSqlDateTime(),
          }).where(eq(schema.accounts.id, id)).run();
        } else if (action === 'refreshbalance') {
          const site = await db.select().from(schema.sites).where(eq(schema.sites.id, existing.siteId)).get();
          const balance = await refreshAccountBalanceFromUpstream(existing, site);
          const runtimeHealth = buildRuntimeHealthRecord({
            state: balance ? 'healthy' : 'unknown',
            reason: balance ? '余额刷新成功' : '余额刷新未获取到上游数据',
            source: 'balance',
            checkedAt: new Date().toISOString(),
          });
          const nextExtraConfig = mergeAccountExtraConfig(existing.extraConfig, {
            runtimeHealth,
          });
            await db.update(schema.accounts).set({
              ...(balance
                ? {
                balance: balance.balance,
                balanceUsed: balance.used,
                quota: balance.quota,
                ...(shouldAutoUpgradeAccountUsername(existing.username) ? { username: balance.username || null } : {}),
              }
              : {}),
              lastBalanceRefresh: formatUtcSqlDateTime(),
              extraConfig: nextExtraConfig,
            updatedAt: formatUtcSqlDateTime(),
          }).where(eq(schema.accounts.id, id)).run();
        }

        successIds.push(id);
      } catch (error: unknown) {
        failedItems.push({
          id,
          message: error instanceof Error ? error.message : '批量操作失败',
        });
      }
    }

    return c.json({ success: true, successIds, failedItems });
  });

  app.post('/api/accounts/:id/balance', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'accountId 无效' }, 400);
    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (!account) return c.json({ success: false, message: '账号不存在' }, 404);
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, account.siteId)).get();
    const refreshed = await refreshAccountBalanceFromUpstream(account, site);
    const runtimeHealth = buildRuntimeHealthRecord({
      state: refreshed ? 'healthy' : 'unknown',
      reason: refreshed ? '余额刷新成功' : '余额刷新未获取到上游数据',
      source: 'balance',
      checkedAt: new Date().toISOString(),
    });
    const nextExtraConfig = mergeAccountExtraConfig(account.extraConfig, {
      runtimeHealth,
    });
    await db.update(schema.accounts).set({
      ...(refreshed
        ? {
          balance: refreshed.balance,
          balanceUsed: refreshed.used,
          quota: refreshed.quota,
          ...(shouldAutoUpgradeAccountUsername(account.username) ? { username: refreshed.username || null } : {}),
        }
        : {}),
      lastBalanceRefresh: formatUtcSqlDateTime(),
      extraConfig: nextExtraConfig,
      updatedAt: formatUtcSqlDateTime(),
    }).where(eq(schema.accounts.id, id)).run();
    const updated = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    return c.json({
      success: true,
      accountId: id,
      balance: toRoundedMicro(updated?.balance ?? account.balance),
      account: updated ? {
        ...updated,
        runtimeHealth: parseStoredRuntimeHealth(updated.extraConfig),
      } : null,
      message: '余额刷新成功',
    });
  });

  app.post('/api/accounts/:id/models/manual', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(accountId) || accountId <= 0) return c.json({ success: false, message: 'accountId 无效' }, 400);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const models = Array.isArray(body.models)
      ? [...new Set(body.models.map((item) => String(item || '').trim()).filter(Boolean))]
      : [];
    for (const modelName of models) {
      await db.insert(schema.modelAvailability).values({
        accountId,
        modelName,
        available: true,
        isManual: true,
        latencyMs: null,
        checkedAt: formatUtcSqlDateTime(),
      }).onConflictDoUpdate({
        target: [schema.modelAvailability.accountId, schema.modelAvailability.modelName],
        set: {
          available: true,
          isManual: true,
          checkedAt: formatUtcSqlDateTime(),
        },
      }).run();
    }
    return c.json({ success: true, accountId, models });
  });

  app.post('/api/accounts/health/refresh', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const accountId = Number.isFinite(Number(body.accountId)) ? Math.trunc(Number(body.accountId)) : null;
    if (accountId !== null && accountId <= 0) {
      return c.json({ success: false, message: 'accountId 无效' }, 400);
    }

    const accountRows = await db
      .select({
        account: schema.accounts,
        site: schema.sites,
      })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(accountId ? eq(schema.accounts.id, accountId) : undefined)
      .all();

    if (accountId && accountRows.length === 0) {
      return c.json({ success: false, message: '账号不存在' }, 404);
    }

    const results: Array<{
      accountId: number;
      siteId: number;
      status: CloudflareAccountHealthState;
      reason: string;
      checkedAt: string;
      refresh?: AccountProbeRefresh;
    }> = [];

    for (const row of accountRows) {
      const checkedAt = new Date().toISOString();
      const disabledState = resolveAccountHealthState({
        accountStatus: row.account.status,
        siteStatus: row.site.status,
      });

      if (disabledState === 'disabled') {
        const runtimeHealth = buildRuntimeHealthRecord({
          state: 'disabled',
          reason: row.account.status !== 'active' ? '账号已禁用' : '站点已禁用',
          source: 'health-refresh',
          checkedAt,
        });
        const nextExtraConfig = mergeAccountExtraConfig(row.account.extraConfig, {
          runtimeHealth,
        });
        await db.update(schema.accounts).set({
          extraConfig: nextExtraConfig,
          updatedAt: formatUtcSqlDateTime(),
        }).where(eq(schema.accounts.id, row.account.id)).run();
        results.push({
          accountId: row.account.id,
          siteId: row.site.id,
          status: 'disabled',
          reason: runtimeHealth.reason,
          checkedAt,
        });
        continue;
      }

      const refresh = await runAccountModelProbe(db, row.account, row.site);
      const status = resolveAccountHealthState({
        accountStatus: row.account.status,
        siteStatus: row.site.status,
        refreshStatus: refresh.status,
      });
      const reason = refresh.status === 'success'
        ? `模型探测成功（${refresh.modelCount}）`
        : (refresh.errorMessage || '模型探测失败');
      const runtimeHealth = buildRuntimeHealthRecord({
        state: status,
        reason,
        source: 'health-refresh',
        checkedAt,
      });
      const nextExtraConfig = mergeAccountExtraConfig(row.account.extraConfig, {
        runtimeHealth,
      });
      await db.update(schema.accounts).set({
        extraConfig: nextExtraConfig,
        updatedAt: formatUtcSqlDateTime(),
      }).where(eq(schema.accounts.id, row.account.id)).run();
      results.push({
        accountId: row.account.id,
        siteId: row.site.id,
        status,
        reason,
        checkedAt,
        refresh,
      });
    }

    const summary = {
      total: results.length,
      healthy: results.filter((item) => item.status === 'healthy').length,
      unhealthy: results.filter((item) => item.status === 'unhealthy').length,
      disabled: results.filter((item) => item.status === 'disabled').length,
    };

    return c.json({
      success: true,
      queued: false,
      accountId,
      summary,
      results,
      message: accountId
        ? '账号运行健康状态已刷新'
        : '全部账号运行健康状态已刷新',
    });
  });

  app.post('/api/account-tokens', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const accountId = Math.trunc(Number(body.accountId));
    const name = String(body.name || '').trim();
    const requestedToken = String(body.token || '').trim();
    if (!Number.isFinite(accountId) || accountId <= 0 || !name) {
      return c.json({ success: false, message: 'accountId/name 不能为空' }, 400);
    }
    const token = requestedToken || `mtk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const inserted = await db.insert(schema.accountTokens).values({
      accountId,
      name,
      token,
      source: typeof body.source === 'string' ? body.source.trim() : 'manual',
      tokenGroup: typeof body.tokenGroup === 'string'
        ? body.tokenGroup.trim()
        : (typeof body.group === 'string' ? body.group.trim() : null),
      valueStatus: typeof body.valueStatus === 'string' ? body.valueStatus.trim() : 'ready',
      enabled: Object.prototype.hasOwnProperty.call(body, 'enabled') ? !!body.enabled : true,
      isDefault: !!body.isDefault,
      createdAt: formatUtcSqlDateTime(),
      updatedAt: formatUtcSqlDateTime(),
    }).returning().get();
    return c.json(inserted);
  });

  app.put('/api/account-tokens/:id', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'tokenId 无效' }, 400);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const patch: Partial<typeof schema.accountTokens.$inferInsert> = {
      updatedAt: formatUtcSqlDateTime(),
    };
    if (Object.prototype.hasOwnProperty.call(body, 'name')) patch.name = String(body.name || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'token')) patch.token = String(body.token || '').trim();
    if (Object.prototype.hasOwnProperty.call(body, 'source')) patch.source = String(body.source || '').trim() || 'manual';
    if (Object.prototype.hasOwnProperty.call(body, 'tokenGroup')) patch.tokenGroup = body.tokenGroup == null ? null : String(body.tokenGroup).trim();
    if (Object.prototype.hasOwnProperty.call(body, 'valueStatus')) patch.valueStatus = String(body.valueStatus || '').trim() || 'ready';
    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) patch.enabled = !!body.enabled;
    if (Object.prototype.hasOwnProperty.call(body, 'isDefault')) patch.isDefault = !!body.isDefault;
    await db.update(schema.accountTokens).set(patch).where(eq(schema.accountTokens.id, id)).run();
    const updated = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, id)).get();
    return c.json(updated || { success: false, message: 'Token 不存在' });
  });

  app.delete('/api/account-tokens/:id', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'tokenId 无效' }, 400);
    await db.delete(schema.accountTokens).where(eq(schema.accountTokens.id, id)).run();
    return c.json({ success: true });
  });

  app.post('/api/account-tokens/batch', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map((item) => Math.trunc(Number(item))).filter((id) => Number.isFinite(id) && id > 0))] : [];
    const action = String(body.action || '').trim().toLowerCase();
    if (ids.length === 0) return c.json({ success: false, message: 'ids 不能为空' }, 400);
    if (!['enable', 'disable', 'delete'].includes(action)) {
      return c.json({ success: false, message: '不支持的 action' }, 400);
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];

    for (const id of ids) {
      try {
        const existing = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, id)).get();
        if (!existing) {
          failedItems.push({ id, message: 'Token 不存在' });
          continue;
        }

        if (action === 'delete') {
          await db.delete(schema.accountTokens).where(eq(schema.accountTokens.id, id)).run();
        } else {
          await db.update(schema.accountTokens).set({
            enabled: action === 'enable',
            updatedAt: formatUtcSqlDateTime(),
          }).where(eq(schema.accountTokens.id, id)).run();
        }

        successIds.push(id);
      } catch (error: unknown) {
        failedItems.push({
          id,
          message: error instanceof Error ? error.message : '批量操作失败',
        });
      }
    }

    return c.json({ success: true, successIds, failedItems });
  });

  app.get('/api/account-tokens/groups/:accountId', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('accountId')));
    if (!Number.isFinite(accountId) || accountId <= 0) return c.json({ success: false, message: 'accountId 无效' }, 400);
    const rows = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, accountId)).all();
    const groups = [...new Set(rows.map((row) => String(row.tokenGroup || '').trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    return c.json({ accountId, groups });
  });

  app.post('/api/account-tokens/:id/default', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'tokenId 无效' }, 400);
    const token = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, id)).get();
    if (!token) return c.json({ success: false, message: 'Token 不存在' }, 404);
    await db.update(schema.accountTokens).set({
      isDefault: false,
      updatedAt: formatUtcSqlDateTime(),
    }).where(eq(schema.accountTokens.accountId, token.accountId)).run();
    await db.update(schema.accountTokens).set({
      isDefault: true,
      updatedAt: formatUtcSqlDateTime(),
    }).where(eq(schema.accountTokens.id, id)).run();
    return c.json({ success: true });
  });

  app.get('/api/account-tokens/:id/value', async (c) => {
    const db = getCloudflareDb(c);
    const id = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(id) || id <= 0) return c.json({ success: false, message: 'tokenId 无效' }, 400);
    const token = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, id)).get();
    if (!token) return c.json({ success: false, message: 'Token 不存在' }, 404);
    return c.json({
      id: token.id,
      token: token.token,
      name: token.name,
      accountId: token.accountId,
      valueStatus: token.valueStatus,
    });
  });

  app.post('/api/account-tokens/sync/:accountId', async (c) => {
    const db = getCloudflareDb(c);
    const accountId = Math.trunc(Number(c.req.param('accountId')));
    if (!Number.isFinite(accountId) || accountId <= 0) return c.json({ success: false, message: 'accountId 无效' }, 400);
    const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    if (!account) return c.json({ success: false, message: '账号不存在' }, 404);
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, account.siteId)).get();
    if (!site) return c.json({ success: false, message: '站点不存在' }, 404);

    if (site.status !== 'active') {
      return c.json({
        success: true,
        status: 'skipped',
        synced: false,
        reason: 'site_disabled',
        accountId,
        accountName: account.username || '',
        message: '站点已禁用，跳过同步',
        created: 0,
        updated: 0,
        maskedPending: 0,
      });
    }
    if (account.status !== 'active') {
      return c.json({
        success: true,
        status: 'skipped',
        synced: false,
        reason: 'account_disabled',
        accountId,
        accountName: account.username || '',
        message: '账号已禁用，跳过同步',
        created: 0,
        updated: 0,
        maskedPending: 0,
      });
    }

    const tokenValue = String(account.accessToken || account.apiToken || '').trim();
    if (!tokenValue) {
      return c.json({
        success: true,
        status: 'skipped',
        synced: false,
        reason: 'missing_credential',
        accountId,
        accountName: account.username || '',
        message: '账号缺少可用凭证，跳过同步',
        created: 0,
        updated: 0,
        maskedPending: 0,
      });
    }

    if (isMaskedSecretValue(tokenValue)) {
      return c.json({
        success: true,
        status: 'skipped',
        synced: false,
        reason: 'upstream_masked_tokens',
        accountId,
        accountName: account.username || '',
        message: '当前仅有脱敏凭证，无法自动同步令牌',
        created: 0,
        updated: 0,
        maskedPending: 1,
      });
    }

    const existing = await db
      .select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, accountId))
      .all();

    let created = 0;
    let updated = 0;
    let defaultToken = existing.find((item) => item.isDefault);
    if (!defaultToken) {
      defaultToken = existing[0];
      if (defaultToken) {
        await db.update(schema.accountTokens).set({
          isDefault: true,
          enabled: true,
          updatedAt: formatUtcSqlDateTime(),
        }).where(eq(schema.accountTokens.id, defaultToken.id)).run();
        updated += 1;
      }
    }

    if (!defaultToken) {
      const inserted = await db.insert(schema.accountTokens).values({
        accountId,
        name: `${account.username || `account-${accountId}`}-default`,
        token: tokenValue,
        source: 'account_sync',
        enabled: true,
        isDefault: true,
        valueStatus: 'ready',
        createdAt: formatUtcSqlDateTime(),
        updatedAt: formatUtcSqlDateTime(),
      }).returning({ id: schema.accountTokens.id }).get();
      if (inserted?.id) created += 1;
    }

    return c.json({
      success: true,
      accountId,
      accountName: account.username || '',
      status: 'success',
      synced: true,
      created,
      updated,
      maskedPending: 0,
      message: created > 0
        ? `同步完成：新增 ${created}，更新 ${updated}`
        : `同步完成：新增 0，更新 ${updated}`,
    });
  });

  app.post('/api/account-tokens/sync-all', async (_c) => {
    const db = getCloudflareDb(_c);
    const body = await _c.req.json().catch(() => ({})) as Record<string, unknown>;
    const wait = !!body.wait;

    const executeSyncAll = async () => {
      const rows = await db
        .select({
          account: schema.accounts,
          site: schema.sites,
        })
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .all();

      const results: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        if (row.site.status !== 'active') {
          results.push({
            accountId: row.account.id,
            accountName: row.account.username || '',
            status: 'skipped',
            synced: false,
            reason: 'site_disabled',
            message: '站点已禁用，跳过同步',
            created: 0,
            updated: 0,
            maskedPending: 0,
          });
          continue;
        }
        if (row.account.status !== 'active') {
          results.push({
            accountId: row.account.id,
            accountName: row.account.username || '',
            status: 'skipped',
            synced: false,
            reason: 'account_disabled',
            message: '账号已禁用，跳过同步',
            created: 0,
            updated: 0,
            maskedPending: 0,
          });
          continue;
        }

        const tokenValue = String(row.account.accessToken || row.account.apiToken || '').trim();
        if (!tokenValue) {
          results.push({
            accountId: row.account.id,
            accountName: row.account.username || '',
            status: 'skipped',
            synced: false,
            reason: 'missing_credential',
            message: '账号缺少可用凭证，跳过同步',
            created: 0,
            updated: 0,
            maskedPending: 0,
          });
          continue;
        }
        if (isMaskedSecretValue(tokenValue)) {
          results.push({
            accountId: row.account.id,
            accountName: row.account.username || '',
            status: 'skipped',
            synced: false,
            reason: 'upstream_masked_tokens',
            message: '当前仅有脱敏凭证，无法自动同步令牌',
            created: 0,
            updated: 0,
            maskedPending: 1,
          });
          continue;
        }

        const existing = await db
          .select()
          .from(schema.accountTokens)
          .where(eq(schema.accountTokens.accountId, row.account.id))
          .all();

        let created = 0;
        let updated = 0;
        let defaultToken = existing.find((item) => item.isDefault);
        if (!defaultToken) {
          defaultToken = existing[0];
          if (defaultToken) {
            await db.update(schema.accountTokens).set({
              isDefault: true,
              enabled: true,
              updatedAt: formatUtcSqlDateTime(),
            }).where(eq(schema.accountTokens.id, defaultToken.id)).run();
            updated += 1;
          }
        }

        if (!defaultToken) {
          const inserted = await db.insert(schema.accountTokens).values({
            accountId: row.account.id,
            name: `${row.account.username || `account-${row.account.id}`}-default`,
            token: tokenValue,
            source: 'account_sync',
            enabled: true,
            isDefault: true,
            valueStatus: 'ready',
            createdAt: formatUtcSqlDateTime(),
            updatedAt: formatUtcSqlDateTime(),
          }).returning({ id: schema.accountTokens.id }).get();
          if (inserted?.id) created += 1;
        }

        results.push({
          accountId: row.account.id,
          accountName: row.account.username || '',
          status: 'success',
          synced: true,
          message: created > 0
            ? `同步完成：新增 ${created}，更新 ${updated}`
            : `同步完成：新增 0，更新 ${updated}`,
          created,
          updated,
          maskedPending: 0,
        });
      }

      const summary = {
        synced: results.filter((item) => String(item.status) === 'success').length,
        skipped: results.filter((item) => String(item.status) === 'skipped').length,
        failed: results.filter((item) => String(item.status) === 'failed').length,
      };
      return {
        summary,
        results,
        message: `全部同步完成：成功 ${summary.synced}，跳过 ${summary.skipped}，失败 ${summary.failed}`,
      };
    };

    if (wait) {
      const result = await executeSyncAll();
      return _c.json({
        success: true,
        queued: false,
        ...result,
      });
    }

    const dedupeKey = 'sync-all-account-tokens';
    const taskType = 'account-token-sync-all';
    const runningTask = [...cloudflareTaskStore.values()].find((task) => (
      task.type === taskType
      && String(task.dedupeKey || '') === dedupeKey
      && (task.status === 'pending' || task.status === 'running')
    ));
    if (runningTask) {
      return _c.json({
        success: true,
        queued: true,
        reused: true,
        jobId: runningTask.id,
        taskId: runningTask.id,
        status: runningTask.status,
        message: '令牌同步任务执行中，请稍后查看程序日志',
      }, 202);
    }

    const task = createCloudflareTask({
      type: taskType,
      dedupeKey,
      title: '同步全部账号令牌',
      status: 'running',
      message: '正在同步全部账号令牌',
    });

    const run = (async () => {
      try {
        const result = await executeSyncAll();
        updateCloudflareTask(task.id, {
          status: 'succeeded',
          message: result.message,
          result,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '全部账号令牌同步失败';
        updateCloudflareTask(task.id, {
          status: 'failed',
          message,
          error: message,
        });
      }
    })();
    _c.executionCtx.waitUntil(run);

    return _c.json({
      success: true,
      queued: true,
      reused: false,
      jobId: task.id,
      taskId: task.id,
      status: task.status,
      message: '已开始全部账号令牌同步，请稍后查看程序日志',
    }, 202);
  });

  app.post('/api/routes/:id/channels/batch', async (c) => {
    const db = getCloudflareDb(c);
    const routeId = Math.trunc(Number(c.req.param('id')));
    if (!Number.isFinite(routeId) || routeId <= 0) return c.json({ success: false, message: 'routeId 无效' }, 400);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const channels = Array.isArray(body.channels) ? body.channels : [];
    const inserted: unknown[] = [];
    for (const rawChannel of channels) {
      const item = rawChannel as Record<string, unknown>;
      const accountId = Math.trunc(Number(item.accountId));
      const tokenId = item.tokenId == null ? null : Math.trunc(Number(item.tokenId));
      const sourceModel = typeof item.sourceModel === 'string' ? item.sourceModel.trim() : '';
      if (!Number.isFinite(accountId) || accountId <= 0) continue;
      const row = await db.insert(schema.routeChannels).values({
        routeId,
        accountId,
        tokenId: tokenId && tokenId > 0 ? tokenId : null,
        sourceModel: sourceModel || null,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: true,
      }).returning().get();
      inserted.push(row);
    }
    return c.json({ success: true, channels: inserted });
  });

  app.post('/api/search', async (c) => {
    const db = getCloudflareDb(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const query = String(body.query || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(100, Number.isFinite(Number(body.limit)) ? Math.trunc(Number(body.limit)) : 20));
    if (!query) return c.json({ items: [] });
    const [sites, accounts, routes] = await Promise.all([
      db.select().from(schema.sites).all(),
      db.select().from(schema.accounts).all(),
      db.select().from(schema.tokenRoutes).all(),
    ]);
    const items: Array<Record<string, unknown>> = [];
    for (const site of sites) {
      const haystack = [site.name, site.url, site.platform].join(' ').toLowerCase();
      if (!haystack.includes(query)) continue;
      items.push({
        type: 'site',
        id: site.id,
        title: site.name,
        subtitle: `${site.platform} · ${site.url}`,
      });
    }
    for (const account of accounts) {
      const haystack = [account.username || '', account.oauthAccountKey || '', account.oauthProvider || ''].join(' ').toLowerCase();
      if (!haystack.includes(query)) continue;
      items.push({
        type: 'account',
        id: account.id,
        title: account.username || `account-${account.id}`,
        subtitle: account.oauthProvider || account.status || '',
      });
    }
    for (const route of routes) {
      const haystack = [route.modelPattern, route.displayName || ''].join(' ').toLowerCase();
      if (!haystack.includes(query)) continue;
      items.push({
        type: 'route',
        id: route.id,
        title: route.displayName || route.modelPattern,
        subtitle: route.modelPattern,
      });
    }
    return c.json({ items: items.slice(0, limit) });
  });

  app.get('/api/settings/backup/export', async (c) => {
    const db = getCloudflareDb(c);
    const rawType = String(c.req.query('type') || 'all').trim().toLowerCase();
    const type = normalizeBackupExportType(rawType, 'all');
    if (rawType && !['all', 'accounts', 'preferences'].includes(rawType)) {
      return c.json({ success: false, message: '导出类型无效，仅支持 all/accounts/preferences' }, 400);
    }
    const payload = await buildCloudflareBackupExportPayload(db, type);
    return c.json(payload);
  });

  app.post('/api/settings/backup/import', async (c) => {
    const db = getCloudflareDb(c);
    const parsedBody = parseBackupImportPayload(await c.req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return c.json({ success: false, message: parsedBody.error }, 400);
    }
    try {
      const result = await applyCloudflareBackupImport(db, parsedBody.data);
      return c.json(result);
    } catch (error: unknown) {
      return c.json({ success: false, message: error instanceof Error ? error.message : '导入失败' }, 400);
    }
  });

  app.get('/api/settings/backup/webdav', async (c) => {
    const db = getCloudflareDb(c);
    const [config, state] = await Promise.all([
      loadCloudflareBackupWebdavConfig(db),
      loadCloudflareBackupWebdavState(db),
    ]);
    return c.json({
      success: true,
      config: {
        enabled: config.enabled,
        fileUrl: config.fileUrl,
        username: config.username,
        hasPassword: config.password.length > 0,
        passwordMasked: config.password ? '****' : '',
        exportType: config.exportType,
        autoSyncEnabled: config.autoSyncEnabled,
        autoSyncCron: config.autoSyncCron,
      },
      state,
    });
  });

  app.put('/api/settings/backup/webdav', async (c) => {
    const db = getCloudflareDb(c);
    const parsedBody = parseBackupWebdavConfigPayload(await c.req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return c.json({ success: false, message: parsedBody.error }, 400);
    }
    const body = parsedBody.data;
    const current = await loadCloudflareBackupWebdavConfig(db);
    const next: CloudflareBackupWebdavConfig = {
      enabled: body.enabled === undefined ? current.enabled : body.enabled === true,
      fileUrl: body.fileUrl === undefined ? current.fileUrl : String(body.fileUrl || '').trim(),
      username: body.username === undefined ? current.username : String(body.username || '').trim(),
      password: body.clearPassword
        ? ''
        : (body.password === undefined
          ? current.password
          : String(body.password || '')),
      exportType: body.exportType === undefined
        ? current.exportType
        : normalizeBackupExportType(body.exportType, current.exportType),
      autoSyncEnabled: body.autoSyncEnabled === undefined
        ? current.autoSyncEnabled
        : body.autoSyncEnabled === true,
      autoSyncCron: body.autoSyncCron === undefined
        ? current.autoSyncCron
        : (String(body.autoSyncCron || '').trim() || CLOUDFLARE_BACKUP_WEBDAV_DEFAULT_AUTO_SYNC_CRON),
    };
    if (!next.enabled) {
      next.autoSyncEnabled = false;
    }
    try {
      validateCloudflareBackupWebdavConfig(next);
    } catch (error: unknown) {
      return c.json({ success: false, message: error instanceof Error ? error.message : 'WebDAV 配置保存失败' }, 400);
    }

    await writeSetting(db, CLOUDFLARE_BACKUP_WEBDAV_CONFIG_KEY, next);
    const state = await loadCloudflareBackupWebdavState(db);
    return c.json({
      success: true,
      config: {
        enabled: next.enabled,
        fileUrl: next.fileUrl,
        username: next.username,
        hasPassword: next.password.length > 0,
        passwordMasked: next.password ? '****' : '',
        exportType: next.exportType,
        autoSyncEnabled: next.autoSyncEnabled,
        autoSyncCron: next.autoSyncCron,
      },
      state,
    });
  });

  app.post('/api/settings/backup/webdav/export', async (c) => {
    const db = getCloudflareDb(c);
    const parsedBody = parseBackupWebdavExportPayload(await c.req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return c.json({ success: false, message: parsedBody.error }, 400);
    }
    const config = await loadCloudflareBackupWebdavConfig(db);
    try {
      validateCloudflareBackupWebdavConfig(config);
      if (!config.enabled) throw new Error('WebDAV 备份未启用');
      if (!config.fileUrl) throw new Error('WebDAV 文件地址不能为空');

      const type = parsedBody.data.type
        ? normalizeBackupExportType(parsedBody.data.type, config.exportType)
        : config.exportType;
      const payload = await buildCloudflareBackupExportPayload(db, type);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const authHeader = resolveCloudflareBackupWebdavAuthHeader(config);
      if (authHeader) headers.Authorization = authHeader;
      const response = await fetchCloudflareWebdav(config.fileUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload, null, 2),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`WebDAV 导出失败：HTTP ${response.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
      }

      const syncedAt = new Date().toISOString();
      await writeCloudflareBackupWebdavState(db, {
        lastSyncAt: syncedAt,
        lastError: null,
      });
      return c.json({
        success: true,
        fileUrl: config.fileUrl,
        exportType: type,
        syncedAt,
        lastSyncAt: syncedAt,
        lastError: null,
      });
    } catch (error: unknown) {
      const previousState = await loadCloudflareBackupWebdavState(db);
      const message = error instanceof Error ? error.message : 'WebDAV 导出失败';
      await writeCloudflareBackupWebdavState(db, {
        lastSyncAt: previousState.lastSyncAt,
        lastError: message,
      });
      return c.json({ success: false, message }, 400);
    }
  });

  app.post('/api/settings/backup/webdav/import', async (c) => {
    const db = getCloudflareDb(c);
    const config = await loadCloudflareBackupWebdavConfig(db);
    try {
      validateCloudflareBackupWebdavConfig(config);
      if (!config.enabled) throw new Error('WebDAV 备份未启用');
      if (!config.fileUrl) throw new Error('WebDAV 文件地址不能为空');

      const headers: Record<string, string> = {};
      const authHeader = resolveCloudflareBackupWebdavAuthHeader(config);
      if (authHeader) headers.Authorization = authHeader;
      const response = await fetchCloudflareWebdav(config.fileUrl, {
        method: 'GET',
        headers,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`WebDAV 导入失败：HTTP ${response.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
      }
      const raw = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('WebDAV 导入失败：远端文件不是合法 JSON');
      }

      const result = await applyCloudflareBackupImport(db, parsed);
      const syncedAt = new Date().toISOString();
      await writeCloudflareBackupWebdavState(db, {
        lastSyncAt: syncedAt,
        lastError: null,
      });
      return c.json({
        ...result,
        fileUrl: config.fileUrl,
        syncedAt,
        lastSyncAt: syncedAt,
        lastError: null,
      });
    } catch (error: unknown) {
      const previousState = await loadCloudflareBackupWebdavState(db);
      const message = error instanceof Error ? error.message : 'WebDAV 导入失败';
      await writeCloudflareBackupWebdavState(db, {
        lastSyncAt: previousState.lastSyncAt,
        lastError: message,
      });
      return c.json({ success: false, message }, 400);
    }
  });

  app.post('/api/test/chat', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const validated = validateLegacyTestChatPayload(body);
    if (!validated.ok) {
      return c.json({ error: { message: validated.message, type: 'validation_error' } }, validated.status as never);
    }
    const envelope = convertLegacyPayloadToProxyEnvelope(validated.payload, false);
    const { response } = await executeProxyTesterRequest(c, envelope, false);
    const payload = await parseProxyResponsePayload(response);
    if (!response.ok) return c.json(payload, response.status as never);
    return c.json(payload);
  });

  app.post('/api/test/chat/jobs', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const validated = validateLegacyTestChatPayload(body);
    if (!validated.ok) {
      return c.json({ error: { message: validated.message, type: 'validation_error' } }, validated.status as never);
    }

    const task = createCloudflareTask({
      type: 'test-chat',
      title: '测试聊天',
      status: 'running',
      message: '请求执行中',
    });

    try {
      const envelope = convertLegacyPayloadToProxyEnvelope(validated.payload, false);
      const { response } = await executeProxyTesterRequest(c, envelope, false);
      const payload = await parseProxyResponsePayload(response);
      if (response.ok) {
        updateCloudflareTask(task.id, {
          status: 'succeeded',
          message: '测试完成',
          result: payload,
          error: null,
        });
      } else {
        updateCloudflareTask(task.id, {
          status: 'failed',
          message: `测试失败（${response.status}）`,
          result: undefined,
          error: payload,
        });
      }
    } catch (error: unknown) {
      updateCloudflareTask(task.id, {
        status: 'failed',
        message: '测试失败',
        result: undefined,
        error: {
          error: {
            message: error instanceof Error ? error.message : 'proxy request failed',
            type: 'server_error',
          },
        },
      });
    }

    const current = cloudflareTaskStore.get(task.id) || task;
    return c.json({
      jobId: current.id,
      status: current.status,
      result: current.result,
      error: current.error,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      expiresAt: null,
    });
  });

  app.get('/api/test/chat/jobs/:jobId', async (c) => {
    const jobId = String(c.req.param('jobId') || '').trim();
    const task = cloudflareTaskStore.get(jobId);
    if (!task) return c.json({ success: false, message: 'job 不存在' }, 404);
    return c.json({
      jobId: task.id,
      status: task.status,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      expiresAt: null,
    });
  });

  app.delete('/api/test/chat/jobs/:jobId', async (c) => {
    const jobId = String(c.req.param('jobId') || '').trim();
    cloudflareTaskStore.delete(jobId);
    return c.json({ success: true });
  });

  app.post('/api/test/proxy', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const validated = validateProxyEnvelopeInput(body);
    if (!validated.ok) {
      return c.json({ error: { message: validated.message, type: 'validation_error' } }, validated.status as never);
    }
    const { response, durationMs } = await executeProxyTesterRequest(c, validated.envelope, false);
    const payload = await parseProxyResponsePayload(response);
    if (!response.ok) return c.json(payload, response.status as never);
    c.header('x-metapi-test-duration-ms', String(durationMs));
    return c.json(payload);
  });

  app.post('/api/test/proxy/jobs', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const validated = validateProxyEnvelopeInput(body);
    if (!validated.ok) {
      return c.json({ error: { message: validated.message, type: 'validation_error' } }, validated.status as never);
    }

    const task = createCloudflareTask({
      type: 'test-proxy',
      title: '代理测试',
      status: 'running',
      message: '请求执行中',
    });

    let durationMs: number | null = null;
    try {
      const execution = await executeProxyTesterRequest(c, validated.envelope, !!validated.envelope.stream);
      durationMs = execution.durationMs;
      const payload = await parseProxyResponsePayload(execution.response);
      if (execution.response.ok) {
        updateCloudflareTask(task.id, {
          status: 'succeeded',
          message: '测试完成',
          result: payload,
          error: null,
        });
      } else {
        updateCloudflareTask(task.id, {
          status: 'failed',
          message: `测试失败（${execution.response.status}）`,
          result: undefined,
          error: payload,
        });
      }
    } catch (error: unknown) {
      updateCloudflareTask(task.id, {
        status: 'failed',
        message: '测试失败',
        result: undefined,
        error: {
          error: {
            message: error instanceof Error ? error.message : 'proxy request failed',
            type: 'server_error',
          },
        },
      });
    }

    const current = cloudflareTaskStore.get(task.id) || task;
    return c.json({
      jobId: current.id,
      status: current.status,
      result: current.result,
      error: current.error,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      expiresAt: null,
      durationMs,
    });
  });

  app.get('/api/test/proxy/jobs/:jobId', async (c) => {
    const jobId = String(c.req.param('jobId') || '').trim();
    const task = cloudflareTaskStore.get(jobId);
    if (!task) return c.json({ success: false, message: 'job 不存在' }, 404);
    return c.json({
      jobId: task.id,
      status: task.status,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      expiresAt: null,
    });
  });

  app.delete('/api/test/proxy/jobs/:jobId', async (c) => {
    const jobId = String(c.req.param('jobId') || '').trim();
    cloudflareTaskStore.delete(jobId);
    return c.json({ success: true });
  });

  app.post('/api/test/proxy/stream', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const validated = validateProxyEnvelopeInput(body);
    if (!validated.ok) {
      return c.json({ error: { message: validated.message, type: 'validation_error' } }, validated.status as never);
    }
    const { response } = await executeProxyTesterRequest(c, validated.envelope, true);
    if (!response.ok) {
      const payload = await parseProxyResponsePayload(response);
      return c.json(payload, response.status as never);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream') && response.body) {
      return new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
    }

    const text = await response.text();
    const streamBody = [
      ...text.split(/\r?\n/).map((line) => `data: ${line}`),
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(streamBody, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  app.post('/api/test/chat/stream', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const validated = validateLegacyTestChatPayload(body);
    if (!validated.ok) {
      return c.json({ error: { message: validated.message, type: 'validation_error' } }, validated.status as never);
    }

    const envelope = convertLegacyPayloadToProxyEnvelope(validated.payload, true);
    const { response } = await executeProxyTesterRequest(c, envelope, true);
    if (!response.ok) {
      const payload = await parseProxyResponsePayload(response);
      return c.json(payload, response.status as never);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream') && response.body) {
      return new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
    }

    const text = await response.text();
    const streamBody = [
      ...text.split(/\r?\n/).map((line) => `data: ${line}`),
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(streamBody, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  app.get('/api/events', async (c) => {
    const db = getCloudflareDb(c);
    const limit = Math.max(1, Math.min(500, normalizePositiveInt(c.req.query('limit'), 30)));
    const offset = Math.max(0, normalizePositiveInt(c.req.query('offset'), 0));
    const type = (c.req.query('type') || '').trim();
    const readFlag = (c.req.query('read') || '').trim().toLowerCase();
    let whereClause:
      | ReturnType<typeof eq>
      | ReturnType<typeof and>
      | undefined;
    if (type) whereClause = eq(schema.events.type, type);
    if (readFlag === 'true') {
      const readCondition = eq(schema.events.read, true);
      whereClause = whereClause ? and(whereClause, readCondition) : readCondition;
    }
    if (readFlag === 'false') {
      const unreadCondition = eq(schema.events.read, false);
      whereClause = whereClause ? and(whereClause, unreadCondition) : unreadCondition;
    }

    const base = db.select().from(schema.events);
    if (whereClause) {
      const rows = await base
        .where(whereClause)
        .orderBy(desc(schema.events.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
      return c.json(rows);
    }

    const rows = await base
      .orderBy(desc(schema.events.createdAt))
      .limit(limit)
      .offset(offset)
      .all();
    return c.json(rows);
  });

  app.get('/api/events/count', async (c) => {
    const db = getCloudflareDb(c);
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.events)
      .where(eq(schema.events.read, false))
      .get();
    return c.json({ count: Math.trunc(toFiniteNumber(result?.count)) });
  });

  app.post('/api/events/:id/read', async (c) => {
    const db = getCloudflareDb(c);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ success: false, message: 'Invalid event id' }, 400);
    }

    await db
      .update(schema.events)
      .set({ read: true })
      .where(eq(schema.events.id, id))
      .run();

    return c.json({ success: true });
  });

  app.post('/api/events/read-all', async (c) => {
    const db = getCloudflareDb(c);
    await db
      .update(schema.events)
      .set({ read: true })
      .where(eq(schema.events.read, false))
      .run();
    return c.json({ success: true });
  });

  app.delete('/api/events', async (c) => {
    const db = getCloudflareDb(c);
    await db.delete(schema.events).run();
    return c.json({ success: true });
  });
}

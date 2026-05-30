import { Hono } from 'hono';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import * as schema from '../../server/db/schema.js';
import {
  getCloudflareDb,
  sanitizeCloudflareSettingSnapshot,
  type CloudflareHonoEnv,
} from '../shared/http.js';

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

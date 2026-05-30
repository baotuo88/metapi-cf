import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../../server/db/schema.js';
import { normalizeTokenRouteMode } from '../../shared/tokenRouteContract.js';
import {
  isExactTokenRouteModelPattern,
  matchesTokenRouteModelPattern,
} from '../../shared/tokenRoutePatterns.js';
import type { CloudflareD1Db } from '../db/d1.js';
import type { CloudflareHonoEnv } from '../shared/http.js';
import type { CloudflareProxyAuthContext, DownstreamRoutingPolicy } from './auth.js';

type EnabledRouteRow = {
  id: number;
  modelPattern: string;
  displayName: string | null;
  routeMode: string | null;
  modelMapping: string | null;
  sourceRouteIds: number[];
};

type RouteChannelRow = {
  channelId: number;
  routeId: number;
  channelTokenId: number | null;
  channelSourceModel: string | null;
  channelPriority: number | null;
  channelEnabled: boolean | null;
  channelCooldownUntil: string | null;
  accountId: number;
  accountStatus: string | null;
  accountAccessToken: string | null;
  accountApiToken: string | null;
  siteId: number;
  siteStatus: string | null;
  siteUrl: string;
  tokenId: number | null;
  tokenValue: string | null;
  tokenName: string | null;
  tokenEnabled: boolean | null;
  tokenValueStatus: string | null;
};

type SelectedUpstream = {
  routeId: number;
  channelId: number;
  upstreamBaseUrl: string;
  upstreamToken: string;
  actualModel: string;
};

type PreparedProxyRequest =
  | {
    requestedModel: string;
    buildBody(selectedModel: string): {
      body: BodyInit | null;
      contentType?: string;
    };
  }
  | null;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function isMaskedTokenValue(value: string): boolean {
  return value.includes('*') || value.includes('•');
}

function isReadyAccountToken(row: RouteChannelRow): boolean {
  const token = normalizeString(row.tokenValue);
  if (!token || isMaskedTokenValue(token)) return false;
  const valueStatus = normalizeString(row.tokenValueStatus).toLowerCase();
  if (valueStatus === 'masked_pending') return false;
  return normalizeBoolean(row.tokenEnabled);
}

function isExplicitTokenChannel(row: RouteChannelRow): boolean {
  return typeof row.channelTokenId === 'number' && row.channelTokenId > 0;
}

function resolveChannelToken(row: RouteChannelRow): string | null {
  if (isExplicitTokenChannel(row)) {
    if (!isReadyAccountToken(row)) return null;
    return normalizeString(row.tokenValue) || null;
  }
  const accessToken = normalizeString(row.accountAccessToken);
  if (accessToken) return accessToken;
  const apiToken = normalizeString(row.accountApiToken);
  return apiToken || null;
}

function isRouteChannelAllowedByPolicy(row: RouteChannelRow, policy: DownstreamRoutingPolicy): boolean {
  const excludedSiteIds = Array.isArray(policy.excludedSiteIds) ? policy.excludedSiteIds : [];
  if (excludedSiteIds.includes(row.siteId)) return false;

  const excludedCredentialRefs = Array.isArray(policy.excludedCredentialRefs)
    ? policy.excludedCredentialRefs
    : [];
  if (excludedCredentialRefs.length <= 0) return true;

  for (const ref of excludedCredentialRefs) {
    if (ref.kind === 'account_token') {
      if (
        row.channelTokenId
        && row.channelTokenId === ref.tokenId
        && row.siteId === ref.siteId
        && row.accountId === ref.accountId
      ) {
        return false;
      }
      continue;
    }
    if (
      ref.kind === 'default_api_key'
      && !row.channelTokenId
      && row.siteId === ref.siteId
      && row.accountId === ref.accountId
    ) {
      return false;
    }
  }
  return true;
}

type ParsedModelMapping = {
  exact: Map<string, string>;
  patterns: Array<{ pattern: string; target: string }>;
};

function parseModelMapping(rawValue: string | null): ParsedModelMapping {
  const exact = new Map<string, string>();
  const patterns: Array<{ pattern: string; target: string }> = [];
  const payload = normalizeString(rawValue);
  if (!payload) {
    return { exact, patterns };
  }
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exact, patterns };
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const source = normalizeString(key);
      const target = normalizeString(value);
      if (source && target) {
        if (isExactTokenRouteModelPattern(source)) {
          exact.set(source, target);
        } else {
          patterns.push({ pattern: source, target });
        }
      }
    }
  } catch {
    return { exact, patterns };
  }
  return { exact, patterns };
}

function resolveMappedModel(requestedModel: string, mapping: ParsedModelMapping): string | null {
  const exactMatched = mapping.exact.get(requestedModel);
  if (exactMatched) return exactMatched;

  for (const candidate of mapping.patterns) {
    if (matchesTokenRouteModelPattern(requestedModel, candidate.pattern)) {
      return candidate.target;
    }
  }
  return null;
}

function resolveActualModel(
  requestedModel: string,
  route: EnabledRouteRow,
  sourceRoute: EnabledRouteRow,
  channel: RouteChannelRow,
): string {
  const mapping = parseModelMapping(route.modelMapping);
  const mapped = resolveMappedModel(requestedModel, mapping);
  if (mapped) return mapped;
  const sourceModel = normalizeString(channel.channelSourceModel);
  if (sourceModel) return sourceModel;
  if (sourceRoute.id !== route.id && isExactTokenRouteModelPattern(sourceRoute.modelPattern)) {
    return normalizeString(sourceRoute.modelPattern) || requestedModel;
  }
  return requestedModel;
}

function modelMatchesRoute(model: string, route: EnabledRouteRow): boolean {
  const requested = normalizeString(model);
  if (!requested) return false;
  const routeMode = normalizeTokenRouteMode(route.routeMode);
  const displayName = normalizeString(route.displayName);
  if (displayName && requested === displayName) return true;

  if (routeMode === 'explicit_group') return false;
  return matchesTokenRouteModelPattern(requested, normalizeString(route.modelPattern));
}

function matchesPolicyModelPattern(model: string, pattern: string): boolean {
  const normalizedPattern = normalizeString(pattern);
  if (!normalizedPattern) return false;
  return matchesTokenRouteModelPattern(model, normalizedPattern);
}

function isModelAllowedByPolicyForRoute(
  model: string,
  routeId: number,
  policy: DownstreamRoutingPolicy,
): boolean {
  const patterns = Array.isArray(policy.supportedModels) ? policy.supportedModels : [];
  const allowedRouteIds = Array.isArray(policy.allowedRouteIds) ? policy.allowedRouteIds : [];
  const hasPatternRules = patterns.length > 0;
  const hasRouteRules = allowedRouteIds.length > 0;

  if (!hasPatternRules && !hasRouteRules) {
    return policy.denyAllWhenEmpty === true ? false : true;
  }

  if (hasPatternRules && patterns.some((pattern) => matchesPolicyModelPattern(model, pattern))) {
    return true;
  }

  if (hasRouteRules && allowedRouteIds.includes(routeId)) {
    return true;
  }

  return false;
}

function getExposedRouteName(route: EnabledRouteRow): string {
  const displayName = normalizeString(route.displayName);
  if (displayName) return displayName;
  return normalizeString(route.modelPattern);
}

function isExposedModelName(name: string): boolean {
  if (!name) return false;
  if (name.startsWith('__')) return false;
  return isExactTokenRouteModelPattern(name);
}

function buildUpstreamUrl(siteUrl: string, requestPath: string): string {
  const baseRaw = normalizeString(siteUrl);
  const pathRaw = normalizeString(requestPath);
  const fallbackBase = baseRaw.replace(/\/+$/, '');
  let path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;

  if (!fallbackBase) return path || '/';
  if (!path || path === '/') return fallbackBase;

  try {
    const parsed = new URL(baseRaw);
    const basePath = parsed.pathname.replace(/\/+$/, '');
    const baseHasVersionSuffix = /\/(?:api\/)?v1$/i.test(basePath);
    if (baseHasVersionSuffix) {
      if (path === '/v1') {
        path = '/';
      } else if (path.startsWith('/v1/')) {
        path = path.slice('/v1'.length) || '/';
      }
    }

    const joinedPath = basePath
      ? `${basePath}${path.startsWith('/') ? path : `/${path}`}`
      : path;
    return `${parsed.protocol}//${parsed.host}${joinedPath}${parsed.search}${parsed.hash}`;
  } catch {
    const baseHasVersionSuffix = /\/(?:api\/)?v1$/i.test(fallbackBase);
    if (baseHasVersionSuffix) {
      if (path === '/v1') {
        path = '/';
      } else if (path.startsWith('/v1/')) {
        path = path.slice('/v1'.length) || '/';
      }
    }
    return `${fallbackBase}${path}`;
  }
}

async function loadEnabledRoutes(db: CloudflareD1Db): Promise<EnabledRouteRow[]> {
  const groupSources = await db.select({
    groupRouteId: schema.routeGroupSources.groupRouteId,
    sourceRouteId: schema.routeGroupSources.sourceRouteId,
  }).from(schema.routeGroupSources).all();
  const sourceRouteIdsByGroupId = new Map<number, number[]>();
  for (const row of groupSources) {
    if (!sourceRouteIdsByGroupId.has(row.groupRouteId)) {
      sourceRouteIdsByGroupId.set(row.groupRouteId, []);
    }
    sourceRouteIdsByGroupId.get(row.groupRouteId)!.push(row.sourceRouteId);
  }

  const rows = await db.select({
    id: schema.tokenRoutes.id,
    modelPattern: schema.tokenRoutes.modelPattern,
    displayName: schema.tokenRoutes.displayName,
    routeMode: schema.tokenRoutes.routeMode,
    modelMapping: schema.tokenRoutes.modelMapping,
  }).from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.enabled, true))
    .orderBy(asc(schema.tokenRoutes.id))
    .all();

  return rows.map((row) => ({
    id: row.id,
    modelPattern: row.modelPattern || '',
    displayName: row.displayName ?? null,
    routeMode: row.routeMode ?? null,
    modelMapping: row.modelMapping ?? null,
    sourceRouteIds: sourceRouteIdsByGroupId.get(row.id) || [],
  }));
}

async function loadRouteChannels(db: CloudflareD1Db, routeId: number): Promise<RouteChannelRow[]> {
  const rows = await db.select({
    channelId: schema.routeChannels.id,
    routeId: schema.routeChannels.routeId,
    channelTokenId: schema.routeChannels.tokenId,
    channelSourceModel: schema.routeChannels.sourceModel,
    channelPriority: schema.routeChannels.priority,
    channelEnabled: schema.routeChannels.enabled,
    channelCooldownUntil: schema.routeChannels.cooldownUntil,
    accountId: schema.accounts.id,
    accountStatus: schema.accounts.status,
    accountAccessToken: schema.accounts.accessToken,
    accountApiToken: schema.accounts.apiToken,
    siteId: schema.sites.id,
    siteStatus: schema.sites.status,
    siteUrl: schema.sites.url,
    tokenId: schema.accountTokens.id,
    tokenValue: schema.accountTokens.token,
    tokenName: schema.accountTokens.name,
    tokenEnabled: schema.accountTokens.enabled,
    tokenValueStatus: schema.accountTokens.valueStatus,
  }).from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(and(
      eq(schema.routeChannels.routeId, routeId),
      eq(schema.routeChannels.enabled, true),
    ))
    .orderBy(asc(schema.routeChannels.priority), asc(schema.routeChannels.id))
    .all();

  return rows;
}

function isChannelUsable(row: RouteChannelRow, policy: DownstreamRoutingPolicy, nowIso: string): boolean {
  if (!normalizeBoolean(row.channelEnabled)) return false;
  if (row.channelCooldownUntil && row.channelCooldownUntil > nowIso) return false;
  if (!normalizeString(row.siteUrl)) return false;
  if (normalizeString(row.siteStatus).toLowerCase() !== 'active') return false;

  if (isExplicitTokenChannel(row)) {
    if (normalizeString(row.accountStatus).toLowerCase() === 'disabled') return false;
  } else if (normalizeString(row.accountStatus).toLowerCase() !== 'active') {
    return false;
  }

  if (!isRouteChannelAllowedByPolicy(row, policy)) return false;

  return Boolean(resolveChannelToken(row));
}

async function selectUpstreamTarget(input: {
  db: CloudflareD1Db;
  requestedModel: string;
  policy: DownstreamRoutingPolicy;
  nowIso?: string;
}): Promise<SelectedUpstream | null> {
  const nowIso = input.nowIso || new Date().toISOString();
  const routes = await loadEnabledRoutes(input.db);
  const routeById = new Map<number, EnabledRouteRow>(routes.map((route) => [route.id, route]));
  const routeCandidates = routes.filter((route) => modelMatchesRoute(input.requestedModel, route))
    .filter((route) => isModelAllowedByPolicyForRoute(input.requestedModel, route.id, input.policy))
    .map((route) => {
      const routeMode = normalizeTokenRouteMode(route.routeMode);
      if (routeMode !== 'explicit_group' || route.sourceRouteIds.length <= 0) {
        return {
          exposedRoute: route,
          sourceRoutes: [route],
        };
      }

      const sourceRoutes = route.sourceRouteIds
        .map((sourceId) => routeById.get(sourceId))
        .filter((item): item is EnabledRouteRow => Boolean(item))
        .filter((item) => normalizeTokenRouteMode(item.routeMode) !== 'explicit_group');
      if (sourceRoutes.length <= 0) {
        return {
          exposedRoute: route,
          sourceRoutes: [route],
        };
      }
      return {
        exposedRoute: route,
        sourceRoutes,
      };
    });

  for (const routeCandidate of routeCandidates) {
    for (const sourceRoute of routeCandidate.sourceRoutes) {
      const channels = await loadRouteChannels(input.db, sourceRoute.id);
      for (const channel of channels) {
        if (!isChannelUsable(channel, input.policy, nowIso)) continue;
        const upstreamToken = resolveChannelToken(channel);
        if (!upstreamToken) continue;
        return {
          routeId: routeCandidate.exposedRoute.id,
          channelId: channel.channelId,
          upstreamBaseUrl: normalizeString(channel.siteUrl),
          upstreamToken,
          actualModel: resolveActualModel(
            input.requestedModel,
            routeCandidate.exposedRoute,
            sourceRoute,
            channel,
          ),
        };
      }
    }
  }

  return null;
}

function wantsClaudeModelListFormat(headers: Headers): boolean {
  return Boolean(headers.get('anthropic-version') || headers.get('x-api-key'));
}

function isJsonContentType(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.includes('application/json') || normalized.endsWith('+json');
}

function isFormContentType(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.includes('multipart/form-data')
    || normalized.includes('application/x-www-form-urlencoded');
}

async function prepareProxyRequestBody(request: Request): Promise<PreparedProxyRequest> {
  const contentType = request.headers.get('content-type') || '';
  if (isJsonContentType(contentType)) {
    try {
      const body = await request.clone().json();
      const parsed = body && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown>
        : {};
      const requestedModel = normalizeString(parsed.model);
      return {
        requestedModel,
        buildBody(selectedModel: string) {
          return {
            body: JSON.stringify({
              ...parsed,
              model: selectedModel,
            }),
            contentType: 'application/json',
          };
        },
      };
    } catch {
      return null;
    }
  }

  if (isFormContentType(contentType)) {
    try {
      const formData = await request.clone().formData();
      const requestedModel = normalizeString(formData.get('model'));
      return {
        requestedModel,
        buildBody(selectedModel: string) {
          const clonedFormData = new FormData();
          for (const [key, value] of formData.entries()) {
            clonedFormData.append(key, value);
          }
          clonedFormData.set('model', selectedModel);

          if (contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
            const params = new URLSearchParams();
            for (const [key, value] of clonedFormData.entries()) {
              if (typeof value === 'string') {
                params.append(key, value);
              } else {
                params.append(key, value.name);
              }
            }
            return {
              body: params,
              contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
            };
          }

          return {
            body: clonedFormData,
          };
        },
      };
    } catch {
      return null;
    }
  }

  return {
    requestedModel: '',
    buildBody() {
      return {
        body: null,
      };
    },
  };
}

function buildOpenAiModelList(models: string[]) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list' as const,
    data: models.map((id) => ({
      id,
      object: 'model' as const,
      created,
      owned_by: 'metapi',
    })),
  };
}

function buildClaudeModelList(models: string[]) {
  const nowIso = new Date().toISOString();
  const data = models.map((id) => ({
    id,
    type: 'model' as const,
    display_name: id,
    created_at: nowIso,
  }));
  return {
    data,
    first_id: data[0]?.id || null,
    last_id: data[data.length - 1]?.id || null,
    has_more: false,
  };
}

export async function listCloudflareProxyModels(input: {
  db: CloudflareD1Db;
  policy: DownstreamRoutingPolicy;
  headers: Headers;
}): Promise<unknown> {
  const routes = await loadEnabledRoutes(input.db);
  const models = routes
    .map((route) => ({
      routeId: route.id,
      name: getExposedRouteName(route),
    }))
    .filter((item) => isExposedModelName(item.name))
    .filter((item) => isModelAllowedByPolicyForRoute(item.name, item.routeId, input.policy))
    .map((item) => item.name);

  const dedupedSorted = Array.from(new Set(models)).sort((left, right) => left.localeCompare(right));
  if (wantsClaudeModelListFormat(input.headers)) {
    return buildClaudeModelList(dedupedSorted);
  }
  return buildOpenAiModelList(dedupedSorted);
}

export async function forwardCloudflareProxyRequest(input: {
  c: {
    req: { raw: Request };
    env: CloudflareHonoEnv['Bindings'];
  };
  db: CloudflareD1Db;
  auth: CloudflareProxyAuthContext;
}): Promise<Response> {
  const request = input.c.req.raw;
  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname;

  if (request.method.toUpperCase() === 'GET' && pathname === '/v1/models') {
    const payload = await listCloudflareProxyModels({
      db: input.db,
      policy: input.auth.policy,
      headers: request.headers,
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const preparedRequest = await prepareProxyRequestBody(request);
  if (!preparedRequest) {
    return new Response(JSON.stringify({
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
      },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const requestedModel = preparedRequest.requestedModel;
  if (!requestedModel) {
    return new Response(JSON.stringify({
      error: {
        message: 'model is required',
        type: 'invalid_request_error',
      },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const selected = await selectUpstreamTarget({
    db: input.db,
    requestedModel,
    policy: input.auth.policy,
  });

  if (!selected) {
    return new Response(JSON.stringify({
      error: {
        message: 'No available channels for this model',
        type: 'server_error',
      },
    }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const rebasedRequest = preparedRequest.buildBody(selected.actualModel);
  if (!rebasedRequest) {
    return new Response(JSON.stringify({
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
      },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const targetUrl = buildUpstreamUrl(selected.upstreamBaseUrl, pathname) + requestUrl.search;

  const upstreamHeaders = new Headers(request.headers);
  upstreamHeaders.set('authorization', `Bearer ${selected.upstreamToken}`);
  upstreamHeaders.delete('host');
  upstreamHeaders.delete('content-length');
  upstreamHeaders.delete('cf-connecting-ip');
  upstreamHeaders.delete('x-forwarded-for');
  if (rebasedRequest.contentType) {
    upstreamHeaders.set('content-type', rebasedRequest.contentType);
  } else if (!rebasedRequest.body) {
    upstreamHeaders.delete('content-type');
  }

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers: upstreamHeaders,
    body: rebasedRequest.body,
    redirect: 'manual',
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set('x-metapi-cf-route-id', String(selected.routeId));
  responseHeaders.set('x-metapi-cf-channel-id', String(selected.channelId));
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

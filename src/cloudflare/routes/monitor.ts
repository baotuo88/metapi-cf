import type { Context, Hono } from 'hono';
import {
  getCloudflareDb,
  readSetting,
  resolveAdminToken,
  type CloudflareHonoEnv,
} from '../shared/http.js';

const MONITOR_AUTH_COOKIE = 'meta_monitor_auth';
const LDOH_BASE_URL = 'https://ldoh.105117.xyz';
const LDOH_COOKIE_SETTING_KEY = 'monitor_ldoh_cookie';
const LDOH_PROXY_PREFIX = '/monitor-proxy/ldoh';

function parseCookies(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw) return result;
  for (const part of raw.split(';')) {
    const entry = part.trim();
    if (!entry) continue;
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!key) continue;
    result[key] = value;
  }
  return result;
}

function rewriteProxyText(text: string): string {
  return text
    .replaceAll('https://ldoh.105117.xyz/', '/monitor-proxy/ldoh/')
    .replaceAll('https:\\/\\/ldoh.105117.xyz\\/', '\\/monitor-proxy\\/ldoh\\/')
    .replaceAll('src="/', 'src="/monitor-proxy/ldoh/')
    .replaceAll("src='/", "src='/monitor-proxy/ldoh/")
    .replaceAll('href="/', 'href="/monitor-proxy/ldoh/')
    .replaceAll("href='/", "href='/monitor-proxy/ldoh/")
    .replaceAll('action="/', 'action="/monitor-proxy/ldoh/')
    .replaceAll("action='/", "action='/monitor-proxy/ldoh/")
    .replaceAll('"/_next/', '"/monitor-proxy/ldoh/_next/')
    .replaceAll("'/_next/", "'/monitor-proxy/ldoh/_next/")
    .replaceAll('"\\/api/', '"\\/monitor-proxy\\/ldoh\\/api/')
    .replaceAll("'/api/", "'/monitor-proxy/ldoh/api/")
    .replaceAll('"/api/', '"/monitor-proxy/ldoh/api/');
}

function rewriteLocationHeader(location: string | null): string | null {
  if (!location) return null;
  if (location.startsWith(`${LDOH_BASE_URL}/`)) {
    return `${LDOH_PROXY_PREFIX}/${location.slice(LDOH_BASE_URL.length + 1)}`;
  }
  if (location.startsWith('/')) {
    return `${LDOH_PROXY_PREFIX}${location}`;
  }
  return location;
}

function resolveLdohPathname(pathname: string): string {
  if (pathname === LDOH_PROXY_PREFIX || pathname === `${LDOH_PROXY_PREFIX}/`) {
    return '';
  }
  if (pathname.startsWith(`${LDOH_PROXY_PREFIX}/`)) {
    return pathname.slice(LDOH_PROXY_PREFIX.length + 1);
  }
  return '';
}

export function registerMonitorRoutes(app: Hono<CloudflareHonoEnv>) {
  const handleLdohProxy = async (c: Context<CloudflareHonoEnv>) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const expectedToken = await resolveAdminToken(c);
    if (cookies[MONITOR_AUTH_COOKIE] !== expectedToken) {
      return c.json({ error: 'Missing or invalid monitor session' }, 401);
    }

    const db = getCloudflareDb(c);
    const stored = await readSetting(db, LDOH_COOKIE_SETTING_KEY);
    const storedCookie = typeof stored === 'string' ? stored.trim() : '';
    if (!storedCookie) {
      return c.text('LDOH cookie not configured', 400);
    }

    const url = new URL(c.req.url);
    const wildcardPath = resolveLdohPathname(url.pathname);
    const targetUrl = new URL(`${LDOH_BASE_URL}/${wildcardPath}`);
    for (const [key, value] of url.searchParams.entries()) {
      targetUrl.searchParams.set(key, value);
    }

    const upstreamHeaders = new Headers();
    upstreamHeaders.set('cookie', storedCookie);
    upstreamHeaders.set('accept', c.req.header('accept') || '*/*');
    upstreamHeaders.set('accept-language', c.req.header('accept-language') || 'zh-CN,zh;q=0.9,en;q=0.8');
    upstreamHeaders.set('user-agent', c.req.header('user-agent') || 'metapiMonitorProxy/1.0');
    const contentType = c.req.header('content-type');
    if (contentType) upstreamHeaders.set('content-type', contentType);
    const referer = c.req.header('referer');
    if (referer) upstreamHeaders.set('referer', referer.replace(LDOH_PROXY_PREFIX, ''));

    const method = c.req.method.toUpperCase();
    const canHaveBody = method !== 'GET' && method !== 'HEAD';
    const requestBody = canHaveBody ? await c.req.raw.arrayBuffer() : null;

    const upstreamResponse = await fetch(targetUrl.toString(), {
      method,
      headers: upstreamHeaders,
      body: canHaveBody && requestBody && requestBody.byteLength > 0 ? requestBody : undefined,
      redirect: 'manual',
    });

    const responseHeaders = new Headers();
    const responseContentType = upstreamResponse.headers.get('content-type');
    if (responseContentType) responseHeaders.set('content-type', responseContentType);
    const cacheControl = upstreamResponse.headers.get('cache-control');
    if (cacheControl) responseHeaders.set('cache-control', cacheControl);
    const location = rewriteLocationHeader(upstreamResponse.headers.get('location'));
    if (location) responseHeaders.set('location', location);

    if (
      responseContentType?.includes('text/html')
      || responseContentType?.includes('application/javascript')
      || responseContentType?.includes('text/javascript')
      || responseContentType?.includes('text/css')
      || responseContentType?.includes('application/json')
    ) {
      const text = await upstreamResponse.text();
      return new Response(rewriteProxyText(text), {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    const binary = await upstreamResponse.arrayBuffer();
    return new Response(binary, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  };

  app.all('/monitor-proxy/ldoh', handleLdohProxy);
  app.all('/monitor-proxy/ldoh/', handleLdohProxy);
  app.all('/monitor-proxy/ldoh/*', handleLdohProxy);
}

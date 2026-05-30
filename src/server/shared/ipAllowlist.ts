type ParsedAllowlistEntry =
  | { kind: 'exact'; normalizedIp: string }
  | { kind: 'cidr'; network: number; mask: number };

function isValidIpv4(rawIp: string): boolean {
  const parts = rawIp.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isValidIpv6(rawIp: string): boolean {
  const value = rawIp.trim().toLowerCase();
  if (!value || !value.includes(':')) return false;
  if (value.includes(':::')) return false;

  const parts = value.split('::');
  if (parts.length > 2) return false;

  const countSegments = (segmentText: string): number => {
    if (!segmentText) return 0;
    const segments = segmentText.split(':');
    if (segments.some((segment) => !/^[0-9a-f]{1,4}$/.test(segment))) return -1;
    return segments.length;
  };

  if (parts.length === 1) {
    return countSegments(parts[0]) === 8;
  }

  const leftCount = countSegments(parts[0]);
  const rightCount = countSegments(parts[1]);
  if (leftCount < 0 || rightCount < 0) return false;
  return leftCount + rightCount < 8;
}

function isValidIp(rawIp: string): boolean {
  return isValidIpv4(rawIp) || isValidIpv6(rawIp);
}

function normalizeIp(rawIp: string | null | undefined): string {
  const ip = (rawIp || '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length).trim();
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function parseIpv4Value(rawIp: string): number | null {
  const normalizedIp = normalizeIp(rawIp);
  if (!isValidIpv4(normalizedIp)) return null;

  let value = 0;
  for (const part of normalizedIp.split('.')) {
    value = (value << 8) + Number(part);
  }

  return value >>> 0;
}

function parseAllowlistEntry(rawEntry: string): ParsedAllowlistEntry | null {
  const entry = (rawEntry || '').trim();
  if (!entry) return null;

  const slashIndex = entry.indexOf('/');
  if (slashIndex === -1) {
    const normalizedIp = normalizeIp(entry);
    return isValidIp(normalizedIp)
      ? { kind: 'exact', normalizedIp }
      : null;
  }

  if (entry.indexOf('/', slashIndex + 1) !== -1) return null;

  const networkIp = normalizeIp(entry.slice(0, slashIndex));
  const prefixText = entry.slice(slashIndex + 1).trim();
  if (!isValidIpv4(networkIp) || !/^\d+$/.test(prefixText)) return null;

  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;

  const networkValue = parseIpv4Value(networkIp);
  if (networkValue === null) return null;

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return {
    kind: 'cidr',
    network: networkValue & mask,
    mask,
  };
}

export function findInvalidIpAllowlistEntries(allowlist: string[]): string[] {
  return allowlist.filter((item) => parseAllowlistEntry(item) === null);
}

export function extractClientIp(
  remoteIp: string | null | undefined,
  xForwardedFor?: string | string[] | undefined,
): string {
  if (Array.isArray(xForwardedFor)) {
    const first = xForwardedFor.find((item) => item && item.trim().length > 0);
    if (first) {
      return normalizeIp(first.split(',')[0]);
    }
  } else if (typeof xForwardedFor === 'string' && xForwardedFor.trim().length > 0) {
    return normalizeIp(xForwardedFor.split(',')[0]);
  }
  return normalizeIp(remoteIp);
}

export function isIpAllowed(clientIp: string, allowlist: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const normalizedClientIp = normalizeIp(clientIp);
  if (!normalizedClientIp) return false;
  const clientIpv4Value = parseIpv4Value(normalizedClientIp);

  return allowlist.some((item) => {
    const entry = parseAllowlistEntry(item);
    if (!entry) return false;
    if (entry.kind === 'exact') return entry.normalizedIp === normalizedClientIp;
    if (clientIpv4Value === null) return false;
    return (clientIpv4Value & entry.mask) === entry.network;
  });
}

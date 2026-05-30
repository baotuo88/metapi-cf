import { describe, expect, it } from 'vitest';
import { extractClientIp, isIpAllowed } from './auth.js';

describe('auth middleware IP helpers', () => {
  it('re-exports shared allowlist helpers for server call sites', () => {
    expect(extractClientIp('::ffff:10.0.0.1', '198.51.100.7, 203.0.113.2')).toBe('198.51.100.7');
    expect(isIpAllowed('8.8.8.8', ['8.8.8.0/24'])).toBe(true);
  });
});

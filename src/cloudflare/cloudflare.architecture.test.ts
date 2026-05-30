import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function collectCloudflareSources(dir: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      sources.push(...collectCloudflareSources(absolute));
      continue;
    }
    if (absolute.endsWith('.ts') && !absolute.endsWith('.test.ts')) {
      sources.push(absolute);
    }
  }
  return sources;
}

describe('Cloudflare runtime boundaries', () => {
  it('keeps Worker entry modules out of Fastify and Node server adapters', () => {
    const sourceFiles = collectCloudflareSources(new URL('.', import.meta.url).pathname);
    const combined = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

    expect(combined).not.toContain("from 'fastify'");
    expect(combined).not.toContain('from "../server/index.js"');
    expect(combined).not.toContain('from "../../server/index.js"');
    expect(combined).not.toMatch(/from ['"].*server\/routes\//);
    expect(combined).not.toMatch(/from ['"].*server\/services\//);
  });

  it('keeps proxy routing inside cloudflare runtime modules', () => {
    const proxyRouteSource = readFileSync(new URL('./routes/proxy.ts', import.meta.url), 'utf8');

    expect(proxyRouteSource).not.toContain('https://api.openai.com');
    expect(proxyRouteSource).not.toContain('redirect: \'follow\'');
    expect(proxyRouteSource).toContain("from '../proxy/auth.js'");
    expect(proxyRouteSource).toContain("from '../proxy/runtime.js'");
  });
});

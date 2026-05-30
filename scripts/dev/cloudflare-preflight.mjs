#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const WRANGLER_CONFIG_PATH = 'wrangler.toml';

function fail(message) {
  console.error(`[cf:preflight] ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`[cf:preflight] ${message}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getTomlSectionValue(toml, section, key) {
  const sectionPattern = new RegExp(`\\[\\[${section}\\]\\]([\\s\\S]*?)(?=\\n\\[|\\n\\[\\[|$)`, 'g');
  const keyPattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm');
  for (const match of toml.matchAll(sectionPattern)) {
    const valueMatch = keyPattern.exec(match[1] || '');
    if (valueMatch) return valueMatch[1];
  }
  return '';
}

function getFlag(name) {
  return process.argv.includes(name);
}

const skipDryRun = getFlag('--skip-dry-run');
const allowMissingSecrets = getFlag('--allow-missing-secrets');

const wranglerToml = readFileSync(WRANGLER_CONFIG_PATH, 'utf8');
const d1DatabaseId = getTomlSectionValue(wranglerToml, 'd1_databases', 'database_id');
const r2BucketName = getTomlSectionValue(wranglerToml, 'r2_buckets', 'bucket_name');

if (!d1DatabaseId || d1DatabaseId === '00000000-0000-0000-0000-000000000000') {
  fail('wrangler.toml has placeholder d1 database_id. Set a real database_id first.');
}

if (!r2BucketName || r2BucketName === 'metapi-files') {
  warn('r2 bucket_name looks default; make sure it matches your real production bucket.');
}

if (!process.env.CLOUDFLARE_API_TOKEN) {
  fail('Missing CLOUDFLARE_API_TOKEN.');
}

if (!allowMissingSecrets) {
  if (!process.env.AUTH_TOKEN) {
    fail('Missing AUTH_TOKEN. You can bypass this check with --allow-missing-secrets.');
  }
  if (!process.env.PROXY_TOKEN) {
    fail('Missing PROXY_TOKEN. You can bypass this check with --allow-missing-secrets.');
  }
}

if (!skipDryRun) {
  run('npx', ['wrangler', 'deploy', '--dry-run']);
}

console.log('[cf:preflight] Preflight checks passed.');

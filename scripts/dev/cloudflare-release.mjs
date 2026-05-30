#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const WRANGLER_CONFIG_PATH = 'wrangler.toml';
const D1_BOOTSTRAP_SQL_PATH = 'src/server/db/generated/d1.bootstrap.sql';

function fail(message) {
  console.error(`[cf:release] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function putSecret(name, value) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    input: `${value}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
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

const skipBuild = getFlag('--skip-build');
const skipSecrets = getFlag('--skip-secrets');
const skipD1Init = getFlag('--skip-d1-init');
const skipDeploy = getFlag('--skip-deploy');
const provision = getFlag('--provision');

const wranglerToml = readFileSync(WRANGLER_CONFIG_PATH, 'utf8');
const d1DatabaseName = getTomlSectionValue(wranglerToml, 'd1_databases', 'database_name') || 'metapi';
const d1DatabaseId = getTomlSectionValue(wranglerToml, 'd1_databases', 'database_id');

if (!process.env.CLOUDFLARE_API_TOKEN) {
  fail('Missing CLOUDFLARE_API_TOKEN. Export this token before running release.');
}

if (!d1DatabaseId || d1DatabaseId === '00000000-0000-0000-0000-000000000000') {
  if (!provision) {
    fail('wrangler.toml still has placeholder d1 database_id. Set a real database_id first, or run with --provision.');
  }
}

if (provision) {
  run('node', ['scripts/dev/cloudflare-provision.mjs']);
}

run('node', ['scripts/dev/cloudflare-preflight.mjs', '--skip-dry-run']);

if (!skipBuild) {
  run('npm', ['run', 'build:cloudflare']);
}

if (!skipSecrets) {
  const authToken = process.env.AUTH_TOKEN || '';
  const proxyToken = process.env.PROXY_TOKEN || '';
  if (!authToken) {
    fail('Missing AUTH_TOKEN. Export AUTH_TOKEN, or rerun with --skip-secrets.');
  }
  if (!proxyToken) {
    fail('Missing PROXY_TOKEN. Export PROXY_TOKEN, or rerun with --skip-secrets.');
  }
  putSecret('AUTH_TOKEN', authToken);
  putSecret('PROXY_TOKEN', proxyToken);
}

if (!skipD1Init) {
  run('npx', [
    'wrangler',
    'd1',
    'execute',
    d1DatabaseName,
    '--remote',
    `--file=${D1_BOOTSTRAP_SQL_PATH}`,
  ]);
}

if (!skipDeploy) {
  run('npm', ['run', 'cf:deploy']);
}

console.log('[cf:release] Cloudflare release pipeline completed.');

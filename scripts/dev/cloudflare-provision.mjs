#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const WRANGLER_CONFIG_PATH = 'wrangler.toml';

function fail(message) {
  console.error(`[cf:provision] ${message}`);
  process.exit(1);
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  return result;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getArgValue(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceTomlSectionStringValue(content, sectionName, key, value) {
  const sectionRegex = new RegExp(`(\\[\\[${escapeRegex(sectionName)}\\]\\][\\s\\S]*?)(?=\\n\\[|\\n\\[\\[|$)`, 'g');
  const keyRegex = new RegExp(`(^\\s*${escapeRegex(key)}\\s*=\\s*").*?(".*$)`, 'm');
  return content.replace(sectionRegex, (sectionBody) => {
    if (keyRegex.test(sectionBody)) {
      return sectionBody.replace(keyRegex, `$1${value}$2`);
    }
    return `${sectionBody}\n${key} = "${value}"`;
  });
}

function readWranglerToml() {
  return readFileSync(WRANGLER_CONFIG_PATH, 'utf8');
}

function writeWranglerToml(content) {
  writeFileSync(WRANGLER_CONFIG_PATH, content, 'utf8');
}

function parseJsonFromOutput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function resolveD1DatabaseId(databaseName) {
  const listResult = runCapture('npx', ['wrangler', 'd1', 'list', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (listResult.status !== 0) {
    const errorMsg = listResult.stderr?.trim() || listResult.stdout?.trim() || 'wrangler d1 list failed';
    fail(errorMsg);
  }
  const rows = parseJsonFromOutput(listResult.stdout || '');
  if (!Array.isArray(rows)) {
    fail('Unexpected output from `wrangler d1 list --json`.');
  }
  const matched = rows.find((item) => item && item.name === databaseName);
  if (!matched || typeof matched.uuid !== 'string' || !matched.uuid) {
    fail(`Unable to resolve D1 database id for "${databaseName}".`);
  }
  return matched.uuid;
}

function ensureD1Database(databaseName) {
  const createResult = runCapture('npx', [
    'wrangler',
    'd1',
    'create',
    databaseName,
    '--binding',
    'METAPI_DB',
    '--update-config',
    '--use-remote',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (createResult.status === 0) {
    process.stdout.write(createResult.stdout || '');
    process.stderr.write(createResult.stderr || '');
    return resolveD1DatabaseId(databaseName);
  }

  const output = `${createResult.stdout || ''}\n${createResult.stderr || ''}`;
  if (/already exists/i.test(output)) {
    console.warn(`[cf:provision] D1 database "${databaseName}" already exists; reusing it.`);
    return resolveD1DatabaseId(databaseName);
  }

  process.stdout.write(createResult.stdout || '');
  process.stderr.write(createResult.stderr || '');
  fail(`Failed to create D1 database "${databaseName}".`);
}

function ensureR2Bucket(bucketName) {
  const createResult = runCapture('npx', [
    'wrangler',
    'r2',
    'bucket',
    'create',
    bucketName,
    '--binding',
    'METAPI_FILES',
    '--update-config',
    '--use-remote',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (createResult.status === 0) {
    process.stdout.write(createResult.stdout || '');
    process.stderr.write(createResult.stderr || '');
    return;
  }

  const output = `${createResult.stdout || ''}\n${createResult.stderr || ''}`;
  if (/already exists/i.test(output)) {
    console.warn(`[cf:provision] R2 bucket "${bucketName}" already exists; reusing it.`);
    return;
  }

  process.stdout.write(createResult.stdout || '');
  process.stderr.write(createResult.stderr || '');
  fail(`Failed to create R2 bucket "${bucketName}".`);
}

const skipD1 = hasFlag('--skip-d1');
const skipR2 = hasFlag('--skip-r2');
const d1DatabaseName = getArgValue('--d1-name', process.env.CF_D1_DATABASE_NAME || 'metapi');
const r2BucketName = getArgValue('--r2-bucket', process.env.CF_R2_BUCKET_NAME || 'metapi-files');

if (!process.env.CLOUDFLARE_API_TOKEN) {
  fail('Missing CLOUDFLARE_API_TOKEN.');
}

let wranglerToml = readWranglerToml();

if (!skipD1) {
  const d1DatabaseId = ensureD1Database(d1DatabaseName);
  wranglerToml = replaceTomlSectionStringValue(wranglerToml, 'd1_databases', 'binding', 'METAPI_DB');
  wranglerToml = replaceTomlSectionStringValue(wranglerToml, 'd1_databases', 'database_name', d1DatabaseName);
  wranglerToml = replaceTomlSectionStringValue(wranglerToml, 'd1_databases', 'database_id', d1DatabaseId);
}

if (!skipR2) {
  ensureR2Bucket(r2BucketName);
  wranglerToml = replaceTomlSectionStringValue(wranglerToml, 'r2_buckets', 'binding', 'METAPI_FILES');
  wranglerToml = replaceTomlSectionStringValue(wranglerToml, 'r2_buckets', 'bucket_name', r2BucketName);
}

writeWranglerToml(wranglerToml);

run('node', ['scripts/dev/cloudflare-preflight.mjs', '--allow-missing-secrets', '--skip-dry-run']);

console.log('[cf:provision] Cloudflare resources provisioned and wrangler.toml updated.');

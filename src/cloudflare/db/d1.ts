import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../server/db/schema.js';
import { D1_BOOTSTRAP_SQL } from './d1BootstrapSql.js';

export function createD1Db(database: D1Database) {
  return drizzle(database as never, { schema });
}

export type CloudflareD1Db = ReturnType<typeof createD1Db>;

const d1BootstrapPromises = new WeakMap<D1Database, Promise<void>>();
const d1BootstrapStates = new WeakMap<D1Database, {
  status: 'idle' | 'running' | 'ready' | 'failed';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}>();

function splitBootstrapStatements(sqlText: string): string[] {
  return sqlText
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`);
}

const D1_BOOTSTRAP_STATEMENTS = splitBootstrapStatements(D1_BOOTSTRAP_SQL);

function getOrCreateBootstrapState(database: D1Database) {
  const existing = d1BootstrapStates.get(database);
  if (existing) return existing;
  const initial = {
    status: 'idle' as const,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  d1BootstrapStates.set(database, initial);
  return initial;
}

async function executeD1Bootstrap(database: D1Database): Promise<void> {
  if (!D1_BOOTSTRAP_STATEMENTS.length) return;
  const state = getOrCreateBootstrapState(database);
  state.status = 'running';
  state.lastAttemptAt = new Date().toISOString();
  state.lastError = null;
  const chunkSize = 40;
  for (let offset = 0; offset < D1_BOOTSTRAP_STATEMENTS.length; offset += chunkSize) {
    const chunk = D1_BOOTSTRAP_STATEMENTS.slice(offset, offset + chunkSize);
    await database.batch(chunk.map((statement) => database.prepare(statement)));
  }
  state.status = 'ready';
  state.lastSuccessAt = new Date().toISOString();
}

export async function ensureD1Bootstrap(database: D1Database): Promise<void> {
  const existing = d1BootstrapPromises.get(database);
  if (existing) {
    await existing;
    return;
  }
  const bootstrapPromise = executeD1Bootstrap(database).catch((error) => {
    const state = getOrCreateBootstrapState(database);
    state.status = 'failed';
    state.lastError = error instanceof Error ? error.message : String(error);
    d1BootstrapPromises.delete(database);
    throw error;
  });
  d1BootstrapPromises.set(database, bootstrapPromise);
  await bootstrapPromise;
}

export function getD1BootstrapState(database: D1Database) {
  const state = getOrCreateBootstrapState(database);
  return {
    status: state.status,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
  };
}

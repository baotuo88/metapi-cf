import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../server/db/schema.js';
import { D1_BOOTSTRAP_SQL } from './d1BootstrapSql.js';

export function createD1Db(database: D1Database) {
  return drizzle(database as never, { schema });
}

export type CloudflareD1Db = ReturnType<typeof createD1Db>;

const d1BootstrapPromises = new WeakMap<D1Database, Promise<void>>();

function splitBootstrapStatements(sqlText: string): string[] {
  return sqlText
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => `${statement};`);
}

const D1_BOOTSTRAP_STATEMENTS = splitBootstrapStatements(D1_BOOTSTRAP_SQL);

async function executeD1Bootstrap(database: D1Database): Promise<void> {
  if (!D1_BOOTSTRAP_STATEMENTS.length) return;
  const chunkSize = 40;
  for (let offset = 0; offset < D1_BOOTSTRAP_STATEMENTS.length; offset += chunkSize) {
    const chunk = D1_BOOTSTRAP_STATEMENTS.slice(offset, offset + chunkSize);
    await database.batch(chunk.map((statement) => database.prepare(statement)));
  }
}

export async function ensureD1Bootstrap(database: D1Database): Promise<void> {
  const existing = d1BootstrapPromises.get(database);
  if (existing) {
    await existing;
    return;
  }
  const bootstrapPromise = executeD1Bootstrap(database).catch((error) => {
    d1BootstrapPromises.delete(database);
    throw error;
  });
  d1BootstrapPromises.set(database, bootstrapPromise);
  await bootstrapPromise;
}

import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../server/db/schema.js';

export function createD1Db(database: D1Database) {
  return drizzle(database as never, { schema });
}

export type CloudflareD1Db = ReturnType<typeof createD1Db>;

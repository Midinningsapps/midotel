import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

export * as schema from './schema.ts';
export type { WhatsAppPayload, NightPrice, CancellationRule } from './schema.ts';
export { migrate } from './migrate.ts';

export type Db = NodePgDatabase<typeof schema>;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

/** A Drizzle handle with no tenant set: only global tables (app_user, session) are visible. */
export function globalDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/**
 * Run `fn` in one transaction with `app.tenant_id` set, so row-level security
 * limits every query to that tenant. All tenant data access must go through here.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (db: Db, client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(drizzle(client, { schema }), client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

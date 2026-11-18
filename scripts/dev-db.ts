// Starts a local Postgres for development (port 5433, data in .data/pg).
// First run creates the cluster, the `midotel` database and the app role password.
import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, '.data/pg');
const port = 5433;
const fresh = !existsSync(path.join(dataDir, 'PG_VERSION'));

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'midotel_dev_admin',
  port,
  persistent: true,
});

if (fresh) await server.initialise();
await server.start();

if (fresh) {
  await server.createDatabase('midotel');
  const c = new pg.Client({ connectionString: `postgres://postgres:midotel_dev_admin@localhost:${port}/midotel` });
  await c.connect();
  await c.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'midotel_app') THEN
      CREATE ROLE midotel_app LOGIN NOSUPERUSER NOBYPASSRLS;
    END IF; END $$`);
  await c.query(`ALTER ROLE midotel_app PASSWORD 'midotel_dev_app'`);
  await c.end();
  console.log('Created database "midotel". Now run: npm run db:migrate');
}

console.log(`Postgres running on localhost:${port}. Press Ctrl+C to stop.`);
const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

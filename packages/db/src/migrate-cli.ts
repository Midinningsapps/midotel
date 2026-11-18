import { migrate } from './migrate.ts';

const url = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:midotel_dev_admin@localhost:5433/midotel';
const applied = await migrate(url, (m) => console.log(m));

// Production: set the app role's password from the environment (never stored in migrations).
if (process.env.APP_DB_PASSWORD) {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query(`ALTER ROLE midotel_app PASSWORD ${c.escapeLiteral(process.env.APP_DB_PASSWORD)}`);
  await c.end();
  console.log('app role password set');
}
console.log(applied.length ? `${applied.length} migration(s) applied` : 'database is up to date');

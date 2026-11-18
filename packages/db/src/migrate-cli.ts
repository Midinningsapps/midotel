import { migrate } from './migrate.ts';

const url = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:midotel_dev_admin@localhost:5433/midotel';
const applied = await migrate(url, (m) => console.log(m));
console.log(applied.length ? `${applied.length} migration(s) applied` : 'database is up to date');

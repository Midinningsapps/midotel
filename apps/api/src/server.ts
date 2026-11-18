import { createPool } from '@midotel/db';
import { buildApp } from './app.ts';

const pool = createPool(
  process.env.DATABASE_URL ?? 'postgres://midotel_app:midotel_dev_app@localhost:5433/midotel',
);
const app = await buildApp({ pool, logger: true });
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: '127.0.0.1' });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

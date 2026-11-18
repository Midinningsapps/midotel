// Starts a throwaway Postgres for the test run and applies migrations.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '@midotel/db';

const PORT = 54329;
let server: EmbeddedPostgres | undefined;
let dir: string | undefined;

export async function setup(project: TestProject) {
  dir = await mkdtemp(path.join(tmpdir(), 'midotel-test-pg-'));
  server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port: PORT, persistent: false });
  await server.initialise();
  await server.start();
  await server.createDatabase('midotel_test');
  const adminUrl = `postgres://postgres:test@localhost:${PORT}/midotel_test`;
  await migrate(adminUrl);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`ALTER ROLE midotel_app PASSWORD 'test_app'`);
  await c.end();
  project.provide('adminUrl', adminUrl);
  project.provide('appUrl', `postgres://midotel_app:test_app@localhost:${PORT}/midotel_test`);
}

export async function teardown() {
  await server?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
}

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
  }
}

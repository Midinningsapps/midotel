// The most important guarantee in the platform: one hotel company can never see another's data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withTenant } from '@midotel/db';
import { makeApp, signUp, type Owner } from './helpers.ts';

const ctx = await makeApp();
const { app, pool } = ctx;
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('tenant isolation', () => {
  let a: Owner;
  let b: Owner;
  let roomA: string;
  beforeAll(async () => {
    a = await signUp(app, 'Alpha');
    b = await signUp(app, 'Beta');
    const res = await app.inject({
      method: 'POST',
      url: `/properties/${a.propertyId}/room-types`,
      payload: { name: 'Alpha Suite', code: 'AS' },
      headers: { cookie: a.cookie },
    });
    roomA = res.json().id;
  });

  it("hides another tenant's property and rooms through the API", async () => {
    const asB = { cookie: b.cookie };
    expect((await app.inject({ method: 'GET', url: `/properties/${a.propertyId}`, headers: asB })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/properties/${a.propertyId}/room-types`, headers: asB })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/room-types/${roomA}`, payload: { name: 'hacked' }, headers: asB })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/room-types/${roomA}`, headers: asB })).statusCode).toBe(404);
    const list = (await app.inject({ method: 'GET', url: '/properties', headers: asB })).json();
    expect(list.map((p: { id: string }) => p.id)).toEqual([b.propertyId]);
  });

  it('row-level security blocks reads even with no WHERE clause', async () => {
    const seenByB = await withTenant(pool, b.tenantId, (db) => db.select().from(schema.roomType));
    expect(seenByB.find((r) => r.id === roomA)).toBeUndefined();
    const seenByA = await withTenant(pool, a.tenantId, (db) => db.select().from(schema.roomType));
    expect(seenByA.map((r) => r.id)).toContain(roomA);
  });

  it('returns nothing when no tenant is set', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM property');
    expect(rows[0].n).toBe(0);
  });

  it('refuses to write rows into another tenant', async () => {
    await expect(
      withTenant(pool, b.tenantId, (db) =>
        db.insert(schema.roomType).values({ tenantId: a.tenantId, propertyId: a.propertyId, name: 'Sneaky', code: 'SNK' }),
      ),
    ).rejects.toThrow();
  });

  it('the app role cannot bypass RLS', async () => {
    const { rows } = await pool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

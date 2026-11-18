import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieFrom, makeApp, signUp } from './helpers.ts';

const ctx = await makeApp();
const { app } = ctx;
afterAll(async () => {
  await app.close();
  await ctx.pool.end();
});

describe('auth', () => {
  let owner: Awaited<ReturnType<typeof signUp>>;
  beforeAll(async () => {
    owner = await signUp(app);
  });

  it('signup creates a session that /auth/me accepts', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.user.email).toBe(owner.email);
    expect(me.tenant.id).toBe(owner.tenantId);
    expect(me.roles).toEqual([{ role: 'owner', propertyId: null }]);
  });

  it('rejects a duplicate email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { name: 'X', email: owner.email.toUpperCase(), password: 'another long pw', companyName: 'X', propertyName: 'Y' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects short passwords', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { name: 'X', email: 'short@example.com', password: 'short', companyName: 'X', propertyName: 'Y' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('logs in with the right password only', async () => {
    const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: owner.email, password: 'wrong password' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: owner.email, password: 'correct horse battery' } });
    expect(good.statusCode).toBe(200);
    expect(good.json().tenantId).toBe(owner.tenantId);
  });

  it('logout ends the session', async () => {
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: owner.email, password: 'correct horse battery' } });
    const cookie = cookieFrom(login);
    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('requires a session for tenant data', async () => {
    const res = await app.inject({ method: 'GET', url: '/properties' });
    expect(res.statusCode).toBe(401);
  });
});

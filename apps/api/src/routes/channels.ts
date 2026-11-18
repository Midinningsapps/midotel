import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, withTenant } from '@midotel/db';
import { assertProperty, assertPropertyExists, HttpError, requireAuth, type Role } from '../app.ts';
import { audit } from '../audit.ts';
import { addDays, todayIn } from '../booking/pricing.ts';
import { hashManageToken } from '../booking/service.ts';
import { encryptSecret } from '../crypto.ts';
import { adapters } from '../channel/adapters.ts';
import { applyInbound } from '../channel/sync.ts';

const OWNERS: Role[] = ['owner', 'manager'];
const Code = z.string().trim().min(1).max(60);
const publicApiUrl = () => process.env.PUBLIC_API_URL ?? 'http://localhost:4000';

const ConnectionBody = z.object({
  provider: z.enum(['ezee', 'staah', 'simulator']),
  hotelCode: Code,
  endpointUrl: z.url().max(500).nullable().optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(200).optional(),
  apiKey: z.string().max(500).optional(),
  master: z.enum(['channel_manager', 'midotel']).default('channel_manager'),
});

const dto = (c: typeof schema.channelConnection.$inferSelect) => ({
  id: c.id,
  provider: c.provider,
  certified: adapters[c.provider].certified,
  hotelCode: c.hotelCode,
  endpointUrl: c.endpointUrl,
  hasCredentials: !!c.credentialsEnc,
  master: c.master,
  isActive: c.isActive,
  lastSuccessAt: c.lastSuccessAt,
  lastError: c.lastError,
  webhookUrl: `${publicApiUrl()}/channels/${c.id}/inbound`,
});

function credentials(body: { username?: string; password?: string; apiKey?: string }) {
  const creds = Object.fromEntries(Object.entries({ username: body.username, password: body.password, apiKey: body.apiKey }).filter(([, v]) => v));
  return Object.keys(creds).length ? encryptSecret(JSON.stringify(creds)) : undefined;
}

export async function channelRoutes(app: FastifyInstance) {
  const pool = app.pool;

  // Channel managers send XML or JSON; keep the raw text for parsing and logging.
  app.addContentTypeParser(['application/xml', 'text/xml', 'text/plain'], { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/channels', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, OWNERS);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const conns = await db.select().from(schema.channelConnection).where(eq(schema.channelConnection.propertyId, propertyId));
      const ids = conns.map((c) => c.id);
      const [roomMaps, rateMaps, outbox, inbound] = ids.length
        ? await Promise.all([
            db.select().from(schema.channelRoomMap).where(inArray(schema.channelRoomMap.connectionId, ids)),
            db.select().from(schema.channelRateMap).where(inArray(schema.channelRateMap.connectionId, ids)),
            db.select().from(schema.channelOutbox).where(inArray(schema.channelOutbox.connectionId, ids)).orderBy(desc(schema.channelOutbox.createdAt)).limit(50),
            db
              .select({ id: schema.channelInboundLog.id, connectionId: schema.channelInboundLog.connectionId, kind: schema.channelInboundLog.kind, outcome: schema.channelInboundLog.outcome, detail: schema.channelInboundLog.detail, createdAt: schema.channelInboundLog.createdAt })
              .from(schema.channelInboundLog)
              .where(inArray(schema.channelInboundLog.connectionId, ids))
              .orderBy(desc(schema.channelInboundLog.createdAt))
              .limit(50),
          ])
        : [[], [], [], []];
      return conns.map((c) => ({
        ...dto(c),
        roomMaps: roomMaps.filter((m) => m.connectionId === c.id).map((m) => ({ roomTypeId: m.roomTypeId, externalCode: m.externalCode })),
        rateMaps: rateMaps.filter((m) => m.connectionId === c.id).map((m) => ({ roomTypeId: m.roomTypeId, ratePlanId: m.ratePlanId, externalCode: m.externalCode })),
        outbox: outbox.filter((o) => o.connectionId === c.id),
        inbound: inbound.filter((i) => i.connectionId === c.id),
      }));
    });
  });

  // Returns the webhook secret once; only its hash is stored.
  app.post<{ Params: { propertyId: string } }>('/properties/:propertyId/channels', async (req, reply) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, ['owner']);
    const body = ConnectionBody.parse(req.body);
    const token = randomBytes(24).toString('base64url');
    const created = await withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const [c] = await db
        .insert(schema.channelConnection)
        .values({
          tenantId: auth.tenantId,
          propertyId,
          provider: body.provider,
          hotelCode: body.hotelCode,
          endpointUrl: body.endpointUrl ?? null,
          credentialsEnc: credentials(body) ?? null,
          inboundTokenHash: hashManageToken(token),
          master: body.master,
        })
        .returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'create', entity: 'channel_connection', entityId: c!.id, data: { provider: body.provider } });
      return c!;
    });
    return reply.status(201).send({ ...dto(created), inboundToken: token });
  });

  app.patch<{ Params: { id: string } }>('/channels/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    // No defaults here: a field left out must stay as it is.
    const body = z
      .object({
        hotelCode: Code.optional(),
        endpointUrl: z.url().max(500).nullable().optional(),
        username: z.string().max(200).optional(),
        password: z.string().max(200).optional(),
        apiKey: z.string().max(500).optional(),
        master: z.enum(['channel_manager', 'midotel']).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [cur] = await db.select().from(schema.channelConnection).where(eq(schema.channelConnection.id, id));
      if (!cur) throw new HttpError(404, 'Connection not found');
      assertProperty(auth, cur.propertyId, ['owner']);
      if (body.isActive) {
        const [m] = await db.select().from(schema.channelRoomMap).where(eq(schema.channelRoomMap.connectionId, id)).limit(1);
        if (!m) throw new HttpError(400, 'Map at least one room before switching the connection on');
      }
      const creds = credentials(body);
      const [c] = await db
        .update(schema.channelConnection)
        .set({
          ...(body.hotelCode !== undefined && { hotelCode: body.hotelCode }),
          ...(body.endpointUrl !== undefined && { endpointUrl: body.endpointUrl }),
          ...(body.master !== undefined && { master: body.master }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
          ...(creds && { credentialsEnc: creds }),
        })
        .where(eq(schema.channelConnection.id, id))
        .returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'update', entity: 'channel_connection', entityId: id, data: { ...body, password: undefined, apiKey: undefined } });
      return dto(c!);
    });
  });

  app.put<{ Params: { id: string } }>('/channels/:id/mappings', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    const body = z
      .object({
        rooms: z.array(z.object({ roomTypeId: z.uuid(), externalCode: Code })).max(200),
        rates: z.array(z.object({ roomTypeId: z.uuid(), ratePlanId: z.uuid(), externalCode: Code })).max(2000),
      })
      .parse(req.body);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [c] = await db.select().from(schema.channelConnection).where(eq(schema.channelConnection.id, id));
      if (!c) throw new HttpError(404, 'Connection not found');
      assertProperty(auth, c.propertyId, OWNERS);
      const roomIds = [...new Set([...body.rooms.map((r) => r.roomTypeId), ...body.rates.map((r) => r.roomTypeId)])];
      const planIds = [...new Set(body.rates.map((r) => r.ratePlanId))];
      const rooms = roomIds.length ? await db.select({ id: schema.roomType.id }).from(schema.roomType).where(and(eq(schema.roomType.propertyId, c.propertyId), inArray(schema.roomType.id, roomIds))) : [];
      const plans = planIds.length ? await db.select({ id: schema.ratePlan.id }).from(schema.ratePlan).where(and(eq(schema.ratePlan.propertyId, c.propertyId), inArray(schema.ratePlan.id, planIds))) : [];
      if (rooms.length !== roomIds.length || plans.length !== planIds.length) throw new HttpError(400, 'Unknown room or rate plan');
      if (body.rates.some((r) => !body.rooms.some((m) => m.roomTypeId === r.roomTypeId))) throw new HttpError(400, 'Map the room before mapping its rates');
      await db.delete(schema.channelRateMap).where(eq(schema.channelRateMap.connectionId, id));
      await db.delete(schema.channelRoomMap).where(eq(schema.channelRoomMap.connectionId, id));
      if (body.rooms.length) await db.insert(schema.channelRoomMap).values(body.rooms.map((r) => ({ ...r, connectionId: id, tenantId: auth.tenantId })));
      if (body.rates.length) await db.insert(schema.channelRateMap).values(body.rates.map((r) => ({ ...r, connectionId: id, tenantId: auth.tenantId })));
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'update', entity: 'channel_mapping', entityId: id, data: { rooms: body.rooms.length, rates: body.rates.length } });
      return { rooms: body.rooms.length, rates: body.rates.length };
    });
  });

  // Send everything for the next N days, e.g. after mapping or when the channel manager looks out of step.
  app.post<{ Params: { id: string } }>('/channels/:id/full-sync', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    const { days } = z.object({ days: z.number().int().min(1).max(500).default(365) }).parse(req.body ?? {});
    return withTenant(pool, auth.tenantId, async (db) => {
      const [c] = await db.select().from(schema.channelConnection).where(eq(schema.channelConnection.id, id));
      if (!c) throw new HttpError(404, 'Connection not found');
      assertProperty(auth, c.propertyId, OWNERS);
      if (!c.isActive) throw new HttpError(400, 'Switch the connection on first');
      if (c.master !== 'midotel') throw new HttpError(400, 'The channel manager owns rates for this hotel; nothing to send');
      const maps = await db.select().from(schema.channelRoomMap).where(eq(schema.channelRoomMap.connectionId, id));
      const [p] = await db.select().from(schema.property).where(eq(schema.property.id, c.propertyId));
      const from = todayIn(p!.timezone);
      // Chunks of 31 days keep each message a reasonable size.
      let chunks = 0;
      for (let start = 0; start < days; start += 31) {
        const to = addDays(from, Math.min(start + 30, days - 1));
        await db.insert(schema.channelOutbox).values({ tenantId: c.tenantId, connectionId: c.id, kind: 'ari', payload: { roomTypeIds: maps.map((m) => m.roomTypeId), from: addDays(from, start), to } });
        chunks++;
      }
      return { queued: chunks };
    });
  });

  // Webhook for the channel manager: OTA bookings, cancellations and (when it is master) rate/availability changes.
  app.post<{ Params: { id: string } }>('/channels/:id/inbound', async (req, reply) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, 'Not found');
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || String((req.query as Record<string, unknown>).token ?? '');
    const { rows } = await pool.query<{ t: string | null }>('SELECT channel_connection_tenant($1) AS t', [id.data]);
    const tenantId = rows[0]?.t;
    if (!tenantId) throw new HttpError(404, 'Not found');
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
    const conn = await withTenant(pool, tenantId, async (db) => (await db.select().from(schema.channelConnection).where(eq(schema.channelConnection.id, id.data)))[0]);
    const expected = Buffer.from(conn!.inboundTokenHash);
    const actual = Buffer.from(hashManageToken(token));
    if (!token || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new HttpError(401, 'Bad token');
    if (!conn!.isActive) throw new HttpError(409, 'Connection is switched off in Midotel');

    const log = (kind: string, outcome: string, detail: string) =>
      withTenant(pool, tenantId, (db) => db.insert(schema.channelInboundLog).values({ tenantId, connectionId: conn!.id, kind, outcome, detail: detail.slice(0, 1000), body: raw.slice(0, 100_000) }));
    let events;
    try {
      events = adapters[conn!.provider].parseInbound(raw, String(req.headers['content-type'] ?? ''));
    } catch (err) {
      await log('unknown', 'error', (err as Error).message);
      return reply.status(400).send({ ok: false, error: 'Could not read the message' });
    }
    try {
      const notes = await withTenant(pool, tenantId, (db, client) => applyInbound(db, client, conn!, events));
      await log(events.map((e) => e.type).join(','), 'applied', notes.join('; '));
      return { ok: true, notes };
    } catch (err) {
      await log(events.map((e) => e.type).join(','), 'error', (err as Error).message);
      const status = err instanceof HttpError ? err.statusCode : 500;
      return reply.status(status).send({ ok: false, error: status === 500 ? 'Could not apply the message' : (err as Error).message });
    }
  });
}


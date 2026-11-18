import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { schema, withTenant } from '@midotel/db';
import { assertProperty, assertPropertyExists, HttpError, requireAuth, type Role } from '../app.ts';
import { audit } from '../audit.ts';
import { addDays, daysBetween, describePolicy, isDate, stayNights } from '../booking/pricing.ts';
import { encryptSecret, maskKey } from '../crypto.ts';

const REVENUE: Role[] = ['owner', 'manager'];
const day = z.string().refine(isDate, 'Use YYYY-MM-DD');
const paise = z.number().int().min(0).max(100_000_000);

const Rule = z.object({
  daysBefore: z.number().int().min(0).max(365),
  penaltyType: z.enum(['percent', 'nights']),
  value: z.number().int().min(1).max(100),
});
const PolicyBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).nullable().optional(),
  rules: z.array(Rule).max(10).default([]),
  isNonRefundable: z.boolean().default(false),
});

const PlanBody = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/),
  description: z.string().trim().max(1000).nullable().optional(),
  mealPlan: z.enum(['EP', 'CP', 'MAP', 'AP']).default('EP'),
  cancellationPolicyId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  deriveKind: z.enum(['percent', 'amount']).nullable().optional(),
  deriveValue: z.number().int().min(-100_000_000).max(100_000_000).nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

const CalendarUpdate = z
  .object({
    roomTypeIds: z.array(z.uuid()).min(1).max(50),
    from: day,
    to: day,
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(), // 0 = Sunday
    // Prices for a base rate plan.
    ratePlanId: z.uuid().optional(),
    price: paise.optional(),
    extraAdult: paise.optional(),
    extraChild: paise.optional(),
    // Inventory and restrictions.
    total: z.number().int().min(0).max(5000).optional(),
    closed: z.boolean().optional(),
    closedToArrival: z.boolean().optional(),
    closedToDeparture: z.boolean().optional(),
    minStay: z.number().int().min(1).max(60).nullable().optional(),
    maxStay: z.number().int().min(1).max(365).nullable().optional(),
  })
  .refine((v) => v.to >= v.from && daysBetween(v.from, v.to) <= 400, 'Choose a date range of at most 400 days')
  .refine((v) => v.price === undefined || v.ratePlanId, 'Choose a rate plan for prices');

export async function rateRoutes(app: FastifyInstance) {
  const pool = app.pool;

  // Cancellation policies -------------------------------------------------------
  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/cancellation-policies', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const rows = await db.select().from(schema.cancellationPolicy).where(eq(schema.cancellationPolicy.propertyId, propertyId)).orderBy(asc(schema.cancellationPolicy.name));
      return rows.map((p) => ({ ...p, summary: describePolicy(p) }));
    });
  });

  app.post<{ Params: { propertyId: string } }>('/properties/:propertyId/cancellation-policies', async (req, reply) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, REVENUE);
    const body = PolicyBody.parse(req.body);
    const p = await withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const [row] = await db.insert(schema.cancellationPolicy).values({ ...body, tenantId: auth.tenantId, propertyId }).returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'create', entity: 'cancellation_policy', entityId: row!.id });
      return row!;
    });
    return reply.status(201).send({ ...p, summary: describePolicy(p) });
  });

  app.patch<{ Params: { id: string } }>('/cancellation-policies/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    const body = PolicyBody.partial().parse(req.body);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [cur] = await db.select().from(schema.cancellationPolicy).where(eq(schema.cancellationPolicy.id, id));
      if (!cur) throw new HttpError(404, 'Policy not found');
      assertProperty(auth, cur.propertyId, REVENUE);
      const [p] = await db.update(schema.cancellationPolicy).set(body).where(eq(schema.cancellationPolicy.id, id)).returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'update', entity: 'cancellation_policy', entityId: id, data: body });
      return { ...p!, summary: describePolicy(p!) };
    });
  });

  // Rate plans ---------------------------------------------------------------------
  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/rate-plans', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      return db.select().from(schema.ratePlan).where(eq(schema.ratePlan.propertyId, propertyId)).orderBy(asc(schema.ratePlan.sortOrder), asc(schema.ratePlan.name));
    });
  });

  async function checkPlanRefs(db: import('@midotel/db').Db, propertyId: string, body: Partial<z.infer<typeof PlanBody>>, selfId?: string) {
    const derived = body.parentId != null;
    if (derived !== (body.deriveKind != null) || derived !== (body.deriveValue != null)) {
      throw new HttpError(400, 'A derived plan needs a parent plan, a kind (percent or amount) and a value');
    }
    if (body.parentId) {
      if (body.parentId === selfId) throw new HttpError(400, 'A plan cannot derive from itself');
      const [parent] = await db.select().from(schema.ratePlan).where(and(eq(schema.ratePlan.id, body.parentId), eq(schema.ratePlan.propertyId, propertyId)));
      if (!parent) throw new HttpError(400, 'Unknown parent plan');
      if (parent.parentId) throw new HttpError(400, 'Derive from a base plan, not from another derived plan');
      if (body.deriveKind === 'percent' && (body.deriveValue! < -90 || body.deriveValue! > 500)) throw new HttpError(400, 'Percent must be between -90 and 500');
    }
    if (body.cancellationPolicyId) {
      const [p] = await db
        .select({ id: schema.cancellationPolicy.id })
        .from(schema.cancellationPolicy)
        .where(and(eq(schema.cancellationPolicy.id, body.cancellationPolicyId), eq(schema.cancellationPolicy.propertyId, propertyId)));
      if (!p) throw new HttpError(400, 'Unknown cancellation policy');
    }
  }

  app.post<{ Params: { propertyId: string } }>('/properties/:propertyId/rate-plans', async (req, reply) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, REVENUE);
    const body = PlanBody.parse(req.body);
    const plan = await withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      await checkPlanRefs(db, propertyId, body);
      const [p] = await db.insert(schema.ratePlan).values({ ...body, tenantId: auth.tenantId, propertyId }).returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'create', entity: 'rate_plan', entityId: p!.id, data: body });
      return p!;
    });
    return reply.status(201).send(plan);
  });

  app.patch<{ Params: { id: string } }>('/rate-plans/:id', async (req) => {
    const auth = requireAuth(req);
    const id = z.uuid().parse(req.params.id);
    const body = PlanBody.partial().parse(req.body);
    return withTenant(pool, auth.tenantId, async (db) => {
      const [cur] = await db.select().from(schema.ratePlan).where(eq(schema.ratePlan.id, id));
      if (!cur) throw new HttpError(404, 'Rate plan not found');
      assertProperty(auth, cur.propertyId, REVENUE);
      const merged = { ...cur, ...body };
      await checkPlanRefs(db, cur.propertyId, merged, id);
      if (merged.parentId && !cur.parentId) {
        const [child] = await db.select({ id: schema.ratePlan.id }).from(schema.ratePlan).where(eq(schema.ratePlan.parentId, id));
        if (child) throw new HttpError(400, 'Other plans derive from this one, so it must stay a base plan');
      }
      const [p] = await db.update(schema.ratePlan).set(body).where(eq(schema.ratePlan.id, id)).returning();
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'update', entity: 'rate_plan', entityId: id, data: body });
      return p;
    });
  });

  // Rates and inventory calendar -------------------------------------------------
  app.get<{ Params: { propertyId: string }; Querystring: { from?: string; to?: string } }>('/properties/:propertyId/calendar', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId);
    const q = z.object({ from: day, to: day }).parse(req.query);
    if (q.to < q.from || daysBetween(q.from, q.to) > 62) throw new HttpError(400, 'Show at most 62 days at a time');
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const [rooms, plans, rates, inventory] = await Promise.all([
        db.select().from(schema.roomType).where(eq(schema.roomType.propertyId, propertyId)).orderBy(asc(schema.roomType.sortOrder), asc(schema.roomType.name)),
        db.select().from(schema.ratePlan).where(eq(schema.ratePlan.propertyId, propertyId)).orderBy(asc(schema.ratePlan.sortOrder)),
        db.select().from(schema.roomRate).where(and(eq(schema.roomRate.propertyId, propertyId), gte(schema.roomRate.date, q.from), lte(schema.roomRate.date, q.to))),
        db.select().from(schema.inventoryDay).where(and(eq(schema.inventoryDay.propertyId, propertyId), gte(schema.inventoryDay.date, q.from), lte(schema.inventoryDay.date, q.to))),
      ]);
      return {
        dates: stayNights(q.from, addDays(q.to, 1)),
        rooms: rooms.map((r) => ({ id: r.id, name: r.name, totalUnits: r.totalUnits, baseOccupancy: r.baseOccupancy })),
        basePlans: plans.filter((p) => !p.parentId).map((p) => ({ id: p.id, name: p.name, code: p.code })),
        rates: rates.map((r) => ({ roomTypeId: r.roomTypeId, ratePlanId: r.ratePlanId, date: r.date, price: r.price, extraAdult: r.extraAdult, extraChild: r.extraChild })),
        inventory: inventory.map((i) => ({
          roomTypeId: i.roomTypeId,
          date: i.date,
          total: i.total,
          sold: i.sold,
          held: i.held,
          closed: i.closed,
          closedToArrival: i.closedToArrival,
          closedToDeparture: i.closedToDeparture,
          minStay: i.minStay,
          maxStay: i.maxStay,
        })),
      };
    });
  });

  // Bulk update: "set Deluxe to Rs 6,500 on weekends in December, min stay 2".
  app.put<{ Params: { propertyId: string } }>('/properties/:propertyId/calendar', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, REVENUE);
    const body = CalendarUpdate.parse(req.body);
    const dates = stayNights(body.from, addDays(body.to, 1)).filter(
      (d) => !body.weekdays || body.weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay()),
    );
    if (!dates.length) return { updatedDays: 0 };
    return withTenant(pool, auth.tenantId, async (db, client) => {
      await assertPropertyExists(db, propertyId);
      const rooms = await db
        .select({ id: schema.roomType.id, totalUnits: schema.roomType.totalUnits })
        .from(schema.roomType)
        .where(and(eq(schema.roomType.propertyId, propertyId), inArray(schema.roomType.id, body.roomTypeIds)));
      if (rooms.length !== new Set(body.roomTypeIds).size) throw new HttpError(400, 'Unknown room type');

      if (body.ratePlanId && (body.price !== undefined || body.extraAdult !== undefined || body.extraChild !== undefined)) {
        const [plan] = await db.select().from(schema.ratePlan).where(and(eq(schema.ratePlan.id, body.ratePlanId), eq(schema.ratePlan.propertyId, propertyId)));
        if (!plan) throw new HttpError(400, 'Unknown rate plan');
        if (plan.parentId) throw new HttpError(400, 'Derived plans are priced from their parent plan');
        for (const r of rooms) {
          // New rows need a price; existing rows keep fields that were not sent.
          await client.query(
            `INSERT INTO room_rate (tenant_id, property_id, room_type_id, rate_plan_id, date, price, extra_adult, extra_child)
             SELECT $1, $2, $3, $4, d::date, $6, coalesce($7, 0), coalesce($8, 0) FROM unnest($5::date[]) d
             WHERE $6::int IS NOT NULL
             ON CONFLICT (room_type_id, rate_plan_id, date) DO UPDATE SET
               price = coalesce($6, room_rate.price),
               extra_adult = coalesce($7, room_rate.extra_adult),
               extra_child = coalesce($8, room_rate.extra_child)`,
            [auth.tenantId, propertyId, r.id, body.ratePlanId, dates, body.price ?? null, body.extraAdult ?? null, body.extraChild ?? null],
          );
          if (body.price === undefined) {
            await client.query(
              `UPDATE room_rate SET extra_adult = coalesce($4, extra_adult), extra_child = coalesce($5, extra_child)
               WHERE room_type_id = $1 AND rate_plan_id = $2 AND date = ANY($3::date[])`,
              [r.id, body.ratePlanId, dates, body.extraAdult ?? null, body.extraChild ?? null],
            );
          }
        }
      }

      const inv = {
        total: body.total,
        closed: body.closed,
        closed_to_arrival: body.closedToArrival,
        closed_to_departure: body.closedToDeparture,
        min_stay: body.minStay,
        max_stay: body.maxStay,
      };
      const invSet = Object.entries(inv).filter(([, v]) => v !== undefined);
      if (invSet.length) {
        for (const r of rooms) {
          await client.query(
            `INSERT INTO inventory_day (tenant_id, property_id, room_type_id, date, total)
             SELECT $1, $2, $3, d::date, $4 FROM unnest($5::date[]) d
             ON CONFLICT (room_type_id, date) DO NOTHING`,
            [auth.tenantId, propertyId, r.id, r.totalUnits, dates],
          );
          const assignments = invSet.map(([col], i) => `${col} = $${i + 3}`).join(', ');
          await client.query(`UPDATE inventory_day SET ${assignments} WHERE room_type_id = $1 AND date = ANY($2::date[])`, [
            r.id,
            dates,
            ...invSet.map(([, v]) => v),
          ]);
        }
      }
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'update', entity: 'calendar', entityId: propertyId, data: { ...body, days: dates.length } });
      return { updatedDays: dates.length };
    });
  });

  // Payment gateway (the hotel's own account) --------------------------------------
  app.get<{ Params: { propertyId: string } }>('/properties/:propertyId/gateway', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, REVENUE);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const [g] = await db.select().from(schema.gatewayAccount).where(eq(schema.gatewayAccount.propertyId, propertyId));
      if (!g) return { provider: 'demo', keyId: null, hasSecret: false, payAtHotel: true, configured: false };
      return { provider: g.provider, keyId: g.keyId, keySecret: maskKey(g.keySecretEnc ? 'xxxx' : null), hasSecret: !!g.keySecretEnc, payAtHotel: g.payAtHotel, configured: true };
    });
  });

  app.put<{ Params: { propertyId: string } }>('/properties/:propertyId/gateway', async (req) => {
    const auth = requireAuth(req);
    const propertyId = z.uuid().parse(req.params.propertyId);
    assertProperty(auth, propertyId, ['owner']);
    const body = z
      .object({
        provider: z.enum(['razorpay', 'demo']),
        keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/, 'Razorpay key id looks like rzp_test_...').nullable().optional(),
        keySecret: z.string().trim().min(8).max(200).optional(),
        payAtHotel: z.boolean().default(true),
      })
      .parse(req.body);
    return withTenant(pool, auth.tenantId, async (db) => {
      await assertPropertyExists(db, propertyId);
      const [cur] = await db.select().from(schema.gatewayAccount).where(eq(schema.gatewayAccount.propertyId, propertyId));
      if (body.provider === 'razorpay' && !body.keyId) throw new HttpError(400, 'Enter the Razorpay key id');
      if (body.provider === 'razorpay' && !body.keySecret && !cur?.keySecretEnc) throw new HttpError(400, 'Enter the Razorpay key secret');
      const values = {
        provider: body.provider,
        keyId: body.provider === 'razorpay' ? body.keyId! : null,
        keySecretEnc: body.provider === 'razorpay' ? (body.keySecret ? encryptSecret(body.keySecret) : cur?.keySecretEnc ?? null) : null,
        payAtHotel: body.payAtHotel,
      };
      await db
        .insert(schema.gatewayAccount)
        .values({ ...values, tenantId: auth.tenantId, propertyId })
        .onConflictDoUpdate({ target: schema.gatewayAccount.propertyId, set: values });
      // Never log secrets: record only what changed in kind.
      await audit(db, { tenantId: auth.tenantId, userId: auth.userId, action: 'update', entity: 'gateway', entityId: propertyId, data: { provider: body.provider, secretChanged: !!body.keySecret } });
      return { provider: values.provider, keyId: values.keyId, hasSecret: !!values.keySecretEnc, payAtHotel: values.payAtHotel, configured: true };
    });
  });
}

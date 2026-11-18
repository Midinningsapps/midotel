import { schema, type Db } from '@midotel/db';

export async function audit(
  db: Db,
  entry: { tenantId: string; userId: string | null; action: string; entity: string; entityId?: string; data?: unknown },
): Promise<void> {
  await db.insert(schema.auditLog).values({
    tenantId: entry.tenantId,
    userId: entry.userId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    data: entry.data ?? null,
  });
}

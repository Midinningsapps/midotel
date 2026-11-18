// One adapter per channel manager. The simulator lets us build and demo the full flow before eZee and STAAH
// grant API access; their adapters are drafts until we implement their specs and pass certification.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { availNotif, rateAmountNotif, resNotif } from './ota-xml.ts';
import type { AriDay, BookingMessage, ChannelAdapter, ConnectionInfo, InboundEvent } from './types.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The simulator's inbound format: plain JSON, documented in docs/channel-manager.md. */
const SimulatorInbound = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('booking'),
    action: z.enum(['new', 'modify', 'cancel']),
    externalReference: z.string().min(1).max(80),
    channelName: z.string().max(80).nullable().default(null),
    checkIn: date,
    checkOut: date,
    currency: z.string().length(3).default('INR'),
    total: z.number().int().min(0),
    guest: z.object({ name: z.string().min(1).max(120), email: z.string().max(200).nullable().default(null), phone: z.string().max(30).nullable().default(null) }),
    specialRequests: z.string().max(1000).nullable().default(null),
    rooms: z.array(z.object({ roomCode: z.string(), rateCode: z.string().nullable().default(null), adults: z.number().int().min(1).max(10), children: z.number().int().min(0).max(10).default(0) })).min(1).max(10),
  }),
  z.object({
    type: z.literal('ari'),
    updates: z
      .array(
        z.object({
          roomCode: z.string(),
          rateCode: z.string().nullable().default(null),
          from: date,
          to: date,
          price: z.number().int().min(0).optional(),
          available: z.number().int().min(0).max(5000).optional(),
          closed: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
]);

async function post(url: string, body: string, contentType: string, credentials: Record<string, string> | null) {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (credentials?.username) headers.authorization = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password ?? ''}`).toString('base64');
  if (credentials?.apiKey) headers['x-api-key'] = credentials.apiKey;
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${res.status} from channel manager: ${text.slice(0, 200)}`);
  // OTA responses report failure inside a 200 response.
  if (/<Errors>/.test(text)) throw new Error(`Channel manager rejected the message: ${text.slice(0, 200)}`);
  return text;
}

export function simulatorAdapter(dir = process.env.CHANNEL_SIM_DIR ?? new URL('../../../../.data/channel', import.meta.url).pathname): ChannelAdapter {
  async function record(conn: ConnectionInfo, kind: string, data: unknown) {
    if (conn.endpointUrl) {
      await post(conn.endpointUrl, JSON.stringify({ kind, hotelCode: conn.hotelCode, data }), 'application/json', conn.credentials);
      return;
    }
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `${conn.hotelCode}.jsonl`), JSON.stringify({ at: new Date().toISOString(), kind, data }) + '\n');
  }
  return {
    provider: 'simulator',
    certified: true,
    pushAri: (conn, days) => record(conn, 'ari', days),
    pushBooking: (conn, b) => record(conn, 'booking', b),
    parseInbound(body) {
      const parsed = SimulatorInbound.parse(JSON.parse(body));
      return [parsed as InboundEvent];
    },
  };
}

/** Draft OTA-XML adapter shared by eZee and STAAH until each provider's own spec is implemented. */
function otaXmlAdapter(provider: 'ezee' | 'staah'): ChannelAdapter {
  const requireEndpoint = (conn: ConnectionInfo) => {
    if (!conn.endpointUrl) throw new Error(`No ${provider} endpoint configured. Add it from ${provider}'s API documentation.`);
    return conn.endpointUrl;
  };
  return {
    provider,
    certified: false,
    async pushAri(conn: ConnectionInfo, days: AriDay[]) {
      const url = requireEndpoint(conn);
      await post(url, availNotif(conn.hotelCode, days, randomUUID()), 'application/xml', conn.credentials);
      if (days.some((d) => d.rates.some((r) => r.price !== null))) {
        await post(url, rateAmountNotif(conn.hotelCode, days, 'INR', randomUUID()), 'application/xml', conn.credentials);
      }
    },
    async pushBooking(conn: ConnectionInfo, b: BookingMessage) {
      await post(requireEndpoint(conn), resNotif(conn.hotelCode, b, randomUUID()), 'application/xml', conn.credentials);
    },
    parseInbound() {
      throw new Error(`Receiving ${provider} messages is not built yet: it needs ${provider}'s API specification.`);
    },
  };
}

export const adapters: Record<ConnectionInfo['provider'], ChannelAdapter> = {
  simulator: simulatorAdapter(),
  ezee: otaXmlAdapter('ezee'),
  staah: otaXmlAdapter('staah'),
};

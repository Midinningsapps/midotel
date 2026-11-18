import { createPool } from '@midotel/db';
import { buildApp } from './app.ts';
import { expireHolds } from './booking/service.ts';
import { deliverOutbox } from './notify/outbox.ts';
import { senderFromEnv } from './notify/senders.ts';
import { whatsAppSenderFromEnv } from './notify/whatsapp.ts';
import { whatsappEnabled } from './notify/outbox.ts';
import { deliverChannelOutbox } from './channel/sync.ts';

const pool = createPool(
  process.env.DATABASE_URL ?? 'postgres://midotel_app:midotel_dev_app@localhost:5433/midotel',
);
const app = await buildApp({ pool, logger: true });
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: process.env.API_HOST ?? '127.0.0.1' });

// Release rooms held by guests who never finished paying.
const sweeper = setInterval(() => {
  expireHolds(pool)
    .then((n) => n && app.log.info({ expired: n }, 'released expired booking holds'))
    .catch((err) => app.log.error(err, 'hold sweeper failed'));
}, 60_000);
sweeper.unref();

// Deliver queued emails every few seconds.
const sender = senderFromEnv();
const whatsapp = whatsAppSenderFromEnv();
whatsappEnabled.value = whatsapp !== null;
app.log.info({ sender: sender.name, whatsapp: whatsapp?.name ?? 'off' }, 'message senders ready');
let delivering = false;
const mailer = setInterval(() => {
  if (delivering) return;
  delivering = true;
  deliverOutbox(pool, sender, 20, whatsapp)
    .then((r) => (r.sent || r.failed) && app.log.info(r, 'email delivery'))
    .catch((err) => app.log.error(err, 'email delivery failed'))
    .finally(() => (delivering = false));
}, 5_000);
mailer.unref();

// Push prices, availability and bookings to channel managers.
let syncing = false;
const channelSync = setInterval(() => {
  if (syncing) return;
  syncing = true;
  deliverChannelOutbox(pool)
    .then((r) => (r.sent || r.failed) && app.log.info(r, 'channel sync'))
    .catch((err) => app.log.error(err, 'channel sync failed'))
    .finally(() => (syncing = false));
}, 5_000);
channelSync.unref();

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

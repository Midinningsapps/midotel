// WhatsApp booking messages via Meta's WhatsApp Cloud API.
// Business-initiated messages must use templates pre-approved by Meta; their wording is in docs/whatsapp-templates.md.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WhatsAppPayload } from '@midotel/db';

export interface WhatsAppMessage {
  to: string; // digits only, with country code, e.g. 919876543210
  payload: WhatsAppPayload;
  text: string; // the same message as plain text, for logs and previews
  messageId: string;
}

export interface WhatsAppSender {
  name: string;
  send(m: WhatsAppMessage): Promise<{ providerId: string }>;
}

/** Normalise a guest's phone to international digits. Indian 10-digit mobiles get +91. Returns null if unusable. */
export function toWhatsAppNumber(raw: string, defaultCountry = '91'): string | null {
  const plus = raw.trim().startsWith('+') || raw.trim().startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('00')) digits = digits.slice(2);
  if (!plus) {
    if (/^0[6-9]\d{9}$/.test(digits)) digits = defaultCountry + digits.slice(1);
    else if (/^[6-9]\d{9}$/.test(digits)) digits = defaultCountry + digits;
  }
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
}

export const TEMPLATES = {
  booking_confirmed: {
    // {{1}} first name, {{2}} hotel, {{3}} check-in date, {{4}} nights, {{5}} reference, {{6}} total, {{7}} manage link
    body: 'Hello {{1}}, your stay at {{2}} is confirmed. Check-in: {{3}} for {{4}} night(s). Booking reference: {{5}}. Total: {{6}}. View or cancel your booking: {{7}}',
  },
  booking_cancelled: {
    // {{1}} first name, {{2}} hotel, {{3}} reference, {{4}} refund note
    body: 'Hello {{1}}, your booking {{3}} at {{2}} has been cancelled. {{4}}',
  },
} as const;
export type TemplateName = keyof typeof TEMPLATES;

export function renderTemplate(name: TemplateName, params: string[]): string {
  return TEMPLATES[name].body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
}

/** WhatsApp template parameters cannot contain new lines, tabs or more than 4 spaces in a row. */
export const cleanParam = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 1000) || '-';

export function metaCloudSender(token: string, phoneNumberId: string, fetchImpl: typeof fetch = fetch): WhatsAppSender {
  return {
    name: 'meta-cloud',
    async send(m) {
      const res = await fetchImpl(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: m.to,
          type: 'template',
          template: {
            name: m.payload.template,
            language: { code: m.payload.language },
            components: [{ type: 'body', parameters: m.payload.params.map((text) => ({ type: 'text', text })) }],
          },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
      if (!res.ok || !data.messages?.[0]) throw new Error(`WhatsApp ${res.status}: ${data.error?.message ?? 'send failed'}`);
      return { providerId: data.messages[0].id };
    },
  };
}

/** Development: saves each WhatsApp message as a text file. */
export function folderWhatsAppSender(dir: string): WhatsAppSender {
  return {
    name: 'local-folder',
    async send(m) {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${m.messageId}.txt`);
      await writeFile(file, `To: +${m.to}\nTemplate: ${m.payload.template} (${m.payload.language})\n\n${m.text}\n`);
      return { providerId: `local:${path.basename(file)}` };
    },
  };
}

export function whatsAppSenderFromEnv(): WhatsAppSender | null {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (token && phoneId) return metaCloudSender(token, phoneId);
  if (process.env.NODE_ENV === 'production') return null; // not configured: WhatsApp messages are not queued
  return folderWhatsAppSender(process.env.WHATSAPP_DIR ?? new URL('../../../../.data/whatsapp', import.meta.url).pathname);
}

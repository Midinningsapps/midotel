// Email delivery. Local development writes every email to .data/mail so it can be opened in a browser;
// production uses Postmark (set POSTMARK_TOKEN and MAIL_FROM). Another provider only needs a new MailSender.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface OutgoingEmail {
  to: string;
  fromName: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  messageId: string;
}

export interface MailSender {
  name: string;
  send(mail: OutgoingEmail): Promise<{ providerId: string }>;
}

/** Saves emails as HTML files instead of sending them. */
export function folderSender(dir: string): MailSender & { dir: string } {
  return {
    name: 'local-folder',
    dir,
    async send(mail) {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${mail.messageId}.html`);
      const head = `<!-- To: ${mail.to} | From: ${mail.fromName} | Reply-To: ${mail.replyTo ?? '-'} | Subject: ${mail.subject} -->\n`;
      await writeFile(file, head + mail.html);
      return { providerId: `local:${path.basename(file)}` };
    },
  };
}

/** Postmark transactional email: https://postmarkapp.com/developer/api/email-api */
export function postmarkSender(token: string, fromAddress: string, fetchImpl: typeof fetch = fetch): MailSender {
  return {
    name: 'postmark',
    async send(mail) {
      const res = await fetchImpl('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': token },
        body: JSON.stringify({
          From: `${mail.fromName.replace(/["<>]/g, '')} <${fromAddress}>`,
          To: mail.to,
          ReplyTo: mail.replyTo ?? undefined,
          Subject: mail.subject,
          HtmlBody: mail.html,
          TextBody: mail.text,
          MessageStream: 'outbound',
          Headers: [{ Name: 'X-Midotel-Message', Value: mail.messageId }],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { MessageID?: string; Message?: string; ErrorCode?: number };
      if (!res.ok || data.ErrorCode) throw new Error(`Postmark ${res.status}: ${data.Message ?? 'send failed'}`);
      return { providerId: data.MessageID ?? 'postmark' };
    },
  };
}

export function senderFromEnv(): MailSender {
  const token = process.env.POSTMARK_TOKEN;
  const from = process.env.MAIL_FROM;
  if (token && from) return postmarkSender(token, from);
  return folderSender(process.env.MAIL_DIR ?? new URL('../../../../.data/mail', import.meta.url).pathname);
}

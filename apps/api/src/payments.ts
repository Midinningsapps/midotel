// Payment gateways. Money always goes to the hotel's own gateway account; Midotel never holds it.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface Order {
  orderId: string;
  amount: number; // paise
  currency: string;
}

export interface Gateway {
  provider: 'razorpay' | 'demo';
  /** Public data the browser needs to open the checkout. */
  publicKey: string | null;
  createOrder(amount: number, currency: string, receipt: string): Promise<Order>;
  /** Check the browser's success callback really came from the gateway. */
  verify(orderId: string, paymentId: string, signature: string): boolean;
  refund(paymentId: string, amount: number): Promise<{ refundId: string; status: 'refunded' | 'pending' }>;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Razorpay: https://razorpay.com/docs/api/orders/ and payment signature verification. */
export function razorpay(keyId: string, keySecret: string, fetchImpl: typeof fetch = fetch): Gateway {
  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  async function call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`https://api.razorpay.com/v1${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { description?: string } } & T;
    if (!res.ok) throw new Error(`Razorpay: ${data.error?.description ?? res.status}`);
    return data;
  }
  return {
    provider: 'razorpay',
    publicKey: keyId,
    async createOrder(amount, currency, receipt) {
      const o = await call<{ id: string; amount: number; currency: string }>('/orders', { amount, currency, receipt: receipt.slice(0, 40) });
      return { orderId: o.id, amount: o.amount, currency: o.currency };
    },
    verify(orderId, paymentId, signature) {
      const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
      return safeEqual(expected, signature);
    },
    async refund(paymentId, amount) {
      const r = await call<{ id: string; status: string }>(`/payments/${encodeURIComponent(paymentId)}/refund`, { amount });
      return { refundId: r.id, status: r.status === 'processed' ? 'refunded' : 'pending' };
    },
  };
}

/**
 * Demo gateway for local development and sales demos: no real money moves.
 * The "payment" is completed by our own demo checkout page, which is signed the same way Razorpay signs.
 */
export function demoGateway(secret = process.env.DEMO_GATEWAY_SECRET ?? 'midotel-demo-gateway'): Gateway & { sign(orderId: string, paymentId: string): string } {
  const sign = (orderId: string, paymentId: string) => createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  return {
    provider: 'demo',
    publicKey: null,
    async createOrder(amount, currency) {
      return { orderId: `demo_order_${randomUUID().replace(/-/g, '').slice(0, 16)}`, amount, currency };
    },
    verify(orderId, paymentId, signature) {
      return safeEqual(sign(orderId, paymentId), signature);
    },
    async refund() {
      return { refundId: `demo_rfnd_${randomUUID().slice(0, 8)}`, status: 'refunded' };
    },
    sign,
  };
}

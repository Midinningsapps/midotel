export async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/public${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issue = data?.issues?.[0];
    throw new Error(issue ? issue.message : (data?.error ?? 'Something went wrong. Please try again.'));
  }
  return data as T;
}

export const money = (paise: number, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);

export const niceDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export const MEAL_PLANS: Record<string, string> = {
  EP: 'Room only',
  CP: 'Breakfast included',
  MAP: 'Breakfast and one meal',
  AP: 'All meals included',
};

export interface EngineInfo {
  property: { id: string; name: string; tagline: string | null; currency: string; timezone: string; checkInTime: string; checkOutTime: string; phone: string | null; email: string | null; amenities: string[] };
  today: string;
  rooms: { id: string; name: string; shortDescription: string | null; description: string | null; sizeSqft: number | null; bedType: string | null; maxAdults: number; maxChildren: number; maxOccupancy: number; images: string[] }[];
  payment: { provider: 'razorpay' | 'demo'; payAtHotel: boolean };
}

export interface RateOffer {
  ratePlanId: string;
  name: string;
  description: string | null;
  mealPlan: string;
  refundable: boolean;
  policyText: string;
  nights: { date: string; price: number; tax: number }[];
  subtotal: number;
  tax: number;
  total: number;
}

export interface RoomOffer {
  roomTypeId: string;
  name: string;
  available: number;
  unavailableReason: string | null;
  rates: RateOffer[];
}

export interface BookingView {
  reference: string;
  status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
  checkIn: string;
  checkOut: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  specialRequests: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  paid: number;
  paymentMode: 'pay_now' | 'pay_at_hotel';
  cancelPenalty: number | null;
  policyText: string;
  cancellationChargeIfCancelledToday: number;
  rooms: { roomName: string; ratePlanName: string; adults: number; children: number }[];
  hotel: { name: string; phone: string | null; email: string | null; address: string; checkInTime: string; checkOutTime: string };
  refunded?: number;
}

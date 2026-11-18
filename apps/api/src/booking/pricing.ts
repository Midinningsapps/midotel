// Pure pricing rules. No database access here, so every rule can be unit-tested.
// All money is integer paise. Dates are 'YYYY-MM-DD' hotel-local calendar dates.

export interface TaxSlab {
  /** Highest per-night room price (paise) this rate applies to; null = no upper limit. */
  upTo: number | null;
  /** Percent, e.g. 5 or 18. */
  rate: number;
}

/** Default India GST for hotel accommodation (per room per night): up to Rs 7,500 at 5%, above at 18%. */
export const INDIA_HOTEL_GST: TaxSlab[] = [
  { upTo: 750000, rate: 5 },
  { upTo: null, rate: 18 },
];

export interface BaseRate {
  price: number;
  extraAdult: number;
  extraChild: number;
}

export interface Derivation {
  kind: 'percent' | 'amount';
  value: number;
}

export interface CancellationRule {
  daysBefore: number;
  penaltyType: 'percent' | 'nights';
  value: number;
}

export interface PolicySnapshot {
  name: string;
  rules: CancellationRule[];
  isNonRefundable: boolean;
}

const DAY = 86_400_000;
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(parse(d) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((parse(to) - parse(from)) / DAY);
export const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(parse(d)) && new Date(parse(d)).toISOString().startsWith(d);

/** The nights of a stay: check-in up to, but not including, check-out. */
export function stayNights(checkIn: string, checkOut: string): string[] {
  const n = daysBetween(checkIn, checkOut);
  return Array.from({ length: Math.max(n, 0) }, (_, i) => addDays(checkIn, i));
}

/** Today's date in the hotel's time zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Price of one room for one night before tax.
 * The base price covers `baseOccupancy` guests (adults first). Extra adults and children beyond that pay supplements.
 */
export function roomNightPrice(rate: BaseRate, baseOccupancy: number, adults: number, children: number, derive?: Derivation | null): number {
  const extraAdults = Math.max(adults - baseOccupancy, 0);
  const freeChildSlots = Math.max(baseOccupancy - adults, 0);
  const extraChildren = Math.max(children - freeChildSlots, 0);
  let price = rate.price + extraAdults * rate.extraAdult + extraChildren * rate.extraChild;
  if (derive) {
    price = derive.kind === 'percent' ? Math.round((price * (100 + derive.value)) / 100) : price + derive.value;
  }
  return Math.max(price, 0);
}

/** GST for one room-night, chosen by that night's room price. */
export function nightTax(price: number, slabs: TaxSlab[]): number {
  const sorted = [...slabs].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  const slab = sorted.find((s) => s.upTo === null || price <= s.upTo) ?? sorted[sorted.length - 1];
  return slab ? Math.round((price * slab.rate) / 100) : 0;
}

export interface PricedNight {
  date: string;
  price: number;
  tax: number;
}

export function priceStay(
  nights: string[],
  rateFor: (date: string) => BaseRate | undefined,
  baseOccupancy: number,
  adults: number,
  children: number,
  slabs: TaxSlab[],
  derive?: Derivation | null,
): { nights: PricedNight[]; subtotal: number; tax: number; total: number } | null {
  const priced: PricedNight[] = [];
  for (const date of nights) {
    const rate = rateFor(date);
    if (!rate) return null; // no price loaded for this night: not sellable
    const price = roomNightPrice(rate, baseOccupancy, adults, children, derive);
    priced.push({ date, price, tax: nightTax(price, slabs) });
  }
  const subtotal = priced.reduce((s, n) => s + n.price, 0);
  const tax = priced.reduce((s, n) => s + n.tax, 0);
  return { nights: priced, subtotal, tax, total: subtotal + tax };
}

/**
 * Cancellation charge for a booking cancelled on `today` (hotel-local date).
 * Every rule whose window has started applies; the highest charge wins. Non-refundable = full amount.
 */
export function cancellationPenalty(
  policy: PolicySnapshot | null,
  checkIn: string,
  today: string,
  rooms: { nights: PricedNight[] }[],
): number {
  const total = rooms.reduce((s, r) => s + r.nights.reduce((a, n) => a + n.price + n.tax, 0), 0);
  if (!policy) return 0;
  if (policy.isNonRefundable) return total;
  const daysLeft = daysBetween(today, checkIn);
  let penalty = 0;
  for (const rule of policy.rules) {
    if (daysLeft > rule.daysBefore) continue;
    const charge =
      rule.penaltyType === 'percent'
        ? Math.round((total * Math.min(rule.value, 100)) / 100)
        : rooms.reduce((s, r) => s + r.nights.slice(0, rule.value).reduce((a, n) => a + n.price + n.tax, 0), 0);
    penalty = Math.max(penalty, charge);
  }
  return Math.min(penalty, total);
}

/** Plain-language summary of a policy for guests. */
export function describePolicy(policy: PolicySnapshot | null): string {
  if (!policy) return 'Free cancellation.';
  if (policy.isNonRefundable) return 'Non-refundable: the full amount is charged if you cancel.';
  if (!policy.rules.length) return 'Free cancellation.';
  const parts = [...policy.rules]
    .sort((a, b) => b.daysBefore - a.daysBefore)
    .map((r) => {
      const what = r.penaltyType === 'percent' ? `${r.value}% of the booking` : `${r.value} night${r.value === 1 ? '' : 's'}`;
      return r.daysBefore === 0 ? `on the day of arrival, ${what} is charged` : `within ${r.daysBefore} day${r.daysBefore === 1 ? '' : 's'} of arrival, ${what} is charged`;
    });
  const first = Math.max(...policy.rules.map((r) => r.daysBefore));
  return `Free cancellation until ${first + 1} days before arrival; ${parts.join('; ')}.`;
}

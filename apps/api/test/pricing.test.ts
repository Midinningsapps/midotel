import { describe, expect, it } from 'vitest';
import {
  cancellationPenalty,
  describePolicy,
  INDIA_HOTEL_GST,
  isDate,
  nightTax,
  priceStay,
  roomNightPrice,
  stayNights,
  todayIn,
} from '../src/booking/pricing.ts';

const rate = { price: 500000, extraAdult: 150000, extraChild: 80000 }; // Rs 5,000 base

describe('stay nights', () => {
  it('lists nights from check-in up to check-out, across month ends', () => {
    expect(stayNights('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    expect(stayNights('2026-12-30', '2026-12-30')).toEqual([]);
  });
  it('validates dates strictly', () => {
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-2-3')).toBe(false);
  });
  it('knows today in the hotel time zone', () => {
    // 20:00 UTC on 18 Nov is already 19 Nov in India.
    expect(todayIn('Asia/Kolkata', new Date('2026-11-18T20:00:00Z'))).toBe('2026-11-19');
  });
});

describe('room night price', () => {
  it('base price covers base occupancy', () => {
    expect(roomNightPrice(rate, 2, 2, 0)).toBe(500000);
    expect(roomNightPrice(rate, 2, 1, 1)).toBe(500000); // child fills a free slot
  });
  it('charges extra adults and children beyond base occupancy', () => {
    expect(roomNightPrice(rate, 2, 3, 0)).toBe(650000);
    expect(roomNightPrice(rate, 2, 2, 1)).toBe(580000);
    expect(roomNightPrice(rate, 2, 3, 2)).toBe(500000 + 150000 + 160000);
  });
  it('applies derived plans', () => {
    expect(roomNightPrice(rate, 2, 2, 0, { kind: 'percent', value: -10 })).toBe(450000);
    expect(roomNightPrice(rate, 2, 2, 0, { kind: 'amount', value: 80000 })).toBe(580000);
    expect(roomNightPrice(rate, 2, 2, 0, { kind: 'amount', value: -900000 })).toBe(0);
  });
});

describe('GST', () => {
  it('uses 5% up to Rs 7,500 per night and 18% above', () => {
    expect(nightTax(750000, INDIA_HOTEL_GST)).toBe(37500);
    expect(nightTax(750001, INDIA_HOTEL_GST)).toBe(135000);
    expect(nightTax(100000, INDIA_HOTEL_GST)).toBe(5000);
  });
  it('prices a stay night by night, so the slab can change between nights', () => {
    const rates: Record<string, typeof rate> = {
      '2026-12-30': { ...rate, price: 700000 },
      '2026-12-31': { ...rate, price: 1200000 },
    };
    const r = priceStay(['2026-12-30', '2026-12-31'], (d) => rates[d], 2, 2, 0, INDIA_HOTEL_GST)!;
    expect(r.nights.map((n) => n.tax)).toEqual([35000, 216000]);
    expect(r.subtotal).toBe(1900000);
    expect(r.total).toBe(1900000 + 251000);
  });
  it('is not sellable when a night has no price', () => {
    expect(priceStay(['2026-12-30'], () => undefined, 2, 2, 0, INDIA_HOTEL_GST)).toBeNull();
  });
});

describe('cancellation', () => {
  const rooms = [{ nights: [{ date: '2026-12-10', price: 500000, tax: 25000 }, { date: '2026-12-11', price: 500000, tax: 25000 }] }];
  const policy = {
    name: 'Standard',
    isNonRefundable: false,
    rules: [
      { daysBefore: 3, penaltyType: 'nights' as const, value: 1 },
      { daysBefore: 0, penaltyType: 'percent' as const, value: 100 },
    ],
  };
  it('is free before the window', () => {
    expect(cancellationPenalty(policy, '2026-12-10', '2026-12-01', rooms)).toBe(0);
  });
  it('charges one night inside 3 days', () => {
    expect(cancellationPenalty(policy, '2026-12-10', '2026-12-07', rooms)).toBe(525000);
  });
  it('charges everything on arrival day', () => {
    expect(cancellationPenalty(policy, '2026-12-10', '2026-12-10', rooms)).toBe(1050000);
  });
  it('non-refundable charges the full amount', () => {
    expect(cancellationPenalty({ ...policy, isNonRefundable: true }, '2026-12-10', '2026-11-01', rooms)).toBe(1050000);
  });
  it('describes the policy for guests', () => {
    expect(describePolicy(policy)).toContain('Free cancellation until 4 days before arrival');
    expect(describePolicy(null)).toBe('Free cancellation.');
  });
});

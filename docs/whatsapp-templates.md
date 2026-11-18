# WhatsApp message templates

WhatsApp only allows businesses to start a conversation with a **pre-approved template**.
Register these two templates in Meta Business Manager (WhatsApp Manager → Message templates) before
turning on `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`. Category: **Utility**. Language: **English (en)**.
The wording below must match `apps/api/src/notify/whatsapp.ts`.

## booking_confirmed

```
Hello {{1}}, your stay at {{2}} is confirmed. Check-in: {{3}} for {{4}} night(s). Booking reference: {{5}}. Total: {{6}}. View or cancel your booking: {{7}}
```

Sample values for Meta's review: `Asha`, `Lakeview Palace Udaipur`, `Mon, 30 Nov 2026, from 14:00`, `2`, `MDCTHEUVGV`,
`₹27,140 (₹27,140 to pay at the hotel)`, `https://book.example.com/booking/MDCTHEUVGV?token=abc`.

## booking_cancelled

```
Hello {{1}}, your booking {{3}} at {{2}} has been cancelled. {{4}}
```

Sample values: `Asha`, `Lakeview Palace Udaipur`, `MDCTHEUVGV`, `There is no cancellation charge.`

## Rules we follow

- Messages go only to guests who ticked the WhatsApp opt-in on the booking page (stored as `booking.whatsapp_opt_in`).
- Numbers are converted to international format; Indian 10-digit mobiles get +91. Landlines are skipped.
- Delivery uses the same outbox and retries as email; failures show in the reservation's message log.

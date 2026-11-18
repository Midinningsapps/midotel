# Channel manager integration

Midotel connects to the hotel's channel manager (eZee Centrix, STAAH), which connects to the OTAs
(Booking.com, MakeMyTrip, Agoda, Expedia, Goibibo).

## What flows where

| Direction | When | What |
| --- | --- | --- |
| Midotel → channel manager | A booking is made or cancelled on the hotel website | The booking, so the CM reduces availability on every OTA |
| Midotel → channel manager | Rates, availability or restrictions change in Midotel (only if Midotel is the "master") | Availability, closures, min stay, prices per mapped rate |
| Channel manager → Midotel | An OTA booking is made or cancelled | The booking: stored with source "channel", rooms blocked on the website |
| Channel manager → Midotel | Rates change in the CM (only if the CM is the "master") | New prices and rooms to sell |

Outgoing messages use a queue with retries (`channel_outbox`); incoming ones are logged (`channel_inbound_log`).
Values are read fresh when a message is sent, so a retry never sends stale prices.

## Status per provider

| Provider | Outgoing | Incoming | Next step |
| --- | --- | --- | --- |
| Simulator | Done | Done | Used for demos and tests |
| STAAH | Draft (standard OTA XML) | Not built | Get API spec and sandbox from STAAH, adapt `apps/api/src/channel/adapters.ts`, pass their certification |
| eZee Centrix | Draft (standard OTA XML) | Not built | Same, with eZee |

What to ask STAAH and eZee for: the PMS/booking-engine connectivity API documentation, sandbox credentials,
a test hotel code, and their certification checklist.

## Simulator webhook format

`POST /channels/<connection id>/inbound` with `Authorization: Bearer <secret shown when the connection was created>`.

New OTA booking:

```json
{
  "type": "booking", "action": "new", "externalReference": "BDC-123456", "channelName": "Booking.com",
  "checkIn": "2026-12-01", "checkOut": "2026-12-03", "currency": "INR", "total": 1365000,
  "guest": { "name": "Lena Fischer", "email": null, "phone": null },
  "rooms": [{ "roomCode": "SIM-DLX", "rateCode": "SIM-DLX-BB", "adults": 2, "children": 0 }]
}
```

Cancel: same body with `"action": "cancel"`. Rate/availability update (CM is master):

```json
{ "type": "ari", "updates": [{ "roomCode": "SIM-DLX", "rateCode": "SIM-DLX-BB", "from": "2026-12-01", "to": "2026-12-07", "price": 720000, "available": 3 }] }
```

Amounts are in paise. Outgoing simulator messages are appended to `.data/channel/<hotel code>.jsonl`.

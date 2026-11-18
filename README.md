# Midotel

Hotel websites, a direct booking engine and channel manager integration (eZee, STAAH) for Indian hotels and chains.

See `CLAUDE.md` for architecture decisions and conventions.

## Run locally

Needs Node 24+.

```bash
npm install
cp .env.example .env
npm run db:start      # terminal 1: local Postgres on :5433 (keep running)
npm run db:migrate    # once, and after pulling new migrations
npm run dev           # terminal 2: API on :4000, admin on :3000, hotel sites on :3001
```

Open http://localhost:3000/signup and create a hotel account.

## Tests

```bash
npm test         # API tests on a throwaway Postgres, including tenant isolation
npm run typecheck
```

## Status

- Phase 0 (done): accounts, companies and hotels, roles, room types, hostname routing, admin screens.
- Phase 1 (demo slice done): website builder with pages, sections, photo library, theme colours, preview and publish; Aurora theme.
  A published site is visible at http://localhost:3001/s/<hostname> after adding a domain to the hotel.
- Next: rates, inventory and the booking engine.

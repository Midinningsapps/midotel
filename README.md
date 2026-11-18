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
npm run dev           # terminal 2: API on :4000, admin on :3000
```

Open http://localhost:3000/signup and create a hotel account.

## Tests

```bash
npm test         # API tests on a throwaway Postgres, including tenant isolation
npm run typecheck
```

## Status

- Phase 0 (done): accounts, companies and hotels, roles, room types, hostname routing, admin screens.
- Next: website CMS (themes, page sections, publish), then rates, inventory and the booking engine.

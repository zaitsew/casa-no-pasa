# Architecture

```
Telegram ──webhook──▶ app/api/telegram ─▶ src/bot/handler ─▶ src/engine (extract, assess, draft, store)
Cloudflare Email Worker ─▶ app/api/inbound/<alias> ─┘                    │
landlord ─▶ app/d/<token> (page) and /file/<id> ─▶ src/server/grants ────┴─▶ SQLite + encrypted files
```

## Modules

- `src/engine/`: the S1.1 engine and the SQLite store. The store is the only code that touches the database.
- `src/bot/tg.ts` Bot API client (injectable fetch). `handler.ts` updates, commands, onboarding, buttons.
  `fields.ts` the profile and filter questions. `cards.ts` the listing card. `strings.ts` en, es, ru.
- `src/server/`: `auth.ts` constant-time compare. `files.ts` AES-256-GCM. `grants.ts` dossier tokens.
  `runtime.ts` builds the engine, bot and file store from the environment.
- `app/`: route handlers (`api/telegram`, `api/inbound/[alias]`, `api/health`, `d/[token]`, `d/[token]/file/[id]`)
  and two pages (landing, privacy). The dossier page is a route handler because an expired link needs HTTP 410.

## Data flow of a card

Message or forward or photo ─▶ `engine.handleInput(userId, raw)` (userId = Telegram `from.id`) ─▶ one card per
listing ─▶ buttons carry an opaque key that maps to (renter, listing); the handler re-checks the pressing user.

## Tables (SQLite, `src/engine/store.ts`)

users, profiles, filters, listings, occurrences, events (S1.1); invites (code hash, used_by), bot_state
(open question, ticked documents, privacy acknowledgements), documents (label, mime, size, stored name), grants
(token hash, scope, expiry, revoked, sealed token), inbound_aliases (alias hash), listing_keys (S1.2).

## Where secrets live

All in the environment, never in the repo: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`CASANOPASA_FILES_KEY` (AES key, 64 hex), `CASANOPASA_INBOUND_SECRET`, `ACCOUNTS_SERVICE_CASANOPASA`.
Locally in `.env`; on the droplet in `/srv/casanopasa/.env` (mode 600). Dossier tokens, invite codes and inbound
aliases are stored as SHA-256 hashes. The key is the only way to read a document or rebuild a dossier link.

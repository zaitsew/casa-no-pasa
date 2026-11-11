# Casa No Pasa

*No dejamos pasar ni una casa.*

Casa No Pasa helps Barcelona renters reply first and well to new flat listings. The renter shares a link,
text or screenshot of an ad; within a minute the tool says whether it looks like a real long-term flat,
whether it fits the renter's filters, which red flags it carries, and gives a ready reply in Spanish,
Catalan or English. The renter sends the reply, always. The tool never sends, applies or pays.

## Status

S1.2: the Telegram bot, the dossier page and the inbound-email endpoint, on top of the S1.1 engine. Access is
by invitation until Sprint 3. Not live until the owner deploys it and registers the webhook.

## Quick start (owner)

```
1. Create a bot with @BotFather; copy its token and username into .env (see .env.example).
2. Fill the rest of .env, and the same values in the droplet's /srv/casanopasa/.env (deploy/droplet/.env.example).
3. ./scripts/deploy.sh
4. npm run telegram-setup        # webhook + command menus; add -- --check to see what is missing
5. npm run invite -- --remote    # prints a code and a t.me link; send it to the renter
```

Developers: `npm ci && cp .env.example .env && ./check.sh`. Without the accounts-hub variables the AI is off:
extraction uses rules and replies use templates. `npm run dev` starts the web part on :3000.

## What is here

- `src/core/schema.ts`: the engine contract. `src/engine/`: extraction, assessment, drafts, SQLite store, `createEngine().handleInput`.
- `src/bot/`: Telegram client, webhook handler, onboarding questions, listing cards, strings (en, es, ru).
- `src/server/`: encrypted files, dossier grants, runtime wiring. `app/`: webhook, dossier page, inbound email, landing, privacy.
- `deploy/droplet/`, `scripts/deploy.sh`: the shared droplet. `deploy/cloudflare/email-worker.ts`: the alert-email worker (source only).
- `docs/PLAN.md`: product, decisions D1-D6, security and privacy. `docs/PRIVACY.md`: what is stored. `docs/ARCHITECTURE.md`: modules and data flow.

## Alert emails (a later setup step)

The endpoint `POST /api/inbound/<alias>` exists; nothing feeds it yet. To wire it: set `CASANOPASA_INBOUND_SECRET`
on the droplet, add the domain `in.casanopasa.fabriquefutur.com` to Cloudflare Email Routing with a catch-all
rule that runs a Worker built from `deploy/cloudflare/email-worker.ts` (variable `CASANOPASA_URL`, secret
`CASANOPASA_INBOUND_SECRET`, dependency `postal-mime`). The renter sends `/email` to the bot to get a personal
address and sets a Gmail filter that forwards Idealista, Fotocasa, Habitaclia and Pisos.com alerts to it.
Gmail's forwarding confirmation is relayed to the renter in the chat.

## Licence

Apache-2.0, see `LICENSE`.

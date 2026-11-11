# Casa No Pasa

*No dejamos pasar ni una casa.*

Casa No Pasa helps Barcelona renters reply first and well to new flat listings. The renter shares a link,
text or screenshot of an ad; within a minute the tool says whether it looks like a real long-term flat,
whether it fits the renter's filters, which red flags it carries, and gives a ready reply in Spanish,
Catalan or English. The renter sends the reply, always. The tool never sends, applies or pays.

## Status

S1.1: the engine only (extract, assess, draft, store). No bot yet; S1.2 adds the Telegram bot and the dossier page.

## Quick start

```
git clone https://github.com/zaitsew/casa-no-pasa && cd casa-no-pasa
npm ci
cp .env.example .env
./check.sh
npm test
```

Without the accounts-hub variables the AI is off: extraction uses rules and replies use templates.

## What is here

- `src/core/schema.ts`: the engine contract (listing, profile, filters, flags, assessment, draft).
- `src/engine/`: portal URL detection, extraction, assessment, drafts, SQLite store, and `createEngine().handleInput`.
- `scripts/usage.ts`: usage counters (`./check.sh usage`).
- `docs/PLAN.md`: product, decisions D1–D6, security and privacy. `docs/PRIVACY.md`: what is stored.

## Licence

Apache-2.0, see `LICENSE`.

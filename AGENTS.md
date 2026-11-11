# casa-no-pasa — agent guide

Casa No Pasa helps Barcelona renters reply first and well to new flat listings. Read `docs/PLAN.md`
(product, decisions D1–D6, security and privacy) before you change anything.

## How to run / check it

```
./check.sh          # prints what is missing, then type check and tests
./check.sh usage    # key=value counters from the SQLite store
```

## Conventions

- `src/core/schema.ts` is the engine contract. Surfaces depend on it, not on `src/engine` internals.
- The renter sends every message (D1). The model never writes a fact (D2). Flags explain, never clear (D3).
- Everything in the repo is English, except reply and UI copy, which lives in `src/engine/templates.ts`.
- Test fixtures are invented: no real listings, no real phone numbers.
- No network calls in tests: inject `fetch`.
- Shipping: open the PR and stop unless this repo is named on the merge-approved list in
  `~/.claude/CLAUDE.md`. One PR per logical unit, `gh pr merge --merge`, never squash, never force-push.

Shared session policy for every harness: `~/.agents/POLICY.md`.

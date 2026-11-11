# Privacy

Draft: owner-only use until Sprint 3.

## What Casa No Pasa stores

- Profile facts the renter typed: name, occupation, contract type, net income, number of occupants, pets,
  move-in date, availability, phone, and the reply language.
- Filters (budget, zones, rooms, size, pets, lift, furnished).
- Listings the renter shared (text, link, extracted facts) and events on them (card shown, copied, sent,
  not for me, viewing).
- Documents the renter uploads for the dossier (from S1.2), encrypted at rest with AES-256-GCM.

## Where

One EU-region server, in a SQLite file. Model calls go through the accounts hub to Anthropic and carry the
listing text or screenshot and the profile facts needed for a reply. Documents are never sent to a model.
Portal pages are never fetched. The tool sends no message on the renter's behalf.

## How long

- Listings and their events: 90 days.
- Documents: until the renter deletes them or sends `/delete`.
- Profile and filters: until `/delete`.

## How to delete

Send `/delete` to the bot (S1.2). It removes the profile, filters, listings, events, documents and dossier
grants. Until the bot exists, ask the owner.

## Outbound hosts

| host | what is sent |
|---|---|
| the accounts hub (`ACCOUNTS_URL`) | listing text or screenshot, profile facts for a draft; the renter's id as an opaque string |
| `wa.me` | nothing: the link is built for the renter to open |

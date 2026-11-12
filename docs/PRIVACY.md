# Privacy

Draft: invited renters only until Sprint 3.

## What Casa No Pasa stores

- Profile facts the renter typed: name (the first name from the Telegram profile unless the renter changes it), occupation, contract type, net income, number of occupants, pets,
  move-in date, availability, phone, and the reply language.
- Filters (budget, zones, rooms, size, pets, lift, furnished).
- Listings the renter shared (text, link, extracted facts) and events on them (card shown, copied, sent,
  not for me, viewing).
- Documents the renter uploads for the dossier, encrypted at rest with AES-256-GCM.
- Dossier links the renter creates (a hash of the link, the link sealed with the server's key so replies can
  carry it, the documents it covers, its expiry) and an inbound alert-email address (a hash of it).
- The Telegram user id, which is how the bot knows the renter, and an invite record (a hash of the code).

## Where

One EU-region server, in a SQLite file. Model calls go through the accounts hub to Anthropic and carry the
listing text or screenshot and the profile facts needed for a reply. Documents are never sent to a model.
Portal pages are never fetched. The tool sends no message on the renter's behalf.

## How long

- Listings and their events: 90 days.
- Documents: until the renter deletes them or sends `/delete`.
- Profile and filters: until `/delete`.

## How to delete

Send `/delete` to the bot. It removes the profile, filters, listings, events, documents, dossier grants and
the alert-email address. `/revoke` switches off every dossier link without deleting anything else. A dossier
link also stops working at its expiry (24 hours or 7 days).

## Outbound hosts

| host | what is sent |
|---|---|
| the accounts hub (`ACCOUNTS_URL`) | listing text or screenshot, profile facts for a draft; the renter's id as an opaque string |
| `api.telegram.org` | the bot's messages to the renter, and the files the renter sends it |
| `wa.me` | nothing: the link is built for the renter to open |

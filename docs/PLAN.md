# Casa No Pasa — plan

*No dejamos pasar ni una casa.*

The owner's words for this product, verbatim (2026-11-11):

> "Let's develop a tool that will search for apartments to rent in starting with Barcelona, Spain. This is a
> highly competitive market - it is very hard to find an apartment for rent - and quite often there is maximum
> couple of hours since the publication about the apartment available for rent to answer to it and to get an
> apointment to see it. The main marketplace is Idealista, but also there are good apartments that are
> published only in social media groups, instagram stories, etc. Can we develop a tool to help renters to get
> the best apartments?"

## The bet

Alerts are a solved, crowded market (Idealista's own instant alerts, Prio, Rentsignal). The viewing goes to
the **first complete, credible reply**. Casa No Pasa owns the minute after a listing appears:

1. A listing reaches the renter from any source.
2. Within 60 s of arrival the renter sees: is it a real long-term flat, does it match, is the price legal and
   sane, is it a scam, and a ready reply in Spanish, Catalan or English.
3. The renter taps once to copy the reply (or open WhatsApp with it filled in) and sends it **themselves**.
4. The reply can carry a link to the renter's tenant file (dossier): an expiring page with the facts a landlord
   asks for, and the documents the renter chose to share.

The tool never sends a message, never applies, never pays. Agents propose; the renter decides.

## Sources (legal only)

| source | how it arrives | sprint |
|---|---|---|
| Anything the renter sees (Idealista app push, Instagram story, Facebook group post, a friend's message) | Shared or forwarded to the Telegram bot: a link, text or a screenshot | S1 |
| Saved-search alert emails from Idealista, Fotocasa, Habitaclia, Pisos.com | The renter's Gmail filter forwards them to a personal inbound address | S1 endpoint, S2 wiring |
| Telegram rental groups | Forwarded by the renter; the bot reads a group only where an admin added it | S2 |

Never: scraping Idealista or any portal (their terms forbid it; DataDome blocks it), unofficial Meta clients,
reading closed groups or other people's stories, auto-sending.

## Surface

**Primary: the Telegram bot** (declared in `teyla.toml`). Reasons: the share sheet of every iPhone app can send
to Telegram (Idealista, Instagram, Safari, Photos); Telegram groups forward natively; push is instant and
free; no App Store record is needed while the submission hold stands; any renter can start it with one tap.
A small web part serves the dossier page and the landing page. An iOS share extension is a later option, only
on a written trigger.

## Sprint 1 — engine and bot (this sprint)

| PR | what ships |
|---|---|
| S1.1 engine | Repo scaffold; `Listing` and `Profile` schemas; extraction (portal URL ids, text, screenshot via the hub); dedupe; match and red flags; seasonal-contract detection; Barcelona rent rules note; reply drafts (hub, with a template fallback); SQLite store; usage probe; tests |
| S1.2 bot and dossier | Telegram webhook: onboarding (profile, filters, documents), listing card with flags and draft, buttons (copy, WhatsApp, Catalan/English, sent, not for me); dossier page with an expiring token and AES-256-GCM documents at rest; inbound-email endpoint; deploy files for the droplet |

Done means: the owner forwards an Idealista link or a screenshot of an Instagram story to the bot and gets the card
with a correct draft in under 60 s; the dossier link opens on a phone and expires.

## Sprint 2 — speed and coverage

Alert-email wiring (Cloudflare Email Routing to an inbound address per renter, Gmail forward verification
relayed by the bot); latency log (arrival → card → marked sent); viewing log and follow-ups; neighbourhood
price comparison from Barcelona open data; Telegram group mode.

## Sprint 3 — other renters

Public landing page, onboarding for strangers, a hub budget per renter, privacy policy, deletion on request.
A business test (relocation agencies) only after the viewing log shows more viewings per reply.

## Decisions

- **D1 The renter sends.** No auto-send, no form submission, no portal account use. Liability, platform bans
  and GDPR all point the same way.
- **D2 The model never writes a fact.** Extraction returns fields with the source text; drafts may use only
  profile facts and listing facts; a draft that contains a number not present in either is replaced by the
  template.
- **D3 Flags explain, never clear.** The tool says "red flag: asks for a deposit before a viewing"; it never
  says a listing is safe.
- **D4 Rent rules are a note with a link, not a verdict.** Barcelona is a stressed zone; the legal cap depends on
  facts an ad rarely has (previous rent, landlord size). The card says what is missing and links to the
  official index.
- **D5 Documents stay ours.** Files the renter uploads are encrypted at rest (AES-256-GCM, key in the
  environment), served only through an expiring dossier link the renter creates, and deleted on `/delete`.
- **D6 Model:** Haiku 5.5 through the accounts hub for extraction and drafts (cheap, fast); a kill switch
  `CASANOPASA_AI=off` leaves the bot working with templates.

## Security and privacy (before the bot collects anything)

- **Identity.** A renter is their Telegram user id, taken only from a webhook update verified by the secret-token header. Every store call takes that id; no surface accepts a user id or listing id from a request body or a button payload as proof of ownership. Inbound email routes by a random per-renter alias (128 bits), never by a guessable name.
- **Dossier grants.** A grant is a random 128-bit token stored as a SHA-256 hash, scoped to the documents the renter ticked, with an expiry checked on every page view and download, and revocable with `/revoke`. Responses carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; tokens never appear in logs.
- **Notice at collection.** The bot shows a short privacy notice (what is stored, where, for how long, how to delete) before the first profile question and before the first document upload, linking `docs/PRIVACY.md`. `/delete` removes the profile, filters, listings, events, documents and grants.
- **Untrusted text.** Listing text, emails and screenshots are data. Prompts say so; model output is validated with zod and the D2 checks before anyone sees it.
- **A bare link carries no facts.** Casa No Pasa does not fetch portal pages. A link with no text gets a short card that asks the renter for a screenshot or the ad text, and a generic draft.

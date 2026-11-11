# Droplet deploy files

- `Dockerfile` builds the web image from the standalone Next output (see `scripts/deploy.sh`).
- `docker-compose.fragment.yml` holds one service, `casanopasa`, on port 3130 of the `apps` network.
- `Caddyfile.fragment` routes `casanopasa.fabriquefutur.com` to it. No `log` directive: `/d/<token>` carries a dossier token.
- `.env.example` is rendered to `/srv/casanopasa/.env` the first time only.

Invites for the droplet's database: `npm run invite -- --remote` (runs `invite.mjs` inside the container).

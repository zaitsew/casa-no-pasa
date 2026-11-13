# Droplet deploy files

- `Dockerfile` builds the web image from the standalone Next output (see `scripts/deploy.sh`).
- `docker-compose.fragment.yml` holds two services on the `apps` network: `casanopasa` (web, port 3130) and `casanopasa-mx` (inbound SMTP receiver, host port 25). `scripts/deploy.sh` re-renders and uploads it on every run.
- `mx-start.sh` is the receiver's entry point: it makes a self-signed STARTTLS certificate on first start, then runs `node /app/mx.mjs`.
- `Caddyfile.fragment` routes `casanopasa.fabriquefutur.com` to it. No `log` directive: `/d/<token>` carries a dossier token.
- `.env.example` is rendered to `/srv/casanopasa/.env` the first time only (both services read it).

Invites for the droplet's database: `npm run invite -- --remote` (runs `invite.mjs` inside the container).

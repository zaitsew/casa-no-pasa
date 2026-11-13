# Casa No Pasa web, for the small shared server.
#
# The image is not built from source. The droplet has 1 GB of RAM and cannot run
# `next build`, so scripts/deploy.sh builds on the laptop, assembles Next's
# standalone output into dist/droplet/app/ (server.js, .next/static, public, data,
# node_modules) and rsyncs it to /srv/casanopasa/app/. This file is copied into
# that directory and is the whole build: one COPY, no compiler, no native modules
# (the database is Node's built-in node:sqlite, which needs Node 24 or newer). The same image runs the
# inbound-mail receiver as a second service: mx-start.sh, then `node /app/mx.mjs`, a single-file bundle
# (npm run build:mx; scripts/deploy.sh).
#
#   docker build --platform linux/amd64 -t casanopasa-web dist/droplet/app

FROM node:24-alpine

# Lets deploy.sh prune old Casa No Pasa images without touching another product's.
LABEL app=casanopasa

# openssl makes the self-signed STARTTLS certificate of the inbound-mail container (mx-start.sh).
RUN apk add --no-cache openssl

WORKDIR /app
# 3130 is Casa No Pasa's port on the shared `apps` network (rumbo 3110, batrack 3120).
ENV NODE_ENV=production \
    PORT=3130 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    CASANOPASA_DB_PATH=/data/casanopasa.db \
    CASANOPASA_FILES_DIR=/data/files \
    NODE_OPTIONS="--max-old-space-size=192 --disable-warning=ExperimentalWarning"

COPY --chown=node:node . /app
# The database and the encrypted documents live in a volume mounted here (/srv/casanopasa/data on the host).
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3130
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server.js"]

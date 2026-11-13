#!/usr/bin/env bash
# Deploy Casa No Pasa to the shared droplet (fabrique-apps-1): build on this machine,
# ship Next's standalone output, build the image on the box, wait for it to answer.
#
#   ./scripts/deploy.sh                 build, ship, (first run: create the product), start
#   ./scripts/deploy.sh --dry           print what would run; build and touch nothing
#   ./scripts/deploy.sh --host user@h   another ssh target (default deploy@159.89.99.84)
#
# Why a local build: the box has 1 GB of RAM and cannot run `next build`. The
# shipped bundle is plain JavaScript, so the arm64 Mac and the x86_64 droplet
# produce the same files. The database is node:sqlite, built into Node 24 (the image
# is node:24-alpine), so there is no native module to prune. Safe to re-run.
#
# Two services run from one image: `casanopasa` (the web part) and `casanopasa-mx` (the inbound SMTP
# receiver for alert emails, host port 25, bundled to app/mx.mjs with esbuild). add-product.sh renders
# the compose file only once, so every run renders deploy/droplet/docker-compose.fragment.yml again
# (same {{name}}/{{port}}/{{domain}} substitutions) and uploads it to /srv/casanopasa/docker-compose.yml.
#
# It only writes under /srv/casanopasa/ on the server. add-product.sh appends the
# `include:` line to /srv/docker-compose.yml itself; nothing here edits /srv/docker-compose.yml,
# another product's files or the shared Caddyfile. The data volume /srv/casanopasa/data is never
# deleted by a deploy (rsync excludes it).
set -euo pipefail

NAME="casanopasa"
PORT="3130"                 # the web container's port on the `apps` network; no published host port (the mx service publishes 25)
DOMAIN="fabriquefutur.com"
HOST="deploy@159.89.99.84"
SITE_URL="https://${NAME}.${DOMAIN}"
REMOTE_DIR="/srv/${NAME}"
ADD_PRODUCT="${ADD_PRODUCT:-$HOME/repos/teyla/templates/platform/add-product.sh}"
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry) DRY=1; shift ;;
    --host) HOST="${2:?--host needs user@host}"; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1 (try --help)" >&2; exit 64 ;;
  esac
done

cd "$(dirname "$0")/.."
BUNDLE="dist/droplet/app"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)
RSYNC_SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"

# run <command...> — print it in --dry mode, run it otherwise.
run() {
  if [ "$DRY" = 1 ]; then printf '[dry]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
say() { printf '== %s\n' "$*"; }

# --- 1. Build ----------------------------------------------------------------
say "build (NEXT_PUBLIC_SITE_URL=${SITE_URL})"
if command -v teyla >/dev/null 2>&1; then
  run teyla load --wait --kind build
fi
if [ "$DRY" = 1 ]; then
  echo "[dry] NEXT_PUBLIC_SITE_URL=${SITE_URL} npm run build"
else
  NEXT_PUBLIC_SITE_URL="$SITE_URL" npm run build
fi

# --- 2. Assemble the bundle --------------------------------------------------
say "assemble ${BUNDLE}"
if [ "$DRY" = 1 ]; then
  cat <<DRYEOF
[dry] rm -rf ${BUNDLE} && mkdir -p ${BUNDLE}/.next/static ${BUNDLE}/public ${BUNDLE}/data
[dry] cp -R .next/standalone/. ${BUNDLE}/
[dry] cp -R .next/static/. ${BUNDLE}/.next/static/
[dry] cp -R public/. ${BUNDLE}/public/        (if public/ exists)
[dry] cp scripts/invite.mjs ${BUNDLE}/invite.mjs
[dry] cp deploy/droplet/mx-start.sh ${BUNDLE}/mx-start.sh
[dry] npm run -s build:mx          (esbuild src/mx/main.ts -> ${BUNDLE}/mx.mjs: one ESM file, node24, dependencies bundled)
[dry] rm -rf ${BUNDLE}/node_modules/sharp ${BUNDLE}/node_modules/@img       (the Mac's native binaries)
[dry] cp deploy/droplet/Dockerfile ${BUNDLE}/Dockerfile
DRYEOF
else
  [ -f .next/standalone/server.js ] || { echo "no .next/standalone/server.js: is output: \"standalone\" set?" >&2; exit 1; }
  rm -rf "$BUNDLE"
  mkdir -p "$BUNDLE/.next/static" "$BUNDLE/public" "$BUNDLE/data"
  cp -R .next/standalone/. "$BUNDLE/"
  cp -R .next/static/. "$BUNDLE/.next/static/"
  [ -d public ] && cp -R public/. "$BUNDLE/public/"
  # The invite script runs inside the container (`npm run invite -- --remote`). Never ship a local
  # database, local documents or an .env file.
  cp scripts/invite.mjs "$BUNDLE/invite.mjs"
  rm -rf "$BUNDLE"/data/*.db "$BUNDLE"/data/*.db-* "$BUNDLE"/data/files "$BUNDLE/.env"
  # sharp is an optional dependency of next, traced for the image optimizer, which
  # next.config.ts turns off. Its binary is for this Mac, not for linux/amd64.
  rm -rf "$BUNDLE/node_modules/sharp" "$BUNDLE/node_modules/@img"
  cp deploy/droplet/Dockerfile "$BUNDLE/Dockerfile"
  # The inbound-mail receiver: one ESM file with its dependencies (smtp-server, postal-mime) bundled in.
  cp deploy/droplet/mx-start.sh "$BUNDLE/mx-start.sh"
  chmod 755 "$BUNDLE/mx-start.sh"
  npm run -s build:mx
  [ -s "$BUNDLE/mx.mjs" ] || { echo "no ${BUNDLE}/mx.mjs: did npm run build:mx fail?" >&2; exit 1; }
  if grep -qE '\.node["'"'"']' "$BUNDLE/mx.mjs"; then
    echo "mx.mjs refers to a native module; the droplet cannot run it:" >&2
    grep -nE '\.node["'"'"']' "$BUNDLE/mx.mjs" | head -5 >&2
    exit 1
  fi
  if find "$BUNDLE" -name '*.node' | grep -q .; then
    echo "native modules in the bundle; the droplet cannot run them:" >&2
    find "$BUNDLE" -name '*.node' >&2
    exit 1
  fi
  echo "  $(du -sh "$BUNDLE" | cut -f1) in ${BUNDLE}; mx.mjs $(wc -c < "$BUNDLE/mx.mjs" | tr -d ' ') bytes"
fi

# --- 3. Ship -----------------------------------------------------------------
say "rsync bundle -> ${HOST}:${REMOTE_DIR}/app/"
run rsync -az --delete --exclude '.env*' -e "$RSYNC_SSH" \
  --rsync-path "mkdir -p ${REMOTE_DIR}/app && rsync" \
  "${BUNDLE}/" "${HOST}:${REMOTE_DIR}/app/"

# The data volume sits beside app/, so the rsync above never touches it. The container runs
# as uid 1000 (the image's `node` user); make the volume writable for it. Idempotent.
say "data volume ${REMOTE_DIR}/data"
run "${SSH[@]}" "$HOST" "mkdir -p ${REMOTE_DIR}/data && docker run --rm -v ${REMOTE_DIR}/data:/data alpine chown -R 1000:1000 /data"

# --- 4. Create the product (first run) or rebuild (later runs) ---------------
# Always through the root stack in /srv (the one add-product.sh uses): running
# the product's compose file on its own would start a second compose project
# with a second container under the same network alias.
#
# add-product.sh renders the compose file only when it is missing, so on later runs a change to the
# fragment would never reach the server. Render it here with the same substitutions and upload it, on every run.
render_compose() {  # render_compose <dest> — add-product.sh's render(), for the compose fragment
  sed -e "s/{{name}}/${NAME}/g" -e "s/{{port}}/${PORT}/g" -e "s/{{domain}}/${DOMAIN}/g" deploy/droplet/docker-compose.fragment.yml > "$1"
}
COMPOSE_NEW="${REMOTE_DIR}/docker-compose.yml.new"
COMPOSE_CHECK="cd ${REMOTE_DIR} && cp docker-compose.yml docker-compose.yml.bak && mv docker-compose.yml.new docker-compose.yml && (cd /srv && docker compose config -q) || { mv ${REMOTE_DIR}/docker-compose.yml.bak ${REMOTE_DIR}/docker-compose.yml; echo 'compose file refused; the previous one is back' >&2; exit 1; }"
UP="cd /srv && docker compose up -d --build ${NAME} ${NAME}-mx && docker image prune -f --filter label=app=casanopasa >/dev/null"
if [ "$DRY" = 1 ]; then
  cat <<DRYEOF
== first run, only if ${REMOTE_DIR}/docker-compose.yml is missing on the server
[dry] ssh ${HOST} 'tmp=\$(mktemp -d)'
[dry] rsync -az --exclude Dockerfile deploy/droplet/ ${HOST}:\$tmp/droplet/
[dry] scp ${ADD_PRODUCT} ${HOST}:\$tmp/add-product.sh
[dry] ssh ${HOST} 'bash \$tmp/add-product.sh ${NAME} ${PORT} --from \$tmp/droplet --domain ${DOMAIN}; rm -rf \$tmp'
== every run
[dry] sed -e s/{{name}}/${NAME}/g -e s/{{port}}/${PORT}/g -e s/{{domain}}/${DOMAIN}/g deploy/droplet/docker-compose.fragment.yml > \$tmpfile
[dry] chmod 644 \$tmpfile && rsync -a \$tmpfile ${HOST}:${COMPOSE_NEW}
[dry] ssh ${HOST} 'keep the old file as docker-compose.yml.bak, move the new one in, run docker compose config -q in /srv, restore the old one if it fails'
[dry] ssh ${HOST} '${UP}'
DRYEOF
else
  if "${SSH[@]}" "$HOST" "test -f ${REMOTE_DIR}/docker-compose.yml"; then
    say "${REMOTE_DIR} exists; rebuilding"
  else
    say "first run: creating ${NAME} with add-product.sh"
    [ -f "$ADD_PRODUCT" ] || { echo "missing $ADD_PRODUCT (set ADD_PRODUCT=...)" >&2; exit 1; }
    tmp="$("${SSH[@]}" "$HOST" 'mktemp -d')"
    rsync -az --exclude Dockerfile -e "$RSYNC_SSH" deploy/droplet/ "${HOST}:${tmp}/droplet/"
    rsync -az -e "$RSYNC_SSH" "$ADD_PRODUCT" "${HOST}:${tmp}/add-product.sh"
    "${SSH[@]}" "$HOST" "bash ${tmp}/add-product.sh ${NAME} ${PORT} --from ${tmp}/droplet --domain ${DOMAIN}; rc=\$?; rm -rf ${tmp}; exit \$rc"
    echo "  first run: fill ${REMOTE_DIR}/.env (see deploy/droplet/.env.example), then:"
    echo "    ssh ${HOST} 'cd /srv && docker compose up -d ${NAME} ${NAME}-mx'"
  fi
  say "compose file -> ${REMOTE_DIR}/docker-compose.yml"
  rendered="$(mktemp)"
  render_compose "$rendered"
  chmod 644 "$rendered"   # macOS openrsync has no --chmod; rsync -a carries the mode over
  rsync -a -e "$RSYNC_SSH" "$rendered" "${HOST}:${COMPOSE_NEW}"
  rm -f "$rendered"
  "${SSH[@]}" "$HOST" "$COMPOSE_CHECK"
  "${SSH[@]}" "$HOST" "$UP"
fi

# --- 5. Wait for it to answer ------------------------------------------------
URL="${SITE_URL}/api/health"
say "waiting for ${URL} (up to 90 s)"
if [ "$DRY" = 1 ]; then
  echo "[dry] poll ${URL} every 3 s until HTTP 200"
  exit 0
fi
# Ask the target host's own container first, so --host never passes on another box's answer.
code="000"
for _ in $(seq 1 30); do
  if "${SSH[@]}" "$HOST" "cd /srv && docker compose exec -T ${NAME} wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null"; then
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$URL" || true)"
  fi
  [ "$code" = "200" ] && break
  sleep 3
done
if [ "$code" = "200" ]; then
  echo "ok: ${URL} -> 200"
else
  echo "FAILED: ${URL} -> ${code} after 90 s" >&2
  echo "  logs: ssh ${HOST} 'cd /srv && docker compose logs --tail 50 ${NAME}'" >&2
  exit 1
fi

#!/bin/sh
# Entry point of the casanopasa-mx container (inbound SMTP, see src/mx/server.ts).
# STARTTLS needs a certificate. Opportunistic TLS between mail servers does not validate certificates, so a
# self-signed one for the MX host is enough; it is made here on the first start of the container and kept
# in /tmp until the container is recreated. If openssl fails, the server starts without STARTTLS.
set -eu
DIR="${MX_TLS_DIR:-/tmp/mx-tls}"
HOST="${MX_TLS_HOST:-casanopasa.fabriquefutur.com}"
if [ ! -f "$DIR/key.pem" ]; then
  mkdir -p "$DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
    -subj "/CN=$HOST" -addext "subjectAltName=DNS:$HOST" >/dev/null 2>&1 \
    || { rm -f "$DIR/key.pem" "$DIR/cert.pem"; echo '{"svc":"casanopasa-mx","ev":"tls_cert_failed"}'; }
fi
exec node /app/mx.mjs

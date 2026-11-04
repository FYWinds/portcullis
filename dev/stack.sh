#!/usr/bin/env bash
# Local end-to-end stack, the same shape as production minus Traefik:
#
#   omp + plugin ──Bearer──▶ oauth2-proxy :4180 ──X-Forwarded-Email──▶ relay :7466
#   browser ──cookie──────▶        (mock OIDC issuer :9000)
#
# oauth2-proxy runs in reverse-proxy mode here; static paths skip auth like
# the public Traefik router does in production. Requires the oauth2-proxy
# binary (OAUTH2_PROXY, default: oauth2-proxy on PATH) and, for the browser
# client, a collab-web build in WEB_ROOT (see README "Local stack").
set -euo pipefail
cd "$(dirname "$0")/.."

OAUTH2_PROXY=${OAUTH2_PROXY:-oauth2-proxy}
WEB_ROOT=${WEB_ROOT:-}
HOST_ALLOW=${HOST_ALLOW:-dev@example.com}

pids=()
trap 'kill "${pids[@]}" 2>/dev/null; wait' EXIT INT TERM

EMAIL="$HOST_ALLOW" bun dev/mock-oidc.ts &
pids+=($!)
for _ in $(seq 1 50); do curl -fs http://127.0.0.1:9000/.well-known/openid-configuration >/dev/null && break; sleep 0.1; done

PORTCULLIS_IDENTITY_HEADER=X-Forwarded-Email PORTCULLIS_HOST_ALLOW="$HOST_ALLOW" HOST=127.0.0.1 \
	PORTCULLIS_WEB_ROOT="$WEB_ROOT" PORTCULLIS_LOGIN_URL='http://localhost:4180/oauth2/start?rd={rd}' \
	bun relay/src/main.ts &
pids+=($!)

"$OAUTH2_PROXY" \
	--provider=oidc --oidc-issuer-url=http://127.0.0.1:9000 \
	--client-id=proxy --client-secret=dev --cookie-secret=0123456789abcdef0123456789abcdef --cookie-secure=false \
	--email-domain='*' --http-address=127.0.0.1:4180 --upstream=http://127.0.0.1:7466/ \
	--pass-user-headers=true --reverse-proxy=true --skip-provider-button=true \
	--skip-jwt-bearer-tokens=true --extra-jwt-issuers=http://127.0.0.1:9000=portcullis-cli \
	--redirect-url=http://localhost:4180/oauth2/callback --whitelist-domain=localhost:4180 \
	'--skip-auth-route=GET=^/($|[^/]+\.[A-Za-z0-9]+$)' &
pids+=($!)

echo "stack up: relay via ws://localhost:4180 (issuer http://127.0.0.1:9000, client portcullis-cli); Ctrl+C stops"
wait

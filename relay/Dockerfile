# syntax=docker/dockerfile:1
# Build context: repository root (docker build -f relay/Dockerfile .).
ARG BUN_IMAGE=oven/bun:1.4.4-alpine

# collab-web, the browser guest client, built from the omp release the relay
# speaks to. Bump OMP_REF and OMP_SHA together when upgrading omp.
FROM ${BUN_IMAGE} AS web
ARG OMP_REF=v18.16.0
ARG OMP_SHA=650f3a108229ee11bf68ba3377f4e8c3391cd424
RUN apk add --no-cache git
WORKDIR /omp
RUN git init -q . \
	&& git remote add origin https://github.com/can1357/oh-my-pi.git \
	&& git fetch -q --depth 1 origin "${OMP_SHA}" \
	&& git checkout -q FETCH_HEAD
RUN bun install --filter '!./' --filter '@oh-my-pi/collab-web...'
WORKDIR /omp/packages/collab-web
# The upstream page loads a third-party analytics script; a self-hosted relay drops it.
RUN bun run build \
	&& sed -i '/um\.can\.ac\/script\.js/d' dist/index.html \
	&& if grep -q 'um.can.ac' dist/index.html; then echo "analytics script still present" >&2; exit 1; fi

FROM ${BUN_IMAGE}
ARG OMP_REF=v18.16.0
LABEL org.opencontainers.image.source="https://github.com/FYWinds/portcullis" \
	org.opencontainers.image.description="portcullis relay: omp collab relay behind OIDC" \
	org.opencontainers.image.licenses="MIT" \
	sh.omp.collab-web.ref="${OMP_REF}"
WORKDIR /app
COPY relay/src ./relay/src
COPY --from=web /omp/packages/collab-web/dist ./web
ENV PORT=7466 \
	PORTCULLIS_WEB_ROOT=/app/web
USER bun
EXPOSE 7466
ENTRYPOINT ["bun", "relay/src/main.ts"]

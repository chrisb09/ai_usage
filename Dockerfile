FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM build AS prod-deps
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

# curl-impersonate lets the Mistral Code collector present a browser TLS
# fingerprint to Cloudflare. Version and target are pinned; see README.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates; \
  rm -rf /var/lib/apt/lists/*; \
  case "$(dpkg --print-architecture)" in \
    amd64) ci_arch=x86_64 ;; \
    arm64) ci_arch=aarch64 ;; \
    *) echo "unsupported architecture" >&2; exit 1 ;; \
  esac; \
  node -e "const fs=require('fs');fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer()}).then(b=>fs.writeFileSync('/tmp/ci.tar.gz',Buffer.from(b)))" \
    "https://github.com/lexiforest/curl-impersonate/releases/download/v2.3.2/curl-impersonate-v2.3.2.${ci_arch}-linux-gnu.tar.gz"; \
  mkdir -p /tmp/ci && tar -xzf /tmp/ci.tar.gz -C /tmp/ci; \
  install -m 0755 /tmp/ci/curl-impersonate /usr/local/bin/curl-impersonate; \
  rm -rf /tmp/ci /tmp/ci.tar.gz

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7694
ENV DATABASE_PATH=/data/ai_usage.db
ENV WEB_ROOT=/app/web/dist

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 7694

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7694/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

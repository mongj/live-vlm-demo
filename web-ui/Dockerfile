FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable \
    && corepack prepare yarn@4.9.2 --activate \
    && yarn install --immutable

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG VLM_GATEWAY_URL=http://server:8787
ENV VLM_GATEWAY_URL=${VLM_GATEWAY_URL}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable \
    && corepack prepare yarn@4.9.2 --activate \
    && yarn build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    VLM_GATEWAY_URL=http://server:8787

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

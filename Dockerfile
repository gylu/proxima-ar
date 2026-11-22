FROM node:24-bookworm AS dependencies
WORKDIR /srv/proxima
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production PROXIMA_RUNTIME=cloud PORT=8080
WORKDIR /srv/proxima
COPY --from=dependencies /srv/proxima/node_modules ./node_modules
COPY server ./server
COPY web/manual.js web/models.js ./web/
COPY package.json ./package.json
USER node
CMD ["node", "server/start.mjs"]

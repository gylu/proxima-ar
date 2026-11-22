FROM node:24-bookworm-slim
WORKDIR /srv/proxima
COPY package.json ./
COPY gateway ./gateway
COPY server ./server
COPY web ./web
USER node
CMD ["node", "gateway/start.mjs"]

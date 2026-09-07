FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/build/app.js ./build/app.js
COPY --from=builder --chown=node:node /app/build/server.js ./build/server.js
COPY --chown=node:node package.json ./

USER node

EXPOSE 3000

CMD ["node", "build/server.js"]

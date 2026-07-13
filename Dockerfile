FROM node:20-alpine AS base

WORKDIR /app

RUN apk add --no-cache dumb-init openssl libc6-compat

# ---- Stage 1: Install production dependencies ----
FROM base AS production-deps

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev \
  && npx prisma generate

# ---- Stage 2: Build application ----
FROM base AS builder

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

COPY . .

RUN npx prisma generate \
  && npm run build \
  && npm prune --omit=dev

# ---- Stage 3: Production runtime ----
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache dumb-init openssl libc6-compat \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nestjs -u 1001 -G nodejs

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/public ./public
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package*.json ./
COPY --from=builder --chown=nestjs:nodejs /app/docker/start.sh ./docker/start.sh

RUN chmod +x ./docker/start.sh

USER nestjs

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["./docker/start.sh"]
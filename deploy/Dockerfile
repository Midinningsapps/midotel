# One image for the whole monorepo; docker-compose picks which app each container runs.
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/sections/package.json packages/sections/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/site/package.json apps/site/
COPY apps/booking/package.json apps/booking/
RUN npm ci --no-audit --no-fund
COPY . .
# Values the Next.js apps need at build time.
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_SITE_URL
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN npm run build -w @midotel/admin && npm run build -w @midotel/site && npm run build -w @midotel/booking

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
RUN rm -rf apps/*/.next/cache node_modules/@embedded-postgres \
  && useradd --system --uid 10001 midotel && mkdir -p /data/media && chown -R midotel /data
USER midotel

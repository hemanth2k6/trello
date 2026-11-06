# ==========================================
# Stage 1: Build & Dependencies Cache
# ==========================================
FROM node:20-alpine AS dependencies
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ==========================================
# Stage 2: Production Minimal Runner
# ==========================================
FROM node:20-alpine AS runner
WORKDIR /app

# Install dumb-init for proper PID 1 signal forwarding (SIGTERM / SIGINT graceful exit)
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
ENV PORT=3000

# Copy cached production dependencies
COPY --from=dependencies /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
COPY public/ ./public/

# Run as non-privileged node user for container security
USER node

EXPOSE 3000

# Health check using native Node HTTP probe (eliminates curl binary dependency)
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "src/server.js"]

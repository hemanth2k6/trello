FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY src/ ./src/

# Use non-root node user
USER node

# Expose API port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "src/server.js"]

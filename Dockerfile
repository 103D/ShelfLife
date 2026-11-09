# ShelfLife Telegram Bot + Mini App - Docker image for Render
# Build: docker build -t shelflife .
# Run: docker run -p 3000:3000 --env-file .env -v shelflife-data:/var/data shelflife

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./
# Create data directory for SQLite (will be mounted as volume)
RUN mkdir -p /var/data
EXPOSE 3000
CMD ["node", "dist/index.js"]

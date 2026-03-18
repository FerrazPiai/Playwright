FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev 2>/dev/null || true
COPY scraper.js ./
RUN mkdir -p /app/exports
ENV BROKER_URL=https://brokers.mktlab.app
ENV RETRY_ATTEMPTS=3
ENV RETRY_DELAY_MS=5000
ENV CRON_INTERVAL_MS=3600000
ENV OUTPUT_DIR=/app/exports
CMD ["node", "scraper.js"]

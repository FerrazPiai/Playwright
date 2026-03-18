FROM mcr.microsoft.com/playwright:v1.48.0-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npx playwright install chromium
COPY scraper.js ./
RUN mkdir -p /app/exports
ENV BROKER_URL=https://brokers.mktlab.app
ENV HEADLESS=true
ENV TIMEOUT_MS=60000
ENV RETRY_ATTEMPTS=3
ENV RETRY_DELAY_MS=5000
ENV CRON_INTERVAL_MS=3600000
ENV OUTPUT_DIR=/app/exports
ENV DEBUG=false
CMD ["node", "scraper.js"]

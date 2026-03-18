# ─── Brokers Lead Exporter ─────────────────────────────────────────────────────
# Playwright headless Chrome para extração automática de leads
# Deploy: Easypanel (Docker) ou qualquer host com Docker
# ───────────────────────────────────────────────────────────────────────────────

FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# Copiar dependências e instalar
COPY package.json ./
RUN npm install --omit=dev && npx playwright install chromium

# Copiar código
COPY scraper.js ./

# Diretório de saída dos exports
RUN mkdir -p /app/exports

# Variáveis de ambiente (override no Easypanel/docker-compose)
ENV BROKER_URL=https://brokers.mktlab.app
ENV BROKER_EMAIL=""
ENV BROKER_PASSWORD=""
ENV WEBHOOK_URL=""
ENV OUTPUT_DIR=/app/exports
ENV HEADLESS=true
ENV TIMEOUT_MS=60000
ENV RETRY_ATTEMPTS=3
ENV RETRY_DELAY_MS=5000

CMD ["node", "scraper.js"]

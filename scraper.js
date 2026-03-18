/**
 * Brokers MKTLab - Lead Exporter
 * Automatiza login, navegação e exportação de CSV da plataforma brokers.mktlab.app
 * 
 * Campos extraídos: Nome da Empresa, CNPJ (Documento da Empresa), Faturamento, Segmento
 * 
 * Desenvolvido por V4 Ferraz Piai & Co.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl: process.env.BROKER_URL || "https://brokers.mktlab.app",
  email: process.env.BROKER_EMAIL,
  password: process.env.BROKER_PASSWORD,
  webhookUrl: process.env.WEBHOOK_URL || "", // n8n webhook para receber os dados
  outputDir: process.env.OUTPUT_DIR || "/app/exports",
  headless: process.env.HEADLESS !== "false",
  timeout: parseInt(process.env.TIMEOUT_MS) || 60000,
  retryAttempts: parseInt(process.env.RETRY_ATTEMPTS) || 3,
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS) || 5000,
};

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${new Date().toISOString()}] ✅ ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ❌ ${msg}`),
};

// ─── Main Scraper ─────────────────────────────────────────────────────────────
async function scrape() {
  validateConfig();

  let browser;
  let attempt = 0;

  while (attempt < CONFIG.retryAttempts) {
    attempt++;
    log.info(`Tentativa ${attempt}/${CONFIG.retryAttempts}...`);

    try {
      browser = await chromium.launch({
        headless: CONFIG.headless,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });

      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      const page = await context.newPage();
      page.setDefaultTimeout(CONFIG.timeout);

      // ── Step 1: Login ────────────────────────────────────────────────────
      log.info("Acessando plataforma...");
      await page.goto(CONFIG.baseUrl, { waitUntil: "networkidle" });
      await page.waitForTimeout(2000);

      // Detectar se precisa fazer login (procura campos de email/senha)
      const needsLogin = await page
        .locator('input[type="email"], input[name="email"], input[placeholder*="mail"]')
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      if (needsLogin) {
        log.info("Realizando login...");
        
        // Tenta preencher email
        const emailInput = page.locator(
          'input[type="email"], input[name="email"], input[placeholder*="mail"], input[placeholder*="Email"]'
        ).first();
        await emailInput.fill(CONFIG.email);

        // Tenta preencher senha
        const passwordInput = page.locator(
          'input[type="password"], input[name="password"], input[placeholder*="enha"], input[placeholder*="assword"]'
        ).first();
        await passwordInput.fill(CONFIG.password);

        // Clica no botão de login
        const loginBtn = page.locator(
          'button[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Acessar")'
        ).first();
        await loginBtn.click();

        await page.waitForNavigation({ waitUntil: "networkidle", timeout: CONFIG.timeout });
        log.success("Login realizado com sucesso.");
      } else {
        log.info("Já autenticado ou página diferente do esperado.");
      }

      // ── Step 2: Navegar para "Meus Leads" ───────────────────────────────
      log.info("Navegando para Meus Leads...");

      // Tenta clicar no menu lateral primeiro
      const meusLeadsLink = page.locator('a:has-text("Meus Leads"), [href*="product-preview"]').first();
      const menuVisible = await meusLeadsLink.isVisible({ timeout: 5000 }).catch(() => false);

      if (menuVisible) {
        await meusLeadsLink.click();
        await page.waitForLoadState("networkidle");
      } else {
        // Navega direto pela URL
        const leadsUrl = new URL(page.url());
        // Tenta construir a URL baseada no padrão observado
        await page.goto(`${CONFIG.baseUrl}/v4-company-ferraz-piai-%26-co./product-preview`, {
          waitUntil: "networkidle",
        });
      }

      await page.waitForTimeout(3000);
      log.success("Página Meus Leads carregada.");

      // ── Step 3: Interceptar download do CSV ──────────────────────────────
      log.info("Exportando CSV...");

      // Garante que o diretório de saída existe
      fs.mkdirSync(CONFIG.outputDir, { recursive: true });

      // Configura listener de download ANTES de clicar
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: CONFIG.timeout }),
        page.locator('button:has-text("Exportar"), a:has-text("Exportar")').first().click(),
      ]);

      const downloadPath = path.join(CONFIG.outputDir, `leads_${getTimestamp()}.csv`);
      await download.saveAs(downloadPath);
      log.success(`CSV baixado: ${downloadPath}`);

      // ── Step 4: Processar CSV ────────────────────────────────────────────
      log.info("Processando CSV...");
      const rawCsv = fs.readFileSync(downloadPath, "utf-8");
      const records = parse(rawCsv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: [",", ";"], // plataformas BR costumam usar ;
      });

      log.info(`Total de registros no CSV: ${records.length}`);

      // Mapeia colunas — ajuste os nomes conforme o CSV real
      const leads = records.map((row) => ({
        nome_empresa: findColumn(row, ["empresa", "nome da empresa", "company", "nome_empresa"]),
        cnpj: findColumn(row, ["documento da empresa", "cnpj", "documento", "cpf_cnpj", "document"]),
        faturamento: findColumn(row, ["faturamento", "revenue", "billing"]),
        segmento: findColumn(row, ["segmento", "segment"]),
        // Campos extras para referência
        responsavel: findColumn(row, ["responsável", "responsavel", "nome", "contact"]),
        telefone: findColumn(row, ["telefone", "phone", "tel"]),
        email: findColumn(row, ["e-mail", "email"]),
        valor: findColumn(row, ["valor", "value", "price"]),
        data_compra: findColumn(row, ["data/hora de compra", "data_compra", "data", "date"]),
      }));

      // Salva JSON processado
      const jsonPath = path.join(CONFIG.outputDir, `leads_${getTimestamp()}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(leads, null, 2), "utf-8");
      log.success(`JSON processado: ${jsonPath} (${leads.length} leads)`);

      // ── Step 5: Enviar para webhook (n8n) ────────────────────────────────
      if (CONFIG.webhookUrl) {
        log.info("Enviando dados para webhook...");
        await sendToWebhook(leads);
        log.success("Dados enviados para o webhook.");
      }

      // ── Step 6: Validação básica dos dados ───────────────────────────────
      const warnings = validateData(leads);
      if (warnings.length > 0) {
        log.warn(`Validação encontrou ${warnings.length} avisos:`);
        warnings.forEach((w) => log.warn(`  → ${w}`));
      }

      await browser.close();

      return {
        success: true,
        totalLeads: leads.length,
        warnings,
        csvPath: downloadPath,
        jsonPath,
        leads,
      };
    } catch (err) {
      log.error(`Erro na tentativa ${attempt}: ${err.message}`);

      if (browser) {
        // Screenshot para debug
        try {
          const pages = browser.contexts()[0]?.pages();
          if (pages?.length > 0) {
            const screenshotPath = path.join(CONFIG.outputDir, `error_${getTimestamp()}.png`);
            await pages[0].screenshot({ path: screenshotPath, fullPage: true });
            log.info(`Screenshot de erro salvo: ${screenshotPath}`);
          }
        } catch (_) {}
        await browser.close();
      }

      if (attempt < CONFIG.retryAttempts) {
        log.info(`Aguardando ${CONFIG.retryDelayMs}ms antes de tentar novamente...`);
        await sleep(CONFIG.retryDelayMs);
      }
    }
  }

  log.error("Todas as tentativas falharam.");
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateConfig() {
  if (!CONFIG.email || !CONFIG.password) {
    throw new Error(
      "Variáveis BROKER_EMAIL e BROKER_PASSWORD são obrigatórias. Defina no .env ou nas variáveis de ambiente."
    );
  }
}

/**
 * Busca flexível de colunas no CSV — ignora case e acentos
 */
function findColumn(row, possibleNames) {
  const normalize = (str) =>
    str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

  for (const key of Object.keys(row)) {
    const normalizedKey = normalize(key);
    for (const name of possibleNames) {
      if (normalizedKey === normalize(name) || normalizedKey.includes(normalize(name))) {
        return row[key] || "";
      }
    }
  }
  return "";
}

function validateData(leads) {
  const warnings = [];
  const emptyCnpj = leads.filter((l) => !l.cnpj).length;
  const emptyEmpresa = leads.filter((l) => !l.nome_empresa).length;
  const emptyFaturamento = leads.filter((l) => !l.faturamento).length;

  if (emptyEmpresa > 0) warnings.push(`${emptyEmpresa} leads sem nome da empresa`);
  if (emptyCnpj > 0) warnings.push(`${emptyCnpj} leads sem CNPJ (pode ser normal — campo nem sempre preenchido)`);
  if (emptyFaturamento > 0) warnings.push(`${emptyFaturamento} leads sem faturamento`);
  if (leads.length === 0) warnings.push("Nenhum lead encontrado no CSV!");

  return warnings;
}

async function sendToWebhook(leads) {
  const response = await fetch(CONFIG.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      total: leads.length,
      leads,
    }),
  });

  if (!response.ok) {
    throw new Error(`Webhook retornou status ${response.status}: ${await response.text()}`);
  }
}

function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────
scrape()
  .then((result) => {
    log.success(`Extração finalizada. ${result.totalLeads} leads processados.`);
    if (result.warnings.length > 0) {
      log.warn("Revise os avisos acima.");
    }
  })
  .catch((err) => {
    log.error(`Falha fatal: ${err.message}`);
    process.exit(1);
  });

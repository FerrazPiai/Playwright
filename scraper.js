/**
 * Brokers MKTLab - Lead Exporter v3
 * 
 * Login flow (3 steps, 2 domains):
 *   1. brokers.mktlab.app/signin → Click "Acessar Lead Brokers"
 *   2. identity.mktlab.app → Fill email → Click "Avançar"
 *   3. identity.mktlab.app → Fill password → Click "Entrar"
 *   4. Redirected to brokers.mktlab.app (wrong workspace) 
 *   5. Navigate directly to correct workspace URL
 *   6. Click "Meus Leads" → Export CSV or scrape table
 * 
 * Desenvolvido por V4 Ferraz Piai & Co.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl: process.env.BROKER_URL || "https://brokers.mktlab.app",
  email: process.env.BROKER_EMAIL,
  password: process.env.BROKER_PASSWORD,
  webhookUrl: process.env.WEBHOOK_URL || "",
  outputDir: process.env.OUTPUT_DIR || "/app/exports",
  headless: process.env.HEADLESS !== "false",
  timeout: parseInt(process.env.TIMEOUT_MS) || 60000,
  retryAttempts: parseInt(process.env.RETRY_ATTEMPTS) || 3,
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS) || 5000,
  cronIntervalMs: parseInt(process.env.CRON_INTERVAL_MS) || 3600000,
  // URL direta do workspace correto (com & literal, não %26)
  workspaceUrl: process.env.WORKSPACE_URL || "https://brokers.mktlab.app/v4-company-ferraz-piai-&-co.",
  debug: process.env.DEBUG === "true",
};

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
  info: (msg) => console.log(`[${ts()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${ts()}] ✅ ${msg}`),
  warn: (msg) => console.warn(`[${ts()}] ⚠️  ${msg}`),
  error: (msg) => console.error(`[${ts()}] ❌ ${msg}`),
  debug: (msg) => { if (CONFIG.debug) console.log(`[${ts()}] 🐛 ${msg}`); },
};
function ts() { return new Date().toISOString(); }
function getTimestamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function screenshot(page, name) {
  if (!CONFIG.debug) return;
  try {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    const p = path.join(CONFIG.outputDir, `debug_${name}_${getTimestamp()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    log.debug(`Screenshot: ${p}`);
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: Login completo (3 etapas)
// ═══════════════════════════════════════════════════════════════════════════════
async function doLogin(page) {
  // ── Etapa 1: Acessar brokers.mktlab.app → clicar "Acessar Lead Brokers" ──
  log.info("Etapa 1/3: Acessando brokers.mktlab.app/signin...");
  await page.goto(`${CONFIG.baseUrl}/signin`, { waitUntil: "networkidle", timeout: CONFIG.timeout });
  await page.waitForTimeout(3000);
  await screenshot(page, "01_signin_page");

  // Verifica se já está logado (se não caiu no /signin)
  const currentUrl = page.url();
  if (!currentUrl.includes("signin") && !currentUrl.includes("identity")) {
    log.info("Parece já estar autenticado (não redirecionou para signin).");
    return;
  }

  // Clicar no botão vermelho "Acessar Lead Brokers"
  const accessButton = page.locator('a:has-text("Acessar Lead Brokers"), button:has-text("Acessar Lead Brokers")').first();
  if (await accessButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    log.info("Clicando em 'Acessar Lead Brokers'...");
    await accessButton.click();
  } else {
    // Talvez já esteja na página de login do identity
    log.info("Botão 'Acessar Lead Brokers' não encontrado — pode já estar no identity.");
  }

  // Espera redirecionar para identity.mktlab.app
  await page.waitForLoadState("networkidle", { timeout: CONFIG.timeout }).catch(() => {});
  await page.waitForTimeout(3000);
  await screenshot(page, "02_identity_page");

  // ── Etapa 2: Preencher email → clicar "Avançar" ──────────────────────────
  log.info("Etapa 2/3: Preenchendo email...");
  
  // Espera o campo de email aparecer
  const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail"], input[autocomplete="email"]').first();
  try {
    await emailInput.waitFor({ state: "visible", timeout: 10000 });
    await emailInput.fill(CONFIG.email);
    log.success(`Email preenchido: ${CONFIG.email}`);
    await page.waitForTimeout(500);
    await screenshot(page, "03_email_filled");

    // Clicar "Avançar"
    const avancarBtn = page.locator('button:has-text("Avançar"), button:has-text("Avancar"), button:has-text("Next"), button[type="submit"]').first();
    await avancarBtn.waitFor({ state: "visible", timeout: 5000 });
    await avancarBtn.click();
    log.info("Clicou em 'Avançar'.");
  } catch (e) {
    // Pode ser que email e senha estejam na mesma página
    log.warn(`Campo de email ou botão Avançar não encontrado: ${e.message}`);
    log.info("Tentando preencher email e senha na mesma página...");
  }

  // Espera a senha aparecer
  await page.waitForTimeout(3000);
  await screenshot(page, "04_password_page");

  // ── Etapa 3: Preencher senha → clicar "Entrar" ───────────────────────────
  log.info("Etapa 3/3: Preenchendo senha...");

  const passwordInput = page.locator('input[type="password"]').first();
  try {
    await passwordInput.waitFor({ state: "visible", timeout: 10000 });
    await passwordInput.fill(CONFIG.password);
    log.success("Senha preenchida.");
    await page.waitForTimeout(500);
    await screenshot(page, "05_password_filled");

    // Clicar "Entrar"
    const entrarBtn = page.locator('button:has-text("Entrar"), button:has-text("Login"), button:has-text("Sign in"), button[type="submit"]').first();
    await entrarBtn.waitFor({ state: "visible", timeout: 5000 });
    await entrarBtn.click();
    log.info("Clicou em 'Entrar'.");
  } catch (e) {
    log.error(`Erro ao preencher senha: ${e.message}`);
    throw new Error("Falha no login: campo de senha não encontrado.");
  }

  // Espera redirecionamento de volta para brokers.mktlab.app
  log.info("Aguardando redirecionamento pós-login...");
  try {
    await page.waitForURL(/brokers\.mktlab\.app/, { timeout: 30000 });
  } catch (_) {
    // Pode ter ficado no identity — tenta esperar mais
    await page.waitForTimeout(5000);
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);
  await screenshot(page, "06_after_login");

  const postLoginUrl = page.url();
  log.success(`Login concluído. URL atual: ${postLoginUrl}`);

  // Verifica se o login realmente funcionou
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  if (bodyText.includes("Acesse sua conta") || bodyText.includes("Acessar Lead Brokers")) {
    throw new Error("Login falhou — ainda na página de login.");
  }

  log.success("Login verificado com sucesso!");
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: Navegar para workspace correto via URL direta
// ═══════════════════════════════════════════════════════════════════════════════
async function navigateToWorkspace(page) {
  log.info(`Navegando direto para workspace: ${CONFIG.workspaceUrl}`);
  await page.goto(CONFIG.workspaceUrl, { waitUntil: "networkidle", timeout: CONFIG.timeout });
  await page.waitForTimeout(3000);
  await screenshot(page, "07_workspace");

  // Verifica se caiu no workspace certo (deve ter cards de leads ou menu)
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  if (bodyText.includes("Erro inesperado")) {
    log.error("Workspace mostra 'Erro inesperado'. Pode não ter autenticado corretamente.");
    throw new Error("Workspace com erro inesperado.");
  }

  const currentUrl = page.url();
  log.success(`No workspace correto. URL: ${currentUrl}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: Navegar para "Meus Leads"
// ═══════════════════════════════════════════════════════════════════════════════
async function navigateToMeusLeads(page) {
  log.info("Navegando para Meus Leads...");

  // Tenta clicar no link do sidebar (ícone de carrinho de compras)
  const selectors = [
    'a:has-text("Meus Leads")',
    'text=Meus Leads',
    '[href*="product-preview"]',
    // Ícone no sidebar — baseado no screenshot, é o 4º ícone
    'nav a[href*="product"]',
    'aside a[href*="product"]',
  ];

  for (const sel of selectors) {
    try {
      const link = page.locator(sel).first();
      if (await link.isVisible({ timeout: 3000 })) {
        await link.click();
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(3000);
        await screenshot(page, "08_meus_leads_via_menu");

        // Verificar se chegou na página certa
        const url = page.url();
        const text = await page.evaluate(() => document.body.innerText).catch(() => "");
        if (url.includes("product-preview") || text.includes("Minhas Aquisições") || text.includes("Exportar")) {
          log.success("Página Meus Leads carregada via menu.");
          return;
        }
      }
    } catch (_) {}
  }

  // Fallback: URL direta
  log.info("Menu não encontrado, tentando URL direta...");
  const meusLeadsUrl = CONFIG.workspaceUrl.replace(/\/?$/, "") + "/product-preview";
  log.debug(`URL Meus Leads: ${meusLeadsUrl}`);
  await page.goto(meusLeadsUrl, { waitUntil: "networkidle", timeout: CONFIG.timeout });
  await page.waitForTimeout(3000);
  await screenshot(page, "08_meus_leads_direct");

  // Verificar se está na página correta
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  if (bodyText.includes("Acesse sua conta") || bodyText.includes("Acessar Lead Brokers")) {
    throw new Error("Redirecionado para login — sessão perdida.");
  }

  if (bodyText.includes("Minhas Aquisições") || bodyText.includes("Exportar")) {
    log.success("Página Meus Leads carregada via URL direta.");
  } else {
    log.warn("Não tenho certeza se estamos na página correta. Continuando...");
    await screenshot(page, "08_meus_leads_uncertain");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: Exportar dados (CSV ou scrape da tabela)
// ═══════════════════════════════════════════════════════════════════════════════
async function exportData(page) {
  log.info("Exportando dados...");
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  // Garantir que a aba "Aquisições" está selecionada
  try {
    const aquisTab = page.locator('button:has-text("Aquisições"), a:has-text("Aquisições"), [role="tab"]:has-text("Aquisições")').first();
    if (await aquisTab.isVisible({ timeout: 3000 })) {
      await aquisTab.click();
      await page.waitForTimeout(2000);
      log.info("Aba 'Aquisições' selecionada.");
    }
  } catch (_) {}

  // ── Estratégia A: Botão Exportar → download de CSV ───────────────────────
  const exportBtn = page.locator('button:has-text("Exportar"), a:has-text("Exportar")').first();
  if (await exportBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    log.info("Botão 'Exportar' encontrado. Tentando download...");
    await screenshot(page, "09_before_export");

    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        exportBtn.click(),
      ]);
      const csvPath = path.join(CONFIG.outputDir, `leads_${getTimestamp()}.csv`);
      await download.saveAs(csvPath);
      log.success(`CSV baixado: ${csvPath}`);
      return { method: "csv", filePath: csvPath };
    } catch (e) {
      log.warn(`Download do CSV falhou: ${e.message}`);
      // Pode ser que o "Exportar" dispare um fetch/XHR ao invés de download
    }

    // Tenta interceptar via network
    try {
      log.info("Tentando interceptar resposta de rede...");
      const responsePromise = page.waitForResponse(
        (resp) => {
          const ct = resp.headers()["content-type"] || "";
          const url = resp.url();
          return ct.includes("csv") || ct.includes("octet") || ct.includes("excel") ||
                 url.includes("export") || url.includes("csv") || url.includes("download");
        },
        { timeout: 15000 }
      );
      await exportBtn.click();
      const resp = await responsePromise;
      const body = await resp.body();
      const csvPath = path.join(CONFIG.outputDir, `leads_${getTimestamp()}.csv`);
      fs.writeFileSync(csvPath, body);
      log.success(`CSV capturado via rede: ${csvPath}`);
      return { method: "csv_network", filePath: csvPath };
    } catch (e) {
      log.warn(`Interceptação de rede falhou: ${e.message}`);
    }
  } else {
    log.warn("Botão 'Exportar' NÃO encontrado na página.");
  }

  // ── Estratégia B: Scrape da tabela HTML ──────────────────────────────────
  log.info("Fallback: extraindo dados da tabela HTML...");
  return await scrapeTable(page);
}

async function scrapeTable(page) {
  await screenshot(page, "10_table_scrape");

  // Espera a tabela aparecer
  try {
    await page.waitForSelector("table", { timeout: 10000 });
  } catch (_) {
    log.warn("Nenhuma <table> encontrada.");
  }

  // Scroll para carregar todos os dados (caso tenha lazy loading)
  let previousHeight = 0;
  for (let i = 0; i < 10; i++) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) break;
    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  }

  const leads = await page.evaluate(() => {
    const results = [];
    const table = document.querySelector("table");
    if (!table) return results;

    // Extrai headers
    const headerCells = table.querySelectorAll("thead th, thead td, tr:first-child th, tr:first-child td");
    const headers = [];
    headerCells.forEach((h) => headers.push(h.textContent.trim()));

    // Extrai rows
    const rows = table.querySelectorAll("tbody tr");
    rows.forEach((row) => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 3) return;

      const rowData = {};
      cells.forEach((cell, idx) => {
        const key = headers[idx] || `col_${idx}`;
        rowData[key] = cell.textContent.trim();
      });
      results.push(rowData);
    });

    return results;
  });

  log.info(`Tabela HTML: ${leads.length} registros extraídos.`);

  if (leads.length > 0) {
    log.debug(`Headers encontrados: ${Object.keys(leads[0]).join(", ")}`);
    log.debug(`Primeiro registro: ${JSON.stringify(leads[0])}`);
  }

  return { method: "table_scrape", leads, filePath: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: Extrair detalhes clicando em cada lead (para pegar CNPJ e Faturamento)
// ═══════════════════════════════════════════════════════════════════════════════
async function enrichLeadsFromDetails(page, leads) {
  // A tabela "Meus Leads" não tem coluna de CNPJ/Faturamento/Segmento
  // Esses campos só aparecem quando clicamos no card do lead (painel de detalhes)
  // Se já temos os dados do CSV, pula esta etapa
  
  if (leads.length === 0) return leads;

  // Verifica se já temos faturamento (se sim, veio do CSV completo)
  const hasFaturamento = leads.some(l => l.faturamento && l.faturamento !== "");
  if (hasFaturamento) {
    log.info("Dados já contêm faturamento — pulando enriquecimento.");
    return leads;
  }

  log.info("Tabela não tem CNPJ/Faturamento. Tentando enriquecer via detalhes dos cards...");
  
  // Volta para a página principal do workspace (onde tem os cards)
  try {
    await page.goto(CONFIG.workspaceUrl, { waitUntil: "networkidle", timeout: CONFIG.timeout });
    await page.waitForTimeout(3000);
  } catch (_) {
    log.warn("Não conseguiu voltar para página de cards.");
    return leads;
  }

  // Para cada lead, tenta clicar no card e pegar os detalhes
  // Isso é opcional e mais lento — só faz se necessário
  // Por ora, retorna os dados que temos
  log.info("Enriquecimento via cards não implementado nesta versão. Use CSV se possível.");
  return leads;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 6: Processar e normalizar dados
// ═══════════════════════════════════════════════════════════════════════════════
function processData(exportResult) {
  let leads = [];

  if (exportResult.filePath) {
    // Parse CSV
    const raw = fs.readFileSync(exportResult.filePath, "utf-8");
    const delimiter = raw.split("\n")[0].includes(";") ? ";" : ",";
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return [];

    const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
    log.debug(`CSV headers: ${headers.join(" | ")}`);

    for (let i = 1; i < lines.length; i++) {
      // Handle quoted CSV values with delimiters inside
      const values = parseCSVLine(lines[i], delimiter);
      const row = {};
      headers.forEach((h, idx) => { row[h] = (values[idx] || "").trim(); });
      leads.push(mapFields(row));
    }
  } else if (exportResult.leads) {
    leads = exportResult.leads.map(mapFields);
  }

  return leads;
}

function mapFields(row) {
  return {
    nome_empresa: fc(row, ["empresa", "nome da empresa", "company", "nome_empresa"]),
    cnpj: fc(row, ["documento da empresa", "cnpj", "documento", "cpf_cnpj"]),
    faturamento: fc(row, ["faturamento", "revenue"]),
    segmento: fc(row, ["segmento", "segment"]),
    responsavel: fc(row, ["responsável", "responsavel", "contact"]),
    telefone: fc(row, ["telefone", "phone"]),
    email: fc(row, ["e-mail", "email"]),
    valor: fc(row, ["valor", "value"]),
    cargo: fc(row, ["cargo", "role", "position"]),
    data_compra: fc(row, ["data/hora de compra", "data_compra", "data", "date"]),
    tipo: fc(row, ["tipo", "type"]),
    arrematador: fc(row, ["arrematador", "buyer"]),
  };
}

function fc(row, names) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  for (const key of Object.keys(row)) {
    for (const name of names) {
      if (norm(key) === norm(name) || norm(key).includes(norm(name))) {
        return row[key] || "";
      }
    }
  }
  return "";
}

function parseCSVLine(line, delimiter) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ""));
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ""));
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7: Enviar webhook
// ═══════════════════════════════════════════════════════════════════════════════
async function sendWebhook(leads) {
  if (!CONFIG.webhookUrl) {
    log.info("Webhook não configurado.");
    return;
  }
  if (leads.length === 0) {
    log.warn("Nenhum lead para enviar — pulando webhook.");
    return;
  }

  log.info(`Enviando ${leads.length} leads para webhook...`);
  const resp = await fetch(CONFIG.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      source: "brokers-lead-exporter-v3",
      total: leads.length,
      leads,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Webhook ${resp.status}: ${await resp.text().catch(() => "")}`);
  }
  log.success("Webhook OK.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main scrape flow
// ═══════════════════════════════════════════════════════════════════════════════
async function scrape() {
  if (!CONFIG.email || !CONFIG.password) {
    throw new Error("BROKER_EMAIL e BROKER_PASSWORD obrigatórios.");
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: CONFIG.headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.timeout);

    // Step 1: Login (3 etapas)
    await doLogin(page);

    // Step 2: Ir para workspace correto via URL direta
    await navigateToWorkspace(page);

    // Step 3: Ir para Meus Leads
    await navigateToMeusLeads(page);

    // Validar que estamos na página certa
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (bodyText.includes("Acesse sua conta")) {
      throw new Error("Sessão não autenticada — redirecionou para login.");
    }

    // Step 4: Exportar
    const exportResult = await exportData(page);

    // Step 5: Processar
    const leads = processData(exportResult);
    log.info(`${leads.length} leads processados (${exportResult.method}).`);

    // Salvar JSON
    if (leads.length > 0) {
      const jsonPath = path.join(CONFIG.outputDir, `leads_${getTimestamp()}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(leads, null, 2), "utf-8");
      log.success(`JSON: ${jsonPath}`);
    }

    // Step 6: Webhook (só envia se tiver dados válidos)
    const validLeads = leads.filter(l => l.nome_empresa || l.telefone || l.email);
    if (validLeads.length > 0) {
      await sendWebhook(validLeads);
    } else {
      log.warn("Nenhum lead válido para enviar (todos sem empresa/telefone/email).");
      log.warn("Isso pode indicar que o login ou navegação falhou silenciosamente.");
    }

    // Warnings
    const noEmpresa = leads.filter(l => !l.nome_empresa).length;
    if (noEmpresa > 0) log.warn(`${noEmpresa} leads sem empresa`);
    if (leads.length === 0) log.warn("ZERO leads extraídos!");

    await browser.close();
    return { success: leads.length > 0, total: leads.length, method: exportResult.method };
  } catch (err) {
    log.error(`ERRO: ${err.message}`);
    if (browser) {
      try {
        const pg = browser.contexts()[0]?.pages()[0];
        if (pg) {
          const errPath = path.join(CONFIG.outputDir, `error_${getTimestamp()}.png`);
          await pg.screenshot({ path: errPath, fullPage: true });
          log.info(`Screenshot erro: ${errPath}`);
        }
      } catch (_) {}
      await browser.close();
    }
    throw err;
  }
}

async function scrapeWithRetry() {
  for (let i = 1; i <= CONFIG.retryAttempts; i++) {
    log.info(`══ Tentativa ${i}/${CONFIG.retryAttempts} ══`);
    try {
      return await scrape();
    } catch (err) {
      log.error(`Tentativa ${i} falhou: ${err.message}`);
      if (i < CONFIG.retryAttempts) {
        log.info(`Aguardando ${CONFIG.retryDelayMs / 1000}s...`);
        await sleep(CONFIG.retryDelayMs);
      }
    }
  }
  return { success: false, total: 0, method: "none" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cron loop
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  log.info("╔══════════════════════════════════════════════════════╗");
  log.info("║  Brokers Lead Exporter v3 — V4 Ferraz Piai & Co.   ║");
  log.info("╚══════════════════════════════════════════════════════╝");
  log.info(`Intervalo: ${CONFIG.cronIntervalMs / 60000} min`);
  log.info(`Workspace URL: ${CONFIG.workspaceUrl}`);
  log.info(`Webhook: ${CONFIG.webhookUrl ? "OK" : "NÃO CONFIGURADO"}`);
  log.info(`Debug: ${CONFIG.debug}`);
  log.info("");

  const r = await scrapeWithRetry();
  log.info(`→ ${r.success ? "SUCESSO" : "FALHA"} — ${r.total} leads (${r.method})`);
  log.info(`Próxima execução em ${CONFIG.cronIntervalMs / 60000} min...\n`);

  setInterval(async () => {
    log.info("═══════════════════════════════════════════════════════");
    const r = await scrapeWithRetry();
    log.info(`→ ${r.success ? "SUCESSO" : "FALHA"} — ${r.total} leads (${r.method})`);
    log.info(`Próxima em ${CONFIG.cronIntervalMs / 60000} min...\n`);
  }, CONFIG.cronIntervalMs);
}

main();

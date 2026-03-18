/**
 * Brokers MKTLab - Lead Exporter v4 (DEFINITIVE)
 * 
 * Bug fix: waitForURL regex was matching "brokers.mktlab.app" inside the
 * identity.mktlab.app query string (?redirectTo=...brokers.mktlab.app...).
 * This caused the script to think login succeeded when it never left identity.
 * 
 * Key fixes:
 * - URL check now parses hostname, not regex on full URL string
 * - Uses Promise.all([waitForNavigation, click]) for form submissions
 * - Keyboard Enter as primary submit (more reliable than click)
 * - storageState persistence to avoid re-login every hour
 * - Proper error message detection after login attempts
 * 
 * Desenvolvido por V4 Ferraz Piai & Co.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

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
  debug: process.env.DEBUG === "true",
  storagePath: "/app/exports/auth-state.json",
};

const log = {
  info: (m) => console.log(`[${new Date().toISOString()}] ℹ️  ${m}`),
  ok: (m) => console.log(`[${new Date().toISOString()}] ✅ ${m}`),
  warn: (m) => console.warn(`[${new Date().toISOString()}] ⚠️  ${m}`),
  err: (m) => console.error(`[${new Date().toISOString()}] ❌ ${m}`),
  dbg: (m) => { if (CONFIG.debug) console.log(`[${new Date().toISOString()}] 🐛 ${m}`); },
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snap(page, name) {
  if (!CONFIG.debug) return;
  try {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    const p = path.join(CONFIG.outputDir, `debug_${name}_${stamp()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    log.dbg(`Screenshot: ${p}`);
  } catch (_) {}
}

/** Check if current page hostname is brokers.mktlab.app (NOT in query string) */
function isOnBrokers(page) {
  try {
    const url = new URL(page.url());
    return url.hostname === "brokers.mktlab.app";
  } catch {
    return false;
  }
}

/** Check if current page hostname is identity.mktlab.app */
function isOnIdentity(page) {
  try {
    const url = new URL(page.url());
    return url.hostname === "identity.mktlab.app";
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN — 3-step flow across 2 domains
// ═══════════════════════════════════════════════════════════════════════════════
async function doLogin(page) {
  // Check if we have a saved session
  if (fs.existsSync(CONFIG.storagePath)) {
    log.info("Sessão salva encontrada. Testando validade...");
    try {
      // Try loading the workspace directly to check if session is valid
      await page.goto(`${CONFIG.baseUrl}/v4-company-ferraz-piai-%26-co./product-preview`, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await page.waitForTimeout(3000);
      
      if (isOnBrokers(page)) {
        const text = await page.evaluate(() => document.body.innerText).catch(() => "");
        if (!text.includes("Acesse sua conta") && !text.includes("Acessar Lead Brokers")) {
          log.ok("Sessão ainda válida! Pulando login.");
          return;
        }
      }
      log.info("Sessão expirada. Fazendo login novo...");
    } catch {
      log.info("Erro ao testar sessão. Fazendo login novo...");
    }
  }

  // ── STEP 1: brokers.mktlab.app/signin → Click "Acessar Lead Brokers" ─────
  log.info("LOGIN 1/3: Acessando página de signin...");
  await page.goto(`${CONFIG.baseUrl}/signin`, {
    waitUntil: "networkidle",
    timeout: CONFIG.timeout,
  });
  await page.waitForTimeout(2000);
  await snap(page, "01_signin");

  // Click the red "Acessar Lead Brokers" button
  const accessBtn = page.locator('a:has-text("Acessar Lead Brokers"), button:has-text("Acessar Lead Brokers")').first();
  if (await accessBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    log.info("Clicando 'Acessar Lead Brokers'...");
    // This navigates to identity.mktlab.app
    await Promise.all([
      page.waitForURL((url) => new URL(url).hostname === "identity.mktlab.app", { timeout: 15000 }).catch(() => {}),
      accessBtn.click(),
    ]);
  } else if (isOnIdentity(page)) {
    log.info("Já no identity.mktlab.app.");
  } else {
    // Navigate directly to identity
    log.info("Botão não encontrado. Acessando identity diretamente...");
    await page.goto(`${CONFIG.baseUrl}/signin`, { waitUntil: "networkidle", timeout: CONFIG.timeout });
  }

  await page.waitForTimeout(2000);
  await snap(page, "02_identity");

  // ── STEP 2: identity.mktlab.app → Fill email → Click "Avançar" ───────────
  log.info("LOGIN 2/3: Preenchendo email...");
  
  // Wait for email input to appear
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  await emailInput.waitFor({ state: "visible", timeout: 10000 });
  
  // Clear and fill email
  await emailInput.click();
  await emailInput.fill("");
  await emailInput.fill(CONFIG.email);
  await page.waitForTimeout(500);
  log.ok(`Email: ${CONFIG.email}`);
  await snap(page, "03_email");

  // Click "Avançar" and wait for password field to appear
  const avancarBtn = page.locator('button:has-text("Avançar")').first();
  if (await avancarBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await avancarBtn.click();
    log.info("Clicou 'Avançar'. Aguardando campo de senha...");
  } else {
    // Maybe email and password are on the same page
    log.info("Botão 'Avançar' não encontrado — pode ser formulário single-page.");
  }

  // Wait for password field to appear (it may take a moment after "Avançar")
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(1000); // Extra wait for page to stabilize
  await snap(page, "04_password_page");

  // ── STEP 3: Fill password → Press Enter (more reliable than clicking) ─────
  log.info("LOGIN 3/3: Preenchendo senha e submetendo...");
  
  await passwordInput.click();
  await passwordInput.fill("");
  await passwordInput.fill(CONFIG.password);
  await page.waitForTimeout(500);
  log.ok("Senha preenchida.");
  await snap(page, "05_password_filled");

  // Check for error messages BEFORE submitting (e.g., "email inválido")
  const preErrors = await page.evaluate(() => {
    const errorEls = document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"]');
    return Array.from(errorEls).map(e => e.textContent.trim()).filter(t => t.length > 0);
  });
  if (preErrors.length > 0) {
    log.warn(`Erros pré-submit: ${preErrors.join(" | ")}`);
  }

  // Submit using KEYBOARD ENTER (more reliable than clicking for SPA forms)
  // Start listening for navigation BEFORE pressing Enter
  log.info("Submetendo formulário (Enter)...");
  
  const navigationPromise = page.waitForURL(
    (url) => new URL(url).hostname === "brokers.mktlab.app",
    { timeout: 30000 }
  ).catch(() => null);

  // Try Enter key first
  await passwordInput.press("Enter");
  
  // Wait a moment to see if Enter worked
  await page.waitForTimeout(2000);
  
  // If still on identity, try clicking the "Entrar" button
  if (isOnIdentity(page)) {
    log.info("Enter não navegou. Tentando clicar 'Entrar'...");
    const entrarBtn = page.locator('button:has-text("Entrar")').first();
    if (await entrarBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await entrarBtn.click();
    }
  }

  // Wait for the full OAuth redirect chain: identity → brokers/auth/token → brokers
  log.info("Aguardando redirect OAuth (até 30s)...");
  await navigationPromise;
  
  // Extra safety wait for the redirect chain to fully complete
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);
  await snap(page, "06_after_login");

  // ── VERIFY LOGIN SUCCESS ──────────────────────────────────────────────────
  const currentUrl = page.url();
  log.info(`URL pós-login: ${currentUrl}`);

  if (isOnIdentity(page)) {
    // Still on identity — login failed
    // Check for error messages
    const errors = await page.evaluate(() => {
      const errorEls = document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"], [class*="message"]');
      return Array.from(errorEls).map(e => e.textContent.trim()).filter(t => t.length > 0);
    });
    
    if (errors.length > 0) {
      log.err(`Erros na página de login: ${errors.join(" | ")}`);
    }
    
    // Dump page content for debugging
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
    const debugPath = path.join(CONFIG.outputDir, `login_fail_text_${stamp()}.txt`);
    fs.writeFileSync(debugPath, `URL: ${currentUrl}\n\nBody:\n${pageText}`, "utf-8");
    log.info(`Texto da página salvo: ${debugPath}`);
    
    throw new Error(`Login falhou. Ainda em identity.mktlab.app. Verifique credenciais e screenshots.`);
  }

  if (!isOnBrokers(page)) {
    throw new Error(`Login redirecionou para URL inesperada: ${currentUrl}`);
  }

  log.ok("Login OK! Estamos em brokers.mktlab.app");

  // Save session state for reuse
  try {
    await page.context().storageState({ path: CONFIG.storagePath });
    log.ok("Sessão salva para reutilização.");
  } catch (e) {
    log.warn(`Não conseguiu salvar sessão: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATE TO "MEUS LEADS"
// ═══════════════════════════════════════════════════════════════════════════════
async function goToMeusLeads(page) {
  // Navigate to workspace + Meus Leads in one step via URL
  const meusLeadsUrl = `${CONFIG.baseUrl}/v4-company-ferraz-piai-%26-co./product-preview`;
  log.info(`Navegando para Meus Leads: ${meusLeadsUrl}`);
  
  await page.goto(meusLeadsUrl, { waitUntil: "networkidle", timeout: CONFIG.timeout });
  await page.waitForTimeout(3000);
  await snap(page, "07_meus_leads");

  // Verify we're on the right page
  if (!isOnBrokers(page)) {
    // Maybe redirected to login — session expired
    throw new Error("Redirecionado para fora de brokers. Sessão pode ter expirado.");
  }

  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  
  if (bodyText.includes("Acesse sua conta") || bodyText.includes("Acessar Lead Brokers")) {
    // Delete saved session as it's invalid
    try { fs.unlinkSync(CONFIG.storagePath); } catch {}
    throw new Error("Sessão expirada — redirecionou para login.");
  }

  if (bodyText.includes("Erro inesperado")) {
    // Wrong workspace — try with & instead of %26
    log.warn("Erro inesperado. Tentando URL alternativa...");
    await page.goto(`${CONFIG.baseUrl}/v4-company-ferraz-piai-&-co./product-preview`, {
      waitUntil: "networkidle", timeout: CONFIG.timeout,
    });
    await page.waitForTimeout(3000);
    await snap(page, "07b_meus_leads_alt");
  }

  // Check for expected content
  const text2 = await page.evaluate(() => document.body.innerText).catch(() => "");
  if (text2.includes("Minhas Aquisições") || text2.includes("Exportar")) {
    log.ok("Página 'Meus Leads' confirmada.");
  } else if (text2.includes("Erro inesperado")) {
    throw new Error("Workspace incorreto — 'Erro inesperado' persiste.");
  } else {
    log.warn("Não confirmei conteúdo esperado, mas continuando...");
    log.dbg(`Conteúdo: ${text2.substring(0, 200)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT DATA
// ═══════════════════════════════════════════════════════════════════════════════
async function exportData(page) {
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  // Make sure "Aquisições" tab is selected
  try {
    const tab = page.locator('button:has-text("Aquisições"), [role="tab"]:has-text("Aquisições")').first();
    if (await tab.isVisible({ timeout: 3000 })) {
      await tab.click();
      await page.waitForTimeout(2000);
    }
  } catch {}

  // ── Strategy A: Click "Exportar" button ──────────────────────────────────
  const exportBtn = page.locator('button:has-text("Exportar"), a:has-text("Exportar")').first();
  if (await exportBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    log.info("Botão 'Exportar' encontrado.");
    await snap(page, "08_before_export");

    // Attempt 1: Wait for download event
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        exportBtn.click(),
      ]);
      const csvPath = path.join(CONFIG.outputDir, `leads_${stamp()}.csv`);
      await download.saveAs(csvPath);
      log.ok(`CSV download: ${csvPath}`);
      return { method: "csv", file: csvPath };
    } catch (e) {
      log.warn(`Download falhou: ${e.message}`);
    }

    // Attempt 2: Intercept network response
    try {
      log.info("Tentando interceptar resposta de rede...");
      const [resp] = await Promise.all([
        page.waitForResponse(
          (r) => {
            const ct = r.headers()["content-type"] || "";
            return ct.includes("csv") || ct.includes("octet") || ct.includes("spreadsheet") ||
                   r.url().includes("export") || r.url().includes("download");
          },
          { timeout: 15000 }
        ),
        exportBtn.click(),
      ]);
      const body = await resp.body();
      const csvPath = path.join(CONFIG.outputDir, `leads_${stamp()}.csv`);
      fs.writeFileSync(csvPath, body);
      log.ok(`CSV interceptado: ${csvPath}`);
      return { method: "csv_intercept", file: csvPath };
    } catch (e) {
      log.warn(`Interceptação falhou: ${e.message}`);
    }
  } else {
    log.warn("Botão 'Exportar' NÃO encontrado.");
  }

  // ── Strategy B: Scrape HTML table ────────────────────────────────────────
  log.info("Fallback: scraping tabela HTML...");
  return await scrapeTable(page);
}

async function scrapeTable(page) {
  await snap(page, "09_table");

  // Wait for table
  await page.waitForSelector("table", { timeout: 10000 }).catch(() => {});

  // Scroll to load all rows
  for (let i = 0; i < 15; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    const h2 = await page.evaluate(() => document.body.scrollHeight);
    if (h2 === h) break;
  }

  const data = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return [];

    const ths = Array.from(table.querySelectorAll("thead th")).map(h => h.textContent.trim());
    const rows = Array.from(table.querySelectorAll("tbody tr"));

    return rows.map(row => {
      const cells = Array.from(row.querySelectorAll("td")).map(c => c.textContent.trim());
      const obj = {};
      ths.forEach((h, i) => { obj[h] = cells[i] || ""; });
      return obj;
    }).filter(r => Object.values(r).some(v => v.length > 0));
  });

  log.info(`Tabela: ${data.length} linhas.`);
  if (data.length > 0) {
    log.dbg(`Headers: ${Object.keys(data[0]).join(", ")}`);
    log.dbg(`Row 0: ${JSON.stringify(data[0])}`);
  }

  return { method: "table", file: null, rows: data };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS & NORMALIZE
// ═══════════════════════════════════════════════════════════════════════════════
function processData(result) {
  if (result.file) {
    const raw = fs.readFileSync(result.file, "utf-8");
    const sep = raw.split("\n")[0]?.includes(";") ? ";" : ",";
    const lines = raw.split("\n").filter(l => l.trim());
    if (lines.length < 2) return [];

    const hdrs = csvParseLine(lines[0], sep);
    return lines.slice(1).map(line => {
      const vals = csvParseLine(line, sep);
      const row = {};
      hdrs.forEach((h, i) => { row[h] = vals[i] || ""; });
      return normalize(row);
    });
  }

  if (result.rows) {
    return result.rows.map(normalize);
  }

  return [];
}

function normalize(row) {
  return {
    nome_empresa: fc(row, ["empresa", "nome da empresa"]),
    cnpj: fc(row, ["documento da empresa", "cnpj", "documento"]),
    faturamento: fc(row, ["faturamento"]),
    segmento: fc(row, ["segmento"]),
    responsavel: fc(row, ["responsável", "responsavel"]),
    telefone: fc(row, ["telefone", "phone"]),
    email: fc(row, ["e-mail", "email"]),
    valor: fc(row, ["valor"]),
    cargo: fc(row, ["cargo"]),
    tipo: fc(row, ["tipo"]),
    arrematador: fc(row, ["arrematador"]),
    data_compra: fc(row, ["data/hora de compra", "data_compra"]),
  };
}

function fc(row, names) {
  const n = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  for (const k of Object.keys(row)) {
    for (const name of names) {
      if (n(k) === n(name) || n(k).includes(n(name))) return row[k] || "";
    }
  }
  return "";
}

function csvParseLine(line, sep) {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) { out.push(cur.replace(/^"|"$/g, "").trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.replace(/^"|"$/g, "").trim());
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════════
async function sendWebhook(leads) {
  if (!CONFIG.webhookUrl || leads.length === 0) return;

  log.info(`Enviando ${leads.length} leads...`);
  const r = await fetch(CONFIG.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      source: "brokers-exporter-v4",
      total: leads.length,
      leads,
    }),
  });
  if (!r.ok) throw new Error(`Webhook ${r.status}`);
  log.ok("Webhook enviado.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FLOW
// ═══════════════════════════════════════════════════════════════════════════════
async function scrape() {
  if (!CONFIG.email || !CONFIG.password) throw new Error("Credenciais obrigatórias.");

  let browser;
  try {
    // Try to reuse saved session
    const contextOptions = {
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    };

    if (fs.existsSync(CONFIG.storagePath)) {
      contextOptions.storageState = CONFIG.storagePath;
    }

    browser = await chromium.launch({
      headless: CONFIG.headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.timeout);

    // Login (skips if session is valid)
    await doLogin(page);

    // Navigate to Meus Leads
    await goToMeusLeads(page);

    // Export
    const result = await exportData(page);

    // Process
    const leads = processData(result);
    log.info(`${leads.length} leads (${result.method}).`);

    // Save
    if (leads.length > 0) {
      const jp = path.join(CONFIG.outputDir, `leads_${stamp()}.json`);
      fs.writeFileSync(jp, JSON.stringify(leads, null, 2));
      log.ok(`JSON: ${jp}`);
    }

    // Webhook (only if we have real data)
    const valid = leads.filter(l => l.nome_empresa || l.telefone || l.email);
    if (valid.length > 0) {
      await sendWebhook(valid);
    } else if (leads.length > 0) {
      log.warn("Leads sem dados válidos — webhook NÃO enviado.");
    } else {
      log.warn("ZERO leads — webhook NÃO enviado.");
    }

    await browser.close();
    return { ok: true, n: leads.length, method: result.method };
  } catch (err) {
    log.err(err.message);
    if (browser) {
      try {
        const p = browser.contexts()[0]?.pages()[0];
        if (p) {
          await p.screenshot({ path: path.join(CONFIG.outputDir, `error_${stamp()}.png`), fullPage: true });
        }
      } catch {}
      await browser.close();
    }
    throw err;
  }
}

async function run() {
  for (let i = 1; i <= CONFIG.retryAttempts; i++) {
    log.info(`═══ Tentativa ${i}/${CONFIG.retryAttempts} ═══`);
    try { return await scrape(); }
    catch (e) {
      log.err(`Tentativa ${i}: ${e.message}`);
      if (i < CONFIG.retryAttempts) {
        // Delete saved session on failure (might be stale)
        try { fs.unlinkSync(CONFIG.storagePath); } catch {}
        await sleep(CONFIG.retryDelayMs);
      }
    }
  }
  return { ok: false, n: 0, method: "none" };
}

async function main() {
  log.info("╔═════════════════════════════════════════════════╗");
  log.info("║  Brokers Lead Exporter v4 — V4 Ferraz Piai     ║");
  log.info("╚═════════════════════════════════════════════════╝");
  log.info(`Loop: ${CONFIG.cronIntervalMs / 60000}min | Debug: ${CONFIG.debug}`);
  log.info(`Webhook: ${CONFIG.webhookUrl ? "OK" : "NÃO"}`);
  log.info("");

  const r = await run();
  log.info(`→ ${r.ok ? "OK" : "FALHA"} — ${r.n} leads (${r.method})`);
  log.info(`Próxima em ${CONFIG.cronIntervalMs / 60000}min\n`);

  setInterval(async () => {
    log.info("═══════════════════════════════════════════════════");
    const r = await run();
    log.info(`→ ${r.ok ? "OK" : "FALHA"} — ${r.n} leads (${r.method})`);
    log.info(`Próxima em ${CONFIG.cronIntervalMs / 60000}min\n`);
  }, CONFIG.cronIntervalMs);
}

main();

/**
 * Brokers MKTLab - Lead Exporter v5
 * 
 * Uses exact selectors from DevTools inspection:
 *   Email: input[name="email"][type="email"]
 *   Password: input[name="password"][type="password"] 
 *   Avançar: button[type="submit"] with text "Avançar"
 *   Entrar: button[type="submit"] with text "Entrar"
 * 
 * Key fix: Uses page.type() instead of fill() to trigger React onChange events
 * character by character, which is required for v4-input-field components.
 * 
 * V4 Ferraz Piai & Co.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const C = {
  baseUrl: process.env.BROKER_URL || "https://brokers.mktlab.app",
  email: process.env.BROKER_EMAIL,
  password: process.env.BROKER_PASSWORD,
  webhookUrl: process.env.WEBHOOK_URL || "",
  outputDir: process.env.OUTPUT_DIR || "/app/exports",
  headless: process.env.HEADLESS !== "false",
  timeout: parseInt(process.env.TIMEOUT_MS) || 60000,
  retries: parseInt(process.env.RETRY_ATTEMPTS) || 3,
  retryDelay: parseInt(process.env.RETRY_DELAY_MS) || 5000,
  interval: parseInt(process.env.CRON_INTERVAL_MS) || 3600000,
  debug: process.env.DEBUG === "true",
  authFile: "/app/exports/auth-state.json",
};

const log = {
  i: (m) => console.log(`[${new Date().toISOString()}] ℹ️  ${m}`),
  ok: (m) => console.log(`[${new Date().toISOString()}] ✅ ${m}`),
  w: (m) => console.warn(`[${new Date().toISOString()}] ⚠️  ${m}`),
  e: (m) => console.error(`[${new Date().toISOString()}] ❌ ${m}`),
  d: (m) => { if (C.debug) console.log(`[${new Date().toISOString()}] 🐛 ${m}`); },
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostname = (page) => { try { return new URL(page.url()).hostname; } catch { return ""; } };

async function snap(page, name) {
  if (!C.debug) return;
  fs.mkdirSync(C.outputDir, { recursive: true });
  try {
    const p = path.join(C.outputDir, `${name}_${stamp()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    log.d(`Screenshot: ${p}`);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════════════════
async function login(page) {
  // ── Check saved session ─────────────────────────────────────────────────
  if (fs.existsSync(C.authFile)) {
    log.i("Testando sessão salva...");
    await page.goto(`${C.baseUrl}/v4-company-ferraz-piai-%26-co./product-preview`, {
      waitUntil: "domcontentloaded", timeout: 20000,
    }).catch(() => {});
    await page.waitForTimeout(4000);
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (hostname(page) === "brokers.mktlab.app" && !text.includes("Acesse sua conta") && !text.includes("Acessar Lead Brokers")) {
      log.ok("Sessão válida!");
      return;
    }
    log.i("Sessão expirada.");
    try { fs.unlinkSync(C.authFile); } catch {}
  }

  // ── Step 1: Go to signin page ───────────────────────────────────────────
  log.i("LOGIN 1/3: Abrindo signin...");
  await page.goto(`${C.baseUrl}/signin`, { waitUntil: "networkidle", timeout: C.timeout });
  await page.waitForTimeout(2000);
  await snap(page, "01_signin");

  // Click "Acessar Lead Brokers" (red button/link)
  const accessBtn = page.locator('a:has-text("Acessar Lead Brokers"), button:has-text("Acessar Lead Brokers")').first();
  if (await accessBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    log.i("Clicando 'Acessar Lead Brokers'...");
    await accessBtn.click();
    // Wait for identity.mktlab.app to load
    try {
      await page.waitForURL((url) => new URL(url).hostname === "identity.mktlab.app", { timeout: 15000 });
    } catch {
      await page.waitForTimeout(5000);
    }
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2000);
  await snap(page, "02_identity");

  if (hostname(page) !== "identity.mktlab.app") {
    throw new Error(`Esperava identity.mktlab.app, estou em ${hostname(page)}`);
  }

  // ── Step 2: Fill email → Avançar ────────────────────────────────────────
  log.i("LOGIN 2/3: Email...");

  // EXACT selector from DevTools: input[name="email"][type="email"].v4-input-field
  const emailSel = 'input[name="email"]';
  await page.waitForSelector(emailSel, { state: "visible", timeout: 10000 });
  
  // Triple-click to select all existing text, then type over it
  await page.click(emailSel, { clickCount: 3 });
  await page.waitForTimeout(200);
  
  // Use keyboard.type() — types character by character, triggers all React events
  await page.keyboard.type(C.email, { delay: 30 });
  await page.waitForTimeout(500);
  
  log.ok(`Email digitado: ${C.email}`);
  await snap(page, "03_email_typed");

  // Click "Avançar" — exact: button[type="submit"] with text Avançar
  // Use Promise.all to catch navigation that might happen
  const avancarSel = 'button[type="submit"]:has-text("Avançar")';
  await page.waitForSelector(avancarSel, { state: "visible", timeout: 5000 }).catch(() => {});
  
  if (await page.locator(avancarSel).isVisible().catch(() => false)) {
    log.i("Clicando 'Avançar'...");
    await page.click(avancarSel);
  } else {
    // Maybe no "Avançar" button — try submit or Enter
    log.i("Botão 'Avançar' não visível, tentando Enter...");
    await page.press(emailSel, "Enter");
  }

  // Wait for password field to appear
  log.i("Aguardando campo de senha...");
  const passSel = 'input[name="password"]';
  try {
    await page.waitForSelector(passSel, { state: "visible", timeout: 15000 });
  } catch {
    // Maybe email and password are on same page already
    const passAlt = 'input[type="password"]';
    await page.waitForSelector(passAlt, { state: "visible", timeout: 5000 });
  }
  
  await page.waitForTimeout(1000);
  await snap(page, "04_password_page");

  // ── Step 3: Fill password → Entrar ──────────────────────────────────────
  log.i("LOGIN 3/3: Senha...");

  // EXACT selector: input[name="password"][type="password"].v4-input-field
  const passField = 'input[name="password"]';
  await page.click(passField, { clickCount: 3 });
  await page.waitForTimeout(200);
  await page.keyboard.type(C.password, { delay: 30 });
  await page.waitForTimeout(500);

  log.ok("Senha digitada.");
  await snap(page, "05_password_typed");

  // Submit: button[type="submit"] "Entrar"
  // Use Promise.all to wait for navigation
  log.i("Submetendo login...");
  
  const entrarSel = 'button[type="submit"]:has-text("Entrar")';
  const entrarVisible = await page.locator(entrarSel).isVisible().catch(() => false);

  // Start waiting BEFORE clicking
  const navPromise = page.waitForURL(
    (url) => new URL(url).hostname === "brokers.mktlab.app",
    { timeout: 30000 }
  ).catch(() => null);

  if (entrarVisible) {
    await page.click(entrarSel);
    log.i("Clicou 'Entrar'.");
  } else {
    // Fallback: press Enter on password field
    await page.press(passField, "Enter");
    log.i("Pressionou Enter.");
  }

  // Wait for redirect to brokers
  log.i("Aguardando redirect para brokers (até 30s)...");
  const navResult = await navPromise;
  
  // Extra wait for redirects to complete
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);
  await snap(page, "06_after_submit");

  // Check: are we on brokers now?
  if (hostname(page) === "brokers.mktlab.app") {
    log.ok("Redirecionado para brokers.mktlab.app!");
  } else if (hostname(page) === "identity.mktlab.app") {
    // Still on identity — check for error messages
    log.w("Ainda em identity.mktlab.app. Verificando erros...");
    
    const pageContent = await page.evaluate(() => {
      // Check for error/alert elements
      const errors = [];
      document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"], [class*="message"], [class*="toast"]').forEach(el => {
        const t = el.textContent.trim();
        if (t) errors.push(t);
      });
      return { errors, bodyText: document.body.innerText.substring(0, 500) };
    });
    
    if (pageContent.errors.length > 0) {
      log.e(`Mensagens de erro: ${pageContent.errors.join(" | ")}`);
    }
    
    // Maybe the page is still loading/redirecting — give it more time
    log.i("Tentando esperar mais 10s pelo redirect...");
    await page.waitForTimeout(10000);
    await snap(page, "06b_extra_wait");
    
    if (hostname(page) === "brokers.mktlab.app") {
      log.ok("Redirect aconteceu com delay!");
    } else {
      // Last resort: try clicking Entrar again
      log.i("Tentando clicar Entrar novamente...");
      const entrarBtn2 = page.locator('button[type="submit"]').first();
      if (await entrarBtn2.isVisible().catch(() => false)) {
        const nav2 = page.waitForURL(
          (url) => new URL(url).hostname === "brokers.mktlab.app",
          { timeout: 15000 }
        ).catch(() => null);
        await entrarBtn2.click();
        await nav2;
        await page.waitForTimeout(3000);
      }
      
      if (hostname(page) !== "brokers.mktlab.app") {
        // Save debug info
        const debugPath = path.join(C.outputDir, `login_debug_${stamp()}.txt`);
        fs.writeFileSync(debugPath, JSON.stringify(pageContent, null, 2));
        throw new Error("Login falhou — não redirecionou para brokers.mktlab.app");
      }
    }
  }

  // Verify we're truly logged in
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  if (bodyText.includes("Acesse sua conta") || bodyText.includes("Acessar Lead Brokers")) {
    throw new Error("Página de login detectada após redirect — credenciais podem estar incorretas.");
  }

  log.ok("LOGIN CONCLUÍDO!");

  // Save session
  try {
    await page.context().storageState({ path: C.authFile });
    log.ok("Sessão salva.");
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════
async function goToMeusLeads(page) {
  // Try URL with %26 first (from your screenshots)
  const urls = [
    `${C.baseUrl}/v4-company-ferraz-piai-%26-co./product-preview`,
    `${C.baseUrl}/v4-company-ferraz-piai-&-co./product-preview`,
  ];

  for (const url of urls) {
    log.i(`Navegando: ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: C.timeout });
    await page.waitForTimeout(3000);
    await snap(page, "07_meus_leads");

    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    
    if (text.includes("Acesse sua conta") || text.includes("Acessar Lead Brokers")) {
      try { fs.unlinkSync(C.authFile); } catch {}
      throw new Error("Sessão expirada ao navegar para Meus Leads.");
    }

    if (text.includes("Minhas Aquisições") || text.includes("Exportar") || text.includes("Aquisições")) {
      log.ok("Página Meus Leads OK!");
      return;
    }

    if (text.includes("Erro inesperado")) {
      log.w("Erro inesperado — tentando URL alternativa...");
      continue;
    }
  }

  // If we got here, try clicking sidebar "Meus Leads"
  log.i("URLs não funcionaram. Tentando sidebar...");
  
  // First go to workspace home
  await page.goto(`${C.baseUrl}/v4-company-ferraz-piai-%26-co.`, {
    waitUntil: "networkidle", timeout: C.timeout,
  });
  await page.waitForTimeout(3000);

  // Try clicking the Meus Leads icon (cart icon, 4th in sidebar from screenshots)
  const sidebarLinks = page.locator('aside a, nav a, [class*="sidebar"] a');
  const count = await sidebarLinks.count();
  log.d(`Sidebar links: ${count}`);
  
  for (let i = 0; i < count; i++) {
    const href = await sidebarLinks.nth(i).getAttribute("href").catch(() => "");
    const title = await sidebarLinks.nth(i).getAttribute("title").catch(() => "");
    const text = await sidebarLinks.nth(i).textContent().catch(() => "");
    log.d(`  Link ${i}: href=${href} title=${title} text=${text}`);
    
    if (href?.includes("product") || title?.includes("Lead") || text?.includes("Lead")) {
      await sidebarLinks.nth(i).click();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(3000);
      
      const t = await page.evaluate(() => document.body.innerText).catch(() => "");
      if (t.includes("Minhas Aquisições") || t.includes("Exportar")) {
        log.ok("Meus Leads via sidebar!");
        return;
      }
    }
  }

  log.w("Continuando mesmo sem confirmar página...");
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
async function exportData(page) {
  fs.mkdirSync(C.outputDir, { recursive: true });

  // Ensure Aquisições tab
  try {
    const tab = page.locator('button:has-text("Aquisições"), [role="tab"]:has-text("Aquisições")').first();
    if (await tab.isVisible({ timeout: 3000 })) { await tab.click(); await page.waitForTimeout(2000); }
  } catch {}

  // Strategy A: CSV export
  const exportBtn = page.locator('button:has-text("Exportar"), a:has-text("Exportar")').first();
  if (await exportBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    log.i("Botão Exportar encontrado.");
    await snap(page, "08_export");

    try {
      const [dl] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        exportBtn.click(),
      ]);
      const p = path.join(C.outputDir, `leads_${stamp()}.csv`);
      await dl.saveAs(p);
      log.ok(`CSV: ${p}`);
      return { method: "csv", file: p };
    } catch (e) {
      log.w(`Download falhou: ${e.message}`);
    }

    // Try network intercept
    try {
      const [resp] = await Promise.all([
        page.waitForResponse(r => {
          const ct = r.headers()["content-type"] || "";
          return ct.includes("csv") || ct.includes("octet") || r.url().includes("export");
        }, { timeout: 15000 }),
        exportBtn.click(),
      ]);
      const body = await resp.body();
      const p = path.join(C.outputDir, `leads_${stamp()}.csv`);
      fs.writeFileSync(p, body);
      log.ok(`CSV intercept: ${p}`);
      return { method: "csv_net", file: p };
    } catch {}
  }

  // Strategy B: Scrape table
  log.i("Scraping tabela...");
  await page.waitForSelector("table", { timeout: 10000 }).catch(() => {});

  // Scroll to load all
  for (let i = 0; i < 20; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    if (await page.evaluate(() => document.body.scrollHeight) === h) break;
  }

  const rows = await page.evaluate(() => {
    const t = document.querySelector("table");
    if (!t) return [];
    const hs = [...t.querySelectorAll("thead th")].map(h => h.textContent.trim());
    return [...t.querySelectorAll("tbody tr")].map(r => {
      const cs = [...r.querySelectorAll("td")].map(c => c.textContent.trim());
      const o = {};
      hs.forEach((h, i) => o[h] = cs[i] || "");
      return o;
    }).filter(r => Object.values(r).some(v => v));
  });

  log.i(`Tabela: ${rows.length} rows`);
  await snap(page, "09_table");
  return { method: "table", file: null, rows };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS
// ═══════════════════════════════════════════════════════════════════════════════
function process(result) {
  if (result.file) {
    const raw = fs.readFileSync(result.file, "utf-8");
    const sep = raw.split("\n")[0]?.includes(";") ? ";" : ",";
    const ls = raw.split("\n").filter(l => l.trim());
    if (ls.length < 2) return [];
    const hs = csvLine(ls[0], sep);
    return ls.slice(1).map(l => {
      const vs = csvLine(l, sep);
      const r = {};
      hs.forEach((h, i) => r[h] = vs[i] || "");
      return norm(r);
    });
  }
  return (result.rows || []).map(norm);
}

function norm(r) {
  return {
    nome_empresa: fc(r, ["empresa"]),
    cnpj: fc(r, ["documento da empresa", "cnpj", "documento"]),
    faturamento: fc(r, ["faturamento"]),
    segmento: fc(r, ["segmento"]),
    responsavel: fc(r, ["responsável", "responsavel"]),
    telefone: fc(r, ["telefone"]),
    email: fc(r, ["e-mail", "email"]),
    valor: fc(r, ["valor"]),
    cargo: fc(r, ["cargo"]),
    tipo: fc(r, ["tipo"]),
    arrematador: fc(r, ["arrematador"]),
    data_compra: fc(r, ["data/hora de compra", "data_compra"]),
  };
}

function fc(r, ns) {
  const n = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  for (const k of Object.keys(r)) for (const nm of ns) if (n(k).includes(n(nm))) return r[k] || "";
  return "";
}

function csvLine(l, s) {
  const o = []; let c = "", q = false;
  for (const ch of l) { if (ch === '"') q = !q; else if (ch === s && !q) { o.push(c.replace(/^"|"$/g, "").trim()); c = ""; } else c += ch; }
  o.push(c.replace(/^"|"$/g, "").trim()); return o;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════════
async function webhook(leads) {
  if (!C.webhookUrl || !leads.length) return;
  log.i(`Webhook: ${leads.length} leads...`);
  const r = await fetch(C.webhookUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp: new Date().toISOString(), source: "brokers-v5", total: leads.length, leads }),
  });
  if (!r.ok) throw new Error(`Webhook ${r.status}`);
  log.ok("Webhook OK.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function scrape() {
  if (!C.email || !C.password) throw new Error("Credenciais obrigatórias.");

  const ctxOpts = {
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  };
  if (fs.existsSync(C.authFile)) ctxOpts.storageState = C.authFile;

  const browser = await chromium.launch({
    headless: C.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    page.setDefaultTimeout(C.timeout);

    await login(page);
    await goToMeusLeads(page);

    const result = await exportData(page);
    const leads = process(result);
    log.i(`${leads.length} leads (${result.method})`);

    if (leads.length > 0) {
      const jp = path.join(C.outputDir, `leads_${stamp()}.json`);
      fs.writeFileSync(jp, JSON.stringify(leads, null, 2));
      log.ok(`JSON: ${jp}`);
    }

    const valid = leads.filter(l => l.nome_empresa || l.telefone || l.email);
    if (valid.length > 0) await webhook(valid);
    else log.w("Nenhum lead válido.");

    await browser.close();
    return { ok: leads.length > 0, n: leads.length, m: result.method };
  } catch (err) {
    log.e(err.message);
    try {
      const pg = browser.contexts()[0]?.pages()[0];
      if (pg) await pg.screenshot({ path: path.join(C.outputDir, `error_${stamp()}.png`), fullPage: true });
    } catch {}
    await browser.close();
    throw err;
  }
}

async function run() {
  for (let i = 1; i <= C.retries; i++) {
    log.i(`═══ Tentativa ${i}/${C.retries} ═══`);
    try { return await scrape(); }
    catch (e) {
      log.e(`#${i}: ${e.message}`);
      try { fs.unlinkSync(C.authFile); } catch {}
      if (i < C.retries) await sleep(C.retryDelay);
    }
  }
  return { ok: false, n: 0, m: "none" };
}

(async () => {
  log.i("╔═══════════════════════════════════════╗");
  log.i("║  Brokers Exporter v5 — V4 Ferraz Piai ║");
  log.i("╚═══════════════════════════════════════╝");
  log.i(`Loop: ${C.interval / 60000}min | Debug: ${C.debug}`);

  const r = await run();
  log.i(`→ ${r.ok ? "OK" : "FAIL"} ${r.n} leads (${r.m})`);
  log.i(`Próxima em ${C.interval / 60000}min\n`);

  setInterval(async () => {
    log.i("═══════════════════════════════════════");
    const r = await run();
    log.i(`→ ${r.ok ? "OK" : "FAIL"} ${r.n} leads (${r.m})`);
    log.i(`Próxima em ${C.interval / 60000}min\n`);
  }, C.interval);
})();

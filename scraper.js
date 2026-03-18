/**
 * Brokers MKTLab - Lead Exporter v6
 *
 * Fixes from v5:
 * 1. smartType() - removed React native setter hack that conflicted with
 *    pressSequentially(). Only uses keyboard simulation now.
 * 2. Removed form.requestSubmit() fallback - it sent GET requests (400 error).
 * 3. Uses waitForURL with hostname check instead of waitForNavigation('networkidle').
 * 4. Added network request/response logging to diagnose login API failures.
 * 5. Waits for password field after Avançar instead of arbitrary timeout.
 * 6. Updated webhook fields to include all lead detail fields.
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
  storagePath: "/app/exports/auth-state.json",
  workspace: "v4-company-ferraz-piai-%26-co.",
};

function L(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

const stamp = () =>
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snap(page, name) {
  try {
    fs.mkdirSync(C.outputDir, { recursive: true });
    const p = path.join(C.outputDir, `${name}_${stamp()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    L("DBG", `Screenshot: ${p}`);
  } catch (e) {
    L("WARN", `Screenshot fail: ${e.message}`);
  }
}

function hn(page) {
  try {
    return new URL(page.url()).hostname;
  } catch {
    return "";
  }
}

/**
 * Type text into a custom v4-input-field using only keyboard simulation.
 * pressSequentially fires real keydown/keypress/input/keyup events that
 * React's synthetic event system picks up correctly.
 *
 * IMPORTANT: Do NOT combine with native setter hack - it conflicts with
 * React's controlled component state and causes the form to submit empty values.
 */
async function smartType(page, selector, text) {
  L("DBG", `smartType: "${selector}" -> "${text.substring(0, 5)}..."`);
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 10000 });

  // Focus and select all existing text
  await input.click();
  await sleep(300);

  // Clear existing content
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await sleep(100);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await sleep(100);

  // Type character by character - this fires real keyboard events
  // that React processes through its synthetic event system
  await input.pressSequentially(text, { delay: 50 });
  await sleep(500);

  // Verify
  const actual = await input.inputValue();
  L(
    "DBG",
    `smartType result: "${actual}" (expected ${text.length} chars, got ${actual.length})`
  );

  if (actual !== text) {
    L("WARN", `smartType mismatch! Retrying with slower typing...`);
    await input.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await sleep(200);
    // Retry even slower
    await input.pressSequentially(text, { delay: 80 });
    await sleep(500);
    const retry = await input.inputValue();
    L("DBG", `smartType retry: "${retry}" (${retry.length} chars)`);
    return retry === text;
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════════════════
async function doLogin(page) {
  L("INFO", "=== LOGIN START ===");

  // Set up network logging for identity.mktlab.app
  const apiLogs = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("identity.mktlab.app") && !url.includes(".js") && !url.includes(".css") && !url.includes(".png")) {
      const status = response.status();
      const method = response.request().method();
      if (method !== "GET" || status >= 400) {
        let body = "";
        try {
          body = await response.text();
          if (body.length > 500) body = body.substring(0, 500) + "...";
        } catch {}
        apiLogs.push({ method, url: url.substring(0, 120), status, body });
        L("NET", `${method} ${status} ${url.substring(0, 100)}`);
        if (body) L("NET", `  Response: ${body.substring(0, 300)}`);
      }
    }
  });

  // Check saved session first
  if (fs.existsSync(C.storagePath)) {
    L("INFO", "Testing saved session...");
    try {
      await page.goto(
        `${C.baseUrl}/${C.workspace}/product-preview`,
        { waitUntil: "domcontentloaded", timeout: 20000 }
      );
      await sleep(3000);
      if (hn(page) === "brokers.mktlab.app") {
        const t = await page
          .evaluate(() => document.body.innerText)
          .catch(() => "");
        if (
          !t.includes("Acesse sua conta") &&
          !t.includes("Acessar Lead Brokers")
        ) {
          L("OK", "Session valid!");
          return;
        }
      }
    } catch {}
    try {
      fs.unlinkSync(C.storagePath);
    } catch {}
  }

  // ── STEP 1: Navigate to brokers signin ──────────────────────────────────
  L("INFO", "STEP 1: brokers.mktlab.app/signin");
  await page.goto(`${C.baseUrl}/signin`, {
    waitUntil: "networkidle",
    timeout: C.timeout,
  });
  await sleep(2000);
  L("INFO", `URL: ${page.url()} | Host: ${hn(page)}`);
  await snap(page, "01_signin");

  // Click "Acessar Lead Brokers" - works with both <a> and <button>
  const accessBtn = page.getByText("Acessar Lead Brokers").first();
  const accessVisible = await accessBtn
    .isVisible({ timeout: 5000 })
    .catch(() => false);
  L("DBG", `accessBtn visible: ${accessVisible}`);

  if (!accessVisible) {
    throw new Error(
      "Botão 'Acessar Lead Brokers' não encontrado na página de signin"
    );
  }

  L("INFO", "Clicking 'Acessar Lead Brokers'...");
  await accessBtn.click();

  // Wait for redirect to identity.mktlab.app
  try {
    await page.waitForURL(
      (url) => new URL(url).hostname === "identity.mktlab.app",
      { timeout: 15000 }
    );
    L("OK", "Redirected to identity.mktlab.app");
  } catch {
    L("WARN", `After click - still on ${hn(page)}, waiting more...`);
    await sleep(3000);
  }
  await sleep(2000);
  L("INFO", `After step 1 - Host: ${hn(page)} URL: ${page.url()}`);
  await snap(page, "02_identity");

  if (hn(page) !== "identity.mktlab.app") {
    throw new Error(
      `Expected identity.mktlab.app but got ${hn(page)}`
    );
  }

  // ── STEP 2: Fill email ──────────────────────────────────────────────────
  L("INFO", "STEP 2: Filling email...");

  // Debug: log visible inputs and buttons
  await debugElements(page);

  // Find and fill email field
  const emailSelectors = [
    'input[name="email"]',
    'input[type="email"]',
    'input.v4-input-field[type="email"]',
    'input[placeholder*="mail"]',
    'input[placeholder*="Mail"]',
    'input[placeholder*="E-mail"]',
  ];

  let emailFilled = false;
  for (const sel of emailSelectors) {
    const visible = await page
      .locator(sel)
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (visible) {
      L("DBG", `Using email selector: "${sel}"`);
      emailFilled = await smartType(page, sel, C.email);
      break;
    }
  }

  if (!emailFilled) {
    // Fallback: first visible input
    L("WARN", "No email selector matched. Using first visible input...");
    const firstInput = page.locator("input:visible").first();
    if (await firstInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      emailFilled = await smartType(page, "input:visible", C.email);
    }
  }

  if (!emailFilled) {
    throw new Error("Could not fill email field");
  }

  L("OK", `Email typed: ${C.email}`);
  await snap(page, "03_email");

  // ── Click Avançar ───────────────────────────────────────────────────────
  L("INFO", "Waiting for 'Avançar' to become enabled...");

  // Wait for the Avançar button to be enabled (React enables it after email validation)
  const avancar = page.getByText("Avançar").first();
  try {
    await avancar.waitFor({ state: "visible", timeout: 5000 });
    // Wait for it to become enabled
    await page.waitForFunction(
      () => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          b.textContent.includes("Avançar")
        );
        return btn && !btn.disabled;
      },
      { timeout: 5000 }
    );
    L("OK", "Avançar button enabled");
  } catch {
    L("WARN", "Avançar button not enabled, trying anyway...");
  }

  L("INFO", "Clicking 'Avançar'...");
  await avancar.click();

  // Wait for password field to appear (SPA content swap, not navigation)
  L("INFO", "Waiting for password field...");
  const pwField = page.locator(
    'input[type="password"], input[name="password"]'
  ).first();
  try {
    await pwField.waitFor({ state: "visible", timeout: 15000 });
    L("OK", "Password field visible.");
  } catch (e) {
    L("ERR", `Password field NOT found after Avançar: ${e.message}`);
    await snap(page, "04_no_password");
    const bodyText = await page
      .evaluate(() => document.body.innerText)
      .catch(() => "");
    L("DBG", `Page text: ${bodyText.substring(0, 300)}`);
    throw new Error("Password field not found after clicking Avançar");
  }
  await snap(page, "04_password_page");

  // ── STEP 3: Fill password ───────────────────────────────────────────────
  L("INFO", "STEP 3: Filling password...");

  // Debug elements on password page
  await debugElements(page);

  await smartType(
    page,
    'input[name="password"], input[type="password"]',
    C.password
  );
  L("OK", "Password typed.");
  await snap(page, "05_password");

  // ── Submit login ────────────────────────────────────────────────────────
  L("INFO", "Submitting login...");

  // Wait for Entrar button to be enabled
  const entrar = page.getByText("Entrar", { exact: true }).first();
  const entrarVisible = await entrar
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  L("DBG", `Entrar visible: ${entrarVisible}`);

  if (entrarVisible) {
    // Wait for enabled
    try {
      await page.waitForFunction(
        () => {
          const btn = [...document.querySelectorAll("button")].find((b) =>
            b.textContent.trim() === "Entrar"
          );
          return btn && !btn.disabled;
        },
        { timeout: 3000 }
      );
    } catch {}

    // Click and wait for redirect
    L("INFO", "Clicking 'Entrar'...");
    await entrar.click();
  } else {
    // Fallback: press Enter on password field
    L("INFO", "Entrar not found, pressing Enter on password field...");
    await pwField.press("Enter");
  }

  // Wait for redirect away from identity.mktlab.app
  L("INFO", "Waiting for redirect after login...");
  try {
    await page.waitForURL(
      (url) => new URL(url).hostname !== "identity.mktlab.app",
      { timeout: 30000 }
    );
    L("OK", `Redirected to: ${hn(page)}`);
  } catch {
    L("WARN", `Still on identity after 30s. Host: ${hn(page)}`);
  }

  await sleep(3000);
  L("INFO", `After login - Host: ${hn(page)} URL: ${page.url()}`);
  await snap(page, "06_after_login");

  // If still stuck on identity, try pressing Enter as last resort
  if (hn(page) === "identity.mktlab.app") {
    L("WARN", "Still on identity! Checking for errors...");

    // Check for visible error messages
    const errors = await page.evaluate(() => {
      return [
        ...document.querySelectorAll(
          '[class*="error"],[role="alert"],[class*="alert"],[class*="invalid"],[class*="toast"],[class*="notification"]'
        ),
      ]
        .map((e) => e.textContent.trim())
        .filter((t) => t);
    });
    if (errors.length) {
      L("ERR", `Page errors: ${errors.join(" | ")}`);
    } else {
      L("DBG", "No visible error messages on page");
    }

    // Log API responses we captured
    if (apiLogs.length) {
      L("DBG", `API calls captured: ${apiLogs.length}`);
      for (const log of apiLogs) {
        L("DBG", `  ${log.method} ${log.status} ${log.url}`);
        if (log.body) L("DBG", `  Body: ${log.body.substring(0, 200)}`);
      }
    }

    // Try pressing Enter on password field
    L("INFO", "Trying Enter key on password field...");
    try {
      const pwStillVisible = await pwField.isVisible().catch(() => false);
      if (pwStillVisible) {
        await pwField.focus();
        await sleep(200);
        await page.keyboard.press("Enter");
        await sleep(5000);
        L("INFO", `After Enter - Host: ${hn(page)}`);
      }
    } catch (e) {
      L("WARN", `Enter retry failed: ${e.message}`);
    }

    // Final wait for redirect
    if (hn(page) === "identity.mktlab.app") {
      try {
        await page.waitForURL(
          (url) => new URL(url).hostname !== "identity.mktlab.app",
          { timeout: 15000 }
        );
      } catch {}
    }
  }

  // Final check
  L("INFO", `FINAL - Host: ${hn(page)} URL: ${page.url()}`);
  await snap(page, "07_final");

  if (hn(page) === "identity.mktlab.app") {
    // Save debug info
    const html = await page.content().catch(() => "");
    fs.writeFileSync(path.join(C.outputDir, `fail_${stamp()}.html`), html);
    const txt = await page
      .evaluate(() => document.body.innerText)
      .catch(() => "");
    fs.writeFileSync(path.join(C.outputDir, `fail_text_${stamp()}.txt`), txt);

    // Log all captured API responses
    if (apiLogs.length) {
      fs.writeFileSync(
        path.join(C.outputDir, `fail_api_${stamp()}.json`),
        JSON.stringify(apiLogs, null, 2)
      );
    }

    L("ERR", "=== LOGIN FAILED ===");
    L("ERR", "Possible causes:");
    L("ERR", "  1. Wrong credentials");
    L("ERR", "  2. Anti-bot detection");
    L("ERR", "  3. PKCE/OAuth flow rejection");
    if (apiLogs.some((l) => l.status === 400)) {
      L("ERR", "  4. API returned 400 - check fail_api_*.json for details");
    }
    throw new Error("Login failed - stuck on identity.mktlab.app");
  }

  L("OK", "=== LOGIN SUCCESS ===");
  try {
    await page.context().storageState({ path: C.storagePath });
    L("OK", "Session saved.");
  } catch {}
}

async function debugElements(page) {
  const inputs = await page.locator("input:visible").all();
  for (let i = 0; i < inputs.length; i++) {
    const attrs = await inputs[i].evaluate((el) => ({
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      className: el.className.substring(0, 60),
      value: el.value ? `[${el.value.length} chars]` : "[empty]",
    }));
    L("DBG", `  input[${i}]: ${JSON.stringify(attrs)}`);
  }
  const buttons = await page.locator("button:visible").all();
  for (let i = 0; i < buttons.length; i++) {
    const info = await buttons[i].evaluate((el) => ({
      type: el.type,
      text: el.textContent.trim().substring(0, 30),
      disabled: el.disabled,
    }));
    L("DBG", `  button[${i}]: ${JSON.stringify(info)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATE TO LEADS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
async function goToMeusLeads(page) {
  const urls = [
    `${C.baseUrl}/${C.workspace}/product-preview`,
    `${C.baseUrl}/v4-company-ferraz-piai-&-co./product-preview`,
  ];
  for (const url of urls) {
    L("INFO", `Navigating: ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: C.timeout });
    await sleep(3000);
    const t = await page
      .evaluate(() => document.body.innerText)
      .catch(() => "");
    if (t.includes("Acesse sua conta")) {
      try { fs.unlinkSync(C.storagePath); } catch {}
      throw new Error("Session lost - redirected to login");
    }
    if (t.includes("Minhas Aquisições") || t.includes("Exportar")) {
      L("OK", "Meus Leads page loaded.");
      await snap(page, "08_meus_leads");
      return;
    }
    if (t.includes("Erro inesperado")) {
      L("WARN", "Wrong workspace, trying next URL...");
      continue;
    }
    L("WARN", `Unknown page content: ${t.substring(0, 150)}`);
  }
  throw new Error("Could not navigate to Meus Leads page");
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT DATA
// ═══════════════════════════════════════════════════════════════════════════════
async function exportData(page) {
  fs.mkdirSync(C.outputDir, { recursive: true });

  // Click Aquisições tab if present
  try {
    const tab = page.locator('button:has-text("Aquisições")').first();
    if (await tab.isVisible({ timeout: 3000 })) {
      await tab.click();
      await sleep(1000);
    }
  } catch {}

  // Try CSV export via download
  const exp = page
    .locator('button:has-text("Exportar"), a:has-text("Exportar")')
    .first();
  if (await exp.isVisible({ timeout: 5000 }).catch(() => false)) {
    L("INFO", "Clicking 'Exportar'...");

    // Method 1: Wait for download event
    try {
      const [dl] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        exp.click(),
      ]);
      const p = path.join(C.outputDir, `leads_${stamp()}.csv`);
      await dl.saveAs(p);
      L("OK", `CSV downloaded: ${p}`);
      return { method: "csv", file: p };
    } catch (e) {
      L("WARN", `Download event failed: ${e.message}`);
    }

    // Method 2: Intercept network response
    try {
      const [resp] = await Promise.all([
        page.waitForResponse(
          (r) =>
            (r.headers()["content-type"] || "").match(/csv|octet/) ||
            r.url().match(/export|download/),
          { timeout: 15000 }
        ),
        exp.click(),
      ]);
      const body = await resp.body();
      const p = path.join(C.outputDir, `leads_${stamp()}.csv`);
      fs.writeFileSync(p, body);
      L("OK", `CSV intercepted: ${p}`);
      return { method: "csv_net", file: p };
    } catch (e) {
      L("WARN", `Network intercept failed: ${e.message}`);
    }
  }

  // Method 3: Scrape table HTML
  L("INFO", "Falling back to table scraping...");
  await page
    .waitForSelector("table", { timeout: 10000 })
    .catch(() => {});

  // Scroll to load all rows
  for (let i = 0; i < 20; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() =>
      window.scrollTo(0, document.body.scrollHeight)
    );
    await sleep(800);
    if ((await page.evaluate(() => document.body.scrollHeight)) === h) break;
  }

  const data = await page.evaluate(() => {
    const t = document.querySelector("table");
    if (!t) return [];
    const ths = [...t.querySelectorAll("thead th")].map((h) =>
      h.textContent.trim()
    );
    return [...t.querySelectorAll("tbody tr")]
      .map((r) => {
        const c = [...r.querySelectorAll("td")].map((c) =>
          c.textContent.trim()
        );
        const o = {};
        ths.forEach((h, i) => (o[h] = c[i] || ""));
        return o;
      })
      .filter((r) => Object.values(r).some((v) => v));
  });
  L("INFO", `Table scraped: ${data.length} rows`);
  return { method: "table", file: null, rows: data };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS & NORMALIZE
// ═══════════════════════════════════════════════════════════════════════════════
function processResults(result) {
  if (result.file) {
    const raw = fs.readFileSync(result.file, "utf-8");
    const sep = raw.split("\n")[0]?.includes(";") ? ";" : ",";
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return [];
    const hdrs = parseCsvLine(lines[0], sep);
    return lines.slice(1).map((l) => {
      const v = parseCsvLine(l, sep);
      const r = {};
      hdrs.forEach((h, i) => (r[h] = v[i] || ""));
      return normalizeFields(r);
    });
  }
  return (result.rows || []).map(normalizeFields);
}

function normalizeFields(r) {
  return {
    nome_empresa: fc(r, ["empresa", "nome da empresa"]),
    documento_empresa: fc(r, ["documento da empresa", "cnpj", "documento"]),
    faturamento: fc(r, ["faturamento"]),
    segmento: fc(r, ["segmento"]),
    pais: fc(r, ["país", "pais"]),
    email_responsavel: fc(r, ["e-mail", "email"]),
    cargo: fc(r, ["cargo"]),
    telefone: fc(r, ["telefone"]),
    tipo_produto: fc(r, ["tipo de produto", "tipo"]),
    canal: fc(r, ["canal"]),
    descricao: fc(r, ["descrição", "descricao"]),
    data_criacao: fc(r, ["data de criação", "data de criacao", "data criacao"]),
    urgencia: fc(r, ["urgência", "urgencia"]),
    city: fc(r, ["cidade", "city"]),
    state: fc(r, ["estado", "state"]),
    valor: fc(r, ["valor"]),
    responsavel: fc(r, ["responsável", "responsavel", "nome do responsável"]),
    arrematador: fc(r, ["arrematador"]),
    data_compra: fc(r, ["data/hora de compra", "data/hora da compra"]),
    data_aquisicao: fc(r, ["data de aquisição", "data de aquisicao"]),
  };
}

function fc(r, names) {
  const n = (s) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  for (const k of Object.keys(r))
    for (const nm of names) if (n(k).includes(n(nm))) return r[k] || "";
  return "";
}

function parseCsvLine(line, sep) {
  const o = [];
  let c = "",
    q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) {
      o.push(c.replace(/^"|"$/g, "").trim());
      c = "";
    } else c += ch;
  }
  o.push(c.replace(/^"|"$/g, "").trim());
  return o;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK
// ═══════════════════════════════════════════════════════════════════════════════
async function webhook(leads) {
  if (!C.webhookUrl || !leads.length) return;
  L("INFO", `Sending ${leads.length} leads to webhook...`);
  const r = await fetch(C.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      source: "brokers-v6",
      total: leads.length,
      leads,
    }),
  });
  if (!r.ok) throw new Error(`Webhook ${r.status}: ${await r.text()}`);
  L("OK", "Webhook sent successfully.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function scrape() {
  if (!C.email || !C.password)
    throw new Error("BROKER_EMAIL and BROKER_PASSWORD are required.");
  let browser;
  try {
    const opts = {
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    };
    if (fs.existsSync(C.storagePath)) opts.storageState = C.storagePath;
    browser = await chromium.launch({
      headless: C.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(C.timeout);
    page.on("console", (m) => {
      if (m.type() === "error") L("BROWSER", `${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => L("BROWSER_ERR", e.message));

    await doLogin(page);
    await goToMeusLeads(page);
    const result = await exportData(page);
    const leads = processResults(result);
    L("INFO", `Processed ${leads.length} leads (${result.method}).`);

    if (leads.length > 0) {
      const jp = path.join(C.outputDir, `leads_${stamp()}.json`);
      fs.writeFileSync(jp, JSON.stringify(leads, null, 2));
      L("OK", `JSON saved: ${jp}`);
    }

    const valid = leads.filter(
      (l) => l.nome_empresa || l.telefone || l.email_responsavel
    );
    if (valid.length > 0) {
      await webhook(valid);
    } else {
      L("WARN", `${leads.length} leads processed but none have valid data.`);
    }

    await browser.close();
    return { ok: true, n: leads.length, method: result.method };
  } catch (err) {
    L("ERR", err.message);
    if (browser) {
      try {
        const p = browser.contexts()[0]?.pages()[0];
        if (p)
          await p.screenshot({
            path: path.join(C.outputDir, `error_${stamp()}.png`),
            fullPage: true,
          });
      } catch {}
      await browser.close();
    }
    throw err;
  }
}

async function run() {
  for (let i = 1; i <= C.retries; i++) {
    L("INFO", `=== ATTEMPT ${i}/${C.retries} ===`);
    try {
      return await scrape();
    } catch (e) {
      L("ERR", `Attempt ${i}: ${e.message}`);
      if (i < C.retries) {
        try { fs.unlinkSync(C.storagePath); } catch {}
        await sleep(C.retryDelay);
      }
    }
  }
  return { ok: false, n: 0, method: "none" };
}

async function main() {
  L("INFO", "╔═════════════════════════════════════════════════╗");
  L("INFO", "║  Brokers Lead Exporter v6 — V4 Ferraz Piai     ║");
  L("INFO", "╚═════════════════════════════════════════════════╝");
  L("INFO", `Email: ${C.email} | Pass: ${"*".repeat((C.password || "").length)} chars`);
  L("INFO", `Loop: ${C.interval / 60000}min | Webhook: ${C.webhookUrl ? "OK" : "NO"}`);

  const r = await run();
  L("INFO", `=> ${r.ok ? "OK" : "FAIL"} - ${r.n} leads (${r.method})`);

  setInterval(async () => {
    L("INFO", "=================================================");
    const r = await run();
    L("INFO", `=> ${r.ok ? "OK" : "FAIL"} - ${r.n} leads (${r.method})`);
  }, C.interval);
}

main();

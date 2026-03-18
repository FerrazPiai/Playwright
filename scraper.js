/**
 * Brokers MKTLab - Lead Exporter v7
 *
 * ROOT CAUSE (confirmed via v6 network logging):
 * POST https://v1.identity.mktlab.app/auth/signin returns 400 INVALID_CREDENTIALS.
 * pressSequentially() updates the DOM value correctly, but React's controlled
 * component state (v4-input-field) does NOT reflect the typed value. The form
 * sends empty/partial credentials to the API.
 *
 * FIX: Use page.route() to intercept the signin API request and inject the
 * correct email+password into the request body. This completely bypasses
 * React's input state management. We still type into the fields (so the UI
 * enables the submit button), but the actual API call gets correct credentials.
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
 * Type text into a v4-input-field for UI purposes (enabling buttons).
 * The actual credentials are injected via route interception, so this
 * only needs to make React enable the submit button.
 */
async function smartType(page, selector, text) {
  L("DBG", `smartType: "${selector}" -> "${text.substring(0, 5)}..."`);
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 10000 });

  // Focus
  await input.click();
  await sleep(300);

  // Clear
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await sleep(100);

  // Type char by char
  await input.pressSequentially(text, { delay: 50 });
  await sleep(500);

  // Verify DOM value
  const actual = await input.inputValue();
  L(
    "DBG",
    `smartType DOM value: "${actual}" (expected ${text.length}, got ${actual.length})`
  );

  // If DOM value doesn't match, try native setter as fallback for UI only
  if (actual !== text) {
    L("WARN", "DOM value mismatch, using native setter for UI...");
    await input.evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, text);
    await sleep(300);
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════════════════
async function doLogin(page) {
  L("INFO", "=== LOGIN START ===");

  // ── Set up route interception for the signin API ──────────────────────
  // This is the KEY FIX: intercept the POST to auth/signin and inject
  // correct credentials, bypassing React's broken controlled input state.
  let signinIntercepted = false;
  await page.route("**/auth/signin", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }

    let body;
    try {
      body = JSON.parse(request.postData() || "{}");
    } catch {
      body = {};
    }

    // Log what React actually sent
    L(
      "NET",
      `Intercepted signin POST - Original body: email=${body.email || "MISSING"}, password=${body.password ? `[${body.password.length}chars]` : "MISSING"}`
    );

    // Inject correct credentials
    body.email = C.email;
    body.password = C.password;
    signinIntercepted = true;

    L("NET", "Injected correct credentials into signin request");

    await route.continue({
      postData: JSON.stringify(body),
      headers: {
        ...request.headers(),
        "content-type": "application/json",
      },
    });
  });

  // Set up network logging for non-intercepted requests
  page.on("response", async (response) => {
    const url = response.url();
    if (
      url.includes("identity.mktlab.app") &&
      !url.includes(".js") &&
      !url.includes(".css") &&
      !url.includes(".png")
    ) {
      const status = response.status();
      const method = response.request().method();
      if (status >= 400) {
        let body = "";
        try {
          body = await response.text();
          if (body.length > 500) body = body.substring(0, 500) + "...";
        } catch {}
        L("NET", `${method} ${status} ${url.substring(0, 100)}`);
        if (body) L("NET", `  Response: ${body.substring(0, 300)}`);
      }
    }
  });

  // Check saved session first
  if (fs.existsSync(C.storagePath)) {
    L("INFO", "Testing saved session...");
    try {
      await page.goto(`${C.baseUrl}/${C.workspace}/product-preview`, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
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

  // Click "Acessar Lead Brokers"
  const accessBtn = page.getByText("Acessar Lead Brokers").first();
  const accessVisible = await accessBtn
    .isVisible({ timeout: 5000 })
    .catch(() => false);
  L("DBG", `accessBtn visible: ${accessVisible}`);

  if (!accessVisible) {
    throw new Error("Botão 'Acessar Lead Brokers' not found");
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
    L("WARN", `After click - still on ${hn(page)}, waiting...`);
    await sleep(3000);
  }
  await sleep(2000);
  L("INFO", `After step 1 - Host: ${hn(page)}`);
  await snap(page, "02_identity");

  if (hn(page) !== "identity.mktlab.app") {
    throw new Error(`Expected identity.mktlab.app but got ${hn(page)}`);
  }

  // ── STEP 2: Fill email ──────────────────────────────────────────────────
  L("INFO", "STEP 2: Filling email...");
  await debugElements(page);

  const emailSelectors = [
    'input[name="email"]',
    'input[type="email"]',
    'input.v4-input-field[type="email"]',
    'input[placeholder*="mail"]',
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
  const avancar = page.getByText("Avançar").first();
  try {
    await avancar.waitFor({ state: "visible", timeout: 5000 });
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
    L("WARN", "Avançar not enabled after 5s, trying anyway...");
  }

  L("INFO", "Clicking 'Avançar'...");
  await avancar.click();

  // Wait for password field (SPA content swap)
  L("INFO", "Waiting for password field...");
  const pwField = page
    .locator('input[type="password"], input[name="password"]')
    .first();
  try {
    await pwField.waitFor({ state: "visible", timeout: 15000 });
    L("OK", "Password field visible.");
  } catch (e) {
    L("ERR", `Password field NOT found: ${e.message}`);
    await snap(page, "04_no_password");
    throw new Error("Password field not found after Avançar");
  }
  await sleep(500);
  await snap(page, "04_password_page");

  // ── STEP 3: Fill password ───────────────────────────────────────────────
  L("INFO", "STEP 3: Filling password...");
  await debugElements(page);

  await smartType(
    page,
    'input[name="password"], input[type="password"]',
    C.password
  );
  L("OK", "Password typed.");
  await snap(page, "05_password");

  // ── STEP 4: Submit login ──────────────────────────────────────────────
  L("INFO", "STEP 4: Submitting login...");

  // Wait for Entrar button to be enabled
  const entrar = page.getByText("Entrar", { exact: true }).first();
  const entrarVisible = await entrar
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  L("DBG", `Entrar visible: ${entrarVisible}`);

  // Wait for enabled state
  let entrarEnabled = false;
  try {
    await page.waitForFunction(
      () => {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === "Entrar"
        );
        return btn && !btn.disabled;
      },
      { timeout: 5000 }
    );
    entrarEnabled = true;
    L("OK", "Entrar button enabled");
  } catch {
    L("WARN", "Entrar button still disabled after 5s");
  }

  // Log button states after typing
  await debugElements(page);

  if (entrarVisible && entrarEnabled) {
    L("INFO", "Clicking 'Entrar'...");
    await entrar.click();
  } else if (entrarVisible) {
    // Button visible but disabled - force enable and click
    L("WARN", "Entrar disabled - force enabling via JS...");
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "Entrar"
      );
      if (btn) {
        btn.disabled = false;
        btn.click();
      }
    });
  } else {
    L("INFO", "Entrar not found, pressing Enter...");
    await pwField.press("Enter");
  }

  // Wait for redirect
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
  L("INFO", `Signin intercepted: ${signinIntercepted}`);
  await snap(page, "06_after_login");

  // If still on identity, check what happened
  if (hn(page) === "identity.mktlab.app") {
    L("WARN", "Still on identity! Checking errors...");

    const errors = await page.evaluate(() => {
      return [
        ...document.querySelectorAll(
          '[class*="error"],[role="alert"],[class*="alert"],[class*="invalid"],[class*="toast"]'
        ),
      ]
        .map((e) => e.textContent.trim())
        .filter((t) => t);
    });
    if (errors.length) {
      L("ERR", `Page errors: ${errors.join(" | ")}`);
    }

    // Try one more time: press Enter on password field
    L("INFO", "Retrying with Enter key...");
    try {
      if (await pwField.isVisible().catch(() => false)) {
        await pwField.focus();
        await sleep(200);
        await page.keyboard.press("Enter");
        try {
          await page.waitForURL(
            (url) => new URL(url).hostname !== "identity.mktlab.app",
            { timeout: 15000 }
          );
          L("OK", `Redirected after Enter: ${hn(page)}`);
        } catch {}
      }
    } catch (e) {
      L("WARN", `Enter retry failed: ${e.message}`);
    }
  }

  // Final check
  L("INFO", `FINAL - Host: ${hn(page)} URL: ${page.url()}`);
  await snap(page, "07_final");

  if (hn(page) === "identity.mktlab.app") {
    // Save debug info
    try {
      const html = await page.content().catch(() => "");
      fs.writeFileSync(path.join(C.outputDir, `fail_${stamp()}.html`), html);
      const txt = await page
        .evaluate(() => document.body.innerText)
        .catch(() => "");
      fs.writeFileSync(
        path.join(C.outputDir, `fail_text_${stamp()}.txt`),
        txt
      );
    } catch {}

    L("ERR", "=== LOGIN FAILED ===");
    L("ERR", `Signin API intercepted: ${signinIntercepted}`);
    throw new Error("Login failed - stuck on identity.mktlab.app");
  }

  L("OK", "=== LOGIN SUCCESS ===");

  // Remove route interceptor
  await page.unroute("**/auth/signin");

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
      disabled: el.disabled,
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
      try {
        fs.unlinkSync(C.storagePath);
      } catch {}
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
      L("WARN", `Download failed: ${e.message}`);
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
      L("WARN", `Intercept failed: ${e.message}`);
    }
  }

  // Method 3: Scrape table HTML
  L("INFO", "Falling back to table scraping...");
  await page.waitForSelector("table", { timeout: 10000 }).catch(() => {});

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
    L("DBG", `CSV headers: ${hdrs.join(" | ")}`);
    return lines.slice(1).map((l) => {
      const v = parseCsvLine(l, sep);
      const r = {};
      hdrs.forEach((h, i) => (r[h] = v[i] || ""));
      return normalizeFields(r);
    });
  }
  return (result.rows || []).map(normalizeFields);
}

/**
 * Maps CSV/table columns to webhook field names.
 * Based on actual CSV headers from the platform:
 * Nome do Produto;Valor;Arrematador;Data;Faturamento;Segmento;Canal;
 * Nome do responsável;E-mail;Cargo;Telefone;Nome da empresa;País;
 * Documento da empresa;Tipo de produto;Urgência;Data de criação;
 * Descrição;Cidade;Estado;Data de aquisição
 */
function normalizeFields(r) {
  return {
    nome_empresa: fc(r, ["nome da empresa", "empresa"]),
    documento_empresa: fc(r, ["documento da empresa", "cnpj", "documento"]),
    faturamento: fc(r, ["faturamento"]),
    segmento: fc(r, ["segmento"]),
    pais: fc(r, ["país", "pais"]),
    email_responsavel: fc(r, ["e-mail", "email"]),
    cargo: fc(r, ["cargo"]),
    telefone: fc(r, ["telefone"]),
    tipo_produto: fc(r, ["tipo de produto"]),
    canal: fc(r, ["canal"]),
    descricao: fc(r, ["descrição", "descricao"]),
    data_criacao: fc(r, ["data de criação", "data de criacao"]),
    urgencia: fc(r, ["urgência", "urgencia"]),
    city: fc(r, ["cidade", "city"]),
    state: fc(r, ["estado", "state"]),
    valor: fc(r, ["valor"]),
    responsavel: fc(r, ["nome do responsável", "responsável", "responsavel"]),
    arrematador: fc(r, ["arrematador"]),
    data_compra: fc(r, ["data/hora de compra", "data/hora da compra", "data"]),
    data_aquisicao: fc(r, ["data de aquisição", "data de aquisicao"]),
    nome_produto: fc(r, ["nome do produto"]),
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
      source: "brokers-v7",
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
      L("WARN", `${leads.length} leads but none have valid data.`);
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
        try {
          fs.unlinkSync(C.storagePath);
        } catch {}
        await sleep(C.retryDelay);
      }
    }
  }
  return { ok: false, n: 0, method: "none" };
}

async function main() {
  L("INFO", "╔═════════════════════════════════════════════════╗");
  L("INFO", "║  Brokers Lead Exporter v7 — V4 Ferraz Piai     ║");
  L("INFO", "╚═════════════════════════════════════════════════╝");
  L(
    "INFO",
    `Email: ${C.email} | Pass: ${"*".repeat((C.password || "").length)} chars`
  );
  L(
    "INFO",
    `Loop: ${C.interval / 60000}min | Webhook: ${C.webhookUrl ? "OK" : "NO"}`
  );

  const r = await run();
  L("INFO", `=> ${r.ok ? "OK" : "FAIL"} - ${r.n} leads (${r.method})`);

  setInterval(async () => {
    L("INFO", "=================================================");
    const r = await run();
    L("INFO", `=> ${r.ok ? "OK" : "FAIL"} - ${r.n} leads (${r.method})`);
  }, C.interval);
}

main();

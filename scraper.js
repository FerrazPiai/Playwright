/**
 * Brokers MKTLab - Lead Exporter v5 (DEFINITIVE)
 *
 * Root cause: identity.mktlab.app uses custom "v4-input-field" components.
 * Playwright's fill() sets input.value directly but does NOT trigger the
 * framework's internal onChange/onInput handlers. The form sees empty fields.
 *
 * Fix: pressSequentially() types char-by-char (triggers real keyboard events)
 * + explicit React-compatible event dispatching + anti-detection measures.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const C = {
  baseUrl: "https://brokers.mktlab.app",
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
};

function L(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snap(page, name) {
  try {
    fs.mkdirSync(C.outputDir, { recursive: true });
    const p = path.join(C.outputDir, `${name}_${stamp()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    L("DBG", `Screenshot: ${p}`);
  } catch (e) { L("WARN", `Screenshot fail: ${e.message}`); }
}

function hn(page) { try { return new URL(page.url()).hostname; } catch { return ""; } }

/**
 * Smart typing for custom v4-input-field components.
 * Uses triple-clear + pressSequentially + React native setter.
 */
async function smartType(page, selector, text) {
  L("DBG", `smartType: "${selector}" -> "${text.substring(0,5)}..."`);
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 10000 });

  // Focus
  await input.click();
  await sleep(200);

  // Triple clear
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await sleep(100);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await sleep(100);

  // Type char by char
  await input.pressSequentially(text, { delay: 40 });
  await sleep(300);

  // React-compatible event dispatch
  await input.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, text);
  await sleep(200);

  // Verify
  const actual = await input.inputValue();
  L("DBG", `smartType result: "${actual}" (expected ${text.length} chars, got ${actual.length})`);
  return actual === text;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════════════════
async function doLogin(page) {
  L("INFO", "=== LOGIN START ===");

  // Check saved session
  if (fs.existsSync(C.storagePath)) {
    L("INFO", "Testing saved session...");
    try {
      await page.goto(`${C.baseUrl}/v4-company-ferraz-piai-%26-co./product-preview`, {
        waitUntil: "domcontentloaded", timeout: 20000 });
      await sleep(3000);
      if (hn(page) === "brokers.mktlab.app") {
        const t = await page.evaluate(() => document.body.innerText).catch(() => "");
        if (!t.includes("Acesse sua conta") && !t.includes("Acessar Lead Brokers")) {
          L("OK", "Session valid!"); return;
        }
      }
    } catch {}
    try { fs.unlinkSync(C.storagePath); } catch {}
  }

  // STEP 1: brokers signin page
  L("INFO", "STEP 1: brokers.mktlab.app/signin");
  await page.goto(`${C.baseUrl}/signin`, { waitUntil: "networkidle", timeout: C.timeout });
  await sleep(2000);
  L("INFO", `URL: ${page.url()} | Host: ${hn(page)}`);
  await snap(page, "01_signin");

  const accessBtn = page.locator('a:has-text("Acessar Lead Brokers")').first();
  if (await accessBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    L("INFO", "Clicking 'Acessar Lead Brokers'...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {}),
      accessBtn.click(),
    ]);
    await sleep(2000);
  }
  L("INFO", `After step 1 - Host: ${hn(page)} URL: ${page.url()}`);
  await snap(page, "02_identity");

  // STEP 2: Email
  L("INFO", "STEP 2: Filling email...");

  // Debug: log all inputs
  const inputs = await page.locator("input:visible").all();
  for (let i = 0; i < inputs.length; i++) {
    const attrs = await inputs[i].evaluate(el => ({
      type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder, className: el.className.substring(0, 60)
    }));
    L("DBG", `  input[${i}]: ${JSON.stringify(attrs)}`);
  }

  // Debug: log all buttons
  const buttons = await page.locator("button:visible").all();
  for (let i = 0; i < buttons.length; i++) {
    const info = await buttons[i].evaluate(el => ({
      type: el.type, text: el.textContent.trim().substring(0, 30),
      disabled: el.disabled, className: el.className.substring(0, 60)
    }));
    L("DBG", `  button[${i}]: ${JSON.stringify(info)}`);
  }

  await smartType(page, 'input[name="email"]', C.email);
  L("OK", `Email typed: ${C.email}`);
  await snap(page, "03_email");

  // Click Avançar
  L("INFO", "Clicking 'Avançar'...");
  const avancar = page.locator('button[type="submit"]').first();
  if (await avancar.isVisible({ timeout: 3000 }).catch(() => false)) {
    await Promise.all([
      page.waitForResponse(r => r.url().includes("identity"), { timeout: 10000 }).catch(() => {}),
      avancar.click(),
    ]);
  } else {
    await page.keyboard.press("Enter");
  }
  await sleep(3000);
  L("INFO", `After Avançar - URL: ${page.url()}`);
  await snap(page, "04_after_avancar");

  // STEP 3: Password
  L("INFO", "STEP 3: Waiting for password field...");

  const pwField = page.locator('input[type="password"], input[name="password"]').first();
  try {
    await pwField.waitFor({ state: "visible", timeout: 15000 });
    L("OK", "Password field visible.");
  } catch (e) {
    L("ERR", `Password field NOT found: ${e.message}`);
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    L("DBG", `Page text: ${bodyText.substring(0, 300)}`);
    await snap(page, "04b_no_password");
    throw new Error("Password field not found");
  }

  // Debug inputs on password page
  const inputs2 = await page.locator("input:visible").all();
  for (let i = 0; i < inputs2.length; i++) {
    const attrs = await inputs2[i].evaluate(el => ({
      type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder, value: el.value ? `[${el.value.length} chars]` : "[empty]"
    }));
    L("DBG", `  pw-page input[${i}]: ${JSON.stringify(attrs)}`);
  }

  await smartType(page, 'input[name="password"], input[type="password"]', C.password);
  L("OK", "Password typed.");
  await snap(page, "05_password");

  // Debug buttons on password page
  const btns2 = await page.locator("button:visible").all();
  for (let i = 0; i < btns2.length; i++) {
    const info = await btns2[i].evaluate(el => ({
      type: el.type, text: el.textContent.trim().substring(0, 30),
      disabled: el.disabled
    }));
    L("DBG", `  pw-page button[${i}]: ${JSON.stringify(info)}`);
  }

  // Submit: Click Entrar with navigation wait
  L("INFO", "Clicking 'Entrar'...");
  const entrar = page.locator('button[type="submit"]:has-text("Entrar")').first();
  const entrarVisible = await entrar.isVisible({ timeout: 3000 }).catch(() => false);
  L("DBG", `Entrar visible: ${entrarVisible}`);

  if (entrarVisible) {
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }),
        entrar.click(),
      ]);
      L("OK", "Navigation after Entrar detected!");
    } catch (e) {
      L("WARN", `Navigation wait failed: ${e.message}`);
      await sleep(3000);
    }
  } else {
    L("INFO", "Entrar not found, pressing Enter...");
    await pwField.press("Enter");
    await sleep(5000);
  }

  L("INFO", `After Entrar - Host: ${hn(page)} URL: ${page.url()}`);
  await snap(page, "06_after_entrar");

  // If still on identity, try JS submit
  if (hn(page) === "identity.mktlab.app") {
    L("WARN", "Still on identity! Trying JS form.requestSubmit()...");

    // Check for errors
    const errors = await page.evaluate(() => {
      return [...document.querySelectorAll('[class*="error"],[role="alert"],[class*="alert"],[class*="invalid"]')]
        .map(e => e.textContent.trim()).filter(t => t);
    });
    L("DBG", `Page errors: ${errors.length ? errors.join(" | ") : "none"}`);

    // Check form data
    const formInfo = await page.evaluate(() => {
      const form = document.querySelector("form");
      if (!form) return { found: false };
      const fd = new FormData(form);
      const data = {};
      for (const [k, v] of fd.entries()) data[k] = typeof v === "string" ? (v.length > 0 ? `[${v.length}chars]` : "[empty]") : "[file]";
      return { found: true, action: form.action, method: form.method, data };
    });
    L("DBG", `Form info: ${JSON.stringify(formInfo)}`);

    // Try requestSubmit
    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (form) form.requestSubmit();
    });
    await sleep(5000);
    L("INFO", `After JS submit - Host: ${hn(page)} URL: ${page.url()}`);
    await snap(page, "07_js_submit");

    // Try evaluate click
    if (hn(page) === "identity.mktlab.app") {
      L("WARN", "Still on identity! Trying evaluate click...");
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes("Entrar"));
        if (btn) btn.click();
      });
      await sleep(5000);
      L("INFO", `After eval click - Host: ${hn(page)}`);
      await snap(page, "08_eval_click");
    }

    // Last wait
    if (hn(page) === "identity.mktlab.app") {
      try {
        await page.waitForURL(url => new URL(url).hostname !== "identity.mktlab.app", { timeout: 15000 });
      } catch {}
    }
  }

  // Final check
  L("INFO", `FINAL - Host: ${hn(page)} URL: ${page.url()}`);
  await snap(page, "09_final");

  if (hn(page) === "identity.mktlab.app") {
    // Save full page for debug
    const html = await page.content().catch(() => "");
    fs.writeFileSync(path.join(C.outputDir, `fail_${stamp()}.html`), html);
    const txt = await page.evaluate(() => document.body.innerText).catch(() => "");
    fs.writeFileSync(path.join(C.outputDir, `fail_text_${stamp()}.txt`), txt);
    L("ERR", "=== LOGIN FAILED ===");
    L("ERR", "Causes: wrong password, 2FA, anti-bot, or framework blocking events");
    throw new Error("Login failed - stuck on identity.mktlab.app");
  }

  L("OK", "=== LOGIN SUCCESS ===");
  try { await page.context().storageState({ path: C.storagePath }); L("OK", "Session saved."); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAV + EXPORT + PROCESS (same as v4)
// ═══════════════════════════════════════════════════════════════════════════════
async function goToMeusLeads(page) {
  const urls = [
    `${C.baseUrl}/v4-company-ferraz-piai-%26-co./product-preview`,
    `${C.baseUrl}/v4-company-ferraz-piai-&-co./product-preview`,
  ];
  for (const url of urls) {
    L("INFO", `Trying: ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: C.timeout });
    await sleep(3000);
    const t = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (t.includes("Acesse sua conta")) { try { fs.unlinkSync(C.storagePath); } catch {} throw new Error("Session lost"); }
    if (t.includes("Minhas Aquisições") || t.includes("Exportar")) { L("OK", "Meus Leads OK."); return; }
    if (t.includes("Erro inesperado")) { L("WARN", "Wrong workspace, trying next URL..."); continue; }
    L("WARN", `Unknown content: ${t.substring(0,150)}`);
  }
}

async function exportData(page) {
  fs.mkdirSync(C.outputDir, { recursive: true });
  try { const tab = page.locator('button:has-text("Aquisições")').first();
    if (await tab.isVisible({ timeout: 3000 })) await tab.click(); await sleep(1000); } catch {}

  const exp = page.locator('button:has-text("Exportar"), a:has-text("Exportar")').first();
  if (await exp.isVisible({ timeout: 5000 }).catch(() => false)) {
    try {
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), exp.click()]);
      const p = path.join(C.outputDir, `leads_${stamp()}.csv`);
      await dl.saveAs(p); L("OK", `CSV: ${p}`); return { method: "csv", file: p };
    } catch (e) { L("WARN", `Download failed: ${e.message}`); }
    try {
      const [resp] = await Promise.all([
        page.waitForResponse(r => (r.headers()["content-type"]||"").match(/csv|octet/) || r.url().match(/export|download/), { timeout: 15000 }),
        exp.click()]);
      const body = await resp.body(); const p = path.join(C.outputDir, `leads_${stamp()}.csv`);
      fs.writeFileSync(p, body); L("OK", `CSV intercepted: ${p}`); return { method: "csv_net", file: p };
    } catch (e) { L("WARN", `Intercept failed: ${e.message}`); }
  }
  L("INFO", "Scraping table...");
  await page.waitForSelector("table", { timeout: 10000 }).catch(() => {});
  for (let i = 0; i < 20; i++) { const h = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(800);
    if (await page.evaluate(() => document.body.scrollHeight) === h) break; }
  const data = await page.evaluate(() => { const t = document.querySelector("table");
    if (!t) return []; const ths = [...t.querySelectorAll("thead th")].map(h=>h.textContent.trim());
    return [...t.querySelectorAll("tbody tr")].map(r => { const c = [...r.querySelectorAll("td")].map(c=>c.textContent.trim());
      const o = {}; ths.forEach((h,i) => o[h] = c[i]||""); return o; }).filter(r => Object.values(r).some(v=>v)); });
  L("INFO", `Table: ${data.length} rows`);
  return { method: "table", file: null, rows: data };
}

function proc(result) {
  if (result.file) { const raw = fs.readFileSync(result.file, "utf-8"); const sep = raw.split("\n")[0]?.includes(";") ? ";" : ",";
    const lines = raw.split("\n").filter(l=>l.trim()); if (lines.length<2) return [];
    const hdrs = csvL(lines[0],sep); return lines.slice(1).map(l => { const v = csvL(l,sep); const r = {};
      hdrs.forEach((h,i) => r[h]=v[i]||""); return norm(r); }); }
  return (result.rows||[]).map(norm);
}
function norm(r) { return { nome_empresa:fc(r,["empresa"]), cnpj:fc(r,["documento da empresa","cnpj","documento"]),
  faturamento:fc(r,["faturamento"]), segmento:fc(r,["segmento"]), responsavel:fc(r,["responsável","responsavel"]),
  telefone:fc(r,["telefone"]), email:fc(r,["e-mail","email"]), valor:fc(r,["valor"]), cargo:fc(r,["cargo"]),
  tipo:fc(r,["tipo"]), arrematador:fc(r,["arrematador"]), data_compra:fc(r,["data/hora de compra"]) }; }
function fc(r,names) { const n=s=>s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
  for(const k of Object.keys(r)) for(const nm of names) if(n(k).includes(n(nm))) return r[k]||""; return ""; }
function csvL(line,sep) { const o=[]; let c="",q=false; for(const ch of line) { if(ch==='"')q=!q;
  else if(ch===sep&&!q){o.push(c.replace(/^"|"$/g,"").trim());c="";}else c+=ch;}
  o.push(c.replace(/^"|"$/g,"").trim()); return o; }

async function webhook(leads) { if(!C.webhookUrl||!leads.length)return;
  L("INFO",`Webhook: ${leads.length} leads...`);
  const r=await fetch(C.webhookUrl,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({timestamp:new Date().toISOString(),source:"brokers-v5",total:leads.length,leads})});
  if(!r.ok)throw new Error(`Webhook ${r.status}`); L("OK","Webhook OK."); }

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function scrape() {
  if (!C.email||!C.password) throw new Error("Credentials required.");
  let browser;
  try {
    const opts = { viewport:{width:1440,height:900}, acceptDownloads:true,
      userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" };
    if (fs.existsSync(C.storagePath)) opts.storageState = C.storagePath;
    browser = await chromium.launch({ headless:C.headless,
      args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled"] });
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(() => { Object.defineProperty(navigator,"webdriver",{get:()=>undefined}); });
    const page = await ctx.newPage(); page.setDefaultTimeout(C.timeout);
    page.on("console", m => L("BROWSER", `${m.type()}: ${m.text()}`));
    page.on("pageerror", e => L("BROWSER_ERR", e.message));

    await doLogin(page);
    await goToMeusLeads(page);
    const result = await exportData(page);
    const leads = proc(result);
    L("INFO", `${leads.length} leads (${result.method}).`);
    if (leads.length > 0) { const jp = path.join(C.outputDir,`leads_${stamp()}.json`);
      fs.writeFileSync(jp,JSON.stringify(leads,null,2)); L("OK",`JSON: ${jp}`); }
    const valid = leads.filter(l => l.nome_empresa||l.telefone||l.email);
    if (valid.length > 0) await webhook(valid);
    else L("WARN", `${leads.length} leads but none valid.`);
    await browser.close();
    return { ok:true, n:leads.length, method:result.method };
  } catch (err) { L("ERR", err.message);
    if (browser) { try { const p=browser.contexts()[0]?.pages()[0];
      if(p) await p.screenshot({path:path.join(C.outputDir,`error_${stamp()}.png`),fullPage:true}); } catch {}
      await browser.close(); } throw err; }
}

async function run() {
  for (let i=1; i<=C.retries; i++) { L("INFO",`=== ATTEMPT ${i}/${C.retries} ===`);
    try { return await scrape(); } catch(e) { L("ERR",`Attempt ${i}: ${e.message}`);
      if(i<C.retries){try{fs.unlinkSync(C.storagePath);}catch{}await sleep(C.retryDelay);} } }
  return { ok:false, n:0, method:"none" }; }

async function main() {
  L("INFO","╔═════════════════════════════════════════════════╗");
  L("INFO","║  Brokers Lead Exporter v5 — V4 Ferraz Piai     ║");
  L("INFO","╚═════════════════════════════════════════════════╝");
  L("INFO",`Email: ${C.email} | Pass: ${"*".repeat((C.password||"").length)} chars`);
  L("INFO",`Loop: ${C.interval/60000}min | Webhook: ${C.webhookUrl?"OK":"NO"}`);
  const r = await run();
  L("INFO",`=> ${r.ok?"OK":"FAIL"} - ${r.n} leads (${r.method})`);
  setInterval(async()=>{ L("INFO","=================================================");
    const r=await run(); L("INFO",`=> ${r.ok?"OK":"FAIL"} - ${r.n} leads (${r.method})`);
  }, C.interval);
}

main();

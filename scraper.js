/**
 * Brokers MKTLab - Lead Exporter v9 (Pure HTTP — No Browser)
 *
 * Complete rewrite: replaces Playwright with direct HTTP API calls.
 * No Chromium, no React state bugs, no anti-bot detection.
 *
 * Flow:
 * 1. GET brokers.mktlab.app/signin → extract OAuth redirect URL
 * 2. GET identity.mktlab.app/signin?codeChallenge=... → get session cookies
 * 3. POST v1.identity.mktlab.app/auth/signin → authenticate
 * 4. Follow redirect chain → get brokers session
 * 5. GET product-preview page → find export endpoint
 * 6. Download CSV → parse → send to webhook
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const C = {
  baseUrl: process.env.BROKER_URL || "https://brokers.mktlab.app",
  email: process.env.BROKER_EMAIL,
  password: process.env.BROKER_PASSWORD,
  webhookUrl:
    process.env.WEBHOOK_URL ||
    "https://ferrazpiai-n8n-editor.uyk8ty.easypanel.host/webhook/dcad05e6-2430-40f8-ab75-3201f6bf931d",
  outputDir: process.env.OUTPUT_DIR || "/app/exports",
  retries: parseInt(process.env.RETRY_ATTEMPTS) || 3,
  retryDelay: parseInt(process.env.RETRY_DELAY_MS) || 5000,
  interval: parseInt(process.env.CRON_INTERVAL_MS) || 3600000,
  workspace: "v4-company-ferraz-piai-%26-co.",
  leadsUrl:
    "https://brokers.mktlab.app/v4-company-ferraz-piai-%26-co./product-preview",
};

function L(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

const stamp = () =>
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════════
// PKCE helpers
// ═══════════════════════════════════════════════════════════════════════════════
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cookie jar — simple manual cookie management across domains
// ═══════════════════════════════════════════════════════════════════════════════
class CookieJar {
  constructor() {
    this.cookies = {}; // domain -> { name: value }
  }

  addFromHeaders(responseHeaders, url) {
    const domain = new URL(url).hostname;
    const setCookies = responseHeaders.getSetCookie
      ? responseHeaders.getSetCookie()
      : [];
    if (!this.cookies[domain]) this.cookies[domain] = {};
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const [name, ...rest] = pair.split("=");
      if (name && rest.length) {
        this.cookies[domain][name.trim()] = rest.join("=").trim();
      }
    }
  }

  getForUrl(url) {
    const domain = new URL(url).hostname;
    const all = {};
    // Include cookies for this domain and parent domains
    for (const [d, cookies] of Object.entries(this.cookies)) {
      if (domain === d || domain.endsWith("." + d)) {
        Object.assign(all, cookies);
      }
    }
    return Object.entries(all)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  dump() {
    return JSON.stringify(this.cookies, null, 2);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP helpers
// ═══════════════════════════════════════════════════════════════════════════════
async function httpGet(url, jar, opts = {}) {
  const headers = { ...opts.headers };
  const cookie = jar.getForUrl(url);
  if (cookie) headers["Cookie"] = cookie;
  headers["User-Agent"] =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
  headers["Accept"] =
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

  const resp = await fetch(url, {
    method: "GET",
    headers,
    redirect: opts.noRedirect ? "manual" : "follow",
  });
  jar.addFromHeaders(resp.headers, url);
  return resp;
}

async function httpPost(url, body, jar, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  const cookie = jar.getForUrl(url);
  if (cookie) headers["Cookie"] = cookie;
  headers["User-Agent"] =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: opts.noRedirect ? "manual" : "follow",
  });
  jar.addFromHeaders(resp.headers, url);
  return resp;
}

// Follow redirects manually to capture cookies at each hop
async function followRedirects(url, jar, maxRedirects = 10) {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const resp = await httpGet(currentUrl, jar, { noRedirect: true });
    jar.addFromHeaders(resp.headers, currentUrl);
    const status = resp.status;
    if (status >= 300 && status < 400) {
      const location = resp.headers.get("location");
      if (!location) break;
      currentUrl = location.startsWith("http")
        ? location
        : new URL(location, currentUrl).href;
      L("DBG", `Redirect ${status} → ${currentUrl.substring(0, 100)}`);
      continue;
    }
    return { resp, url: currentUrl };
  }
  return { resp: await httpGet(currentUrl, jar), url: currentUrl };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN — Pure HTTP, no browser
// ═══════════════════════════════════════════════════════════════════════════════
async function doLogin(jar) {
  L("INFO", "=== LOGIN START (HTTP) ===");

  // Generate PKCE pair upfront — needed for both identity URL and signin POST
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  jar._codeVerifier = codeVerifier;
  L("DBG", `PKCE codeChallenge: ${codeChallenge}`);

  const appId = "1169ee93-8f36-4b60-a1b3-abba6c31bba0";
  const redirectTo = `${C.baseUrl}/auth/token`;

  // STEP 1: Visit brokers signin to extract the OAuth redirect URL
  L("INFO", "STEP 1: GET brokers.mktlab.app/signin...");
  let identityUrl = null;

  const signinResp = await httpGet(`${C.baseUrl}/signin`, jar);
  const signinStatus = signinResp.status;
  const signinHtml = await signinResp.text();
  L("DBG", `Signin page: ${signinStatus} (${signinHtml.length} bytes)`);

  if (signinStatus === 429) {
    L("WARN", "Rate limited (429). Using constructed PKCE URL...");
  }

  // Try to find identity URL in the page HTML
  const hrefMatch = signinHtml.match(
    /href=["'](https?:\/\/identity\.mktlab\.app[^"']+)["']/
  );
  if (hrefMatch) {
    identityUrl = hrefMatch[1].replace(/&amp;/g, "&");
    L("OK", `Found identity URL in href: ${identityUrl.substring(0, 100)}`);
    // Extract codeChallenge from URL if present (use theirs instead of ours)
    const ccMatch = identityUrl.match(/codeChallenge=([^&]+)/);
    if (ccMatch) {
      L("DBG", `Using server codeChallenge: ${ccMatch[1]}`);
    }
  }

  // If no href found, try the no-redirect approach
  if (!identityUrl) {
    const redirectResp = await httpGet(`${C.baseUrl}/signin`, jar, {
      noRedirect: true,
    });
    const loc = redirectResp.headers.get("location");
    if (loc && loc.includes("identity.mktlab.app")) {
      identityUrl = loc;
      L("OK", `Found redirect: ${identityUrl.substring(0, 100)}`);
    }
  }

  // Fallback: construct manually with our PKCE challenge
  if (!identityUrl) {
    identityUrl = `https://identity.mktlab.app/signin?codeChallenge=${codeChallenge}&codeChallengeMethod=S256&redirectTo=${encodeURIComponent(redirectTo)}&appId=${appId}`;
    L("INFO", "Using self-generated PKCE URL");
  }

  // Extract the codeChallenge being used (from URL or our generated one)
  const usedChallenge =
    new URL(identityUrl).searchParams.get("codeChallenge") || codeChallenge;

  // STEP 2: Visit identity.mktlab.app to establish session cookies
  L("INFO", "STEP 2: GET identity.mktlab.app/signin...");
  const identityResp = await httpGet(identityUrl, jar);
  const identityHtml = await identityResp.text();
  L("DBG", `Identity page: ${identityResp.status} (${identityHtml.length} bytes)`);

  // Try to extract CSRF token or hidden fields from the identity page
  const csrfMatch = identityHtml.match(
    /name=["']?csrf[^"']*["']?\s+value=["']([^"']+)["']/i
  );
  if (csrfMatch) L("DBG", `CSRF token found: ${csrfMatch[1].substring(0, 20)}...`);

  // Also look for any appId embedded in the page
  const appIdMatch = identityHtml.match(
    /appId["']?\s*[:=]\s*["']([^"']+)["']/
  );
  if (appIdMatch) L("DBG", `AppId from page: ${appIdMatch[1]}`);

  // STEP 3: POST to signin API with credentials + PKCE fields
  L("INFO", "STEP 3: POST v1.identity.mktlab.app/auth/signin...");
  const signinBody = {
    email: C.email,
    password: C.password,
    codeChallenge: usedChallenge,
    codeChallengeMethod: "S256",
    redirectTo,
    appId,
  };
  L("DBG", `POST body keys: ${Object.keys(signinBody).join(", ")}`);

  const signinApiResp = await httpPost(
    "https://v1.identity.mktlab.app/auth/signin",
    signinBody,
    jar,
    { noRedirect: true }
  );

  const signinStatus = signinApiResp.status;
  let signinBody;
  try {
    signinBody = await signinApiResp.text();
  } catch {
    signinBody = "";
  }
  L("INFO", `Signin API: ${signinStatus}`);
  L("DBG", `Response: ${signinBody.substring(0, 300)}`);

  if (signinStatus >= 400) {
    L("ERR", `Signin failed: ${signinStatus} - ${signinBody}`);
    throw new Error(`Signin API returned ${signinStatus}: ${signinBody}`);
  }

  // Parse response - might contain tokens, redirect URL, or auth code
  let signinData;
  try {
    signinData = JSON.parse(signinBody);
  } catch {
    signinData = {};
  }

  // Check if response contains a redirect URL or auth code
  const redirectUrl =
    signinApiResp.headers.get("location") ||
    signinData.redirectUrl ||
    signinData.redirect ||
    signinData.callbackUrl;

  if (redirectUrl) {
    L("INFO", `Following post-login redirect: ${redirectUrl.substring(0, 80)}`);
    const { resp: finalResp, url: finalUrl } = await followRedirects(
      redirectUrl,
      jar
    );
    L("OK", `Final URL: ${finalUrl.substring(0, 80)}`);
  }

  // Try to get session to verify login worked
  const sessionResp = await httpGet(
    "https://identity.mktlab.app/api/auth/session",
    jar
  );
  const sessionBody = await sessionResp.text();
  L("DBG", `Session check: ${sessionResp.status} - ${sessionBody.substring(0, 200)}`);

  let sessionData;
  try {
    sessionData = JSON.parse(sessionBody);
  } catch {
    sessionData = {};
  }

  if (sessionData.user) {
    L("OK", `Logged in as: ${sessionData.user.email || sessionData.user.name || "OK"}`);
  } else {
    L("WARN", "Session check didn't return user, but proceeding...");
  }

  // STEP 4: Try to access brokers with current cookies
  L("INFO", "STEP 4: Verifying brokers access...");
  const brokersResp = await httpGet(C.leadsUrl, jar, { noRedirect: true });
  const brokersStatus = brokersResp.status;
  L("DBG", `Brokers leads page: ${brokersStatus}`);

  if (brokersStatus >= 300 && brokersStatus < 400) {
    const loc = brokersResp.headers.get("location");
    L("DBG", `Brokers redirects to: ${loc?.substring(0, 80)}`);
    // Follow the redirect chain
    const { resp: finalResp, url: finalUrl } = await followRedirects(
      loc.startsWith("http") ? loc : new URL(loc, C.leadsUrl).href,
      jar
    );
    L("DBG", `After redirects: ${finalUrl.substring(0, 80)} (${finalResp.status})`);

    // Try again after following redirects
    const retryResp = await httpGet(C.leadsUrl, jar);
    const retryStatus = retryResp.status;
    L("DBG", `Retry brokers: ${retryStatus}`);
    if (retryStatus !== 200) {
      throw new Error(`Cannot access leads page: ${retryStatus}`);
    }
  } else if (brokersStatus !== 200) {
    throw new Error(`Cannot access leads page: ${brokersStatus}`);
  }

  L("OK", "=== LOGIN SUCCESS ===");
  L("DBG", `Cookies: ${jar.dump().substring(0, 500)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT DATA
// ═══════════════════════════════════════════════════════════════════════════════
async function exportData(jar) {
  L("INFO", "=== EXPORT START ===");
  fs.mkdirSync(C.outputDir, { recursive: true });

  // Get the leads page HTML to find the export endpoint
  const pageResp = await httpGet(C.leadsUrl, jar);
  const pageHtml = await pageResp.text();
  L("DBG", `Leads page: ${pageResp.status} (${pageHtml.length} bytes)`);

  // Try to find export URL in the HTML/JS
  const exportPatterns = [
    /["'](\/api\/[^"']*export[^"']*?)["']/i,
    /["'](\/[^"']*download[^"']*?)["']/i,
    /["'](https?:\/\/[^"']*export[^"']*?)["']/i,
    /["'](\/[^"']*csv[^"']*?)["']/i,
    /fetch\(["']([^"']+)["']/g,
  ];

  let exportUrl = null;
  for (const pattern of exportPatterns) {
    const match = pageHtml.match(pattern);
    if (match && match[1]) {
      exportUrl = match[1];
      L("DBG", `Found potential export URL: ${exportUrl}`);
      break;
    }
  }

  // Try common export endpoints
  const exportEndpoints = [
    `${C.baseUrl}/${C.workspace}/product-preview/export`,
    `${C.baseUrl}/api/${C.workspace}/product-preview/export`,
    `${C.baseUrl}/api/export/product-preview`,
    `${C.baseUrl}/api/v1/${C.workspace}/products/export`,
    `${C.baseUrl}/api/acquisitions/export`,
  ];

  if (exportUrl) {
    const full = exportUrl.startsWith("http")
      ? exportUrl
      : `${C.baseUrl}${exportUrl}`;
    exportEndpoints.unshift(full);
  }

  // Try each endpoint
  for (const endpoint of exportEndpoints) {
    L("DBG", `Trying export: ${endpoint}`);
    try {
      const resp = await httpGet(endpoint, jar);
      const ct = resp.headers.get("content-type") || "";
      if (
        ct.includes("csv") ||
        ct.includes("octet-stream") ||
        ct.includes("text/plain")
      ) {
        const csv = await resp.text();
        if (csv.includes(";") && csv.split("\n").length > 1) {
          const p = path.join(C.outputDir, `leads_${stamp()}.csv`);
          fs.writeFileSync(p, csv);
          L("OK", `CSV downloaded: ${p} (${csv.length} bytes)`);
          return { method: "csv_api", file: p };
        }
      }
      // Check if response is actually CSV even with wrong content-type
      const text = await resp.text().catch(() => "");
      if (text.includes(";") && text.includes("Nome") && text.split("\n").length > 2) {
        const p = path.join(C.outputDir, `leads_${stamp()}.csv`);
        fs.writeFileSync(p, text);
        L("OK", `CSV found at ${endpoint}: ${p}`);
        return { method: "csv_api", file: p };
      }
    } catch (e) {
      L("DBG", `  Failed: ${e.message}`);
    }
  }

  // Fallback: scrape leads from the HTML page itself
  L("INFO", "No CSV endpoint found. Parsing HTML table...");
  const tableMatch = pageHtml.match(/<table[\s\S]*?<\/table>/i);
  if (tableMatch) {
    const rows = parseHtmlTable(tableMatch[0]);
    L("INFO", `Parsed ${rows.length} rows from HTML table`);
    return { method: "html_table", file: null, rows };
  }

  // Try to find data in JSON embedded in the page (Next.js/React hydration data)
  const jsonMatches = pageHtml.match(
    /<script[^>]*>[\s\S]*?__NEXT_DATA__[\s\S]*?({[\s\S]*?})\s*<\/script>/
  );
  if (jsonMatches) {
    try {
      const data = JSON.parse(jsonMatches[1]);
      L("DBG", "Found __NEXT_DATA__, extracting leads...");
      const leads = extractLeadsFromJson(data);
      if (leads.length > 0) {
        return { method: "json_hydration", file: null, rows: leads };
      }
    } catch {}
  }

  // Look for any JSON data in script tags
  const scriptDataMatch = pageHtml.match(
    /(?:window\.__data__|window\.__INITIAL_STATE__|__remixContext)\s*=\s*({[\s\S]*?});?\s*<\/script>/
  );
  if (scriptDataMatch) {
    try {
      const data = JSON.parse(scriptDataMatch[1]);
      L("DBG", "Found embedded JSON data");
      const leads = extractLeadsFromJson(data);
      if (leads.length > 0) {
        return { method: "json_embedded", file: null, rows: leads };
      }
    } catch {}
  }

  L("WARN", "No export method succeeded. Saving page HTML for debug...");
  fs.writeFileSync(
    path.join(C.outputDir, `page_${stamp()}.html`),
    pageHtml
  );

  throw new Error("Could not export leads data");
}

function parseHtmlTable(tableHtml) {
  const rows = [];
  const headerMatch = tableHtml.match(/<thead[\s\S]*?<\/thead>/i);
  const bodyMatch = tableHtml.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (!headerMatch || !bodyMatch) return rows;

  const headers = [];
  const thMatches = headerMatch[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi);
  for (const m of thMatches) {
    headers.push(m[1].replace(/<[^>]+>/g, "").trim());
  }

  const trMatches = bodyMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const tr of trMatches) {
    const tdMatches = tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    const row = {};
    let i = 0;
    for (const td of tdMatches) {
      if (i < headers.length) {
        row[headers[i]] = td[1].replace(/<[^>]+>/g, "").trim();
      }
      i++;
    }
    if (Object.values(row).some((v) => v)) rows.push(row);
  }
  return rows;
}

function extractLeadsFromJson(data, depth = 0) {
  if (depth > 10) return [];
  if (Array.isArray(data)) {
    if (
      data.length > 0 &&
      typeof data[0] === "object" &&
      data[0] !== null &&
      ("empresa" in data[0] ||
        "nome_empresa" in data[0] ||
        "Nome da empresa" in data[0] ||
        "telefone" in data[0])
    ) {
      return data;
    }
    for (const item of data) {
      const result = extractLeadsFromJson(item, depth + 1);
      if (result.length > 0) return result;
    }
  } else if (typeof data === "object" && data !== null) {
    for (const val of Object.values(data)) {
      const result = extractLeadsFromJson(val, depth + 1);
      if (result.length > 0) return result;
    }
  }
  return [];
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

function normalizeFields(r) {
  return {
    nome_empresa: fc(r, ["nome da empresa", "empresa"]),
    documento_empresa: fc(r, ["documento da empresa", "cnpj"]),
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
    city: fc(r, ["cidade"]),
    state: fc(r, ["estado"]),
    valor: fc(r, ["valor"]),
    responsavel: fc(r, ["nome do responsável", "responsável"]),
    arrematador: fc(r, ["arrematador"]),
    data_compra: fc(r, ["data/hora de compra", "data"]),
    data_aquisicao: fc(r, ["data de aquisição"]),
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
      source: "brokers-v9-http",
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
    throw new Error("BROKER_EMAIL and BROKER_PASSWORD required.");

  const jar = new CookieJar();

  // Login via HTTP
  await doLogin(jar);

  // Export data
  const result = await exportData(jar);
  const leads = processResults(result);
  L("INFO", `Processed ${leads.length} leads (${result.method}).`);

  if (leads.length > 0) {
    const jp = path.join(C.outputDir, `leads_${stamp()}.json`);
    fs.writeFileSync(jp, JSON.stringify(leads, null, 2));
    L("OK", `JSON: ${jp}`);
  }

  // Send to webhook
  const valid = leads.filter(
    (l) => l.nome_empresa || l.telefone || l.email_responsavel
  );
  if (valid.length > 0) {
    await webhook(valid);
  } else {
    L("WARN", `${leads.length} leads but none valid.`);
  }

  return { ok: true, n: leads.length, method: result.method };
}

async function run() {
  for (let i = 1; i <= C.retries; i++) {
    L("INFO", `=== ATTEMPT ${i}/${C.retries} ===`);
    try {
      return await scrape();
    } catch (e) {
      L("ERR", `Attempt ${i}: ${e.message}`);
      if (e.stack) L("DBG", e.stack.split("\n").slice(1, 3).join(" | "));
      if (i < C.retries) await sleep(C.retryDelay);
    }
  }
  return { ok: false, n: 0, method: "none" };
}

async function main() {
  L("INFO", "╔═════════════════════════════════════════════════╗");
  L("INFO", "║  Brokers Lead Exporter v9 — Pure HTTP          ║");
  L("INFO", "║  V4 Ferraz Piai & Co.                          ║");
  L("INFO", "╚═════════════════════════════════════════════════╝");
  L("INFO", `Email: ${C.email}`);
  L("INFO", `Webhook: ${C.webhookUrl ? "OK" : "NO"}`);
  L("INFO", `Loop: ${C.interval / 60000}min`);

  const r = await run();
  L("INFO", `=> ${r.ok ? "OK" : "FAIL"} - ${r.n} leads (${r.method})`);

  setInterval(async () => {
    L("INFO", "=== CYCLE ===");
    const r = await run();
    L("INFO", `=> ${r.ok ? "OK" : "FAIL"} - ${r.n} leads (${r.method})`);
  }, C.interval);
}

main();

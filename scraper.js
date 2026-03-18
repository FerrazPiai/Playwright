/**
 * Brokers MKTLab - Lead Exporter v2
 * 
 * Fixes:
 * - Workspace selection ("V4 Company Ferraz Piai & Co")
 * - Robust login detection with multiple selector strategies
 * - Fallback: scrape table DOM if CSV export fails
 * - Built-in 1-hour cron loop
 * - Debug screenshots at every step
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
  cronIntervalMs: parseInt(process.env.CRON_INTERVAL_MS) || 3600000, // 1 hora
  workspaceName: process.env.WORKSPACE_NAME || "V4 Company Ferraz Piai",
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

// ─── Debug Screenshot Helper ──────────────────────────────────────────────────
async function debugScreenshot(page, stepName) {
  try {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    const filePath = path.join(CONFIG.outputDir, `debug_${stepName}_${getTimestamp()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    log.debug(`Screenshot: ${filePath}`);
  } catch (_) {}
}

// ─── Step 1: Login ────────────────────────────────────────────────────────────
async function doLogin(page) {
  log.info("Acessando plataforma...");
  await page.goto(CONFIG.baseUrl, { waitUntil: "networkidle", timeout: CONFIG.timeout });
  await page.waitForTimeout(3000);

  await debugScreenshot(page, "01_initial_page");

  // Detectar login com múltiplos seletores
  const loginSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="mail"]',
    'input[placeholder*="Mail"]',
    'input[placeholder*="E-mail"]',
    'input[placeholder*="usuário"]',
    'input[placeholder*="usuario"]',
    'input[placeholder*="login"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
  ];

  let emailInput = null;
  for (const selector of loginSelectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 2000 })) {
        emailInput = el;
        log.info(`Campo de email encontrado: ${selector}`);
        break;
      }
    } catch (_) {}
  }

  if (!emailInput) {
    // Tenta achar qualquer input visível que pareça ser email
    const allInputs = page.locator('input:visible');
    const count = await allInputs.count();
    log.debug(`Inputs visíveis na página: ${count}`);
    
    if (count >= 2) {
      // Assume: primeiro input = email, segundo = senha
      emailInput = allInputs.nth(0);
      log.info("Usando primeiro input visível como campo de email.");
    }
  }

  if (emailInput) {
    log.info("Realizando login...");
    await emailInput.fill(CONFIG.email);
    await page.waitForTimeout(500);

    // Busca campo de senha
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[placeholder*="enha"]',
      'input[placeholder*="assword"]',
      'input[autocomplete="current-password"]',
    ];

    let passwordInput = null;
    for (const selector of passwordSelectors) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 })) {
          passwordInput = el;
          break;
        }
      } catch (_) {}
    }

    if (!passwordInput) {
      // Fallback: segundo input visível
      const allInputs = page.locator('input:visible');
      if (await allInputs.count() >= 2) {
        passwordInput = allInputs.nth(1);
      }
    }

    if (passwordInput) {
      await passwordInput.fill(CONFIG.password);
      await page.waitForTimeout(500);
    }

    await debugScreenshot(page, "02_login_filled");

    // Busca botão de submit
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'button:has-text("Acessar")',
      'button:has-text("Enviar")',
      'input[type="submit"]',
      'button:visible >> nth=0',
    ];

    for (const selector of submitSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          log.info(`Login submetido via: ${selector}`);
          break;
        }
      } catch (_) {}
    }

    // Espera navegação pós-login
    await page.waitForLoadState("networkidle", { timeout: CONFIG.timeout }).catch(() => {});
    await page.waitForTimeout(3000);
    log.success("Login realizado.");
  } else {
    log.info("Nenhum campo de login encontrado — possivelmente já autenticado.");
  }

  await debugScreenshot(page, "03_after_login");
}

// ─── Step 2: Selecionar Workspace ─────────────────────────────────────────────
async function selectWorkspace(page) {
  log.info(`Selecionando workspace: "${CONFIG.workspaceName}"...`);
  await page.waitForTimeout(2000);

  // O dropdown do workspace fica no canto superior esquerdo
  // Baseado nas screenshots: é um seletor com o nome da empresa atual
  
  // Estratégia 1: Clicar no seletor de workspace (o componente com ícone de seta)
  const workspaceSelectors = [
    // O elemento parece ser um botão/div com o nome do workspace e um ícone de dropdown
    '[class*="workspace"] [class*="select"]',
    '[class*="company"] [class*="select"]',
    'button:has-text("v4company")',
    'div:has-text("v4company") >> nth=0',
    // Seletor genérico para o dropdown no sidebar
    'nav button:has([class*="chevron"])',
    'aside button:has([class*="chevron"])',
    // Tentar pelo texto visível
    ':text("v4company com") >> xpath=./ancestor::button | ./ancestor::div[@role="button"]',
  ];

  let dropdownOpened = false;

  // Primeiro tenta: clicar em qualquer elemento que contenha o texto do workspace atual
  // e que pareça ser um seletor/dropdown
  try {
    // Procura o componente de seleção de workspace no sidebar
    // Baseado no screenshot: aparece como "V v4company com" com uma setinha
    const sidebarSelector = page.locator('aside, nav, [class*="sidebar"]').first();
    
    // Tenta encontrar um botão ou div clicável que contenha texto de workspace
    const clickables = page.locator('button, [role="button"], [class*="select"], [class*="dropdown"]');
    const count = await clickables.count();
    
    for (let i = 0; i < count; i++) {
      const el = clickables.nth(i);
      try {
        const text = await el.textContent({ timeout: 1000 });
        if (text && (text.includes("v4company") || text.includes("V4 Company") || text.includes("Ferraz"))) {
          log.debug(`Encontrei seletor de workspace: "${text.trim().substring(0, 50)}"`);
          await el.click();
          dropdownOpened = true;
          await page.waitForTimeout(1500);
          break;
        }
      } catch (_) {}
    }
  } catch (e) {
    log.debug(`Estratégia 1 falhou: ${e.message}`);
  }

  // Estratégia 2: Clicar diretamente no texto do workspace visível
  if (!dropdownOpened) {
    try {
      const wsText = page.getByText(/v4company|V4 Company/i).first();
      if (await wsText.isVisible({ timeout: 3000 })) {
        await wsText.click();
        dropdownOpened = true;
        await page.waitForTimeout(1500);
        log.debug("Dropdown aberto via texto direto.");
      }
    } catch (_) {}
  }

  // Estratégia 3: Buscar por select nativo ou custom dropdown
  if (!dropdownOpened) {
    try {
      const selects = page.locator('select');
      const selectCount = await selects.count();
      for (let i = 0; i < selectCount; i++) {
        const options = await selects.nth(i).locator('option').allTextContents();
        if (options.some(o => o.includes("Ferraz") || o.includes("V4 Company"))) {
          await selects.nth(i).selectOption({ label: options.find(o => o.includes("Ferraz") || o.includes("V4 Company")) });
          log.success("Workspace selecionado via <select> nativo.");
          await page.waitForTimeout(3000);
          await page.waitForLoadState("networkidle");
          await debugScreenshot(page, "04_workspace_selected");
          return;
        }
      }
    } catch (_) {}
  }

  await debugScreenshot(page, "04_dropdown_opened");

  // Agora seleciona "V4 Company Ferraz Piai & ..."
  if (dropdownOpened) {
    try {
      // Procura o item do dropdown com o texto correto
      const targetSelectors = [
        `text=V4 Company Ferraz Piai`,
        `text=Ferraz Piai`,
        `:text("V4 Company Ferraz")`,
        `li:has-text("Ferraz Piai")`,
        `div:has-text("Ferraz Piai")`,
        `a:has-text("Ferraz Piai")`,
        `[role="option"]:has-text("Ferraz")`,
        `[role="menuitem"]:has-text("Ferraz")`,
      ];

      for (const sel of targetSelectors) {
        try {
          const item = page.locator(sel).first();
          if (await item.isVisible({ timeout: 2000 })) {
            await item.click();
            log.success(`Workspace "${CONFIG.workspaceName}" selecionado!`);
            await page.waitForTimeout(3000);
            await page.waitForLoadState("networkidle").catch(() => {});
            await debugScreenshot(page, "05_workspace_selected");
            return;
          }
        } catch (_) {}
      }

      log.warn("Dropdown aberto mas não encontrou o workspace alvo. Tentando por posição...");
      
      // Fallback: clica no primeiro item do dropdown (que nos screenshots é "V4 Company Ferraz Piai & ...")
      const listItems = page.locator('[role="option"], [role="menuitem"], li, [class*="item"], [class*="option"]');
      const itemCount = await listItems.count();
      
      for (let i = 0; i < itemCount; i++) {
        const text = await listItems.nth(i).textContent({ timeout: 1000 }).catch(() => "");
        if (text.includes("Ferraz") || text.includes("V4 Company Ferraz")) {
          await listItems.nth(i).click();
          log.success("Workspace selecionado por scan de lista.");
          await page.waitForTimeout(3000);
          await page.waitForLoadState("networkidle").catch(() => {});
          await debugScreenshot(page, "05_workspace_selected");
          return;
        }
      }

    } catch (e) {
      log.warn(`Erro ao selecionar workspace: ${e.message}`);
    }
  }

  // Último fallback: navegar diretamente pela URL com o workspace correto
  log.warn("Não conseguiu selecionar workspace via UI. Tentando navegar pela URL direta...");
  try {
    await page.goto(`${CONFIG.baseUrl}/v4-company-ferraz-piai-%26-co.`, {
      waitUntil: "networkidle",
      timeout: CONFIG.timeout,
    });
    await page.waitForTimeout(3000);
    await debugScreenshot(page, "05_workspace_url_direct");
    log.info("Navegou direto para URL do workspace.");
  } catch (e) {
    log.error(`Falha ao navegar para workspace: ${e.message}`);
  }
}

// ─── Step 3: Navegar para Meus Leads ──────────────────────────────────────────
async function navigateToMeusLeads(page) {
  log.info("Navegando para Meus Leads...");

  // Tenta clicar no link do menu lateral
  const menuSelectors = [
    'a:has-text("Meus Leads")',
    'text=Meus Leads',
    '[href*="product-preview"]',
    'nav a:has-text("Leads")',
    'aside a:has-text("Leads")',
  ];

  for (const sel of menuSelectors) {
    try {
      const link = page.locator(sel).first();
      if (await link.isVisible({ timeout: 3000 })) {
        await link.click();
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(3000);
        log.success("Página Meus Leads carregada via menu.");
        await debugScreenshot(page, "06_meus_leads");
        return;
      }
    } catch (_) {}
  }

  // Fallback: URL direta
  log.info("Menu não encontrado, tentando URL direta...");
  await page.goto(`${CONFIG.baseUrl}/v4-company-ferraz-piai-%26-co./product-preview`, {
    waitUntil: "networkidle",
    timeout: CONFIG.timeout,
  });
  await page.waitForTimeout(3000);
  await debugScreenshot(page, "06_meus_leads_direct");
  log.success("Página Meus Leads carregada via URL direta.");
}

// ─── Step 4: Exportar CSV ─────────────────────────────────────────────────────
async function exportCSV(page) {
  log.info("Tentando exportar CSV...");
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  // ── Estratégia A: Botão Exportar com download event ──────────────────────
  const exportSelectors = [
    'button:has-text("Exportar")',
    'a:has-text("Exportar")',
    ':text("Exportar")',
    'button:has-text("Export")',
    '[class*="export"]',
    // O botão na screenshot parece ter um ícone de download
    'button:has([class*="download"])',
    'a:has([class*="download"])',
  ];

  for (const sel of exportSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 5000 })) {
        log.info(`Botão Exportar encontrado: ${sel}`);
        await debugScreenshot(page, "07_before_export");

        try {
          // Tenta capturar download
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 30000 }),
            btn.click(),
          ]);

          const downloadPath = path.join(CONFIG.outputDir, `leads_${getTimestamp()}.csv`);
          await download.saveAs(downloadPath);
          log.success(`CSV baixado: ${downloadPath}`);
          return { method: "csv_download", filePath: downloadPath };
        } catch (downloadErr) {
          log.warn(`Download event não disparou: ${downloadErr.message}`);
          
          // Talvez o botão tenha aberto algo — esperar e tentar de novo
          await page.waitForTimeout(3000);

          // Verificar se abriu um blob/URL de download
          const pages = page.context().pages();
          if (pages.length > 1) {
            const newPage = pages[pages.length - 1];
            const url = newPage.url();
            if (url.includes("blob:") || url.includes(".csv")) {
              const content = await newPage.content();
              const csvPath = path.join(CONFIG.outputDir, `leads_${getTimestamp()}.csv`);
              fs.writeFileSync(csvPath, content, "utf-8");
              await newPage.close();
              log.success(`CSV capturado de nova aba: ${csvPath}`);
              return { method: "csv_newtab", filePath: csvPath };
            }
          }
        }
        break; // Botão encontrado mas download falhou — vai pro fallback
      }
    } catch (_) {}
  }

  // ── Estratégia B: Interceptar requests de rede ───────────────────────────
  log.info("Tentando interceptar request de exportação via rede...");
  try {
    let csvResponse = null;

    page.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (
        url.includes("export") ||
        url.includes("csv") ||
        url.includes("download") ||
        contentType.includes("csv") ||
        contentType.includes("octet-stream")
      ) {
        csvResponse = response;
      }
    });

    // Tenta clicar no exportar de novo
    const btn = page.locator('button:has-text("Exportar"), a:has-text("Exportar"), :text("Exportar")').first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(10000);

      if (csvResponse) {
        const body = await csvResponse.body();
        const csvPath = path.join(CONFIG.outputDir, `leads_${getTimestamp()}.csv`);
        fs.writeFileSync(csvPath, body);
        log.success(`CSV capturado via interceptação de rede: ${csvPath}`);
        return { method: "csv_intercept", filePath: csvPath };
      }
    }
  } catch (e) {
    log.debug(`Interceptação de rede falhou: ${e.message}`);
  }

  // ── Estratégia C (Fallback): Scrape direto da tabela HTML ────────────────
  log.warn("CSV export falhou. Extraindo dados direto da tabela HTML...");
  return await scrapeTableDOM(page);
}

// ─── Fallback: Scrape Table DOM ───────────────────────────────────────────────
async function scrapeTableDOM(page) {
  await debugScreenshot(page, "08_table_scrape_start");

  // Espera a tabela carregar
  try {
    await page.waitForSelector("table, [class*='table'], [role='table'], [class*='list']", {
      timeout: 15000,
    });
  } catch (_) {
    log.warn("Tabela não encontrada na página.");
  }

  // Extrai dados da tabela
  const leads = await page.evaluate(() => {
    const results = [];

    // Estratégia 1: Tabela HTML padrão
    const table = document.querySelector("table");
    if (table) {
      const rows = table.querySelectorAll("tbody tr, tr");
      const headers = [];

      // Pega headers
      const headerRow = table.querySelector("thead tr, tr:first-child");
      if (headerRow) {
        headerRow.querySelectorAll("th, td").forEach((th) => {
          headers.push(th.textContent.trim().toLowerCase());
        });
      }

      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) return; // Pula rows inválidas

        const rowData = {};
        cells.forEach((cell, idx) => {
          if (headers[idx]) {
            rowData[headers[idx]] = cell.textContent.trim();
          } else {
            rowData[`col_${idx}`] = cell.textContent.trim();
          }
        });

        if (Object.keys(rowData).length > 0) {
          results.push(rowData);
        }
      });
    }

    // Estratégia 2: Cards ou lista customizada (caso não tenha table)
    if (results.length === 0) {
      // Procura por cards/items que contenham dados de leads
      const cards = document.querySelectorAll(
        '[class*="card"], [class*="item"], [class*="row"], [class*="lead"]'
      );
      cards.forEach((card) => {
        const text = card.textContent || "";
        if (text.includes("Lead") || text.includes("R$")) {
          results.push({ raw_text: text.trim().substring(0, 500) });
        }
      });
    }

    return results;
  });

  log.info(`Extraídos ${leads.length} registros da tabela HTML.`);

  if (leads.length === 0) {
    log.error("Nenhum dado encontrado na tabela.");

    // Último recurso: pegar TODO o conteúdo da página para debug
    await debugScreenshot(page, "09_no_data_found");
    const pageText = await page.evaluate(() => document.body.innerText);
    const debugPath = path.join(CONFIG.outputDir, `page_text_${getTimestamp()}.txt`);
    fs.writeFileSync(debugPath, pageText, "utf-8");
    log.info(`Texto da página salvo para debug: ${debugPath}`);

    return { method: "table_scrape", leads: [], filePath: null };
  }

  return { method: "table_scrape", leads, filePath: null };
}

// ─── Step 5: Processar dados ──────────────────────────────────────────────────
function processData(exportResult) {
  let leads = [];

  if (exportResult.filePath) {
    // CSV foi baixado — parsear
    const rawCsv = fs.readFileSync(exportResult.filePath, "utf-8");
    
    // Detectar delimitador
    const firstLine = rawCsv.split("\n")[0] || "";
    const delimiter = firstLine.includes(";") ? ";" : ",";

    const lines = rawCsv.split("\n").filter((l) => l.trim());
    if (lines.length < 2) {
      log.warn("CSV vazio ou com apenas header.");
      return [];
    }

    const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
    log.debug(`Headers CSV: ${headers.join(" | ")}`);

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(delimiter).map((v) => v.trim().replace(/^"|"$/g, ""));
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] || "";
      });

      leads.push({
        nome_empresa: findCol(row, ["empresa", "nome da empresa", "company", "nome_empresa"]),
        cnpj: findCol(row, ["documento da empresa", "cnpj", "documento", "cpf_cnpj", "document"]),
        faturamento: findCol(row, ["faturamento", "revenue", "billing"]),
        segmento: findCol(row, ["segmento", "segment"]),
        responsavel: findCol(row, ["responsável", "responsavel", "nome", "contact"]),
        telefone: findCol(row, ["telefone", "phone", "tel"]),
        email: findCol(row, ["e-mail", "email"]),
        valor: findCol(row, ["valor", "value", "price"]),
        data_compra: findCol(row, ["data/hora de compra", "data_compra", "data", "date"]),
      });
    }
  } else if (exportResult.leads) {
    // Dados vieram do scrape da tabela
    leads = exportResult.leads.map((row) => ({
      nome_empresa: findCol(row, ["empresa", "nome da empresa", "company"]),
      cnpj: findCol(row, ["documento da empresa", "cnpj", "documento"]),
      faturamento: findCol(row, ["faturamento", "revenue"]),
      segmento: findCol(row, ["segmento", "segment"]),
      responsavel: findCol(row, ["responsável", "responsavel"]),
      telefone: findCol(row, ["telefone", "phone"]),
      email: findCol(row, ["e-mail", "email"]),
      valor: findCol(row, ["valor", "value"]),
      data_compra: findCol(row, ["data/hora de compra", "data_compra", "data"]),
      raw_text: row.raw_text || undefined,
    }));
  }

  return leads;
}

function findCol(row, possibleNames) {
  const normalize = (str) =>
    str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  for (const key of Object.keys(row)) {
    const nk = normalize(key);
    for (const name of possibleNames) {
      if (nk === normalize(name) || nk.includes(normalize(name))) {
        return row[key] || "";
      }
    }
  }
  return "";
}

// ─── Step 6: Enviar para webhook ──────────────────────────────────────────────
async function sendToWebhook(leads) {
  if (!CONFIG.webhookUrl) {
    log.info("Webhook não configurado — pulando envio.");
    return;
  }

  log.info(`Enviando ${leads.length} leads para webhook...`);

  const response = await fetch(CONFIG.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      source: "brokers-lead-exporter-v2",
      total: leads.length,
      leads,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Webhook retornou ${response.status}: ${text}`);
  }

  log.success("Webhook disparado com sucesso.");
}

// ─── Main Scrape Flow ─────────────────────────────────────────────────────────
async function scrape() {
  if (!CONFIG.email || !CONFIG.password) {
    throw new Error("BROKER_EMAIL e BROKER_PASSWORD são obrigatórios.");
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
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.timeout);

    // Step 1: Login
    await doLogin(page);

    // Step 2: Selecionar workspace correto
    await selectWorkspace(page);

    // Step 3: Navegar para Meus Leads
    await navigateToMeusLeads(page);

    // Verificar se a página carregou corretamente (sem "Erro inesperado")
    const pageText = await page.evaluate(() => document.body.innerText);
    if (pageText.includes("Erro inesperado")) {
      log.error("Página ainda mostra 'Erro inesperado' — workspace pode não ter sido selecionado.");
      await debugScreenshot(page, "ERROR_inesperado");
      throw new Error("Página com erro inesperado após seleção de workspace");
    }

    // Step 4: Exportar
    const exportResult = await exportCSV(page);

    // Step 5: Processar
    const leads = processData(exportResult);
    log.info(`${leads.length} leads processados (método: ${exportResult.method}).`);

    // Salvar JSON
    const jsonPath = path.join(CONFIG.outputDir, `leads_${getTimestamp()}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(leads, null, 2), "utf-8");
    log.success(`JSON salvo: ${jsonPath}`);

    // Step 6: Webhook
    await sendToWebhook(leads);

    // Validação
    const warnings = [];
    const noEmpresa = leads.filter((l) => !l.nome_empresa).length;
    const noCnpj = leads.filter((l) => !l.cnpj).length;
    if (noEmpresa > 0) warnings.push(`${noEmpresa} leads sem empresa`);
    if (noCnpj > 0) warnings.push(`${noCnpj} leads sem CNPJ`);
    if (leads.length === 0) warnings.push("Nenhum lead encontrado!");
    warnings.forEach((w) => log.warn(w));

    await browser.close();

    return { success: true, totalLeads: leads.length, method: exportResult.method, warnings };
  } catch (err) {
    log.error(`Erro: ${err.message}`);
    if (browser) {
      try {
        const pages = browser.contexts()[0]?.pages();
        if (pages?.length > 0) {
          const errorPath = path.join(CONFIG.outputDir, `error_${getTimestamp()}.png`);
          await pages[0].screenshot({ path: errorPath, fullPage: true });
          log.info(`Screenshot de erro: ${errorPath}`);
        }
      } catch (_) {}
      await browser.close();
    }
    throw err;
  }
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────
async function scrapeWithRetry() {
  for (let attempt = 1; attempt <= CONFIG.retryAttempts; attempt++) {
    log.info(`=== Tentativa ${attempt}/${CONFIG.retryAttempts} ===`);
    try {
      return await scrape();
    } catch (err) {
      log.error(`Tentativa ${attempt} falhou: ${err.message}`);
      if (attempt < CONFIG.retryAttempts) {
        log.info(`Aguardando ${CONFIG.retryDelayMs / 1000}s...`);
        await sleep(CONFIG.retryDelayMs);
      }
    }
  }
  log.error("Todas as tentativas falharam neste ciclo.");
  return { success: false, totalLeads: 0, method: "none", warnings: ["Todas as tentativas falharam"] };
}

// ─── Cron Loop (1h) ──────────────────────────────────────────────────────────
async function main() {
  log.info("╔══════════════════════════════════════════════════════╗");
  log.info("║  Brokers Lead Exporter v2 — V4 Ferraz Piai & Co.   ║");
  log.info("╚══════════════════════════════════════════════════════╝");
  log.info(`Intervalo: ${CONFIG.cronIntervalMs / 60000} minutos`);
  log.info(`Workspace: ${CONFIG.workspaceName}`);
  log.info(`Webhook: ${CONFIG.webhookUrl ? "configurado" : "NÃO configurado"}`);
  log.info(`Debug: ${CONFIG.debug ? "ativado" : "desativado"}`);
  log.info("");

  // Primeira execução imediata
  const result = await scrapeWithRetry();
  log.info(`Resultado: ${result.success ? "SUCESSO" : "FALHA"} — ${result.totalLeads} leads (${result.method})`);

  // Loop a cada 1 hora
  log.info(`\nPróxima execução em ${CONFIG.cronIntervalMs / 60000} minutos...\n`);

  setInterval(async () => {
    log.info("═══════════════════════════════════════════════════════");
    log.info("Iniciando nova execução agendada...");
    log.info("═══════════════════════════════════════════════════════");
    const r = await scrapeWithRetry();
    log.info(`Resultado: ${r.success ? "SUCESSO" : "FALHA"} — ${r.totalLeads} leads (${r.method})`);
    log.info(`\nPróxima execução em ${CONFIG.cronIntervalMs / 60000} minutos...\n`);
  }, CONFIG.cronIntervalMs);
}

main();

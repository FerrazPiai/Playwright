# Brokers Lead Exporter

Automação de extração de leads do **Brokers MKTLab** (`brokers.mktlab.app`) via Playwright headless browser.

> Desenvolvido por **V4 Ferraz Piai & Co.**

---

## O que faz

1. Faz login automático na plataforma
2. Navega até "Meus Leads"
3. Clica no botão "Exportar" e baixa o CSV
4. Filtra os campos: **Nome da Empresa**, **CNPJ**, **Faturamento**, **Segmento**
5. Salva JSON processado + envia para webhook n8n (opcional)

---

## Campos extraídos

| Campo          | Fonte no CSV            | Observação                         |
| -------------- | ----------------------- | ---------------------------------- |
| nome_empresa   | Empresa                 | Sempre preenchido                  |
| cnpj           | Documento da empresa    | Pode estar vazio                   |
| faturamento    | Faturamento             | Ex: "De 71 mil à 100 mil"         |
| segmento       | Segmento                | Ex: "Serviço", "Outro"            |

---

## Deploy no Easypanel

### Opção A: Via GitHub (recomendado)

1. Suba este repo para o GitHub (privado)
2. No Easypanel, crie um novo **App** > **GitHub**
3. Conecte o repositório
4. Easypanel detecta o `Dockerfile` automaticamente
5. Em **Environment Variables**, adicione:
   - `BROKER_EMAIL` = seu email
   - `BROKER_PASSWORD` = sua senha
   - `WEBHOOK_URL` = URL do webhook n8n
6. Em **Advanced** > **Restart Policy**: selecione `no` (execução única)
7. Para agendar execução periódica, use um dos métodos abaixo

### Opção B: Via Docker Image

```bash
docker build -t brokers-scraper .
docker run --env-file .env -v ./exports:/app/exports brokers-scraper
```

---

## Agendamento (Cron)

### Via n8n (recomendado)
Crie um workflow n8n:
1. **Cron Trigger** → a cada 6h (ou o intervalo desejado)
2. **HTTP Request** → `POST` para a API do Easypanel para restart do container
3. **Webhook** (nó separado) → recebe os leads do scraper

### Via entrypoint com loop
No `docker-compose.yml`, descomente a linha `entrypoint` para rodar a cada 6h:
```yaml
entrypoint: ["sh", "-c", "while true; do node scraper.js; sleep 21600; done"]
```

### Via cron do Easypanel
Configure um **Cron Job** no Easypanel apontando para o container.

---

## Variáveis de Ambiente

| Variável          | Obrigatória | Descrição                                |
| ----------------- | ----------- | ---------------------------------------- |
| `BROKER_EMAIL`    | ✅          | Email de login na plataforma             |
| `BROKER_PASSWORD` | ✅          | Senha de login                           |
| `BROKER_URL`      | Não         | URL base (default: brokers.mktlab.app)   |
| `WEBHOOK_URL`     | Não         | Webhook n8n para receber os dados        |
| `HEADLESS`        | Não         | `true` (default) ou `false` para debug   |
| `TIMEOUT_MS`      | Não         | Timeout de operações (default: 60000)    |
| `RETRY_ATTEMPTS`  | Não         | Tentativas em caso de erro (default: 3)  |

---

## Estrutura de saída

```
/app/exports/
├── leads_2026-03-18T10-30-00.csv    # CSV original da plataforma
├── leads_2026-03-18T10-30-00.json   # JSON processado
└── error_2026-03-18T10-30-00.png    # Screenshot em caso de erro
```

### Formato do JSON

```json
[
  {
    "nome_empresa": "Clif",
    "cnpj": "",
    "faturamento": "De 401 mil à 1 milhão",
    "segmento": "Serviço",
    "responsavel": "Sabrina",
    "telefone": "+5521999535825",
    "email": "sapresman@gmail.com",
    "valor": "R$ 676,00",
    "data_compra": "18/03/2026 - 09:15 AM"
  }
]
```

---

## Troubleshooting

- **Erro de login**: Verifique credenciais. A plataforma pode ter mudado o layout — ajuste os seletores em `scraper.js`
- **Download não inicia**: O botão "Exportar" pode ter mudado de texto/posição. Verifique o seletor
- **Timeout**: Aumente `TIMEOUT_MS`. Conexões lentas podem precisar de 90000+
- **Screenshots de erro**: Sempre salvas em `/app/exports/error_*.png` para diagnóstico

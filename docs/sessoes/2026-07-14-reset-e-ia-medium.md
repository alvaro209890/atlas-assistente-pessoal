# Atlas — Sessão 2026-07-14 (Reset total + IA raciocínio médio)

## 📋 Resumo

Pull do GitHub, análise do repositório, migração da IA para **raciocínio médio**,
**reset total do banco** (preservando o WhatsApp admin), rebuild e restart de todos
os backends, testes e documentação.

---

## 🔄 Pull

- Branch: `main` (alvaro209890/atlas-assistente-pessoal)
- Estado: **Already up to date** (HEAD em `091f71f`)

---

## 🤖 IA — DeepSeek V4 Flash com raciocínio MÉDIO

Modelo continua fixo em `deepseek-v4-flash` com `thinking.type=enabled` e sem
`temperature`. O `reasoning_effort` foi trocado de **`high` → `medium`** em todos
os pontos (código real da chamada + metadados de auditoria + defaults de banco +
testes + docs):

| Arquivo | Ponto |
|---|---|
| `packages/integrations/src/deepseek.ts` | corpo da chamada (triagem WhatsApp) |
| `apps/api/src/ai.ts` | corpo da chamada (chat do Segundo Cérebro) |
| `apps/api/src/config.ts` | tipo + valor de `reasoningEffort` |
| `apps/api/src/routes/chat.ts` | `INSERT ai_runs` (auditoria) |
| `apps/api/src/routes/platform.ts` | `UPDATE user_settings` (PATCH /api/config) |
| `apps/worker/src/repository.ts` | `INSERT ai_runs` (auditoria da triagem) |
| `apps/api/src/ai.test.ts`, `apps/api/src/config.test.ts` | testes atualizados |
| `README.md` | "raciocínio médio" / `reasoning_effort=medium` |
| **`packages/database/migrations/0011_reasoning_effort_medium.sql`** | novo |

### Migration 0011
- `ALTER COLUMN reasoning_effort SET DEFAULT 'medium'` em `user_settings` e `ai_runs`.
- `UPDATE user_settings SET reasoning_effort='medium' WHERE reasoning_effort='high'`.
- Verificado: novo usuário registrado recebe `reasoning_effort=medium` automaticamente.

> Observação: o valor efetivo enviado ao DeepSeek é **fixado no código** (não lido
> do banco). As colunas de banco são apenas auditoria/metadados, agora coerentes.

---

## 🗄️ Reset total do banco

Backup antes: `scratchpad/atlas-db-backup-20260714-113653.sql` (316K).

Estratégia: `TRUNCATE ... RESTART IDENTITY CASCADE` em **todas** as tabelas de
`public`, **exceto**:
- `platform_whatsapp_connection` — o **WhatsApp admin** (número-mãe / singleton `mother`)
- `platform_whatsapp_auth_records` — credenciais Baileys do número-mãe
- `schema_migrations` — controle de migrações

Também limpou a fila do pg-boss: `TRUNCATE pgboss.job, pgboss.job_common` +
`DELETE FROM pgboss.schedule` (os 6 schedules são re-registrados pelo worker no
boot — `apps/worker/src/handlers.ts:588-594`).

### Estado final
| Tabela | Linhas |
|---|---|
| `users` | 0 |
| `sessions` | 0 |
| `platform_whatsapp_connection` | 1 (preservado) |
| `pgboss.schedule` | 6 (re-registrado no boot) |

> No momento do reset, o número-mãe já estava `disconnected` com 0 auth records
> (precisará de novo pareamento por QR em `/admin` de qualquer forma).

---

## 🏗️ Migrations

`0001`–`0010` já aplicadas; **`0011_reasoning_effort_medium.sql` aplicada nesta sessão.**

---

## 🚀 Backends (systemd --user) — rebuild + restart

`npm run build` (packages + apps) e `systemctl --user restart`:

| Serviço | Porta | Status |
|---|---|---|
| atlas-api | 3100 | ✅ active (health OK) |
| atlas-worker | — | ✅ active (sem erros no boot) |
| atlas-web | 3200 | ✅ active |

`dist` confirmado com `reasoning_effort: "medium"`.

---

## ✅ Validação

- `npm run typecheck` — OK
- `npm test` — API 24 ok / worker 55 ok / web 27 ok (testes de IA ao vivo pulados, opt-in)
- `GET /health` → `{"status":"ok"}`
- `POST /api/auth/register` → 201, `user_settings.reasoning_effort=medium`
- Usuário de teste removido ao final (banco permanece zerado)

---

## ⚠️ PENDÊNCIA CRÍTICA — chave DeepSeek inválida

O `DEEPSEEK_API_KEY` no `.env` retorna **HTTP 401** na API oficial:
`Authentication Fails, Your api key: ****311b is invalid`.

A IA está corretamente configurada (modelo + raciocínio médio), mas **não
responderá** até a chave ser substituída por uma válida no `.env` e o
`atlas-api` + `atlas-worker` serem reiniciados. Ação do operador:

```bash
# editar DEEPSEEK_API_KEY em ~/Documentos/atlas-assistente-pessoal/.env
systemctl --user restart atlas-api atlas-worker
```

---

## 🔗 Links
- Frontend: https://atlas.cursar.space/
- Admin (WhatsApp mãe): https://atlas.cursar.space/admin
- API local: http://127.0.0.1:3100/health

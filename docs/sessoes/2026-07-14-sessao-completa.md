# Atlas — Sessão 2026-07-14 (Completa)

## 📋 Resumo

Sessão intensiva de correções e deploy do Atlas após pull do GitHub. Múltiplos bugs críticos encontrados e corrigidos.

---

## 🔄 Pull Inicial

- **Branch:** main (alvaro209890/atlas-assistente-pessoal)
- **Range:** `cc9b5b8` → `c66f530`
- **Arquivos:** 27 arquivos, +1020/-74 linhas
- **Destaques:** Nova rota admin, frontend admin, migração `0009_platform_whatsapp.sql`, guia WhatsApp+Trello

---

## 🐛 Bugs Corrigidos (6 commits)

### 1. `4a29ad7` — PATCH /api/config 500 (JSON array → jsonb)
- **Problema:** `reminderTimes` (array JS) serializado como array PostgreSQL `{08:00,18:00}` em vez de JSON `["08:00","18:00"]`
- **Solução:** `JSON.stringify()` nos arrays antes de passar pra colunas `jsonb`
- **Arquivo:** `apps/api/src/routes/platform.ts`

### 2. `94fd3fb` — POST /api/onboarding/complete 400 (max selectedChatIds)
- **Problema:** 853 chats monitorados ultrapassavam limite `.max(500)` do Zod
- **Solução:** Aumentado para `.max(2000)`
- **Arquivo:** `apps/api/src/routes/platform.ts`

### 3. `0063918` — Chats sem nome (contacts.upsert nunca tratado)
- **Problema:** 793/853 chats sem `display_name` porque o evento `contacts.upsert` do Baileys não era tratado
- **Solução:** Handlers para `contacts.upsert` + `contacts.update` no pacote de integração, novo método `upsertContacts` no worker
- **Arquivos:** `packages/integrations/src/whatsapp.ts`, `apps/worker/src/repository.ts`, `apps/worker/src/index.ts`

### 4. `bb9ecda` — Sessão WhatsApp quebrada (coluna inexistente)
- **Problema:** `upsertContacts` usava `updated_at` na tabela `whatsapp_conversation_catalog` (coluna não existe)
- **Solução:** `updated_at` → `last_seen_at`
- **Arquivo:** `apps/worker/src/repository.ts`

### 5. `0e9caf0` — "Não é tarefa" 500 + senderJid vazio
- **Problema 1:** Coluna `source_message_ids` referenciada no código mas não existia na tabela `canonical_tasks`
- **Solução 1:** Migration `0010_source_message_ids.sql`
- **Problema 2:** Mensagens de sistema do WhatsApp com `senderJid` vazio causando ZodError
- **Solução 2:** Filtro `if (!senderJid) continue` antes de emitir evento
- **Arquivos:** `packages/database/migrations/0010_source_message_ids.sql`, `packages/integrations/src/whatsapp.ts`

---

## 🗄️ Wipes de Banco (2x)

### Primeiro wipe (manter WhatsApp)
- Deletado usuário `alvaro@gmail.com`, preservados `whatsapp_connections`, `trello_connections`, `trello_board_configs`, `platform_whatsapp_connection`
- Estratégia: backup → drop FKs → NULL user_id → delete user → restore

### Segundo wipe (limpo total)
- DELETE FROM users (CASCADE)
- Backups salvos em `_restore_wc`, `_restore_tc`, `_restore_tbc`
- WhatsApp mãe (`platform_whatsapp_connection`) preservado
- Após re-registro: WhatsApp reconectou automático (credenciais Baileys válidas), Trello restaurado do backup

### Comando de wipe seletivo
```sql
BEGIN;
-- Salvar
CREATE TABLE _restore_wc AS SELECT * FROM whatsapp_connections;
CREATE TABLE _restore_tc AS SELECT * FROM trello_connections;
CREATE TABLE _restore_tbc AS SELECT * FROM trello_board_configs;
-- Deletar
DELETE FROM users;
-- Restaurar após re-registro
UPDATE _restore_wc SET user_id = '<novo_user_id>';
UPDATE _restore_tc SET user_id = '<novo_user_id>';
UPDATE _restore_tbc SET user_id = '<novo_user_id>';
INSERT INTO whatsapp_connections SELECT * FROM _restore_wc;
INSERT INTO trello_connections SELECT * FROM _restore_tc;
INSERT INTO trello_board_configs SELECT * FROM _restore_tbc;
COMMIT;
```

---

## 🏗️ Migrations Aplicadas

| # | Nome | Status |
|---|------|--------|
| 0001 | core.sql | ✓ |
| 0002 | integrations.sql | ✓ |
| 0003 | runtime_records.sql | ✓ |
| 0004 | whatsapp_runtime.sql | ✓ |
| 0005 | default_automations.sql | ✓ |
| 0006 | atlas_assistant_v2.sql | ✓ |
| 0007 | single_whatsapp_connection.sql | ✓ |
| 0008 | brain_source_semantics.sql | ✓ |
| 0009 | platform_whatsapp.sql | ✓ |
| **0010** | **source_message_ids.sql** | ✓ (nova) |

---

## 🚀 Serviços (systemd --user)

| Serviço | Porta | Status |
|---------|-------|--------|
| atlas-api | 3100 | ✅ active |
| atlas-worker | — | ✅ active |
| atlas-web | 3200 | ✅ active |

---

## 🔗 Links

- Frontend: https://atlas.cursar.space/
- Admin: https://atlas.cursar.space/admin
- API local: http://127.0.0.1:3100
- Cloudflare Tunnel: `0a219227`

---

## ⚠️ Pitfalls Registrados

1. **Arrays JS → coluna jsonb:** driver pg converte para array PostgreSQL `{a,b}` em vez de JSON `["a","b"]`. Usar `JSON.stringify()`.
2. **max selectedChatIds:** 500 era pouco para 853+ chats. Aumentado para 2000.
3. **contacts.upsert:** Baileys envia nomes separado dos chats. Sem handler, chats ficam sem `display_name`.
4. **whatsapp_conversation_catalog:** não tem coluna `updated_at`, usar `last_seen_at`.
5. **canonical_tasks.source_message_ids:** coluna referenciada no código precisa existir.
6. **senderJid vazio:** filtrar `if (!senderJid) continue` antes de processar mensagem.

---

## 📊 Commits no GitHub

```
0e9caf0 fix: adiciona coluna source_message_ids + filtra senderJid vazio
bb9ecda fix: updated_at -> last_seen_at no upsertContacts
0063918 feat: contacts.upsert/update handler para nomes dos chats + fix max selectedChatIds
94fd3fb fix: aumenta max selectedChatIds de 500 para 2000
4a29ad7 fix: PATCH /api/config — JSON.stringify arrays antes de jsonb + docs da sessão
```

# Atlas — Atualização 2026-07-14

## Pull do GitHub
- **Branch:** main (alvaro209890/atlas-assistente-pessoal)
- **Range:** `cc9b5b8` → `c66f530`
- **Arquivos:** 27 arquivos, +1020/-74 linhas
- **Destaques:**
  - Nova rota admin (`apps/api/src/routes/admin.ts`)
  - Novo frontend admin (`apps/web/src/admin/AdminApp.tsx`)
  - Migração `0009_platform_whatsapp.sql`
  - Melhorias no worker (WhatsApp events, Trello, learning safety)
  - Guia WhatsApp+Trello (`docs/whatsapp-trello-guide.md`)

## Correção de Bug Crítico

### Problema
`PATCH /api/config` retornava **500 Internal Server Error** ao salvar `reminderTimes` durante o onboarding.

### Causa
O driver `pg` (Node.js) converte arrays JavaScript para formato array PostgreSQL (`{08:00,18:00}`) em vez de JSON (`["08:00","18:00"]`). A coluna `reminder_times` é do tipo `jsonb`, e o PostgreSQL rejeitava o formato array como JSON inválido.

**Erro:** `invalid input syntax for type json` — `Expected ":", but found ","` — JSON data: `{"08:00",...}`

### Solução
No arquivo `apps/api/src/routes/platform.ts`, linha 301, usar `JSON.stringify()` antes de passar arrays/objetos para colunas `jsonb`:

```typescript
// ANTES (quebrado):
input.reminderTimes ?? null, input.featureFlags ?? null

// DEPOIS (corrigido):
input.reminderTimes ? JSON.stringify(input.reminderTimes) : null,
input.featureFlags ? JSON.stringify(input.featureFlags) : null
```

Também adicionado cast explícito `::jsonb` na query SQL para segurança extra.

### Pitfall documentado
Atualizada a skill `atlas` com este pitfall para evitar recorrência.

## Wipe de Banco de Dados

### Limpeza seletiva (mantendo WhatsApp/Trello conectados)

**Tabelas PRESERVADAS:**
- `users` (1) — conta de usuário
- `whatsapp_connections` (1) — conexão WhatsApp ativa
- `platform_whatsapp_connection` (1) — nova plataforma WhatsApp
- `whatsapp_auth_records` (6503) — histórico de autenticação
- `monitored_chats` (893) — chats monitorados
- `whatsapp_conversation_catalog` (893) — catálogo de conversas
- `trello_connections` (1) — conexão Trello
- `trello_board_configs` (1) — configuração de boards

**Tabelas ZERADAS (conteúdo de usuário):**
- `brain_nodes`, `brain_edges`, `brain_node_revisions`, `brain_node_sources`
- `brain_chat_threads`, `brain_chat_messages`
- `canonical_tasks`, `task_events`, `task_trello_links`
- `trello_cards`, `trello_card_node_map`, `trello_sync_cursors`
- `reminders`, `reminder_occurrences`, `commitments`
- `ai_runs`, `ai_usage_events`
- `assistant_learnings`, `assistant_learning_evidence`, `assistant_action_outcomes`
- `action_proposals`, `feedback`
- `message_batches`, `message_batch_items`
- `whatsapp_messages`, `platform_whatsapp_messages`
- `job_attempts`, `idempotency_keys`
- `sessions` (1 deletado)
- `automations` (2 deletados — serão recriados no primeiro login)
- `notification_outbox`, `event_outbox` (limpos)

**Resetados para defaults:**
- `user_settings`: timezone, locale, ai_model, reminder_times, feature_flags
- `user_profiles`: professional_area, goals, metadata

## Deploy

### Serviços (todos systemd --user)
| Serviço | Porta | Status |
|---------|-------|--------|
| atlas-api | 3100 | ✅ active |
| atlas-worker | — | ✅ active |
| atlas-web | 3200 | ✅ active |

### Links
- Frontend: https://atlas.cursar.space/
- Admin: https://atlas.cursar.space/admin
- API local: http://127.0.0.1:3100

### Comandos úteis para wipe futuro
```bash
# Zerar conteúdo mantendo WhatsApp/Trello:
sudo -u postgres psql -d atlas << 'SQL'
BEGIN;
TRUNCATE TABLE brain_nodes, brain_edges, brain_node_revisions, brain_node_sources,
  brain_chat_threads, brain_chat_messages, canonical_tasks, task_events,
  task_trello_links, trello_cards, trello_card_node_map, trello_sync_cursors,
  reminders, reminder_occurrences, commitments, ai_runs, ai_usage_events,
  assistant_learnings, assistant_learning_evidence, assistant_action_outcomes,
  action_proposals, feedback, message_batches, message_batch_items,
  whatsapp_messages, platform_whatsapp_messages, job_attempts, idempotency_keys
CASCADE;
DELETE FROM sessions; DELETE FROM automations;
DELETE FROM notification_outbox; DELETE FROM event_outbox;
UPDATE user_settings SET timezone='America/Sao_Paulo',locale='pt-BR',
  reminder_times='["08:00","18:00"]'::jsonb, feature_flags='{}'::jsonb, updated_at=now();
UPDATE user_profiles SET professional_area=NULL, goals='{}', metadata='{}'::jsonb, updated_at=now();
COMMIT;
SQL
```

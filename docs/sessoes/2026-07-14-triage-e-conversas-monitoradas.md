# Atlas — Sessão 2026-07-14 (Fix do triage + UI de Conversas monitoradas)

## 📋 Resumo

Diagnóstico de "mensagens do WhatsApp não sendo processadas", correção da causa
raiz (schema do triage) e nova view visual no app para **ativar/desativar o
monitoramento de conversas** — que não existia fora do onboarding.

---

## 🔎 Multimídia (áudio/imagem) — verificado e descartado

Testei a API do DeepSeek empiricamente: **não suporta visão** (rejeita
`image_url`: "unknown variant") **nem tem endpoint de transcrição** (`/audio/...`
→ 404). Conta só tem `deepseek-v4-flash` e `deepseek-v4-pro`, ambos texto. Por
decisão do Álvaro (não usar API de outra IA), o recurso de áudio/imagem foi
descartado por ora.

---

## 🐛 Causa raiz: mensagens não viravam tarefas

O banco mostrava 851 chats monitorados (todos enabled), mas só 1 mensagem
persistida e 0 tarefas. O `ai_runs` revelou o triage **falhando na validação**:

```
DeepSeek JSON failed schema validation: path ["reply","objective"] → expected "none"
```

Quando o modelo decide que **não precisa responder** (`needed:false`), o schema
exigia `objective:"none"`, mas o modelo às vezes devolvia `needed:false` com um
`objective` do enum → o batch inteiro falhava (e com ele tarefas, compromissos e
memórias). O `brain_chat` (site) funcionava; só o `whatsapp_triage` quebrava.

### Correção (`packages/shared/src/schemas.ts`)
`aiReplySchema` agora tem um `z.preprocess` que **normaliza** qualquer `reply`
malformado para a forma canônica "sem resposta", em vez de rejeitar:
- `needed:false` com campos residuais → vira no-reply limpo.
- `needed:true` sem `draft`/`tone`/`objective` válido → vira no-reply (a resposta
  é só sugestão mostrada ao dono; nunca enviada sozinha, então não pode derrubar
  todo o triage).
- `needed:true` bem formado → preservado.
3 testes novos em `packages/shared/tests/schema.test.ts`.

> Observação: mensagens **novas** passam a ser processadas. O 1 batch histórico
> que já falhou não é reprocessado retroativamente.

---

## 🖥️ Nova view: Conversas monitoradas (o que o Álvaro não achava)

Antes só dava para escolher chats monitorados no onboarding. Agora há uma **view
dedicada e visual** no menu principal (entre Inbox e Cérebro).

### Backend (`apps/api/src/routes/integrations.ts`)
- `GET /api/whatsapp/chats` e `PATCH /api/whatsapp/chats/:id` já existiam.
- **Novo** `POST /api/whatsapp/chats/monitor-all { enabled }` — liga/desliga todas
  de uma vez (essencial com centenas de chats).

### Frontend
- `apps/web/src/api.ts`: `updateChat` e `setAllChatsMonitored` (real + preview).
- `types.ts`: `NavId` ganha `'chats'`.
- `navigation.tsx`: item "Conversas" (ícone MessageCircle) + `viewMeta`.
- `apps/web/src/workspace/MonitoredChatsView.tsx` (novo): banner de privacidade,
  painel de números (conversas/monitoradas/diretas/grupos), busca, filtros
  (Todas/Monitoradas/Diretas/Grupos), botões "Monitorar todas / Desativar todas"
  e lista com avatar, badge e **toggle** por conversa (update otimista + reverte
  em erro).
- `ViewContent.tsx` + `Workspace.tsx`: fiação das props via `api`.
- `styles.css`: estilos `.chats-monitor*` (responsivos).

---

## ✅ Validação
- `npm run typecheck` — OK
- `npm test` — todos passam (incl. 3 novos testes de normalização do reply)
- `npm run build` — OK
- Serviços reiniciados sem erros; endpoint `monitor-all` protegido (401 sem sessão).
- **Verificação visual ao vivo** (preview `?preview=demo`): a view "Conversas
  monitoradas" renderiza e o botão "Monitorar todas" ligou as 4 conversas (contador
  1 → 4) com toggles funcionando.

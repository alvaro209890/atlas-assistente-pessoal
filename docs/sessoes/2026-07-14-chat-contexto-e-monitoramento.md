# Atlas — Sessão 2026-07-14 (Chat persistente, contexto dos 2 lados, chats limpos, layout)

## 📋 Resumo

Quatro frentes pedidas pelo Álvaro: (1) chat lateral persistente e mais completo,
(2) a IA passar a ver as mensagens que o próprio Álvaro envia (contexto dos dois
lados), (3) corte da parte inferior do front em zoom/escala > 100%, (4) a lista de
conversas do Álvaro estava poluída de `@lid` (participantes de grupo) em vez de só
grupos + diretos.

> Nota: multimídia (áudio/imagem) ficou de fora — o DeepSeek é só texto e o Álvaro
> não quer usar API de outra IA.

---

## 1) Chat lateral (IA) persistente e mais completo

Antes o painel guardava as mensagens só em memória → recarregar a página perdia
tudo (embora o backend já persista em `brain_chat_threads`/`brain_chat_messages`).

- `apps/web/src/api.ts`: `listChatThreads()` e `getChatMessages(threadId)` (real +
  preview). O histórico persistido usa `citations`, mapeado para `sources`.
- `apps/web/src/components/AIAssistant.tsx`: no mount, retoma a conversa mais
  recente (thread + mensagens). Botão **"+" (nova conversa)** no cabeçalho para
  começar um thread limpo.

## 2) IA com contexto dos DOIS lados da conversa

As mensagens `fromMe` (que o Álvaro envia) eram descartadas em dois pontos:

- **Worker** (`apps/worker/src/index.ts`): `fromMe` em conversa monitorada (não
  self-chat) caía num `return`. Agora é persistida e entra no batch de triage.
- **Contexto** (`packages/shared/src/context.ts`): `buildAiContext` só incluía
  `fromMe` se começasse com `"trello:"`. Agora **sempre** inclui — o campo
  `from_me` diz à IA quem falou. Assim ela entende o diálogo completo e detecta
  compromissos que o próprio Álvaro assume ("te envio amanhã").

## 3) Corte da parte inferior do front (zoom/escala > 100%)

Causa: containers flex de rolagem sem `min-height: 0`. Em telas mais baixas o
`nav` da sidebar (flex:1) e o `ai-thread` não encolhiam, empurrando o rodapé
(perfil/captura rápida e o compositor do chat) para fora da tela.

- `apps/web/src/styles.css`: `min-height: 0` em `.workspace-grid > *`, `.sidebar`,
  `.content-panel`, `.ai-panel`, `.sidebar nav`, `.ai-thread`; header/compositor
  do chat com `flex: none` para não encolher.

## 4) Lista de conversas: só grupos + diretos (sem `@lid`)

A conta do Álvaro tinha 854 "chats", mas 149 eram `@lid` (participantes de grupo /
modo privacidade) — não são conversas. O monitorável deve ser **grupo (`@g.us`)**
ou **direto (`@s.whatsapp.net`)**.

- `packages/integrations/src/whatsapp.ts`: helper exportado
  `isMonitorableChatJid`; aplicado em `mapConversationCatalog` (ingestão de chats)
  e em `mapWhatsAppContactNames` (agenda). +2 testes.
- `apps/api/src/routes/integrations.ts`: `GET /whatsapp/chats` filtra por
  `@g.us`/`@s.whatsapp.net` e ordena por (com nome) → grupos → nome.
- **Limpeza do banco**: removidas 149 linhas `@lid`/não-conversa de
  `monitored_chats` e de `whatsapp_conversation_catalog`. Preservados a conexão do
  WhatsApp (conectada) e as 705 conversas reais (645 diretos + 60 grupos).

---

## ✅ Validação
- `npm run typecheck` — OK
- `npm test` — todos passam (novos testes de contexto, filtro de JID e mocks do chat)
- `npm run build` — OK
- Serviços reiniciados sem erros; health 200; público serve o novo bundle.
- QA visual (preview): botão "+" no chat, layout íntegro, view Conversas.

> Como as mensagens `fromMe` e a limpeza afetam dados do Álvaro em produção: as
> mensagens novas passam a ser processadas com os dois lados; a lista de conversas
> agora mostra só grupos + diretos.

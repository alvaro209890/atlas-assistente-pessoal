# Atlas — Sessão 2026-07-14 (Nome salvo dos contatos)

## 📋 Resumo

Correção: muitos chats mostravam o **pushName** (nome que o contato definiu) ou o
**número**, em vez do **nome salvo** na agenda do dono. A causa era de prioridade
no preenchimento do `display_name`.

> A parte de Trello (apagar boards / consertar a aba) foi cancelada a pedido do
> responsável pela conta nesta sessão — nada foi alterado no Trello nem nos boards.

---

## 🐛 Causa raiz

- O sync do chat (`upsertConversationCatalog`) gravava o `display_name` a partir do
  nome do chat, que para 1:1 costuma ser o **pushName** ou o número.
- O `upsertContacts` (agenda) só preenchia `display_name` **quando estava vazio**
  (`WHERE display_name = '' OR IS NULL`). Então, se o chat já tinha gravado o
  pushName/número, o **nome salvo da agenda nunca sobrescrevia**.

## ✅ Correção

1. `packages/integrations/src/whatsapp.ts` — `mapWhatsAppContactNames` agora
   devolve `{ jid, name, saved }`. `saved=true` só quando o nome vem do campo
   `name` (agenda do dono); pushName (`notify`) e `verifiedName` ficam com
   `saved=false`. Evento `contacts` carrega o flag.
2. `apps/worker/src/repository.ts` — `upsertContacts` **sobrescreve** o
   `display_name` quando `saved=true` (nome salvo tem prioridade sobre
   pushName/número); com `saved=false` mantém o comportamento antigo (só preenche
   vazio). Vale para `whatsapp_conversation_catalog` e `monitored_chats`.
3. `packages/integrations/src/whatsapp.ts` — ao conectar, dispara um
   `resyncAppState([...], false)` (delta, uma vez, sem bloquear) para completar a
   sincronização da agenda quando o sync inicial veio parcial. **Não** é usado
   re-download total (`isInitialSync=true`) para evitar padrões de sync que possam
   sinalizar risco de ban na conta.
4. Testes atualizados (`packages/integrations/tests/whatsapp.test.ts`): o mapeamento
   marca `saved` corretamente e descarta `@lid`.

---

## ⚠️ Sobre os chats já existentes

- Contatos **salvos** na agenda passam a exibir o nome salvo assim que o WhatsApp
  os sincroniza (o `resyncAppState` ajuda a completar sincronizações parciais).
- Dos ~645 diretos, ~498 estavam **sem nome**: em boa parte são contatos **não
  salvos** na agenda — nesses casos o número é o esperado (não há nome salvo).
- Para reaplicar a agenda inteira de uma vez, **re-escanear o QR** faz uma
  sincronização inicial completa e, com a nova prioridade, os nomes salvos passam a
  sobrescrever pushName/número.

---

## ✅ Validação
- `npm run typecheck` — OK
- `npm test` — todos passam
- `npm run build` — OK
- `atlas-worker` reiniciado sem erros; `resyncAppState` rodou sem erro no log.

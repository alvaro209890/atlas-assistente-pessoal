# Atlas — Sessão 2026-07-14 (IA no ar + nomes de contatos no scan)

## 📋 Resumo

Chave DeepSeek válida instalada (IA funcionando de ponta a ponta) e correção para
garantir que, ao escanear o QR pessoal, os **nomes dos contatos venham
automaticamente**. Banco mantido zerado — apenas o WhatsApp admin.

---

## 🤖 IA no ar

- `DEEPSEEK_API_KEY` anterior era inválida (401). Nova chave instalada no `.env`
  (mascarada: `sk-df26***8c33`), backup temporário do `.env` removido.
- Smoke test direto na API: `deepseek-v4-flash`, `reasoning_effort=medium`,
  `thinking.enabled` → HTTP 200, resposta válida, `reasoning_content` presente
  (34 reasoning tokens). `atlas-api` e `atlas-worker` reiniciados.
- **Não** foi criado nenhum usuário de teste: banco permanece `users=0`,
  `platform_whatsapp_connection=1`.

---

## 👤 Nomes dos contatos ao escanear o QR (`packages/integrations/src/whatsapp.ts`)

### Causa
O handler de `messaging-history.set` lia apenas `{ chats }` e **ignorava o array
`contacts`**. É nesse evento que o Baileys entrega a **agenda inteira no sync
inicial** logo após o scan. Os handlers `contacts.upsert`/`contacts.update` só
disparam para mudanças posteriores, então numa conexão nova a maioria dos chats
1:1 ficava sem nome até o contato mudar (era o caso de ~793/853 chats sem nome).

### Correção
1. `messaging-history.set` agora também processa `contacts` (a agenda inicial).
2. **Ordem garantida**: primeiro `await emitConversations(chats)` (upsert do
   catálogo), depois `await emitContacts(contacts)` — porque `upsertContacts` só
   ATUALIZA linhas de catálogo já existentes (evita corrida insert/update).
3. Mapeamento extraído para função pura exportada `mapWhatsAppContactNames`, com
   prioridade **nome salvo → pushName (`notify`) → nome verificado
   (`verifiedName`, contas comerciais)**; descarta entradas sem id/sem nome.
4. Teste novo em `tests/whatsapp.test.ts` travando a prioridade e o descarte.

### Fluxo resultante
`messaging-history.set` → catálogo populado (grupos já com nome do assunto; 1:1
vazios) → nomes da agenda aplicados aos 1:1 → `contacts.upsert/update` e o
`pushName` das mensagens seguem complementando ao longo do tempo.

---

## ✅ Validação
- `npm run typecheck` — OK
- `npm test -w @atlas/integrations` — 16 passed (inclui o novo teste)
- `npm run build` — OK
- `atlas-worker` reiniciado sem erros; banco confirmado zerado (só WhatsApp admin).

> Teste ao vivo do scan depende do usuário parear um WhatsApp pessoal; o caminho
> de código está coberto por teste e o worker está no ar aguardando o pareamento.

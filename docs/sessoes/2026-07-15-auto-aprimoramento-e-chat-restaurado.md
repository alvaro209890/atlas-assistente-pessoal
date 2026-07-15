# 2026-07-15 — Varredura de auto-aprimoramento, chat lateral restaurado e correções do grafo

## Contexto

Os créditos do DeepSeek acabaram dias atrás e todo o pipeline de análise passou a
falhar silenciosamente: 61 lotes `failed`, 56 `ai_runs` com `PROVIDER_UNAVAILABLE`,
60 notas "Análise pendente" no inbox, grafo com **zero arestas** e zero
aprendizados. Com os créditos repostos, esta sessão corrigiu os bugs que ficaram
escondidos atrás da indisponibilidade e adicionou auto-cura permanente.

## Bugs corrigidos

1. **Chat lateral (AIAssistant) sumiu do site** — o commit `3b6f36a` ("unifica
   contexto") removeu acidentalmente o `<AIAssistant />` do `Workspace.tsx` e as
   3 colunas do grid. O componente e o CSS continuavam no repositório.
   Restaurado com o botão mobile (`PanelRightOpen`) e overlay.
2. **`brain_edges` provenance `evidence` violava o CHECK** — `upsertMemories` e
   `linkTaskKnowledge` gravam arestas com `provenance='evidence'`, mas o CHECK
   original só aceitava `manual/rule/ai/import`. Toda a transação de memória
   sofria rollback (grafo permanentemente vazio). → migração
   `0014_edge_provenance_evidence.sql`.
3. **`column entity.node_id does not exist`** — a SQL das arestas factuais
   nota↔entidade referenciava `entity.node_id` (2 ocorrências); a tabela
   `brain_nodes` só tem `id`.
4. **`inconsistent types deduced for parameter $1`** — `INSERT … SELECT $1,…`
   combinado com `WHERE user_id=$1` deixa o tipo ambíguo no protocolo estendido.
   Corrigido com casts `$1::uuid` em `upsertMemories`, `linkTaskKnowledge` (2×)
   e na nova tecelagem de grafo.
5. **Saída da IA reprovada pelo schema estrito**:
   - `priority: "medium"` (o enum é `low|normal|high|urgent`) → aliases
     (`medium/média→normal`, `alta→high`, `urgente→urgent`, …);
   - `conversationClassification` com chaves extras (`classificationType`),
     `confidence` textual ou campos faltando → normalização poda/coage e cai em
     `null` quando incompleta (classificação é opcional);
   - `content` vazio/JSON truncado com raciocínio ligado →
     `DEFAULT_DEEPSEEK_MAX_OUTPUT_TOKENS` 4096→6144.
6. **Front**: busca de notas do Cérebro não filtrava; botão "Centralizar grafo"
   morto; sino de notificações decorativo; prazos de tarefas nunca exibidos no
   Hoje/drawer (só existia `dueLabel`, nunca preenchido pela API);
   ~120 linhas de views mortas (`TodayView`/`InboxView`/`FeedbackActions`).

## Novidades

### Varredura de auto-aprimoramento (`apps/worker/src/self-improve.ts`)

Fila `atlas.brain.self-improve`, agendada a cada 30 min (e na subida do worker):

1. **Reprocessa lotes falhados** (até 50/ciclo, máx. 10 tentativas por lote)
   reaproveitando o `batch_key` idempotente — apagões de IA se curam sozinhos.
2. **Tece o grafo deterministicamente**: arestas `mentions` (provenance `rule`)
   quando uma nota/decisão cita o título/alias (≥4 chars, fronteira de palavra
   `\m…\M`) de pessoa/projeto/grupo/entidade/tópico.
3. **Arquiva notas "Análise pendente"** cujo lote foi concluído.
4. **Consolida aprendizados duplicados** (mesma frase + escopo, mantém o de
   maior autoridade/confiança).
5. **Pergunta proativa no WhatsApp** (kind `proactive_question`): quando existe
   dúvida concreta (tarefa `inbox` com `missingInformation`/confiança <0,7 ou
   learning `suggested`), envia UMA pergunta pelo número central. Regras:
   mínimo 6 h entre perguntas, horário social 08–21 do fuso do usuário,
   `dedupe_key` derivado da dúvida (nunca repete a mesma pergunta),
   respeita `notifySelf`.

### Mais contexto para a IA

- **Chat do site (`/ai/chat`)**: além do RAG de notas (agora 10 sementes + 12
  resultados), o prompt recebe um *snapshot do espaço de trabalho* direto do
  banco: 14 tarefas abertas, 10 lembretes agendados, 10 compromissos,
  8 aprendizados ativos e o resumo diário mais recente
  (`loadWorkspaceSnapshot` em `routes/chat.ts` + `renderWorkspaceSnapshot` em
  `ai.ts`). Histórico de conversa 8→12 mensagens.
- **Triagem do WhatsApp (`buildContext`)**: orçamento 18k→26k chars, mensagens
  20→24, memórias 5+3→8+5 (+ resumo diário mais recente sempre incluído),
  learnings 6→10.
- **Assistente do número central**: agora também recebe lembretes agendados,
  compromissos abertos e preferências confirmadas; histórico 12→20 mensagens.

### Front

- Chat lateral persistente de volta em todas as views, com **histórico de
  conversas** (menu no cabeçalho do painel, carrega threads/mensagens salvas).
- Sino de notificações funcional (dropdown com atividade recente + tempo
  relativo).
- Busca de notas do Cérebro funcional; "Centralizar grafo" funcional.
- Prazos reais nas tarefas (`taskDueLabel`: "Hoje, 14:00", "Amanhã…", "Venceu…").

## Operação executada no banco do Álvaro

- Migração 0014 aplicada; serviços `atlas-api`/`atlas-worker`/`atlas-web`
  reiniciados (o `atlas-web` estava parado desde a noite anterior — era isso que
  derrubava o site com 502 no tunnel).
- Backlog inteiro reenfileirado e reprocessado com DeepSeek real.
- Teste real com a sessão do Álvaro: `/api/ai/chat` respondeu com tarefas e
  notas reais dele, fontes citadas e snapshot do banco no prompt.

## Como acompanhar

```bash
journalctl --user -u atlas-worker -f          # varredura e análise
psql "$DATABASE_URL" -c "SELECT status,count(*) FROM message_batches GROUP BY 1"
psql "$DATABASE_URL" -c "SELECT relation_type,provenance,count(*) FROM brain_edges GROUP BY 1,2"
```

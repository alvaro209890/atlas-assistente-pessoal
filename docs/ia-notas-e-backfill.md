# IA, notas e backfill seguro

O Atlas separa ações externas de conhecimento pessoal: tarefas continuam usando
`AI_CONFIDENCE_THRESHOLD` (padrão 0,70), enquanto notas, fatos, decisões e
observações usam `MEMORY_CONFIDENCE_THRESHOLD` (padrão 0,60).

## Regras de captura

- Só responsabilidades concretas criam tarefa/Trello.
- Fatos úteis, decisões, riscos, mudanças de status e observações duráveis
  viram nós `note` ou `decision`, com fonte por mensagem do WhatsApp.
- Conversa social sem valor futuro não é salva como memória.
- Falha de provedor ou JSON não cria tarefa: registra uma nota `Análise pendente`
  e agenda nova tentativa.

## Rastreabilidade

Cada nota gerada guarda suas mensagens de origem em `brain_node_sources`.
Quando uma tarefa compartilha evidência com uma nota, o worker cria a edge
idempotente `context_for`. Em caso de título ambíguo, uma relação sugerida pela
IA é ignorada para evitar um vínculo incorreto.

Notas e decisões que compartilham a mesma evidência de uma pessoa, projeto,
grupo ou entidade recebem também a edge factual `about`. Isso dá conectividade
ao grafo sem inventar relações: a IA ainda pode sugerir relações adicionais,
mas apenas quando existirem título e tipo não ambíguos.

Na recuperação de contexto, o Atlas seleciona até cinco nós semanticamente
relacionados ao lote atual e até três vizinhos conectados por edges. Assim uma
nota útil ligada a um projeto ou pessoa pode voltar ao contexto sem carregar o
grafo inteiro.

## Janela de contexto e custo

Uma conversa do WhatsApp é reiniciada depois de **15 minutos** sem mensagens
(`CONVERSATION_CONTEXT_IDLE_MINUTES`). A nova conversa não herda o resumo
operacional anterior; fatos duráveis continuam disponíveis pelo grafo de
memória, recuperados pelo conteúdo do lote atual.

Antes da chamada à IA, o worker aplica dois tetos configuráveis:

- `AI_CONTEXT_MAX_MESSAGES=20`: máximo de mensagens recentes fornecidas.
- `AI_CONTEXT_MAX_CHARS=18000`: orçamento total aproximado para mensagens,
  memórias, correções, cartões e aprendizados. Textos longos preservam começo
  e fim, em vez de consumir o orçamento inteiro.

O modelo recebe no máximo `DEEPSEEK_MAX_OUTPUT_TOKENS=4096` tokens de saída.
Esses limites são independentes dos registros completos, que permanecem no
banco e nas fontes do grafo para auditoria.

## Backfill do usuário

Use primeiro um replay em modo seco para produzir relatório sem escrita ou
efeito externo:

```bash
npm run ai:replay-notes -- --user "nome"
```

Depois, `--apply` grava apenas notas e fontes; ele nunca cria cartões, tarefas,
lembretes ou envia mensagens:

```bash
npm run ai:replay-notes -- --user "nome" --apply
```

Antes do backfill, faça backup e aplique as migrações pendentes.

## Ensino explícito

`POST /api/assistant/teach` recebe `statement` e `title` opcional. Em uma única
transação cria o aprendizado ativo, uma nota manual, sua fonte e a evidência de
instrução explícita. A tela **Aprendizados** expõe a mesma ação em “Ensinar ao
Atlas”.

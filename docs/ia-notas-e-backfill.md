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

## Backfill do usuário

Use primeiro um replay em modo seco para produzir relatório sem escrita ou
efeito externo. O modo de aplicação aprovado para dados históricos grava apenas
notas, fontes e vínculos; ele nunca cria cartões, tarefas, lembretes ou envia
mensagens. Antes do backfill, faça backup e aplique as migrações pendentes.

## Ensino explícito

`POST /api/assistant/teach` recebe `statement` e `title` opcional. Em uma única
transação cria o aprendizado ativo, uma nota manual, sua fonte e a evidência de
instrução explícita. A tela **Aprendizados** expõe a mesma ação em “Ensinar ao
Atlas”.

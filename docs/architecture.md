# Arquitetura do Atlas

## Componentes

- **Web**: React/Vite para cadastro, onboarding, painel Hoje, Inbox, tarefas, aprendizados, editor, grafo, chat e console `/admin`.
- **API**: Fastify com autenticação por cookie, validação Zod, isolamento por usuário, SSE e APIs de domínio.
- **Worker**: sessões Baileys, agrupamento de mensagens, DeepSeek, sincronização Trello, lembretes, compromissos e manutenção dos aprendizados.
- **PostgreSQL**: fonte de verdade para contas, perfis, tarefas canônicas, Segundo Cérebro e filas `pg-boss`.

O frontend nunca recebe chaves do DeepSeek ou do Trello. As rotas pessoais usam o `user_id` da sessão autenticada. O console `/admin` e suas rotas de operação do WhatsApp central estão intencionalmente sem login nesta fase local-first.

## Perfil e onboarding

O cadastro exige `preferredName`; `fullName` é opcional. O perfil guarda área profissional e até três objetivos. Fuso, idioma, jornada, horário silencioso e estilo de comunicação ficam nas configurações individuais.

O onboarding coleta o perfil antes de conectar WhatsApp e Trello. Um nome obtido do WhatsApp é apenas sugestão e nunca substitui o perfil sem confirmação.

Depois que a autorização delegada do Trello é confirmada, o onboarding apresenta um tutorial curto sobre quadro, listas, cartões, sincronização e preservação do conteúdo manual. Só então a pessoa segue para o mapeamento das quatro fases canônicas. A navegação selecionável informa título e finalidade de cada área e expõe o estado atual semanticamente com `aria-current` ou `aria-selected`.

Existem duas classes de sessão Baileys: uma sessão pessoal por usuário, com envio bloqueado no próprio adaptador, e uma sessão central singleton (`mother`), conectada pelo admin e autorizada a enviar. Ao abrir a sessão pessoal, o `self_jid` identifica e normaliza automaticamente o telefone brasileiro; entradas nacionais como `66984396232` usam `55` como DDI padrão.

## Mensagens e decisões

1. O Baileys pessoal persiste texto ou legenda de uma conversa autorizada, sem permissão de envio.
2. Mensagens são agrupadas por dez segundos, com limite de trinta.
3. O contexto inclui mensagens, tarefa e cartões candidatos, memórias, aprendizados com escopo e correções semelhantes.
4. DeepSeek V4 Flash devolve uma decisão estruturada e versionada.
5. IDs e evidências são validados contra o contexto fornecido.
6. Ações reversíveis com confiança mínima de 0,70 podem ser executadas.
7. Conclusão, cancelamento e merge inferidos viram propostas confirmáveis.
8. Efeitos são registrados em eventos idempotentes e publicados por SSE.

## Tarefas e Trello

`canonical_tasks` é a fonte de verdade. `task_events` mantém o histórico e `task_trello_links` relaciona cada tarefa à projeção local de um cartão.

O executor altera apenas a seção gerenciada pelo Atlas, preservando conteúdo manual. Checklists, prazo, membros, etiquetas e `dueComplete` usam recursos nativos do Trello. Mudanças humanas são observadas; colisões no mesmo campo entram como conflito no Inbox.

Um fingerprint por usuário evita duplicação entre lotes. O marcador novo é `Atlas-ID`; o leitor também aceita o marcador da versão anterior apenas para recuperar cartões antigos.

## Lembretes e compromissos

`reminders` define a regra e `reminder_occurrences` representa cada disparo. Ocorrências são reivindicadas com lock, possuem deduplicação e respeitam fuso e horário silencioso.

`commitments` diferencia `owed_by_me` de `owed_to_me`. O Atlas acompanha follow-ups e prepara respostas, mas nunca envia mensagens aos contatos monitorados. Boas-vindas, lembretes e respostas ao próprio usuário saem do número central.

Na conversa com o número central, comandos naturais podem confirmar, adiar, reagendar, silenciar ou abrir a última tarefa relacionada. O remetente é associado à conta pelo `self_jid` capturado no QR pessoal.

## Aprendizado

`assistant_learnings` guarda a regra; evidências e resultados ficam em tabelas próprias. Cada aprendizado possui escopo, estado, confiança, validade e histórico.

- Instrução explícita: pode ser ativada imediatamente.
- Inferência de baixo risco: três evidências em ao menos dois dias e confiança mínima de 0,85.
- Ação destrutiva, destinatário ou permissão externa: confirmação obrigatória.
- Inferência sem uso: revisão após 90 dias.

Somente regras ativas e relevantes ao escopo entram no prompt. A pessoa pode confirmar, editar, pausar, rejeitar, desfazer ou esquecer.

## Segundo Cérebro e chat

Notas manuais e conteúdo gerado permanecem separados. Fontes, revisões, wikilinks, backlinks, stubs e relações compõem o grafo.

A busca combina título, aliases, tags, FTS em português, `pg_trgm` e vizinhança de um salto. O chat responde com fontes internas e pode devolver propostas estruturadas; confirmar uma proposta é uma operação separada e auditável.

## Recuperação de falhas

- Lotes, tarefas, mutações Trello, lembretes, notificações e propostas usam idempotência.
- JSON inválido recebe uma correção imediata.
- Timeout, `429` e `5xx` usam tentativas progressivas.
- Alertas perdidos durante indisponibilidade são consolidados após reconexão.
- Uma falha de notificação nunca repete a criação de tarefa ou cartão.

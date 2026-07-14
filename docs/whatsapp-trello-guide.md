# Guia dos fluxos WhatsApp e Trello

Este documento descreve o comportamento entregue para cadastro, conexão das contas, tutorial do Trello, comunicação central e operação do painel admin.

## Visão geral

O Atlas separa leitura e envio em duas conexões WhatsApp:

1. **WhatsApp pessoal do usuário**: conectado durante o onboarding, identifica automaticamente o telefone e pode somente ler as conversas escolhidas.
2. **WhatsApp central do Atlas**: conectado uma única vez em `/admin`; é o único autorizado a enviar boas-vindas, lembretes, respostas e mensagens administrativas.

Assim, o Atlas nunca responde aos contatos que aparecem nas conversas monitoradas. Ele conversa apenas com o próprio usuário pelo número central.

## Jornada do usuário

1. A pessoa cria a conta e informa nome preferido, área de trabalho e objetivos.
2. Ela conecta o WhatsApp pessoal por QR Code. Não existe campo manual de telefone.
3. O `self_jid` da sessão identifica o número. Telefones nacionais, como `66984396232`, são normalizados com o DDI brasileiro padrão `55`.
4. A primeira conexão cria, de forma idempotente, uma notificação de boas-vindas para a fila do WhatsApp central.
5. A pessoa autoriza o Trello pelo fluxo oficial, sem copiar token ou senha.
6. Assim que a autorização é confirmada, a interface mostra um tutorial explicando quadro, listas, cartões e sincronização.
7. A pessoa escolhe um quadro e relaciona quatro fases: **Entrada**, **Em andamento**, **Pausado** e **Concluído**.
8. Por fim, seleciona as conversas que o leitor pessoal pode acompanhar e revisa os horários de aviso.

## Como o Trello funciona no Atlas

- **Quadro**: o espaço que reúne as tarefas de um fluxo ou projeto.
- **Lista**: uma etapa do trabalho. O nome real pode variar; o onboarding relaciona cada lista às quatro fases canônicas do Atlas.
- **Cartão**: uma tarefa com título, prazo, membros, etiquetas, checklists e contexto.
- **Sincronização**: tarefas canônicas ficam no PostgreSQL e são projetadas no Trello. Alterações humanas são observadas e conflitos de um mesmo campo aparecem no Inbox.
- **Conteúdo preservado**: o Atlas altera apenas sua seção gerenciada e mantém descrições manuais fora dela.

O tutorial pós-conexão prepara a pessoa antes do mapeamento. A navegação do produto também apresenta título, descrição e estado selecionado visível, com `aria-current` no desktop e no celular. Filtros do Inbox, aprendizados, grafo e formatação receberam estados selecionados consistentes.

## Painel admin sem login

Abra `http://localhost:5173/admin`. Nesta fase, o painel é propositalmente público e não possui senha.

O painel permite:

- gerar ou renovar o QR Code do único WhatsApp central;
- visualizar estado, telefone detectado e horário da última conexão;
- desconectar e apagar a autenticação central persistida;
- editar a mensagem automática de boas-vindas usando `{nome}`;
- acompanhar números pessoais detectados e o estado da primeira mensagem;
- enviar uma mensagem direta para um usuário pela fila do número central.

Rotas da API, sob `/api/admin`:

| Método | Rota | Função |
| --- | --- | --- |
| `GET` | `/whatsapp` | Consultar a conexão central |
| `POST` | `/whatsapp/pair` | Solicitar ou renovar o QR Code |
| `POST` | `/whatsapp/disconnect` | Desconectar e limpar a sessão central |
| `PATCH` | `/settings` | Atualizar a mensagem de boas-vindas |
| `GET` | `/users` | Listar usuários e telefones detectados |
| `POST` | `/messages` | Enfileirar mensagem para um usuário |

## Persistência e garantias

A migração `0009_platform_whatsapp.sql` cria a conexão singleton `mother`, os registros de autenticação, o histórico de mensagens e os campos usados para associar o telefone detectado à conta.

- O adaptador da sessão pessoal recebe `allowSending: false`; uma tentativa de envio falha antes de chegar ao WhatsApp.
- A sessão central recebe `allowSending: true` e consome a `notification_outbox`.
- A boas-vindas usa a chave de deduplicação `platform-mother:welcome:v1`, evitando reenvio em reconexões.
- Mensagens que chegam ao número central são associadas ao usuário pelo JID capturado no QR pessoal.
- A normalização brasileira aceita DDD mais número e preenche `55` quando não houver DDI.

## Operação e validação

Depois de atualizar o código:

```bash
npm ci
npm run db:migrate
npm run release:check
npm audit --omit=dev --audit-level=moderate
```

Inicie API, worker e web. Conecte primeiro o número central em `/admin`; depois conclua o onboarding com uma conta de teste. A confirmação real do QR exige PostgreSQL em execução e dois aparelhos/sessões WhatsApp disponíveis.

Antes de expor o sistema na internet, adicione autenticação e autorização ao `/admin`, HTTPS, limitação de requisições e auditoria de ações administrativas. A ausência de senha é uma decisão temporária de desenvolvimento, não um padrão de produção.

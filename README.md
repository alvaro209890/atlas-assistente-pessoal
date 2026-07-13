# Atlas

Atlas é um assistente pessoal multiusuário que conecta WhatsApp, Trello, lembretes e um Segundo Cérebro interno. Ele transforma conversas autorizadas em tarefas e compromissos, acompanha follow-ups, explica prioridades e aprende preferências com evidências e controle da própria pessoa.

O Atlas possui personalidade masculina, direta, humana e calma. Ele usa o nome preferido configurado em cada conta e nunca presume a identidade do usuário.

## Recursos

- Cadastro, perfil e onboarding independentes por usuário.
- WhatsApp principal conectado por QR Code, com seleção explícita das conversas monitoradas.
- Trello como projeção sincronizada de tarefas canônicas mantidas pelo Atlas.
- Criação, atualização, reabertura, conclusão confirmada, comentários, checklists nativos e deduplicação.
- Lembretes por prazo, recorrência, snooze, horário silencioso e recuperação após indisponibilidade.
- Compromissos “eu devo” e “estão me devendo”, respostas pendentes e follow-ups.
- Comandos naturais no WhatsApp da própria pessoa, como “feito”, “adiar 1h” e “amanhã às 9”.
- Aprendizados com escopo, confiança, evidências, histórico, confirmação, pausa e esquecimento.
- Segundo Cérebro no PostgreSQL com notas manuais, conteúdo gerado, wikilinks, backlinks, fontes, revisões, grafo e chat.
- Chat com respostas fundamentadas e propostas confirmáveis de ação.
- Briefings às 08:00 e 18:00, configuráveis por conta.
- DeepSeek V4 Flash com thinking habilitado e raciocínio alto.
- Eventos em tempo real por SSE e execução assíncrona com `pg-boss`.

Nenhuma resposta é enviada automaticamente a contatos. Alertas e sugestões são entregues somente à própria pessoa pelo `NotificationChannel`.

## Estrutura

```text
apps/web       React + Vite
apps/api       Fastify, autenticação e APIs
apps/worker    WhatsApp, IA, Trello, lembretes e rotinas
packages/*     banco, schemas e integrações compartilhadas
PostgreSQL     dados multiusuário e filas pg-boss
```

Consulte [a arquitetura](docs/architecture.md), [a operação](docs/operations.md) e [a personalidade do Atlas](docs/atlas-personality.md).

## Requisitos

- Node.js 24 LTS.
- npm 10 ou superior.
- PostgreSQL 17 ou Docker Compose.
- Chave de servidor do DeepSeek.
- Aplicação Trello com callback delegado.

## Início local

```bash
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

- Interface: `http://localhost:5173`
- API: `http://localhost:3000`
- Health check: `http://localhost:3000/health`

Com Docker:

```bash
docker compose up --build
```

O serviço `migrate` aplica as migrações antes de iniciar a API e o worker.

## Configuração

- `DATABASE_URL`: conexão PostgreSQL.
- `SESSION_SECRET`: segredo aleatório com pelo menos 32 caracteres.
- `DEEPSEEK_API_KEY`: chave central, usada apenas no servidor.
- `TRELLO_API_KEY` e `TRELLO_CALLBACK_URL`: autorização delegada do Trello.
- `AI_CONFIDENCE_THRESHOLD`: padrão `0.70`.
- `RUN_LIVE_AI_TESTS`: habilita testes reais e cobrados somente quando definido como `1`.

O modelo é fixado em `deepseek-v4-flash`, com `thinking.type=enabled`, `reasoning_effort=high` e sem `temperature`.

## Validação

```bash
npm run typecheck
npm test
npm run build
npm run verify:release
```

Os testes reais da IA permanecem desligados por padrão. A validação do projeto não precisa abrir navegador.

## Limites atuais

- Um WhatsApp e um quadro Trello por conta.
- Texto e legendas são processados; outras mídias são ignoradas.
- Google Calendar, e-mail, embeddings, equipes, múltiplos números e número secundário ficam para versões futuras.
- Baileys é uma integração não oficial e pode exigir atualizações quando o WhatsApp mudar.

## Licença

MIT

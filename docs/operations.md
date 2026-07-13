# Operação local e Linux

## Requisitos

- Node.js 24 LTS e npm 10 ou superior.
- PostgreSQL 17 ou Docker Compose.
- Aplicação Trello com callback em `/api/trello/callback`.
- Chave de servidor do DeepSeek.

## Preparação

1. Copie `.env.example` para `.env`.
2. Troque todos os segredos de exemplo.
3. Execute `npm ci`.
4. Execute `npm run db:migrate`.
5. Inicie com `npm run dev`.

Com Docker, `docker compose up --build` inicia o PostgreSQL, aplica as migrações e libera API, worker e web nessa ordem.

O estado Baileys é persistido por usuário no PostgreSQL. Não versione `.env`, dumps, credenciais, sessões ou diretórios de build.

## Valores importantes

- `DATABASE_URL`: banco principal.
- `SESSION_SECRET`: pelo menos 32 caracteres aleatórios.
- `DEEPSEEK_API_KEY`: chave central do servidor.
- `TRELLO_API_KEY`: chave pública da aplicação Trello.
- `TRELLO_CALLBACK_URL`: callback correspondente ao domínio da API.
- `WEB_ORIGIN`: origem pública permitida para a interface web.

Antes de produção, configure HTTPS, substitua qualquer chave usada em testes e faça backup do PostgreSQL.

## Migrações

As migrações são aditivas. A migração Atlas V2 cria perfis, tarefas canônicas, lembretes, compromissos, aprendizados, fontes e propostas, além de importar representações antigas sem apagar conteúdo manual.

Execute sempre a migração antes de iniciar uma nova versão da API ou do worker.

## Validação

```bash
npm run release:check
npm audit --omit=dev --audit-level=moderate
```

`release:check` executa typecheck, testes, build e a varredura de publicação. Testes PostgreSQL usam `TEST_DATABASE_URL`; testes reais do DeepSeek exigem `RUN_LIVE_AI_TESTS=1`.

Conforme a limitação deste ambiente, a validação local não abre navegador, Chrome, Playwright ou screenshots. Componentes são cobertos com Vitest/jsdom e o frontend pelo build de produção.

## CI

O GitHub Actions usa Node.js 24 e PostgreSQL 17, aplica todas as migrações, executa `release:check`, auditoria npm e constrói as três imagens de produção em pushes e pull requests.

## Publicação

Antes do push público:

1. Execute a auditoria e `npm run verify:release`.
2. Confirme que somente `.env.example` possui nomes de variáveis.
3. Confirme que não há tokens, arquivos de sessão ou dados reais.
4. Verifique que o repositório remoto pertence à conta correta.
5. Aguarde o resultado do GitHub Actions.

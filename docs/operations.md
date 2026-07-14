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

O estado Baileys pessoal é persistido por usuário no PostgreSQL; o estado do número central usa registros separados. Não versione `.env`, dumps, credenciais, sessões ou diretórios de build.

Depois de iniciar API, worker e web, abra `http://localhost:5173/admin` (ou `/admin` no domínio publicado), clique em **Gerar QR Code** e leia o código com o único WhatsApp central. O painel está deliberadamente sem senha nesta fase. Em seguida, cada usuário conecta o WhatsApp pessoal no onboarding; o número é identificado pelo QR, a mensagem de boas-vindas é enfileirada automaticamente e a conexão do Trello passa por um tutorial antes do mapeamento das listas.

O fluxo funcional completo e as rotas administrativas estão documentados no [guia de WhatsApp e Trello](whatsapp-trello-guide.md).

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

Além do Vitest/jsdom e do build de produção, mudanças visuais devem ser conferidas em navegador real nos tamanhos desktop e celular. O pareamento real de WhatsApp continua dependendo de PostgreSQL, worker ativo e aparelhos disponíveis.

## CI

O GitHub Actions usa Node.js 24 e PostgreSQL 17, aplica todas as migrações, executa `release:check`, auditoria npm e constrói as três imagens de produção em pushes e pull requests.

## Publicação

Antes do push público:

1. Execute a auditoria e `npm run verify:release`.
2. Confirme que somente `.env.example` possui nomes de variáveis.
3. Confirme que não há tokens, arquivos de sessão ou dados reais.
4. Verifique que o repositório remoto pertence à conta correta.
5. Aguarde o resultado do GitHub Actions.

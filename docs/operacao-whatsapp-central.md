# Operação do WhatsApp central

O Atlas usa duas conexões distintas:

- **WhatsApp pessoal do usuário**: lê as conversas monitoradas e identifica o destinatário das notificações.
- **WhatsApp central**: recebe mensagens diretas do usuário e envia respostas, lembretes e resumos.

O worker mantém a sessão central com a chave interna `mother`. Mensagens diretas são associadas ao usuário pelo número de telefone normalizado, persistidas em `platform_whatsapp_messages`, respondidas pelo provedor de IA e enviadas por `notification_outbox`.

O histórico conversacional direto é uma janela de 15 minutos por padrão. Se o
usuário ficar inativo por esse período, a próxima mensagem abre um novo
contexto; memórias e tarefas relevantes continuam acessíveis, sem reaproveitar
conversa antiga como se ainda estivesse em andamento.

## Verificação rápida

```bash
systemctl --user is-active atlas-worker atlas-api atlas-web
curl -fsS http://127.0.0.1:3100/health
curl -fsS https://atlas.cursar.space/health
```

O estado da sessão central fica em `platform_whatsapp_connection`; deve ser `connected`. A fila de saída fica em `notification_outbox`: uma resposta normal passa por `pending`/`sending` e termina em `sent`.

## Diagnóstico de uma mensagem sem resposta

1. Confirme que a sessão central está `connected` e que existe uma conexão pessoal ativa para o usuário.
2. Veja se a entrada foi persistida em `platform_whatsapp_messages`. Se não houver registro, o problema é antes da IA, na recepção/identificação do WhatsApp.
3. Verifique `notification_outbox` e `last_error`. Sem item na fila, investigue os logs do worker e o provedor de IA; com item `failed`, a mensagem será retomada automaticamente quando a sessão central reconectar.
4. Consulte os logs sem expor conteúdo de conversas: `journalctl --user -u atlas-worker.service --since '15 minutes ago' --no-pager`.

## Compatibilidade com identificadores LID

O WhatsApp pode entregar conversas diretas usando um LID de privacidade e, no mesmo evento, fornecer o JID do telefone em `remoteJidAlt` ou `participantAlt`. O Atlas sempre prioriza o JID de telefone (`@s.whatsapp.net`) para encontrar a conta correta. Isso evita descartar mensagens de usuários já vinculados quando a privacidade de número está ativa.

## Publicação pelo Cloudflare

O Atlas fica disponível em `https://atlas.cursar.space`; a rota pública e `GET /health` devem responder após a reinicialização. O `cloudflared.service` é um serviço de sistema, separado dos serviços de usuário `atlas-api`, `atlas-worker` e `atlas-web`. A configuração de ingress pode ser administrada remotamente pelo Cloudflare; por isso a validação obrigatória é a chamada pública ao endpoint de saúde, e não apenas o arquivo local do túnel.

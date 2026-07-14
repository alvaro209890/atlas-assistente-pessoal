# Entrega unificada: contexto de grupos, assistente no WhatsApp e Trello operacional

Data: 14/07/2026

## Objetivo desta entrega

Integrar o trabalho local com o `main` mais recente do GitHub e consolidar três comportamentos:

1. impedir que conversas de grupo destinadas a terceiros virem tarefas do dono da conta;
2. manter a conversa com o Atlas no WhatsApp central, removendo o chat lateral de IA do painel web;
3. substituir controles inertes do quadro Trello por ações ligadas à API e ao fluxo de sincronização.

Antes das alterações, o repositório local foi atualizado por fast-forward até o commit remoto `3d79aab`. As mudanças locais anteriores de nomes de contatos, seleção de conversas, grupos e monitoramento foram reaplicadas e reconciliadas sobre essa base.

## Implementado

### Contexto de grupos e responsabilidade

- Mensagens normalizadas agora carregam indicação de grupo, menções, participante citado, mensagem citada e sinal de direcionamento ao usuário.
- O adaptador do WhatsApp reconhece mensagens diretas, menções ao JID pessoal e respostas a mensagens do dono.
- O contexto enviado ao DeepSeek inclui a identidade do dono da conta, nomes conhecidos e os campos de direcionamento de cada evidência.
- Chamadas pelo nome no início da mensagem, como `Pessoa Usuária, ...`, também podem identificar direcionamento mesmo sem uma menção nativa.
- A política impede que evidência de grupo não direcionada ao dono crie tarefa, lembrete, compromisso ou proposta de ação.
- O prompt diferencia uma promessa feita pelo dono de uma ordem que ele enviou a outra pessoa no grupo.
- A classificação automática de contatos e conversas continua limitada às conversas com monitoramento ativo; grupos definidos manualmente não são sobrescritos pela IA.

### Assistente pelo número central

- O chat lateral de IA, seu botão no topo e seu comando na paleta foram removidos do espaço web.
- Mensagens diretas enviadas pelo telefone cadastrado ao WhatsApp central são associadas à conta correta.
- Conversas comuns recebem resposta do DeepSeek pelo próprio número central, usando histórico recente, tarefas abertas e memórias relevantes.
- Respostas enviadas pelo Atlas passam a ser registradas no histórico central para preservar continuidade de conversa.
- Ordens inequívocas continuam usando o executor determinístico e seguro antes da conversa livre.
- O reconhecimento de conclusão aceita, entre outras formas: `a tarefa X tá concluída`, `marque X como concluída`, `conclua a tarefa X` e `terminei X`.
- O Atlas não afirma que uma alteração foi executada antes da confirmação do executor de tarefas/Trello.

### Conversas monitoradas e grupos

- O QR sincroniza o catálogo de conversas e prioriza o nome salvo na agenda sobre `pushName` e número.
- A configuração permite ativar e desativar individualmente o monitoramento.
- Também existe controle para ativar ou desativar todas as conversas autorizadas.
- Conversas podem ser organizadas em grupos como Trabalho, Estudos e Relacionamentos.
- A IA pode classificar gradualmente somente conversas monitoradas; a atribuição manual sempre prevalece.
- A migração aditiva correspondente é `0012_conversation_groups.sql`.

### Quadro Trello

- A API do workspace retorna o cartão externo, a tarefa canônica vinculada, a função da lista e a URL do Trello.
- O quadro possui busca, filtro por lista e atualização manual.
- O botão `+` de cada lista cria uma tarefa real e agenda sua sincronização.
- O título de um cartão vinculado abre os detalhes da tarefa.
- O menu de cartão permite concluir, comentar no Trello e abrir o cartão externo.
- Após criar ou executar uma ação, o workspace é recarregado para refletir o estado sincronizado.
- Foi adicionado um teste de interface que confirma que `Concluir tarefa` chama a API com a tarefa correta.

## Validações concluídas durante o desenvolvimento

- Typecheck dos pacotes, API, worker e web.
- `release:check` concluído: typecheck, 171 testes aprovados, build de produção e verificação de publicação.
- Pacote compartilhado: 38 testes aprovados.
- Integrações: 20 testes aprovados e 1 teste real de IA ignorado por depender de credencial/flag.
- Web: 30 testes aprovados.
- Casos específicos cobrem mensagem de grupo para terceiro, menção/resposta ao dono, novos comandos naturais e ação de conclusão no Trello.

## Checklist restante

- [ ] Aplicar `npm run db:migrate` no PostgreSQL do ambiente de destino.
- [x] Executar o `release:check` final e a verificação de publicação.
- [ ] Validar visualmente em navegador real os tamanhos desktop e celular; a tentativa desta sessão foi interrompida antes de iniciar o servidor Vite.
- [ ] Testar com aparelhos reais: QR pessoal, QR central, mensagem ao número central e resposta do Atlas.
- [ ] Testar conclusão, comentário e criação contra um quadro Trello real configurado.
- [ ] Publicar/reiniciar API, worker e web no servidor que executa o produto.
- [ ] Confirmar o GitHub Actions do commit enviado ao `main`.
- [ ] Antes de exposição pública, proteger `/admin` com autenticação, autorização, HTTPS e limite de requisições.

Os itens de dispositivo, serviços externos e produção não são simulados como concluídos: exigem as sessões reais de WhatsApp, credenciais do Trello, banco de destino e acesso ao servidor.

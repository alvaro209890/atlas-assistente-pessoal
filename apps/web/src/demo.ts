import type { Chat, Note, OnboardingStatus, Session, WorkspaceData } from './types';

export const demoSession: Session = {
  user: {
    id: 'preview-user',
    preferredName: 'Marina',
    fullName: 'Marina Costa',
    email: 'marina@atlas.preview',
  },
  onboardingComplete: true,
};

export const demoOnboarding: OnboardingStatus = {
  step: 2,
  profile: {
    preferredName: 'Marina',
    fullName: 'Marina Costa',
    occupation: 'Gestora de produto',
    goals: ['Lançar o Projeto Aurora', 'Ter uma rotina mais previsível'],
    timezone: 'America/Sao_Paulo',
    locale: 'pt-BR',
    workDays: [1, 2, 3, 4, 5],
    workStart: '08:00',
    workEnd: '18:00',
    quietStart: '21:00',
    quietEnd: '07:00',
    communicationStyle: 'balanced',
  },
  whatsapp: {
    id: 'preview-whatsapp',
    status: 'qr',
    qrDataUrl: null,
  },
  trelloConnected: false,
  trello: {
    connected: false,
    boards: [
      { id: 'board-main', name: 'Trabalho e projetos' },
      { id: 'board-personal', name: 'Organização pessoal' },
    ],
    selectedBoardId: null,
    lists: [],
    mapping: {},
  },
  selectedChatIds: [],
};

export const demoChats: Chat[] = [
  { id: 'chat-1', name: 'Eu mesmo', kind: 'direct', lastMessageAt: 'agora', selected: true },
  { id: 'chat-2', name: 'Equipe Produto', kind: 'group', lastMessageAt: 'há 12 min' },
  { id: 'chat-3', name: 'Lucas Mendes', kind: 'direct', lastMessageAt: 'ontem' },
  { id: 'chat-4', name: 'Projeto Aurora', kind: 'group', lastMessageAt: 'sexta-feira' },
];

export const demoNotes: Record<string, Note> = {
  'note-1': {
    id: 'note-1',
    title: 'Decisões da semana',
    excerpt: 'Consolidar o lançamento da Aurora e alinhar os próximos responsáveis.',
    updatedAt: 'Hoje, 09:42',
    tags: ['decisões', 'aurora'],
    pinned: true,
    source: 'manual',
    contentMarkdown:
      '# Decisões da semana\n\nO lançamento da **Aurora** segue para quinta-feira. [[Lucas Mendes]] prepara o material final e o time de produto revisa o fluxo.\n\n## Próximos passos\n\n- Fechar a apresentação\n- Revisar os cartões no Trello\n- Enviar o resumo para o time\n\n> O contexto completo está conectado ao [[Projeto Aurora]].',
  },
  'note-2': {
    id: 'note-2',
    title: 'Ideias para o novo onboarding',
    excerpt: 'Reduzir o tempo até o primeiro valor e explicar a conexão com clareza.',
    updatedAt: 'Ontem, 18:10',
    tags: ['produto', 'onboarding'],
    source: 'whatsapp',
    contentMarkdown:
      '# Ideias para o novo onboarding\n\nMostrar o benefício antes de solicitar integrações. Criar uma etapa por vez e sempre explicar por que o acesso é necessário.\n\nRelacionada a [[Experiência do usuário]].',
  },
  'note-3': {
    id: 'note-3',
    title: 'Reunião com operações',
    excerpt: 'Pendências, responsáveis e riscos levantados na conversa de segunda.',
    updatedAt: '10 jul, 16:25',
    tags: ['reunião', 'operações'],
    source: 'trello',
    contentMarkdown:
      '# Reunião com operações\n\nA equipe precisa de uma visão diária das prioridades abertas. Vincular a [[Rotina operacional]] e revisar em duas semanas.',
  },
  'note-4': {
    id: 'note-4',
    title: 'Referências de posicionamento',
    excerpt: 'Produtos que transformam informação dispersa em contexto acionável.',
    updatedAt: '8 jul, 11:04',
    tags: ['marca', 'referências'],
    source: 'manual',
    contentMarkdown:
      '# Referências de posicionamento\n\nA promessa deve ser calma, confiável e direta: menos busca, mais clareza. Conectar a [[Atlas]] e [[Narrativa de marca]].',
  },
};

export const demoWorkspace: WorkspaceData = {
  greeting: 'Bom dia, Marina',
  briefing: 'Fechar a apresentação antes das 14:00 libera duas tarefas dependentes e mantém o Projeto Aurora no prazo.',
  focus: [
    { id: 'focus-1', title: 'Revisar apresentação final', project: 'Projeto Aurora', dueLabel: 'Hoje, 14:00', priority: 'high' },
    { id: 'focus-2', title: 'Responder Lucas sobre orçamento', project: 'Operações', dueLabel: 'Hoje', priority: 'medium' },
    { id: 'focus-3', title: 'Organizar notas da semana', project: 'Atlas', dueLabel: 'Amanhã', priority: 'low' },
  ],
  tasks: [
    { id: 'focus-1', title: 'Revisar apresentação final', description: 'Validar narrativa, números e chamada final antes de compartilhar.', status: 'in_progress', priority: 'urgent', projectName: 'Projeto Aurora', personName: 'Lucas Mendes', dueAt: '2026-07-13T14:00:00-03:00', dueLabel: 'Hoje, 14:00', nextAction: 'Revisar os três slides finais', risk: 'Bloqueia a revisão do time se passar das 14:00.', estimateMinutes: 35, expectedOwner: 'Marina', trelloCardId: 'card-1', trelloCardUrl: 'https://trello.com/c/preview', labels: ['Aurora', 'Prioridade'], sourceMessageIds: ['msg-31', 'msg-34'], updatedAt: 'há 8 min' },
    { id: 'focus-2', title: 'Responder Lucas sobre orçamento', status: 'open', priority: 'high', projectName: 'Operações', personName: 'Lucas Mendes', dueLabel: 'Hoje', nextAction: 'Confirmar o teto aprovado', estimateMinutes: 10, expectedOwner: 'Marina', labels: ['Resposta pendente'], updatedAt: 'há 32 min' },
    { id: 'focus-3', title: 'Organizar notas da semana', status: 'open', priority: 'low', projectName: 'Atlas', dueLabel: 'Amanhã', nextAction: 'Revisar o inbox do cérebro', estimateMinutes: 25, labels: ['Revisão'], updatedAt: 'ontem' },
  ],
  reminders: [
    { id: 'reminder-1', title: 'Revisar apresentação final', scheduledAt: '2026-07-13T12:00:00-03:00', state: 'scheduled', taskId: 'focus-1' },
    { id: 'reminder-2', title: 'Briefing da tarde', scheduledAt: '2026-07-13T18:00:00-03:00', state: 'scheduled', recurrence: 'Todos os dias úteis' },
  ],
  commitments: [
    { id: 'commitment-1', title: 'Enviar a versão final da apresentação', direction: 'owed_by_me', personName: 'Lucas Mendes', dueLabel: 'Hoje, 16:00', dueAt: '2026-07-13T16:00:00-03:00', status: 'open' },
    { id: 'commitment-2', title: 'Retorno sobre custos de implantação', direction: 'owed_to_me', personName: 'Rafael Lima', dueLabel: 'Aguardando há 2 dias', followUpAt: '2026-07-13T15:00:00-03:00', status: 'open' },
  ],
  learnings: [
    { id: 'learning-1', statement: 'Prefere receber o briefing com no máximo três prioridades.', scopeType: 'global', status: 'active', confidence: 0.96, evidenceCount: 6, inferred: false, lastUsedAt: 'Hoje, 08:00', updatedAt: '12 jul' },
    { id: 'learning-2', statement: 'Tarefas do Projeto Aurora devem ser marcadas como alta prioridade quando tiverem prazo no mesmo dia.', scopeType: 'project', scopeLabel: 'Projeto Aurora', status: 'suggested', confidence: 0.88, evidenceCount: 4, inferred: true, lastUsedAt: null, updatedAt: 'Hoje, 09:42' },
    { id: 'learning-3', statement: 'Não criar lembretes durante o horário de almoço.', scopeType: 'global', status: 'paused', confidence: 0.81, evidenceCount: 3, inferred: true, lastUsedAt: '8 jul', updatedAt: '10 jul' },
    { id: 'learning-4', statement: 'Mover automaticamente qualquer ideia para Em andamento.', scopeType: 'global', status: 'rejected', confidence: 0.72, evidenceCount: 2, inferred: true, updatedAt: '4 jul' },
  ],
  proposals: [
    { id: 'proposal-1', title: 'Adiar revisão semanal', description: 'Mover a revisão para amanhã às 09:00 e ajustar o lembrete vinculado.', actionType: 'reschedule_task', risk: 'low', reversible: true, status: 'pending', evidence: [{ id: 'msg-41', label: 'Mensagem enviada hoje às 10:22' }] },
  ],
  assistantInbox: [
    { id: 'inbox-task-1', kind: 'task', title: 'Possível tarefa: confirmar fornecedor', description: 'Atlas encontrou uma solicitação explícita na conversa Operações.', confidence: 0.68, createdAt: 'há 12 min', targetId: 'focus-2' },
    { id: 'inbox-conflict-1', kind: 'conflict', title: 'Prazo diferente no Trello', description: 'O cartão mostra amanhã, mas a conversa cita hoje às 17:00.', createdAt: 'há 28 min', targetId: 'focus-1' },
    { id: 'inbox-duplicate-1', kind: 'duplicate', title: 'Dois cartões parecem iguais', description: '“Revisar apresentação Aurora” pode ser duplicata da tarefa principal.', confidence: 0.91, createdAt: 'há 1 h', targetId: 'focus-1' },
    { id: 'inbox-learning-1', kind: 'learning', title: 'Novo padrão observado', description: 'Você costuma adiar revisões longas para o início da manhã.', confidence: 0.86, createdAt: 'ontem', targetId: 'learning-2' },
  ],
  activities: [
    { id: 'activity-1', title: 'Nova decisão capturada', detail: 'Equipe Produto · WhatsApp', at: 'há 8 min', kind: 'whatsapp' },
    { id: 'activity-2', title: 'Cartão movido para Em andamento', detail: 'Revisar apresentação final', at: 'há 32 min', kind: 'trello' },
    { id: 'activity-3', title: 'Conexão criada', detail: 'Projeto Aurora ↔ Lucas Mendes', at: 'há 1 h', kind: 'ai' },
    { id: 'activity-4', title: 'Nota atualizada', detail: 'Decisões da semana', at: 'há 2 h', kind: 'note' },
  ],
  notes: Object.values(demoNotes).map(({ contentMarkdown: _content, ...note }) => note),
  inboxItems: Object.values(demoNotes).slice(0, 2).map(({ contentMarkdown: _content, ...note }) => note),
  projects: [
    { id: 'project-1', name: 'Projeto Aurora', description: 'Lançamento da nova experiência de produto.', progress: 72, status: 'active', noteCount: 18, people: ['MC', 'LM', 'AS'], accent: '#a98bf7' },
    { id: 'project-2', name: 'Rotina operacional', description: 'Acompanhamento diário e automações do time.', progress: 48, status: 'active', noteCount: 11, people: ['MC', 'RL'], accent: '#6fcfbd' },
    { id: 'project-3', name: 'Narrativa de marca', description: 'Posicionamento, linguagem e referências do Atlas.', progress: 34, status: 'paused', noteCount: 9, people: ['MC', 'AS'], accent: '#e7ad6f' },
  ],
  people: [
    { id: 'person-1', name: 'Lucas Mendes', role: 'Produto', initials: 'LM', lastContext: 'Apresentação do Projeto Aurora', noteCount: 12, accent: '#a98bf7' },
    { id: 'person-2', name: 'Ana Souza', role: 'Design', initials: 'AS', lastContext: 'Revisão do novo onboarding', noteCount: 8, accent: '#e7ad6f' },
    { id: 'person-3', name: 'Rafael Lima', role: 'Operações', initials: 'RL', lastContext: 'Automação do resumo diário', noteCount: 6, accent: '#6fcfbd' },
  ],
  trelloCards: [
    { id: 'card-1', title: 'Revisar apresentação final', list: 'Em andamento', due: 'Hoje, 14:00', labels: ['Aurora', 'Prioridade'] },
    { id: 'card-2', title: 'Definir cópia do onboarding', list: 'A fazer', due: 'Amanhã', labels: ['Produto'] },
    { id: 'card-3', title: 'Automatizar resumo diário', list: 'Em revisão', due: '16 jul', labels: ['Operações', 'Automação'] },
    { id: 'card-4', title: 'Organizar referências de marca', list: 'A fazer', due: null, labels: ['Marca'] },
  ],
  automations: [
    { id: 'auto-1', name: 'Resumo diário', description: 'Envia para você as prioridades abertas às 08:00.', enabled: true, lastRun: 'Hoje, 08:00', status: 'healthy' },
    { id: 'auto-2', name: 'Capturar decisões', description: 'Transforma mensagens marcadas em notas conectadas.', enabled: true, lastRun: 'há 8 min', status: 'healthy' },
    { id: 'auto-3', name: 'Lembrete de cartões', description: 'Avisa quando um cartão importante estiver perto do prazo.', enabled: false, lastRun: '10 jul', status: 'paused' },
  ],
  graph: {
    nodes: [
      { id: 'atlas', label: 'Atlas', kind: 'topic', size: 18 },
      { id: 'aurora', label: 'Projeto Aurora', kind: 'project', size: 16 },
      { id: 'lucas', label: 'Lucas Mendes', kind: 'person', size: 12 },
      { id: 'ana', label: 'Ana Souza', kind: 'person', size: 11 },
      { id: 'decisoes', label: 'Decisões da semana', kind: 'note', size: 13 },
      { id: 'onboarding', label: 'Novo onboarding', kind: 'note', size: 12 },
      { id: 'operacoes', label: 'Rotina operacional', kind: 'project', size: 15 },
      { id: 'marca', label: 'Narrativa de marca', kind: 'topic', size: 12 },
      { id: 'resumo', label: 'Resumo diário', kind: 'note', size: 10 },
    ],
    edges: [
      { source: 'atlas', target: 'aurora' },
      { source: 'atlas', target: 'onboarding' },
      { source: 'atlas', target: 'marca' },
      { source: 'aurora', target: 'lucas' },
      { source: 'aurora', target: 'ana' },
      { source: 'aurora', target: 'decisoes' },
      { source: 'onboarding', target: 'ana' },
      { source: 'operacoes', target: 'resumo' },
      { source: 'operacoes', target: 'lucas' },
    ],
  },
  stats: {
    inbox: 7,
    notes: 126,
    connections: 384,
    openTasks: 12,
  },
  integrationStatus: { whatsappConnected: true, trelloConnected: true, monitoredChats: 4 },
  settings: { timezone: 'America/Sao_Paulo', reminderTimes: ['08:00', '18:00'], notifySelf: true },
  aiUsage: {
    period: 'Últimos 30 dias',
    calls: 1842,
    tokens: 628400,
    latencyMs: 1260,
    errors: 17,
    errorRate: 0.92,
    costCents: 1837,
  },
};

import {
  Activity as ActivityIcon,
  ArrowUpRight,
  Bot,
  Brain,
  Ban,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  FilePlus2,
  Filter,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Merge,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  SquareKanban,
  Tag,
  Users,
  Wifi,
  RefreshCw,
} from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { Chat, FeedbackAction, LearningAction, LearningEvidence, Note, NavId, TaskAction, WorkspaceData } from '../types';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { viewMeta } from './navigation';
import { LearningsView, PersonalInboxView, PersonalTodayView } from './PersonalAssistantViews';
import { MonitoredChatsView } from './MonitoredChatsView';

const KnowledgeGraph = lazy(() => import('../components/KnowledgeGraph').then((module) => ({ default: module.KnowledgeGraph })));
const NoteEditor = lazy(() => import('../components/NoteEditor').then((module) => ({ default: module.NoteEditor })));

interface ViewContentProps {
  activeView: NavId;
  data: WorkspaceData;
  selectedNoteId: string | null;
  note: Note | null;
  noteLoading: boolean;
  noteError: string | null;
  onSelectNote(id: string): void;
  onNewNote(): void;
  onSaveNote(id: string, input: { title: string; contentMarkdown: string }): Promise<Note>;
  onRetryNote(): void;
  onToggleAutomation(id: string, enabled: boolean): void;
  onUpdateSettings(input: { reminderTimes?: string[]; notifySelf?: boolean }): void;
  onFeedback(itemId: string, action: FeedbackAction, context: 'inbox' | 'activity'): void;
  onOpenTask(id: string): void;
  onTaskAction(id: string, input: { action: TaskAction; targetTaskId?: string; snoozeUntil?: string; dueAt?: string }): void;
  onCommitmentAction(id: string, input: { status?: 'open' | 'waiting' | 'fulfilled' | 'cancelled'; dueAt?: string | null; nextFollowUpAt?: string | null }): void;
  onLearningAction(id: string, action: LearningAction, statement?: string): void;
  onLoadLearningEvidence(id: string): Promise<LearningEvidence[]>;
  onReplan(): void;
  onCreateAutomation(input: { kind: 'briefing' | 'deadline' | 'overdue' | 'follow_up' | 'stale_task' | 'weekly_review'; time?: string }): void;
  onLoadChats(): Promise<Chat[]>;
  onToggleChat(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }>;
  onToggleAllChats(enabled: boolean): Promise<{ updated: number }>;
}

export function ViewContent(props: ViewContentProps) {
  const meta = viewMeta[props.activeView];
  const Icon = meta.icon;
  return (
    <div className={`view view--${props.activeView}`}>
      <header className="view-heading">
        <div>
          <span className="eyebrow"><Icon size={14} /> {meta.eyebrow}</span>
          <h1>{props.activeView === 'today' ? props.data.greeting : meta.title}</h1>
          <p>{meta.description}</p>
        </div>
        <div className="view-heading__actions">
          {props.activeView === 'brain' && <button className="button button--primary button--small" type="button" onClick={props.onNewNote}><FilePlus2 size={15} /> Nova nota</button>}
          {['inbox', 'projects', 'people', 'trello'].includes(props.activeView) && <button className="button button--secondary button--small" type="button"><Filter size={14} /> Filtrar</button>}
          <button className="icon-button" type="button" aria-label="Mais opções"><MoreHorizontal size={18} /></button>
        </div>
      </header>

      {props.activeView === 'today' && <PersonalTodayView data={props.data} onSelectNote={props.onSelectNote} onOpenTask={props.onOpenTask} onTaskAction={props.onTaskAction} onCommitmentAction={props.onCommitmentAction} onReplan={props.onReplan} />}
      {props.activeView === 'inbox' && <PersonalInboxView data={props.data} onOpenTask={props.onOpenTask} onFeedback={props.onFeedback} onLearningAction={props.onLearningAction} />}
      {props.activeView === 'chats' && <MonitoredChatsView onLoadChats={props.onLoadChats} onToggleChat={props.onToggleChat} onToggleAll={props.onToggleAllChats} />}
      {props.activeView === 'brain' && <BrainView {...props} />}
      {props.activeView === 'graph' && <Suspense fallback={<div className="center-state"><Spinner label="Preparando o grafo" /></div>}><KnowledgeGraph nodes={props.data.graph.nodes} edges={props.data.graph.edges} onOpenNode={props.onSelectNote} /></Suspense>}
      {props.activeView === 'projects' && <ProjectsView data={props.data} />}
      {props.activeView === 'people' && <PeopleView data={props.data} />}
      {props.activeView === 'trello' && <TrelloView data={props.data} />}
      {props.activeView === 'learnings' && <LearningsView learnings={props.data.learnings ?? []} onAction={props.onLearningAction} onLoadEvidence={props.onLoadLearningEvidence} />}
      {props.activeView === 'automations' && <AutomationsView data={props.data} onToggle={props.onToggleAutomation} onCreate={props.onCreateAutomation} />}
      {props.activeView === 'settings' && <SettingsView data={props.data} onUpdate={props.onUpdateSettings} />}
    </div>
  );
}

function TodayView({ data, onSelectNote, onFeedback }: { data: WorkspaceData; onSelectNote(id: string): void; onFeedback(itemId: string, action: FeedbackAction, context: 'activity'): void }) {
  return (
    <div className="today-layout">
      <section className="stat-strip" aria-label="Resumo">
        <article><span className="stat-icon stat-icon--purple"><MessageCircle size={17} /></span><div><strong>{data.stats.inbox}</strong><small>itens no inbox</small></div><ChevronRight size={15} /></article>
        <article><span className="stat-icon stat-icon--mint"><Brain size={17} /></span><div><strong>{data.stats.notes}</strong><small>notas conectadas</small></div><ChevronRight size={15} /></article>
        <article><span className="stat-icon stat-icon--amber"><Link2 size={17} /></span><div><strong>{data.stats.connections}</strong><small>conexões ativas</small></div><ChevronRight size={15} /></article>
        <article><span className="stat-icon stat-icon--blue"><SquareKanban size={17} /></span><div><strong>{data.stats.openTasks}</strong><small>tarefas abertas</small></div><ChevronRight size={15} /></article>
      </section>

      <div className="today-columns">
        <section className="surface focus-card">
          <header className="section-heading"><div><span className="section-kicker"><Sparkles size={14} /> Foco recomendado</span><h2>O que move seu dia</h2></div><button className="text-link" type="button">Ver todas</button></header>
          {data.focus.length ? <div className="focus-list">{data.focus.map((item, index) => (
            <article key={item.id} className="focus-row">
              <button type="button" className="task-check" aria-label={`Concluir ${item.title}`}><Circle size={18} /></button>
              <span className={`priority-dot priority-dot--${item.priority}`} />
              <div><strong>{item.title}</strong><span>{item.project}</span></div>
              <small className={index === 0 ? 'is-urgent' : ''}><Clock3 size={12} /> {item.dueLabel}</small>
            </article>
          ))}</div> : <EmptyState title="Nada urgente por agora" description="Quando uma tarefa exigir atenção, ela aparece aqui." />}
          <footer className="focus-insight"><span className="ai-avatar"><Sparkles size={14} /></span><p><strong>Leitura do Atlas:</strong> {data.briefing}</p></footer>
        </section>

        <section className="surface activity-card">
          <header className="section-heading"><div><span className="section-kicker"><ActivityIcon size={14} /> Atividade</span><h2>Movimentos recentes</h2></div></header>
          {data.activities.length ? <div className="activity-list">{data.activities.map((item) => (
            <article key={item.id}>
              <span className={`activity-kind activity-kind--${item.kind}`}>{item.kind === 'whatsapp' ? <MessageCircle size={14} /> : item.kind === 'trello' ? <SquareKanban size={14} /> : item.kind === 'ai' ? <Sparkles size={14} /> : <Brain size={14} />}</span>
              <div><strong>{item.title}</strong><span>{item.detail}</span></div><small>{item.at}</small>
              <FeedbackActions itemId={item.id} context="activity" onFeedback={onFeedback} compact />
            </article>
          ))}</div> : <EmptyState title="Tudo quieto" description="As novas capturas e conexões aparecem aqui." />}
        </section>
      </div>

      <section className="notes-section">
        <header className="section-heading"><div><span className="section-kicker"><Brain size={14} /> Memória recente</span><h2>Continue de onde parou</h2></div><button className="text-link" type="button">Abrir cérebro <ArrowUpRight size={13} /></button></header>
        {data.notes.length ? <div className="note-grid">{data.notes.slice(0, 3).map((note) => <NoteCard key={note.id} note={note} onClick={() => onSelectNote(note.id)} />)}</div> : <EmptyState title="Nenhuma nota ainda" description="Capture sua primeira ideia para começar a construir conexões." />}
      </section>
    </div>
  );
}

function NoteCard({ note, onClick }: { note: WorkspaceData['notes'][number]; onClick(): void }) {
  return (
    <button type="button" className="note-card" onClick={onClick}>
      <span className="note-card__meta"><span>{note.source === 'whatsapp' ? <MessageCircle size={12} /> : note.source === 'trello' ? <SquareKanban size={12} /> : <Brain size={12} />}{note.source === 'whatsapp' ? 'WhatsApp' : note.source === 'trello' ? 'Trello' : 'Nota'}</span><small>{note.updatedAt}</small></span>
      <strong>{note.title}</strong><p>{note.excerpt}</p>
      <span className="tag-row">{note.tags.slice(0, 2).map((tag) => <em key={tag}>#{tag}</em>)}</span>
    </button>
  );
}

function InboxView({ data, onSelectNote, onFeedback }: { data: WorkspaceData; onSelectNote(id: string): void; onFeedback(itemId: string, action: FeedbackAction, context: 'inbox'): void }) {
  const items = data.inboxItems ?? data.notes;
  if (!items.length) return <EmptyState title="Seu inbox está limpo" description="Mensagens e capturas que precisam de organização aparecerão aqui." />;
  return (
    <div className="inbox-layout">
      <div className="inbox-toolbar"><span><strong>{data.stats.inbox}</strong> itens aguardando revisão</span><button className="text-link" type="button"><CheckCircle2 size={14} /> Marcar tudo como revisado</button></div>
      <div className="inbox-list">{items.map((note, index) => (
        <article className="inbox-item" key={note.id}>
        <button type="button" className="inbox-row" onClick={() => onSelectNote(note.id)}>
          <span className="inbox-unread">{index < 2 && <i />}</span>
          <span className={`source-badge source-badge--${note.source || 'manual'}`}>{note.source === 'whatsapp' ? <MessageCircle size={15} /> : note.source === 'trello' ? <SquareKanban size={15} /> : <Brain size={15} />}</span>
          <span className="inbox-row__content"><strong>{note.title}</strong><small>{note.excerpt}</small><span>{note.tags.map((tag) => <em key={tag}>#{tag}</em>)}</span></span>
          <time>{note.updatedAt}</time><ChevronRight size={16} />
        </button>
        <FeedbackActions itemId={note.id} context="inbox" onFeedback={onFeedback} />
        </article>
      ))}</div>
    </div>
  );
}

function BrainView(props: ViewContentProps) {
  return (
    <div className="brain-layout">
      <aside className="note-browser">
        <label className="search-field"><Search size={15} /><input placeholder="Buscar notas" /></label>
        <div className="note-browser__heading"><span>{props.data.notes.length} notas</span><button type="button" aria-label="Ordenar notas"><Settings2 size={14} /></button></div>
        <div className="note-browser__list">
          {props.data.notes.length ? props.data.notes.map((item) => (
            <button type="button" key={item.id} className={props.selectedNoteId === item.id ? 'is-active' : ''} onClick={() => props.onSelectNote(item.id)}>
              <strong>{item.title}</strong><span>{item.excerpt}</span><small>{item.updatedAt}</small>
            </button>
          )) : <EmptyState title="Comece uma nota" description="Suas ideias conectadas aparecerão aqui." action={<button className="button button--primary button--small" onClick={props.onNewNote}><Plus size={14} /> Nova nota</button>} />}
        </div>
      </aside>
      <section className="brain-editor-stage">
        {props.noteLoading ? <div className="center-state"><Spinner label="Abrindo nota" /></div> : props.noteError ? <ErrorState message={props.noteError} onRetry={props.onRetryNote} /> : props.note ? <Suspense fallback={<div className="center-state"><Spinner label="Preparando o editor" /></div>}><NoteEditor note={props.note} onSave={props.onSaveNote} /></Suspense> : <EmptyState title="Selecione uma nota" description="Escolha uma nota ao lado ou crie uma nova para começar." />}
      </section>
    </div>
  );
}

function ProjectsView({ data }: { data: WorkspaceData }) {
  if (!data.projects.length) return <EmptyState title="Nenhum projeto ainda" description="Agrupe notas, tarefas e pessoas em torno de um resultado." />;
  return <div className="project-grid">{data.projects.map((project) => (
    <article className="project-card" key={project.id} style={{ '--project-accent': project.accent } as React.CSSProperties}>
      <header><span className="project-symbol">{project.name.slice(0, 1)}</span><span className={`status-pill status-pill--${project.status}`}>{project.status === 'active' ? 'Ativo' : project.status === 'paused' ? 'Pausado' : 'Concluído'}</span><button className="icon-button" type="button"><MoreHorizontal size={16} /></button></header>
      <h2>{project.name}</h2><p>{project.description}</p>
      <div className="project-progress"><span><small>Progresso</small><strong>{project.progress}%</strong></span><div><i style={{ width: `${project.progress}%` }} /></div></div>
      <footer><span className="stacked-avatars">{project.people.map((person) => <i key={person}>{person}</i>)}</span><span><Brain size={13} /> {project.noteCount} notas</span></footer>
    </article>
  ))}<button type="button" className="project-card project-card--new"><Plus size={24} /><strong>Novo projeto</strong><span>Conecte um novo objetivo</span></button></div>;
}

function PeopleView({ data }: { data: WorkspaceData }) {
  if (!data.people.length) return <EmptyState title="Nenhuma pessoa conectada" description="Pessoas citadas nas suas notas e conversas aparecem aqui." />;
  return <div className="people-grid">{data.people.map((person) => (
    <article className="person-card" key={person.id}>
      <span className="person-avatar" style={{ background: `${person.accent}22`, color: person.accent }}>{person.initials}</span>
      <div><h2>{person.name}</h2><span>{person.role}</span></div>
      <p><small>Contexto mais recente</small>{person.lastContext}</p>
      <footer><span><Brain size={13} /> {person.noteCount} notas</span><button type="button">Abrir contexto <ArrowUpRight size={13} /></button></footer>
    </article>
  ))}</div>;
}

function TrelloView({ data }: { data: WorkspaceData }) {
  const lists = [...new Set(data.trelloCards.map((card) => card.list))];
  if (!data.trelloCards.length) return <EmptyState title="Nenhum cartão encontrado" description="Conecte uma lista no Trello para acompanhar tarefas com contexto." />;
  return (
    <div className="trello-board">
      {lists.map((list) => <section className="trello-column" key={list}><header><span><i />{list}</span><small>{data.trelloCards.filter((card) => card.list === list).length}</small><button type="button"><Plus size={14} /></button></header><div>{data.trelloCards.filter((card) => card.list === list).map((card) => (
        <article className="trello-card" key={card.id}><div className="trello-labels">{card.labels.map((label) => <span key={label}>{label}</span>)}</div><strong>{card.title}</strong>{card.due && <small><CalendarClock size={13} /> {card.due}</small>}<footer><span className="mini-avatar">MC</span><button type="button"><MoreHorizontal size={15} /></button></footer></article>
      ))}</div></section>)}
    </div>
  );
}

function AutomationsView({ data, onToggle, onCreate }: { data: WorkspaceData; onToggle(id: string, enabled: boolean): void; onCreate(input: { kind: 'briefing' | 'deadline' | 'overdue' | 'follow_up' | 'stale_task' | 'weekly_review'; time?: string }): void }) {
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<'briefing' | 'deadline' | 'overdue' | 'follow_up' | 'stale_task' | 'weekly_review'>('briefing');
  const [time, setTime] = useState('08:00');
  return <div className="automation-layout"><section className="automation-hero"><span><Bot size={22} /></span><div><h2>Rotinas que trabalham em silêncio</h2><p>Atlas observa apenas as fontes autorizadas e executa cada regra com rastreabilidade.</p></div><button className="button button--primary button--small" type="button" onClick={() => setCreating((value) => !value)}><Plus size={14} /> Nova automação</button></section>{creating && <section className="automation-creator" aria-label="Criar automação"><label><span>Tipo de rotina</span><select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="briefing">Briefing pessoal</option><option value="deadline">Prazo próximo</option><option value="overdue">Item vencido</option><option value="follow_up">Resposta pendente</option><option value="stale_task">Tarefa parada</option><option value="weekly_review">Revisão semanal</option></select></label>{['briefing', 'weekly_review'].includes(kind) && <label><span>Horário</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>}<button type="button" className="button button--primary button--small" onClick={() => { onCreate({ kind, ...(['briefing', 'weekly_review'].includes(kind) ? { time } : {}) }); setCreating(false); }}>Criar rotina</button><button type="button" className="button button--ghost button--small" onClick={() => setCreating(false)}>Cancelar</button></section>}<AiUsagePanel usage={data.aiUsage} />{data.automations.length ? <div className="automation-list">{data.automations.map((automation) => (
    <article key={automation.id}><span className={`automation-icon automation-icon--${automation.status}`}><Bot size={18} /></span><div><strong>{automation.name}</strong><p>{automation.description}</p><small><Wifi size={12} /> {automation.lastRun ? `Última execução: ${automation.lastRun}` : 'Ainda não executada'}</small></div><span className={`status-pill status-pill--${automation.status}`}>{automation.status === 'healthy' ? 'Saudável' : automation.status === 'attention' ? 'Atenção' : 'Pausada'}</span><label className="switch"><input type="checkbox" checked={automation.enabled} onChange={(event) => onToggle(automation.id, event.target.checked)} /><span /></label><button className="icon-button"><MoreHorizontal size={16} /></button></article>
  ))}</div> : <EmptyState title="Nenhuma automação criada" description="Crie uma rotina suportada para agir no momento certo." />}</div>;
}

function FeedbackActions({ itemId, context, onFeedback, compact = false }: { itemId: string; context: 'inbox' | 'activity'; onFeedback(itemId: string, action: FeedbackAction, context: 'inbox' | 'activity'): void; compact?: boolean }) {
  const actions = [
    { id: 'edit' as const, label: 'Editar', icon: Pencil },
    { id: 'not_task' as const, label: 'Não é tarefa', icon: Ban },
    { id: 'merge' as const, label: 'Mesclar', icon: Merge },
    { id: 'reprocess' as const, label: 'Reprocessar', icon: RefreshCw },
  ];
  return <div className={`feedback-actions ${compact ? 'feedback-actions--compact' : ''}`} aria-label="Corrigir interpretação da IA">{actions.map((action) => { const Icon = action.icon; return <button type="button" key={action.id} onClick={() => onFeedback(itemId, action.id, context)}><Icon size={compact ? 11 : 12} /><span>{action.label}</span></button>; })}</div>;
}

function AiUsagePanel({ usage }: { usage: WorkspaceData['aiUsage'] }) {
  if (!usage) return <section className="ai-usage"><header><div><span className="section-kicker"><Sparkles size={13} /> Uso de IA</span><h2>Métricas indisponíveis</h2></div></header><p className="ai-usage__empty">A API ainda não retornou métricas para este período.</p></section>;
  const formatNumber = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
  return <section className="ai-usage"><header><div><span className="section-kicker"><Sparkles size={13} /> Uso de IA</span><h2>Operação e custo</h2></div><small>{usage.period}</small></header><div className="ai-usage__grid"><article><span>Chamadas</span><strong>{usage.calls.toLocaleString('pt-BR')}</strong><small>requisições</small></article><article><span>Tokens</span><strong>{formatNumber.format(usage.tokens)}</strong><small>entrada + saída</small></article><article><span>Latência</span><strong>{(usage.latencyMs / 1000).toFixed(2)}s</strong><small>média</small></article><article><span>Erros</span><strong>{usage.errorRate.toFixed(2)}%</strong><small>{usage.errors} falhas</small></article><article><span>Custo</span><strong>{(usage.costCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' })}</strong><small>estimado</small></article></div></section>;
}

function SettingsView({ data, onUpdate }: { data: WorkspaceData; onUpdate(input: { reminderTimes?: string[]; notifySelf?: boolean }): void }) {
  const status = data.integrationStatus;
  const settings = data.settings ?? { timezone: 'America/Sao_Paulo', reminderTimes: ['08:00', '18:00'], notifySelf: true };
  const morning = settings.reminderTimes[0] ?? '08:00';
  const evening = settings.reminderTimes[1] ?? '18:00';
  return (
    <div className="settings-layout">
      <section className="settings-section"><header><div><h2>Integrações</h2><p>Fontes conectadas ao seu espaço.</p></div></header><div className="integration-list"><article><span className="integration-logo integration-logo--whatsapp"><MessageCircle size={20} /></span><div><strong>WhatsApp pessoal · somente leitura</strong><small>{status?.whatsappConnected ? `${status.monitoredChats} conversa${status.monitoredChats === 1 ? '' : 's'} acompanhada${status.monitoredChats === 1 ? '' : 's'}` : 'Aguardando conexão'}</small></div><span className={status?.whatsappConnected ? 'connected-pill' : 'status-pill status-pill--paused'}>{status?.whatsappConnected && <Check size={12} />} {status?.whatsappConnected ? 'Conectado' : 'Desconectado'}</span></article><article><span className="integration-logo integration-logo--trello"><SquareKanban size={20} /></span><div><strong>Trello</strong><small>{status?.trelloConnected ? 'Quadro principal configurado' : 'Aguardando autorização'}</small></div><span className={status?.trelloConnected ? 'connected-pill' : 'status-pill status-pill--paused'}>{status?.trelloConnected && <Check size={12} />} {status?.trelloConnected ? 'Conectado' : 'Desconectado'}</span></article></div></section>
      <section className="settings-section"><header><div><h2>Mensagens e notificações</h2><p>Controle quando Atlas fala com você.</p></div></header><div className="setting-rows"><label><span><strong>Receber lembretes do Atlas</strong><small>O número central envia mensagens somente para o telefone identificado no seu QR pessoal.</small></span><span className="switch"><input type="checkbox" checked={settings.notifySelf} onChange={(event) => onUpdate({ notifySelf: event.target.checked })} /><i /></span></label><label><span><strong>Briefing da manhã</strong><small>Prioridades e prazos no início do dia.</small></span><input type="time" value={morning} onChange={(event) => onUpdate({ reminderTimes: [event.target.value, evening] })} /></label><label><span><strong>Briefing da tarde</strong><small>Pendências e respostas antes de encerrar o dia.</small></span><input type="time" value={evening} onChange={(event) => onUpdate({ reminderTimes: [morning, event.target.value] })} /></label></div></section>
      <section className="settings-section"><header><div><h2>Privacidade</h2><p>Seus dados, suas regras.</p></div></header><div className="privacy-settings"><article><span><Users size={18} /></span><div><strong>Conversas acompanhadas</strong><p>{status?.monitoredChats ?? 0} conversa{status?.monitoredChats === 1 ? '' : 's'} autorizada{status?.monitoredChats === 1 ? '' : 's'}. Todo o restante é ignorado.</p></div></article><article><span><Tag size={18} /></span><div><strong>Exportação</strong><p>A exportação completa dos dados está prevista para uma versão futura.</p></div></article></div></section>
    </div>
  );
}

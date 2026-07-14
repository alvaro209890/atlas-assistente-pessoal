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
  ExternalLink,
  FilePlus2,
  Filter,
  Link2,
  MessageCircle,
  MessageSquareText,
  MoreHorizontal,
  Merge,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  SquareKanban,
  Tag,
  Trash2,
  Users,
  Wifi,
  RefreshCw,
  X,
} from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { Chat, CreateTaskInput, FeedbackAction, LearningAction, LearningEvidence, Note, NavId, TaskAction, TrelloCard, WorkspaceData } from '../types';
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
  conversationLoading: boolean;
  conversationError: string | null;
  onRefreshConversations(): void;
  onUpdateChat(id: string, input: { enabled?: boolean; groupId?: string | null }): void;
  onCreateChatGroup(input: { name: string; description?: string }): void;
  onDeleteChatGroup(id: string): void;
  onCreateTask(input: CreateTaskInput): Promise<unknown>;
  onRefreshWorkspace(): void;
  onFeedback(itemId: string, action: FeedbackAction, context: 'inbox' | 'activity'): void;
  onOpenTask(id: string): void;
  onTaskAction(id: string, input: { action: TaskAction; targetTaskId?: string; snoozeUntil?: string; dueAt?: string; comment?: string }): void;
  onCommitmentAction(id: string, input: { status?: 'open' | 'waiting' | 'fulfilled' | 'cancelled'; dueAt?: string | null; nextFollowUpAt?: string | null }): void;
  onLearningAction(id: string, action: LearningAction, statement?: string): void;
  onTeachAtlas(input: { statement: string; title?: string }): void;
  onLoadLearningEvidence(id: string): Promise<LearningEvidence[]>;
  onReplan(): void;
  onCreateAutomation(input: { kind: 'briefing' | 'deadline' | 'overdue' | 'follow_up' | 'stale_task' | 'weekly_review'; time?: string }): void;
  onLoadChats(): Promise<Chat[]>;
  onToggleChat(id: string, enabled: boolean): Promise<unknown>;
  onToggleAllChats(enabled: boolean): Promise<{ updated: number }>;
}

export function ViewContent(props: ViewContentProps) {
  const [trelloFiltersOpen, setTrelloFiltersOpen] = useState(false);
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
          {props.activeView === 'trello' && <button className="button button--secondary button--small" type="button" aria-pressed={trelloFiltersOpen} onClick={() => setTrelloFiltersOpen((open) => !open)}><Filter size={14} /> Filtrar</button>}
          {props.activeView === 'trello' && <button className="icon-button" type="button" aria-label="Atualizar cartões do Trello" onClick={props.onRefreshWorkspace}><RefreshCw size={17} /></button>}
        </div>
      </header>

      {props.activeView === 'today' && <PersonalTodayView data={props.data} onSelectNote={props.onSelectNote} onOpenTask={props.onOpenTask} onTaskAction={props.onTaskAction} onCommitmentAction={props.onCommitmentAction} onReplan={props.onReplan} />}
      {props.activeView === 'inbox' && <PersonalInboxView data={props.data} onOpenTask={props.onOpenTask} onFeedback={props.onFeedback} onLearningAction={props.onLearningAction} />}
      {props.activeView === 'chats' && <MonitoredChatsView onLoadChats={props.onLoadChats} onToggleChat={props.onToggleChat} onToggleAll={props.onToggleAllChats} />}
      {props.activeView === 'brain' && <BrainView {...props} />}
      {props.activeView === 'graph' && <Suspense fallback={<div className="center-state"><Spinner label="Preparando o grafo" /></div>}><KnowledgeGraph nodes={props.data.graph.nodes} edges={props.data.graph.edges} onOpenNode={props.onSelectNote} /></Suspense>}
      {props.activeView === 'projects' && <ProjectsView data={props.data} />}
      {props.activeView === 'people' && <PeopleView data={props.data} />}
      {props.activeView === 'trello' && <TrelloView data={props.data} filtersOpen={trelloFiltersOpen} onCreateTask={props.onCreateTask} onOpenTask={props.onOpenTask} onTaskAction={props.onTaskAction} />}
      {props.activeView === 'learnings' && <LearningsView learnings={props.data.learnings ?? []} onAction={props.onLearningAction} onTeach={props.onTeachAtlas} onLoadEvidence={props.onLoadLearningEvidence} />}
      {props.activeView === 'automations' && <AutomationsView data={props.data} onToggle={props.onToggleAutomation} onCreate={props.onCreateAutomation} />}
      {props.activeView === 'settings' && <SettingsView {...props} />}
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

const taskStatusForTrelloList = (list: string, cards: TrelloCard[]): CreateTaskInput['status'] => {
  const role = cards.find((card) => card.list === list && card.listRole)?.listRole;
  if (role === 'inProgress') return 'in_progress';
  if (role === 'paused') return 'paused';
  if (role === 'completed') return 'done';
  if (role === 'inbox') return 'open';
  const normalized = list.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');
  if (/conclu|finaliz|done/.test(normalized)) return 'done';
  if (/andamento|progres|doing/.test(normalized)) return 'in_progress';
  if (/paus|aguard|blocked/.test(normalized)) return 'paused';
  return 'open';
};

const formatTrelloDue = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
};

function TrelloView({
  data,
  filtersOpen,
  onCreateTask,
  onOpenTask,
  onTaskAction,
}: {
  data: WorkspaceData;
  filtersOpen: boolean;
  onCreateTask(input: CreateTaskInput): Promise<unknown>;
  onOpenTask(id: string): void;
  onTaskAction(id: string, input: { action: TaskAction; comment?: string }): void;
}) {
  const [search, setSearch] = useState('');
  const [listFilter, setListFilter] = useState('all');
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const lists = [...new Set(data.trelloCards.map((card) => card.list))];
  if (!data.trelloCards.length) return <EmptyState title="Nenhum cartão encontrado" description="Conecte uma lista no Trello para acompanhar tarefas com contexto." />;
  const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR');
  const visibleLists = listFilter === 'all' ? lists : lists.filter((list) => list === listFilter);

  const createInList = async (list: string) => {
    const title = newTaskTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      await onCreateTask({ title, status: taskStatusForTrelloList(list, data.trelloCards) });
      setNewTaskTitle('');
      setCreatingIn(null);
    } finally {
      setCreating(false);
    }
  };

  const sendComment = (card: TrelloCard) => {
    const text = comment.trim();
    if (!card.taskId || !text) return;
    onTaskAction(card.taskId, { action: 'comment', comment: text });
    setComment('');
    setCommenting(null);
    setOpenMenu(null);
  };

  return (
    <div className="trello-view">
      {filtersOpen && <div className="trello-toolbar" aria-label="Filtros do Trello"><label><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar cartão" aria-label="Buscar cartão" /></label><select value={listFilter} onChange={(event) => setListFilter(event.target.value)} aria-label="Filtrar por lista"><option value="all">Todas as listas</option>{lists.map((list) => <option value={list} key={list}>{list}</option>)}</select><span>{data.trelloCards.filter((card) => !normalizedSearch || card.title.toLocaleLowerCase('pt-BR').includes(normalizedSearch)).length} cartões</span></div>}
      <div className="trello-board">
        {visibleLists.map((list) => {
          const cards = data.trelloCards.filter((card) => card.list === list && (!normalizedSearch || card.title.toLocaleLowerCase('pt-BR').includes(normalizedSearch)));
          return <section className="trello-column" key={list}><header><span><i />{list}</span><small>{cards.length}</small><button type="button" aria-label={`Criar tarefa em ${list}`} onClick={() => { setCreatingIn((current) => current === list ? null : list); setNewTaskTitle(''); }}><Plus size={14} /></button></header>
            {creatingIn === list && <form className="trello-create-card" onSubmit={(event) => { event.preventDefault(); void createInList(list); }}><input autoFocus value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="Título da nova tarefa" aria-label={`Título da nova tarefa em ${list}`} /><div><button type="submit" disabled={!newTaskTitle.trim() || creating}><Check size={13} /> {creating ? 'Criando' : 'Criar'}</button><button type="button" onClick={() => setCreatingIn(null)} aria-label="Cancelar criação"><X size={13} /></button></div></form>}
            <div>{cards.map((card) => (
              <article className="trello-card" key={card.id}>
                <div className="trello-labels">{card.labels.map((label) => <span key={label}>{label}</span>)}</div>
                <button type="button" className="trello-card__title" disabled={!card.taskId} onClick={() => card.taskId && onOpenTask(card.taskId)}>{card.title}</button>
                {card.due && <small><CalendarClock size={13} /> {formatTrelloDue(card.due)}</small>}
                <footer><span className="mini-avatar">A</span><button type="button" aria-label={`Ações de ${card.title}`} aria-expanded={openMenu === card.id} onClick={() => { setOpenMenu((current) => current === card.id ? null : card.id); setCommenting(null); }}><MoreHorizontal size={15} /></button></footer>
                {openMenu === card.id && <div className="trello-card-menu">
                  <button type="button" disabled={!card.taskId} onClick={() => { if (card.taskId) onOpenTask(card.taskId); setOpenMenu(null); }}><SquareKanban size={13} /> Abrir detalhes</button>
                  <button type="button" disabled={!card.taskId || card.listRole === 'completed'} onClick={() => { if (card.taskId) onTaskAction(card.taskId, { action: 'complete' }); setOpenMenu(null); }}><CheckCircle2 size={13} /> Concluir tarefa</button>
                  <button type="button" disabled={!card.taskId} onClick={() => setCommenting(card.id)}><MessageSquareText size={13} /> Comentar no Trello</button>
                  {card.url && <a href={card.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Abrir no Trello</a>}
                </div>}
                {commenting === card.id && <form className="trello-comment-form" onSubmit={(event) => { event.preventDefault(); sendComment(card); }}><textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comentário que será enviado ao cartão" aria-label={`Comentário em ${card.title}`} rows={3} /><div><button type="submit" disabled={!comment.trim()}><MessageSquareText size={13} /> Enviar</button><button type="button" onClick={() => { setCommenting(null); setComment(''); }}><X size={13} /> Cancelar</button></div></form>}
              </article>
            ))}{!cards.length && <div className="trello-column__empty">Nenhum cartão neste filtro.</div>}</div>
          </section>;
        })}
      </div>
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

function SettingsView(props: ViewContentProps) {
  const { data, onUpdateSettings: onUpdate } = props;
  const status = data.integrationStatus;
  const monitoredChats = data.chats
    ? data.chats.filter((chat) => chat.selected).length
    : status?.monitoredChats ?? 0;
  const settings = data.settings ?? { timezone: 'America/Sao_Paulo', reminderTimes: ['08:00', '18:00'], notifySelf: true };
  const morning = settings.reminderTimes[0] ?? '08:00';
  const evening = settings.reminderTimes[1] ?? '18:00';
  return (
    <div className="settings-layout">
      <ConversationSettings {...props} />
      <section className="settings-section"><header><div><h2>Integrações</h2><p>Fontes conectadas ao seu espaço.</p></div></header><div className="integration-list"><article><span className="integration-logo integration-logo--whatsapp"><MessageCircle size={20} /></span><div><strong>WhatsApp pessoal · somente leitura</strong><small>{status?.whatsappConnected ? `${monitoredChats} conversa${monitoredChats === 1 ? '' : 's'} acompanhada${monitoredChats === 1 ? '' : 's'}` : 'Aguardando conexão'}</small></div><span className={status?.whatsappConnected ? 'connected-pill' : 'status-pill status-pill--paused'}>{status?.whatsappConnected && <Check size={12} />} {status?.whatsappConnected ? 'Conectado' : 'Desconectado'}</span></article><article><span className="integration-logo integration-logo--trello"><SquareKanban size={20} /></span><div><strong>Trello</strong><small>{status?.trelloConnected ? 'Quadro principal configurado' : 'Aguardando autorização'}</small></div><span className={status?.trelloConnected ? 'connected-pill' : 'status-pill status-pill--paused'}>{status?.trelloConnected && <Check size={12} />} {status?.trelloConnected ? 'Conectado' : 'Desconectado'}</span></article></div></section>
      <section className="settings-section"><header><div><h2>Mensagens e notificações</h2><p>Controle quando Atlas fala com você.</p></div></header><div className="setting-rows"><label><span><strong>Receber lembretes do Atlas</strong><small>O número central envia mensagens somente para o telefone identificado no seu QR pessoal.</small></span><span className="switch"><input type="checkbox" checked={settings.notifySelf} onChange={(event) => onUpdate({ notifySelf: event.target.checked })} /><i /></span></label><label><span><strong>Briefing da manhã</strong><small>Prioridades e prazos no início do dia.</small></span><input type="time" value={morning} onChange={(event) => onUpdate({ reminderTimes: [event.target.value, evening] })} /></label><label><span><strong>Briefing da tarde</strong><small>Pendências e respostas antes de encerrar o dia.</small></span><input type="time" value={evening} onChange={(event) => onUpdate({ reminderTimes: [morning, event.target.value] })} /></label></div></section>
      <section className="settings-section"><header><div><h2>Privacidade</h2><p>Seus dados, suas regras.</p></div></header><div className="privacy-settings"><article><span><Users size={18} /></span><div><strong>Conversas acompanhadas</strong><p>{monitoredChats} conversa{monitoredChats === 1 ? '' : 's'} autorizada{monitoredChats === 1 ? '' : 's'}. Todo o restante é ignorado.</p></div></article><article><span><Tag size={18} /></span><div><strong>Exportação</strong><p>A exportação completa dos dados está prevista para uma versão futura.</p></div></article></div></section>
    </div>
  );
}

function ConversationSettings({
  data,
  conversationLoading,
  conversationError,
  onRefreshConversations,
  onUpdateChat,
  onCreateChatGroup,
  onDeleteChatGroup,
}: Pick<ViewContentProps, 'data' | 'conversationLoading' | 'conversationError' | 'onRefreshConversations' | 'onUpdateChat' | 'onCreateChatGroup' | 'onDeleteChatGroup'>) {
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const chats = data.chats ?? [];
  const groups = data.chatGroups ?? [];
  const monitoredCount = chats.filter((chat) => chat.selected).length;
  const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR');
  const filteredChats = chats.filter((chat) => {
    if (normalizedSearch && !chat.name.toLocaleLowerCase('pt-BR').includes(normalizedSearch)) return false;
    if (groupFilter === 'automatic') return !chat.group;
    if (groupFilter !== 'all') return chat.group?.id === groupFilter;
    return true;
  });
  const submitGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    onCreateChatGroup({ name, description: 'Grupo personalizado criado por você.' });
    setNewGroupName('');
    setCreatingGroup(false);
  };
  return (
    <section className="settings-section conversation-settings">
      <header>
        <div><h2>Conversas monitoradas</h2><p>Escolha quem o Atlas pode acompanhar e organize seus contextos.</p></div>
        <button className="button button--secondary button--small" type="button" onClick={() => setCreatingGroup((value) => !value)}><Plus size={14} /> Novo grupo</button>
      </header>
      <div className="conversation-privacy-note"><Sparkles size={16} /><p><strong>Classificação privada e gradual.</strong> A IA aprende e classifica somente conversas com monitoramento ativo. Uma escolha manual de grupo nunca é substituída.</p></div>
      {creatingGroup && <div className="conversation-group-form"><label><span>Nome do grupo</span><input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitGroup(); }} placeholder="Ex.: Clientes importantes" autoFocus /></label><button className="button button--primary button--small" type="button" onClick={submitGroup} disabled={!newGroupName.trim()}>Criar</button><button className="button button--ghost button--small" type="button" onClick={() => setCreatingGroup(false)}>Cancelar</button></div>}
      <div className="conversation-group-strip" aria-label="Grupos de conversas">
        <button type="button" className={groupFilter === 'all' ? 'is-active' : ''} onClick={() => setGroupFilter('all')}><i style={{ background: '#8B8394' }} />Todas <small>{chats.length}</small></button>
        <button type="button" className={groupFilter === 'automatic' ? 'is-active' : ''} onClick={() => setGroupFilter('automatic')}><i style={{ background: '#A98BF7' }} />Atlas classifica <small>{chats.filter((chat) => !chat.group).length}</small></button>
        {groups.map((group) => <span className="conversation-group-chip" key={group.id}><button type="button" className={groupFilter === group.id ? 'is-active' : ''} onClick={() => setGroupFilter(group.id)}><i style={{ background: group.color }} />{group.name} <small>{group.chatCount}</small></button>{!group.system && <button type="button" className="conversation-group-delete" onClick={() => onDeleteChatGroup(group.id)} aria-label={`Excluir grupo ${group.name}`}><Trash2 size={12} /></button>}</span>)}
      </div>
      <div className="conversation-toolbar"><label className="search-field"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar conversa pelo nome" /></label><span><strong>{monitoredCount}</strong> de {chats.length} monitoradas</span><button type="button" className="icon-button" onClick={onRefreshConversations} aria-label="Atualizar conversas"><RefreshCw size={15} /></button></div>
      {conversationLoading && !chats.length ? <div className="conversation-state"><Spinner label="Buscando nomes e conversas" /></div>
        : conversationError ? <ErrorState title="Não foi possível carregar as conversas" message={conversationError} onRetry={onRefreshConversations} />
          : filteredChats.length ? <div className="conversation-management-list">{filteredChats.map((chat) => {
            const automatic = chat.classification?.source !== 'manual';
            const statusText = !chat.selected
              ? 'Ignorada · a IA não lê nem classifica'
              : chat.classification?.source === 'ai' && chat.group
                ? `Classificada pela IA · ${Math.round((chat.classification.confidence ?? 0) * 100)}%`
                : chat.classification?.source === 'manual'
                  ? 'Grupo definido por você'
                  : 'Atlas classificará conforme adquirir contexto';
            return <article className={`conversation-management-row ${chat.selected ? 'is-monitored' : ''}`} key={chat.id}>
              <span className="chat-avatar">{chat.kind === 'group' ? <Users size={17} /> : chat.name.slice(0, 2).toUpperCase()}</span>
              <div className="conversation-management-copy"><strong>{chat.name}</strong><small>{chat.kind === 'group' ? 'Grupo' : 'Contato'} · {statusText}</small>{chat.classification?.reason && chat.selected && <em>{chat.classification.reason}</em>}</div>
              <label className="conversation-group-select"><span>Contexto</span><select value={automatic ? 'automatic' : chat.group?.id ?? 'automatic'} onChange={(event) => onUpdateChat(chat.id, { groupId: event.target.value === 'automatic' ? null : event.target.value })}><option value="automatic">Atlas classifica{automatic && chat.group ? ` · ${chat.group.name}` : ''}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
              <label className="switch conversation-monitor-switch" title={chat.selected ? 'Desativar monitoramento' : 'Ativar monitoramento'}><input type="checkbox" checked={chat.selected === true} onChange={(event) => onUpdateChat(chat.id, { enabled: event.target.checked })} /><i /></label>
            </article>;
          })}</div> : <div className="conversation-state"><MessageCircle size={22} /><strong>Nenhuma conversa encontrada</strong><p>Depois que o WhatsApp sincronizar o histórico do QR, os nomes aparecerão aqui.</p></div>}
    </section>
  );
}

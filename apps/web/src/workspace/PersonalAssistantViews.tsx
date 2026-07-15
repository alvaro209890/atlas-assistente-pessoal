import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BellRing,
  Brain,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  GitMerge,
  Lightbulb,
  MessageCircle,
  Pause,
  Pencil,
  RefreshCw,
  Sparkles,
  SquareKanban,
  Trash2,
  UserRoundCheck,
  X,
} from 'lucide-react';
import type {
  AssistantLearning,
  AssistantTask,
  LearningEvidence,
  LearningAction,
  TaskAction,
  WorkspaceData,
} from '../types';
import { EmptyState } from '../components/ui';

interface TaskHandlers {
  onOpenTask(id: string): void;
  onTaskAction(id: string, input: { action: TaskAction; targetTaskId?: string; snoozeUntil?: string; dueAt?: string; comment?: string }): void;
}

export function PersonalTodayView({ data, onOpenTask, onTaskAction, onSelectNote, onReplan, onCommitmentAction }: {
  data: WorkspaceData;
  onSelectNote(id: string): void;
  onReplan(): void;
  onCommitmentAction(id: string, input: { status?: 'open' | 'waiting' | 'fulfilled' | 'cancelled'; dueAt?: string | null; nextFollowUpAt?: string | null }): void;
} & TaskHandlers) {
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const tasks = useMemo<AssistantTask[]>(() => data.tasks?.length ? data.tasks.filter((task) => !['completed', 'done', 'cancelled', 'merged'].includes(task.status)) : data.focus.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.completed ? 'completed' : 'open',
    priority: item.priority,
    projectName: item.project,
    dueLabel: item.dueLabel,
  })), [data.focus, data.tasks]);
  const commitments = data.commitments?.filter((item) => item.status === 'open') ?? [];

  return (
    <div className="today-layout personal-today">
      <section className="stat-strip" aria-label="Resumo do dia">
        <article><span className="stat-icon stat-icon--purple"><MessageCircle size={17} /></span><div><strong>{data.stats.inbox}</strong><small>itens para revisar</small></div><ChevronRight size={15} /></article>
        <article><span className="stat-icon stat-icon--mint"><UserRoundCheck size={17} /></span><div><strong>{commitments.length}</strong><small>compromissos abertos</small></div><ChevronRight size={15} /></article>
        <article><span className="stat-icon stat-icon--amber"><BellRing size={17} /></span><div><strong>{data.reminders?.filter((item) => item.state === 'scheduled').length ?? 0}</strong><small>lembretes ativos</small></div><ChevronRight size={15} /></article>
        <article><span className="stat-icon stat-icon--blue"><SquareKanban size={17} /></span><div><strong>{tasks.length}</strong><small>tarefas abertas</small></div><ChevronRight size={15} /></article>
      </section>

      <div className="today-command-bar">
        <div><Sparkles size={17} /><span><strong>Leitura do Atlas:</strong> {data.briefing}</span></div>
        <button className="button button--secondary button--small" type="button" onClick={onReplan}><RefreshCw size={14} /> Replanejar meu dia</button>
      </div>

      <div className="today-columns today-columns--assistant">
        <section className="surface focus-card">
          <header className="section-heading"><div><span className="section-kicker"><Sparkles size={14} /> Foco recomendado</span><h2>O que move seu dia</h2></div><small>{tasks.length} em aberto</small></header>
          {tasks.length ? <div className="assistant-task-list">{tasks.slice(0, 5).map((task) => (
            <article key={task.id} className={`assistant-task assistant-task--${task.priority}`}>
              <button type="button" className="task-check" aria-label={`Concluir ${task.title}`} onClick={() => onTaskAction(task.id, { action: 'complete' })}><CheckCircle2 size={18} /></button>
              <div className="assistant-task__main"><span><strong>{task.title}</strong>{task.priority === 'urgent' && <em>Urgente</em>}</span><small>{task.projectName || 'Sem projeto'}{taskDueLabel(task) ? ` · ${taskDueLabel(task)}` : ''}</small>{whyOpen === task.id && <p className="task-reason"><CircleHelp size={13} /> {task.risk || task.nextAction || 'Atlas priorizou esta tarefa pelo prazo, contexto recente e dependências abertas.'}</p>}</div>
              <div className="assistant-task__actions"><button type="button" onClick={() => onTaskAction(task.id, { action: 'snooze', snoozeUntil: tomorrowAtNine() })}><Clock3 size={13} /> Adiar</button><button type="button" onClick={() => setWhyOpen((current) => current === task.id ? null : task.id)}><CircleHelp size={13} /> Por quê</button><button type="button" onClick={() => onOpenTask(task.id)}><ArrowUpRight size={13} /> Abrir</button></div>
            </article>
          ))}</div> : <EmptyState title="Nada urgente por agora" description="Quando algo exigir sua atenção, Atlas colocará aqui com uma explicação." />}
        </section>

        <section className="surface commitments-card">
          <header className="section-heading"><div><span className="section-kicker"><UserRoundCheck size={14} /> Compromissos</span><h2>O que não pode se perder</h2></div></header>
          {commitments.length ? <div className="commitment-list">{commitments.slice(0, 5).map((item) => <article key={item.id}><span className={`commitment-direction commitment-direction--${item.direction}`}>{item.direction === 'owed_by_me' ? <ArrowUpRight size={14} /> : <MessageCircle size={14} />}</span><div><strong>{item.title}</strong><small>{item.direction === 'owed_by_me' ? 'Você prometeu' : 'Aguardando retorno'}{item.personName ? ` · ${item.personName}` : ''}</small></div><time>{item.dueLabel || 'Sem prazo'}</time><span className="commitment-actions"><button type="button" title="Concluir compromisso" onClick={() => onCommitmentAction(item.id, { status: 'fulfilled' })}><Check size={13} /> Concluir</button><button type="button" title="Adiar follow-up para amanhã" onClick={() => onCommitmentAction(item.id, { status: 'waiting', nextFollowUpAt: tomorrowAtNine() })}><Clock3 size={13} /> Amanhã</button><button type="button" title="Cancelar compromisso" onClick={() => onCommitmentAction(item.id, { status: 'cancelled' })}><X size={13} /></button></span></article>)}</div> : <EmptyState title="Nenhum compromisso aberto" description="Promessas e respostas pendentes aparecerão aqui." />}
        </section>
      </div>

      <section className="notes-section"><header className="section-heading"><div><span className="section-kicker"><Brain size={14} /> Memória recente</span><h2>Continue de onde parou</h2></div></header>{data.notes.length ? <div className="note-grid">{data.notes.slice(0, 3).map((note) => <button type="button" className="note-card" key={note.id} onClick={() => onSelectNote(note.id)}><span className="note-card__meta"><span><Brain size={12} /> {note.source === 'whatsapp' ? 'WhatsApp' : note.source === 'trello' ? 'Trello' : 'Nota'}</span><small>{note.updatedAt}</small></span><strong>{note.title}</strong><p>{note.excerpt}</p><span className="tag-row">{note.tags.slice(0, 2).map((tag) => <em key={tag}>#{tag}</em>)}</span></button>)}</div> : <EmptyState title="Nenhuma memória recente" description="Suas decisões e notas conectadas aparecerão aqui." />}</section>
    </div>
  );
}

export function PersonalInboxView({ data, onOpenTask, onFeedback, onLearningAction }: {
  data: WorkspaceData;
  onOpenTask(id: string): void;
  onLearningAction(id: string, action: LearningAction, statement?: string): void;
  onFeedback(itemId: string, action: 'edit' | 'not_task' | 'merge' | 'reprocess', context: 'inbox'): void;
}) {
  const [filter, setFilter] = useState<'all' | 'task' | 'conflict' | 'duplicate' | 'learning'>('all');
  const items = (data.assistantInbox ?? []).filter((item) => filter === 'all' || item.kind === filter);
  const labels = { all: 'Tudo', task: 'Tarefas', conflict: 'Conflitos', duplicate: 'Duplicatas', learning: 'Aprendizados' } as const;
  const icons = { task: SquareKanban, conflict: AlertTriangle, duplicate: GitMerge, learning: Lightbulb, memory: Brain } as const;
  return (
    <div className="assistant-inbox">
      <div className="inbox-filter-tabs" role="tablist" aria-label="Filtrar inbox">{(Object.keys(labels) as Array<keyof typeof labels>).map((id) => <button type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'is-active' : ''} key={id} onClick={() => setFilter(id)}>{labels[id]}{id !== 'all' && <small>{data.assistantInbox?.filter((item) => item.kind === id).length ?? 0}</small>}</button>)}</div>
      {items.length ? <div className="assistant-inbox__list">{items.map((item) => { const Icon = icons[item.kind]; const taskLike = (item.kind === 'task' || item.kind === 'duplicate') && item.targetId; return <article key={item.id}><span className={`assistant-inbox__icon assistant-inbox__icon--${item.kind}`}><Icon size={17} /></span><div><span className="inbox-kind">{labels[item.kind === 'memory' ? 'all' : item.kind]}</span><strong>{item.title}</strong><p>{item.description}</p><small>{item.createdAt}{item.confidence !== undefined ? ` · ${Math.round(item.confidence * 100)}% de confiança` : ''}</small></div><div className="assistant-inbox__actions">{taskLike && <><button type="button" className="button button--secondary button--small" onClick={() => onOpenTask(item.targetId!)}><Pencil size={12} /> {item.kind === 'duplicate' ? 'Comparar e mesclar' : 'Editar'}</button><button type="button" className="button button--secondary button--small" onClick={() => onFeedback(item.targetId!, 'not_task', 'inbox')}><X size={12} /> Não é tarefa</button><button type="button" className="button button--secondary button--small" onClick={() => onFeedback(item.targetId!, 'reprocess', 'inbox')}><RefreshCw size={12} /> Reprocessar</button></>}{item.kind === 'conflict' && item.targetId && <button type="button" className="button button--secondary button--small" onClick={() => onOpenTask(item.targetId!)}>Resolver conflito</button>}{item.kind === 'learning' && item.targetId && <><button type="button" className="button button--primary button--small" onClick={() => onLearningAction(item.targetId!, 'confirm')}>Confirmar</button><button type="button" className="icon-button" aria-label={`Rejeitar ${item.title}`} onClick={() => onLearningAction(item.targetId!, 'reject')}><X size={15} /></button></>}</div></article>; })}</div> : <EmptyState title="Seu inbox está limpo" description="Tarefas incertas, conflitos, duplicatas e novos padrões aparecerão aqui." />}
    </div>
  );
}

export function LearningsView({ learnings, onAction, onTeach, onLoadEvidence }: {
  learnings: AssistantLearning[];
  onAction(id: string, action: LearningAction, statement?: string): void;
  onTeach(input: { statement: string; title?: string }): void;
  onLoadEvidence(id: string): Promise<LearningEvidence[]>;
}) {
  const [tab, setTab] = useState<'active' | 'suggested' | 'rejected'>('active');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [teaching, setTeaching] = useState(false);
  const [teachingText, setTeachingText] = useState('');
  const [evidenceOpen, setEvidenceOpen] = useState<string | null>(null);
  const [evidenceByLearning, setEvidenceByLearning] = useState<Record<string, LearningEvidence[]>>({});
  const [evidenceLoading, setEvidenceLoading] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const filtered = learnings.filter((item) => tab === 'active' ? ['active', 'paused'].includes(item.status) : item.status === tab);
  const counts = { active: learnings.filter((item) => ['active', 'paused'].includes(item.status)).length, suggested: learnings.filter((item) => item.status === 'suggested').length, rejected: learnings.filter((item) => item.status === 'rejected').length };
  const toggleEvidence = async (learningId: string) => {
    if (evidenceOpen === learningId) {
      setEvidenceOpen(null);
      return;
    }
    setEvidenceOpen(learningId);
    setEvidenceError(null);
    if (evidenceByLearning[learningId]) return;
    setEvidenceLoading(learningId);
    try {
      const evidence = await onLoadEvidence(learningId);
      setEvidenceByLearning((current) => ({ ...current, [learningId]: evidence }));
    } catch (error) {
      setEvidenceError(error instanceof Error ? error.message : 'Não foi possível carregar as evidências.');
    } finally {
      setEvidenceLoading(null);
    }
  };
  return (
    <div className="learnings-layout">
      <section className="learning-manifesto"><span><Lightbulb size={20} /></span><div><h2>Aprendizado com controle</h2><p>Atlas mostra o que observou, as evidências e a confiança. Você decide o que continua valendo.</p></div><button type="button" className="button button--primary button--small" onClick={() => setTeaching((open) => !open)}>Ensinar ao Atlas</button></section>
      {teaching && <section className="learning-edit"><label><span>O que o Atlas deve lembrar?</span><textarea value={teachingText} aria-label="Ensinar ao Atlas" onChange={(event) => setTeachingText(event.target.value)} /></label><div><button type="button" className="button button--primary button--small" disabled={teachingText.trim().length < 3} onClick={() => { onTeach({ statement: teachingText.trim() }); setTeachingText(''); setTeaching(false); }}>Salvar aprendizado</button><button type="button" className="button button--ghost button--small" onClick={() => setTeaching(false)}>Cancelar</button></div></section>}
      <div className="learning-tabs" role="tablist" aria-label="Estados dos aprendizados">{([['active', 'Ativos'], ['suggested', 'Sugestões'], ['rejected', 'Rejeitados']] as const).map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} key={id} onClick={() => setTab(id)}>{label}<small>{counts[id]}</small></button>)}</div>
      {filtered.length ? <div className="learning-list">{filtered.map((learning) => (
        <article key={learning.id} className={`learning-card learning-card--${learning.status}`}>
          <span className="learning-card__icon"><Sparkles size={17} /></span>
          <div className="learning-card__body">
            <header><span className={`status-pill status-pill--${learning.status === 'active' ? 'healthy' : learning.status === 'paused' ? 'paused' : 'attention'}`}>{learning.status === 'active' ? 'Ativo' : learning.status === 'suggested' ? 'Sugestão' : learning.status === 'paused' ? 'Pausado' : 'Rejeitado'}</span><small>{learning.scopeType === 'global' ? 'Geral' : learning.scopeLabel || learning.scopeType}{learning.version ? ` · v${learning.version}` : ''}</small></header>
            {editingId === learning.id ? <div className="learning-edit"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Editar aprendizado" /><div><button type="button" className="button button--primary button--small" disabled={!draft.trim()} onClick={() => { onAction(learning.id, 'update', draft.trim()); setEditingId(null); }}>Salvar</button><button type="button" className="button button--ghost button--small" onClick={() => setEditingId(null)}>Cancelar</button></div></div> : <p>{learning.statement}</p>}
            <footer><span><strong>{Math.round(learning.confidence * 100)}%</strong> de confiança</span><button className="learning-evidence-toggle" type="button" onClick={() => void toggleEvidence(learning.id)}><strong>{learning.evidenceCount}</strong> evidências</button><span>{learning.inferred ? 'Inferido pelo Atlas' : 'Definido por você'}</span></footer>
            {evidenceOpen === learning.id && <section className="learning-evidence" aria-label="Evidências do aprendizado">{evidenceLoading === learning.id ? <p>Carregando evidências…</p> : evidenceError ? <p className="form-error">{evidenceError}</p> : evidenceByLearning[learning.id]?.length ? evidenceByLearning[learning.id]!.map((evidence) => <article key={evidence.id}><span>{evidence.signal === 'contradicts' || evidence.signal === 'rejects' ? <AlertTriangle size={13} /> : <Check size={13} />}</span><div><p>{evidence.excerpt || 'Evidência registrada sem trecho textual.'}</p><small>{evidence.evidenceType} · {new Date(evidence.observedAt).toLocaleDateString('pt-BR')}</small></div></article>) : <p>Nenhuma evidência detalhada foi registrada.</p>}</section>}
          </div>
          <div className="learning-card__actions">{learning.status === 'suggested' && <button type="button" className="button button--primary button--small" onClick={() => onAction(learning.id, 'confirm')}><Check size={13} /> Confirmar</button>}<button type="button" onClick={() => { setDraft(learning.statement); setEditingId(learning.id); }}><Pencil size={13} /> Editar</button>{learning.status === 'active' && <button type="button" onClick={() => onAction(learning.id, 'pause')}><Pause size={13} /> Pausar</button>}{learning.status === 'paused' && <button type="button" onClick={() => onAction(learning.id, 'resume')}><RefreshCw size={13} /> Retomar</button>}{learning.status === 'suggested' && <button type="button" onClick={() => onAction(learning.id, 'reject')}><X size={13} /> Rejeitar</button>}{(learning.status === 'rejected' || (learning.version ?? 1) > 1) && <button type="button" onClick={() => onAction(learning.id, 'undo')}><RefreshCw size={13} /> Desfazer</button>}<button type="button" className="is-danger" onClick={() => onAction(learning.id, 'forget')}><Trash2 size={13} /> Esquecer</button></div>
        </article>
      ))}</div> : <EmptyState title={`Nenhum aprendizado ${tab === 'active' ? 'ativo' : tab === 'suggested' ? 'sugerido' : 'rejeitado'}`} description="Atlas só cria padrões a partir das suas instruções e correções." />}
    </div>
  );
}

export function TaskDrawer({ task, availableTasks, onClose, onUpdate, onAction, onResolveConflict }: {
  task: AssistantTask | null;
  availableTasks: AssistantTask[];
  onClose(): void;
  onUpdate(id: string, input: { title?: string; description?: string }): void;
  onAction(id: string, input: { action: TaskAction; targetTaskId?: string; snoozeUntil?: string; dueAt?: string; comment?: string }): void;
  onResolveConflict(id: string, resolution: 'keep_atlas' | 'keep_trello'): void;
}) {
  const [dueAt, setDueAt] = useState('');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [mergeTargetId, setMergeTargetId] = useState('');

  useEffect(() => {
    setTitle(task?.title ?? '');
    setDescription(task?.description ?? '');
    setDueAt('');
    setMergeTargetId('');
    setEditing(false);
  }, [task?.id]);

  if (!task) return null;
  const mergeTargets = availableTasks.filter((candidate) => candidate.id !== task.id);
  return (
    <div className="task-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="task-drawer" role="dialog" aria-modal="true" aria-labelledby="task-drawer-title">
        <header><span><SquareKanban size={17} /> Tarefa do Atlas</span><button type="button" className="icon-button" onClick={onClose} aria-label="Fechar tarefa"><X size={18} /></button></header>
        <div className="task-drawer__content">
          <div className="task-drawer__eyebrow"><span className={`priority-badge priority-badge--${task.priority}`}>{task.priority === 'urgent' ? 'Urgente' : task.priority === 'high' ? 'Alta' : task.priority === 'medium' ? 'Média' : 'Baixa'}</span><span>{task.status.replace('_', ' ')}</span></div>
          {editing ? <section className="task-edit-form"><label><span>Título</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label><span>Descrição</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label><div><button type="button" className="button button--primary button--small" disabled={!title.trim()} onClick={() => { onUpdate(task.id, { title: title.trim(), description }); setEditing(false); }}><Check size={13} /> Salvar edição</button><button type="button" className="button button--ghost button--small" onClick={() => setEditing(false)}>Cancelar</button></div></section> : <><h2 id="task-drawer-title">{task.title}</h2>{task.description && <p className="task-description">{task.description}</p>}<button type="button" className="text-link task-edit-trigger" onClick={() => setEditing(true)}><Pencil size={13} /> Editar título e descrição</button></>}
          <dl><div><dt>Projeto</dt><dd>{task.projectName || 'Sem projeto'}</dd></div><div><dt>Prazo</dt><dd>{taskDueLabel(task) || 'Sem prazo'}</dd></div><div><dt>Próxima ação</dt><dd>{task.nextAction || 'Ainda não definida'}</dd></div><div><dt>Responsável</dt><dd>{task.expectedOwner || 'Você'}</dd></div><div><dt>Estimativa</dt><dd>{task.estimateMinutes ? `${task.estimateMinutes} min` : 'Não estimada'}</dd></div><div><dt>Recorrência</dt><dd>{task.recurrence || 'Não recorrente'}</dd></div></dl>
          {task.risk && <section className="task-risk"><AlertTriangle size={15} /><div><strong>Por que merece atenção</strong><p>{task.risk}</p></div></section>}
          {task.trelloSyncStatus === 'conflict' && <section className="task-conflict"><AlertTriangle size={16} /><div><strong>Conflito com o Trello</strong><p>A tarefa mudou nos dois lados. Escolha qual versão deve prevalecer.</p><div><button type="button" className="button button--primary button--small" onClick={() => onResolveConflict(task.id, 'keep_atlas')}>Manter Atlas</button><button type="button" className="button button--secondary button--small" onClick={() => onResolveConflict(task.id, 'keep_trello')}>Usar Trello</button></div></div></section>}
          <section className="task-sources"><strong>Rastreabilidade</strong><p>{task.sourceMessageIds?.length ? `${task.sourceMessageIds.length} mensagens usadas como evidência` : 'Criada a partir do seu contexto.'}</p>{task.trelloCardUrl && <a href={task.trelloCardUrl} target="_blank" rel="noreferrer">Abrir cartão no Trello <ExternalLink size={13} /></a>}</section>
          <label className="task-reschedule"><span>Reagendar</span><span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /><button type="button" className="button button--secondary button--small" disabled={!dueAt} onClick={() => onAction(task.id, { action: 'reschedule', dueAt: new Date(dueAt).toISOString() })}>Salvar prazo</button></span></label>
          {mergeTargets.length > 0 && <label className="task-reschedule task-merge"><span>Mesclar com outra tarefa</span><span><select value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}><option value="">Escolha o destino…</option>{mergeTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select><button type="button" className="button button--secondary button--small" disabled={!mergeTargetId} onClick={() => onAction(task.id, { action: 'merge', targetTaskId: mergeTargetId })}><GitMerge size={13} /> Mesclar</button></span></label>}
        </div>
        <footer><button type="button" className="button button--primary" onClick={() => onAction(task.id, { action: 'complete' })}><CheckCircle2 size={15} /> Concluir</button><button type="button" className="button button--secondary" onClick={() => onAction(task.id, { action: 'snooze', snoozeUntil: tomorrowAtNine() })}><Clock3 size={15} /> Adiar para amanhã</button><button type="button" className="button button--ghost" onClick={() => onAction(task.id, { action: 'cancel' })}>Cancelar tarefa</button></footer>
      </aside>
    </div>
  );
}

const tomorrowAtNine = () => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
};

export function taskDueLabel(task: Pick<AssistantTask, 'dueLabel' | 'dueAt'>): string | null {
  if (task.dueLabel) return task.dueLabel;
  if (!task.dueAt) return null;
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDelta = Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000);
  const time = due.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (dayDelta < 0) return `Venceu ${due.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`;
  if (dayDelta === 0) return `Hoje, ${time}`;
  if (dayDelta === 1) return `Amanhã, ${time}`;
  return due.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

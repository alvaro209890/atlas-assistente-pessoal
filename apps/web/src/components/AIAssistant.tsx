import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Bot, Check, FileText, MessageCircle, PanelRightClose, Pencil, Repeat2, Sparkles, SquareKanban, X } from 'lucide-react';
import type { AppApi } from '../api';
import type { ActionProposal, AiMessage, AiSource, AssistantTask, NavId, ProposalAction } from '../types';
import { Spinner } from './ui';

interface AIAssistantProps {
  api: AppApi;
  view: NavId;
  noteId?: string | null;
  mobileOpen: boolean;
  tasks?: AssistantTask[];
  onMobileClose(): void;
  onOpenNote(id: string): void;
}

const initialMessages: AiMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content: 'Estou pronto para cruzar suas notas, mensagens e tarefas. Pergunte sobre um projeto, uma decisão ou o que merece atenção agora.',
  },
];

const sourceIcon = (source: AiSource) => source.kind === 'whatsapp' ? <MessageCircle size={13} /> : source.kind === 'trello' ? <SquareKanban size={13} /> : <FileText size={13} />;

const isReminderProposal = (proposal: ActionProposal) => proposal.actionType.includes('reminder');
const needsTaskTarget = (proposal: ActionProposal) => proposal.payload?.needsTargetResolution === true
  || ['task_mutation', 'complete_task', 'cancel_task', 'merge_tasks'].includes(proposal.actionType);
const isMergeProposal = (proposal: ActionProposal) => proposal.actionType.includes('merge')
  || ['mescle', 'mesclar', 'merge'].includes(String(proposal.payload?.requestedAction ?? '').toLocaleLowerCase('pt-BR'));
const proposalCanConfirm = (proposal: ActionProposal) => {
  if (proposal.payload?.needsScheduleResolution === true && typeof proposal.payload.scheduledFor !== 'string') return false;
  if (proposal.payload?.needsTargetResolution === true) {
    const targetIds = Array.isArray(proposal.payload.targetIds) ? proposal.payload.targetIds : [];
    if (!targetIds.length && typeof proposal.payload.taskId !== 'string') return false;
  }
  return true;
};
const canAlwaysProposal = (proposal: ActionProposal) => {
  const type = proposal.actionType.toLocaleLowerCase('en-US');
  return proposal.reversible && proposal.risk !== 'destructive'
    && type !== 'profile_change'
    && !type.includes('permission')
    && !type.includes('recipient')
    && !type.includes('external');
};

export function AIAssistant({ api, view, noteId, mobileOpen, tasks = [], onMobileClose, onOpenNote }: AIAssistantProps) {
  const [messages, setMessages] = useState<AiMessage[]>(initialMessages);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposalBusy, setProposalBusy] = useState<string | null>(null);
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [proposalDraft, setProposalDraft] = useState('');
  const [proposalScheduledFor, setProposalScheduledFor] = useState('');
  const [proposalRecurrence, setProposalRecurrence] = useState('');
  const [proposalTaskId, setProposalTaskId] = useState('');
  const [proposalMergeTargetId, setProposalMergeTargetId] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), [messages, sending]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    const userMessage: AiMessage = { id: `user-${Date.now()}`, role: 'user', content: text };
    setMessages((current) => [...current, userMessage]);
    setDraft('');
    setSending(true);
    setError(null);
    try {
      const result = await api.askAi({ message: text, ...(threadId ? { threadId } : {}), context: { view, noteId } });
      setThreadId(result.threadId);
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: 'assistant', content: result.answer, sources: result.sources, proposals: result.proposals }]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível consultar seu contexto.');
    } finally {
      setSending(false);
    }
  };

  const handleProposal = async (proposalId: string, action: ProposalAction, patch?: Record<string, unknown>) => {
    setProposalBusy(proposalId);
    setError(null);
    try {
      const updated = await api.actOnProposal(proposalId, { action, ...(patch ? { patch } : {}) });
      setMessages((current) => current.map((message) => ({ ...message, proposals: message.proposals?.map((proposal) => proposal.id === proposalId ? updated : proposal) })));
      if (action === 'edit') {
        setEditingProposalId(null);
        setProposalDraft('');
        setProposalScheduledFor('');
        setProposalRecurrence('');
        setProposalTaskId('');
        setProposalMergeTargetId('');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível atualizar esta proposta.');
    } finally { setProposalBusy(null); }
  };

  const beginProposalEdit = (proposal: ActionProposal) => {
    const scheduledFor = typeof proposal.payload?.scheduledFor === 'string' ? new Date(proposal.payload.scheduledFor) : null;
    const recurrence = proposal.payload?.recurrence;
    const targetIds = Array.isArray(proposal.payload?.targetIds)
      ? proposal.payload.targetIds.filter((value): value is string => typeof value === 'string')
      : [];
    setEditingProposalId(proposal.id);
    setProposalDraft(proposal.description);
    setProposalScheduledFor(scheduledFor && !Number.isNaN(scheduledFor.getTime())
      ? new Date(scheduledFor.getTime() - scheduledFor.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
      : '');
    setProposalRecurrence(typeof recurrence === 'string'
      ? recurrence
      : recurrence && typeof recurrence === 'object' && typeof (recurrence as Record<string, unknown>).rule === 'string'
        ? String((recurrence as Record<string, unknown>).rule)
        : '');
    setProposalTaskId(targetIds[0] ?? (typeof proposal.payload?.taskId === 'string' ? proposal.payload.taskId : ''));
    setProposalMergeTargetId(targetIds[1] ?? (typeof proposal.payload?.targetTaskId === 'string' ? proposal.payload.targetTaskId : ''));
    setError(null);
  };

  const saveProposalEdit = (proposal: ActionProposal) => {
    const patch: Record<string, unknown> = { description: proposalDraft.trim() };
    if (isReminderProposal(proposal)) {
      if (proposalScheduledFor) patch.scheduledFor = new Date(proposalScheduledFor).toISOString();
      if (proposalRecurrence.trim()) patch.recurrence = { rule: proposalRecurrence.trim() };
      patch.needsScheduleResolution = !proposalScheduledFor;
    }
    if (needsTaskTarget(proposal) && proposalTaskId) {
      const targetIds = [proposalTaskId, ...(isMergeProposal(proposal) && proposalMergeTargetId ? [proposalMergeTargetId] : [])];
      patch.targetIds = targetIds;
      patch.taskId = proposalTaskId;
      if (proposalMergeTargetId) patch.targetTaskId = proposalMergeTargetId;
      patch.needsTargetResolution = false;
    }
    void handleProposal(proposal.id, 'edit', patch);
  };

  return (
    <aside className={`ai-panel ${mobileOpen ? 'is-mobile-open' : ''}`} aria-label="Assistente Atlas">
      <header className="ai-panel__header">
        <div><span className="ai-avatar"><Sparkles size={17} /></span><span><strong>Assistente Atlas</strong><small><i /> Contexto ativo</small></span></div>
        <button className="icon-button ai-mobile-close" type="button" onClick={onMobileClose} aria-label="Fechar assistente"><PanelRightClose size={18} /></button>
      </header>
      <div className="ai-context-strip"><Bot size={14} /><span>Respondendo com base no seu segundo cérebro</span></div>
      <div className="ai-thread" aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} className={`ai-message ai-message--${message.role}`}>
            {message.role === 'assistant' && <span className="ai-message__mark">A</span>}
            <div>
              <p>{message.content}</p>
              {message.sources?.length ? (
                <div className="ai-sources">
                  <span className="ai-sources__label">Fontes usadas · {message.sources.length}</span>
                  {message.sources.map((source, index) => {
                    const content = <><span className={`source-card__icon source-card__icon--${source.kind}`}>{sourceIcon(source)}</span><span><strong>[{index + 1}] {source.title}</strong><small>{source.excerpt}</small><em>{source.updatedAt}</em></span></>;
                    const accessibleLabel = source.kind === 'note'
                      ? `Abrir nota ${source.title}`
                      : `Abrir fonte ${index + 1}: ${source.title}`;
                    return <button type="button" key={source.id} className="source-card" onClick={() => onOpenNote(source.id)} aria-label={accessibleLabel}>{content}</button>;
                  })}
                </div>
              ) : null}
              {message.proposals?.length ? (
                <div className="ai-proposals">
                  <span className="ai-sources__label">Ações propostas · revise antes de confirmar</span>
                  {message.proposals.map((proposal) => (
                    <article key={proposal.id} className={`ai-proposal ai-proposal--${proposal.status}`}>
                      <header>
                        <strong>{proposal.title}</strong>
                        <span className={`proposal-risk proposal-risk--${proposal.risk}`}>
                          {proposal.risk === 'low' ? 'Baixo risco' : proposal.risk === 'medium' ? 'Médio risco' : proposal.risk === 'destructive' ? 'Destrutivo' : 'Alto risco'}
                        </span>
                      </header>
                      {editingProposalId === proposal.id ? (
                        <div className="ai-proposal__editor">
                          <label htmlFor={`proposal-edit-${proposal.id}`}>Descreva como a proposta deve ficar</label>
                          <textarea
                            id={`proposal-edit-${proposal.id}`}
                            value={proposalDraft}
                            onChange={(event) => setProposalDraft(event.target.value)}
                            rows={3}
                          />
                          {isReminderProposal(proposal) && <>
                            <label htmlFor={`proposal-when-${proposal.id}`}>Data e hora do lembrete</label>
                            <input id={`proposal-when-${proposal.id}`} type="datetime-local" value={proposalScheduledFor} onChange={(event) => setProposalScheduledFor(event.target.value)} />
                            <label htmlFor={`proposal-recurrence-${proposal.id}`}>Recorrência opcional</label>
                            <input id={`proposal-recurrence-${proposal.id}`} value={proposalRecurrence} onChange={(event) => setProposalRecurrence(event.target.value)} placeholder="Ex.: toda sexta-feira" />
                          </>}
                          {needsTaskTarget(proposal) && <>
                            <label htmlFor={`proposal-task-${proposal.id}`}>{isMergeProposal(proposal) ? 'Tarefa de origem' : 'Tarefa que receberá a ação'}</label>
                            <select id={`proposal-task-${proposal.id}`} value={proposalTaskId} onChange={(event) => setProposalTaskId(event.target.value)}>
                              <option value="">Selecione uma tarefa</option>
                              {tasks.filter((task) => !['completed', 'done', 'cancelled', 'merged'].includes(task.status)).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
                            </select>
                            {isMergeProposal(proposal) && <><label htmlFor={`proposal-merge-target-${proposal.id}`}>Mesclar em</label><select id={`proposal-merge-target-${proposal.id}`} value={proposalMergeTargetId} onChange={(event) => setProposalMergeTargetId(event.target.value)}><option value="">Selecione a tarefa de destino</option>{tasks.filter((task) => task.id !== proposalTaskId && !['completed', 'done', 'cancelled', 'merged'].includes(task.status)).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></>}
                            {!tasks.length && <small>Nenhuma tarefa aberta está disponível para selecionar.</small>}
                          </>}
                          <div>
                            <button
                              type="button"
                              disabled={!proposalDraft.trim()
                                || (isReminderProposal(proposal) && !proposalScheduledFor)
                                || (needsTaskTarget(proposal) && !proposalTaskId)
                                || (isMergeProposal(proposal) && (!proposalMergeTargetId || proposalMergeTargetId === proposalTaskId))
                                || proposalBusy === proposal.id}
                              onClick={() => saveProposalEdit(proposal)}
                            >
                              <Check size={12} /> Salvar alteração
                            </button>
                            <button type="button" disabled={proposalBusy === proposal.id} onClick={() => setEditingProposalId(null)}>
                              <X size={12} /> Voltar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p>{proposal.description}</p>
                      )}
                      {proposal.evidence?.length ? <small>{proposal.evidence.length} evidência{proposal.evidence.length === 1 ? '' : 's'} vinculada{proposal.evidence.length === 1 ? '' : 's'}</small> : null}
                      {['pending', 'edited'].includes(proposal.status) && editingProposalId !== proposal.id ? (
                        <div>
                          <button type="button" disabled={proposalBusy === proposal.id || !proposalCanConfirm(proposal)} title={!proposalCanConfirm(proposal) ? 'Edite para informar os dados necessários' : undefined} onClick={() => void handleProposal(proposal.id, 'confirm')}><Check size={12} /> Confirmar</button>
                          <button type="button" disabled={proposalBusy === proposal.id} onClick={() => beginProposalEdit(proposal)}><Pencil size={12} /> Editar</button>
                          <button type="button" disabled={proposalBusy === proposal.id} onClick={() => void handleProposal(proposal.id, 'cancel')}><X size={12} /> Cancelar</button>
                          {canAlwaysProposal(proposal) && <button type="button" disabled={proposalBusy === proposal.id} onClick={() => void handleProposal(proposal.id, 'always')}><Repeat2 size={12} /> Fazer sempre</button>}
                        </div>
                      ) : !['pending', 'edited'].includes(proposal.status) ? (
                        <em>{proposal.status === 'cancelled' ? 'Proposta cancelada' : proposal.status === 'failed' ? 'Falha ao executar' : proposal.status === 'completed' || proposal.status === 'executed' ? 'Proposta executada' : 'Proposta confirmada'}</em>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : null}
            </div>
          </article>
        ))}
        {sending && <article className="ai-message ai-message--assistant"><span className="ai-message__mark">A</span><div className="ai-thinking"><Spinner label="Cruzando suas fontes" /></div></article>}
        {error && <div className="ai-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Fechar</button></div>}
        <div ref={endRef} />
      </div>
      <form className="ai-composer" onSubmit={send}>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }} placeholder="Pergunte ao Atlas…" rows={2} aria-label="Mensagem para o Atlas" />
        <div><span>Enter para enviar · Shift + Enter para quebrar linha</span><button type="submit" disabled={!draft.trim() || sending} aria-label="Enviar pergunta"><ArrowUp size={17} /></button></div>
      </form>
    </aside>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Brain,
  Check,
  ChevronDown,
  Command,
  LogOut,
  Menu,
  MessageCircle,
  PanelRightOpen,
  Plus,
  Search,
  Sparkles,
  SquareKanban,
  X,
} from 'lucide-react';
import type { AppApi } from '../api';
import type { AssistantTask, CreateTaskInput, FeedbackAction, LearningAction, Note, NavId, Session, TaskAction, WorkspaceData } from '../types';
import { AIAssistant } from '../components/AIAssistant';
import { CommandPalette } from '../components/CommandPalette';
import { Avatar, Brand, ErrorState } from '../components/ui';
import { mobileNavIds, navItems, viewMeta } from './navigation';
import { ViewContent } from './ViewContent';
import { TaskDrawer } from './PersonalAssistantViews';

interface WorkspaceProps {
  api: AppApi;
  session: Session;
  onLogout(): Promise<void>;
  onEnterPreview(): void;
  onExitPreview(): void;
}

const navFromHash = (): NavId => {
  const value = window.location.hash.replace(/^#\/?/, '') as NavId;
  return navItems.some((item) => item.id === value) ? value : 'today';
};

export function Workspace({ api, session, onLogout, onEnterPreview, onExitPreview }: WorkspaceProps) {
  const [activeView, setActiveView] = useState<NavId>(navFromHash);
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [aiMobileOpen, setAiMobileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<AssistantTask | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);

  const loadWorkspace = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const result = await api.getWorkspace();
      const [tasks, reminders, commitments, learnings, proposals] = await Promise.allSettled([
        api.listTasks(), api.listReminders(), api.listCommitments(), api.listLearnings(), api.listProposals(),
      ]);
      const merged: WorkspaceData = {
        ...result,
        tasks: tasks.status === 'fulfilled' ? tasks.value : result.tasks,
        reminders: reminders.status === 'fulfilled' ? reminders.value : result.reminders,
        commitments: commitments.status === 'fulfilled' ? commitments.value : result.commitments,
        learnings: learnings.status === 'fulfilled' ? learnings.value : result.learnings,
        proposals: proposals.status === 'fulfilled' ? proposals.value : result.proposals,
      };
      setData((current) => ({ ...merged, chats: current?.chats, chatGroups: current?.chatGroups }));
      setSelectedNoteId((current) => current || result.notes[0]?.id || null);
    } catch (error) {
      if (!background) setLoadError(error instanceof Error ? error.message : 'Não foi possível carregar seu espaço.');
    } finally {
      if (!background) setLoading(false);
    }
  }, [api]);

  const loadConversationSettings = useCallback(async () => {
    setConversationLoading(true);
    setConversationError(null);
    try {
      const [chats, chatGroups] = await Promise.all([api.listChats(), api.listChatGroups()]);
      setData((current) => current ? { ...current, chats, chatGroups } : current);
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : 'Não foi possível carregar as conversas.');
    } finally {
      setConversationLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    let refreshTimer: number | undefined;
    const unsubscribe = api.subscribeEvents(() => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void loadWorkspace(true), 300);
    });
    return () => {
      unsubscribe();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [api, loadWorkspace]);

  const navigate = useCallback((view: NavId) => {
    setActiveView(view);
    setMobileMenuOpen(false);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${view}`);
  }, []);

  const openNote = useCallback((id: string) => {
    setSelectedNoteId(id);
    navigate('brain');
  }, [navigate]);

  const openAiSource = useCallback((id: string) => {
    setAiMobileOpen(false);
    openNote(id);
  }, [openNote]);

  const loadNote = useCallback(async () => {
    if (!selectedNoteId) {
      setNote(null);
      return;
    }
    setNoteLoading(true);
    setNoteError(null);
    try {
      setNote(await api.getNote(selectedNoteId));
    } catch (error) {
      setNoteError(error instanceof Error ? error.message : 'Não foi possível abrir esta nota.');
    } finally {
      setNoteLoading(false);
    }
  }, [api, selectedNoteId]);

  useEffect(() => {
    if (activeView === 'brain') void loadNote();
  }, [activeView, loadNote]);

  useEffect(() => {
    if (activeView === 'settings' && data && data.chats === undefined && !conversationLoading && !conversationError) {
      void loadConversationSettings();
    }
  }, [activeView, conversationError, conversationLoading, data, loadConversationSettings]);

  const createNote = useCallback(async () => {
    try {
      const created = await api.createNote();
      setData((current) => current ? { ...current, notes: [{ id: created.id, title: created.title, excerpt: created.excerpt, updatedAt: created.updatedAt, tags: created.tags, source: created.source }, ...current.notes] } : current);
      setSelectedNoteId(created.id);
      setNote(created);
      navigate('brain');
      setToast('Nova nota criada');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível criar a nota.');
    }
  }, [api, navigate]);

  const saveNote = useCallback(async (id: string, input: { title: string; contentMarkdown: string }) => {
    const updated = await api.updateNote(id, input);
    setNote((current) => current?.id === id ? updated : current);
    setData((current) => current ? { ...current, notes: current.notes.map((item) => item.id === id ? { ...item, title: updated.title, excerpt: updated.excerpt, updatedAt: updated.updatedAt } : item) } : current);
    return updated;
  }, [api]);

  const toggleAutomation = useCallback(async (id: string, enabled: boolean) => {
    try {
      await api.toggleAutomation(id, enabled);
      setData((current) => current ? { ...current, automations: current.automations.map((item) => item.id === id ? { ...item, enabled, status: enabled ? 'healthy' : 'paused' } : item) } : current);
      setToast(enabled ? 'Automação ativada' : 'Automação pausada');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível atualizar a automação.');
    }
  }, [api]);

  const updateSettings = useCallback(async (input: { reminderTimes?: string[]; notifySelf?: boolean }) => {
    try {
      const settings = await api.updateSettings(input);
      setData((current) => current ? { ...current, settings } : current);
      setToast('Configurações salvas');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível salvar as configurações.');
    }
  }, [api]);

  const sendFeedback = useCallback(async (itemId: string, action: FeedbackAction, context: 'inbox' | 'activity') => {
    try {
      await api.sendFeedback({ itemId, action, context });
      if (action === 'not_task') {
        setData((current) => current ? {
          ...current,
          tasks: current.tasks?.map((task) => task.id === itemId ? { ...task, status: 'cancelled' } : task),
          assistantInbox: current.assistantInbox?.filter((item) => item.targetId !== itemId),
        } : current);
      }
      const labels: Record<FeedbackAction, string> = { edit: 'Item enviado para edição', not_task: 'Marcado como não tarefa', merge: 'Item enviado para mesclagem', reprocess: 'Reprocessamento solicitado' };
      setToast(labels[action]);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível registrar o feedback.');
    }
  }, [api]);

  const updateChat = useCallback(async (id: string, input: { enabled?: boolean; groupId?: string | null }) => {
    try {
      await api.updateChat(id, input);
      await loadConversationSettings();
      setToast(input.enabled === true ? 'Monitoramento ativado' : input.enabled === false ? 'Monitoramento desativado' : input.groupId ? 'Grupo definido por você' : 'Atlas voltará a classificar com o tempo');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível atualizar a conversa.');
    }
  }, [api, loadConversationSettings]);

  const createChatGroup = useCallback(async (input: { name: string; description?: string }) => {
    try {
      await api.createChatGroup(input);
      await loadConversationSettings();
      setToast('Grupo de conversas criado');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível criar o grupo.');
    }
  }, [api, loadConversationSettings]);

  const deleteChatGroup = useCallback(async (id: string) => {
    try {
      await api.deleteChatGroup(id);
      await loadConversationSettings();
      setToast('Grupo removido');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível remover o grupo.');
    }
  }, [api, loadConversationSettings]);

  const openTask = useCallback(async (id: string) => {
    const local = data?.tasks?.find((item) => item.id === id) ?? null;
    if (local) setSelectedTask(local);
    try { setSelectedTask(await api.getTask(id)); }
    catch (error) { if (!local) setToast(error instanceof Error ? error.message : 'Não foi possível abrir a tarefa.'); }
  }, [api, data?.tasks]);

  const updateTask = useCallback(async (id: string, input: { title?: string; description?: string }) => {
    try {
      const updated = await api.updateTask(id, input);
      await api.sendFeedback({ itemId: id, action: 'edit', context: 'inbox' });
      setData((current) => current ? { ...current, tasks: current.tasks?.map((item) => item.id === id ? updated : item) } : current);
      setSelectedTask((current) => current?.id === id ? updated : current);
      setToast('Tarefa editada e sincronização agendada');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível editar a tarefa.');
    }
  }, [api]);

  const createTask = useCallback(async (input: CreateTaskInput) => {
    try {
      const created = await api.createTask(input);
      setData((current) => current ? { ...current, tasks: [created, ...(current.tasks ?? [])] } : current);
      setToast('Tarefa criada e enviada para sincronização com o Trello');
      await loadWorkspace(true);
      return created;
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível criar a tarefa.');
      throw error;
    }
  }, [api, loadWorkspace]);

  const runTaskAction = useCallback(async (id: string, input: { action: TaskAction; targetTaskId?: string; snoozeUntil?: string; dueAt?: string; comment?: string }) => {
    try {
      const updated = await api.runTaskAction(id, input);
      if (input.action === 'merge') await api.sendFeedback({ itemId: id, action: 'merge', context: 'inbox' });
      setData((current) => current ? {
        ...current,
        tasks: current.tasks?.map((item) => item.id === id ? updated : item),
        focus: ['complete', 'cancel', 'merge'].includes(input.action) ? current.focus.filter((item) => item.id !== id) : current.focus,
      } : current);
      setSelectedTask((current) => current?.id === id ? updated : current);
      setToast(input.action === 'complete' ? 'Tarefa concluída' : input.action === 'cancel' ? 'Tarefa cancelada' : input.action === 'merge' ? 'Tarefas mescladas' : input.action === 'snooze' ? 'Tarefa adiada para amanhã' : input.action === 'reschedule' ? 'Novo prazo salvo' : input.action === 'comment' ? 'Comentário enviado ao Trello' : 'Tarefa atualizada');
      await loadWorkspace(true);
      if (['complete', 'cancel', 'merge'].includes(input.action)) window.setTimeout(() => setSelectedTask((current) => current?.id === id ? null : current), 450);
    } catch (error) { setToast(error instanceof Error ? error.message : 'Não foi possível atualizar a tarefa.'); }
  }, [api, loadWorkspace]);

  const resolveTaskConflict = useCallback(async (id: string, resolution: 'keep_atlas' | 'keep_trello') => {
    try {
      const updated = await api.resolveTaskConflict(id, resolution);
      setData((current) => {
        if (!current) return current;
        const assistantInbox = current.assistantInbox?.filter(
          (item) => item.kind !== 'conflict' || item.targetId !== id,
        );
        return {
          ...current,
          tasks: current.tasks?.map((item) => item.id === id ? updated : item),
          assistantInbox,
          stats: { ...current.stats, inbox: assistantInbox?.length ?? current.stats.inbox },
        };
      });
      setSelectedTask((current) => current?.id === id ? updated : current);
      setToast(resolution === 'keep_atlas'
        ? 'A versão do Atlas será enviada ao Trello'
        : 'A versão do Trello foi mantida');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível resolver o conflito.');
    }
  }, [api]);

  const runCommitmentAction = useCallback(async (id: string, input: { status?: 'open' | 'waiting' | 'fulfilled' | 'cancelled'; dueAt?: string | null; nextFollowUpAt?: string | null }) => {
    try {
      const updated = await api.updateCommitment(id, input);
      setData((current) => current ? {
        ...current,
        commitments: current.commitments?.map((item) => item.id === id ? updated : item),
      } : current);
      setToast(input.status === 'fulfilled' ? 'Compromisso concluído' : input.status === 'cancelled' ? 'Compromisso cancelado' : 'Follow-up reagendado');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Não foi possível atualizar o compromisso.');
    }
  }, [api]);

  const actOnLearning = useCallback(async (id: string, action: LearningAction, statement?: string) => {
    try {
      const result = await api.actOnLearning(id, { action, ...(statement ? { statement } : {}) });
      setData((current) => {
        if (!current) return current;
        if ('deleted' in result) return { ...current, learnings: current.learnings?.filter((item) => item.id !== id), assistantInbox: current.assistantInbox?.filter((item) => item.targetId !== id) };
        const withoutPrevious = current.learnings?.filter((item) => item.id !== id && item.id !== result.id) ?? [];
        return { ...current, learnings: [result, ...withoutPrevious], assistantInbox: action === 'confirm' || action === 'reject' ? current.assistantInbox?.filter((item) => item.targetId !== id) : current.assistantInbox };
      });
      const labels: Record<LearningAction, string> = { confirm: 'Aprendizado confirmado', pause: 'Aprendizado pausado', resume: 'Aprendizado reativado', reject: 'Sugestão rejeitada', forget: 'Aprendizado esquecido', update: 'Aprendizado atualizado', undo: 'Última alteração desfeita' };
      setToast(labels[action]);
    } catch (error) { setToast(error instanceof Error ? error.message : 'Não foi possível atualizar o aprendizado.'); }
  }, [api]);

  const teachAtlas = useCallback(async (input: { statement: string; title?: string }) => {
    try {
      const learning = await api.teachAtlas(input);
      setData((current) => current ? { ...current, learnings: [learning, ...(current.learnings ?? [])] } : current);
      setToast('Atlas aprendeu e vinculou uma nota ao Segundo Cérebro');
    } catch (error) { setToast(error instanceof Error ? error.message : 'Não foi possível ensinar ao Atlas.'); }
  }, [api]);

  const replanDay = useCallback(async () => {
    try {
      const result = await api.askAi({ message: 'Replaneje meu dia com até três prioridades, considerando prazos, compromissos e tempo disponível.', context: { view: 'today' } });
      setData((current) => current ? { ...current, briefing: result.answer } : current);
      setToast('Seu plano do dia foi atualizado');
    } catch (error) { setToast(error instanceof Error ? error.message : 'Não foi possível replanejar agora.'); }
  }, [api]);

  const createAutomation = useCallback(async (input: { kind: 'briefing' | 'deadline' | 'overdue' | 'follow_up' | 'stale_task' | 'weekly_review'; time?: string }) => {
    try {
      const created = await api.createAutomation(input);
      setData((current) => current ? { ...current, automations: [...current.automations, created] } : current);
      setToast('Automação criada');
    } catch (error) { setToast(error instanceof Error ? error.message : 'Não foi possível criar a automação.'); }
  }, [api]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        setMobileMenuOpen(false);
        setNotificationsOpen(false);
        setAiMobileOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  const groupedNav = useMemo(() => ({
    main: navItems.filter((item) => item.section === 'main'),
    organize: navItems.filter((item) => item.section === 'organize'),
    system: navItems.filter((item) => item.section === 'system'),
  }), []);
  const displayName = session.user.preferredName || session.user.name || 'Você';

  return (
    <main className={`workspace ${api.isPreview ? 'workspace--preview' : ''}`}>
      {api.isPreview && <div className="preview-bar"><span><Sparkles size={13} /> Preview demonstrativo · os dados desta tela são fictícios</span><button type="button" onClick={onExitPreview}>Sair do preview <X size={13} /></button></div>}
      <div className="workspace-grid">
        <aside className="sidebar">
          <div className="sidebar__brand"><Brand /></div>
          <button className="sidebar-search" type="button" onClick={() => setPaletteOpen(true)}><Search size={15} /><span>Buscar</span><kbd>Ctrl K</kbd></button>
          <nav aria-label="Navegação principal">
            <NavGroup items={groupedNav.main} activeView={activeView} onNavigate={navigate} />
            <span className="nav-section-label">Organizar</span>
            <NavGroup items={groupedNav.organize} activeView={activeView} onNavigate={navigate} />
            <span className="nav-section-label">Sistema</span>
            <NavGroup items={groupedNav.system} activeView={activeView} onNavigate={navigate} />
          </nav>
          <div className="sidebar__capture"><span><Plus size={16} /></span><div><strong>Captura rápida</strong><small>Transforme uma ideia em nota</small></div><button type="button" onClick={() => void createNote()} aria-label="Criar nota"><Command size={13} /> N</button></div>
          <div className="sidebar__profile">
             <button type="button" onClick={() => setProfileOpen((current) => !current)} aria-expanded={profileOpen}><Avatar name={displayName} /><span><strong>{displayName}</strong><small>{session.user.email}</small></span><ChevronDown size={15} /></button>
            {profileOpen && <div className="profile-menu"><button type="button" onClick={() => navigate('settings')}><Brain size={15} /> Meu espaço</button><button type="button" onClick={() => void onLogout()}><LogOut size={15} /> Sair</button></div>}
          </div>
        </aside>

        <section className="content-panel">
          <header className="topbar">
            <div className="topbar__mobile-brand"><Brand compact /></div>
            <div className="breadcrumbs"><span>Atlas</span><ChevronDown size={13} /><strong>{viewMeta[activeView].title}</strong></div>
            <button className="topbar-search" type="button" onClick={() => setPaletteOpen(true)}><Search size={15} /><span>Busque notas, pessoas ou projetos…</span><kbd>⌘ K</kbd></button>
            <div className="topbar__actions">
              <div className="notification-anchor">
                <button className="icon-button" type="button" aria-label="Notificações" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((current) => !current)}><Bell size={17} />{(data?.activities.length ?? 0) > 0 && <i />}</button>
                {notificationsOpen && (
                  <div className="notification-menu" role="menu" aria-label="Atividade recente">
                    <header><strong>Atividade recente</strong><button type="button" onClick={() => setNotificationsOpen(false)} aria-label="Fechar notificações"><X size={14} /></button></header>
                    {data?.activities.length ? data.activities.slice(0, 8).map((item) => (
                      <article key={item.id}>
                        <span className={`activity-kind activity-kind--${item.kind}`}>{item.kind === 'whatsapp' ? <MessageCircle size={13} /> : item.kind === 'trello' ? <SquareKanban size={13} /> : item.kind === 'ai' ? <Sparkles size={13} /> : <Brain size={13} />}</span>
                        <div><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</div>
                        <time>{formatRelativeTime(item.at)}</time>
                      </article>
                    )) : <p className="notification-menu__empty">Nenhuma atividade por enquanto.</p>}
                  </div>
                )}
              </div>
              <button className="icon-button topbar-ai-button" type="button" onClick={() => setAiMobileOpen(true)} aria-label="Abrir assistente"><PanelRightOpen size={18} /></button>
              <button className="button button--primary button--small topbar-new-note" type="button" onClick={() => void createNote()}><Plus size={15} /> Nova nota</button>
              <Avatar name={displayName} size="small" />
            </div>
          </header>

          <div className="content-scroll">
            {loading ? <WorkspaceSkeleton /> : loadError ? <div className="workspace-error"><ErrorState title="Não conseguimos abrir seu espaço" message={loadError} onRetry={() => void loadWorkspace()} extra={!api.isPreview ? <button className="button button--ghost button--small" type="button" onClick={onEnterPreview}>Abrir preview com dados fictícios</button> : undefined} /></div> : data ? (
              <ViewContent
                activeView={activeView}
                data={data}
                selectedNoteId={selectedNoteId}
                note={note}
                noteLoading={noteLoading}
                noteError={noteError}
                onSelectNote={openNote}
                onNewNote={() => void createNote()}
                onSaveNote={saveNote}
                onRetryNote={() => void loadNote()}
                onToggleAutomation={(id, enabled) => void toggleAutomation(id, enabled)}
                onUpdateSettings={(input) => void updateSettings(input)}
                conversationLoading={conversationLoading}
                conversationError={conversationError}
                onRefreshConversations={() => void loadConversationSettings()}
                onUpdateChat={(id, input) => void updateChat(id, input)}
                onCreateChatGroup={(input) => void createChatGroup(input)}
                onDeleteChatGroup={(id) => void deleteChatGroup(id)}
                 onCreateTask={createTask}
                 onRefreshWorkspace={() => void loadWorkspace()}
                 onFeedback={(itemId, action, context) => void sendFeedback(itemId, action, context)}
                 onOpenTask={(id) => void openTask(id)}
                 onTaskAction={(id, input) => void runTaskAction(id, input)}
                 onCommitmentAction={(id, input) => void runCommitmentAction(id, input)}
                 onLearningAction={(id, action, statement) => void actOnLearning(id, action, statement)}
                 onTeachAtlas={(input) => void teachAtlas(input)}
                 onLoadLearningEvidence={(id) => api.listLearningEvidence(id)}
                 onReplan={() => void replanDay()}
                 onCreateAutomation={(input) => void createAutomation(input)}
                 onLoadChats={() => api.listChats()}
                 onToggleChat={(id, enabled) => api.updateChat(id, enabled)}
                 onToggleAllChats={(enabled) => api.setAllChatsMonitored(enabled)}
              />
            ) : null}
          </div>
        </section>

        <AIAssistant api={api} view={activeView} noteId={selectedNoteId} tasks={data?.tasks ?? []} mobileOpen={aiMobileOpen} onMobileClose={() => setAiMobileOpen(false)} onOpenNote={openAiSource} />
        {aiMobileOpen && <button type="button" className="mobile-overlay" onClick={() => setAiMobileOpen(false)} aria-label="Fechar assistente" />}

      </div>

      <TaskDrawer
        task={selectedTask}
        availableTasks={(data?.tasks ?? []).filter((task) => !['completed', 'done', 'cancelled', 'merged'].includes(task.status))}
        onClose={() => setSelectedTask(null)}
        onUpdate={(id, input) => void updateTask(id, input)}
        onAction={(id, input) => void runTaskAction(id, input)}
        onResolveConflict={(id, resolution) => void resolveTaskConflict(id, resolution)}
      />

      <nav className="mobile-nav" aria-label="Navegação móvel">
        {mobileNavIds.map((id) => {
          const item = navItems.find((entry) => entry.id === id)!;
          const Icon = item.icon;
          return <button type="button" key={id} aria-current={activeView === id ? 'page' : undefined} className={activeView === id ? 'is-active' : ''} onClick={() => navigate(id)}><Icon size={19} /><span>{item.label}</span></button>;
        })}
        <button type="button" aria-current={!mobileNavIds.includes(activeView) ? 'page' : undefined} aria-expanded={mobileMenuOpen} className={!mobileNavIds.includes(activeView) ? 'is-active' : ''} onClick={() => setMobileMenuOpen(true)}><Menu size={19} /><span>Mais</span></button>
      </nav>

      {mobileMenuOpen && <div className="mobile-sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setMobileMenuOpen(false)}><section className="mobile-sheet"><header><strong>Mais opções</strong><button type="button" onClick={() => setMobileMenuOpen(false)} aria-label="Fechar menu"><X size={18} /></button></header>{navItems.filter((item) => !mobileNavIds.includes(item.id)).map((item) => { const Icon = item.icon; return <button type="button" key={item.id} aria-current={activeView === item.id ? 'page' : undefined} className={activeView === item.id ? 'is-active' : ''} onClick={() => navigate(item.id)}><span className="mobile-sheet__icon"><Icon size={18} /></span><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronDown size={14} /></button>; })}</section></div>}

      <CommandPalette open={paletteOpen} activeView={activeView} onClose={() => setPaletteOpen(false)} onNavigate={navigate} onNewNote={() => void createNote()} />
      {toast && <div className="toast" role="status"><Check size={14} /> {toast}</div>}
    </main>
  );
}

function NavGroup({ items, activeView, onNavigate }: { items: typeof navItems; activeView: NavId; onNavigate(view: NavId): void }) {
  return <div className="nav-group">{items.map((item) => { const Icon = item.icon; return <button type="button" key={item.id} aria-current={activeView === item.id ? 'page' : undefined} className={activeView === item.id ? 'is-active' : ''} onClick={() => onNavigate(item.id)}><span className="nav-group__icon"><Icon size={17} /></span><span className="nav-group__copy"><strong>{item.label}</strong><small>{item.description}</small></span><i aria-hidden="true" /></button>; })}</div>;
}

export function formatRelativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const deltaMinutes = Math.round((Date.now() - time) / 60_000);
  if (deltaMinutes < 1) return 'agora';
  if (deltaMinutes < 60) return `há ${deltaMinutes} min`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `há ${deltaHours} h`;
  const date = new Date(time);
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function WorkspaceSkeleton() {
  return (
    <div className="workspace-skeleton" aria-label="Carregando seu espaço">
      <div className="skeleton-line skeleton-line--short" /><div className="skeleton-line skeleton-line--title" /><div className="skeleton-line skeleton-line--medium" />
      <div className="skeleton-stats">{Array.from({ length: 4 }, (_, index) => <span key={index} />)}</div>
      <div className="skeleton-panels"><span /><span /></div>
    </div>
  );
}

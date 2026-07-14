import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  BellRing,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  KeyRound,
  Link2,
  LockKeyhole,
  MessageCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserRound,
  Users,
} from 'lucide-react';
import type { AppApi } from '../api';
import type { Chat, CommunicationStyle, OnboardingStatus, Session, TrelloListRole, TrelloSetup, UserProfile, WhatsAppSession } from '../types';
import { Brand, ErrorState, LoadingScreen, Spinner } from '../components/ui';

interface OnboardingFlowProps {
  api: AppApi;
  onComplete(session: Session): void;
  onExitPreview?(): void;
}

const steps = [
  { label: 'Seu perfil', hint: 'Como Atlas ajuda você', icon: UserRound },
  { label: 'Conheça Atlas', hint: 'Seu assistente pessoal', icon: Sparkles },
  { label: 'WhatsApp pessoal', hint: 'Leitura protegida', icon: Smartphone },
  { label: 'Trello', hint: 'Autorize o acesso', icon: Link2 },
  { label: 'Seu fluxo', hint: 'Mapeie as listas', icon: KeyRound },
  { label: 'Conversas', hint: 'Escolha o que acompanhar', icon: MessageCircle },
  { label: 'Lembretes', hint: 'Revise os horários', icon: BellRing },
] as const;

const defaultProfile = (): UserProfile => ({
  preferredName: '',
  fullName: null,
  occupation: null,
  goals: [''],
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo',
  locale: navigator.language || 'pt-BR',
  workDays: [1, 2, 3, 4, 5],
  workStart: '08:00',
  workEnd: '18:00',
  quietStart: '21:00',
  quietEnd: '07:00',
  communicationStyle: 'balanced',
});

const weekdays = [
  { id: 1, short: 'S', label: 'Segunda-feira' },
  { id: 2, short: 'T', label: 'Terça-feira' },
  { id: 3, short: 'Q', label: 'Quarta-feira' },
  { id: 4, short: 'Q', label: 'Quinta-feira' },
  { id: 5, short: 'S', label: 'Sexta-feira' },
  { id: 6, short: 'S', label: 'Sábado' },
  { id: 7, short: 'D', label: 'Domingo' },
] as const;

export function OnboardingFlow({ api, onComplete, onExitPreview }: OnboardingFlowProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<UserProfile>(defaultProfile);
  const [whatsapp, setWhatsapp] = useState<WhatsAppSession | null>(null);
  const [trelloConnected, setTrelloConnected] = useState(false);
  const [trello, setTrello] = useState<TrelloSetup | null>(null);
  const [trelloAuthorizing, setTrelloAuthorizing] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [chatSearch, setChatSearch] = useState('');
  const [reminderTimes, setReminderTimes] = useState(['08:00', '18:00']);
  const [notifySelf, setNotifySelf] = useState(true);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const hydrate = useCallback((status: OnboardingStatus, background = false) => {
    if (!background) setStep(Math.min(Math.max(status.step || 0, 0), steps.length - 1));
    if (status.profile) setProfile(status.profile);
    setWhatsapp(status.whatsapp);
    setTrelloConnected(status.trelloConnected);
    setTrello(status.trello || null);
    if (!background) setSelectedChatIds(status.selectedChatIds || []);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const status = await api.getOnboarding();
      hydrate(status);
      if (!status.profile) {
        try { setProfile(await api.getProfile()); } catch { /* Registration data will seed the empty form. */ }
      }
      if (status.trelloConnected || new URLSearchParams(window.location.search).get('trello') === 'connected') {
        const setup = await api.getTrelloSetup();
        setTrello(setup);
        setTrelloConnected(setup.connected);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Não foi possível carregar a configuração.');
    } finally {
      setLoading(false);
    }
  }, [api, hydrate]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let refreshTimer: number | undefined;
    const unsubscribe = api.subscribeEvents((event) => {
      if (!event.eventType.startsWith('whatsapp.') && !event.eventType.startsWith('trello.') && event.eventType !== 'onboarding.completed') return;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(async () => {
        try {
          const status = await api.getOnboarding();
          hydrate(status, true);
          if (status.trelloConnected) {
            const setup = await api.getTrelloSetup();
            setTrello(setup);
            setTrelloConnected(setup.connected);
            if (setup.connected) setTrelloAuthorizing(false);
          }
        } catch { /* Polling and explicit retries remain available. */ }
      }, 200);
    });
    return () => {
      unsubscribe();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [api, hydrate]);

  useEffect(() => {
    if (!whatsapp || !['qr', 'connecting', 'reconnecting'].includes(whatsapp.status)) return;
    const id = window.setInterval(async () => {
      try { setWhatsapp(await api.getWhatsAppSession(whatsapp.id)); } catch { /* Keep the current QR visible. */ }
    }, api.isPreview ? 800 : 2500);
    return () => window.clearInterval(id);
  }, [api, whatsapp?.id, whatsapp?.status]);

  useEffect(() => {
    if (!trelloAuthorizing) return;
    const id = window.setInterval(async () => {
      try {
        const setup = await api.getTrelloSetup();
        setTrello(setup);
        setTrelloConnected(setup.connected);
        if (setup.connected) setTrelloAuthorizing(false);
      } catch { /* The callback can take a moment. */ }
    }, api.isPreview ? 500 : 1800);
    return () => window.clearInterval(id);
  }, [api, trelloAuthorizing]);

  useEffect(() => {
    if (step !== 5 || chats.length) return;
    setWorking(true);
    api.listChats()
      .then((items) => {
        setChats(items);
        if (!selectedChatIds.length) setSelectedChatIds(items.filter((chat) => chat.selected).map((chat) => chat.id));
      })
      .catch((error) => setActionError(error instanceof Error ? error.message : 'Não foi possível carregar suas conversas.'))
      .finally(() => setWorking(false));
  }, [api, chats.length, selectedChatIds.length, step]);

  const filteredChats = useMemo(() => {
    const query = chatSearch.trim().toLocaleLowerCase('pt-BR');
    return chats.filter((chat) => !query || chat.name.toLocaleLowerCase('pt-BR').includes(query));
  }, [chatSearch, chats]);

  const updateProfile = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => setProfile((current) => ({ ...current, [key]: value }));
  const profileReady = Boolean(profile.preferredName.trim() && profile.occupation?.trim() && profile.goals.some((goal) => goal.trim()) && profile.workDays.length);

  const saveProfile = async () => {
    if (!profileReady) return;
    setWorking(true);
    setActionError(null);
    try {
      const clean = { ...profile, fullName: profile.fullName?.trim() || null, occupation: profile.occupation?.trim() || null, goals: profile.goals.map((goal) => goal.trim()).filter(Boolean).slice(0, 3) };
      setProfile(await api.updateProfile(clean));
      setStep(1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Não foi possível salvar seu perfil.');
    } finally { setWorking(false); }
  };

  const startWhatsApp = async () => {
    setWorking(true); setActionError(null);
    try { setWhatsapp(await api.createWhatsAppSession()); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Não foi possível gerar o QR Code.'); }
    finally { setWorking(false); }
  };

  const connectTrello = async () => {
    setWorking(true); setActionError(null);
    try {
      const result = await api.startTrelloAuthorization();
      setTrelloAuthorizing(true);
      if (api.isPreview) {
        const setup = await api.getTrelloSetup();
        setTrello(setup); setTrelloConnected(setup.connected); setTrelloAuthorizing(false);
      } else {
        const popup = window.open(result.authorizationUrl, 'atlas-trello-auth', 'popup,width=620,height=760');
        if (!popup) window.location.assign(result.authorizationUrl);
      }
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Não foi possível conectar o Trello.'); }
    finally { setWorking(false); }
  };

  const chooseBoard = async (boardId: string) => {
    if (!boardId) return;
    setWorking(true); setActionError(null);
    try { setTrello(await api.selectTrelloBoard(boardId)); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Não foi possível carregar as listas deste quadro.'); }
    finally { setWorking(false); }
  };

  const setListRole = (role: TrelloListRole, listId: string) => setTrello((current) => current ? { ...current, mapping: { ...current.mapping, [role]: listId } } : current);
  const mappingReady = Boolean(trello?.selectedBoardId && trello.mapping.inbox && trello.mapping.inProgress && trello.mapping.paused && trello.mapping.completed);

  const saveMapping = async () => {
    if (!trello?.selectedBoardId || !mappingReady) return;
    const { inbox, inProgress, paused, completed } = trello.mapping;
    setWorking(true); setActionError(null);
    try {
      setTrello(await api.saveTrelloMapping({ boardId: trello.selectedBoardId, mapping: { inbox: inbox!, inProgress: inProgress!, paused: paused!, completed: completed! } }));
      setStep(5);
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Não foi possível salvar o mapeamento.'); }
    finally { setWorking(false); }
  };

  const finish = async () => {
    setWorking(true); setActionError(null);
    try {
      await api.updateSettings({ reminderTimes, notifySelf });
      onComplete(await api.completeOnboarding({ selectedChatIds, notifySelf }));
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Não foi possível concluir a configuração.'); }
    finally { setWorking(false); }
  };

  if (loading) return <LoadingScreen label="Preparando seu espaço" />;
  if (loadError) return <main className="onboarding-shell onboarding-shell--centered"><Brand /><ErrorState message={loadError} onRetry={() => void load()} extra={api.isPreview && onExitPreview ? <button className="button button--ghost button--small" onClick={onExitPreview}>Sair do preview</button> : undefined} /></main>;

  const whatsappConnected = whatsapp?.status === 'connected';
  const whatsappQrReady = whatsapp?.status === 'qr' && Boolean(whatsapp.qrDataUrl || api.isPreview);
  const whatsappWaiting = whatsapp?.status === 'connecting' || whatsapp?.status === 'reconnecting';

  return (
    <main className="onboarding-shell">
      <header className="onboarding-header"><Brand /><div className="onboarding-header__right">{api.isPreview && <span className="preview-badge">Preview</span>}<span>Configuração pessoal</span></div></header>
      <div className="onboarding-layout">
        <aside className="onboarding-steps" aria-label="Etapas da configuração">
          <div><span className="eyebrow">Seu Atlas</span><h2>Vamos montar seu espaço</h2><p>Atlas aprende com você, nunca com o perfil de outra pessoa.</p></div>
          <ol>{steps.map((item, index) => { const Icon = item.icon; const complete = index < step; return <li key={item.label} className={`${index === step ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}><span>{complete ? <Check size={15} /> : <Icon size={15} />}</span><div><strong>{item.label}</strong><small>{item.hint}</small></div></li>; })}</ol>
          <div className="privacy-card"><ShieldCheck size={18} /><div><strong>Um perfil por pessoa</strong><p>Nomes, metas, integrações e aprendizados permanecem separados por conta.</p></div></div>
        </aside>

        <section className="onboarding-stage">
          {actionError && <div className="form-error" role="alert">{actionError}</div>}

          {step === 0 && <ProfileStep profile={profile} onUpdate={updateProfile} />}

          {step === 1 && (
            <div className="onboarding-content welcome-step">
              <span className="hero-orb"><span>A</span></span>
              <span className="eyebrow">Prazer, {profile.preferredName}</span>
              <h1>Eu sou Atlas, seu assistente pessoal.</h1>
              <p>Vou conectar o que você conversa, decide e precisa fazer. Serei direto, calmo e proativo — e sempre explicarei por que algo merece sua atenção.</p>
              <div className="welcome-grid">
                <article><MessageCircle size={20} /><strong>Transformo conversa em ação</strong><span>Sem responder contatos por conta própria.</span></article>
                <article><BriefcaseBusiness size={20} /><strong>Cuido dos compromissos</strong><span>Tarefas, prazos e follow-ups no mesmo contexto.</span></article>
                <article><Sparkles size={20} /><strong>Aprendo com suas correções</strong><span>Você pode revisar, pausar ou esquecer qualquer aprendizado.</span></article>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="onboarding-content connector-step">
              <span className="eyebrow">Leitor pessoal</span><h1>Conecte seu WhatsApp para o Atlas ler</h1>
              <p>Abra “Aparelhos conectados” e leia o QR Code. Esta sessão apenas lê as conversas escolhidas; todo envio será feito pelo número central do Atlas.</p>
              {!whatsapp && <div className="connection-intro"><span className="connection-icon"><Smartphone size={30} /></span><div><strong>Pronto para parear</strong><span>O código expira rapidamente e pode ser renovado.</span></div><button className="button button--primary" type="button" onClick={() => void startWhatsApp()} disabled={working}>{working ? <Spinner label="Gerando" /> : <>Gerar QR Code <ArrowRight size={16} /></>}</button></div>}
              {whatsapp && !whatsappConnected && whatsappQrReady && <div className="qr-layout"><div className="qr-card">{whatsapp.qrDataUrl ? <img src={whatsapp.qrDataUrl} alt="QR Code para conectar o WhatsApp" /> : <DemoQr />}<span className="qr-scan-line" aria-hidden="true" /></div><div className="qr-instructions"><strong>Leia com seu celular</strong><ol><li>Abra o WhatsApp</li><li>Toque em Aparelhos conectados</li><li>Escolha Conectar aparelho</li><li>Aponte para este código</li></ol><button type="button" className="text-link" onClick={() => void startWhatsApp()} disabled={working}><RefreshCw size={14} /> Renovar QR Code</button></div></div>}
              {whatsapp && !whatsappConnected && whatsappWaiting && <div className="connection-intro"><span className="connection-icon"><Spinner label={whatsapp.status === 'reconnecting' ? 'Reconectando' : 'Preparando'} /></span><div><strong>{whatsapp.status === 'reconnecting' ? 'Reconectando seu WhatsApp' : 'Preparando um QR Code seguro'}</strong><span>{whatsapp.status === 'reconnecting' ? 'Sua sessão persistida está sendo retomada; não leia outro código ainda.' : 'Aguarde alguns instantes. O código real aparecerá assim que estiver pronto.'}</span></div></div>}
              {whatsapp && !whatsappConnected && !whatsappWaiting && !whatsappQrReady && <div className="connection-intro connection-intro--error"><span className="connection-icon"><AlertTriangle size={24} /></span><div><strong>{whatsapp.status === 'error' ? 'Não foi possível conectar' : 'WhatsApp desconectado'}</strong><span>{whatsapp.error || 'Gere um novo QR Code para tentar novamente.'}</span></div><button className="button button--secondary" type="button" onClick={() => void startWhatsApp()} disabled={working}>{working ? <Spinner label="Tentando" /> : <><RefreshCw size={14} /> Tentar novamente</>}</button></div>}
              {whatsappConnected && <div className="connection-success"><CheckCircle2 size={28} /><div><strong>WhatsApp pessoal conectado somente para leitura</strong><span>{whatsapp.phoneLabel ? `${whatsapp.phoneLabel} identificado automaticamente` : 'Seu número foi identificado automaticamente.'}</span></div></div>}
              <div className="security-note"><LockKeyhole size={15} /> Atlas nunca pede o código recebido por SMS nem sua senha.</div>
            </div>
          )}

          {step === 3 && (
            <div className="onboarding-content connector-step">
              <span className="eyebrow">Tarefas conectadas</span><h1>Conecte seu Trello</h1><p>Autorize Atlas no fluxo oficial do Trello. Você não precisa copiar chaves ou tokens.</p>
              {trelloConnected ? (
                <div className="trello-connected-stack">
                  <div className="connection-success connection-success--large"><CheckCircle2 size={32} /><div><strong>Trello conectado</strong><span>{trello?.accountName ? `Conta ${trello.accountName} autorizada.` : 'A autorização foi confirmada.'}</span></div></div>
                  <section className="trello-tutorial" aria-labelledby="trello-tutorial-title">
                    <header><span className="delegated-auth-card__icon"><SquareTrello /></span><div><span className="eyebrow">Tutorial rápido</span><h2 id="trello-tutorial-title">Como o Atlas usa o Trello</h2><p>O quadro reúne seu trabalho, cada lista representa uma fase e cada cartão é uma tarefa.</p></div></header>
                    <div className="trello-tutorial__flow" aria-label="Fluxo de uma tarefa no Trello">
                      <article><span>1</span><div><strong>Entrada</strong><small>Uma mensagem ou ideia vira cartão.</small></div></article>
                      <article><span>2</span><div><strong>Em andamento</strong><small>O cartão mostra o que está sendo feito.</small></div></article>
                      <article><span>3</span><div><strong>Pausado</strong><small>Use quando faltar contexto ou resposta.</small></div></article>
                      <article><span>4</span><div><strong>Concluído</strong><small>Finalize para o Atlas registrar o resultado.</small></div></article>
                    </div>
                    <div className="trello-tutorial__rules">
                      <p><CheckCircle2 size={15} /><span><strong>Sincronização em duas vias</strong> — alterações feitas no Atlas ou no Trello permanecem alinhadas.</span></p>
                      <p><ShieldCheck size={15} /><span><strong>Seu conteúdo continua seu</strong> — o Atlas preserva descrições manuais e altera somente a área que ele gerencia.</span></p>
                    </div>
                    <p className="trello-tutorial__next"><ArrowRight size={15} /> Na próxima etapa você escolhe o quadro e relaciona suas listas com essas quatro fases.</p>
                  </section>
                </div>
              ) : <div className="delegated-auth-card"><span className="delegated-auth-card__icon"><SquareTrello /></span><div><strong>Autorização delegada</strong><p>O Trello mostra exatamente quais permissões serão concedidas. Atlas nunca vê sua senha.</p></div><ul><li><Check size={13} /> Ler o quadro escolhido</li><li><Check size={13} /> Criar e atualizar cartões</li><li><Check size={13} /> Revogar quando quiser</li></ul><button className="button button--primary button--wide" type="button" onClick={() => void connectTrello()} disabled={working || trelloAuthorizing}>{working || trelloAuthorizing ? <Spinner label="Aguardando autorização" /> : <>Continuar no Trello <ExternalLink size={16} /></>}</button></div>}
            </div>
          )}

          {step === 4 && (
            <div className="onboarding-content mapping-step"><span className="eyebrow">Seu fluxo</span><h1>Mostre como seu quadro funciona</h1><p>Relacione as quatro listas essenciais. Atlas preserva o conteúdo manual dos cartões.</p><div className="board-mapping-card"><label><span>Quadro principal</span><select value={trello?.selectedBoardId || ''} onChange={(event) => void chooseBoard(event.target.value)} disabled={working}><option value="">Escolha um quadro</option>{trello?.boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}</select></label>{trello?.selectedBoardId ? <div className="mapping-grid">{([['inbox', 'Entrada', 'Novas tarefas e ideias'], ['inProgress', 'Em andamento', 'O que está sendo executado'], ['paused', 'Pausado', 'Itens aguardando contexto'], ['completed', 'Concluído', 'Trabalho finalizado']] as const).map(([role, label, description]) => <label key={role}><span><strong>{label}</strong><small>{description}</small></span><select value={trello.mapping[role] || ''} onChange={(event) => setListRole(role, event.target.value)}><option value="">Selecione uma lista</option>{trello.lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>)}</div> : <div className="mapping-placeholder"><KeyRound size={22} /><span>Escolha um quadro para carregar suas listas.</span></div>}<button className="button button--primary button--wide" type="button" onClick={() => void saveMapping()} disabled={working || !mappingReady}>{working ? <Spinner label="Salvando fluxo" /> : <>Salvar e continuar <ArrowRight size={16} /></>}</button></div></div>
          )}

          {step === 5 && (
            <div className="onboarding-content chats-step"><span className="eyebrow">Fontes autorizadas</span><h1>Escolha as conversas que importam</h1><p>Somente as conversas selecionadas serão acompanhadas. O nome da conta WhatsApp nunca substituirá seu nome preferido sem confirmação.</p><div className="chat-picker"><label className="search-field"><Search size={16} /><input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Buscar conversas" /></label><div className="chat-picker__meta"><span>{selectedChatIds.length} selecionada{selectedChatIds.length === 1 ? '' : 's'}</span><button className="text-link" type="button" onClick={() => setSelectedChatIds(chats.map((chat) => chat.id))}>Selecionar todas</button></div><div className="chat-list">{working ? <div className="chat-list__loading"><Spinner label="Buscando conversas" /></div> : filteredChats.length ? filteredChats.map((chat) => { const selected = selectedChatIds.includes(chat.id); return <button type="button" key={chat.id} className={`chat-row ${selected ? 'is-selected' : ''}`} onClick={() => setSelectedChatIds((current) => selected ? current.filter((id) => id !== chat.id) : [...current, chat.id])} aria-pressed={selected}><span className="chat-avatar">{chat.kind === 'group' ? <Users size={18} /> : chat.name.slice(0, 2).toUpperCase()}</span><span><strong>{chat.name}</strong><small>{chat.kind === 'group' ? 'Grupo' : 'Conversa individual'} · {chat.lastMessageAt || 'sem mensagens recentes'}</small></span><span className="check-control">{selected && <Check size={14} />}</span></button>; }) : <p className="chat-list__empty">Nenhuma conversa encontrada.</p>}</div></div><div className="self-message-note"><MessageCircle size={17} /><div><strong>Os avisos vão somente para você.</strong><span>Atlas não envia respostas automáticas aos seus contatos.</span></div></div></div>
          )}

          {step === 6 && (
            <div className="onboarding-content reminder-review"><span className="eyebrow">Última revisão</span><h1>Quando Atlas deve falar com você?</h1><p>Você receberá briefings e alertas enviados pelo número central do Atlas, respeitando o horário silencioso.</p><div className="reminder-review__grid"><label><span><BellRing size={16} /><strong>Briefing da manhã</strong></span><input type="time" value={reminderTimes[0]} onChange={(event) => setReminderTimes([event.target.value, reminderTimes[1]])} /></label><label><span><BellRing size={16} /><strong>Briefing da tarde</strong></span><input type="time" value={reminderTimes[1]} onChange={(event) => setReminderTimes([reminderTimes[0], event.target.value])} /></label><article><span><Clock3 size={16} /><strong>Horário silencioso</strong></span><p>{profile.quietStart} até {profile.quietEnd}</p></article><label className="reminder-toggle"><span><MessageCircle size={16} /><span><strong>Receber mensagens do Atlas</strong><small>O número mãe conversa com você; sua sessão pessoal nunca envia.</small></span></span><span className="switch"><input type="checkbox" checked={notifySelf} onChange={(event) => setNotifySelf(event.target.checked)} /><i /></span></label></div><div className="atlas-promise"><Sparkles size={19} /><div><strong>Começarei com calma.</strong><p>Vou priorizar até três itens, consolidar alertas vencidos e aprender com o que você concluir, adiar ou corrigir.</p></div></div></div>
          )}

          <footer className="onboarding-actions">
            <button className="button button--ghost" type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || working}><ArrowLeft size={16} /> Voltar</button>
            {step === 0 ? <button className="button button--primary" type="button" onClick={() => void saveProfile()} disabled={working || !profileReady}>{working ? <Spinner label="Salvando" /> : <>Salvar perfil <ArrowRight size={16} /></>}</button>
              : step === 4 ? <span aria-hidden="true" />
                : step < 6 ? <button className="button button--primary" type="button" onClick={() => setStep((current) => Math.min(6, current + 1))} disabled={(step === 2 && !whatsappConnected) || (step === 3 && !trelloConnected) || (step === 5 && selectedChatIds.length === 0)}>Continuar <ArrowRight size={16} /></button>
                  : <button className="button button--primary" type="button" onClick={() => void finish()} disabled={working}>{working ? <Spinner label="Finalizando" /> : <>Entrar no Atlas <ArrowRight size={16} /></>}</button>}
          </footer>
        </section>
      </div>
    </main>
  );
}

function ProfileStep({ profile, onUpdate }: { profile: UserProfile; onUpdate<K extends keyof UserProfile>(key: K, value: UserProfile[K]): void }) {
  const setGoal = (index: number, value: string) => { const goals = [...profile.goals]; goals[index] = value; onUpdate('goals', goals); };
  const setStyle = (style: CommunicationStyle) => onUpdate('communicationStyle', style);
  return (
    <div className="onboarding-content profile-step">
      <span className="eyebrow">Feito para você</span><h1>Conte o essencial sobre sua rotina</h1><p>Esses dados ajudam Atlas a priorizar e lembrar no momento certo. Nada aqui vale para outros usuários.</p>
      <div className="profile-form">
        <div className="profile-form__row"><label><span>Nome preferido</span><input value={profile.preferredName} onChange={(event) => onUpdate('preferredName', event.target.value)} placeholder="Como Atlas chama você" required /></label><label><span>Nome completo <small>opcional</small></span><input value={profile.fullName || ''} onChange={(event) => onUpdate('fullName', event.target.value || null)} placeholder="Seu nome completo" /></label></div>
        <label><span>Área de atuação</span><input value={profile.occupation || ''} onChange={(event) => onUpdate('occupation', event.target.value || null)} placeholder="Ex.: gestão, vendas, campo, estudos" required /></label>
        <fieldset><legend>Até três objetivos</legend>{[0, 1, 2].map((index) => <input key={index} value={profile.goals[index] || ''} onChange={(event) => setGoal(index, event.target.value)} placeholder={index === 0 ? 'Seu principal objetivo agora' : `Objetivo ${index + 1} (opcional)`} required={index === 0} />)}</fieldset>
        <div className="profile-form__row"><label><span>Fuso horário</span><select value={profile.timezone} onChange={(event) => onUpdate('timezone', event.target.value)}><option value="America/Sao_Paulo">Brasília · São Paulo</option><option value="America/Manaus">Manaus</option><option value="America/Cuiaba">Cuiabá</option><option value="America/Rio_Branco">Rio Branco</option><option value="America/Fortaleza">Fortaleza</option><option value="Europe/Lisbon">Lisboa</option></select></label><label><span>Idioma</span><select value={profile.locale} onChange={(event) => onUpdate('locale', event.target.value)}><option value="pt-BR">Português (Brasil)</option><option value="pt-PT">Português (Portugal)</option><option value="en-US">English</option><option value="es-ES">Español</option></select></label></div>
        <fieldset><legend>Dias de trabalho</legend><div className="weekday-picker">{weekdays.map((day) => { const selected = profile.workDays.includes(day.id); return <button type="button" key={day.id} className={selected ? 'is-selected' : ''} aria-pressed={selected} aria-label={day.label} onClick={() => onUpdate('workDays', selected ? profile.workDays.filter((id) => id !== day.id) : [...profile.workDays, day.id].sort())}>{day.short}</button>; })}</div></fieldset>
        <div className="profile-form__time-grid"><label><span>Começo do trabalho</span><input type="time" value={profile.workStart} onChange={(event) => onUpdate('workStart', event.target.value)} /></label><label><span>Fim do trabalho</span><input type="time" value={profile.workEnd} onChange={(event) => onUpdate('workEnd', event.target.value)} /></label><label><span>Silêncio a partir de</span><input type="time" value={profile.quietStart} onChange={(event) => onUpdate('quietStart', event.target.value)} /></label><label><span>Voltar a falar às</span><input type="time" value={profile.quietEnd} onChange={(event) => onUpdate('quietEnd', event.target.value)} /></label></div>
        <fieldset><legend>Como Atlas deve se comunicar?</legend><div className="style-picker">{([['concise', 'Direto', 'Só o essencial'], ['balanced', 'Equilibrado', 'Contexto na medida'], ['detailed', 'Detalhado', 'Explica cada decisão']] as const).map(([id, title, description]) => <button type="button" key={id} className={profile.communicationStyle === id ? 'is-selected' : ''} aria-pressed={profile.communicationStyle === id} onClick={() => setStyle(id)}><strong>{title}</strong><small>{description}</small></button>)}</div></fieldset>
      </div>
    </div>
  );
}

function DemoQr() { return <div className="demo-qr" aria-label="QR Code demonstrativo do preview">{Array.from({ length: 121 }, (_, index) => <span key={index} className={(index * 7 + Math.floor(index / 11) * 3) % 5 < 2 ? 'is-dark' : ''} />)}<b>A</b></div>; }
function SquareTrello() { return <span className="trello-glyph" aria-hidden="true"><i /><i /></span>; }

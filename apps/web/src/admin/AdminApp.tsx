import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2, CircleAlert, Clock3, MessageCircle, Plug, Power, QrCode,
  RefreshCw, Save, Send, Smartphone, Users,
} from 'lucide-react';

type MotherStatus = 'qr' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

interface MotherConnection {
  displayName: string;
  status: MotherStatus;
  phoneLabel: string | null;
  qrDataUrl: string | null;
  qrExpiresAt: string | null;
  lastConnectedAt: string | null;
  error: string | null;
  welcomeMessage: string;
  updatedAt: string;
}

interface AdminUser {
  id: string;
  preferredName: string;
  email: string;
  phoneLabel: string | null;
  readerStatus: string | null;
  welcomeStatus: string | null;
  lastMessageAt: string | null;
}

async function adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || 'Não foi possível concluir a operação.');
  return payload as T;
}

function relativeDate(value: string | null) {
  if (!value) return 'Ainda não conversou';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

export function AdminApp() {
  const [connection, setConnection] = useState<MotherConnection | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    if (!background) setError(null);
    try {
      const [nextConnection, nextUsers] = await Promise.all([
        adminRequest<MotherConnection>('/whatsapp'),
        adminRequest<{ items: AdminUser[] }>('/users'),
      ]);
      setConnection(nextConnection);
      setUsers(nextUsers.items);
      setWelcomeMessage((current) => current || nextConnection.welcomeMessage);
      setSelectedUser((current) => current || nextUsers.items.find((user) => user.phoneLabel)?.id || '');
    } catch (reason) {
      if (!background) setError(reason instanceof Error ? reason.message : 'Falha ao carregar o painel.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 2_500);
    return () => window.clearInterval(timer);
  }, [load]);

  const connectedUsers = useMemo(() => users.filter((user) => user.phoneLabel), [users]);
  const connected = connection?.status === 'connected';

  const act = async (key: string, action: () => Promise<void>, success?: string) => {
    setWorking(key); setError(null); setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível concluir.');
    } finally { setWorking(null); }
  };

  const pair = () => act('pair', async () => {
    setConnection(await adminRequest<MotherConnection>('/whatsapp/pair', { method: 'POST' }));
  });
  const disconnect = () => act('disconnect', async () => {
    await adminRequest('/whatsapp/disconnect', { method: 'POST' });
  }, 'WhatsApp central desconectado.');
  const saveWelcome = () => act('settings', async () => {
    setConnection(await adminRequest<MotherConnection>('/settings', {
      method: 'PATCH', body: JSON.stringify({ welcomeMessage }),
    }));
  }, 'Mensagem de boas-vindas salva.');
  const sendMessage = () => act('send', async () => {
    await adminRequest('/messages', {
      method: 'POST', body: JSON.stringify({ userId: selectedUser, message }),
    });
    setMessage('');
  }, 'Mensagem colocada na fila do WhatsApp central.');

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div className="brand"><span className="brand-mark"><span>A</span></span><span className="brand-copy"><strong>Atlas Admin</strong><small>CENTRAL DE COMUNICAÇÃO</small></span></div>
        <div className={`admin-live ${connected ? 'is-online' : ''}`}><i />{connected ? `Online · ${connection?.phoneLabel}` : 'Central desconectada'}</div>
      </header>

      <div className="admin-wrap">
        <section className="admin-hero">
          <div><span className="eyebrow">WhatsApp mãe</span><h1>Uma voz para todos os usuários.</h1><p>A conta pessoal de cada usuário apenas lê as conversas escolhidas. Todas as boas-vindas, respostas e lembretes saem exclusivamente deste número central.</p></div>
          <div className="admin-metrics">
            <article><Users size={18} /><strong>{users.length}</strong><span>contas</span></article>
            <article><Smartphone size={18} /><strong>{connectedUsers.length}</strong><span>números capturados</span></article>
            <article><MessageCircle size={18} /><strong>{users.filter((user) => user.welcomeStatus === 'sent').length}</strong><span>boas-vindas enviadas</span></article>
          </div>
        </section>

        {error && <div className="admin-alert is-error"><CircleAlert size={17} /><span>{error}</span></div>}
        {notice && <div className="admin-alert is-success"><CheckCircle2 size={17} /><span>{notice}</span></div>}

        <section className="admin-grid">
          <article className="admin-card admin-connect-card">
            <div className="admin-card__heading"><div><span className="section-kicker"><Plug size={13} />CONEXÃO CENTRAL</span><h2>{connected ? 'WhatsApp pronto' : 'Conecte o número mãe'}</h2></div><span className={`admin-status admin-status--${connection?.status || 'disconnected'}`}>{connection?.status || 'carregando'}</span></div>
            {connection?.status === 'qr' && connection.qrDataUrl ? (
              <div className="admin-qr"><div className="qr-card"><img src={connection.qrDataUrl} alt="QR Code do WhatsApp central" /><span className="qr-scan-line" /></div><div><strong>Leia este QR no celular central</strong><ol><li>Abra o WhatsApp</li><li>Entre em Aparelhos conectados</li><li>Toque em Conectar aparelho</li><li>Aponte a câmera para o código</li></ol><button className="text-link" onClick={pair} disabled={working === 'pair'}><RefreshCw size={14} />Renovar código</button></div></div>
            ) : connected ? (
              <div className="admin-connected"><span><CheckCircle2 size={28} /></span><div><strong>{connection.phoneLabel}</strong><p>Este é o único número autorizado a enviar mensagens pelo Atlas.</p><small><Clock3 size={12} />Conectado em {relativeDate(connection.lastConnectedAt)}</small></div></div>
            ) : (
              <div className="admin-pair-empty"><span><QrCode size={30} /></span><div><strong>{connection?.status === 'connecting' ? 'Preparando o QR Code…' : 'Nenhum WhatsApp central conectado'}</strong><p>O QR aparecerá aqui. Não é necessário cadastrar o número manualmente.</p></div></div>
            )}
            <div className="admin-card__actions">
              {!connected && <button className="button button--primary" onClick={pair} disabled={working === 'pair'}><QrCode size={16} />{working === 'pair' ? 'Preparando…' : 'Gerar QR Code'}</button>}
              {connected && <button className="button button--ghost" onClick={disconnect} disabled={working === 'disconnect'}><Power size={16} />Desconectar</button>}
            </div>
          </article>

          <article className="admin-card">
            <div className="admin-card__heading"><div><span className="section-kicker"><MessageCircle size={13} />PRIMEIRO CONTATO</span><h2>Boas-vindas automáticas</h2></div></div>
            <p className="admin-card__description">Assim que o usuário escanear o QR pessoal, o Atlas identifica o telefone e esta mensagem entra na fila do número mãe. Use <code>{'{nome}'}</code> para personalizar.</p>
            <textarea className="admin-textarea admin-textarea--welcome" value={welcomeMessage} onChange={(event) => setWelcomeMessage(event.target.value)} maxLength={1500} />
            <div className="admin-field-meta"><span>{welcomeMessage.length}/1500</span><button className="button button--secondary button--small" onClick={saveWelcome} disabled={working === 'settings' || welcomeMessage.trim().length < 20}><Save size={14} />Salvar texto</button></div>
          </article>

          <article className="admin-card admin-compose-card">
            <div className="admin-card__heading"><div><span className="section-kicker"><Send size={13} />MENSAGEM DIRETA</span><h2>Falar com um usuário</h2></div></div>
            <label className="admin-label">Destinatário<select value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)}><option value="">Selecione uma pessoa</option>{connectedUsers.map((user) => <option key={user.id} value={user.id}>{user.preferredName} · {user.phoneLabel}</option>)}</select></label>
            <label className="admin-label">Mensagem<textarea className="admin-textarea" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Escreva como o Atlas deve falar com esta pessoa…" maxLength={4000} /></label>
            <button className="button button--primary" onClick={sendMessage} disabled={!connected || !selectedUser || !message.trim() || working === 'send'}><Send size={15} />{working === 'send' ? 'Enfileirando…' : 'Enviar pelo número mãe'}</button>
            {!connected && <small className="admin-hint">Conecte o WhatsApp central para liberar os envios.</small>}
          </article>
        </section>

        <section className="admin-card admin-users-card">
          <div className="admin-card__heading"><div><span className="section-kicker"><Users size={13} />USUÁRIOS</span><h2>Números identificados automaticamente</h2></div><button className="icon-button" onClick={() => void load()} aria-label="Atualizar usuários"><RefreshCw size={15} /></button></div>
          <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Pessoa</th><th>WhatsApp detectado</th><th>Leitor pessoal</th><th>Boas-vindas</th><th>Último contato</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><span className="admin-user"><i>{user.preferredName.slice(0, 2).toUpperCase()}</i><span><strong>{user.preferredName}</strong><small>{user.email}</small></span></span></td><td>{user.phoneLabel || <em>Aguardando QR pessoal</em>}</td><td><span className={`table-pill is-${user.readerStatus || 'disconnected'}`}>{user.readerStatus || 'não conectado'}</span></td><td><span className={`table-pill is-${user.welcomeStatus || 'waiting'}`}>{user.welcomeStatus || 'aguardando número'}</span></td><td>{relativeDate(user.lastMessageAt)}</td></tr>)}</tbody></table>{!users.length && <div className="admin-empty">Nenhum usuário cadastrado ainda.</div>}</div>
        </section>
      </div>
    </main>
  );
}

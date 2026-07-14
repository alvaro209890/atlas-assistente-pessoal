import { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  MessageCircle,
  Search,
  ShieldCheck,
  User,
  Users,
} from 'lucide-react';
import type { Chat } from '../types';

type ChatFilter = 'all' | 'monitored' | 'direct' | 'group';

interface MonitoredChatsViewProps {
  onLoadChats: () => Promise<Chat[]>;
  onToggleChat: (id: string, enabled: boolean) => Promise<{ id: string; enabled: boolean }>;
  onToggleAll: (enabled: boolean) => Promise<{ updated: number }>;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function formatWhen(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

export function MonitoredChatsView({ onLoadChats, onToggleChat, onToggleAll }: MonitoredChatsViewProps) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setError(null);
    onLoadChats()
      .then((rows) => { if (active) setChats(rows); })
      .catch(() => { if (active) setError('Não foi possível carregar suas conversas.'); });
    return () => { active = false; };
  }, [onLoadChats]);

  const stats = useMemo(() => {
    const list = chats ?? [];
    return {
      total: list.length,
      monitored: list.filter((c) => c.selected).length,
      groups: list.filter((c) => c.kind === 'group').length,
      direct: list.filter((c) => c.kind === 'direct').length,
    };
  }, [chats]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (chats ?? []).filter((chat) => {
      if (filter === 'monitored' && !chat.selected) return false;
      if (filter === 'direct' && chat.kind !== 'direct') return false;
      if (filter === 'group' && chat.kind !== 'group') return false;
      if (term && !chat.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [chats, search, filter]);

  async function toggle(chat: Chat) {
    if (pending.has(chat.id)) return;
    const next = !chat.selected;
    setChats((prev) => prev?.map((c) => (c.id === chat.id ? { ...c, selected: next } : c)) ?? prev);
    setPending((prev) => new Set(prev).add(chat.id));
    try {
      await onToggleChat(chat.id, next);
    } catch {
      // Reverte em caso de falha.
      setChats((prev) => prev?.map((c) => (c.id === chat.id ? { ...c, selected: !next } : c)) ?? prev);
    } finally {
      setPending((prev) => { const copy = new Set(prev); copy.delete(chat.id); return copy; });
    }
  }

  async function toggleAll(enabled: boolean) {
    if (bulkBusy || !chats) return;
    const snapshot = chats;
    setBulkBusy(true);
    setChats((prev) => prev?.map((c) => ({ ...c, selected: enabled })) ?? prev);
    try {
      await onToggleAll(enabled);
    } catch {
      setChats(snapshot);
    } finally {
      setBulkBusy(false);
    }
  }

  if (error) {
    return (
      <div className="chats-monitor">
        <div className="error-state">
          <span className="error-state__icon"><MessageCircle size={18} /></span>
          <div><h3>{error}</h3><p>Confirme que seu WhatsApp pessoal está conectado e tente novamente.</p></div>
        </div>
      </div>
    );
  }

  if (!chats) {
    return (
      <div className="chats-monitor chats-monitor--loading">
        <Loader2 size={18} className="chats-monitor__spin" />
        <span>Carregando suas conversas…</span>
      </div>
    );
  }

  if (chats.length === 0) {
    return (
      <div className="chats-monitor">
        <div className="empty-state">
          <span className="empty-state__icon"><MessageCircle size={20} /></span>
          <h3>Nenhuma conversa ainda</h3>
          <p>Assim que você conectar e sincronizar seu WhatsApp pessoal, suas conversas aparecem aqui para você escolher quais o Atlas acompanha.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chats-monitor">
      <div className="chats-monitor__intro">
        <span className="chats-monitor__intro-icon"><ShieldCheck size={18} /></span>
        <p>
          O Atlas <strong>apenas lê</strong> as conversas que você ativar aqui para transformar em tarefas, prazos e lembretes.
          Ele nunca responde nem envia mensagens pelo seu número.
        </p>
      </div>

      <div className="chats-monitor__stats">
        <article><strong>{stats.total}</strong><small>Conversas</small></article>
        <article className="is-accent"><strong>{stats.monitored}</strong><small>Monitoradas</small></article>
        <article><strong>{stats.direct}</strong><small>Diretas</small></article>
        <article><strong>{stats.groups}</strong><small>Grupos</small></article>
      </div>

      <div className="chats-monitor__toolbar">
        <div className="search-field chats-monitor__search">
          <Search size={14} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar conversa por nome"
            aria-label="Buscar conversa"
          />
        </div>
        <div className="chats-monitor__filters">
          {([['all', 'Todas'], ['monitored', 'Monitoradas'], ['direct', 'Diretas'], ['group', 'Grupos']] as const).map(([id, label]) => (
            <button key={id} type="button" className={filter === id ? 'is-active' : ''} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <div className="chats-monitor__bulk">
          <button type="button" className="button button--secondary button--small" disabled={bulkBusy} onClick={() => void toggleAll(true)}>Monitorar todas</button>
          <button type="button" className="button button--ghost button--small" disabled={bulkBusy} onClick={() => void toggleAll(false)}>Desativar todas</button>
        </div>
      </div>

      <div className="chats-monitor__list">
        {visible.length === 0 && <div className="chats-monitor__empty">Nenhuma conversa encontrada para este filtro.</div>}
        {visible.map((chat) => (
          <label key={chat.id} className={`chats-monitor__row ${chat.selected ? 'is-on' : ''}`}>
            <span className={`chats-monitor__avatar ${chat.kind === 'group' ? 'is-group' : ''}`}>
              {chat.kind === 'group' ? <Users size={16} /> : chat.name.trim() ? initials(chat.name) : <User size={16} />}
            </span>
            <span className="chats-monitor__meta">
              <strong>{chat.name || 'Sem nome'}</strong>
              <small>
                <span className={`chats-monitor__kind chats-monitor__kind--${chat.kind}`}>{chat.kind === 'group' ? 'Grupo' : 'Direta'}</span>
                {formatWhen(chat.lastMessageAt) && <em>· {formatWhen(chat.lastMessageAt)}</em>}
              </small>
            </span>
            <span className={`switch chats-monitor__switch ${pending.has(chat.id) ? 'is-pending' : ''}`}>
              <input type="checkbox" checked={!!chat.selected} onChange={() => void toggle(chat)} aria-label={`Monitorar ${chat.name}`} />
              <i />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

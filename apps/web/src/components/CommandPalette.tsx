import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Bot, Command, FilePlus2, PanelRightOpen, Search } from 'lucide-react';
import type { NavId } from '../types';
import { navItems } from '../workspace/navigation';

interface CommandPaletteProps {
  open: boolean;
  activeView: NavId;
  onClose(): void;
  onNavigate(view: NavId): void;
  onNewNote(): void;
  onToggleAi(): void;
}

type PaletteCommand = {
  id: string;
  label: string;
  hint: string;
  icon: typeof Search;
  action(): void;
  keywords: string;
};

export function CommandPalette({ open, activeView, onClose, onNavigate, onNewNote, onToggleAi }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<PaletteCommand[]>(() => [
    { id: 'new-note', label: 'Criar nova nota', hint: 'N', icon: FilePlus2, action: onNewNote, keywords: 'nova nota escrever capturar' },
    { id: 'toggle-ai', label: 'Abrir assistente Atlas', hint: 'A', icon: PanelRightOpen, action: onToggleAi, keywords: 'ia inteligência assistente painel' },
    ...navItems.map((item) => ({
      id: `go-${item.id}`,
      label: `Ir para ${item.label}`,
      hint: item.shortcut || '',
      icon: item.icon,
      action: () => onNavigate(item.id),
      keywords: `${item.label} navegar abrir ${item.id}`,
    })),
  ], [onNavigate, onNewNote, onToggleAi]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('pt-BR');
    if (!needle) return commands;
    return commands.filter((item) => `${item.label} ${item.keywords}`.toLocaleLowerCase('pt-BR').includes(needle));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    window.setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  useEffect(() => setSelected((current) => Math.min(current, Math.max(filtered.length - 1, 0))), [filtered.length]);

  const run = (command: PaletteCommand) => {
    command.action();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((current) => (current + 1) % Math.max(filtered.length, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) => (current - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1));
    } else if (event.key === 'Enter' && filtered[selected]) {
      event.preventDefault();
      run(filtered[selected]);
    } else if (event.key === 'Escape') {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos">
        <label className="palette-search">
          <Search size={19} />
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Busque uma página ou ação…" aria-label="Buscar comando" />
          <kbd>ESC</kbd>
        </label>
        <div className="palette-heading"><span>Sugestões</span><small>{filtered.length} comandos</small></div>
        <div className="palette-results" role="listbox">
          {filtered.length ? filtered.map((item, index) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" role="option" aria-selected={index === selected} className={index === selected ? 'is-selected' : ''} onMouseEnter={() => setSelected(index)} onClick={() => run(item)}>
                <span className="palette-result__icon"><Icon size={17} /></span>
                <span>{item.label}</span>
                {item.id === `go-${activeView}` && <small className="palette-current">Atual</small>}
                {item.hint && <kbd>{item.hint}</kbd>}
              </button>
            );
          }) : (
            <div className="palette-empty"><Bot size={22} /><strong>Nenhum comando encontrado</strong><span>Tente buscar por uma página ou ação diferente.</span></div>
          )}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>↵</kbd> abrir</span><span className="palette-brand"><Command size={13} /> Atlas</span></footer>
      </section>
    </div>
  );
}

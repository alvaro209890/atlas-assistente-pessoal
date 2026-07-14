import {
  Archive,
  Bot,
  Brain,
  CalendarDays,
  FolderKanban,
  GitFork,
  Inbox,
  Lightbulb,
  Settings,
  SquareKanban,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { NavId } from '../types';

export interface NavItem {
  id: NavId;
  label: string;
  description: string;
  icon: LucideIcon;
  section: 'main' | 'organize' | 'system';
  shortcut?: string;
}

export const navItems: NavItem[] = [
  { id: 'today', label: 'Hoje', description: 'Prioridades do dia', icon: CalendarDays, section: 'main', shortcut: 'G H' },
  { id: 'inbox', label: 'Inbox', description: 'Itens para revisar', icon: Inbox, section: 'main', shortcut: 'G I' },
  { id: 'brain', label: 'Cérebro', description: 'Notas e contexto', icon: Brain, section: 'main', shortcut: 'G C' },
  { id: 'graph', label: 'Grafo', description: 'Conexões do conhecimento', icon: GitFork, section: 'main', shortcut: 'G G' },
  { id: 'projects', label: 'Projetos', description: 'Trabalho em movimento', icon: FolderKanban, section: 'organize' },
  { id: 'people', label: 'Pessoas', description: 'Histórico e relações', icon: Users, section: 'organize' },
  { id: 'trello', label: 'Trello', description: 'Quadro sincronizado', icon: SquareKanban, section: 'organize' },
  { id: 'learnings', label: 'Aprendizados', description: 'Regras que o Atlas aprendeu', icon: Lightbulb, section: 'system' },
  { id: 'automations', label: 'Automações', description: 'Rotinas e lembretes', icon: Bot, section: 'system' },
  { id: 'settings', label: 'Configurações', description: 'Conta e integrações', icon: Settings, section: 'system' },
];

export const mobileNavIds: NavId[] = ['today', 'inbox', 'brain', 'graph'];

export const viewMeta: Record<NavId, { title: string; eyebrow: string; description: string; icon: LucideIcon }> = {
  today: { title: 'Hoje', eyebrow: 'Seu dia', description: 'Prioridades e contexto para avançar com clareza.', icon: CalendarDays },
  inbox: { title: 'Inbox', eyebrow: 'Entrada', description: 'Tudo que chegou e ainda precisa de um lugar.', icon: Inbox },
  brain: { title: 'Cérebro', eyebrow: 'Biblioteca', description: 'Notas conectadas, decisões e conhecimento vivo.', icon: Brain },
  graph: { title: 'Grafo', eyebrow: 'Conexões', description: 'Veja como pessoas, ideias e projetos se relacionam.', icon: GitFork },
  projects: { title: 'Projetos', eyebrow: 'Em movimento', description: 'Contexto, pessoas e progresso em uma visão.', icon: FolderKanban },
  people: { title: 'Pessoas', eyebrow: 'Relacionamentos', description: 'O histórico que ajuda cada conversa a continuar.', icon: Users },
  trello: { title: 'Trello', eyebrow: 'Tarefas', description: 'Seus cartões com o contexto que faltava.', icon: SquareKanban },
  learnings: { title: 'Aprendizados', eyebrow: 'Memória adaptativa', description: 'Revise o que Atlas aprendeu sobre sua forma de trabalhar.', icon: Lightbulb },
  automations: { title: 'Automações', eyebrow: 'Rotinas', description: 'Regras silenciosas que mantêm tudo organizado.', icon: Bot },
  settings: { title: 'Configurações', eyebrow: 'Preferências', description: 'Conta, integrações, privacidade e notificações.', icon: Settings },
};

export const archiveCommand = { label: 'Arquivar item selecionado', icon: Archive };

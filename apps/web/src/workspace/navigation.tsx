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
  icon: LucideIcon;
  section: 'main' | 'organize' | 'system';
  shortcut?: string;
}

export const navItems: NavItem[] = [
  { id: 'today', label: 'Hoje', icon: CalendarDays, section: 'main', shortcut: 'G H' },
  { id: 'inbox', label: 'Inbox', icon: Inbox, section: 'main', shortcut: 'G I' },
  { id: 'brain', label: 'Cérebro', icon: Brain, section: 'main', shortcut: 'G C' },
  { id: 'graph', label: 'Grafo', icon: GitFork, section: 'main', shortcut: 'G G' },
  { id: 'projects', label: 'Projetos', icon: FolderKanban, section: 'organize' },
  { id: 'people', label: 'Pessoas', icon: Users, section: 'organize' },
  { id: 'trello', label: 'Trello', icon: SquareKanban, section: 'organize' },
  { id: 'learnings', label: 'Aprendizados', icon: Lightbulb, section: 'system' },
  { id: 'automations', label: 'Automações', icon: Bot, section: 'system' },
  { id: 'settings', label: 'Configurações', icon: Settings, section: 'system' },
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

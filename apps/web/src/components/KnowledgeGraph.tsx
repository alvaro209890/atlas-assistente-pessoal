import { useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import { Brain, Focus, Search, X } from 'lucide-react';
import type { GraphEdge, GraphNode } from '../types';
import { EmptyState } from './ui';

interface KnowledgeGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onOpenNode?(id: string): void;
}

const colors: Record<GraphNode['kind'], string> = {
  note: '#cbb9ff',
  project: '#6fcfbd',
  person: '#e7ad6f',
  topic: '#a98bf7',
};

export function createGraphModel(nodes: GraphNode[], edges: GraphEdge[], query = '') {
  const graph = new Graph({ type: 'undirected', multi: true });
  const needle = query.trim().toLocaleLowerCase('pt-BR');

  nodes.forEach((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2;
    const orbit = node.id === 'atlas' ? 0 : 1 + (index % 3) * 0.24;
    const matches = !needle || node.label.toLocaleLowerCase('pt-BR').includes(needle);
    graph.addNode(node.id, {
      label: node.label,
      x: node.id === 'atlas' ? 0 : Math.cos(angle) * orbit,
      y: node.id === 'atlas' ? 0 : Math.sin(angle) * orbit,
      size: (node.size || 10) * (matches ? 1 : 0.66),
      color: matches ? colors[node.kind] : '#403a49',
      forceLabel: matches && Boolean(needle),
      zIndex: matches ? 2 : 1,
    });
  });
  edges.forEach((edge, index) => graph.addEdgeWithKey(`edge-${index}`, edge.source, edge.target, { color: '#393341', size: 1.2 }));
  return graph;
}

export function KnowledgeGraph({ nodes, edges, onOpenNode }: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<'all' | GraphNode['kind']>('all');
  const [source, setSource] = useState<'all' | NonNullable<GraphNode['source']>>('all');
  const [period, setPeriod] = useState<'all' | '7' | '30' | '90'>('all');
  const [tag, setTag] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const availableTags = useMemo(
    () => [...new Set(nodes.flatMap((node) => node.tags ?? []))].sort((left, right) => left.localeCompare(right, 'pt-BR')),
    [nodes],
  );
  const visibleNodes = useMemo(() => {
    const minimumTime = period === 'all' ? null : Date.now() - Number(period) * 86_400_000;
    return nodes.filter((node) => {
      if (kind !== 'all' && node.kind !== kind) return false;
      if (source !== 'all' && (node.source ?? 'manual') !== source) return false;
      if (tag !== 'all' && !(node.tags ?? []).includes(tag)) return false;
      if (minimumTime !== null && node.updatedAt) {
        const updatedAt = Date.parse(node.updatedAt);
        if (Number.isFinite(updatedAt) && updatedAt < minimumTime) return false;
      }
      return true;
    });
  }, [kind, nodes, period, source, tag]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)), [edges, visibleIds]);

  useEffect(() => {
    if (!containerRef.current || !visibleNodes.length) return;
    const graph = createGraphModel(visibleNodes, visibleEdges, query);

    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      labelColor: { color: '#d9d2e3' },
      labelFont: 'Inter, ui-sans-serif, system-ui',
      labelSize: 12,
      defaultEdgeColor: '#393341',
      defaultNodeColor: '#a98bf7',
      zIndex: true,
      minCameraRatio: 0.25,
      maxCameraRatio: 3,
    });
    renderer.on('clickNode', ({ node }) => setSelected(nodes.find((item) => item.id === node) || null));
    renderer.on('doubleClickNode', ({ node }) => onOpenNode?.(node));
    return () => renderer.kill();
  }, [nodes, onOpenNode, query, visibleEdges, visibleNodes]);

  if (!nodes.length) return <EmptyState icon={<Brain size={22} />} title="Seu grafo começa com uma conexão" description="Crie notas e use duplo colchete para relacionar pessoas, ideias e projetos." />;

  return (
    <section className="graph-card">
      <header className="graph-toolbar">
        <label className="search-field graph-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Encontrar no grafo" /></label>
        <div className="graph-filters" role="group" aria-label="Filtrar conexões">
          {([['all', 'Tudo'], ['note', 'Notas'], ['project', 'Projetos'], ['person', 'Pessoas'], ['topic', 'Temas']] as const).map(([value, label]) => <button type="button" key={value} className={kind === value ? 'is-active' : ''} onClick={() => setKind(value)}>{label}</button>)}
        </div>
        <div className="graph-filter-selects">
          <select value={source} onChange={(event) => setSource(event.target.value as typeof source)} aria-label="Filtrar grafo por fonte">
            <option value="all">Todas as fontes</option><option value="manual">Manual</option><option value="whatsapp">WhatsApp</option><option value="trello">Trello</option><option value="ai">IA</option>
          </select>
          <select value={period} onChange={(event) => setPeriod(event.target.value as typeof period)} aria-label="Filtrar grafo por período">
            <option value="all">Todo período</option><option value="7">7 dias</option><option value="30">30 dias</option><option value="90">90 dias</option>
          </select>
          <select value={tag} onChange={(event) => setTag(event.target.value)} aria-label="Filtrar grafo por tag">
            <option value="all">Todas as tags</option>{availableTags.map((item) => <option key={item} value={item}>#{item}</option>)}
          </select>
        </div>
        <button className="icon-button" type="button" aria-label="Centralizar grafo"><Focus size={17} /></button>
      </header>
      <div className="graph-canvas" ref={containerRef} aria-label={`Grafo com ${visibleNodes.length} itens e ${visibleEdges.length} conexões`} />
      <div className="graph-legend"><span><i style={{ background: colors.note }} /> Nota</span><span><i style={{ background: colors.project }} /> Projeto</span><span><i style={{ background: colors.person }} /> Pessoa</span><span><i style={{ background: colors.topic }} /> Tema</span></div>
      {selected && (
        <aside className="graph-selection">
          <button type="button" onClick={() => setSelected(null)} aria-label="Fechar detalhe"><X size={15} /></button>
          <span className="eyebrow">{selected.kind === 'note' ? 'Nota' : selected.kind === 'project' ? 'Projeto' : selected.kind === 'person' ? 'Pessoa' : 'Tema'}</span>
          <strong>{selected.label}</strong>
          <small>{edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).length} conexões diretas</small>
        </aside>
      )}
    </section>
  );
}

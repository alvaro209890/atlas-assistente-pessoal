import { describe, expect, it } from 'vitest';
import { createGraphModel } from './KnowledgeGraph';

describe('createGraphModel', () => {
  it('keeps multiple valid relations between the same pair of nodes', () => {
    const graph = createGraphModel(
      [
        { id: 'a', label: 'Projeto', kind: 'project' },
        { id: 'b', label: 'Decisão', kind: 'note' },
      ],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
      ],
    );

    expect(graph.multi).toBe(true);
    expect(graph.size).toBe(2);
  });
});

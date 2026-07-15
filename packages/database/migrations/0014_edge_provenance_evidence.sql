-- O worker grava arestas factuais com provenance='evidence' (nota↔entidade que
-- compartilham a mesma mensagem de origem), mas o CHECK original só aceitava
-- manual/rule/ai/import. Isso derrubava a transação inteira de upsert de
-- memórias e deixava o grafo vazio. Amplia o domínio permitido.
ALTER TABLE brain_edges DROP CONSTRAINT IF EXISTS brain_edges_provenance_check;
ALTER TABLE brain_edges ADD CONSTRAINT brain_edges_provenance_check
  CHECK (provenance IN ('manual', 'rule', 'ai', 'import', 'evidence'));

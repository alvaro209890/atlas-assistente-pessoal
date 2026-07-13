import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import { AppError, parseInput } from '../errors.js';
import type { EventHub } from '../events.js';
import type { AppDatabase } from '../types.js';
import { syncWikilinkEdgesInTransaction } from '../wikilinks.js';

interface BrainDeps {
  database: AppDatabase;
  events: EventHub;
}

export interface BrainNodeRow {
  id: string;
  user_id: string;
  type: string;
  domain: string;
  title: string;
  manual_content: string;
  generated_content: string;
  status: string;
  aliases: string[];
  tags: string[];
  source_type: string | null;
  source_id: string | null;
  source_url: string | null;
  happened_at: Date | string | null;
  metadata: Record<string, unknown>;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  score?: number;
}

const nodeSelect = `id, user_id, type, domain, title, manual_content, generated_content,
  status, aliases, tags, source_type, source_id, source_url, happened_at, metadata,
  version, created_at, updated_at`;

export function nodeJson(row: BrainNodeRow) {
  return {
    id: row.id,
    type: row.type,
    domain: row.domain,
    title: row.title,
    manualContent: row.manual_content,
    generatedContent: row.generated_content,
    content: row.manual_content || row.generated_content,
    status: row.status,
    aliases: row.aliases,
    tags: row.tags,
    source: {
      type: row.source_type,
      id: row.source_id,
      url: row.source_url,
    },
    happenedAt: row.happened_at ? new Date(row.happened_at).toISOString() : null,
    metadata: row.metadata,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.score === undefined ? {} : { score: Number(row.score) }),
  };
}

const uuidParams = z.object({ id: z.string().uuid() });
const createNodeSchema = z.object({
  type: z.string().trim().min(1).max(50).default('note'),
  domain: z.string().trim().min(1).max(80).default('general'),
  title: z.string().trim().min(1).max(300),
  manualContent: z.string().max(500_000).default(''),
  generatedContent: z.string().max(500_000).default(''),
  status: z.string().trim().min(1).max(50).default('active'),
  aliases: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  tags: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  sourceType: z.string().trim().min(1).max(60).nullable().optional(),
  sourceId: z.string().trim().min(1).max(500).nullable().optional(),
  sourceUrl: z.string().url().max(2_000).nullable().optional(),
  happenedAt: z.coerce.date().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const updateNodeSchema = createNodeSchema.partial().refine((value) => Object.keys(value).length > 0, 'Envie ao menos um campo.');

export async function registerBrainRoutes(app: FastifyInstance, deps: BrainDeps): Promise<void> {
  const { database, events } = deps;

  app.get('/brain/nodes', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({
      type: z.string().max(50).optional(),
      domain: z.string().max(80).optional(),
      status: z.string().max(50).optional(),
      tag: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
    }), request.query);
    const result = await database.query<BrainNodeRow>(
      `SELECT ${nodeSelect}, count(*) OVER()::int AS total
       FROM brain_nodes
       WHERE user_id = $1
         AND ($2::text IS NULL OR type = $2)
         AND ($3::text IS NULL OR domain = $3)
         AND ($4::text IS NULL OR status = $4)
         AND ($5::text IS NULL OR $5 = ANY(tags))
       ORDER BY updated_at DESC
       LIMIT $6 OFFSET $7`,
      [user.id, query.type ?? null, query.domain ?? null, query.status ?? null, query.tag ?? null, query.limit, query.offset],
    );
    const total = Number((result.rows[0] as BrainNodeRow & { total?: number } | undefined)?.total ?? 0);
    return { items: result.rows.map(nodeJson), total, limit: query.limit, offset: query.offset };
  });

  app.get('/brain/search', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({
      q: z.string().trim().min(1).max(500),
      type: z.string().max(50).optional(),
      domain: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }), request.query);
    const result = await database.query<BrainNodeRow>(
      `WITH input AS (SELECT websearch_to_tsquery('portuguese', $2) AS tsq)
       SELECT ${nodeSelect},
         (ts_rank_cd(search_vector, input.tsq) * 0.8 + similarity(title, $2) * 0.2)::float AS score
       FROM brain_nodes, input
       WHERE user_id = $1
         AND status <> 'deleted'
         AND ($3::text IS NULL OR type = $3)
         AND ($4::text IS NULL OR domain = $4)
         AND (search_vector @@ input.tsq OR similarity(title, $2) > 0.18 OR title ILIKE '%' || $2 || '%')
       ORDER BY score DESC, updated_at DESC
       LIMIT $5`,
      [user.id, query.q, query.type ?? null, query.domain ?? null, query.limit],
    );
    return { query: query.q, items: result.rows.map(nodeJson) };
  });

  app.post('/brain/nodes', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(createNodeSchema, request.body);
    const result = await database.userTransaction(user.id, async (client) => {
      const stub = input.type === 'stub' ? { rows: [] } : await client.query<{ id: string }>(
        `SELECT id FROM brain_nodes WHERE user_id=$1 AND type='stub' AND status<>'deleted'
           AND (lower(btrim(title))=lower(btrim($2)) OR lower(btrim($2))=ANY(
             SELECT lower(btrim(alias)) FROM unnest(aliases) AS a(alias)))
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`, [user.id, input.title],
      );
      const created = stub.rows[0]
        ? await client.query<BrainNodeRow>(
          `UPDATE brain_nodes SET type=$3,domain=$4,title=$5,manual_content=$6,generated_content=$7,
             status=$8,aliases=$9,tags=$10,source_type=$11,source_id=$12,source_url=$13,
             happened_at=$14,metadata=$15
           WHERE id=$1 AND user_id=$2 RETURNING ${nodeSelect}`,
          [stub.rows[0].id, user.id, input.type, input.domain, input.title, input.manualContent,
            input.generatedContent, input.status, input.aliases, input.tags, input.sourceType ?? null,
            input.sourceId ?? null, input.sourceUrl ?? null, input.happenedAt ?? null, input.metadata],
        )
        : await client.query<BrainNodeRow>(
          `INSERT INTO brain_nodes (
             user_id, type, domain, title, manual_content, generated_content, status,
             aliases, tags, source_type, source_id, source_url, happened_at, metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING ${nodeSelect}`,
          [user.id, input.type, input.domain, input.title, input.manualContent, input.generatedContent,
            input.status, input.aliases, input.tags, input.sourceType ?? null, input.sourceId ?? null,
            input.sourceUrl ?? null, input.happenedAt ?? null, input.metadata],
        );
      await syncWikilinkEdgesInTransaction(client, {
        userId: user.id,
        fromNodeId: created.rows[0]!.id,
        content: input.manualContent,
      });
      return created;
    });
    const node = nodeJson(result.rows[0]!);
    await events.publish(user.id, 'brain.node.created', { nodeId: node.id });
    return reply.status(201).send(node);
  });

  app.get('/brain/nodes/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const result = await database.query<BrainNodeRow>(
      `SELECT ${nodeSelect} FROM brain_nodes WHERE id = $1 AND user_id = $2`,
      [id, user.id],
    );
    if (!result.rows[0]) throw new AppError(404, 'NODE_NOT_FOUND', 'Item não encontrado.');
    return nodeJson(result.rows[0]);
  });

  app.patch('/brain/nodes/:id', async (request) => updateNode(request.params, request.body, request));

  async function updateNode(params: unknown, body: unknown, request: Parameters<typeof currentUser>[0]) {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, params);
    const input = parseInput(updateNodeSchema, body);
    const values = [
      id, user.id, input.type ?? null, input.domain ?? null, input.title ?? null,
      input.manualContent ?? null, input.generatedContent ?? null, input.status ?? null,
      input.aliases ?? null, input.tags ?? null,
      Object.hasOwn(input, 'sourceType') ? input.sourceType ?? null : null,
      Object.hasOwn(input, 'sourceId') ? input.sourceId ?? null : null,
      Object.hasOwn(input, 'sourceUrl') ? input.sourceUrl ?? null : null,
      Object.hasOwn(input, 'happenedAt') ? input.happenedAt ?? null : null,
      input.metadata ?? null,
      Object.hasOwn(input, 'sourceType'), Object.hasOwn(input, 'sourceId'), Object.hasOwn(input, 'sourceUrl'), Object.hasOwn(input, 'happenedAt'),
    ];
    const result = await database.userTransaction(user.id, async (client) => {
      const updated = await client.query<BrainNodeRow>(
        `UPDATE brain_nodes SET
           type = COALESCE($3, type), domain = COALESCE($4, domain), title = COALESCE($5, title),
           manual_content = COALESCE($6, manual_content), generated_content = COALESCE($7, generated_content),
           status = COALESCE($8, status), aliases = COALESCE($9, aliases), tags = COALESCE($10, tags),
           source_type = CASE WHEN $16 THEN $11 ELSE source_type END,
           source_id = CASE WHEN $17 THEN $12 ELSE source_id END,
           source_url = CASE WHEN $18 THEN $13 ELSE source_url END,
           happened_at = CASE WHEN $19 THEN $14 ELSE happened_at END,
           metadata = COALESCE($15, metadata)
         WHERE id = $1 AND user_id = $2
         RETURNING ${nodeSelect}`,
        values,
      );
      if (updated.rows[0]) {
        await syncWikilinkEdgesInTransaction(client, {
          userId: user.id,
          fromNodeId: id,
          content: updated.rows[0].manual_content,
        });
      }
      return updated;
    });
    if (!result.rows[0]) throw new AppError(404, 'NODE_NOT_FOUND', 'Item não encontrado.');
    await events.publish(user.id, 'brain.node.updated', { nodeId: id, version: result.rows[0].version });
    return nodeJson(result.rows[0]);
  }

  app.delete('/brain/nodes/:id', async (request, reply) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const result = await database.query('DELETE FROM brain_nodes WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!result.rowCount) throw new AppError(404, 'NODE_NOT_FOUND', 'Item não encontrado.');
    await events.publish(user.id, 'brain.node.deleted', { nodeId: id });
    return reply.status(204).send();
  });

  app.get('/brain/nodes/:id/revisions', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const result = await database.query(
      `SELECT id, revision, title, manual_content AS "manualContent",
              generated_content AS "generatedContent", status, aliases, tags, metadata, created_at AS "createdAt"
       FROM brain_node_revisions
       WHERE node_id = $1 AND user_id = $2
       ORDER BY revision DESC`,
      [id, user.id],
    );
    return { items: result.rows };
  });

  app.post('/brain/nodes/:id/revisions/:revision/restore', async (request) => {
    const user = currentUser(request);
    const params = parseInput(z.object({ id: z.string().uuid(), revision: z.coerce.number().int().positive() }), request.params);
    const result = await database.userTransaction(user.id, async (client) => {
      const revision = await client.query<{
        title: string; manual_content: string; generated_content: string; status: string;
        aliases: string[]; tags: string[]; metadata: Record<string, unknown>;
      }>(
        `SELECT title, manual_content, generated_content, status, aliases, tags, metadata
         FROM brain_node_revisions WHERE node_id = $1 AND user_id = $2 AND revision = $3`,
        [params.id, user.id, params.revision],
      );
      if (!revision.rows[0]) throw new AppError(404, 'REVISION_NOT_FOUND', 'Versão não encontrada.');
      const old = revision.rows[0];
      const restored = await client.query<BrainNodeRow>(
        `UPDATE brain_nodes SET title=$3, manual_content=$4, generated_content=$5,
           status=$6, aliases=$7, tags=$8, metadata=$9
         WHERE id=$1 AND user_id=$2 RETURNING ${nodeSelect}`,
        [params.id, user.id, old.title, old.manual_content, old.generated_content, old.status, old.aliases, old.tags, old.metadata],
      );
      if (restored.rows[0]) {
        await syncWikilinkEdgesInTransaction(client, {
          userId: user.id,
          fromNodeId: params.id,
          content: restored.rows[0].manual_content,
        });
      }
      return restored;
    });
    await events.publish(user.id, 'brain.node.restored', { nodeId: params.id, revision: params.revision });
    return nodeJson(result.rows[0]!);
  });

  app.post('/brain/edges', async (request, reply) => {
    const user = currentUser(request);
    const input = parseInput(z.object({
      fromNodeId: z.string().uuid(), toNodeId: z.string().uuid(),
      relationType: z.string().trim().min(1).max(80),
      weight: z.number().min(0).max(1).default(1),
      provenance: z.enum(['manual', 'rule', 'ai', 'import']).default('manual'),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }), request.body);
    const result = await database.query(
      `INSERT INTO brain_edges (user_id, from_node_id, to_node_id, relation_type, weight, provenance, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, from_node_id AS "fromNodeId", to_node_id AS "toNodeId",
         relation_type AS "relationType", weight, provenance, metadata, created_at AS "createdAt"`,
      [user.id, input.fromNodeId, input.toNodeId, input.relationType, input.weight, input.provenance, input.metadata],
    );
    await events.publish(user.id, 'brain.edge.created', { edgeId: result.rows[0]?.id });
    return reply.status(201).send(result.rows[0]);
  });

  app.delete('/brain/edges/:id', async (request, reply) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const result = await database.query('DELETE FROM brain_edges WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!result.rowCount) throw new AppError(404, 'EDGE_NOT_FOUND', 'Conexão não encontrada.');
    await events.publish(user.id, 'brain.edge.deleted', { edgeId: id });
    return reply.status(204).send();
  });

  app.get('/brain/graph', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({ limit: z.coerce.number().int().min(1).max(500).default(150) }), request.query);
    const nodes = await database.query<BrainNodeRow>(
      `SELECT ${nodeSelect} FROM brain_nodes WHERE user_id=$1 AND status <> 'deleted'
       ORDER BY updated_at DESC LIMIT $2`, [user.id, query.limit],
    );
    const ids = nodes.rows.map((node) => node.id);
    const edges = ids.length ? await database.query(
      `SELECT id, from_node_id AS "fromNodeId", to_node_id AS "toNodeId",
              relation_type AS "relationType", weight, provenance
       FROM brain_edges
       WHERE user_id=$1 AND from_node_id = ANY($2::uuid[]) AND to_node_id = ANY($2::uuid[])`,
      [user.id, ids],
    ) : { rows: [] };
    return { nodes: nodes.rows.map(nodeJson), edges: edges.rows };
  });

  app.get('/brain/nodes/:id/backlinks', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const result = await database.query<BrainNodeRow & { relation_type: string; edge_id: string }>(
      `SELECT n.*, e.relation_type, e.id AS edge_id
       FROM brain_edges e JOIN brain_nodes n ON n.id=e.from_node_id AND n.user_id=e.user_id
       WHERE e.user_id=$1 AND e.to_node_id=$2 ORDER BY n.updated_at DESC`,
      [user.id, id],
    );
    return { items: result.rows.map((row) => ({ node: nodeJson(row), relationType: row.relation_type, edgeId: row.edge_id })) };
  });
}

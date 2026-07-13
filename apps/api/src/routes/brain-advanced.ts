import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth.js';
import { AppError, parseInput } from '../errors.js';
import type { EventHub } from '../events.js';
import type { AppDatabase } from '../types.js';
import { nodeJson, type BrainNodeRow } from './brain.js';

interface BrainAdvancedDeps {
  database: AppDatabase;
  events: EventHub;
}

const uuidParams = z.object({ id: z.string().uuid() });
const nodeSelect = `id,user_id,type,domain,title,manual_content,generated_content,status,aliases,tags,
  source_type,source_id,source_url,happened_at,metadata,version,created_at,updated_at`;

function combineContent(primary: string, secondary: string, secondaryTitle: string): string {
  if (!secondary.trim()) return primary;
  if (!primary.trim()) return secondary;
  if (primary.includes(secondary)) return primary;
  return `${primary.trim()}\n\n---\n\n## Conteúdo mesclado de ${secondaryTitle}\n\n${secondary.trim()}`;
}

export async function registerBrainAdvancedRoutes(app: FastifyInstance, deps: BrainAdvancedDeps): Promise<void> {
  const { database, events } = deps;

  app.get('/brain/nodes/:id/sources', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const owned = await database.query('SELECT 1 FROM brain_nodes WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!owned.rows[0]) throw new AppError(404, 'NODE_NOT_FOUND', 'Item não encontrado.');
    const result = await database.query(
      `SELECT id,source_kind AS "sourceKind",source_id AS "sourceId",source_url AS "sourceUrl",
              title,excerpt,captured_at AS "capturedAt",valid_from AS "validFrom",valid_until AS "validUntil",
              confidence,importance,supersedes_source_id AS "supersedesSourceId",
              contradicts_source_id AS "contradictsSourceId",metadata,created_at AS "createdAt"
       FROM brain_node_sources WHERE node_id=$1 AND user_id=$2 ORDER BY captured_at DESC`, [id, user.id],
    );
    return { items: result.rows };
  });

  app.post('/brain/nodes/:id/sources', async (request, reply) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({
      sourceKind: z.enum(['brain_node', 'whatsapp_message', 'trello_card', 'task', 'commitment', 'url', 'manual']),
      sourceId: z.string().trim().min(1).max(500).optional(),
      sourceUrl: z.string().url().max(2_000).optional(), title: z.string().trim().max(300).optional(),
      excerpt: z.string().max(20_000).default(''), capturedAt: z.coerce.date().default(() => new Date()),
      validFrom: z.coerce.date().nullable().optional(), validUntil: z.coerce.date().nullable().optional(),
      confidence: z.number().min(0).max(1).nullable().optional(), importance: z.number().int().min(0).max(5).default(3),
      supersedesSourceId: z.string().uuid().nullable().optional(), contradictsSourceId: z.string().uuid().nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }).refine((value) => !value.validFrom || !value.validUntil || value.validUntil >= value.validFrom,
      'A validade final deve ser posterior à inicial.'), request.body);
    const relatedIds = [input.supersedesSourceId, input.contradictsSourceId].filter((value): value is string => Boolean(value));
    if (relatedIds.length) {
      const related = await database.query<{ id: string }>(
        'SELECT id FROM brain_node_sources WHERE user_id=$1 AND id=ANY($2::uuid[])', [user.id, relatedIds],
      );
      if (related.rows.length !== new Set(relatedIds).size) {
        throw new AppError(422, 'SOURCE_RELATION_INVALID', 'Uma fonte relacionada não pertence a esta conta.');
      }
    }
    const result = await database.query(
      `INSERT INTO brain_node_sources
        (user_id,node_id,source_kind,source_id,source_url,title,excerpt,captured_at,valid_from,valid_until,
         confidence,importance,supersedes_source_id,contradicts_source_id,metadata)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
       WHERE EXISTS (SELECT 1 FROM brain_nodes WHERE id=$2 AND user_id=$1)
       RETURNING id,source_kind AS "sourceKind",source_id AS "sourceId",source_url AS "sourceUrl",
         title,excerpt,captured_at AS "capturedAt",valid_from AS "validFrom",valid_until AS "validUntil",
         confidence,importance,supersedes_source_id AS "supersedesSourceId",
         contradicts_source_id AS "contradictsSourceId",metadata,created_at AS "createdAt"`,
      [user.id, id, input.sourceKind, input.sourceId ?? null, input.sourceUrl ?? null,
        input.title ?? null, input.excerpt, input.capturedAt, input.validFrom ?? null, input.validUntil ?? null,
        input.confidence ?? null, input.importance, input.supersedesSourceId ?? null,
        input.contradictsSourceId ?? null, input.metadata],
    );
    if (!result.rows[0]) throw new AppError(404, 'NODE_NOT_FOUND', 'Item não encontrado.');
    await events.publish(user.id, 'brain.source.created', { nodeId: id, sourceId: result.rows[0].id });
    return reply.status(201).send(result.rows[0]);
  });

  app.delete('/brain/nodes/:nodeId/sources/:sourceId', async (request, reply) => {
    const user = currentUser(request);
    const params = parseInput(z.object({ nodeId: z.string().uuid(), sourceId: z.string().uuid() }), request.params);
    const result = await database.query(
      'DELETE FROM brain_node_sources WHERE id=$1 AND node_id=$2 AND user_id=$3',
      [params.sourceId, params.nodeId, user.id],
    );
    if (!result.rowCount) throw new AppError(404, 'SOURCE_NOT_FOUND', 'Fonte não encontrada.');
    await events.publish(user.id, 'brain.source.deleted', { nodeId: params.nodeId, sourceId: params.sourceId });
    return reply.status(204).send();
  });

  app.get('/brain/nodes/:id/neighborhood', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const query = parseInput(z.object({ depth: z.coerce.number().int().min(1).max(3).default(1) }), request.query);
    const owned = await database.query('SELECT 1 FROM brain_nodes WHERE id=$1 AND user_id=$2 AND status<>\'deleted\'', [id, user.id]);
    if (!owned.rows[0]) throw new AppError(404, 'NODE_NOT_FOUND', 'Item não encontrado.');
    const found = await database.query<{ node_id: string; depth: number }>(
      `WITH RECURSIVE walk(node_id,depth,path) AS (
         SELECT $2::uuid,0,ARRAY[$2::uuid]
         UNION ALL
         SELECT CASE WHEN e.from_node_id=w.node_id THEN e.to_node_id ELSE e.from_node_id END,
                w.depth+1,w.path || CASE WHEN e.from_node_id=w.node_id THEN e.to_node_id ELSE e.from_node_id END
         FROM walk w JOIN brain_edges e ON e.user_id=$1
           AND (e.from_node_id=w.node_id OR e.to_node_id=w.node_id)
         WHERE w.depth<$3 AND NOT (CASE WHEN e.from_node_id=w.node_id THEN e.to_node_id ELSE e.from_node_id END = ANY(w.path))
       ) SELECT node_id,min(depth)::int AS depth FROM walk GROUP BY node_id`,
      [user.id, id, query.depth],
    );
    const ids = found.rows.map((row) => row.node_id);
    const nodes = await database.query<BrainNodeRow>(
      `SELECT ${nodeSelect} FROM brain_nodes WHERE user_id=$1 AND id=ANY($2::uuid[]) AND status<>'deleted'`,
      [user.id, ids],
    );
    const edges = await database.query(
      `SELECT id,from_node_id AS "fromNodeId",to_node_id AS "toNodeId",
              relation_type AS "relationType",weight,provenance,metadata
       FROM brain_edges WHERE user_id=$1 AND from_node_id=ANY($2::uuid[]) AND to_node_id=ANY($2::uuid[])`,
      [user.id, ids],
    );
    const depths = new Map(found.rows.map((row) => [row.node_id, row.depth]));
    return { centerNodeId: id, depth: query.depth,
      nodes: nodes.rows.map((row) => ({ ...nodeJson(row), depth: depths.get(row.id) ?? 0 })), edges: edges.rows };
  });

  app.post('/brain/nodes/:id/merge', async (request) => {
    const user = currentUser(request);
    const { id: sourceNodeId } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({ targetNodeId: z.string().uuid() }), request.body);
    if (sourceNodeId === input.targetNodeId) throw new AppError(400, 'MERGE_SELF', 'Um item não pode ser mesclado nele mesmo.');
    const merged = await database.userTransaction(user.id, async (client) => {
      const nodes = await client.query<BrainNodeRow>(
        `SELECT ${nodeSelect} FROM brain_nodes WHERE user_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE`,
        [user.id, [sourceNodeId, input.targetNodeId]],
      );
      const source = nodes.rows.find((node) => node.id === sourceNodeId);
      const target = nodes.rows.find((node) => node.id === input.targetNodeId);
      if (!source || !target) throw new AppError(404, 'MERGE_NODE_NOT_FOUND', 'Origem ou destino não encontrado.');
      const manualContent = combineContent(target.manual_content, source.manual_content, source.title);
      const generatedContent = combineContent(target.generated_content, source.generated_content, source.title);
      const aliases = [...new Set([...target.aliases, ...source.aliases, source.title])].filter((value) => value !== target.title);
      const tags = [...new Set([...target.tags, ...source.tags])];
      const updated = await client.query<BrainNodeRow>(
        `UPDATE brain_nodes SET manual_content=$3,generated_content=$4,aliases=$5,tags=$6,
           metadata=metadata || $7::jsonb WHERE id=$1 AND user_id=$2 RETURNING ${nodeSelect}`,
        [target.id, user.id, manualContent, generatedContent, aliases, tags,
          { mergedNodeIds: [...new Set([...(Array.isArray(target.metadata.mergedNodeIds) ? target.metadata.mergedNodeIds : []), source.id])] }],
      );
      await client.query(
        `INSERT INTO brain_node_sources
          (user_id,node_id,source_kind,source_id,source_url,title,excerpt,captured_at,metadata)
         SELECT user_id,$3,source_kind,source_id,source_url,title,excerpt,captured_at,metadata
         FROM brain_node_sources WHERE user_id=$1 AND node_id=$2 ON CONFLICT DO NOTHING`,
        [user.id, source.id, target.id],
      );
      await client.query('DELETE FROM brain_node_sources WHERE user_id=$1 AND node_id=$2', [user.id, source.id]);
      await client.query(
        `INSERT INTO brain_node_sources (user_id,node_id,source_kind,source_id,title,excerpt,metadata)
         VALUES ($1,$2,'brain_node',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [user.id, target.id, source.id, source.title,
          (source.manual_content || source.generated_content).slice(0, 20_000), { merged: true }],
      );
      await client.query(
        `INSERT INTO brain_edges (user_id,from_node_id,to_node_id,relation_type,weight,provenance,metadata)
         SELECT user_id,
           CASE WHEN from_node_id=$2 THEN $3 ELSE from_node_id END,
           CASE WHEN to_node_id=$2 THEN $3 ELSE to_node_id END,
           relation_type,weight,provenance,metadata
         FROM brain_edges WHERE user_id=$1 AND (from_node_id=$2 OR to_node_id=$2)
           AND (CASE WHEN from_node_id=$2 THEN $3 ELSE from_node_id END) <>
               (CASE WHEN to_node_id=$2 THEN $3 ELSE to_node_id END)
         ON CONFLICT DO NOTHING`, [user.id, source.id, target.id],
      );
      await client.query('DELETE FROM brain_edges WHERE user_id=$1 AND (from_node_id=$2 OR to_node_id=$2)', [user.id, source.id]);
      await client.query('UPDATE canonical_tasks SET project_node_id=$3 WHERE user_id=$1 AND project_node_id=$2', [user.id, source.id, target.id]);
      await client.query('UPDATE canonical_tasks SET person_node_id=$3 WHERE user_id=$1 AND person_node_id=$2', [user.id, source.id, target.id]);
      await client.query('UPDATE commitments SET person_node_id=$3 WHERE user_id=$1 AND person_node_id=$2', [user.id, source.id, target.id]);
      const targetTask = await client.query('SELECT 1 FROM canonical_tasks WHERE user_id=$1 AND brain_node_id=$2', [user.id, target.id]);
      await client.query(
        `UPDATE canonical_tasks SET brain_node_id=$3 WHERE user_id=$1 AND brain_node_id=$2`,
        [user.id, source.id, targetTask.rows[0] ? null : target.id],
      );
      await client.query(
        `UPDATE brain_nodes SET status='deleted',metadata=metadata || $3::jsonb
         WHERE id=$1 AND user_id=$2`, [source.id, user.id, { mergedIntoNodeId: target.id }],
      );
      return updated.rows[0]!;
    });
    await events.publish(user.id, 'brain.node.merged', { sourceNodeId, targetNodeId: input.targetNodeId });
    return { node: nodeJson(merged), mergedNodeId: sourceNodeId };
  });
}

import type { PoolClient } from '@atlas/database';
import type { AppDatabase } from './types.js';

export const WIKILINK_RELATION_TYPE = 'wikilink';
export const WIKILINK_EDGE_MANAGER = 'native-wikilink-sync';

export interface WikilinkReference {
  /** The complete source token, including the double brackets. */
  raw: string;
  target: string;
  section?: string;
  alias?: string;
  /** Zero-based, inclusive source offset. */
  start: number;
  /** Zero-based, exclusive source offset. */
  end: number;
}

export interface SyncWikilinkEdgesInput {
  userId: string;
  fromNodeId: string;
  content: string;
}

export interface SyncWikilinkEdgesResult {
  sourceNodeId: string;
  linksFound: number;
  uniqueTargets: number;
  resolvedTargets: number;
  unresolvedTargets: string[];
  ignoredSelfTargets: string[];
  linkedNodeIds: string[];
  upsertedEdges: number;
  removedEdges: number;
}

interface SourceNodeRow {
  id: string;
  user_id: string;
  title: string;
  aliases: string[];
}

interface CandidateNodeRow extends SourceNodeRow {
  updated_at?: Date | string;
}

interface EdgeMetadataLink {
  target: string;
  section?: string;
  alias?: string;
}

interface DesiredEdge {
  nodeId: string;
  links: EdgeMetadataLink[];
}

export class WikilinkSourceNotFoundError extends Error {
  readonly code = 'WIKILINK_SOURCE_NOT_FOUND';

  constructor(readonly userId: string, readonly nodeId: string) {
    super(`Brain node ${nodeId} does not exist for user ${userId}.`);
    this.name = 'WikilinkSourceNotFoundError';
  }
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findUnescaped(value: string, token: string, from: number): number {
  let cursor = from;
  while (cursor < value.length) {
    const found = value.indexOf(token, cursor);
    if (found === -1 || !isEscaped(value, found)) return found;
    cursor = found + token.length;
  }
  return -1;
}

/**
 * Extracts wiki-style links from Markdown without treating escaped or
 * malformed tokens as links. Besides the three public forms, the natural
 * combination `[[target#section|alias]]` is supported as well.
 */
export function extractWikilinks(content: string): WikilinkReference[] {
  const links: WikilinkReference[] = [];
  let cursor = 0;

  while (cursor < content.length - 1) {
    const start = findUnescaped(content, '[[', cursor);
    if (start === -1) break;

    const endStart = findUnescaped(content, ']]', start + 2);
    if (endStart === -1) {
      cursor = start + 2;
      continue;
    }

    // A nested opener makes the outer token malformed. Resume from the nested
    // opener so a valid inner wikilink can still be extracted.
    const nestedStart = findUnescaped(content, '[[', start + 2);
    if (nestedStart !== -1 && nestedStart < endStart) {
      cursor = nestedStart;
      continue;
    }

    const end = endStart + 2;
    const body = content.slice(start + 2, endStart);
    cursor = end;

    // Node titles are single-line values. Rejecting line breaks also prevents
    // an unfinished link from consuming an unrelated closing token later on.
    if (!body || /[\r\n]/u.test(body)) continue;

    const pipeIndex = body.indexOf('|');
    const destination = (pipeIndex === -1 ? body : body.slice(0, pipeIndex)).trim();
    const aliasValue = pipeIndex === -1 ? '' : body.slice(pipeIndex + 1).trim();
    const hashIndex = destination.indexOf('#');
    const target = (hashIndex === -1 ? destination : destination.slice(0, hashIndex)).trim();
    const sectionValue = hashIndex === -1 ? '' : destination.slice(hashIndex + 1).trim();

    if (!target || target.includes('[[') || target.includes(']]')) continue;

    links.push({
      raw: content.slice(start, end),
      target,
      ...(sectionValue ? { section: sectionValue } : {}),
      ...(aliasValue ? { alias: aliasValue } : {}),
      start,
      end,
    });
  }

  return links;
}

/** Alias kept for callers that prefer the two-word camel-case spelling. */
export const extractWikiLinks = extractWikilinks;

function normalizeTarget(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function nodeKeys(node: Pick<SourceNodeRow, 'title' | 'aliases'>): string[] {
  return [node.title, ...(node.aliases ?? [])].map(normalizeTarget).filter(Boolean);
}

function candidateRank(candidate: CandidateNodeRow, reference: WikilinkReference): number {
  const target = reference.target.trim().normalize('NFC');
  const normalized = normalizeTarget(target);
  if (candidate.title.trim().normalize('NFC') === target) return 0;
  if (normalizeTarget(candidate.title) === normalized) return 1;
  if ((candidate.aliases ?? []).some((alias) => alias.trim().normalize('NFC') === target)) return 2;
  return 3;
}

function compactLink(reference: WikilinkReference): EdgeMetadataLink {
  return {
    target: reference.target,
    ...(reference.section ? { section: reference.section } : {}),
    ...(reference.alias ? { alias: reference.alias } : {}),
  };
}

/**
 * Performs the complete synchronization in a user-scoped database
 * transaction. Existing manual edges are never deleted or overwritten.
 */
export function syncWikilinkEdges(
  database: Pick<AppDatabase, 'userTransaction'>,
  input: SyncWikilinkEdgesInput,
): Promise<SyncWikilinkEdgesResult> {
  return database.userTransaction(input.userId, (client) => syncWikilinkEdgesInTransaction(client, input));
}

/**
 * Transaction-scoped variant for routes that already mutate the node inside a
 * user transaction and need the content update and edge sync to be atomic.
 */
export async function syncWikilinkEdgesInTransaction(
  client: Pick<PoolClient, 'query'>,
  input: SyncWikilinkEdgesInput,
): Promise<SyncWikilinkEdgesResult> {
  const references = extractWikilinks(input.content);
  const sourceResult = await client.query<SourceNodeRow>(
    `SELECT id, user_id, title, aliases
       FROM brain_nodes
      WHERE id = $1 AND user_id = $2 AND status <> 'deleted'
      FOR UPDATE`,
    [input.fromNodeId, input.userId],
  );
  const source = sourceResult.rows[0];
  if (!source) throw new WikilinkSourceNotFoundError(input.userId, input.fromNodeId);

  const referencesByTarget = new Map<string, WikilinkReference[]>();
  for (const reference of references) {
    const key = normalizeTarget(reference.target);
    const existing = referencesByTarget.get(key) ?? [];
    existing.push(reference);
    referencesByTarget.set(key, existing);
  }

  const selfKeys = new Set(nodeKeys(source));
  const ignoredSelfTargets: string[] = [];
  const targetKeys: string[] = [];
  for (const [key, targetReferences] of referencesByTarget) {
    if (selfKeys.has(key)) ignoredSelfTargets.push(targetReferences[0]!.target);
    else targetKeys.push(key);
  }

  const candidateResult = targetKeys.length === 0
    ? { rows: [] as CandidateNodeRow[] }
    : await client.query<CandidateNodeRow>(
      `SELECT n.id, n.user_id, n.title, n.aliases, n.updated_at
         FROM brain_nodes n
        WHERE n.user_id = $1
          AND n.id <> $2
          AND n.status <> 'deleted'
          AND (
            lower(btrim(n.title)) = ANY($3::text[])
            OR EXISTS (
              SELECT 1 FROM unnest(n.aliases) AS node_alias
               WHERE lower(btrim(node_alias)) = ANY($3::text[])
            )
          )
        ORDER BY n.updated_at DESC, n.id
        FOR KEY SHARE OF n`,
      [input.userId, input.fromNodeId, targetKeys],
    );

  // Keep the ownership check in application code too. The SQL predicate and
  // composite foreign keys are the primary boundary; this guards test doubles
  // and future query refactors from accidentally accepting another user's row.
  const candidates = candidateResult.rows.filter((candidate) => (
    candidate.user_id === input.userId && candidate.id !== input.fromNodeId
  ));
  const desiredByNode = new Map<string, DesiredEdge>();
  const unresolvedTargets: string[] = [];
  let resolvedTargets = 0;

  for (const key of targetKeys) {
    const targetReferences = referencesByTarget.get(key)!;
    const matches = candidates
      .filter((candidate) => nodeKeys(candidate).includes(key))
      .sort((left, right) => candidateRank(left, targetReferences[0]!) - candidateRank(right, targetReferences[0]!));
    let match = matches[0];
    if (!match) {
      const target = targetReferences[0]!.target;
      const stub = await client.query<CandidateNodeRow>(
        `INSERT INTO brain_nodes
           (user_id,type,domain,title,status,source_type,source_id,metadata)
         VALUES ($1,'stub','general',left($2,300),'active','wikilink-stub',
           encode(digest($3,'sha256'),'hex'),$4)
         ON CONFLICT (user_id,source_type,source_id)
           WHERE source_type IS NOT NULL AND source_id IS NOT NULL
         DO UPDATE SET title=EXCLUDED.title,updated_at=now()
         RETURNING id,user_id,title,aliases,updated_at`,
        [input.userId, target, key, { stub: true, createdFromWikilink: true }],
      );
      match = stub.rows[0];
      if (!match) {
        unresolvedTargets.push(target);
        continue;
      }
    }

    resolvedTargets += 1;
    const desired = desiredByNode.get(match.id) ?? { nodeId: match.id, links: [] };
    desired.links.push(...targetReferences.map(compactLink));
    desiredByNode.set(match.id, desired);
  }

  const linkedNodeIds = [...desiredByNode.keys()];
  const deleted = await client.query(
    `DELETE FROM brain_edges
      WHERE user_id = $1
        AND from_node_id = $2
        AND relation_type = $4
        AND provenance = 'rule'
        AND metadata->>'managedBy' = $5
        AND NOT (to_node_id = ANY($3::uuid[]))`,
    [input.userId, input.fromNodeId, linkedNodeIds, WIKILINK_RELATION_TYPE, WIKILINK_EDGE_MANAGER],
  );

  let upsertedEdges = 0;
  for (const desired of desiredByNode.values()) {
    const metadata = {
      managedBy: WIKILINK_EDGE_MANAGER,
      links: desired.links,
    };
    const upserted = await client.query(
      `INSERT INTO brain_edges
         (user_id, from_node_id, to_node_id, relation_type, weight, provenance, metadata)
       VALUES ($1, $2, $3, $4, 1, 'rule', $5)
       ON CONFLICT (user_id, from_node_id, to_node_id, relation_type)
       DO UPDATE SET
         weight = EXCLUDED.weight,
         metadata = EXCLUDED.metadata,
         updated_at = now()
       WHERE brain_edges.provenance = 'rule'
         AND brain_edges.metadata->>'managedBy' = $6
       RETURNING id`,
      [input.userId, input.fromNodeId, desired.nodeId, WIKILINK_RELATION_TYPE, metadata, WIKILINK_EDGE_MANAGER],
    );
    upsertedEdges += upserted.rowCount ?? 0;
  }

  return {
    sourceNodeId: input.fromNodeId,
    linksFound: references.length,
    uniqueTargets: referencesByTarget.size,
    resolvedTargets,
    unresolvedTargets,
    ignoredSelfTargets,
    linkedNodeIds,
    upsertedEdges,
    removedEdges: deleted.rowCount ?? 0,
  };
}

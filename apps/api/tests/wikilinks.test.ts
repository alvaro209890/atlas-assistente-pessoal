import type { PoolClient, QueryResult } from '@atlas/database';
import { describe, expect, it, vi } from 'vitest';
import {
  WIKILINK_EDGE_MANAGER,
  WikilinkSourceNotFoundError,
  extractWikilinks,
  syncWikilinkEdges,
} from '../src/wikilinks.js';
import type { AppDatabase } from '../src/types.js';

function result(rows: Record<string, unknown>[] = [], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: '', oid: 0, fields: [] } as QueryResult;
}

describe('extractWikilinks', () => {
  it('extracts targets, aliases, sections and their combined form', () => {
    const content = 'Veja [[Projeto Atlas]], [[Maria|responsável]], [[Manual#Instalação]] e [[API#Erros|guia rápido]].';

    expect(extractWikilinks(content)).toEqual([
      expect.objectContaining({ raw: '[[Projeto Atlas]]', target: 'Projeto Atlas' }),
      expect.objectContaining({ raw: '[[Maria|responsável]]', target: 'Maria', alias: 'responsável' }),
      expect.objectContaining({ raw: '[[Manual#Instalação]]', target: 'Manual', section: 'Instalação' }),
      expect.objectContaining({ raw: '[[API#Erros|guia rápido]]', target: 'API', section: 'Erros', alias: 'guia rápido' }),
    ]);
    expect(extractWikilinks(content).every((link) => content.slice(link.start, link.end) === link.raw)).toBe(true);
  });

  it('trims parts and ignores escaped, empty, multiline and malformed tokens', () => {
    const content = String.raw`\[[Escapado]] [[  Projeto  #  Próximos passos  |  abrir  ]] [[]] [[ |alias]] [[sem
fechar]] [[externo [[Interno]]`;

    expect(extractWikilinks(content)).toEqual([
      expect.objectContaining({ target: 'Projeto', section: 'Próximos passos', alias: 'abrir' }),
      expect.objectContaining({ target: 'Interno' }),
    ]);
  });
});

describe('syncWikilinkEdges', () => {
  it('resolves only same-user existing nodes, aggregates mentions and keeps manual edges protected', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('FROM brain_nodes') && sql.includes('FOR UPDATE')) {
        return result([{ id: 'source', user_id: 'user-1', title: 'Origem', aliases: [] }]);
      }
      if (sql.includes('FROM brain_nodes n')) {
        return result([
          { id: 'atlas', user_id: 'user-1', title: 'Projeto Atlas', aliases: ['Atlas'], updated_at: new Date() },
          { id: 'maria', user_id: 'user-1', title: 'Maria Silva', aliases: ['Maria'], updated_at: new Date() },
          // A defensive application-level check must reject this row even if a
          // future query/test double accidentally supplies it.
          { id: 'foreign', user_id: 'user-2', title: 'Segredo', aliases: [], updated_at: new Date() },
        ]);
      }
      if (sql.startsWith('INSERT INTO brain_nodes')) {
        const title = String(values[1]);
        return result([{
          id: `stub-${title.toLowerCase()}`, user_id: 'user-1', title, aliases: [], updated_at: new Date(),
        }]);
      }
      if (sql.startsWith('DELETE FROM brain_edges')) return result([], 1);
      if (sql.startsWith('INSERT INTO brain_edges')) return result([{ id: 'edge' }], 1);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;
    const userTransaction = vi.fn(async <T>(_userId: string, callback: (value: PoolClient) => Promise<T>) => callback(client));
    const database = { userTransaction } as Pick<AppDatabase, 'userTransaction'>;

    const synced = await syncWikilinkEdges(database, {
      userId: 'user-1',
      fromNodeId: 'source',
      content: '[[Projeto Atlas]] [[Atlas#Entrega|cronograma]] [[Maria]] [[Segredo]] [[Origem]] [[Ausente]]',
    });

    expect(userTransaction).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(synced).toMatchObject({
      linksFound: 6,
      uniqueTargets: 6,
      resolvedTargets: 5,
      linkedNodeIds: ['atlas', 'maria', 'stub-segredo', 'stub-ausente'],
      upsertedEdges: 4,
      removedEdges: 1,
      unresolvedTargets: [],
      ignoredSelfTargets: ['Origem'],
    });

    const candidatesQuery = queries.find(({ sql }) => sql.includes('FROM brain_nodes n'))!;
    expect(candidatesQuery.sql).toContain('n.user_id = $1');
    expect(candidatesQuery.values[0]).toBe('user-1');

    const deletion = queries.find(({ sql }) => sql.startsWith('DELETE FROM brain_edges'))!;
    expect(deletion.sql).toContain("provenance = 'rule'");
    expect(deletion.sql).toContain("metadata->>'managedBy'");
    expect(deletion.values).toContain(WIKILINK_EDGE_MANAGER);

    const insertions = queries.filter(({ sql }) => sql.startsWith('INSERT INTO brain_edges'));
    expect(insertions).toHaveLength(4);
    for (const insertion of insertions) {
      expect(insertion.sql).toContain("WHERE brain_edges.provenance = 'rule'");
      expect(insertion.sql).toContain("brain_edges.metadata->>'managedBy'");
    }
    expect(insertions[0]!.values[4]).toMatchObject({
      managedBy: WIKILINK_EDGE_MANAGER,
      links: [
        { target: 'Projeto Atlas' },
        { target: 'Atlas', section: 'Entrega', alias: 'cronograma' },
      ],
    });
  });

  it('does not overwrite a conflicting manual edge', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM brain_nodes') && sql.includes('FOR UPDATE')) {
        return result([{ id: 'source', user_id: 'user-1', title: 'Origem', aliases: [] }]);
      }
      if (sql.includes('FROM brain_nodes n')) {
        return result([{ id: 'target', user_id: 'user-1', title: 'Destino', aliases: [] }]);
      }
      if (sql.startsWith('DELETE FROM brain_edges')) return result([], 0);
      // PostgreSQL returns zero rows because the ON CONFLICT WHERE condition is
      // false for provenance=manual.
      if (sql.startsWith('INSERT INTO brain_edges')) return result([], 0);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;
    const database = {
      userTransaction: async <T>(_userId: string, callback: (value: PoolClient) => Promise<T>) => callback(client),
    } as Pick<AppDatabase, 'userTransaction'>;

    const synced = await syncWikilinkEdges(database, {
      userId: 'user-1', fromNodeId: 'source', content: '[[Destino]]',
    });

    expect(synced.linkedNodeIds).toEqual(['target']);
    expect(synced.upsertedEdges).toBe(0);
    const insertionSql = query.mock.calls.find(([sql]) => String(sql).startsWith('INSERT INTO brain_edges'))?.[0];
    expect(insertionSql).toContain("brain_edges.provenance = 'rule'");
  });

  it('fails inside the transaction when the source node is not owned by the user', async () => {
    const client = { query: vi.fn(async () => result([])) } as unknown as PoolClient;
    const database = {
      userTransaction: async <T>(_userId: string, callback: (value: PoolClient) => Promise<T>) => callback(client),
    } as Pick<AppDatabase, 'userTransaction'>;

    await expect(syncWikilinkEdges(database, {
      userId: 'user-1', fromNodeId: 'foreign-node', content: '[[Destino]]',
    })).rejects.toBeInstanceOf(WikilinkSourceNotFoundError);
  });
});

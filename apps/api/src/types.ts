import type { PoolClient, QueryResult, QueryResultRow } from '@atlas/database';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  sessionId: string;
}
export interface AppDatabase {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  userTransaction<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

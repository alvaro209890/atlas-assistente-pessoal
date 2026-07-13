import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiConfig } from './config.js';
import { AppError, parseInput } from './errors.js';
import { createSessionToken, hashPassword, hashSessionToken, normalizeEmail, verifyPassword } from './security.js';
import type { AppDatabase, AuthUser } from './types.js';

interface AuthDeps {
  database: AppDatabase;
  config: ApiConfig;
}

interface SessionRow {
  session_id: string;
  id: string;
  email: string;
  display_name: string;
  preferred_name: string;
  full_name: string | null;
  role: 'user' | 'admin';
  feature_flags: Record<string, unknown> | null;
}

const credentialsSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(10).max(200),
});

const registerSchema = credentialsSchema.extend({
  preferredName: z.string().trim().min(2).max(120),
  fullName: z.string().trim().min(2).max(180).nullable().optional(),
});

function publicSession(row: SessionRow) {
  return {
    user: {
      id: row.id,
      name: row.preferred_name,
      preferredName: row.preferred_name,
      fullName: row.full_name,
      email: row.email,
      avatarUrl: null,
    },
    onboardingComplete: row.feature_flags?.onboardingComplete === true,
  };
}

function setSessionCookie(reply: FastifyReply, token: string, config: ApiConfig): void {
  reply.setCookie(config.cookie.name, token, {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: config.cookie.sessionDays * 24 * 60 * 60,
  });
}

export function makeRequireAuth({ database, config }: AuthDeps) {
  return async function requireAuth(request: FastifyRequest): Promise<void> {
    const token = request.cookies[config.cookie.name];
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Sua sessão expirou. Entre novamente.');
    const tokenHash = hashSessionToken(token, config.cookie.sessionSecret);
    const result = await database.query<SessionRow>(
      `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.preferred_name, u.full_name,
              u.role, us.feature_flags
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN user_settings us ON us.user_id = u.id
       WHERE s.token_hash = $1
         AND s.expires_at > now()
         AND u.disabled_at IS NULL
       LIMIT 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Sua sessão expirou. Entre novamente.');
    request.authUser = {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      sessionId: row.session_id,
    };
    void database.query(
      `UPDATE sessions SET last_seen_at = now()
       WHERE id = $1 AND user_id = $2 AND last_seen_at < now() - interval '5 minutes'`,
      [row.session_id, row.id],
    ).catch((error: unknown) => request.log.warn({ err: error }, 'could not refresh session activity'));
  };
}

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', 'Sua sessão expirou. Entre novamente.');
  return request.authUser;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { database, config } = deps;
  const requireAuth = makeRequireAuth(deps);

  app.post('/api/auth/register', async (request, reply) => {
    const input = parseInput(registerSchema, request.body);
    const email = normalizeEmail(input.email);
    const preferredName = input.preferredName;
    const passwordHash = await hashPassword(input.password, config.bcryptRounds);
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token, config.cookie.sessionSecret);
    const expiresAt = new Date(Date.now() + config.cookie.sessionDays * 86_400_000);

    const row = await database.transaction(async (client) => {
      const user = await client.query<SessionRow>(
        `INSERT INTO users (email, password_hash, display_name, preferred_name, full_name)
         VALUES ($1, $2, $3, $3, $4)
         RETURNING id, email, display_name, preferred_name, full_name, role,
           NULL::uuid AS session_id, '{}'::jsonb AS feature_flags`,
        [email, passwordHash, preferredName, input.fullName ?? null],
      );
      const created = user.rows[0]!;
      await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [created.id]);
      await client.query('INSERT INTO user_profiles (user_id) VALUES ($1)', [created.id]);
      await client.query(
        `INSERT INTO automations (user_id,name,kind,schedule,config)
         VALUES
           ($1,'Briefings de prioridades','pending_reminder','0 8,18 * * *',$2),
           ($1,'Captura de conversas','message_ingestion',NULL,$3)`,
        [created.id, { notifySelf: true }, { quietWindowSeconds: 10, maxMessages: 30 }],
      );
      const session = await client.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5::inet)
         RETURNING id`,
        [created.id, tokenHash, expiresAt, request.headers['user-agent'] ?? null, request.ip],
      );
      return { ...created, session_id: session.rows[0]!.id };
    });

    setSessionCookie(reply, token, config);
    return reply.status(201).send(publicSession(row));
  });

  app.post('/api/auth/login', async (request, reply) => {
    const input = parseInput(credentialsSchema, request.body);
    const email = normalizeEmail(input.email);
    const userResult = await database.query<SessionRow & { password_hash: string }>(
      `SELECT u.id, u.email, u.display_name, u.preferred_name, u.full_name, u.role, u.password_hash,
              NULL::uuid AS session_id, us.feature_flags
       FROM users u
       LEFT JOIN user_settings us ON us.user_id = u.id
       WHERE lower(u.email) = lower($1) AND u.disabled_at IS NULL
       LIMIT 1`,
      [email],
    );
    const user = userResult.rows[0];
    if (!user || !(await verifyPassword(input.password, user.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.');
    }

    const token = createSessionToken();
    const session = await database.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, now() + ($3 * interval '1 day'), $4, $5::inet)
       RETURNING id`,
      [user.id, hashSessionToken(token, config.cookie.sessionSecret), config.cookie.sessionDays, request.headers['user-agent'] ?? null, request.ip],
    );
    user.session_id = session.rows[0]!.id;
    setSessionCookie(reply, token, config);
    return publicSession(user);
  });

  const sessionHandler = async (request: FastifyRequest) => {
    await requireAuth(request);
    const user = currentUser(request);
    const result = await database.query<SessionRow>(
      `SELECT u.id, u.email, u.display_name, u.preferred_name, u.full_name, u.role,
              $2::uuid AS session_id, us.feature_flags
       FROM users u LEFT JOIN user_settings us ON us.user_id = u.id
       WHERE u.id = $1`,
      [user.id, user.sessionId],
    );
    return publicSession(result.rows[0]!);
  };
  app.get('/api/auth/session', sessionHandler);
  app.get('/api/auth/me', sessionHandler);

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[config.cookie.name];
    if (token) await database.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token, config.cookie.sessionSecret)]);
    reply.clearCookie(config.cookie.name, { path: '/' });
    return reply.status(204).send();
  });
}

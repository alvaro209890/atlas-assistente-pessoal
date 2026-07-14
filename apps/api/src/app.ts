import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AiProvider } from './ai.js';
import { DeepSeekProvider } from './ai.js';
import { registerAuthRoutes, makeRequireAuth } from './auth.js';
import type { ApiConfig } from './config.js';
import { loadConfig } from './config.js';
import { AppError, errorHandler } from './errors.js';
import { EventHub } from './events.js';
import { HttpWhatsAppAdapter, QueuedWhatsAppAdapter, ServerKeyTrelloAdapter, type TrelloAdapter, type WhatsAppAdapter } from './integrations.js';
import { registerBrainRoutes } from './routes/brain.js';
import { registerBrainAdvancedRoutes } from './routes/brain-advanced.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerPlatformRoutes } from './routes/platform.js';
import type { AppDatabase } from './types.js';

class UnavailableAiProvider implements AiProvider {
  async answer(): Promise<never> {
    throw new Error('DEEPSEEK_API_KEY is not configured on the server');
  }
}

export interface BuildAppOptions {
  database: AppDatabase;
  config?: ApiConfig;
  ai?: AiProvider;
  whatsapp?: WhatsAppAdapter;
  trello?: TrelloAdapter;
  logger?: boolean;
  closeDatabaseOnClose?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 120_000,
  });
  app.decorateRequest('authUser', null);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({
    message: 'Rota não encontrada.', error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' },
  }));
  await app.register(cookie);
  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  const ai = options.ai ?? (config.deepseek.apiKey
    ? new DeepSeekProvider({
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
      model: config.deepseek.model,
      timeoutMs: config.deepseek.timeoutMs,
    })
    : new UnavailableAiProvider());
  const whatsapp = options.whatsapp ?? (config.whatsapp.serviceUrl
    ? new HttpWhatsAppAdapter(config.whatsapp.serviceUrl, config.whatsapp.serviceToken)
    : new QueuedWhatsAppAdapter());
  const trello = options.trello ?? (config.trello.apiKey
    ? new ServerKeyTrelloAdapter(config.trello.apiKey, config.trello.baseUrl)
    : undefined);
  const events = new EventHub(options.database);

  const healthHandler = async () => ({
    status: 'ok', service: 'atlas-api', version: '0.1.0', now: new Date().toISOString(),
  });
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  const readinessHandler = async (_request: unknown, reply: { status(code: number): { send(body: unknown): unknown } }) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await options.database.query('SELECT 1');
      checks.database = { ok: true };
    } catch (error) {
      checks.database = { ok: false, detail: error instanceof Error ? error.message : 'database unavailable' };
    }
    checks.deepseek = config.deepseek.apiKey
      ? { ok: true }
      : { ok: config.nodeEnv !== 'production', detail: 'DEEPSEEK_API_KEY is not configured' };
    const ready = Object.values(checks).every((check) => check.ok);
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks, now: new Date().toISOString() });
  };
  app.get('/ready', readinessHandler);
  app.get('/api/ready', readinessHandler);

  await registerAuthRoutes(app, { database: options.database, config });
  // Intentionally public for the current local-first phase, as requested.
  await app.register(async (adminApp) => {
    await registerAdminRoutes(adminApp, { database: options.database });
  }, { prefix: '/api/admin' });
  await app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', makeRequireAuth({ database: options.database, config }));
    await registerBrainRoutes(protectedApp, { database: options.database, events });
    await registerBrainAdvancedRoutes(protectedApp, { database: options.database, events });
    await registerChatRoutes(protectedApp, { database: options.database, events, ai });
    await registerAssistantRoutes(protectedApp, { database: options.database, events });
    await registerIntegrationRoutes(protectedApp, {
      database: options.database, config, events, whatsapp,
      ...(trello ? { trello } : {}),
    });
    await registerPlatformRoutes(protectedApp, { database: options.database, events });
  }, { prefix: '/api' });

  if (options.closeDatabaseOnClose) {
    app.addHook('onClose', async () => options.database.close());
  }
  return app;
}

export { AppError };

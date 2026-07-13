import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  SESSION_SECRET: z.string().optional(),
  SESSION_COOKIE_NAME: z.string().min(1).optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).optional(),
  COOKIE_NAME: z.string().min(1).optional(),
  COOKIE_SECURE: z.enum(['0', '1']).optional(),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).optional(),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
    DEEPSEEK_MODEL: z.literal('deepseek-v4-flash').default('deepseek-v4-flash'),
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(90_000),
  TRELLO_API_KEY: z.string().min(1).optional(),
  TRELLO_BASE_URL: z.string().url().default('https://api.trello.com/1'),
  TRELLO_CALLBACK_URL: z.string().url().default('http://localhost:3000/api/trello/callback'),
  WHATSAPP_SERVICE_URL: z.string().url().optional(),
  WHATSAPP_SERVICE_TOKEN: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface ApiConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  webOrigin: string;
  cookie: {
    name: string;
    secure: boolean;
    sessionDays: number;
    sessionSecret?: string;
  };
  bcryptRounds: number;
  deepseek: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    reasoningEffort: 'high';
    timeoutMs: number;
  };
  trello: {
    apiKey?: string;
    baseUrl: string;
    callbackUrl: string;
  };
  whatsapp: {
    serviceUrl?: string;
    serviceToken?: string;
  };
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.parse(env);
  if (parsed.NODE_ENV === 'production' && (
    !parsed.SESSION_SECRET
    || parsed.SESSION_SECRET.length < 32
    || parsed.SESSION_SECRET === 'replace-with-at-least-32-random-characters'
  )) {
    throw new Error('SESSION_SECRET with at least 32 characters is required in production');
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    webOrigin: parsed.WEB_ORIGIN,
    cookie: {
      name: parsed.SESSION_COOKIE_NAME ?? parsed.COOKIE_NAME ?? 'second_brain_session',
      secure: parsed.COOKIE_SECURE ? parsed.COOKIE_SECURE === '1' : parsed.NODE_ENV === 'production',
      sessionDays: parsed.SESSION_TTL_DAYS ?? parsed.SESSION_DAYS ?? 30,
      ...(parsed.SESSION_SECRET ? { sessionSecret: parsed.SESSION_SECRET } : {}),
    },
    bcryptRounds: parsed.BCRYPT_ROUNDS,
    deepseek: {
      ...(parsed.DEEPSEEK_API_KEY ? { apiKey: parsed.DEEPSEEK_API_KEY } : {}),
      baseUrl: parsed.DEEPSEEK_BASE_URL.replace(/\/$/, ''),
      model: parsed.DEEPSEEK_MODEL,
      reasoningEffort: 'high',
      timeoutMs: parsed.DEEPSEEK_TIMEOUT_MS,
    },
    trello: {
      ...(parsed.TRELLO_API_KEY ? { apiKey: parsed.TRELLO_API_KEY } : {}),
      baseUrl: parsed.TRELLO_BASE_URL.replace(/\/$/, ''),
      callbackUrl: parsed.TRELLO_CALLBACK_URL,
    },
    whatsapp: {
      ...(parsed.WHATSAPP_SERVICE_URL ? { serviceUrl: parsed.WHATSAPP_SERVICE_URL.replace(/\/$/, '') } : {}),
      ...(parsed.WHATSAPP_SERVICE_TOKEN ? { serviceToken: parsed.WHATSAPP_SERVICE_TOKEN } : {}),
    },
    logLevel: parsed.LOG_LEVEL,
  };
}

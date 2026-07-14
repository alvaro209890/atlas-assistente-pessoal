import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.literal("deepseek-v4-flash").default("deepseek-v4-flash"),
  TRELLO_APP_KEY: z.string().default(""),
  AI_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  MEMORY_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  BATCH_QUIET_SECONDS: z.coerce.number().int().min(1).max(60).default(10),
  BATCH_MAX_SECONDS: z.coerce.number().int().min(10).max(120).default(30),
  SESSION_WATCH_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
  LOG_LEVEL: z.string().default("info"),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
});

export type WorkerConfig = z.infer<typeof configSchema>;

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return configSchema.parse(env);
}

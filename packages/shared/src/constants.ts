export const AI_SCHEMA_VERSION = "2.1" as const;
export const AI_PROMPT_VERSION = "atlas-assistant-v2.1" as const;
export const DEFAULT_AI_CONFIDENCE_THRESHOLD = 0.7;
// Conhecimento é reversível e auditável; tarefas podem gerar efeitos externos.
// Por isso a memória usa um limiar próprio, deliberadamente mais permissivo.
export const DEFAULT_MEMORY_CONFIDENCE_THRESHOLD = 0.6;
export const INFERRED_LEARNING_CONFIDENCE_THRESHOLD = 0.85;
export const INFERRED_LEARNING_MIN_EVIDENCE = 3;
export const INFERRED_LEARNING_MIN_DISTINCT_DAYS = 2;
export const INFERRED_LEARNING_STALE_DAYS = 90;
export const AI_RETRY_DELAYS_SECONDS = [10, 60, 300] as const;
export const BATCH_QUIET_WINDOW_MS = 10_000;
export const BATCH_MAX_WINDOW_MS = 30_000;

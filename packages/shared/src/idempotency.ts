import { createHash } from "node:crypto";

import { AI_PROMPT_VERSION } from "./constants.js";

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

export function makeMessageDedupeKey(
  userId: string,
  connectionId: string,
  whatsappMessageId: string,
): string {
  return `wa:${hash([userId, connectionId, whatsappMessageId])}`;
}

export function makeBatchIdempotencyKey(
  userId: string,
  chatJid: string,
  messageIds: readonly string[],
  promptVersion: string = AI_PROMPT_VERSION,
): string {
  const stableIds = [...new Set(messageIds)].sort();
  return `ai:${hash([userId, chatJid, promptVersion, ...stableIds])}`;
}

export function makeTaskExecutionKey(batchKey: string, clientRef: string): string {
  return `trello:${hash([batchKey, clientRef])}`;
}

function normalizeFingerprintPart(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function makeCanonicalTaskFingerprint(input: {
  userId: string;
  title: string;
  project?: string | null;
  person?: string | null;
  nextAction?: string | null;
}): string {
  return `task:${hash([
    input.userId,
    normalizeFingerprintPart(input.title),
    normalizeFingerprintPart(input.project),
    normalizeFingerprintPart(input.person),
    normalizeFingerprintPart(input.nextAction),
  ])}`;
}

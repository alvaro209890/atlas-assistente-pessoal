import type { ActiveWhatsappConnection } from "./repository.js";

export interface WhatsAppSessionController {
  hasSession(userId: string): boolean;
  listSessionUserIds(): string[];
  start(userId: string): Promise<void>;
  stop(userId: string): Promise<void>;
}

const STARTABLE_STATUSES = new Set<ActiveWhatsappConnection["status"]>([
  "pairing",
  "connected",
  "reconnecting",
  "error",
]);

export async function reconcileWhatsAppSessions(
  connections: readonly ActiveWhatsappConnection[],
  sessions: WhatsAppSessionController,
  onStartError?: (userId: string, error: unknown) => void,
): Promise<void> {
  const desiredUsers = new Set(
    connections
      .filter((connection) => STARTABLE_STATUSES.has(connection.status))
      .map((connection) => connection.userId),
  );

  await Promise.all(
    sessions
      .listSessionUserIds()
      .filter((userId) => !desiredUsers.has(userId))
      .map((userId) => sessions.stop(userId)),
  );

  for (const userId of desiredUsers) {
    if (sessions.hasSession(userId)) continue;
    try {
      await sessions.start(userId);
    } catch (error) {
      onStartError?.(userId, error);
    }
  }
}

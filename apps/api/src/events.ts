import type { ServerResponse } from 'node:http';
import type { AppDatabase } from './types.js';

export interface AppEvent {
  id: number;
  topic: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

type Listener = (event: AppEvent) => void;

export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly database: AppDatabase) {}

  async publish(userId: string, eventType: string, payload: Record<string, unknown> = {}, topic = 'app'): Promise<AppEvent> {
    const result = await this.database.query<{
      id: string;
      topic: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date | string;
    }>(
      `INSERT INTO event_outbox (user_id, topic, event_type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id, topic, event_type, payload, created_at`,
      [userId, topic, eventType, payload],
    );
    const row = result.rows[0]!;
    const event: AppEvent = {
      id: Number(row.id),
      topic: row.topic,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: new Date(row.created_at).toISOString(),
    };
    for (const listener of this.listeners.get(userId) ?? []) listener(event);
    return event;
  }

  subscribe(userId: string, listener: Listener): () => void {
    const set = this.listeners.get(userId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(userId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(userId);
    };
  }

  static write(response: ServerResponse, event: AppEvent): void {
    response.write(`id: ${event.id}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

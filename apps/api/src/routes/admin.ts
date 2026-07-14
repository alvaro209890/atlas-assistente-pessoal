import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, parseInput } from '../errors.js';
import type { AppDatabase } from '../types.js';
import { frontendWhatsappStatus } from './integrations.js';

interface AdminDeps {
  database: AppDatabase;
}

interface PlatformWhatsAppRow {
  display_name: string;
  status: string;
  phone_number: string | null;
  pairing_qr: string | null;
  pairing_expires_at: Date | string | null;
  last_connected_at: Date | string | null;
  last_error: string | null;
  welcome_message: string;
  updated_at: Date | string;
}

function platformJson(row: PlatformWhatsAppRow) {
  return {
    displayName: row.display_name,
    status: frontendWhatsappStatus(row.status, Boolean(row.pairing_qr)),
    phoneLabel: row.phone_number,
    qrDataUrl: row.pairing_qr,
    qrExpiresAt: row.pairing_expires_at ? new Date(row.pairing_expires_at).toISOString() : null,
    lastConnectedAt: row.last_connected_at ? new Date(row.last_connected_at).toISOString() : null,
    error: row.last_error,
    welcomeMessage: row.welcome_message,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const selectPlatform = `SELECT display_name,status,phone_number,pairing_qr,pairing_expires_at,
  last_connected_at,last_error,welcome_message,updated_at
  FROM platform_whatsapp_connection WHERE singleton_key='mother'`;

export async function registerAdminRoutes(app: FastifyInstance, { database }: AdminDeps): Promise<void> {
  app.get('/whatsapp', async () => {
    const result = await database.query<PlatformWhatsAppRow>(selectPlatform);
    const row = result.rows[0];
    if (!row) throw new AppError(503, 'PLATFORM_WHATSAPP_MISSING', 'Execute as migrações do banco antes de abrir o painel admin.');
    return platformJson(row);
  });

  app.post('/whatsapp/pair', async () => {
    await database.query(
      `UPDATE platform_whatsapp_connection SET status=CASE WHEN status='connected' THEN status ELSE 'pairing' END,
         pairing_qr=CASE WHEN status='connected' THEN pairing_qr ELSE NULL END,
         pairing_expires_at=NULL,last_error=NULL WHERE singleton_key='mother'`,
    );
    const result = await database.query<PlatformWhatsAppRow>(selectPlatform);
    return platformJson(result.rows[0]!);
  });

  app.post('/whatsapp/disconnect', async () => {
    await database.transaction(async (client) => {
      await client.query("DELETE FROM platform_whatsapp_auth_records WHERE singleton_key='mother'");
      await client.query(
        `UPDATE platform_whatsapp_connection SET status='disconnected',phone_number=NULL,self_jid=NULL,
           pairing_qr=NULL,pairing_expires_at=NULL,last_error=NULL WHERE singleton_key='mother'`,
      );
    });
    return { status: 'disconnected' };
  });

  app.patch('/settings', async (request) => {
    const input = parseInput(z.object({
      welcomeMessage: z.string().trim().min(20).max(1500),
    }), request.body);
    const result = await database.query<PlatformWhatsAppRow>(
      `UPDATE platform_whatsapp_connection SET welcome_message=$1 WHERE singleton_key='mother'
       RETURNING display_name,status,phone_number,pairing_qr,pairing_expires_at,
         last_connected_at,last_error,welcome_message,updated_at`,
      [input.welcomeMessage],
    );
    return platformJson(result.rows[0]!);
  });

  app.get('/users', async () => {
    const result = await database.query<{
      id: string; preferred_name: string; email: string; phone_number: string | null;
      whatsapp_status: string | null; welcome_status: string | null; last_message_at: Date | string | null;
    }>(
      `SELECT u.id,u.preferred_name,u.email,wa.phone_number,wa.status AS whatsapp_status,
         welcome.status AS welcome_status,last_message.sent_at AS last_message_at
       FROM users u
       LEFT JOIN LATERAL (
         SELECT phone_number,status FROM whatsapp_connections
         WHERE user_id=u.id ORDER BY (status='connected') DESC,updated_at DESC LIMIT 1
       ) wa ON true
       LEFT JOIN LATERAL (
         SELECT status FROM notification_outbox
         WHERE user_id=u.id AND dedupe_key='platform-mother:welcome:v1'
         ORDER BY created_at DESC LIMIT 1
       ) welcome ON true
       LEFT JOIN LATERAL (
         SELECT sent_at FROM platform_whatsapp_messages
         WHERE user_id=u.id ORDER BY sent_at DESC LIMIT 1
       ) last_message ON true
       WHERE u.disabled_at IS NULL ORDER BY u.created_at DESC`,
    );
    return { items: result.rows.map((row) => ({
      id: row.id,
      preferredName: row.preferred_name,
      email: row.email,
      phoneLabel: row.phone_number,
      readerStatus: row.whatsapp_status,
      welcomeStatus: row.welcome_status,
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
    })) };
  });

  app.post('/messages', async (request, reply) => {
    const input = parseInput(z.object({
      userId: z.string().uuid(),
      message: z.string().trim().min(1).max(4000),
    }), request.body);
    const user = await database.query<{ preferred_name: string; self_jid: string }>(
      `SELECT u.preferred_name,wa.self_jid FROM users u
       JOIN LATERAL (
         SELECT self_jid FROM whatsapp_connections
         WHERE user_id=u.id AND self_jid IS NOT NULL
         ORDER BY (status='connected') DESC,updated_at DESC LIMIT 1
       ) wa ON true WHERE u.id=$1 AND u.disabled_at IS NULL`,
      [input.userId],
    );
    const recipient = user.rows[0];
    if (!recipient) throw new AppError(422, 'USER_WITHOUT_WHATSAPP', 'Este usuário ainda não conectou o WhatsApp pessoal.');
    const queued = await database.query<{ id: string }>(
      `INSERT INTO notification_outbox
         (user_id,channel,recipient_jid,subject,body,payload,dedupe_key)
       VALUES ($1,'whatsapp',$2,'Mensagem do Atlas',$3,$4,$5) RETURNING id`,
      [input.userId, recipient.self_jid, input.message,
        { kind: 'admin_message', userName: recipient.preferred_name }, `admin:${randomUUID()}`],
    );
    return reply.status(202).send({ queued: true, outboxId: Number(queued.rows[0]!.id) });
  });
}

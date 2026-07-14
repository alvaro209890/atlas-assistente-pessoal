import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';
import { currentUser } from '../auth.js';
import { AppError, parseInput } from '../errors.js';
import type { EventHub } from '../events.js';
import type { TrelloAdapter, WhatsAppAdapter, WhatsAppPairingResult } from '../integrations.js';
import type { AppDatabase } from '../types.js';

interface IntegrationDeps {
  database: AppDatabase;
  config: ApiConfig;
  events: EventHub;
  whatsapp: WhatsAppAdapter;
  trello?: TrelloAdapter;
}

interface WhatsAppRow {
  id: string;
  display_name: string;
  status: string;
  phone_number: string | null;
  pairing_qr: string | null;
  pairing_expires_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function frontendWhatsappStatus(status: string, hasQr = false) {
  return status === 'pairing'
    ? (hasQr ? 'qr' : 'connecting')
    : status === 'connected' ? 'connected'
      : status === 'reconnecting' ? 'reconnecting'
        : status === 'error' ? 'error'
          : status === 'disconnected' || status === 'logged_out' ? 'disconnected' : 'connecting';
}

function whatsappJson(row: WhatsAppRow) {
  const frontendStatus = frontendWhatsappStatus(row.status, Boolean(row.pairing_qr));
  return {
    id: row.id,
    name: row.display_name,
    status: frontendStatus,
    qrDataUrl: row.pairing_qr,
    qrExpiresAt: row.pairing_expires_at ? new Date(row.pairing_expires_at).toISOString() : null,
    phoneLabel: row.phone_number,
    error: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function storeAdapterState(database: AppDatabase, userId: string, connectionId: string, state: WhatsAppPairingResult): Promise<void> {
  await database.query(
    `UPDATE whatsapp_connections SET status=$3, pairing_qr=$4, pairing_expires_at=$5,
       phone_number=COALESCE($6,phone_number), last_connected_at=CASE WHEN $3='connected' THEN now() ELSE last_connected_at END,
       last_error=$7
     WHERE id=$1 AND user_id=$2`,
    [connectionId, userId, state.status, state.qrDataUrl ?? null, state.expiresAt ?? null,
      state.phoneNumber ?? null, state.error ?? null],
  );
}

export async function registerIntegrationRoutes(app: FastifyInstance, deps: IntegrationDeps): Promise<void> {
  const { database, config, events, whatsapp, trello } = deps;
  const uuidParams = z.object({ id: z.string().uuid() });

  app.get('/whatsapp/connections', async (request) => {
    const user = currentUser(request);
    const result = await database.query<WhatsAppRow>(
      `SELECT id,display_name,status,phone_number,pairing_qr,pairing_expires_at,last_error,created_at,updated_at
       FROM whatsapp_connections WHERE user_id=$1 ORDER BY created_at DESC`, [user.id],
    );
    return { items: result.rows.map(whatsappJson) };
  });

  async function createWhatsApp(request: Parameters<typeof currentUser>[0]) {
    const user = currentUser(request);
    const body = parseInput(z.object({ displayName: z.string().trim().min(1).max(120).default('WhatsApp principal') }), request.body ?? {});
    const row = await database.userTransaction(user.id, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [user.id]);
      const existing = await client.query<WhatsAppRow>(
        `SELECT id,display_name,status,phone_number,pairing_qr,pairing_expires_at,last_error,created_at,updated_at
         FROM whatsapp_connections WHERE user_id=$1 AND status<>'logged_out'
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`, [user.id],
      );
      if (existing.rows[0]?.status === 'connected') return existing.rows[0];
      const result = existing.rows[0]
        ? await client.query<WhatsAppRow>(
          `UPDATE whatsapp_connections SET display_name=$3,status='pairing',pairing_qr=NULL,
             pairing_expires_at=NULL,last_error=NULL
           WHERE id=$1 AND user_id=$2
           RETURNING id,display_name,status,phone_number,pairing_qr,pairing_expires_at,last_error,created_at,updated_at`,
          [existing.rows[0].id, user.id, body.displayName],
        )
        : await client.query<WhatsAppRow>(
          `INSERT INTO whatsapp_connections (user_id,display_name,status)
           VALUES ($1,$2,'pairing')
           RETURNING id,display_name,status,phone_number,pairing_qr,pairing_expires_at,last_error,created_at,updated_at`,
          [user.id, body.displayName],
        );
      return result.rows[0]!;
    });
    if (row.status === 'connected') return whatsappJson(row);
    try {
      const state = await whatsapp.beginPairing({ userId: user.id, connectionId: row.id });
      await storeAdapterState(database, user.id, row.id, state);
    } catch (error) {
      await storeAdapterState(database, user.id, row.id, {
        status: 'error', error: error instanceof Error ? error.message.slice(0, 500) : 'Falha ao iniciar conexão',
      });
    }
    const result = await database.query<WhatsAppRow>(
      `SELECT id,display_name,status,phone_number,pairing_qr,pairing_expires_at,last_error,created_at,updated_at
       FROM whatsapp_connections WHERE id=$1 AND user_id=$2`, [row.id, user.id],
    );
    await events.publish(user.id, 'whatsapp.connection.created', { connectionId: row.id }, 'whatsapp');
    return whatsappJson(result.rows[0]!);
  }
  app.post('/whatsapp/connections', async (request, reply) => reply.status(201).send(await createWhatsApp(request)));
  app.post('/whatsapp/sessions', async (request, reply) => reply.status(201).send(await createWhatsApp(request)));

  async function getWhatsApp(request: Parameters<typeof currentUser>[0]) {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const existing = await database.query<WhatsAppRow>(
      `SELECT id,display_name,status,phone_number,pairing_qr,pairing_expires_at,last_error,created_at,updated_at
       FROM whatsapp_connections WHERE id=$1 AND user_id=$2`, [id, user.id],
    );
    if (!existing.rows[0]) throw new AppError(404, 'WHATSAPP_NOT_FOUND', 'Conexão do WhatsApp não encontrada.');
    try {
      const latest = await whatsapp.readSession({ userId: user.id, connectionId: id });
      if (latest) {
        await storeAdapterState(database, user.id, id, latest);
        const refreshed = await database.query<WhatsAppRow>(
          `SELECT id,display_name,status,phone_number,pairing_qr,pairing_expires_at,last_error,created_at,updated_at
           FROM whatsapp_connections WHERE id=$1 AND user_id=$2`, [id, user.id],
        );
        return whatsappJson(refreshed.rows[0]!);
      }
    } catch (error) {
      request.log.warn({ err: error, connectionId: id }, 'could not refresh WhatsApp session');
    }
    return whatsappJson(existing.rows[0]);
  }
  app.get('/whatsapp/connections/:id', getWhatsApp);
  app.get('/whatsapp/sessions/:id', getWhatsApp);

  app.post('/whatsapp/connections/:id/disconnect', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const owned = await database.query('SELECT 1 FROM whatsapp_connections WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!owned.rows[0]) throw new AppError(404, 'WHATSAPP_NOT_FOUND', 'Conexão do WhatsApp não encontrada.');
    await database.query(
      `UPDATE whatsapp_connections SET status='disconnected', pairing_qr=NULL, pairing_expires_at=NULL
       WHERE id=$1 AND user_id=$2`, [id, user.id],
    );
    try { await whatsapp.disconnect({ userId: user.id, connectionId: id }); }
    catch (error) { request.log.warn({ err: error, connectionId: id }, 'could not immediately stop WhatsApp adapter'); }
    await events.publish(user.id, 'whatsapp.connection.disconnected', { connectionId: id }, 'whatsapp');
    return { id, status: 'disconnected' };
  });

  app.delete('/whatsapp/connections/:id', async (request, reply) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const owned = await database.query('SELECT 1 FROM whatsapp_connections WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!owned.rows[0]) throw new AppError(404, 'WHATSAPP_NOT_FOUND', 'Conexão do WhatsApp não encontrada.');
    try { await whatsapp.disconnect({ userId: user.id, connectionId: id }); }
    catch (error) { request.log.warn({ err: error, connectionId: id }, 'could not immediately stop WhatsApp adapter before deletion'); }
    await database.transaction(async (client) => {
      await client.query('DELETE FROM whatsapp_auth_records WHERE user_id=$1', [user.id]);
      await client.query('DELETE FROM whatsapp_connections WHERE id=$1 AND user_id=$2', [id, user.id]);
    });
    await events.publish(user.id, 'whatsapp.connection.deleted', { connectionId: id }, 'whatsapp');
    return reply.status(204).send();
  });

  app.get('/whatsapp/chats', async (request) => {
    const user = currentUser(request);
    const query = parseInput(z.object({ connectionId: z.string().uuid().optional() }), request.query);
    let connectionId = query.connectionId;
    if (!connectionId) {
      const connection = await database.query<{ id: string }>(
        `SELECT id FROM whatsapp_connections WHERE user_id=$1 ORDER BY (status='connected') DESC,created_at DESC LIMIT 1`, [user.id],
      );
      connectionId = connection.rows[0]?.id;
    }
    if (!connectionId) return [];
    const owned = await database.query('SELECT 1 FROM whatsapp_connections WHERE id=$1 AND user_id=$2', [connectionId, user.id]);
    if (!owned.rows[0]) throw new AppError(404, 'WHATSAPP_NOT_FOUND', 'Conexão do WhatsApp não encontrada.');
    let remote = [] as Awaited<ReturnType<WhatsAppAdapter['listChats']>>;
    try { remote = await whatsapp.listChats({ userId: user.id, connectionId }); }
    catch (error) { request.log.warn({ err: error }, 'could not list remote chats'); }
    if (remote.length) {
      for (const chat of remote) {
        await database.query(
          `INSERT INTO monitored_chats (user_id,whatsapp_connection_id,jid,display_name,is_group,enabled,metadata)
           VALUES ($1,$2,$3,$4,$5,false,$6)
           ON CONFLICT (user_id,whatsapp_connection_id,jid)
           DO UPDATE SET display_name=EXCLUDED.display_name,is_group=EXCLUDED.is_group,metadata=monitored_chats.metadata || EXCLUDED.metadata`,
          [user.id, connectionId, chat.jid, chat.name, chat.isGroup, { lastMessageAt: chat.lastMessageAt ?? null }],
        );
      }
    }
    const result = await database.query<{
      id: string; display_name: string; is_group: boolean; enabled: boolean; metadata: { lastMessageAt?: string };
    }>(
      `SELECT id,display_name,is_group,enabled,metadata FROM monitored_chats
       WHERE user_id=$1 AND whatsapp_connection_id=$2
         AND (jid LIKE '%@g.us' OR jid LIKE '%@s.whatsapp.net')
       ORDER BY (display_name <> '') DESC, is_group DESC, display_name`, [user.id, connectionId],
    );
    return result.rows.map((row) => ({
      id: row.id, name: row.display_name, kind: row.is_group ? 'group' : 'direct',
      lastMessageAt: row.metadata.lastMessageAt ?? null, selected: row.enabled,
    }));
  });

  app.patch('/whatsapp/chats/:id', async (request) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({ enabled: z.boolean(), displayName: z.string().trim().min(1).max(160).optional() }), request.body);
    const result = await database.query(
      `UPDATE monitored_chats SET enabled=$3,display_name=COALESCE($4,display_name)
       WHERE id=$1 AND user_id=$2 RETURNING id,enabled,display_name AS "displayName"`,
      [id, user.id, input.enabled, input.displayName ?? null],
    );
    if (!result.rows[0]) throw new AppError(404, 'CHAT_NOT_FOUND', 'Conversa não encontrada.');
    await events.publish(user.id, 'whatsapp.chat.updated', { chatId: id, enabled: input.enabled }, 'whatsapp');
    return result.rows[0];
  });

  app.post('/whatsapp/chats/monitor-all', async (request) => {
    const user = currentUser(request);
    const input = parseInput(z.object({ enabled: z.boolean(), connectionId: z.string().uuid().optional() }), request.body);
    let connectionId = input.connectionId;
    if (!connectionId) {
      const connection = await database.query<{ id: string }>(
        `SELECT id FROM whatsapp_connections WHERE user_id=$1 ORDER BY (status='connected') DESC,created_at DESC LIMIT 1`, [user.id],
      );
      connectionId = connection.rows[0]?.id;
    }
    if (!connectionId) return { updated: 0 };
    const result = await database.query(
      `UPDATE monitored_chats SET enabled=$3 WHERE user_id=$1 AND whatsapp_connection_id=$2`,
      [user.id, connectionId, input.enabled],
    );
    await events.publish(user.id, 'whatsapp.chat.updated', { all: true, enabled: input.enabled }, 'whatsapp');
    return { updated: result.rowCount ?? 0 };
  });

  async function listTrelloConnections(request: Parameters<typeof currentUser>[0]) {
    const user = currentUser(request);
    const result = await database.query(
      `SELECT tc.id,tc.display_name AS "displayName",tc.member_id AS "memberId",tc.member_name AS "memberName",
              tc.status,tc.last_verified_at AS "lastVerifiedAt",tc.last_error AS "lastError",tc.created_at AS "createdAt",
              bc.board_id AS "boardId",bc.board_name AS "boardName",bc.inbox_list_id AS "inboxListId",
              bc.in_progress_list_id AS "inProgressListId",bc.paused_list_id AS "pausedListId",bc.done_list_id AS "doneListId"
       FROM trello_connections tc
       LEFT JOIN LATERAL (
         SELECT board_id,board_name,inbox_list_id,in_progress_list_id,paused_list_id,done_list_id
         FROM trello_board_configs
         WHERE user_id=tc.user_id AND trello_connection_id=tc.id AND is_active=true
         ORDER BY updated_at DESC LIMIT 1
       ) bc ON true
       WHERE tc.user_id=$1 ORDER BY tc.created_at DESC`, [user.id],
    );
    return { items: result.rows };
  }
  app.get('/integrations/trello', listTrelloConnections);
  app.get('/trello/connections', listTrelloConnections);

  app.get('/trello/authorize', async (request) => {
    const user = currentUser(request);
    if (!config.trello.apiKey || !trello) {
      throw new AppError(503, 'TRELLO_NOT_CONFIGURED', 'A integração com Trello ainda não foi configurada no servidor.');
    }
    const state = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    await database.query(
      `INSERT INTO idempotency_keys
         (user_id,namespace,idempotency_key,status,expires_at,resource_type)
       VALUES ($1,'trello_oauth',$2,'processing',$3,'trello_connection')`,
      [user.id, state, expiresAt],
    );
    const url = new URL('https://trello.com/1/authorize');
    url.searchParams.set('expiration', 'never');
    url.searchParams.set('name', 'Atlas');
    url.searchParams.set('scope', 'read,write');
    url.searchParams.set('response_type', 'token');
    url.searchParams.set('callback_method', 'fragment');
    url.searchParams.set('key', config.trello.apiKey);
    const callback = new URL(config.trello.callbackUrl);
    callback.searchParams.set('state', state);
    url.searchParams.set('return_url', callback.toString());
    url.searchParams.set('state', state);
    return { authorizeUrl: url.toString(), state, expiresAt: expiresAt.toISOString() };
  });

  async function connectTrello(request: Parameters<typeof currentUser>[0]) {
    const user = currentUser(request);
    const input = parseInput(z.object({
      token: z.string().trim().min(8).max(2_000),
      state: z.string().trim().min(20).max(200),
    }).strict(), request.body);
    if (!config.trello.apiKey || !trello) {
      throw new AppError(503, 'TRELLO_NOT_CONFIGURED', 'A integração com Trello ainda não foi configurada no servidor.');
    }
    const state = await database.query(
      `DELETE FROM idempotency_keys
       WHERE user_id=$1 AND namespace='trello_oauth' AND idempotency_key=$2
         AND status='processing' AND expires_at>now()
       RETURNING id`, [user.id, input.state],
    );
    if (!state.rows[0]) throw new AppError(400, 'TRELLO_STATE_INVALID', 'A autorização expirou ou não pertence a esta sessão. Inicie novamente.');
    let member;
    try { member = await trello.verify(input.token); }
    catch { throw new AppError(400, 'TRELLO_TOKEN_INVALID', 'Não foi possível validar o acesso ao Trello.'); }
    const result = await database.query<{ id: string }>(
      `INSERT INTO trello_connections
         (user_id,display_name,api_key,access_token,member_id,member_name,status,last_verified_at)
       VALUES ($1,'Trello',$2,$3,$4,$5,'connected',now())
       ON CONFLICT (user_id,member_id) WHERE member_id IS NOT NULL DO UPDATE SET
         display_name=EXCLUDED.display_name,api_key=EXCLUDED.api_key,access_token=EXCLUDED.access_token,
         member_name=EXCLUDED.member_name,status='connected',last_verified_at=now(),last_error=NULL
       RETURNING id`,
      [user.id, config.trello.apiKey, input.token, member.id, member.fullName ?? member.username ?? 'Trello'],
    );
    await events.publish(user.id, 'trello.connected', { connectionId: result.rows[0]!.id }, 'trello');
    return { connected: true, id: result.rows[0]!.id, memberName: member.fullName ?? member.username ?? null };
  }
  app.post('/integrations/trello/connect', async (request, reply) => reply.status(201).send(await connectTrello(request)));
  app.post('/trello/connect', async (request, reply) => reply.status(201).send(await connectTrello(request)));
  app.post('/trello/callback', async (request, reply) => reply.status(201).send(await connectTrello(request)));
  app.get('/trello/callback', async (request, reply) => {
    const { state } = parseInput(z.object({ state: z.string().min(20).max(200) }), request.query);
    const endpoint = '/api/trello/callback';
    const successUrl = `${config.webOrigin.replace(/\/$/, '')}/?trello=connected`;
    const errorUrl = `${config.webOrigin.replace(/\/$/, '')}/?trello=error`;
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Conectando Trello ao Atlas</title></head>
<body><p>Concluindo a conexão com o Trello...</p><script>
(async()=>{const token=new URLSearchParams(location.hash.slice(1)).get('token');
if(!token){location.replace(${JSON.stringify(errorUrl)});return;}
const response=await fetch(${JSON.stringify(endpoint)},{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,state:${JSON.stringify(state)}})});
location.replace(response.ok?${JSON.stringify(successUrl)}:${JSON.stringify(errorUrl)});})().catch(()=>location.replace(${JSON.stringify(errorUrl)}));
</script></body></html>`;
    return reply.type('text/html; charset=utf-8').send(html);
  });

  async function listBoards(request: Parameters<typeof currentUser>[0]) {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    if (!trello) throw new AppError(503, 'TRELLO_NOT_CONFIGURED', 'A integração com Trello ainda não foi configurada no servidor.');
    const connection = await database.query<{ access_token: string }>(
      'SELECT access_token FROM trello_connections WHERE id=$1 AND user_id=$2 AND status=$3', [id, user.id, 'connected'],
    );
    if (!connection.rows[0]) throw new AppError(404, 'TRELLO_NOT_FOUND', 'Conexão com Trello não encontrada.');
    return { items: await trello.listBoards(connection.rows[0].access_token) };
  }
  app.get('/integrations/trello/:id/boards', listBoards);
  app.get('/trello/connections/:id/boards', listBoards);

  app.get('/trello/boards/:boardId/lists', async (request) => {
    const user = currentUser(request);
    const { boardId } = parseInput(z.object({ boardId: z.string().min(1).max(200) }), request.params);
    const query = parseInput(z.object({ connectionId: z.string().uuid().optional() }), request.query);
    if (!trello) throw new AppError(503, 'TRELLO_NOT_CONFIGURED', 'A integração com Trello ainda não foi configurada no servidor.');
    const connection = await database.query<{ id: string; access_token: string }>(
      `SELECT tc.id,tc.access_token FROM trello_connections tc
       LEFT JOIN trello_board_configs bc ON bc.trello_connection_id=tc.id AND bc.user_id=tc.user_id AND bc.board_id=$2
       WHERE tc.user_id=$1 AND tc.status='connected' AND ($3::uuid IS NULL OR tc.id=$3)
       ORDER BY (bc.id IS NOT NULL) DESC,tc.created_at DESC LIMIT 1`,
      [user.id, boardId, query.connectionId ?? null],
    );
    if (!connection.rows[0]) throw new AppError(404, 'TRELLO_NOT_FOUND', 'Conexão com Trello não encontrada.');
    return { connectionId: connection.rows[0].id, items: await trello.listLists(connection.rows[0].access_token, boardId) };
  });

  app.get('/trello/boards/:boardId/mapping', async (request) => {
    const user = currentUser(request);
    const { boardId } = parseInput(z.object({ boardId: z.string().min(1).max(200) }), request.params);
    const result = await database.query(
      `SELECT id,trello_connection_id AS "connectionId",board_id AS "boardId",board_name AS "boardName",
              inbox_list_id AS "inboxListId",in_progress_list_id AS "inProgressListId",
              paused_list_id AS "pausedListId",done_list_id AS "doneListId",
              project_list_map AS "projectListMap",is_active AS "isActive"
       FROM trello_board_configs WHERE user_id=$1 AND board_id=$2 ORDER BY is_active DESC,updated_at DESC LIMIT 1`,
      [user.id, boardId],
    );
    if (!result.rows[0]) throw new AppError(404, 'TRELLO_MAPPING_NOT_FOUND', 'Mapeamento desse quadro não foi configurado.');
    return result.rows[0];
  });

  app.put('/trello/boards/:boardId/mapping', async (request) => {
    const user = currentUser(request);
    const { boardId } = parseInput(z.object({ boardId: z.string().min(1).max(200) }), request.params);
    const input = parseInput(z.object({
      connectionId: z.string().uuid(), boardName: z.string().max(300).default(''),
      inboxListId: z.string().max(200).nullable().optional(), inProgressListId: z.string().max(200).nullable().optional(),
      pausedListId: z.string().max(200).nullable().optional(), doneListId: z.string().max(200).nullable().optional(),
      projectListMap: z.record(z.string(), z.string()).default({}), isActive: z.boolean().default(true),
    }), request.body);
    const result = await database.transaction(async (client) => {
      if (input.isActive) {
        await client.query('UPDATE trello_board_configs SET is_active=false WHERE user_id=$1', [user.id]);
      }
      return client.query(
        `INSERT INTO trello_board_configs
           (user_id,trello_connection_id,board_id,board_name,inbox_list_id,in_progress_list_id,paused_list_id,done_list_id,project_list_map,is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id,trello_connection_id,board_id) DO UPDATE SET
           board_name=EXCLUDED.board_name,inbox_list_id=EXCLUDED.inbox_list_id,in_progress_list_id=EXCLUDED.in_progress_list_id,
           paused_list_id=EXCLUDED.paused_list_id,done_list_id=EXCLUDED.done_list_id,
           project_list_map=EXCLUDED.project_list_map,is_active=EXCLUDED.is_active
         RETURNING id,trello_connection_id AS "connectionId",board_id AS "boardId",board_name AS "boardName",
           inbox_list_id AS "inboxListId",in_progress_list_id AS "inProgressListId",
           paused_list_id AS "pausedListId",done_list_id AS "doneListId",project_list_map AS "projectListMap",is_active AS "isActive"`,
        [user.id, input.connectionId, boardId, input.boardName, input.inboxListId ?? null, input.inProgressListId ?? null,
          input.pausedListId ?? null, input.doneListId ?? null, input.projectListMap, input.isActive],
      );
    });
    await events.publish(user.id, 'trello.board.configured', { boardConfigId: result.rows[0]?.id }, 'trello');
    return result.rows[0];
  });

  app.post('/integrations/trello/:id/boards', async (request, reply) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const input = parseInput(z.object({
      boardId: z.string().min(1).max(200), boardName: z.string().max(300).default(''),
      inboxListId: z.string().max(200).nullable().optional(), inProgressListId: z.string().max(200).nullable().optional(),
      pausedListId: z.string().max(200).nullable().optional(), doneListId: z.string().max(200).nullable().optional(),
      projectListMap: z.record(z.string(), z.string()).default({}),
    }), request.body);
    const result = await database.transaction(async (client) => {
      await client.query('UPDATE trello_board_configs SET is_active=false WHERE user_id=$1', [user.id]);
      return client.query(
        `INSERT INTO trello_board_configs
           (user_id,trello_connection_id,board_id,board_name,inbox_list_id,in_progress_list_id,paused_list_id,done_list_id,project_list_map)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id,trello_connection_id,board_id) DO UPDATE SET
           board_name=EXCLUDED.board_name,inbox_list_id=EXCLUDED.inbox_list_id,
           in_progress_list_id=EXCLUDED.in_progress_list_id,paused_list_id=EXCLUDED.paused_list_id,
           done_list_id=EXCLUDED.done_list_id,project_list_map=EXCLUDED.project_list_map,is_active=true
         RETURNING id,board_id AS "boardId",board_name AS "boardName",is_active AS "isActive"`,
        [user.id, id, input.boardId, input.boardName, input.inboxListId ?? null, input.inProgressListId ?? null,
          input.pausedListId ?? null, input.doneListId ?? null, input.projectListMap],
      );
    });
    await events.publish(user.id, 'trello.board.configured', { boardConfigId: result.rows[0]?.id }, 'trello');
    return reply.status(201).send(result.rows[0]);
  });

  async function listTrelloCards(request: Parameters<typeof currentUser>[0]) {
    const user = currentUser(request);
    const result = await database.query(
      `SELECT id,trello_card_id AS "trelloCardId",title,list_name AS "list",due_at AS "due",
              labels,closed,url,synced_at AS "syncedAt"
       FROM trello_cards WHERE user_id=$1 ORDER BY closed,due_at NULLS LAST,updated_at DESC LIMIT 300`, [user.id],
    );
    return { items: result.rows };
  }
  app.get('/integrations/trello/cards', listTrelloCards);
  app.get('/trello/cards', listTrelloCards);

  app.delete('/integrations/trello/:id', async (request, reply) => {
    const user = currentUser(request);
    const { id } = parseInput(uuidParams, request.params);
    const result = await database.query('DELETE FROM trello_connections WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!result.rowCount) throw new AppError(404, 'TRELLO_NOT_FOUND', 'Conexão com Trello não encontrada.');
    await events.publish(user.id, 'trello.disconnected', { connectionId: id }, 'trello');
    return reply.status(204).send();
  });
}

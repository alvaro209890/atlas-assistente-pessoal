#!/usr/bin/env node
/**
 * Reprocessa conversas do WhatsApp exclusivamente para notas, observações e
 * vínculos. Não cria tarefas, cartões, lembretes, compromissos ou mensagens.
 * Sem --apply, apenas consulta o banco e chama a IA para produzir um relatório.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabaseFromEnv } from '@atlas/database';
import { buildAiContext } from '@atlas/shared';
import { DeepSeekDecisionClient } from '@atlas/integrations';
import { WorkerRepository } from '../apps/worker/dist/repository.js';

const args = new Set(process.argv.slice(2));
const nameIndex = process.argv.indexOf('--user');
const userName = nameIndex >= 0 ? process.argv[nameIndex + 1] : undefined;
const apply = args.has('--apply');
if (!userName) throw new Error('Uso: node scripts/replay-whatsapp-notes.mjs --user "nome" [--apply]');

const root = resolve(new URL('..', import.meta.url).pathname);
const envText = await readFile(resolve(root, '.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const database = createDatabaseFromEnv(process.env);
const repository = new WorkerRepository(database);
const userResult = await database.query(
  `SELECT u.id::text,u.preferred_name,s.timezone,s.locale
   FROM users u JOIN user_settings s ON s.user_id=u.id
   WHERE lower(u.preferred_name)=lower($1) LIMIT 1`, [userName],
);
const user = userResult.rows[0];
if (!user) throw new Error(`Usuário não encontrado: ${userName}`);

const messages = await database.query(
  `SELECT external_message_id,chat_jid,sender_jid,COALESCE(metadata->>'senderName',NULL) AS sender_name,
          sent_at,from_me,body,metadata
   FROM whatsapp_messages WHERE user_id=$1 AND message_type='text' AND btrim(body)<>''
   ORDER BY chat_jid,sent_at`, [user.id],
);
const byChat = new Map();
for (const row of messages.rows) {
  const items = byChat.get(row.chat_jid) ?? [];
  items.push(row);
  byChat.set(row.chat_jid, items);
}
const ai = new DeepSeekDecisionClient({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL });
let analyzed = 0;
let notes = 0;
let failures = 0;
for (const [chatJid, rows] of byChat) {
  const context = buildAiContext({
    now: new Date(), chatJid, chatName: null,
    preferences: { timezone: user.timezone, language: user.locale },
    isGroupChat: chatJid.endsWith('@g.us'),
    messages: rows.slice(-30).map((row) => ({
      id: row.external_message_id, userId: user.id, chatJid, senderJid: row.sender_jid,
      senderName: row.sender_name, sentAt: new Date(row.sent_at).toISOString(), fromMe: row.from_me,
      text: row.body, isGroup: chatJid.endsWith('@g.us'),
      mentionedJids: Array.isArray(row.metadata?.mentionedJids) ? row.metadata.mentionedJids : [],
      quotedParticipantJid: row.metadata?.quotedParticipantJid ?? null,
      quotedMessageId: row.metadata?.quotedMessageId ?? null,
      directedToUser: row.from_me || !chatJid.endsWith('@g.us'),
    })),
  });
  try {
    const result = await ai.decide(context);
    const memories = result.decision.memories.filter((memory) => memory.operation === 'upsert' && memory.confidence >= Number(process.env.MEMORY_CONFIDENCE_THRESHOLD || 0.6));
    analyzed += rows.length;
    notes += memories.length;
    if (apply && memories.length) await repository.upsertMemories(user.id, memories);
  } catch (error) {
    failures += rows.length;
    console.error(`Falha ao analisar um chat (${chatJid.slice(0, 12)}…): ${error instanceof Error ? error.message : String(error)}`);
  }
}
await new Promise((done) => process.stdout.write(`${JSON.stringify({ user: user.preferred_name, mode: apply ? 'apply-notes-only' : 'dry-run', chats: byChat.size, messages: messages.rows.length, analyzed, proposedNotes: notes, failures, externalActions: 0 })}\n`, done));
await database.close();
process.exit(failures > 0 ? 2 : 0);

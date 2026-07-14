import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  jidNormalizedUser,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

import { IntegrationError } from "./errors.js";

export interface BaileysAuthRepository {
  get(userId: string, category: string, key: string): Promise<string | null>;
  set(userId: string, category: string, key: string, value: string | null): Promise<void>;
  clearUser(userId: string): Promise<void>;
}

export interface SelectedChatRepository {
  isSelected(userId: string, chatJid: string): Promise<boolean>;
}

export type WhatsAppSessionEvent =
  | { type: "qr"; userId: string; qr: string; dataUrl: string }
  | { type: "connected"; userId: string; selfJid: string; displayName?: string | null }
  | { type: "disconnected"; userId: string; retrying: boolean }
  | { type: "logged_out"; userId: string }
  | { type: "error"; userId: string; error: Error }
  | {
      type: "conversations";
      userId: string;
      conversations: WhatsAppConversationCatalogEntry[];
    }
  | {
      type: "contacts";
      userId: string;
      contacts: { jid: string; name: string; saved: boolean }[];
    }
  | {
      type: "text_message";
      userId: string;
      message: {
        id: string;
        chatJid: string;
        senderJid: string;
        senderName: string | null;
        sentAt: string;
        fromMe: boolean;
        text: string;
        isGroup: boolean;
        mentionedJids: string[];
        quotedParticipantJid: string | null;
        quotedMessageId: string | null;
        directedToUser: boolean;
      };
    };

export type WhatsAppEventHandler = (event: WhatsAppSessionEvent) => void | Promise<void>;

export interface WhatsAppConversationCatalogEntry {
  jid: string;
  name: string | null;
  isGroup: boolean;
  conversationTimestamp: string | null;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize<T>(value: string): T {
  return JSON.parse(value, BufferJSON.reviver) as T;
}

export async function createPersistentAuthenticationState(
  userId: string,
  repository: BaileysAuthRepository,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const storedCreds = await repository.get(userId, "auth", "creds");
  const creds = storedCreds ? deserialize<AuthenticationState["creds"]>(storedCreds) : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        await Promise.all(
          ids.map(async (id) => {
            const stored = await repository.get(userId, `key:${String(type)}`, id);
            if (!stored) return;
            const value = deserialize<SignalDataTypeMap[T]>(stored);
            if (type === "app-state-sync-key") {
              result[id] = proto.Message.AppStateSyncKeyData.fromObject(
                value as unknown as Record<string, unknown>,
              ) as unknown as SignalDataTypeMap[T];
              return;
            }
            result[id] = value;
          }),
        );
        return result;
      },
      set: async (data) => {
        const writes: Promise<void>[] = [];
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const entries = data[category];
          if (!entries) continue;
          for (const [id, value] of Object.entries(entries)) {
            writes.push(
              repository.set(
                userId,
                `key:${String(category)}`,
                id,
                value == null ? null : serialize(value),
              ),
            );
          }
        }
        await Promise.all(writes);
      },
    },
  };

  return {
    state,
    saveCreds: () => repository.set(userId, "auth", "creds", serialize(creds)),
  };
}

export function extractTextMessageContent(
  message: proto.IMessage | null | undefined,
): string | null {
  if (!message) return null;
  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption;
  const normalized = text?.trim();
  return normalized ? normalized : null;
}

function extractMessageContextInfo(message: proto.IMessage | null | undefined): proto.IContextInfo | null {
  if (!message) return null;
  return message.extendedTextMessage?.contextInfo
    ?? message.imageMessage?.contextInfo
    ?? message.videoMessage?.contextInfo
    ?? message.documentMessage?.contextInfo
    ?? null;
}

export function isWhatsAppMessageDirectedToUser(input: {
  isGroup: boolean;
  fromMe: boolean;
  mentionedJids: readonly string[];
  quotedParticipantJid: string | null;
  selfJids: readonly string[];
}): boolean {
  if (!input.isGroup || input.fromMe) return true;
  const self = new Set(input.selfJids.filter(Boolean).map((jid) => jidNormalizedUser(jid)));
  if (input.mentionedJids.some((jid) => self.has(jidNormalizedUser(jid)))) return true;
  return input.quotedParticipantJid !== null && self.has(jidNormalizedUser(input.quotedParticipantJid));
}

export function createQrDataUrl(qr: string): Promise<string> {
  return QRCode.toDataURL(qr, {
    type: "image/png",
    width: 320,
    margin: 2,
  });
}

/**
 * Uma conversa monitorável é sempre um GRUPO (`@g.us`) ou um chat DIRETO
 * (`@s.whatsapp.net`). Identidades `@lid` (participantes de grupo / modo
 * privacidade), `@newsletter`, `status@broadcast` e afins NÃO são conversas do
 * dono do número e não devem virar itens monitoráveis.
 */
export function isMonitorableChatJid(jid: string): boolean {
  return jid.endsWith("@g.us") || jid.endsWith("@s.whatsapp.net");
}

/**
 * Normaliza a agenda do Baileys (sync inicial do QR, contacts.upsert/update) em
 * pares {jid, name, saved}. `name` (agenda do dono do número) é o nome SALVO e
 * marca `saved=true` — ele deve ter prioridade e sobrescrever o pushName. Sem
 * nome salvo, cai no pushName (`notify`) e depois no nome verificado
 * (`verifiedName`), com `saved=false` (só preenche quando o chat está sem nome).
 * Descarta entradas sem id, sem nome ou não-monitoráveis.
 */
export function mapWhatsAppContactNames(
  rawContacts: readonly { id?: unknown; name?: unknown; notify?: unknown; verifiedName?: unknown }[],
): { jid: string; name: string; saved: boolean }[] {
  return rawContacts
    .filter((c) => typeof c.id === "string" && c.id)
    .map((c) => {
      const savedName = typeof c.name === "string" ? c.name.trim() : "";
      const fallbackName =
        (typeof c.notify === "string" && c.notify.trim()) ||
        (typeof c.verifiedName === "string" && c.verifiedName.trim()) ||
        "";
      return {
        jid: jidNormalizedUser(c.id as string),
        name: savedName || fallbackName,
        saved: Boolean(savedName),
      };
    })
    .filter((c) => c.name && isMonitorableChatJid(c.jid));
}

export function shouldProcessWhatsAppChat(
  chatJid: string,
  selfJid: string | null,
  selected: boolean,
): boolean {
  return selected || (selfJid !== null && jidNormalizedUser(chatJid) === jidNormalizedUser(selfJid));
}

function mapConversationCatalog(items: readonly unknown[]): WhatsAppConversationCatalogEntry[] {
  const mapped: WhatsAppConversationCatalogEntry[] = [];
  for (const raw of items) {
    const item = raw as {
      id?: unknown;
      name?: unknown;
      subject?: unknown;
      conversationTimestamp?: unknown;
    };
    if (typeof item.id !== "string" || !item.id) continue;
    const jid = jidNormalizedUser(item.id);
    if (!isMonitorableChatJid(jid)) continue;
    const timestamp = item.conversationTimestamp;
    mapped.push({
      jid,
      name:
        typeof item.name === "string"
          ? item.name
          : typeof item.subject === "string"
            ? item.subject
            : null,
      isGroup: jid.endsWith("@g.us"),
      conversationTimestamp:
        timestamp == null ? null : unixTimestampToIso(timestamp),
    });
  }
  return mapped;
}

export function mapContactCatalog(
  rawContacts: readonly { id?: unknown; name?: unknown; notify?: unknown }[],
): { jid: string; name: string }[] {
  return rawContacts
    .filter((contact) => typeof contact.id === "string" && contact.id)
    .map((contact) => ({
      jid: jidNormalizedUser(contact.id as string),
      name:
        (typeof contact.name === "string" && contact.name.trim()) ||
        (typeof contact.notify === "string" && contact.notify.trim()) ||
        "",
    }))
    .filter((contact) => contact.name);
}

function unixTimestampToIso(timestamp: unknown): string {
  const value = Number(timestamp ?? Math.floor(Date.now() / 1_000));
  return new Date(value * 1_000).toISOString();
}

function statusCode(error: unknown): number | null {
  const code = (error as { output?: { statusCode?: unknown } })?.output?.statusCode;
  return typeof code === "number" ? code : null;
}

export interface BaileysSessionManagerOptions {
  authRepository: BaileysAuthRepository;
  selectedChats: SelectedChatRepository;
  onEvent: WhatsAppEventHandler;
  /** Central sessions receive every direct text; personal sessions stay allow-listed. */
  acceptAllTextMessages?: boolean;
  /** Personal reader sessions explicitly disable all outbound sends. */
  allowSending?: boolean;
}

export interface BrazilianPhoneIdentity {
  digits: string;
  e164: string;
  jid: string;
  national: string;
  formatted: string;
}

/**
 * Normalizes either a Brazilian national number or a Baileys JID.
 * National inputs such as 66984396232 receive the default country code 55.
 */
export function normalizeBrazilianPhone(value: string): BrazilianPhoneIdentity | null {
  const localPart = value.trim().split("@")[0]?.split(":")[0] ?? "";
  const rawDigits = localPart.replace(/\D/g, "");
  const digits = rawDigits.length === 10 || rawDigits.length === 11
    ? `55${rawDigits}`
    : (rawDigits.length === 12 || rawDigits.length === 13) && rawDigits.startsWith("55")
      ? rawDigits
      : "";
  if (!/^55\d{10,11}$/.test(digits)) return null;
  const national = digits.slice(2);
  const areaCode = national.slice(0, 2);
  const subscriber = national.slice(2);
  const formattedSubscriber = subscriber.length === 9
    ? `${subscriber.slice(0, 5)}-${subscriber.slice(5)}`
    : `${subscriber.slice(0, 4)}-${subscriber.slice(4)}`;
  return {
    digits,
    e164: `+${digits}`,
    jid: `${digits}@s.whatsapp.net`,
    national,
    formatted: `+55 (${areaCode}) ${formattedSubscriber}`,
  };
}

export class BaileysSessionManager {
  private readonly sockets = new Map<string, WASocket>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly intentionalStops = new Set<string>();
  private readonly silentStops = new Set<string>();
  private readonly logger = pino({ level: "silent" });

  constructor(private readonly options: BaileysSessionManagerOptions) {}

  async start(userId: string): Promise<void> {
    if (this.sockets.has(userId)) return;
    this.intentionalStops.delete(userId);
    this.silentStops.delete(userId);
    const active = this.starting.get(userId);
    if (active) return active;
    const startPromise = this.open(userId).finally(() => this.starting.delete(userId));
    this.starting.set(userId, startPromise);
    return startPromise;
  }

  private async open(userId: string): Promise<void> {
    const previous = this.sockets.get(userId);
    previous?.end(undefined);

    const { state, saveCreds } = await createPersistentAuthenticationState(
      userId,
      this.options.authRepository,
    );
    const socket = makeWASocket({
      auth: state,
      logger: this.logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      // Names and subjects arrive in the initial history snapshot. Message bodies are
      // still filtered by the selected-chat allow-list before leaving this adapter.
      syncFullHistory: true,
      generateHighQualityLinkPreview: false,
    });
    this.sockets.set(userId, socket);

    socket.ev.on("creds.update", () => {
      void saveCreds().catch((error) => this.emitError(userId, error));
    });

    socket.ev.on("connection.update", (update) => {
      void (async () => {
        if (update.qr) {
          const dataUrl = await createQrDataUrl(update.qr);
          await this.options.onEvent({ type: "qr", userId, qr: update.qr, dataUrl });
        }
        if (update.connection === "open") {
          const selfJid = socket.user?.id ? jidNormalizedUser(socket.user.id) : null;
          if (!selfJid) throw new IntegrationError("WhatsApp connected without a self JID", true);
          await this.options.onEvent({
            type: "connected",
            userId,
            selfJid,
            displayName: socket.user?.name?.trim() || null,
          });
          // Completa a sincronização da agenda (app-state) para trazer os nomes
          // SALVOS dos contatos — o sync inicial costuma vir parcial, deixando
          // chats só com número/pushName. Uma vez por conexão, sem bloquear.
          setTimeout(() => {
            void socket
              .resyncAppState(
                ["critical_unblock_low", "critical_block", "regular_high", "regular_low", "regular"],
                false,
              )
              .catch((error) => this.emitError(userId, error));
          }, 2_500);
        }
        if (update.connection === "close") {
          if (this.intentionalStops.delete(userId)) {
            this.sockets.delete(userId);
            if (!this.silentStops.delete(userId)) {
              await this.options.onEvent({ type: "disconnected", userId, retrying: false });
            }
            return;
          }
          const loggedOut = statusCode(update.lastDisconnect?.error) === DisconnectReason.loggedOut;
          this.sockets.delete(userId);
          if (loggedOut) {
            await this.options.authRepository.clearUser(userId);
            await this.options.onEvent({ type: "logged_out", userId });
          } else {
            await this.options.onEvent({ type: "disconnected", userId, retrying: true });
            setTimeout(() => void this.start(userId).catch((error) => this.emitError(userId, error)), 2_000);
          }
        }
      })().catch((error) => this.emitError(userId, error));
    });

    const emitConversations = async (items: readonly unknown[]) => {
      const conversations = mapConversationCatalog(items);
      if (conversations.length > 0) {
        await this.options.onEvent({ type: "conversations", userId, conversations });
      }
    };

    const emitContacts = async (
      rawContacts: readonly { id?: unknown; name?: unknown; notify?: unknown; verifiedName?: unknown }[],
    ) => {
      const mapped = mapWhatsAppContactNames(rawContacts);
      if (mapped.length > 0) {
        await this.options.onEvent({ type: "contacts", userId, contacts: mapped });
      }
    };

    socket.ev.on("messaging-history.set", ({ chats, contacts }) => {
      // O sync inicial após o scan do QR traz a agenda inteira aqui (contacts).
      // Sem isto, os nomes só chegariam via contacts.upsert (mudanças futuras),
      // deixando os chats sem nome logo após conectar. Persistimos os chats antes
      // de aplicar os nomes: upsertContacts só ATUALIZA linhas de catálogo já
      // existentes, então a ordem importa (evita corrida insert/update).
      void (async () => {
        await emitConversations(chats);
        if (Array.isArray(contacts) && contacts.length > 0) {
          await emitContacts(contacts);
        }
      })().catch((error) => this.emitError(userId, error));
    });
    socket.ev.on("chats.upsert", (chats) => {
      void emitConversations(chats).catch((error) => this.emitError(userId, error));
    });
    socket.ev.on("chats.update", (chats) => {
      void emitConversations(chats).catch((error) => this.emitError(userId, error));
    });

    socket.ev.on("contacts.upsert", (contacts) => {
      void emitContacts(contacts).catch((error) => this.emitError(userId, error));
    });
    socket.ev.on("contacts.update", (contacts) => {
      void emitContacts(contacts).catch((error) => this.emitError(userId, error));
    });

    socket.ev.on("messages.upsert", ({ messages }) => {
      void (async () => {
        for (const item of messages) {
          const chatJid = item.key.remoteJid ? jidNormalizedUser(item.key.remoteJid) : null;
          const messageId = item.key.id;
          if (!chatJid || !messageId) continue;
          const selfJid = socket.user?.id ? jidNormalizedUser(socket.user.id) : null;
          const selected = this.options.acceptAllTextMessages === true
            || await this.options.selectedChats.isSelected(userId, chatJid);
          if (!shouldProcessWhatsAppChat(chatJid, selfJid, selected)) continue;
          const text = extractTextMessageContent(item.message);
          if (!text) continue;
          const senderJid = jidNormalizedUser(item.key.participant ?? chatJid);
          if (!senderJid) continue;
          const isGroup = chatJid.endsWith("@g.us");
          const contextInfo = extractMessageContextInfo(item.message);
          const mentionedJids = [...new Set(
            (contextInfo?.mentionedJid ?? [])
              .filter((jid): jid is string => typeof jid === "string" && jid.length > 0)
              .map((jid) => jidNormalizedUser(jid)),
          )];
          const quotedParticipantJid = typeof contextInfo?.participant === "string" && contextInfo.participant
            ? jidNormalizedUser(contextInfo.participant)
            : null;
          const quotedMessageId = typeof contextInfo?.stanzaId === "string" && contextInfo.stanzaId
            ? contextInfo.stanzaId
            : null;
          const socketIdentity = socket.user as (typeof socket.user & { lid?: string | null }) | undefined;
          const selfJids = [socketIdentity?.id, socketIdentity?.lid]
            .filter((jid): jid is string => typeof jid === "string" && jid.length > 0)
            .map((jid) => jidNormalizedUser(jid));
          await this.options.onEvent({
            type: "text_message",
            userId,
            message: {
              id: messageId,
              chatJid,
              senderJid,
              senderName: item.pushName?.trim() || null,
              sentAt: unixTimestampToIso(item.messageTimestamp),
              fromMe: item.key.fromMe === true,
              text,
              isGroup,
              mentionedJids,
              quotedParticipantJid,
              quotedMessageId,
              directedToUser: isWhatsAppMessageDirectedToUser({
                isGroup,
                fromMe: item.key.fromMe === true,
                mentionedJids,
                quotedParticipantJid,
                selfJids,
              }),
            },
          });
        }
      })().catch((error) => this.emitError(userId, error));
    });

    if (this.intentionalStops.has(userId)) socket.end(undefined);
  }

  private async emitError(userId: string, error: unknown): Promise<void> {
    await this.options.onEvent({
      type: "error",
      userId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  async stop(userId: string): Promise<void> {
    this.intentionalStops.add(userId);
    const socket = this.sockets.get(userId);
    if (!socket) return;
    socket.end(undefined);
    this.sockets.delete(userId);
  }

  async suspend(userId: string): Promise<void> {
    this.intentionalStops.add(userId);
    this.silentStops.add(userId);
    const socket = this.sockets.get(userId);
    if (!socket) return;
    socket.end(undefined);
    this.sockets.delete(userId);
  }

  hasSession(userId: string): boolean {
    return this.sockets.has(userId) || this.starting.has(userId);
  }

  listSessionUserIds(): string[] {
    return [...new Set([...this.sockets.keys(), ...this.starting.keys()])];
  }

  async logout(userId: string): Promise<void> {
    const socket = this.sockets.get(userId);
    if (socket) await socket.logout();
    await this.options.authRepository.clearUser(userId);
    this.sockets.delete(userId);
  }

  getSelfJid(userId: string): string {
    const socket = this.sockets.get(userId);
    const selfJid = socket?.user?.id ? jidNormalizedUser(socket.user.id) : null;
    if (!selfJid) throw new IntegrationError("WhatsApp session is not connected", true);
    return selfJid;
  }

  async sendText(userId: string, destinationJid: string, text: string): Promise<string> {
    if (this.options.allowSending === false) {
      throw new IntegrationError("Outbound sending is disabled for this WhatsApp session", false);
    }
    const socket = this.sockets.get(userId);
    if (!socket) throw new IntegrationError("WhatsApp session is not connected", true);
    const sent = await socket.sendMessage(jidNormalizedUser(destinationJid), { text });
    if (!sent?.key.id) throw new IntegrationError("WhatsApp did not return a message ID", true);
    return sent.key.id;
  }

  sendSelf(userId: string, text: string): Promise<string> {
    return this.sendText(userId, this.getSelfJid(userId), text);
  }
}

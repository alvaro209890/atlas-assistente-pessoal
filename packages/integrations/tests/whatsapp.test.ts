import { describe, expect, it } from "vitest";

import {
  createPersistentAuthenticationState,
  createQrDataUrl,
  extractTextMessageContent,
  isMonitorableChatJid,
  mapWhatsAppContactNames,
  normalizeBrazilianPhone,
  shouldProcessWhatsAppChat,
  type BaileysAuthRepository,
} from "../src/index.js";

class MemoryAuthRepository implements BaileysAuthRepository {
  readonly records = new Map<string, string>();

  get(userId: string, category: string, key: string): Promise<string | null> {
    return Promise.resolve(this.records.get(`${userId}:${category}:${key}`) ?? null);
  }

  set(userId: string, category: string, key: string, value: string | null): Promise<void> {
    const recordKey = `${userId}:${category}:${key}`;
    if (value === null) this.records.delete(recordKey);
    else this.records.set(recordKey, value);
    return Promise.resolve();
  }

  clearUser(userId: string): Promise<void> {
    for (const key of this.records.keys()) if (key.startsWith(`${userId}:`)) this.records.delete(key);
    return Promise.resolve();
  }
}

describe("WhatsApp integration", () => {
  it("extracts text and captions without downloading media", () => {
    expect(extractTextMessageContent({ conversation: " texto " })).toBe("texto");
    expect(extractTextMessageContent({ imageMessage: { caption: "foto da obra" } })).toBe(
      "foto da obra",
    );
    expect(extractTextMessageContent({ videoMessage: { caption: "vistoria" } })).toBe("vistoria");
    expect(extractTextMessageContent({ documentMessage: { caption: "contrato" } })).toBe(
      "contrato",
    );
    expect(extractTextMessageContent({ imageMessage: {} })).toBeNull();
  });

  it("generates a frontend-ready PNG data URL for pairing", async () => {
    await expect(createQrDataUrl("pairing-payload")).resolves.toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("persists credentials through the repository adapter", async () => {
    const repository = new MemoryAuthRepository();
    const first = await createPersistentAuthenticationState("user-1", repository);
    first.state.creds.registered = true;
    await first.saveCreds();
    const second = await createPersistentAuthenticationState("user-1", repository);
    expect(second.state.creds.registered).toBe(true);
  });

  it("accepts the self chat as a command channel even when it is not monitored", () => {
    expect(shouldProcessWhatsAppChat("5511999@s.whatsapp.net", "5511999:12@s.whatsapp.net", false)).toBe(true);
    expect(shouldProcessWhatsAppChat("group@g.us", "5511999@s.whatsapp.net", false)).toBe(false);
    expect(shouldProcessWhatsAppChat("selected@g.us", "5511999@s.whatsapp.net", true)).toBe(true);
  });

  it("só considera grupos e chats diretos como monitoráveis (exclui @lid e afins)", () => {
    expect(isMonitorableChatJid("120363000000000000@g.us")).toBe(true);
    expect(isMonitorableChatJid("556684396232@s.whatsapp.net")).toBe(true);
    expect(isMonitorableChatJid("216737052123240@lid")).toBe(false);
    expect(isMonitorableChatJid("status@broadcast")).toBe(false);
    expect(isMonitorableChatJid("123@newsletter")).toBe(false);
  });

  it("descarta contatos @lid ao mapear nomes da agenda", () => {
    const mapped = mapWhatsAppContactNames([
      { id: "556684396232@s.whatsapp.net", name: "Cliente Direto" },
      { id: "216737052123240@lid", name: "Participante de grupo" },
    ]);
    expect(mapped).toEqual([{ jid: "556684396232@s.whatsapp.net", name: "Cliente Direto" }]);
  });

  it("mapeia a agenda do QR em nomes de chat (nome salvo > pushName > verificado)", () => {
    const mapped = mapWhatsAppContactNames([
      { id: "5566984396232@s.whatsapp.net", name: "  João Obra  ", notify: "Joãozinho" },
      { id: "5511988887777@s.whatsapp.net", notify: "  Maria  " },
      { id: "5511911112222@s.whatsapp.net", verifiedName: "Loja Oficial" },
      { id: "5511900000000@s.whatsapp.net" }, // sem nome nenhum -> descartado
      { name: "Sem id" }, // sem id -> descartado
    ]);
    expect(mapped).toEqual([
      { jid: "5566984396232@s.whatsapp.net", name: "João Obra" },
      { jid: "5511988887777@s.whatsapp.net", name: "Maria" },
      { jid: "5511911112222@s.whatsapp.net", name: "Loja Oficial" },
    ]);
  });

  it("adds Brazil country code 55 to national phone numbers and accepts Baileys JIDs", () => {
    expect(normalizeBrazilianPhone("66984396232")).toMatchObject({
      digits: "5566984396232",
      e164: "+5566984396232",
      jid: "5566984396232@s.whatsapp.net",
      formatted: "+55 (66) 98439-6232",
    });
    expect(normalizeBrazilianPhone("5566984396232:17@s.whatsapp.net")?.national).toBe("66984396232");
    expect(normalizeBrazilianPhone("123")).toBeNull();
  });
});

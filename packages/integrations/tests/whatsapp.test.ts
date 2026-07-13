import { describe, expect, it } from "vitest";

import {
  createPersistentAuthenticationState,
  createQrDataUrl,
  extractTextMessageContent,
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
});

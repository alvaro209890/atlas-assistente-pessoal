import { describe, expect, it } from "vitest";

import { buildAiContext, serializeAiContext, type NormalizedMessage } from "../src/index.js";

const message = (id: string, fromMe = false, text = id): NormalizedMessage => ({
  id,
  userId: "u1",
  chatJid: "chat",
  senderJid: fromMe ? "self" : "other",
  senderName: null,
  sentAt: `2026-07-13T12:00:${id.padStart(2, "0")}-03:00`,
  fromMe,
  text,
});

describe("buildAiContext", () => {
  it("keeps recent messages in chronological order and enforces limits", () => {
    const context = buildAiContext({
      now: new Date("2026-07-13T15:00:00Z"),
      chatJid: "chat",
      messages: [message("03"), message("01"), message("02")],
      maxRecentMessages: 2,
    });
    expect(context.messages.map((item) => item.id)).toEqual(["02", "03"]);
  });

  it("inclui as mensagens do próprio dono como contexto (ambos os lados do diálogo)", () => {
    const context = buildAiContext({
      now: new Date("2026-07-13T15:00:00Z"),
      chatJid: "chat",
      messages: [
        message("01", true, "te envio o contrato amanhã"),
        message("02", true, "TRELLO: criar o card"),
        message("03", false, "pedido recebido"),
      ],
    });
    expect(context.messages.map((item) => item.id)).toEqual(["01", "02", "03"]);
    expect(context.messages.filter((item) => item.fromMe)).toHaveLength(2);
  });

  it("carries recent user corrections into the serialized prompt context", () => {
    const context = buildAiContext({
      now: new Date("2026-07-13T15:00:00Z"),
      chatJid: "chat",
      messages: [message("01")],
      corrections: [
        {
          action: "not_task",
          comment: "Conversas sobre futebol não são tarefas",
          metadata: { topic: "futebol" },
          createdAt: "2026-07-13T14:00:00Z",
        },
      ],
    });
    const serialized = JSON.parse(serializeAiContext(context)) as {
      previous_corrections: Array<{ action: string; metadata: { topic: string } }>;
    };
    expect(serialized.previous_corrections[0]).toMatchObject({
      action: "not_task",
      metadata: { topic: "futebol" },
    });
  });
});

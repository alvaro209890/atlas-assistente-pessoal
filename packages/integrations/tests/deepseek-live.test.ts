import { describe, expect, it } from "vitest";

import {
  buildAiContext,
  PORTUGUESE_AI_EVALUATION_CORPUS,
  scoreAiEvaluation,
  type AiEvaluationPrediction,
  type NormalizedMessage,
} from "@atlas/shared";

import { DeepSeekDecisionClient } from "../src/index.js";

const live = process.env.RUN_LIVE_AI_TESTS === "1";

describe.skipIf(!live)("DeepSeek V4 Flash live Portuguese evaluator", () => {
  it(
    "reaches 90% explicit-task recall with at most 10% false positives",
    async () => {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required when RUN_LIVE_AI_TESTS=1");
      const client = new DeepSeekDecisionClient({ apiKey });
      const predictions: AiEvaluationPrediction[] = [];
      for (const item of PORTUGUESE_AI_EVALUATION_CORPUS) {
        const message: NormalizedMessage = {
          id: item.id,
          userId: "00000000-0000-0000-0000-000000000001",
          chatJid: "551199999999@s.whatsapp.net",
          senderJid: "551188888888@s.whatsapp.net",
          senderName: "Contato",
          sentAt: "2026-07-13T12:00:00-03:00",
          fromMe: false,
          text: item.text,
        };
        const result = await client.decide(
          buildAiContext({ now: new Date("2026-07-13T15:00:00Z"), chatJid: message.chatJid, messages: [message] }),
        );
        predictions.push({
          caseId: item.id,
          predictedTask: result.decision.tasks.some(
            (task) => task.operation !== "ignore" && task.confidence >= 0.7,
          ),
        });
      }
      const metrics = scoreAiEvaluation(PORTUGUESE_AI_EVALUATION_CORPUS, predictions);
      expect(metrics.explicitTaskRecall).toBeGreaterThanOrEqual(0.9);
      expect(metrics.falsePositiveRate).toBeLessThanOrEqual(0.1);
    },
    15 * 60 * 1_000,
  );
});

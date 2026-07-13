import { describe, expect, it } from "vitest";

import {
  conservativePortugueseTaskHeuristic,
  PORTUGUESE_AI_EVALUATION_CORPUS,
  scoreAiEvaluation,
} from "../src/index.js";

describe("Portuguese AI evaluator", () => {
  it("contains at least 50 realistic labeled messages", () => {
    expect(PORTUGUESE_AI_EVALUATION_CORPUS.length).toBeGreaterThanOrEqual(100);
    expect(PORTUGUESE_AI_EVALUATION_CORPUS.some((item) => item.explicitTask)).toBe(true);
    expect(PORTUGUESE_AI_EVALUATION_CORPUS.some((item) => !item.explicitTask)).toBe(true);
  });

  it("meets the 90% explicit-task and 10% false-positive offline gate", () => {
    const predictions = PORTUGUESE_AI_EVALUATION_CORPUS.map((item) => ({
      caseId: item.id,
      predictedTask: conservativePortugueseTaskHeuristic(item.text),
    }));
    const metrics = scoreAiEvaluation(PORTUGUESE_AI_EVALUATION_CORPUS, predictions);
    expect(metrics.explicitTaskRecall).toBeGreaterThanOrEqual(0.9);
    expect(metrics.falsePositiveRate).toBeLessThanOrEqual(0.1);
    expect(metrics.passed).toBe(true);
  });
});

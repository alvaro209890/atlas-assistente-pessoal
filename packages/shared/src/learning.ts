import {
  INFERRED_LEARNING_CONFIDENCE_THRESHOLD,
  INFERRED_LEARNING_MIN_DISTINCT_DAYS,
  INFERRED_LEARNING_MIN_EVIDENCE,
  INFERRED_LEARNING_STALE_DAYS,
} from "./constants.js";

export interface LearningEvidenceSignal {
  id: string;
  occurredAt: string;
  confidence: number;
}

export interface LearningPromotionInput {
  explicitInstruction: boolean;
  risk: "low" | "high";
  confidence: number;
  evidence: readonly LearningEvidenceSignal[];
}

export function shouldActivateLearning(input: LearningPromotionInput): boolean {
  if (input.explicitInstruction) return true;
  if (input.risk !== "low" || input.confidence < INFERRED_LEARNING_CONFIDENCE_THRESHOLD) return false;
  const uniqueEvidence = new Map(input.evidence.map((item) => [item.id, item]));
  const days = new Set(
    [...uniqueEvidence.values()]
      .filter((item) => item.confidence >= INFERRED_LEARNING_CONFIDENCE_THRESHOLD)
      .map((item) => item.occurredAt.slice(0, 10)),
  );
  return uniqueEvidence.size >= INFERRED_LEARNING_MIN_EVIDENCE && days.size >= INFERRED_LEARNING_MIN_DISTINCT_DAYS;
}

export function isInferredLearningStale(lastConfirmedAt: string, now = new Date()): boolean {
  const age = now.getTime() - new Date(lastConfirmedAt).getTime();
  return age >= INFERRED_LEARNING_STALE_DAYS * 24 * 60 * 60 * 1_000;
}

export interface AtlasPersonalization {
  preferredName: string;
  professionalArea: string | null;
  goals: readonly string[];
  workDays: readonly number[];
  workStart: string;
  workEnd: string;
  communicationStyle: string;
  customInstructions: string;
}

export function composeAtlasPersonalization(input: AtlasPersonalization): {
  replyTone: string;
  customInstructions: string;
} {
  const style: Record<string, string> = {
    concise: "direto e conciso",
    balanced: "claro, calmo e equilibrado",
    detailed: "detalhado e organizado",
    encouraging: "acolhedor, encorajador e objetivo",
  };
  const facts = [
    `Nome preferido confirmado do usuário: ${input.preferredName}.`,
    input.professionalArea ? `Área de atuação: ${input.professionalArea}.` : null,
    input.goals.length ? `Objetivos declarados: ${input.goals.join("; ")}.` : null,
    `Dias de trabalho: ${input.workDays.join(", ")}; horário: ${input.workStart}–${input.workEnd}.`,
    input.customInstructions.trim() || null,
  ].filter((line): line is string => line !== null);
  return {
    replyTone: style[input.communicationStyle] ?? style.balanced!,
    customInstructions: facts.join("\n"),
  };
}

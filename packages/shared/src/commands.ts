export type AtlasSelfCommandKind =
  | "complete"
  | "snooze"
  | "reschedule"
  | "silence"
  | "open"
  | "explain";

export interface AtlasSelfCommand {
  kind: AtlasSelfCommandKind;
  raw: string;
  reference: string | null;
  durationMinutes: number | null;
  localTime: string | null;
}

const normalize = (value: string) =>
  value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLocaleLowerCase("pt-BR");

export function parseAtlasSelfCommand(text: string): AtlasSelfCommand | null {
  const raw = text.trim();
  const value = normalize(raw).replace(/^atlas[:,]?\s*/, "");
  const taskStatusComplete = value.match(/^(?:a\s+)?tarefa\s+(.+?)\s+(?:esta|ta|foi)\s+(?:concluida?|finalizada?|pronta?)$/);
  if (taskStatusComplete) {
    return { kind: "complete", raw, reference: taskStatusComplete[1]?.trim() ?? null, durationMinutes: null, localTime: null };
  }
  const markComplete = value.match(/^(?:marque|marca)\s+(?:a\s+tarefa\s+)?(.+?)\s+como\s+(?:concluida?|finalizada?|pronta?)$/);
  if (markComplete) {
    return { kind: "complete", raw, reference: markComplete[1]?.trim() ?? null, durationMinutes: null, localTime: null };
  }
  const imperativeComplete = value.match(/^(?:conclua|complete|finalize)\s+(?:a\s+tarefa\s+)?(.+)$/);
  if (imperativeComplete) {
    return { kind: "complete", raw, reference: imperativeComplete[1]?.trim() ?? null, durationMinutes: null, localTime: null };
  }
  const complete = value.match(/^(?:feito|conclui(?:do)?|finalizei|terminei)(?:\s+(.+))?$/);
  if (complete) return { kind: "complete", raw, reference: complete[1]?.trim() ?? null, durationMinutes: null, localTime: null };

  const snooze = value.match(/^(?:adiar|lembre(?:-me)?\s+depois|soneca)(?:\s+(?:por\s+)?)?(\d+)\s*(m|min|minutos?|h|horas?)(?:\s+(.+))?$/);
  if (snooze) {
    const amount = Number(snooze[1]);
    const durationMinutes = snooze[2]?.startsWith("h") ? amount * 60 : amount;
    return { kind: "snooze", raw, reference: snooze[3]?.trim() ?? null, durationMinutes, localTime: null };
  }

  const tomorrow = value.match(/^(?:amanha)(?:\s+as)?\s+(\d{1,2})(?::(\d{2}))?(?:\s+(.+))?$/);
  if (tomorrow) {
    const hour = Number(tomorrow[1]);
    const minute = Number(tomorrow[2] ?? 0);
    if (hour <= 23 && minute <= 59) {
      return { kind: "reschedule", raw, reference: tomorrow[3]?.trim() ?? null, durationMinutes: null, localTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
    }
  }

  const silence = value.match(/^(?:silenciar|silencio|nao me lembre)(?:\s+(.+))?$/);
  if (silence) return { kind: "silence", raw, reference: silence[1]?.trim() ?? null, durationMinutes: null, localTime: null };
  const open = value.match(/^(?:abrir|abra|mostre)(?:\s+(.+))?$/);
  if (open) return { kind: "open", raw, reference: open[1]?.trim() ?? null, durationMinutes: null, localTime: null };
  const explain = value.match(/^(?:por que|porque|explique)(?:\s+(.+))?\??$/);
  if (explain) return { kind: "explain", raw, reference: explain[1]?.trim() ?? null, durationMinutes: null, localTime: null };
  return null;
}

export interface AtlasSelfCommandEvaluationCase {
  id: string;
  text: string;
  expectedKind: AtlasSelfCommandKind;
}

export const ATLAS_SELF_COMMAND_EVALUATION_CORPUS: readonly AtlasSelfCommandEvaluationCase[] = [
  { id: "complete-01", text: "feito", expectedKind: "complete" },
  { id: "complete-02", text: "concluído relatório mensal", expectedKind: "complete" },
  { id: "complete-03", text: "finalizei proposta Aurora", expectedKind: "complete" },
  { id: "complete-04", text: "Atlas: feito contrato", expectedKind: "complete" },
  { id: "complete-05", text: "a tarefa relatório mensal tá concluída", expectedKind: "complete" },
  { id: "complete-06", text: "marque proposta Aurora como concluída", expectedKind: "complete" },
  { id: "complete-07", text: "conclua a tarefa orçamento da Ana", expectedKind: "complete" },
  { id: "complete-08", text: "terminei vistoria da fazenda", expectedKind: "complete" },
  { id: "snooze-01", text: "adiar 1h", expectedKind: "snooze" },
  { id: "snooze-02", text: "adiar por 30 minutos orçamento", expectedKind: "snooze" },
  { id: "snooze-03", text: "lembre-me depois 2 horas vistoria", expectedKind: "snooze" },
  { id: "snooze-04", text: "soneca 15m", expectedKind: "snooze" },
  { id: "reschedule-01", text: "amanhã às 9", expectedKind: "reschedule" },
  { id: "reschedule-02", text: "amanhã 14:30 reunião", expectedKind: "reschedule" },
  { id: "reschedule-03", text: "Atlas, amanhã às 8 retorno", expectedKind: "reschedule" },
  { id: "silence-01", text: "silenciar", expectedKind: "silence" },
  { id: "silence-02", text: "silêncio contrato", expectedKind: "silence" },
  { id: "silence-03", text: "não me lembre reunião", expectedKind: "silence" },
  { id: "open-01", text: "abrir tarefa da Ana", expectedKind: "open" },
  { id: "open-02", text: "abra orçamento", expectedKind: "open" },
  { id: "open-03", text: "mostre projeto Aurora", expectedKind: "open" },
  { id: "explain-01", text: "por quê tarefa urgente?", expectedKind: "explain" },
  { id: "explain-02", text: "porque isso é prioridade?", expectedKind: "explain" },
  { id: "explain-03", text: "explique prazo do contrato", expectedKind: "explain" },
] as const;

export function scoreAtlasSelfCommands(corpus = ATLAS_SELF_COMMAND_EVALUATION_CORPUS) {
  const resolved = corpus.filter((item) => parseAtlasSelfCommand(item.text)?.kind === item.expectedKind).length;
  return {
    total: corpus.length,
    resolved,
    resolutionRate: corpus.length ? resolved / corpus.length : 1,
    passed: corpus.length > 0 && resolved / corpus.length >= 0.95,
  };
}

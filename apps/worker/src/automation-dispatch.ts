export type UserAutomationKind =
  | "briefing"
  | "deadline"
  | "overdue"
  | "follow_up"
  | "stale_task"
  | "weekly_review";

const titles: Record<UserAutomationKind, string> = {
  briefing: "Briefing do Atlas",
  deadline: "Prazos próximos",
  overdue: "Itens vencidos",
  follow_up: "Follow-ups pendentes",
  stale_task: "Tarefas paradas",
  weekly_review: "Revisão semanal",
};

export function isUserAutomationKind(value: string): value is UserAutomationKind {
  return value in titles;
}

export function composeAutomationNotification(
  kind: UserAutomationKind,
  items: readonly string[],
): { title: string; body: string } {
  const clean = [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  const empty: Record<UserAutomationKind, string> = {
    briefing: "Nada urgente agora. Seu dia está organizado.",
    deadline: "Nenhum prazo nas próximas 24 horas.",
    overdue: "Nenhum item vencido.",
    follow_up: "Nenhum follow-up pendente.",
    stale_task: "Nenhuma tarefa parada há mais de 7 dias.",
    weekly_review: "Sem alterações relevantes nesta semana.",
  };
  return {
    title: titles[kind],
    body: clean.length ? clean.slice(0, 20).map((item) => `• ${item}`).join("\n") : empty[kind],
  };
}

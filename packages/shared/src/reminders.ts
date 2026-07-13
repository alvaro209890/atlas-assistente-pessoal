export interface QuietHours {
  start: string;
  end: string;
}

function minutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid HH:mm value: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid HH:mm value: ${value}`);
  return hour * 60 + minute;
}

export function isWithinQuietHours(localTime: string, quiet: QuietHours): boolean {
  const current = minutes(localTime);
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function defaultReminderOffsetsMinutes(priority: "low" | "normal" | "high" | "urgent"): number[] {
  return priority === "urgent" ? [24 * 60, 2 * 60] : [2 * 60];
}

export function consolidateCatchUpTitles(titles: readonly string[], maximum = 8): string {
  const unique = [...new Set(titles.map((title) => title.trim()).filter(Boolean))];
  const visible = unique.slice(0, maximum).map((title) => `• ${title}`);
  const remaining = unique.length - visible.length;
  return `${visible.join("\n")}${remaining > 0 ? `\n• e mais ${remaining}` : ""}`;
}

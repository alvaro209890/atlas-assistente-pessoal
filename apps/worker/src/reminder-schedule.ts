export interface ReminderRecurrence {
  nextAt?: unknown;
  intervalMinutes?: unknown;
  every?: unknown;
  unit?: unknown;
  frequency?: unknown;
  time?: unknown;
  rule?: unknown;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = localParts(date, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
}

function localDateTimeToUtc(parts: LocalParts, timezone: string): Date {
  const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), timezone));
  candidate = new Date(wallClock - timezoneOffsetMs(candidate, timezone));
  return candidate;
}

function calendarAdvance(after: Date, timezone: string, days: number, time?: string): Date {
  const parts = localParts(after, timezone);
  const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second));
  const advanced: LocalParts = {
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: 0,
  };
  const match = typeof time === "string" ? /^(\d{2}):(\d{2})$/.exec(time) : null;
  if (match) {
    advanced.hour = Number(match[1]);
    advanced.minute = Number(match[2]);
  }
  return localDateTimeToUtc(advanced, timezone);
}

function ruleTime(rule: string): string | undefined {
  const match = /(?:as|a)\s+(\d{1,2})(?::(\d{2}))?/.exec(rule);
  if (!match) return undefined;
  const hour = Math.min(Number(match[1]), 23);
  const minute = Math.min(Number(match[2] ?? 0), 59);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function nextLocalTime(after: Date, timezone: string, time: string, minimumDays = 0): Date {
  let candidate = calendarAdvance(after, timezone, minimumDays, time);
  if (candidate.getTime() <= after.getTime()) candidate = calendarAdvance(after, timezone, minimumDays + 1, time);
  return candidate;
}

function materializePortugueseRule(ruleValue: string, after: Date, timezone: string): Date | null {
  const rule = ruleValue.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR").trim();
  if (!rule) return null;
  const time = ruleTime(rule);
  const interval = /a cada\s+(\d+)\s*(minuto|hora|dia|semana)s?/.exec(rule);
  if (interval) {
    const every = Math.min(Math.max(Number(interval[1]), 1), 525_600);
    if (interval[2] === "minuto") return new Date(after.getTime() + every * 60_000);
    if (interval[2] === "hora") return new Date(after.getTime() + every * 3_600_000);
    if (interval[2] === "dia") return calendarAdvance(after, timezone, every, time);
    return calendarAdvance(after, timezone, every * 7, time);
  }
  if (/\b(diari[oa]|diariamente|todo dia|todos os dias)\b/.test(rule)) {
    return time ? nextLocalTime(after, timezone, time) : calendarAdvance(after, timezone, 1);
  }
  const weekdays: Record<string, number> = {
    domingo: 0, segunda: 1, "segunda-feira": 1, terca: 2, "terca-feira": 2,
    quarta: 3, "quarta-feira": 3, quinta: 4, "quinta-feira": 4,
    sexta: 5, "sexta-feira": 5, sabado: 6,
  };
  const weekday = Object.entries(weekdays).find(([name]) => new RegExp(`\\b${name}\\b`).test(rule));
  if (weekday) {
    const parts = localParts(after, timezone);
    const currentWeekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    let days = (weekday[1] - currentWeekday + 7) % 7;
    const desiredTime = time ?? `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
    let candidate = calendarAdvance(after, timezone, days, desiredTime);
    if (candidate.getTime() <= after.getTime()) {
      days += 7;
      candidate = calendarAdvance(after, timezone, days, desiredTime);
    }
    return candidate;
  }
  if (/\b(semanal|toda semana|todas as semanas)\b/.test(rule)) {
    return calendarAdvance(after, timezone, 7, time);
  }
  return null;
}

export function materializeNextReminderOccurrence(
  recurrence: ReminderRecurrence,
  after: Date,
  timezone: string,
): Date | null {
  const nextAt = typeof recurrence.nextAt === "string" ? new Date(recurrence.nextAt) : null;
  if (nextAt && Number.isFinite(nextAt.getTime()) && nextAt.getTime() > after.getTime()) return nextAt;

  const intervalMinutes = typeof recurrence.intervalMinutes === "number" && Number.isFinite(recurrence.intervalMinutes)
    ? Math.min(Math.max(recurrence.intervalMinutes, 0), 525_600)
    : 0;
  if (intervalMinutes > 0) return new Date(after.getTime() + intervalMinutes * 60_000);

  const every = typeof recurrence.every === "number" && Number.isFinite(recurrence.every)
    ? Math.min(Math.max(Math.trunc(recurrence.every), 1), 365)
    : 1;
  if (recurrence.unit === "minute") return new Date(after.getTime() + every * 60_000);
  if (recurrence.unit === "hour") return new Date(after.getTime() + every * 3_600_000);
  if (recurrence.unit === "week" || recurrence.frequency === "weekly") {
    return calendarAdvance(after, timezone, every * 7, typeof recurrence.time === "string" ? recurrence.time : undefined);
  }
  if (recurrence.unit === "day" || recurrence.frequency === "daily") {
    return calendarAdvance(after, timezone, every, typeof recurrence.time === "string" ? recurrence.time : undefined);
  }
  if (typeof recurrence.rule === "string") {
    return materializePortugueseRule(recurrence.rule, after, timezone);
  }
  return null;
}

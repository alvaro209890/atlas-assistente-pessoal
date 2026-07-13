import { CronExpressionParser } from "cron-parser";

export function nextAutomationRun(
  schedule: string,
  timezone: string,
  after: Date,
): Date {
  if (!schedule.trim()) throw new Error("Automation schedule cannot be blank");
  const next = CronExpressionParser.parse(schedule, {
    currentDate: after,
    tz: timezone,
  }).next().toDate();
  if (!Number.isFinite(next.getTime()) || next.getTime() <= after.getTime()) {
    throw new Error("Automation schedule did not produce a future occurrence");
  }
  return next;
}

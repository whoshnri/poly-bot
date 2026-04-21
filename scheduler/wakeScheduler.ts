import type { ScheduleWakeOnceResult } from "../types/scheduler";
import { compileTradingGraph } from "../ai";

/**
 * Schedules a one-shot wake cron task for a future datetime.
 */
export function scheduleWakeOnce(
  wakeAt: Date, sessionId : string | null
): ScheduleWakeOnceResult {
  const wakeEpoch = wakeAt.getTime();

  if (!Number.isFinite(wakeEpoch)) {
    throw new Error("Invalid datetime provided.");
  }

  const nowEpoch = Date.now();
  const delayMs = wakeEpoch - nowEpoch;

  if (delayMs <= 0) {
    throw new Error("Wake datetime must be in the future.");
  }
 
  const cronExpression = [
    wakeAt.getUTCMinutes(),
    wakeAt.getUTCHours(),
    wakeAt.getUTCDate(),
    wakeAt.getUTCMonth() + 1,
    "*",
  ].join(" ");

  const cronTask = Bun.cron(cronExpression, () => {
    if (Date.now() < wakeEpoch) {
      return;
    }

    // compile the graph
    sessionId ? compileTradingGraph({sessionId : sessionId}) : compileTradingGraph()
    console.log(`AI restart triggered at ${wakeAt.toLocaleDateString()}`)

    cronTask.stop();
  });

  return { delayMs, cronExpression };
}

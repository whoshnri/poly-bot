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

    const { invoke } = sessionId
      ? compileTradingGraph({ sessionId })
      : compileTradingGraph();

    invoke()
      .then(() => {
        console.log(`[wake] Graph execution completed for session=${sessionId ?? "new"} at ${wakeAt.toISOString()}`);
      })
      .catch((err: unknown) => {
        console.error(
          `[wake] Graph execution failed for session=${sessionId ?? "new"} at ${wakeAt.toISOString()}:`,
          err instanceof Error ? err.message : err,
        );
      });

    cronTask.stop();
  });

  return { delayMs, cronExpression };
}

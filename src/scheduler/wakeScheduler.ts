export function scheduleWakeOnce(
  wakeAt: Date,
): { delayMs: number; cronExpression: string } {
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

    console.log(`[wake] triggered at ${new Date().toISOString()}`);
    cronTask.stop();
  });

  return { delayMs, cronExpression };
}

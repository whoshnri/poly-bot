import type { Context } from "hono";
import { Hono } from "hono";
import type { WakeRequestBody } from "../types/server";
import { scheduleWakeOnce } from "../scheduler/wakeScheduler";

const app = new Hono();

/**
 * Returns service health metadata.
 */
function getHealth(c: Context) {
  return c.json({
    status: "ok",
    now: new Date().toISOString(),
  });
}

/**
 * Schedules one wake event at the requested datetime.
 */
async function scheduleWake(c: Context) {
  const body = (await c.req.json()) as Partial<WakeRequestBody>;
  const datetime = body.datetime;

  if (!datetime) {
    return c.json({ error: "Missing 'datetime' in request body." }, 400);
  }

  const wakeAt = new Date(datetime);

  try {
    const { delayMs, cronExpression } = scheduleWakeOnce(wakeAt, '');

    return c.json({
      scheduled: true,
      runAt: wakeAt.toISOString(),
      delayMs,
      cronExpression,
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to schedule wake.",
      },
      400,
    );
  }
}

app.get("/health", getHealth);
app.post("/wake", scheduleWake);

export default app;

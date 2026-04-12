import { Hono } from "hono";
import { scheduleWakeOnce } from "./scheduler/wakeScheduler";

type WakeRequestBody = {
  datetime: string;
};

const app = new Hono();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    now: new Date().toISOString(),
  });
});

app.post("/wake", async (c) => {
  const body = (await c.req.json()) as Partial<WakeRequestBody>;
  const datetime = body.datetime;

  if (!datetime) {
    return c.json({ error: "Missing 'datetime' in request body." }, 400);
  }

  const wakeAt = new Date(datetime);

  try {
    const { delayMs, cronExpression } = scheduleWakeOnce(wakeAt);

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
});

export default app;

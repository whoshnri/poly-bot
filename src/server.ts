import type { Context } from "hono";
import { Hono } from "hono";
import type { WakeRequestBody } from "../types/server";
import { scheduleWakeOnce } from "../scheduler/wakeScheduler";
import { compileTradingGraph } from "../ai";
import { createNewTask } from "../actions/db";

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
 * Verifies the request carries a valid WAKE_API_TOKEN bearer token.
 * When WAKE_API_TOKEN is not set in env, all requests are allowed (dev mode).
 */
function verifyWakeToken(c: Context): boolean {
  const expected = process.env.WAKE_API_TOKEN;
  if (!expected) {
    return true;
  }

  const authHeader = c.req.header("Authorization");
  return authHeader === `Bearer ${expected}`;
}

/**
 * Schedules one wake event at the requested datetime.
 */
async function scheduleWake(c: Context) {
  if (!verifyWakeToken(c)) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  const body = (await c.req.json()) as Partial<WakeRequestBody>;
  const datetime = body.datetime;
  const sessionId = body.sessionId ?? "";

  if (!datetime) {
    return c.json({ error: "Missing 'datetime' in request body." }, 400);
  }

  const wakeAt = new Date(datetime);

  try {
    const { delayMs, cronExpression } = scheduleWakeOnce(wakeAt, sessionId);

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

/**
 * Creates a new autonomous trading session and triggers the first graph run.
 */
async function startSession(c: Context) {
  const session = await createNewTask({
    name: `Autonomous session ${new Date().toISOString()}`,
    metadata: { targetToken: null },
  });

  const { invoke } = compileTradingGraph({ sessionId: session.id, forceInitPath: true });
  invoke()
    .then(() => {
      console.log(`[session-start] Initial graph run completed for session=${session.id}`);
    })
    .catch((err: unknown) => {
      console.error(
        `[session-start] Initial graph run failed for session=${session.id}:`,
        err instanceof Error ? err.message : err,
      );
    });

  return c.json({
    sessionId: session.id,
    name: session.name,
    createdAt: session.createdAt,
    message: "Session created. Initial graph run started.",
  }, 201);
}

app.get("/health", getHealth);
app.post("/wake", scheduleWake);
app.post("/session/start", startSession);

export default app;

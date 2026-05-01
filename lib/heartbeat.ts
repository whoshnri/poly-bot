import { runHeartbeatLoop } from "../polymarket-endpoint";
import { initPolymarketClient } from "../polymarket-endpoint";
import type { ClobClient as ClobClientV1 } from "@polymarket/clob-client";

const heartbeatControllers = new Map<string, AbortController>();

/**
 * Starts a mandatory heartbeat loop for an active trade session.
 * No-op if a loop is already running for the given sessionId.
 */
export function startHeartbeat(sessionId: string): void {
  if (heartbeatControllers.has(sessionId)) {
    return;
  }

  const controller = new AbortController();
  heartbeatControllers.set(sessionId, controller);

  initPolymarketClient()
    .then((client) =>
      runHeartbeatLoop({
        client: client as unknown as ClobClientV1,
        signal: controller.signal,
        onHeartbeat: (hb) => {
          console.log(`[heartbeat] session=${sessionId} id=${hb.heartbeat_id}`);
        },
      }),
    )
    .catch((err) => {
      console.error(`[heartbeat] Loop failed for session ${sessionId}:`, err instanceof Error ? err.message : err);
      heartbeatControllers.delete(sessionId);
    });
}

/**
 * Stops the heartbeat loop for a session.
 * No-op if no loop is running for the given sessionId.
 */
export function stopHeartbeat(sessionId: string): void {
  const controller = heartbeatControllers.get(sessionId);
  if (!controller) {
    return;
  }

  controller.abort();
  heartbeatControllers.delete(sessionId);
  console.log(`[heartbeat] Stopped for session ${sessionId}`);
}

/**
 * Returns whether a heartbeat loop is currently active for the given session.
 */
export function isHeartbeatActive(sessionId: string): boolean {
  return heartbeatControllers.has(sessionId);
}

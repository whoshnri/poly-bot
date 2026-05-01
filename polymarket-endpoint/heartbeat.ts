import type {
  RunHeartbeatLoopParams,
  SendHeartbeatParams,
} from "../types/polymarket";
import type { HeartbeatResponse } from "@polymarket/clob-client";

/**
 * Sends one heartbeat request and returns server heartbeat metadata.
 */
export async function sendHeartbeat({
  client,
  heartbeatId,
}: SendHeartbeatParams): Promise<HeartbeatResponse> {
  const response = await client.postHeartbeat(heartbeatId ?? null);
  return response;
}

/**
 * Runs a heartbeat loop until aborted to keep market session active.
 */
export async function runHeartbeatLoop({
  client,
  intervalMs = 8_000,
  initialHeartbeatId = "",
  signal,
  onHeartbeat,
}: RunHeartbeatLoopParams): Promise<void> {
  if (intervalMs <= 0) {
    throw new Error("intervalMs must be greater than zero.");
  }

  let heartbeatId = initialHeartbeatId;

  while (!signal?.aborted) {
    const response = await sendHeartbeat({ client, heartbeatId });
    heartbeatId = response.heartbeat_id;
    onHeartbeat?.(response);

    if (signal?.aborted) {
      return;
    }

    await Bun.sleep(intervalMs);
  }
}

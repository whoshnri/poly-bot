const WAKE_SERVER_URL = process.env.WAKE_SERVER_URL ?? "http://localhost:3000";

/**
 * Calls the wake scheduler API with a target datetime.
 */
export async function callWakeApi(datetime: Date | string, sessionId: string) {
  const wakeAt = datetime instanceof Date ? datetime : new Date(datetime);

  if (!Number.isFinite(wakeAt.getTime())) {
    throw new Error("Invalid wake datetime.");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  const wakeToken = process.env.WAKE_API_TOKEN;
  if (wakeToken) {
    headers["Authorization"] = `Bearer ${wakeToken}`;
  }

  const response = await fetch(`${WAKE_SERVER_URL}/wake`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      datetime: wakeAt.toISOString(),
      sessionId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to schedule wake: ${await response.text()}`);
  }

  return response.json();
}

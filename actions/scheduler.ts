import prisma from "../lib/prisma";
import { callWakeApi } from "../lib/wakeCaller";

/**
 * Schedules a wake call for the given stage's nextWake timestamp.
 */
export async function scheduleWake(stageId: string) {
  const stage = await prisma.sessionStage.findUnique({
    where: { id: stageId },
    select: { nextWake: true, sessionId : true },
  });

  if (!stage) {
    throw new Error(`Stage not found: ${stageId}`);
  }

  return callWakeApi(stage.nextWake, stage.sessionId);
}

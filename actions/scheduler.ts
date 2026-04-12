import prisma from "../lib/prisma";
import { callWakeApi } from "../lib/wakeCaller";

export async function scheduleWake(stageId: string) {
  const stage = await prisma.sessionStage.findUnique({
    where: { id: stageId },
    select: { nextWake: true },
  });

  if (!stage) {
    throw new Error(`Stage not found: ${stageId}`);
  }

  return callWakeApi(stage.nextWake);
}

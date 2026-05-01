import prisma from "../lib/prisma";
import { callWakeApi } from "../lib/wakeCaller";
import { SessionAction } from "../src/generated/prisma/client";
import type { CreateNewStageInput, CreateNewTaskInput } from "../types/db";

/**
 * Creates a new session task.
 */
export async function createNewTask(input: CreateNewTaskInput) {
  return prisma.session.create({
    data: {
      name: input.name,
      pages: input.pages,
      metadata: input.metadata,
    },
  });
}

/**
 * Creates the next stage for a session and schedules its wake call.
 */
export async function createNewStage(sessionId: string, input: CreateNewStageInput) {
  const latestStage = await getLatestStage(sessionId);
  const nextWake = input.nextWake instanceof Date ? input.nextWake : new Date(input.nextWake);

  if (!Number.isFinite(nextWake.getTime())) {
    throw new Error("Invalid nextWake datetime.");
  }

  const createdStage = await prisma.sessionStage.create({
    data: {
      sessionId,
      sequence: input.sequence ?? (latestStage?.sequence ?? 0) + 1,
      summary: input.summary,
      todo: input.todo,
      sessionAction: input.sessionAction,
      stageActionCompleted: input.stageActionCompleted ?? false,
      nextWake,
      prevStageId: input.prevStageId ?? latestStage?.id ?? null,
    },
  });

  if (input.scheduleWake ?? true) {
    await callWakeApi(createdStage.nextWake, sessionId );
  }

  return createdStage;
}

export async function markLatestStageActionCompleted(
  sessionId: string,
  completed: boolean,
) {
  const latestStage = await getLatestStage(sessionId);
  if (!latestStage) {
    throw new Error(`No stage found for session: ${sessionId}`);
  }

  return prisma.sessionStage.update({
    where: { id: latestStage.id },
    data: { stageActionCompleted: completed },
  });
}

/**
 * Returns all session stages in ascending sequence order.
 */
export async function getAllStages(taskId: string) {
  return prisma.sessionStage.findMany({
    where: { sessionId: taskId },
    orderBy: { sequence: "asc" },
  });
}

/**
 * Returns the latest session stage by sequence.
 */
export async function getLatestStage(sessionId: string) {
  return prisma.sessionStage.findFirst({
    where: { sessionId },
    orderBy: { sequence: "desc" },
  });
}

export { SessionAction };

import prisma from "../lib/prisma";
import { callWakeApi } from "../lib/wakeCaller";
import { TaskAction, type Prisma } from "../src/generated/prisma/client";

type CreateNewTaskInput = {
  name: string;
  pages?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
};

type CreateNewStageInput = {
  summary: string;
  todo: string;
  taskAction: TaskAction;
  nextWake: Date | string;
  sequence?: number;
  prevStageId?: string | null;
};

export async function createNewTask(input: CreateNewTaskInput) {
  return prisma.session.create({
    data: {
      name: input.name,
      pages: input.pages,
      metadata: input.metadata,
    },
  });
}

export async function createNewStage(taskId: string, input: CreateNewStageInput) {
  const latestStage = await getLatestStage(taskId);
  const nextWake = input.nextWake instanceof Date ? input.nextWake : new Date(input.nextWake);

  if (!Number.isFinite(nextWake.getTime())) {
    throw new Error("Invalid nextWake datetime.");
  }

  const createdStage = await prisma.sessionStage.create({
    data: {
      sessionId: taskId,
      sequence: input.sequence ?? (latestStage?.sequence ?? 0) + 1,
      summary: input.summary,
      todo: input.todo,
      taskAction: input.taskAction,
      nextWake,
      prevStageId: input.prevStageId ?? latestStage?.id ?? null,
    },
  });

  await callWakeApi(createdStage.nextWake);

  return createdStage;
}

export async function getAllStages(taskId: string) {
  return prisma.sessionStage.findMany({
    where: { sessionId: taskId },
    orderBy: { sequence: "asc" },
  });
}

export async function getLatestStage(taskId: string) {
  return prisma.sessionStage.findFirst({
    where: { sessionId: taskId },
    orderBy: { sequence: "desc" },
  });
}

export { TaskAction };

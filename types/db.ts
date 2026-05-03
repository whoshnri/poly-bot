import type { Prisma, SessionAction } from "../src/generated/prisma/client";

export type UserPreferences = {
  dryRun?: boolean;
  maxOrderSizeUsdc?: number;
};

export type CreateNewTaskInput = {
  name: string;
  pages?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
};

export type CreateNewStageInput = {
  summary: string;
  todo: string;
  sessionAction: SessionAction;
  stageActionCompleted?: boolean;
  nextWake: Date | string;
  scheduleWake?: boolean;
  sequence?: number;
  prevStageId?: string | null;
};

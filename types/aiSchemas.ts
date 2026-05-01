import type { z } from "zod";
import type {
  aiModelResponseSchema,
  decisionToolSchema,
  nextStageSchema,
  stageActionSchema,
  toolCallSchema,
} from "../lib/aiSchemas";

export type StageAction = z.infer<typeof stageActionSchema>;
export type DecisionTool = z.infer<typeof decisionToolSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type NextStage = z.infer<typeof nextStageSchema>;
export type AiModelResponse = z.infer<typeof aiModelResponseSchema>;

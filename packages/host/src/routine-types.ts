import { z } from "zod";
import { createGoalSchema, type CreateGoal } from "./goal-types.js";

const explicitAllowedPaths = createGoalSchema.shape.allowedPaths.unwrap();
const explicitBudget = z.number().int();
const { requestId: _requestId, ...goalFields } = createGoalSchema.shape;
const routineGoalSchema = z.object(goalFields).extend({
  allowedPaths: explicitAllowedPaths,
  maxRuns: explicitBudget.min(1).max(10),
  maxMinutes: explicitBudget.min(5).max(1440),
  maxMembers: explicitBudget.min(4).max(200),
}).strict().refine(value => value.maxTotalMinutes === undefined || value.maxTotalMinutes >= value.maxMinutes, {
  path: ["maxTotalMinutes"], message: "The total time ceiling cannot be shorter than the time limit.",
});

export const createRoutineSchema = z.object({
  requestId: z.uuid(),
  goal: routineGoalSchema,
  intervalMinutes: z.number().int().min(5).max(10080),
  maxOccurrences: z.number().int().min(1).max(100),
  startsAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type CreateRoutine = Omit<z.infer<typeof createRoutineSchema>, "goal"> & { goal: Omit<CreateGoal, "requestId"> };

export const routineActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
export type RoutineAction = z.infer<typeof routineActionSchema>;

export interface RoutineOccurrence { goalId: string; startedAt: string }
export type RoutineStatus = "scheduled" | "running" | "paused" | "blocked" | "completed" | "cancelled" | "expired";
export interface Routine {
  id: string;
  revision: number;
  status: RoutineStatus;
  goal: Omit<CreateGoal, "requestId">;
  intervalMinutes: number;
  maxOccurrences: number;
  startsAt: string;
  expiresAt: string;
  nextRunAt: string;
  occurrences: RoutineOccurrence[];
  activeGoalId?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

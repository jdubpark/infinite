import { z } from "zod";
import { createGoalSchema, type CreateGoal } from "./goal-types.js";
import { signalKinds, type PendingWake, type SignalKind } from "./signals/types.js";

const explicitAllowedPaths = createGoalSchema.shape.allowedPaths.unwrap();
const explicitBudget = z.number().int();
const { requestId: _requestId, standing: _standing, ...goalFields } = createGoalSchema.shape; // A routine never starts a standing goal; `strict` refuses the key.
const routineGoalSchema = z.object(goalFields).extend({
  allowedPaths: explicitAllowedPaths,
  maxRuns: explicitBudget.min(1).max(10),
  maxMinutes: explicitBudget.min(5).max(1440),
  maxMembers: explicitBudget.min(4).max(200),
}).strict().refine(value => value.maxTotalMinutes === undefined || value.maxTotalMinutes >= value.maxMinutes, {
  path: ["maxTotalMinutes"], message: "The total time ceiling cannot be shorter than the time limit.",
});

/** The project signal kinds that may start an occurrence before `nextRunAt`. No default, so an absent key stays absent. */
const wakeOnSchema = z.array(z.enum(signalKinds)).min(1).max(4)
  .refine(kinds => new Set(kinds).size === kinds.length, "Each signal kind may appear once.");

export const createRoutineSchema = z.object({
  requestId: z.uuid(),
  goal: routineGoalSchema,
  intervalMinutes: z.number().int().min(5).max(10080),
  maxOccurrences: z.number().int().min(1).max(100),
  startsAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  wakeOn: wakeOnSchema.optional(),
}).strict();
export type CreateRoutine = Omit<z.infer<typeof createRoutineSchema>, "goal"> & { goal: Omit<CreateGoal, "requestId"> };

export const routineActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
export type RoutineAction = z.infer<typeof routineActionSchema>;

/** The signals an occurrence started on: their ids, and how many older ones the pending wake dropped. */
export interface RoutineWake { signalIds: string[]; dropped: number }
export interface RoutineOccurrence {
  goalId: string;
  startedAt: string;
  /** When the routine saw the occurrence's goal settle. Absent while it runs, and on records from before this field. */
  endedAt?: string;
  /** Present when signals were waiting when the occurrence started. */
  wake?: RoutineWake;
}
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
  /** Signal kinds that may start an occurrence early. Fixed at approval. */
  wakeOn?: SignalKind[];
  /** The last inbox seq this routine read. Unset means it has read nothing yet. */
  signalCursor?: number;
  /** Signals read since the last occurrence started. */
  pendingWake?: PendingWake;
  /** A busy project refused a start while a wake was pending, so the wake waits for `nextRunAt`. */
  wakeDeferred?: boolean;
}

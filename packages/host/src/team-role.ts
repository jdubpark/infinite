export const TEAM_ROLE_VALUES = ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker", "evaluator", "judge"] as const;
export type TeamRole = typeof TEAM_ROLE_VALUES[number];

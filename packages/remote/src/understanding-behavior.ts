import type { KnowledgeEvidence } from "./understanding-knowledge.js";

export type BehaviorValue = string | number | boolean;
export type BehaviorOperand = { variable: string } | { value: BehaviorValue };
export type BehaviorPredicate =
  | { op: "eq" | "neq"; left: BehaviorOperand; right: BehaviorOperand }
  | { op: "and" | "or"; args: BehaviorPredicate[] }
  | { op: "not"; arg: BehaviorPredicate }
  | { op: "true" | "false" };

/** Data only: no expressions, modules, shell commands, or executable markup. */
export interface BehaviorModel {
  initial: string;
  states: { id: string; label: string }[];
  variables: { id: string; domain: BehaviorValue[]; initial: BehaviorValue }[];
  transitions: {
    id: string; from: string; to: string; label: string; actor: string; event: string;
    guard: BehaviorPredicate; effects: Record<string, BehaviorOperand>; evidence: KnowledgeEvidence[];
  }[];
  properties: {
    id: string; title: string; kind: "safety" | "liveness";
    /** Empty means every state. Reachability is checked independently of truth. */
    states: string[]; predicate: BehaviorPredicate; requirement: string;
    basis: "accepted" | "proposed"; evidence: KnowledgeEvidence[];
  }[];
}

export interface BehaviorDefinition {
  schemaVersion: 1; id: string; title: string; componentId: string; repositoryId: string;
  /** The captured map and complete active component plan set used to model this flow. */
  sourceSnapshotId: string; planRevisions: { id: string; revision: number }[];
  requirementRevision: string; assumptions: string[]; exclusions: string[];
  current: BehaviorModel; planned: BehaviorModel | null;
}

export interface BehaviorTraceStep {
  state: string; values: Record<string, BehaviorValue>;
  transitionId: string | null; summary: string;
}
export interface BehaviorPropertyResult {
  id: string; status: "passed" | "failed" | "unreachable" | "unsupported" | "incomplete";
  reachableStates: number; trace: BehaviorTraceStep[]; traceTruncated: boolean;
}
export interface BehaviorCheckResult {
  tool: "infinite-finite-state"; toolVersion: string;
  status: "passed" | "counterexample" | "inconclusive" | "error";
  checkedAt: string; modelHash: string; exhaustive: boolean;
  exploredStates: number; exploredTransitions: number;
  limits: { maxStates: number; maxTransitions: number; timeoutMs: number; maxTraceSteps: number };
  properties: BehaviorPropertyResult[]; message: string;
}
export interface BehaviorRun {
  id: string; definitionRevision: number; definitionHash: string;
  startedAt: string; finishedAt: string | null;
  state: "running" | "finished" | "interrupted";
  current: BehaviorCheckResult | null; planned: BehaviorCheckResult | null; message: string | null;
}
export interface KnowledgeBehavior {
  id: string; revision: number; definition: BehaviorDefinition;
  sources: { repositoryId: string; path: string; hash: string; lines: number }[];
  updatedAt: string;
  freshness: "current" | "stale" | "unavailable";
  status: "unchecked" | "running" | "passed" | "counterexample" | "inconclusive" | "error" | "stale";
  coverage: string[]; runs: BehaviorRun[];
}
export interface BehaviorList { schemaVersion: 1; behaviors: KnowledgeBehavior[]; coverage: string[] }
export interface BehaviorMutation { requestId: string; revision: number }
export interface BehaviorSuite {
  schemaVersion: 1; files: { path: string; content: string }[]; coverage: string[];
}

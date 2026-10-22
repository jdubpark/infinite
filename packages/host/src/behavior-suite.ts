import { createHash } from "node:crypto";
import type { BehaviorDefinition, BehaviorModel, BehaviorOperand, BehaviorPredicate, BehaviorSuite, BehaviorValue } from "@infinite/remote";
import { validateBehaviorDefinition } from "./behavior-checker.js";

type NameTable = { locationByState: Map<string, number>; variableById: Map<string, string>; valueByKey: Map<string, number> };

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function safeIdentifier(prefix: string, value: string): string {
  const slug = value.normalize("NFKD").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "item";
  return `${prefix}_${slug}_${stableHash(value)}`;
}

function valueKey(value: BehaviorValue): string {
  return JSON.stringify(value);
}

function walkPredicate(predicate: BehaviorPredicate, visit: (operand: BehaviorOperand) => void): void {
  if (predicate.op === "eq" || predicate.op === "neq") {
    visit(predicate.left);
    visit(predicate.right);
  } else if (predicate.op === "not") walkPredicate(predicate.arg, visit);
  else if (predicate.op === "and" || predicate.op === "or") predicate.args.forEach(item => walkPredicate(item, visit));
}

function namesFor(model: BehaviorModel): NameTable {
  const allValues = new Map<string, BehaviorValue>();
  const addValue = (value: BehaviorValue) => allValues.set(valueKey(value), value);
  for (const variable of model.variables) {
    variable.domain.forEach(addValue);
    addValue(variable.initial);
  }
  for (const transition of model.transitions) {
    walkPredicate(transition.guard, operand => { if ("value" in operand) addValue(operand.value); });
    Object.values(transition.effects).forEach(operand => { if ("value" in operand) addValue(operand.value); });
  }
  for (const property of model.properties) walkPredicate(property.predicate, operand => { if ("value" in operand) addValue(operand.value); });
  const valueByKey = new Map([...allValues.keys()].sort().map((key, index) => [key, index]));
  return {
    locationByState: new Map(model.states.map((state, index) => [state.id, index])),
    variableById: new Map(model.variables.map(variable => [variable.id, safeIdentifier("v", variable.id)])),
    valueByKey,
  };
}

function valueCode(value: BehaviorValue, names: NameTable): string {
  const code = names.valueByKey.get(valueKey(value));
  if (code === undefined) throw new Error("TLA export encountered an unregistered finite value");
  return String(code);
}

function operandCode(operand: BehaviorOperand, names: NameTable): string {
  return "variable" in operand ? names.variableById.get(operand.variable)! : valueCode(operand.value, names);
}

function predicateCode(predicate: BehaviorPredicate, names: NameTable, indent = ""): string {
  if (predicate.op === "true" || predicate.op === "false") return predicate.op === "true" ? "TRUE" : "FALSE";
  if (predicate.op === "eq" || predicate.op === "neq") {
    return `${operandCode(predicate.left, names)} ${predicate.op === "eq" ? "=" : "#"} ${operandCode(predicate.right, names)}`;
  }
  if (predicate.op === "not") return `~(${predicateCode(predicate.arg, names, indent)})`;
  if (predicate.op === "and" || predicate.op === "or") {
    const connective = predicate.op === "and" ? "/\\" : "\\/";
    return `(${predicate.args.map(item => predicateCode(item, names, indent)).join(` ${connective} `)})`;
  }
  throw new Error("Unreachable predicate operator during TLA export");
}

function finiteSet(values: number[]): string {
  return `{${[...new Set(values)].sort((left, right) => left - right).join(", ")}}`;
}

function renderTla(model: BehaviorModel, moduleName: string): string {
  const names = namesFor(model);
  const variableIds = model.variables.map(variable => variable.id);
  const stateVariables = ["loc", ...variableIds.map(id => names.variableById.get(id)!)];
  const lines = [
    `---------------- MODULE ${moduleName} ----------------`,
    "EXTENDS Naturals, TLC",
    "",
    `VARIABLES ${stateVariables.join(", ")}`,
    `vars == <<${stateVariables.join(", ")}>>`,
    "",
    "Init ==",
    `  /\\ loc = ${names.locationByState.get(model.initial)}`,
    ...model.variables.map(variable => `  /\\ ${names.variableById.get(variable.id)} = ${valueCode(variable.initial, names)}`),
    "",
    "TypeOK ==",
    `  /\\ loc \\in ${finiteSet(model.states.map(state => names.locationByState.get(state.id)!))}`,
    ...model.variables.map(variable => `  /\\ ${names.variableById.get(variable.id)} \\in ${finiteSet(variable.domain.map(value => Number(names.valueByKey.get(valueKey(value))!)))}`),
    "",
  ];
  for (const transition of model.transitions) {
    lines.push(`${safeIdentifier("Step", transition.id)} ==`);
    lines.push(`  /\\ loc = ${names.locationByState.get(transition.from)}`);
    lines.push(`  /\\ (${predicateCode(transition.guard, names)})`);
    lines.push(`  /\\ loc' = ${names.locationByState.get(transition.to)}`);
    for (const variable of model.variables) {
      const rhs = Object.hasOwn(transition.effects, variable.id)
        ? operandCode(transition.effects[variable.id]!, names)
        : names.variableById.get(variable.id)!;
      lines.push(`  /\\ ${names.variableById.get(variable.id)}' = ${rhs}`);
    }
    lines.push("");
  }
  if (model.transitions.length) {
    lines.push("Next ==");
    lines.push(...model.transitions.map((transition, index) => `  ${index === 0 ? "\\/" : "\\/"} ${safeIdentifier("Step", transition.id)}`));
  } else lines.push("Next == FALSE");
  lines.push("", "Spec == Init /\\ [][Next]_vars", "");
  for (const property of model.properties.filter(item => item.kind === "safety")) {
    const scopedStates = property.states.map(state => names.locationByState.get(state)!);
    const scope = scopedStates.length ? `loc \\in ${finiteSet(scopedStates)} => ` : "";
    lines.push(`${safeIdentifier("Invariant", property.id)} == ${scope}(${predicateCode(property.predicate, names)})`);
  }
  lines.push("", "=======================================================", "");
  return lines.join("\n");
}

function renderConfig(model: BehaviorModel): string {
  const lines = [`SPECIFICATION Spec`, "INVARIANT TypeOK"];
  for (const property of model.properties.filter(item => item.kind === "safety")) lines.push(`INVARIANT ${safeIdentifier("Invariant", property.id)}`);
  lines.push("CHECK_DEADLOCK FALSE", "");
  return lines.join("\n");
}

function skillText(): string {
  return `---
name: understanding-behavior
description: Use when authoring, reviewing, or checking a finite data-only behavior model for an Understanding component, including interpreting bounded safety results and optional TLC exports.
---

# Understanding behavior verification

Use this workflow when an Understanding behavior definition needs a local finite safety check or a separate TLC check.

1. Bind template IDs to the intended source snapshot, component, repository, and complete plan revision set. Keep current and planned models distinct.
2. From the suite directory, run the local checker and save its JSON result:

   \`\`\`sh
   infinite understand check --file definition.json --json > behavior-result.json
   \`\`\`

3. Review the checker version, model hash, timestamp, all four limits, exhaustive flag, and each property result. A counterexample is a safety failure. Treat inconclusive, incomplete, unreachable, unsupported, cancelled, timed-out, or otherwise bounded work as unresolved. Liveness is unsupported.
4. If independent checking is useful, run the exported current and planned TLA+ modules separately with TLC and record its version, commands, and results. Exporting a module does not mean TLC ran.

For model semantics and the Understanding refresh pilot, see \`docs/behavior-verification.md\` at the repository root. For a multi-repository model, bind the definition's repository ID to the repository containing the referenced host component code; A/B labels are symbolic workspace actors. The local checker verifies only the declared finite model; bind it to the intended preview and do not infer deployment or live source freshness from a pass.

`;
}

function readmeText(definition: BehaviorDefinition): string {
  const scope = [definition.componentId, definition.repositoryId, definition.sourceSnapshotId].map(value => JSON.stringify(value)).join(" / ");
  const currentResult = definition.current.properties.length ? "Current model: finite safety specification; run the command below to produce a result." : "Current model: no safety properties are declared.";
  const plannedResult = definition.planned ? "Planned model: exported separately for independent checking." : "Planned model: none is declared.";
  const assumptions = definition.assumptions.length ? definition.assumptions : ["No assumptions were recorded."];
  const exclusions = definition.exclusions.length ? definition.exclusions : ["No exclusions were recorded."];
  const safeText = (value: string) => value.replace(/[<>`]/g, "").replace(/[\r\n]+/g, " ");
  return [
    `# ${definition.title.replace(/[<>]/g, "")}`,
    "",
    `This suite describes a bounded finite behavior model for ${scope}. The definition is a template until the preview is bound to its actual source snapshot, component, repository, and complete plan revision set. For a multi-repository model, bind the repository ID to the repository containing the referenced host component code; labels such as A and B represent workspace actors, not source-evidence ownership.`,
    "",
    `${currentResult} ${plannedResult}`,
    "",
    "## Current, Planned, and Difference",
    "",
    "Current and planned are complete independent model definitions. Compare their states, domains, transitions, and safety properties directly; a pass for either model does not imply equivalence or approval of the other.",
    "",
    "## Run",
    "",
    "    infinite understand check --file definition.json --json",
    "",
    "The checker exhaustively explores enabled transitions within the recorded state, transition, time, and trace limits. A result passes only when all declared reachable safety properties are checked exhaustively. Liveness is unsupported; unreachable properties and every incomplete run remain inconclusive.",
    "",
    "The verification exports represent current and planned models independently. TLC has not been run by exporting these files. When an independent TLC run is performed, record the TLC version, exact command, and result alongside the review. See [Lamport's TLA+ tools](https://lamport.azurewebsites.net/tla/tools.html) and the [TLA+ examples](https://github.com/tlaplus/Examples).",
    "",
    "## Assumptions",
    "",
    ...assumptions.map(value => `- ${safeText(value)}`),
    "",
    "## Exclusions",
    "",
    ...exclusions.map(value => `- ${safeText(value)}`),
    "",
    "Bind template source, component, repository, and plan revision identifiers to the intended preview before treating a result as relevant. A source map or passing model does not establish deployment or live acceptance.",
    "",
  ].join("\n");
}

export function exportBehaviorSuite(definition: BehaviorDefinition): BehaviorSuite {
  const validated = validateBehaviorDefinition(definition);
  const files: BehaviorSuite["files"] = [
    { path: "definition.json", content: `${JSON.stringify(validated, null, 2)}\n` },
    { path: "README.md", content: readmeText(validated) },
    { path: "SKILL.md", content: skillText() },
    { path: "verification/Current.tla", content: renderTla(validated.current, "Current") },
    { path: "verification/Current.cfg", content: renderConfig(validated.current) },
  ];
  if (validated.planned) {
    files.push({ path: "verification/Planned.tla", content: renderTla(validated.planned, "Planned") });
    files.push({ path: "verification/Planned.cfg", content: renderConfig(validated.planned) });
  }
  return {
    schemaVersion: 1,
    files,
    coverage: [
      "Current and planned models are exported independently.",
      "TLA+ output uses generated identifiers and finite integer value ordinals; definition text is not inserted as executable expressions.",
      "The export represents safety invariants only; liveness remains unsupported by the local checker.",
      "No TLC execution is implied by generating the suite.",
    ],
  };
}

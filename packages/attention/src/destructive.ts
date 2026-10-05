// Pattern list adapted from jevcode (packages/contracts/src/security.ts) with additions.
export interface DestructivePattern {
  name: string;
  pattern: RegExp;
}
export const destructivePatterns: readonly DestructivePattern[] = [
  { name: "rm-recursive-force", pattern: /\brm\b\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\s+-f|-f\s+-r)\b/i },
  { name: "rm-recursive-force-long", pattern: /\brm\b\s+(?=.*--recursive)(?=.*--force)/i },
  // Separate flags anywhere in the same command, such as `rm -r build -f`.
  { name: "rm-recursive-force", pattern: /\brm\b(?=[^\n;&|]*\s-[a-zA-Z]*r)(?=[^\n;&|]*\s-[a-zA-Z]*f)/i },
  { name: "git-push-force", pattern: /\bgit\s+push\b[^\n]*(^|\s)(--force(-with-lease)?|-f)(\s|$|=)/ },
  { name: "git-reset-hard", pattern: /\bgit\s+reset\s+--hard\b/ },
  { name: "git-clean-force", pattern: /\bgit\s+clean\b[^\n]*\s(-[a-zA-Z]*f|--force\b)/ },
  { name: "git-checkout-discard", pattern: /\bgit\s+checkout\s+--\s+\./ },
  { name: "git-branch-delete", pattern: /\bgit\s+branch\s+(-D|--delete\s+--force)\b/ },
  { name: "sql-drop-table", pattern: /\bDROP\s+TABLE\b/i },
  { name: "sql-truncate", pattern: /\bTRUNCATE(\s+TABLE)?\s+\w/i },
  { name: "sql-delete-from", pattern: /\bDELETE\s+FROM\b/i },
  { name: "db-reset", pattern: /\bdb:reset\b/i },
  { name: "migration-down", pattern: /\b(migrat(?:e|ion)s?\s+(down|rollback)|migrate:down|migration:down|db:migrate:down)\b/i },
  { name: "chmod-world-writable", pattern: /\bchmod\s+(-R\s+)?0?777\b/ },
  { name: "kubectl-delete", pattern: /\bkubectl\s+delete\b/ },
  { name: "terraform-destroy", pattern: /\bterraform\s+destroy\b/ },
  { name: "docker-prune", pattern: /\bdocker\s+(system|volume|image|container)\s+prune\b/ },
];

export function matchDestructive(command: string): string | null {
  // A leading `echo …` only prints its words; whatever follows `;`, `&&`, `||` or `|` still runs.
  const runs = command.replace(/^\s*echo\b[^;&|]*/, "");
  for (const entry of destructivePatterns) if (entry.pattern.test(runs)) return entry.name;
  return null;
}

import type { BoardItem, ProjectGroup, ProjectGroupCheckout, ProjectGroupList, ProjectGroupSuggestion } from "../../api/client";

export function visibleGroups(groups: ProjectGroup[]): ProjectGroup[] {
  return groups.filter(group => !group.hidden);
}

export function groupActivity(items: BoardItem[], groupId: string): string {
  const mine = items.filter(item => item.groupId === groupId);
  const count = (column: BoardItem["column"]) => mine.filter(item => item.column === column).length;
  const parts: string[] = [];
  const needsInput = count("needs-input");
  if (needsInput) parts.push(`${needsInput} ${needsInput === 1 ? "needs" : "need"} input`);
  const working = count("working");
  if (working) parts.push(`${working} working`);
  const review = count("review");
  if (review) parts.push(`${review} to review`);
  return parts.length ? parts.join(" · ") : "Nothing running";
}

export function checkoutsOf(group: ProjectGroup): ProjectGroupCheckout[] {
  return group.repos.flatMap(repo => [...repo.checkouts].sort((a, b) => Number(b.primary) - Number(a.primary)));
}

export function groupContaining(groups: ProjectGroup[], projectId: string): ProjectGroup | undefined {
  return groups.find(group => group.id === projectId || group.repos.some(repo => repo.projectId === projectId || repo.checkouts.some(checkout => checkout.projectId === projectId)));
}

export function primaryCheckout(group: ProjectGroup): ProjectGroupCheckout | undefined {
  const repo = group.repos[0];
  return repo?.checkouts.find(checkout => checkout.primary) ?? repo?.checkouts[0];
}

export function projectSections(list: ProjectGroupList): { visible: ProjectGroup[]; hidden: ProjectGroup[]; suggestions: ProjectGroupSuggestion[] } {
  return { visible: list.groups.filter(group => !group.hidden), hidden: list.groups.filter(group => group.hidden), suggestions: list.suggestions };
}

export function combineLabel(suggestion: ProjectGroupSuggestion, groups: ProjectGroup[]): string {
  const names = suggestion.groupIds.map(id => groups.find(group => group.id === id)?.name ?? id);
  const joined = names.length > 2 ? `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}` : names.join(" and ");
  return `Combine ${joined}`;
}

export function preferredCheckout(group: ProjectGroup): ProjectGroupCheckout | undefined {
  const primary = primaryCheckout(group);
  if (primary?.teamReady) return primary;
  return checkoutsOf(group).find(checkout => checkout.teamReady) ?? primary;
}

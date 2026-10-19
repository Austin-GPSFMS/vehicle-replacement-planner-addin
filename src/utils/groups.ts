import type { GeotabGroup } from "../types";

/** Expand selected group ids to themselves plus every descendant. */
export function expandGroupIds(selected: string[], byId: Map<string, GeotabGroup>): Set<string> {
  const out = new Set<string>();
  const stack = [...selected];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const g = byId.get(id);
    for (const c of g?.children ?? []) stack.push(c.id);
  }
  return out;
}

/** Display names for a device's groups, skipping the built-in company root. */
export function groupNames(ids: Array<{ id: string }> | undefined, byId: Map<string, GeotabGroup>): string[] {
  const names: string[] = [];
  for (const g of ids ?? []) {
    if (g.id === "GroupCompanyId") continue;
    const name = byId.get(g.id)?.name;
    names.push(name && name.length ? name : g.id);
  }
  return names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

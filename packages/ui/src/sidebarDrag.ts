type SidebarOrders = ReadonlyMap<string, readonly string[]>;

/** The insertion index is relative to the target after the dragged path is removed. */
export function moveSidebarSession(orders: SidebarOrders, path: string, target: string, index: number): Map<string, string[]> {
  const next = new Map([...orders].map(([key, paths]) => [key, [...paths]]));
  if (!next.has(target)) return next;
  for (const [key, paths] of next) next.set(key, paths.filter(item => item !== path));
  const destination = [...new Set(next.get(target)!)];
  const insertion = Number.isNaN(index) ? 0 : Math.max(0, Math.min(destination.length, Math.trunc(index)));
  destination.splice(insertion, 0, path);
  next.set(target, destination);
  return next;
}

/** Compare complete container snapshots, so a round trip produces no writes. */
export function changedSidebarOrders(initial: SidebarOrders, current: SidebarOrders): Map<string, string[]> {
  const changed = new Map<string, string[]>();
  for (const [key, paths] of current) {
    const before = initial.get(key);
    if (!before || before.length !== paths.length || paths.some((path, index) => path !== before[index])) changed.set(key, [...paths]);
  }
  return changed;
}

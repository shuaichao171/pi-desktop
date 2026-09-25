import type { UiSessionGroup, UiSessionSummary } from '@pidesktop/shared';

export interface SidebarPreferences {
  mode: 'grouped' | 'project';
  projectView: 'project' | 'timeline';
  sort: 'newest' | 'oldest';
  filter: 'all' | 'unread' | 'pinned';
  collapsed: string[];
}

export type SidebarSession = UiSessionSummary & { workspace: string };

const PREFERENCES_KEY = 'pi-desktop.sidebar-organization.v1';

function normalizePreferences(value: unknown): SidebarPreferences {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    mode: source.mode === 'project' ? 'project' : 'grouped',
    projectView: source.projectView === 'timeline' ? 'timeline' : 'project',
    sort: source.sort === 'oldest' ? 'oldest' : 'newest',
    filter: source.filter === 'unread' || source.filter === 'pinned' ? source.filter : 'all',
    collapsed: Array.isArray(source.collapsed)
      ? [...new Set(source.collapsed.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : [],
  };
}

export function readSidebarPreferences(storage?: Pick<Storage, 'getItem'>): SidebarPreferences {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(PREFERENCES_KEY);
    return normalizePreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return normalizePreferences(undefined);
  }
}

export function saveSidebarPreferences(
  value: SidebarPreferences,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(PREFERENCES_KEY, JSON.stringify(normalizePreferences(value)));
  } catch {
    // An unavailable or full preference store must not block sidebar navigation.
  }
}

export function collectSidebarSessions(
  workspacePaths: string[],
  sessionsByWorkspace: Record<string, UiSessionSummary[]>,
): SidebarSession[] {
  const seen = new Set<string>();
  const sessions: SidebarSession[] = [];
  for (const workspace of workspacePaths) {
    for (const session of sessionsByWorkspace[workspace] ?? []) {
      if (seen.has(session.path)) continue;
      seen.add(session.path);
      sessions.push({ ...session, workspace });
    }
  }
  return sessions;
}

export function selectSidebarSessions(
  sessions: SidebarSession[],
  options: {
    archived: boolean;
    filter: SidebarPreferences['filter'];
    sort: SidebarPreferences['sort'];
  },
): SidebarSession[] {
  return sessions
    .filter((session) => Boolean(session.archived) === options.archived
      && (options.filter !== 'unread' || session.unread)
      && (options.filter !== 'pinned' || session.pinned))
    .map((session, index) => ({ session, index, time: Date.parse(session.modified) }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.time);
      const rightValid = Number.isFinite(right.time);
      if (leftValid !== rightValid) return leftValid ? -1 : 1;
      if (leftValid && left.time !== right.time) {
        return options.sort === 'oldest' ? left.time - right.time : right.time - left.time;
      }
      return left.index - right.index;
    })
    .map(({ session }) => session);
}

export function buildSidebarGroups(sessions: SidebarSession[], groups: UiSessionGroup[]): {
  pinned: SidebarSession[];
  groups: { id: string; name: string; sessions: SidebarSession[] }[];
  ungrouped: SidebarSession[];
} {
  const groupById = new Map<string, { id: string; name: string; sessions: SidebarSession[] }>();
  const groupBySessionPath = new Map<string, string>();
  for (const group of groups) {
    if (groupById.has(group.id)) continue;
    groupById.set(group.id, { id: group.id, name: group.name, sessions: [] });
    for (const path of group.sessionPaths) {
      if (!groupBySessionPath.has(path)) groupBySessionPath.set(path, group.id);
    }
  }
  const pinned: SidebarSession[] = [];
  const ungrouped: SidebarSession[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.path)) continue;
    seen.add(session.path);
    if (session.pinned) {
      pinned.push(session);
      continue;
    }
    const groupId = groupBySessionPath.get(session.path);
    const group = groupId === undefined ? undefined : groupById.get(groupId);
    (group ? group.sessions : ungrouped).push(session);
  }
  for (const bucket of groupById.values()) bucket.sessions = orderSessions(bucket.sessions);
  return { pinned, groups: [...groupById.values()], ungrouped: orderSessions(ungrouped) };
}

/**
 * Manual sidebar positions: sessions without an explicit order keep their
 * time-based sort and stay above the manually arranged block below.
 */
export function orderSessions(sessions: SidebarSession[]): SidebarSession[] {
  if (!sessions.some((session) => Number.isFinite(session.order))) return sessions;
  const unordered = sessions.filter((session) => !Number.isFinite(session.order));
  const ordered = sessions
    .filter((session) => Number.isFinite(session.order))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0)
      || Date.parse(right.modified) - Date.parse(left.modified));
  return [...unordered, ...ordered];
}

export function groupSessionsByDate(sessions: SidebarSession[], now = new Date()): {
  id: 'today' | 'yesterday' | 'week' | 'older';
  sessions: SidebarSession[];
}[] {
  // Construct calendar boundaries instead of subtracting 24-hour durations across DST.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  const groups: ReturnType<typeof groupSessionsByDate> = [
    { id: 'today', sessions: [] },
    { id: 'yesterday', sessions: [] },
    { id: 'week', sessions: [] },
    { id: 'older', sessions: [] },
  ];
  for (const session of sessions) {
    const time = Date.parse(session.modified);
    const index = time >= today ? 0 : time >= yesterday ? 1 : time >= week ? 2 : 3;
    groups[index]!.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}

import type { UiSessionGroup, UiSessionSummary } from '@pidesktop/shared';

export interface SidebarPreferences {
  mode: 'grouped' | 'project';
  projectView: 'project' | 'timeline';
  sort: 'newest' | 'oldest';
  filter: 'all' | 'unread' | 'pinned';
  collapsed: string[];
  projectOrder: string[];
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
    projectOrder: Array.isArray(source.projectOrder)
      ? [...new Set(source.projectOrder.filter((path): path is string => typeof path === 'string' && path.length > 0))]
      : [],
  };
}

/** Retain known positions while the workspace registry is still loading. */
export function mergeSidebarProjectOrder(saved: readonly string[], workspaces: readonly string[]): string[] {
  return [...new Set([...saved, ...workspaces])];
}

/** Reorder one visible section without moving the saved slots of other projects. */
export function reorderSidebarProjectPositions(saved: readonly string[], reordered: readonly string[]): string[] {
  const projects = sidebarProjectPaths(reordered, null);
  const keys = new Set(projects.map(sidebarWorkspaceKey));
  let index = 0;
  return sidebarProjectPaths([...saved, ...projects], null)
    .map(path => keys.has(sidebarWorkspaceKey(path)) ? projects[index++]! : path);
}

/** Navigation may update the workspace MRU; explicit sidebar positions stay put. */
export function orderSidebarProjects(workspaces: readonly string[], saved: readonly string[], pinned: ReadonlySet<string>): string[] {
  const available = new Map(sidebarProjectPaths(workspaces, null).map(path => [sidebarWorkspaceKey(path), path]));
  const ordered = mergeSidebarProjectOrder(saved, workspaces)
    .map(path => available.get(sidebarWorkspaceKey(path)))
    .filter((path): path is string => path !== undefined);
  const sections = splitSidebarProjects(ordered, pinned);
  return [...sections.pinned, ...sections.unpinned];
}

/** Compare Windows workspace aliases without treating POSIX paths as case-insensitive. */
export function sidebarWorkspaceKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:(?:\/|$)/i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

/** The default working directory holds conversations that have no selected project. */
export function isConversationWorkspace(workspace: string, conversationWorkspaces: readonly string[]): boolean {
  const key = sidebarWorkspaceKey(workspace);
  return conversationWorkspaces.some(path => sidebarWorkspaceKey(path) === key);
}

export function sidebarProjectPaths(workspaces: readonly string[], defaultWorkspace: string | null, conversationWorkspaces: readonly string[] = []): string[] {
  const defaultKey = defaultWorkspace === null ? null : sidebarWorkspaceKey(defaultWorkspace);
  const hidden = new Set(conversationWorkspaces.map(sidebarWorkspaceKey));
  const seen = new Set<string>();
  return workspaces.filter((workspace) => {
    const key = sidebarWorkspaceKey(workspace);
    if (key === defaultKey || hidden.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Pinning changes sections without changing the saved position within the project list. */
export function splitSidebarProjects(workspaces: readonly string[], pinned: ReadonlySet<string>): {
  pinned: string[];
  unpinned: string[];
} {
  const pinnedKeys = new Set([...pinned].map(sidebarWorkspaceKey));
  const sections = { pinned: [] as string[], unpinned: [] as string[] };
  for (const workspace of sidebarProjectPaths(workspaces, null)) {
    (pinnedKeys.has(sidebarWorkspaceKey(workspace)) ? sections.pinned : sections.unpinned).push(workspace);
  }
  return sections;
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

/** Projects pinned to the top of the sidebar's project list (Codex-style). */
const PINNED_PROJECTS_KEY = 'pi-desktop.pinned-projects.v1';

export function readPinnedProjects(storage?: Pick<Storage, 'getItem'>): string[] {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(PINNED_PROJECTS_KEY);
    const value = raw ? JSON.parse(raw) : undefined;
    return Array.isArray(value)
      ? [...new Set(value.filter((path): path is string => typeof path === 'string' && path.length > 0))]
      : [];
  } catch {
    return [];
  }
}

export function savePinnedProjects(paths: string[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(PINNED_PROJECTS_KEY, JSON.stringify(paths));
  } catch {
    // Pinning is cosmetic; ignore unavailable storage.
  }
}

/** Remove the legacy renderer-only pin store after migration to workspace.json. */
export function clearPinnedProjects(storage?: Pick<Storage, 'removeItem'>): void {
  try {
    (storage ?? globalThis.localStorage)?.removeItem(PINNED_PROJECTS_KEY);
  } catch {
    // Migration cleanup is best effort.
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
    .map((session, index) => ({ session, index, time: Date.parse(session.modified), created: Date.parse(session.created ?? '') }))
    .sort((left, right) => {
      // zcode two-tier ordering (taskListOrdering): running conversations float to the
      // top as one tier and that tier NEVER reads modified — concurrent runs bump it
      // on every turn boundary and would swap rows mid-stream. Creation time is the
      // stable key; entries without it keep insertion order.
      const leftRunning = left.session.runtime?.phase === 'running';
      const rightRunning = right.session.runtime?.phase === 'running';
      if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
      if (leftRunning) {
        const leftCreated = Number.isFinite(left.created);
        const rightCreated = Number.isFinite(right.created);
        if (leftCreated !== rightCreated) return leftCreated ? -1 : 1;
        if (leftCreated && left.created !== right.created) return right.created - left.created;
        return left.index - right.index;
      }
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

/** Keep conversations outside the project registry in their own section below projects. */
export function buildSidebarProjectGroups(sessions: SidebarSession[], projectPaths: readonly string[]): {
  projects: { workspace: string; sessions: SidebarSession[] }[];
  unassigned: SidebarSession[];
} {
  const projects = sidebarProjectPaths(projectPaths, null).map((workspace) => ({ workspace, sessions: [] as SidebarSession[] }));
  const projectByWorkspace = new Map(projects.map((project) => [sidebarWorkspaceKey(project.workspace), project]));
  const unassigned: SidebarSession[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.path)) continue;
    seen.add(session.path);
    // Pinned conversations already have a shared section above the project list.
    if (session.pinned) continue;
    const project = projectByWorkspace.get(sidebarWorkspaceKey(session.workspace));
    (project ? project.sessions : unassigned).push(session);
  }
  for (const project of projects) project.sessions = orderSessions(project.sessions);
  return { projects, unassigned: orderSessions(unassigned) };
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

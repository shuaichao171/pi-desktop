import type { UiMessage, UiToolActivity } from '@pidesktop/shared';

/**
 * A model that searched another directory often names just the file ("see
 * `sheepington_basic.zip`") while the real location appears elsewhere in the
 * conversation ("都在 `D:\steam\...\anim\` 下"). Collecting those absolute
 * mentions lets the main process retry the link outside the conversation cwd.
 *
 * Only Windows drive paths are collected: POSIX absolute paths collide with
 * URL paths and markdown link targets in prose.
 */

const QUOTED_PATHS = [
  // Quoted or backtick-wrapped runs may contain spaces (e.g. "Don't Starve Together").
  /`([^`\n]{0,512}[a-zA-Z]:[\\/][^`\n]{0,512})`/g,
  /"([^"\n]{0,512}[a-zA-Z]:[\\/][^"\n]{0,512})"/g,
  /'([^'\n]{0,512}[a-zA-Z]:[\\/][^'\n]{0,512})'/g,
];
// Bare tokens stop at whitespace and quotes; a path with spaces is covered by a
// quoted form above, and quoted spans are masked before this scan runs so a
// long quoted path is never re-truncated into a bogus shorter one.
const BARE_PATH = /\b([a-zA-Z]:[\\/][^\s`"'|<>()[\]{}]*)/g;

function linkBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? '';
}

function trimSlashes(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

function collectFromText(text: string, linkPath: string, basename: string, fileLevel: string[], directoryLevel: string[], seen: Set<string>): void {
  const quoted: Array<{ at: number; len: number; value: string }> = [];
  for (const pattern of QUOTED_PATHS) {
    for (const match of text.matchAll(pattern)) quoted.push({ at: match.index, len: match[0].length, value: match[1] });
  }
  const masked = text.split('');
  for (const span of quoted) {
    masked.fill(' ', span.at, span.at + span.len);
  }
  const bare: Array<{ at: number; value: string }> = [];
  for (const match of masked.join('').matchAll(BARE_PATH)) bare.push({ at: match.index, value: match[1] });
  // Later mentions read as the fresher location, so visits run back to front.
  for (const mention of [...quoted, ...bare].sort((a, b) => b.at - a.at)) {
    const found = trimSlashes(mention.value);
    const tail = found.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? '';
    // A mention of the very file wins; any other absolute path is tried as a
    // directory the relative link may hang under.
    const isFileLevel = Boolean(basename) && tail === basename;
    const candidate = isFileLevel ? found : `${found}\\${linkPath.replace(/^~[\\/]?/, '')}`;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (isFileLevel ? fileLevel : directoryLevel).push(candidate);
  }
}

/** Absolute path candidates for a relative link, newest mention first. */
export function resultFileCandidates(linkPath: string, messages: UiMessage[], activities: UiToolActivity[]): string[] {
  if (/^(?:[a-zA-Z]:[\\/]|~[\\/])/i.test(linkPath) || /^[\\/]/.test(linkPath)) return [];
  const basename = linkBasename(linkPath);
  if (!basename) return [];
  const fileLevel: string[] = [];
  const directoryLevel: string[] = [];
  const seen = new Set<string>();
  // Newest mentions win, so blocks are visited in reverse timeline order; the
  // scan is bounded because a long transcript must stay cheap on every click.
  const blocks: Array<{ order: number; text: string }> = [
    ...activities.slice(-200).map((activity) => ({ order: activity.order, text: `${activity.title ?? ''}\n${activity.detail ?? ''}` })),
    ...messages.slice(-200).map((message) => ({ order: message.order, text: message.text ?? '' })),
  ].sort((a, b) => b.order - a.order);
  for (const block of blocks) collectFromText(block.text, linkPath, basename, fileLevel, directoryLevel, seen);
  return [...fileLevel, ...directoryLevel].slice(0, 8);
}

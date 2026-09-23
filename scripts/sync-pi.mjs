import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
export const PI_PACKAGES = [
  '@earendil-works/chord',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  PI_PACKAGE,
  '@earendil-works/pi-telemetry',
  '@earendil-works/pi-tui',
];
export const ESBUILD_PACKAGES = [
  '@esbuild/darwin-arm64',
  '@esbuild/darwin-x64',
  '@esbuild/linux-x64',
  '@esbuild/win32-x64',
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = [
  ['root', 'package.json', 'devDependencies', '.'],
  ['agent', 'packages/agent/package.json', 'dependencies', 'packages/agent'],
  ['desktop', 'packages/desktop/package.json', 'dependencies', 'packages/desktop'],
];
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REGISTRY_URL = 'https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent';

export function assertStableVersion(value) {
  if (typeof value !== 'string' || !STABLE_VERSION.test(value)) {
    throw new Error(`Expected an exact stable Pi version (for example 0.87.1), got ${JSON.stringify(value)}`);
  }
  return value;
}

export function compareStableVersions(left, right) {
  const a = assertStableVersion(left).split('.').map(BigInt);
  const b = assertStableVersion(right).split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function parseYaml(text, label) {
  const document = YAML.parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) {
    throw new Error(`${label} is invalid YAML: ${document.errors[0].message}`);
  }
  return document.toJS({ maxAliasCount: 100 });
}

function parseManifest(text, label, dependencyGroup) {
  let manifest;
  try { manifest = JSON.parse(text); }
  catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
  const version = manifest?.[dependencyGroup]?.[PI_PACKAGE];
  try { assertStableVersion(version); }
  catch { throw new Error(`${label} must declare ${PI_PACKAGE} as an exact stable version in ${dependencyGroup}`); }
  return { manifest, version };
}

function verifyWorkspace(text, version) {
  const workspace = parseYaml(text, 'pnpm-workspace.yaml');
  const entries = workspace?.minimumReleaseAgeExclude;
  if (!Array.isArray(entries)) throw new Error('pnpm-workspace.yaml is missing minimumReleaseAgeExclude');
  for (const name of PI_PACKAGES) {
    const matches = entries.filter((entry) => typeof entry === 'string' && entry.startsWith(`${name}@`));
    if (matches.length !== 1 || matches[0] !== `${name}@${version}`) {
      throw new Error(`pnpm-workspace.yaml must contain exactly one ${name}@${version} exclusion`);
    }
  }
}

function resolvedVersionMatches(resolved, version) {
  return typeof resolved === 'string' &&
    (resolved === version || resolved.startsWith(`${version}(`));
}

function verifyLockfile(text, version, desktopManifest) {
  const lock = parseYaml(text, 'pnpm-lock.yaml');
  for (const [label, , dependencyGroup, importer] of MANIFESTS) {
    const entry = lock?.importers?.[importer]?.[dependencyGroup]?.[PI_PACKAGE];
    if (entry?.specifier !== version || !resolvedVersionMatches(entry.version, version)) {
      throw new Error(`pnpm-lock.yaml importer ${label} does not resolve ${PI_PACKAGE}@${version}`);
    }
  }
  const packageKey = `${PI_PACKAGE}@${version}`;
  if (!lock?.packages?.[packageKey]) {
    throw new Error(`pnpm-lock.yaml is missing package ${packageKey}`);
  }
  if (!Object.keys(lock?.snapshots ?? {}).some((key) =>
    key === packageKey || key.startsWith(`${packageKey}(`))) {
    throw new Error(`pnpm-lock.yaml is missing a snapshot for ${packageKey}`);
  }

  const chordKey = `@earendil-works/chord@${version}`;
  const chord = lock?.snapshots?.[chordKey];
  const esbuildVersion = chord?.dependencies?.esbuild;
  if (!chord || typeof esbuildVersion !== 'string') {
    throw new Error(`pnpm-lock.yaml is missing ${chordKey} snapshot or its esbuild dependency`);
  }
  assertStableVersion(esbuildVersion);
  for (const name of ESBUILD_PACKAGES) {
    if (desktopManifest?.optionalDependencies?.[name] !== esbuildVersion) {
      throw new Error(`packages/desktop/package.json must pin ${name} to Pi Chord's esbuild ${esbuildVersion}`);
    }
  }
  return { esbuildVersion };
}

/** Validate a complete source set without reading or modifying the filesystem. */
export function verifySources(sources) {
  const manifests = {};
  let version;
  for (const [label, , dependencyGroup] of MANIFESTS) {
    const parsed = parseManifest(sources.manifests?.[label], `${label} package.json`, dependencyGroup);
    manifests[label] = parsed.manifest;
    if (version && parsed.version !== version) {
      throw new Error(`Pi version drift: ${label} has ${parsed.version}, expected ${version}`);
    }
    version = parsed.version;
  }
  verifyWorkspace(sources.workspace, version);
  const { esbuildVersion } = verifyLockfile(sources.lockfile, version, manifests.desktop);
  return { version, esbuildVersion };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceManifestVersion(text, oldVersion, newVersion, label) {
  const expression = new RegExp(`("${escapeRegExp(PI_PACKAGE)}"\\s*:\\s*")${escapeRegExp(oldVersion)}(")`, 'g');
  let count = 0;
  const updated = text.replace(expression, (_match, start, end) => {
    count += 1;
    return `${start}${newVersion}${end}`;
  });
  if (count !== 1) throw new Error(`${label} must contain exactly one ${PI_PACKAGE} version declaration`);
  return updated;
}

function replaceWorkspaceVersion(text, oldVersion, newVersion) {
  let updated = text;
  for (const name of PI_PACKAGES) {
    const expression = new RegExp(`(^[ \\t]*-[ \\t]*['"])${escapeRegExp(name)}@${escapeRegExp(oldVersion)}(['"][ \\t]*$)`, 'gm');
    let count = 0;
    updated = updated.replace(expression, (_match, start, end) => {
      count += 1;
      return `${start}${name}@${newVersion}${end}`;
    });
    if (count !== 1) throw new Error(`pnpm-workspace.yaml must contain exactly one ${name}@${oldVersion} line`);
  }
  return updated;
}

/** Plan a source-only update; pnpm install --lockfile-only must follow it. */
export function updateSources(sources, targetVersion) {
  const { version: oldVersion } = verifySources(sources);
  const newVersion = assertStableVersion(targetVersion);
  if (oldVersion === newVersion) return { changed: false, oldVersion, newVersion, sources };
  const manifests = {};
  for (const [label] of MANIFESTS) {
    manifests[label] = replaceManifestVersion(sources.manifests[label], oldVersion, newVersion, label);
  }
  const workspace = replaceWorkspaceVersion(sources.workspace, oldVersion, newVersion);
  return {
    changed: true,
    oldVersion,
    newVersion,
    sources: { manifests, workspace, lockfile: sources.lockfile },
  };
}

function readSources(root) {
  const manifests = {};
  for (const [label, path] of MANIFESTS) {
    manifests[label] = readFileSync(join(root, path), 'utf8');
  }
  return {
    manifests,
    workspace: readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    lockfile: readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'),
  };
}

function writeUpdatedSources(root, sources) {
  for (const [label, path] of MANIFESTS) {
    writeFileSync(join(root, path), sources.manifests[label], 'utf8');
  }
  writeFileSync(join(root, 'pnpm-workspace.yaml'), sources.workspace, 'utf8');
}

async function getPublishedVersion(version) {
  const endpoint = version ? `${REGISTRY_URL}/${encodeURIComponent(version)}` : `${REGISTRY_URL}/latest`;
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${endpoint}`);
  const metadata = await response.json();
  if (metadata?.name !== PI_PACKAGE) throw new Error('npm registry returned metadata for a different package');
  const published = assertStableVersion(metadata.version);
  if (version && published !== version) throw new Error(`npm registry returned ${published}, expected ${version}`);
  return published;
}

function writeGithubOutput(changed, oldVersion, newVersion) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(output, `changed=${changed}\nold_version=${oldVersion}\nnew_version=${newVersion}\n`, 'utf8');
}

async function main(args = process.argv.slice(2)) {
  const [command, argument] = args;
  if ((command !== '--update' && args.length !== 1) || (command === '--update' && args.length !== 2)) {
    throw new Error('Usage: node scripts/sync-pi.mjs --verify | --check-latest | --update-latest | --update VERSION');
  }
  const sources = readSources(ROOT);
  const { version: current, esbuildVersion } = verifySources(sources);
  if (command === '--verify') {
    console.log(`Pi SDK ${current} is aligned across manifests, lockfile and exclusions; Pi Chord esbuild ${esbuildVersion} is packaged.`);
    return;
  }
  if (command === '--check-latest') {
    const latest = await getPublishedVersion();
    console.log(`Pi SDK: current ${current}; npm latest ${latest}${compareStableVersions(latest, current) > 0 ? ' (update available)' : ''}.`);
    return;
  }
  if (command !== '--update' && command !== '--update-latest') {
    throw new Error('Unknown command. Use --verify, --check-latest, --update-latest, or --update VERSION.');
  }
  const requested = command === '--update' ? assertStableVersion(argument) : null;
  const published = await getPublishedVersion(requested);
  const target = command === '--update-latest' && compareStableVersions(published, current) <= 0 ? current : published;
  const result = updateSources(sources, target);
  if (result.changed) writeUpdatedSources(ROOT, result.sources);
  writeGithubOutput(result.changed, result.oldVersion, result.newVersion);
  console.log(result.changed
    ? `Pi SDK ${result.oldVersion} → ${result.newVersion}. Run pnpm install --lockfile-only, then --verify and CI before merging.`
    : `Pi SDK ${current} is already at the requested version.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

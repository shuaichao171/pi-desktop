import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseUpdateFeedUrl } from '../../packages/desktop/src/main/updateFeed.ts';

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const windowsSecrets = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
const macSecrets = ['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const defaultFeed = 'https://github.com/shuaichao171/pi-desktop/releases/latest/download/';

export function createReleasePlan({ tag, rootVersion, desktopVersion, env = {} }) {
  if (typeof tag !== 'string' || tag !== tag.trim() || !stableTag.test(tag)) throw new Error('Release tag must be a stable version such as v0.1.1 (no prerelease or leading zeros).');
  const version = tag.slice(1);
  if (rootVersion !== version || desktopVersion !== version) throw new Error(`Tag and package versions differ: ${tag}, ${rootVersion}, ${desktopVersion}`);
  const present = (name) => typeof env[name] === 'string' && env[name].trim().length > 0;
  const windowsConfigured = windowsSecrets.filter(present);
  if (windowsConfigured.length > 0 && windowsConfigured.length < windowsSecrets.length) {
    throw new Error(`Windows signing requires both variables; missing: ${windowsSecrets.filter((name) => !present(name)).join(', ')}`);
  }
  const missingMac = macSecrets.filter((name) => !present(name));
  const feed = parseUpdateFeedUrl(env.PI_DESKTOP_UPDATE_URL || defaultFeed);
  if (!feed) throw new Error('PI_DESKTOP_UPDATE_URL must be a public HTTPS directory URL ending in /.');
  return { tag, version, feed, signWindows: windowsConfigured.length === windowsSecrets.length,
    buildMac: missingMac.length === 0, partialMac: missingMac.length > 0 && missingMac.length < macSecrets.length, missingMac };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { tag: { type: 'string' } } });
  const plan = createReleasePlan({
    tag: values.tag ?? process.env.RELEASE_TAG,
    rootVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
    desktopVersion: JSON.parse(readFileSync('packages/desktop/package.json', 'utf8')).version,
    env: process.env,
  });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const taggedSha = execFileSync('git', ['rev-parse', `refs/tags/${plan.tag}^{commit}`], { encoding: 'utf8' }).trim();
  if (sha !== taggedSha) throw new Error('Checkout does not match the requested release tag.');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `tag=${plan.tag}\nversion=${plan.version}\nsha=${sha}\nfeed=${plan.feed}\nwindows_signed=${plan.signWindows}\nmacos=${plan.buildMac}\n`);
  if (plan.partialMac) console.warn(`::warning::macOS is skipped because credentials are incomplete. Missing: ${plan.missingMac.join(', ')}`);
  const summary = `${plan.tag}: Windows ${plan.signWindows ? 'signed' : 'unsigned'}, Linux enabled, macOS ${plan.buildMac ? 'signed and notarized' : 'skipped'}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `${summary}\n\nUpdate feed: ${plan.feed}\n\nArtifacts remain a draft unless the manual publish option is selected.\n`);
}

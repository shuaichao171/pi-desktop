import { createReadStream } from 'node:fs';
import { appendFile, lstat, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import YAML from 'yaml';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Validate the complete batch before returning the exact assets to publish. */
export async function verifyReleaseArtifacts(directory, { version, macos = false } = {}) {
  if (typeof version !== 'string' || version !== version.trim() || !STABLE_VERSION.test(version)) {
    throw new Error('Release version must be a stable version such as 0.2.0');
  }
  const releaseDir = resolve(directory);
  if (/[\r\n\0]/.test(releaseDir)) throw new Error('Release directory must not contain control characters');
  const setup = `Pi-Desktop-Setup-${version}-x64.exe`;
  const portable = `Pi-Desktop-Portable-${version}-x64.exe`;
  const appImage = `Pi-Desktop-${version}-x64.AppImage`;
  const deb = `Pi-Desktop-${version}-x64.deb`;
  const macFiles = ['x64', 'arm64'].flatMap((arch) => ['dmg', 'zip'].map((ext) => `Pi-Desktop-${version}-${arch}.${ext}`));
  const required = [setup, portable, `${setup}.blockmap`, 'latest.yml', appImage, deb, 'latest-linux.yml',
    ...(macos ? [...macFiles, 'latest-mac.yml'] : [])];
  const optional = [`${portable}.blockmap`, `${appImage}.blockmap`,
    ...(macos ? macFiles.filter((name) => name.endsWith('.zip')).map((name) => `${name}.blockmap`) : [])];
  const artifacts = new Map();

  async function inspect(name, isOptional = false) {
    const path = join(releaseDir, name);
    let stats;
    try { stats = await lstat(path); }
    catch (error) {
      if (error.code === 'ENOENT' && isOptional) return;
      if (error.code === 'ENOENT') throw new Error(`Missing release artifact: ${name}`);
      throw error;
    }
    if (!stats.isFile() || stats.size === 0) throw new Error(`Release artifact must be a nonempty regular file: ${name}`);
    artifacts.set(name, { path, size: stats.size });
  }

  await Promise.all(required.map((name) => inspect(name)));
  await Promise.all(optional.map((name) => inspect(name, true)));

  async function hash(name) {
    const artifact = artifacts.get(name);
    artifact.digest ??= (async () => {
      const digest = createHash('sha512');
      for await (const chunk of createReadStream(artifact.path)) digest.update(chunk);
      return digest.digest('base64');
    })();
    return artifact.digest;
  }

  async function verifyManifest(name, allowed, requiredUpdates) {
    const info = YAML.parse(await readFile(artifacts.get(name).path, 'utf8'));
    if (!info || typeof info !== 'object' || info.version !== version) {
      throw new Error(`Update metadata version mismatch: ${name} (expected ${version})`);
    }
    if (!Array.isArray(info.files) || info.files.length === 0) throw new Error(`Update metadata files are missing: ${name}`);
    // This workflow produces full NSIS installers, not web installer packages.
    if (info.packages != null) throw new Error(`Unexpected web installer packages: ${name}`);
    const seen = new Set();
    for (const file of info.files) {
      if (typeof file?.url !== 'string' || !allowed.includes(file.url)) {
        throw new Error(`Unexpected update artifact in ${name}: ${String(file?.url)}`);
      }
      if (seen.has(file.url)) throw new Error(`Duplicate update artifact in ${name}: ${file.url}`);
      seen.add(file.url);
      if (typeof file.sha512 !== 'string' || file.sha512 !== await hash(file.url)) {
        throw new Error(`Update SHA-512 mismatch in ${name}: ${file.url}`);
      }
      if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size !== artifacts.get(file.url).size)) {
        throw new Error(`Update size mismatch in ${name}: ${file.url}`);
      }
    }
    for (const requiredUpdate of requiredUpdates) {
      if (!seen.has(requiredUpdate)) throw new Error(`Required update artifact missing from ${name}: ${requiredUpdate}`);
    }
    if (typeof info.path !== 'string' || !allowed.includes(info.path) || !seen.has(info.path)) {
      throw new Error(`Unexpected update path in ${name}: ${String(info.path)}`);
    }
    if (typeof info.sha512 !== 'string' || info.sha512 !== await hash(info.path)) {
      throw new Error(`Update SHA-512 mismatch for path in ${name}: ${info.path}`);
    }
  }

  await verifyManifest('latest.yml', [setup], [setup]);
  // electron-builder merges AppImage and DEB update entries into this manifest.
  await verifyManifest('latest-linux.yml', [appImage, deb], [appImage, deb]);
  if (macos) await verifyManifest('latest-mac.yml', macFiles, macFiles.filter((name) => name.endsWith('.zip')));
  return [...required, ...optional.filter((name) => artifacts.has(name))].map((name) => artifacts.get(name).path);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { version: { type: 'string' }, macos: { type: 'boolean', default: false } },
  });
  if (positionals.length !== 1 || !values.version) {
    throw new Error('Usage: node .github/scripts/verify-release-artifacts.mjs release --version 0.2.0 [--macos]');
  }
  const files = await verifyReleaseArtifacts(positionals[0], values);
  const output = `${files.join('\n')}\n`;
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `release_files_${randomUUID()}`;
    await appendFile(process.env.GITHUB_OUTPUT, `files<<${delimiter}\n${output}${delimiter}\n`);
  }
  process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

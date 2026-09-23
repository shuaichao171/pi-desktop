import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import YAML from 'yaml';

const releaseDir = process.argv[2] ?? 'release';
const expectedVersion = process.env.GITHUB_REF_NAME?.replace(/^v/, '');
const architectures = ['x64', 'arm64'];

function load(arch) {
  const path = join(releaseDir, `latest-mac-${arch}.yml`);
  const info = YAML.parse(readFileSync(path, 'utf8'));
  if (!info || typeof info.version !== 'string' || !Array.isArray(info.files)) {
    throw new Error(`Invalid macOS update metadata: ${path}`);
  }
  if (expectedVersion && info.version !== expectedVersion) {
    throw new Error(`macOS ${arch} metadata version ${info.version} does not match ${expectedVersion}`);
  }
  for (const file of info.files) {
    if (typeof file?.url !== 'string' || !file.url.includes(`-${arch}.`) || typeof file.sha512 !== 'string') {
      throw new Error(`Unexpected macOS ${arch} update file: ${JSON.stringify(file)}`);
    }
    const artifact = readFileSync(join(releaseDir, basename(file.url)));
    const digest = createHash('sha512').update(artifact).digest('base64');
    if (digest !== file.sha512) throw new Error(`Update hash mismatch: ${file.url}`);
  }
  const zip = info.files.find((file) => file.url.endsWith(`-${arch}.zip`));
  if (!zip) throw new Error(`macOS ${arch} ZIP update payload is missing`);
  return { path, info, zip };
}

const [intel, apple] = architectures.map(load);
if (intel.info.version !== apple.info.version) throw new Error('macOS architecture versions differ');
const files = [...intel.info.files, ...apple.info.files];
if (new Set(files.map((file) => file.url)).size !== files.length) {
  throw new Error('macOS update metadata has duplicate artifacts');
}

// MacUpdater selects arm64 files by their filename and excludes them on Intel.
// Keep the x64 ZIP as the legacy path/sha512 fallback while retaining both
// architecture-specific ZIP and DMG entries in the files array.
const merged = {
  ...intel.info,
  files,
  path: intel.zip.url,
  sha512: intel.zip.sha512,
};
writeFileSync(join(releaseDir, 'latest-mac.yml'), YAML.stringify(merged));
unlinkSync(intel.path);
unlinkSync(apple.path);
console.log(`Merged macOS update metadata for ${intel.info.version}: ${files.length} files`);

'use strict';

/**
 * Android release signing and version numbers, free of Expo imports so the repository's Node tests can load it.
 *
 * The upload key never lives in the repository: the generated `android/app/build.gradle` reads it from Gradle
 * properties (`-P` or `~/.gradle/gradle.properties`) or environment variables. Without a key, release builds keep
 * the debug signature so local test builds still work; published builds are checked against the key in CI.
 */

const MARKER = '// pidesktop: release signing';

/** Names read by the generated Gradle file; the CI workflow and the docs use the same names. */
const SIGNING_VARIABLES = Object.freeze({
  keystore: 'PIDESKTOP_ANDROID_KEYSTORE',
  storePassword: 'PIDESKTOP_ANDROID_KEYSTORE_PASSWORD',
  keyAlias: 'PIDESKTOP_ANDROID_KEY_ALIAS',
  keyPassword: 'PIDESKTOP_ANDROID_KEY_PASSWORD',
});

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Android `versionCode` for a stable `X.Y.Z` version: X·1,000,000 + Y·1,000 + Z, so every later desktop release
 * installs over the previous APK (0.5.14 → 5014).
 */
function versionCodeFor(version) {
  const match = typeof version === 'string' ? STABLE_VERSION.exec(version) : null;
  if (!match) throw new Error(`App version must be a stable X.Y.Z version, got ${JSON.stringify(version)}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (minor > 999 || patch > 999) throw new Error(`Minor and patch versions above 999 do not fit the Android versionCode: ${version}`);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  // Google Play's ceiling; also rejects 0.0.0, which Android does not accept.
  if (code < 1 || code > 2_100_000_000) throw new Error(`Version ${version} gives an invalid Android versionCode ${code}`);
  return code;
}

const HELPERS = `${MARKER}: the upload key comes from Gradle properties or environment variables, never from the repository.
def pidesktopSigningValue = { String name -> (findProperty(name) ?: System.getenv(name))?.toString()?.trim() ?: null }
def pidesktopReleaseKeystore = pidesktopSigningValue('${SIGNING_VARIABLES.keystore}')
if (pidesktopReleaseKeystore) {
    def missing = ['${SIGNING_VARIABLES.storePassword}', '${SIGNING_VARIABLES.keyAlias}', '${SIGNING_VARIABLES.keyPassword}'].findAll { !pidesktopSigningValue(it) }
    if (missing) throw new GradleException("Release signing is incomplete; missing: \${missing.join(', ')}")
    if (!file(pidesktopReleaseKeystore).isFile()) throw new GradleException("Release keystore not found: \${pidesktopReleaseKeystore}")
}

`;

const RELEASE_CONFIG = `        if (pidesktopReleaseKeystore) {
            release {
                storeFile file(pidesktopReleaseKeystore)
                storePassword pidesktopSigningValue('${SIGNING_VARIABLES.storePassword}')
                keyAlias pidesktopSigningValue('${SIGNING_VARIABLES.keyAlias}')
                keyPassword pidesktopSigningValue('${SIGNING_VARIABLES.keyPassword}')
            }
        }
`;

/**
 * Adds the release signing config to Expo's generated `android/app/build.gradle`. Idempotent; throws when the
 * template no longer has the expected shape, so a template change cannot silently ship debug-signed builds.
 */
function applyReleaseSigning(gradle) {
  if (typeof gradle !== 'string') throw new TypeError('build.gradle contents must be a string');
  if (gradle.includes(MARKER)) return gradle;
  const eol = gradle.includes('\r\n') ? '\r\n' : '\n';
  let text = gradle.replace(/\r\n/g, '\n');

  const android = /^android \{$/m;
  if (!android.test(text)) throw new Error('Release signing: no top-level `android {` block in build.gradle');
  text = text.replace(android, `${HELPERS}android {`);

  // The debug config has no nested blocks, so its body is everything up to the first closing brace.
  const debugConfig = /(\n    signingConfigs \{\n        debug \{\n[^{}]*?\n        \}\n)/;
  if (!debugConfig.test(text)) throw new Error('Release signing: unexpected signingConfigs block in build.gradle');
  text = text.replace(debugConfig, `$1${RELEASE_CONFIG}`);

  const releaseType = /(\n    buildTypes \{[\s\S]*?\n        release \{\n(?:            \/\/[^\n]*\n)*)            signingConfig signingConfigs\.debug\n/;
  if (!releaseType.test(text)) throw new Error('Release signing: release build type does not use the debug signature as expected');
  text = text.replace(releaseType, '$1            signingConfig pidesktopReleaseKeystore ? signingConfigs.release : signingConfigs.debug\n');

  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

module.exports = { MARKER, SIGNING_VARIABLES, applyReleaseSigning, versionCodeFor };

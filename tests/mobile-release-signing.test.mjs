import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const { MARKER, SIGNING_VARIABLES, applyReleaseSigning, versionCodeFor } = require('../apps/mobile/plugins/releaseSigning.js');

// The relevant part of Expo SDK 53's generated android/app/build.gradle.
const TEMPLATE = `apply plugin: "com.android.application"

def enableProguardInReleaseBuilds = (findProperty('android.enableProguardInReleaseBuilds') ?: false).toBoolean()

android {
    ndkVersion rootProject.ext.ndkVersion
    defaultConfig {
        applicationId 'com.pidesktop.remote'
        versionCode 5013
        versionName "0.5.13"
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
}
`;

test('release signing reads the upload key from properties or the environment and keeps debug builds on the debug key', () => {
  const gradle = applyReleaseSigning(TEMPLATE);
  assert.equal(gradle.split(MARKER).length, 2);
  assert.ok(gradle.indexOf(MARKER) < gradle.indexOf('\nandroid {'), 'helpers are defined before the android block uses them');
  for (const name of Object.values(SIGNING_VARIABLES)) assert.ok(gradle.includes(`'${name}'`), name);
  assert.match(gradle, /if \(pidesktopReleaseKeystore\) \{\n            release \{\n                storeFile file\(pidesktopReleaseKeystore\)/);
  assert.match(gradle, /release \{\n(?:\s*\/\/[^\n]*\n)*\s*signingConfig pidesktopReleaseKeystore \? signingConfigs\.release : signingConfigs\.debug\n/);
  assert.match(gradle, /debug \{\n            signingConfig signingConfigs\.debug\n/, 'the debug build type is untouched');
  assert.match(gradle, /throw new GradleException\("Release signing is incomplete/);
  // No secret values or key file paths end up in the generated project.
  assert.doesNotMatch(gradle, /storePassword '(?!android')/);
});

test('release signing is idempotent, keeps CRLF files intact and refuses an unexpected template', () => {
  const once = applyReleaseSigning(TEMPLATE);
  assert.equal(applyReleaseSigning(once), once);
  const crlf = applyReleaseSigning(TEMPLATE.replace(/\n/g, '\r\n'));
  assert.equal(crlf, once.replace(/\n/g, '\r\n'));
  assert.throws(() => applyReleaseSigning(TEMPLATE.replace('android {', 'android{')), /android \{/);
  assert.throws(() => applyReleaseSigning(TEMPLATE.replace("storeFile file('debug.keystore')", "storeFile file('debug.keystore') { }")), /signingConfigs/);
  assert.throws(() => applyReleaseSigning(TEMPLATE.replace(/(release \{[\s\S]*?)signingConfig signingConfigs\.debug/, '$1signingConfig signingConfigs.other')), /release build type/);
  assert.throws(() => applyReleaseSigning(null), TypeError);
});

test('Android versionCode follows the desktop version and always increases', () => {
  assert.equal(versionCodeFor('0.5.13'), 5013);
  assert.equal(versionCodeFor('0.5.14'), 5014);
  assert.equal(versionCodeFor('1.0.0'), 1_000_000);
  const ordered = ['0.0.1', '0.1.0', '0.5.13', '0.5.999', '0.6.0', '1.0.0', '2.10.3'];
  const codes = ordered.map(versionCodeFor);
  assert.deepEqual([...codes].sort((a, b) => a - b), codes);
  for (const bad of ['0.0.0', '0.5', 'v0.5.13', '0.5.13-beta.1', '00.5.1', '0.1000.0', '0.1.1000', '2101.0.0', undefined, 5]) {
    assert.throws(() => versionCodeFor(bad), /version/i, String(bad));
  }
});

test('the mobile app config takes its version from the root package and registers the signing plugin', () => {
  const rootVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const makeConfig = require('../apps/mobile/app.config.js');
  const appJson = JSON.parse(readFileSync(new URL('../apps/mobile/app.json', import.meta.url), 'utf8')).expo;
  assert.equal(appJson.version, undefined, 'app.json must not carry a second, stale version');
  assert.ok(appJson.plugins.includes('./plugins/withReleaseSigning'));
  const config = makeConfig({ config: appJson });
  assert.equal(config.version, rootVersion);
  assert.equal(config.android.versionCode, versionCodeFor(rootVersion));
  assert.equal(config.android.package, 'com.pidesktop.remote');
});

test('the 手机远控 download QR points at the APK the release workflow publishes', async () => {
  const { PI_DESKTOP_RELEASES_URL, androidApkFileName, mobileAppDownload } = await import('../packages/shared/src/mobileApp.ts');
  assert.equal(androidApkFileName('0.5.13'), 'Pi-Desktop-Remote-0.5.13-android-arm64.apk');
  // The same asset name as the workflow's copy step and the draft-release verifier.
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const { jobs } = YAML.parse(workflow);
  for (const name of ['build-windows', 'build-macos', 'build-linux']) {
    assert.equal(jobs[name].env.PI_DESKTOP_RELEASE_ANDROID, '${{ needs.prerequisites.outputs.android }}', name);
  }
  assert.ok(workflow.includes('release/Pi-Desktop-Remote-$RELEASE_VERSION-android-arm64.apk'));
  const verifier = readFileSync(new URL('../.github/scripts/verify-release-artifacts.mjs', import.meta.url), 'utf8');
  assert.ok(verifier.includes('`Pi-Desktop-Remote-${version}-android-arm64.apk`'));

  assert.deepEqual(mobileAppDownload('0.5.13', true), {
    version: '0.5.13',
    downloadUrl: `${PI_DESKTOP_RELEASES_URL}/download/v0.5.13/Pi-Desktop-Remote-0.5.13-android-arm64.apk`,
    pageUrl: `${PI_DESKTOP_RELEASES_URL}/tag/v0.5.13`,
  });
  assert.deepEqual(mobileAppDownload('0.5.13', false), {
    version: '0.5.13', downloadUrl: null, pageUrl: `${PI_DESKTOP_RELEASES_URL}/tag/v0.5.13`,
  });
  assert.equal(mobileAppDownload('0.5.13', undefined).downloadUrl, `${PI_DESKTOP_RELEASES_URL}/latest`, 'a local build may carry a stable package version');
  // Dev and other non-release versions have no matching release: use the latest one.
  for (const version of [null, undefined, '', '0.5.13-dev', '0.1.5-review', 'v0.5.13', '05.1.0']) {
    assert.deepEqual(mobileAppDownload(version), { version: null, downloadUrl: `${PI_DESKTOP_RELEASES_URL}/latest`, pageUrl: `${PI_DESKTOP_RELEASES_URL}/latest` }, String(version));
  }
  assert.match(PI_DESKTOP_RELEASES_URL, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases$/);
});

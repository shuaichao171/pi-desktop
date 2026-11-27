/**
 * Where the Android companion app is published: each desktop GitHub release carries
 * `Pi-Desktop-Remote-<version>-android-arm64.apk` (see `.github/workflows/release.yml`).
 */
export const PI_DESKTOP_RELEASES_URL = 'https://github.com/shuaichao171/pi-desktop/releases';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Release asset name of the phone APK built for desktop `version`. */
export function androidApkFileName(version: string): string {
  return `Pi-Desktop-Remote-${version}-android-arm64.apk`;
}

export interface MobileAppDownload {
  /** Desktop version the APK was built with; `null` when this build points at the latest release instead. */
  readonly version: string | null;
  /** What the download QR opens on the phone: the APK itself, or the latest release page. */
  readonly downloadUrl: string;
  /** Release page for a desktop browser. */
  readonly pageUrl: string;
}

/**
 * The phone app built from the same release as this desktop, so both speak the same remote
 * protocol. Development and other non-release versions have no matching release and use the
 * latest one.
 */
export function mobileAppDownload(appVersion: string | null | undefined): MobileAppDownload {
  if (typeof appVersion === 'string' && STABLE_VERSION.test(appVersion)) {
    const tag = `v${appVersion}`;
    return {
      version: appVersion,
      downloadUrl: `${PI_DESKTOP_RELEASES_URL}/download/${tag}/${androidApkFileName(appVersion)}`,
      pageUrl: `${PI_DESKTOP_RELEASES_URL}/tag/${tag}`,
    };
  }
  return { version: null, downloadUrl: `${PI_DESKTOP_RELEASES_URL}/latest`, pageUrl: `${PI_DESKTOP_RELEASES_URL}/latest` };
}

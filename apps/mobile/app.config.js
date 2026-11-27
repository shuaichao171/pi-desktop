'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { versionCodeFor } = require('./plugins/releaseSigning');

/**
 * The phone app is built and published with each desktop release, so it carries the desktop version from the
 * repository's root package.json; the release script bumps that one file for both.
 */
module.exports = ({ config }) => {
  const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  return {
    ...config,
    version,
    android: { ...config.android, versionCode: versionCodeFor(version) },
  };
};

'use strict';

const { withAppBuildGradle } = require('expo/config-plugins');
const { applyReleaseSigning } = require('./releaseSigning');

/** Expo config plugin: lets `assembleRelease` sign with the upload key from Gradle properties or the environment. */
module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') throw new Error('Release signing expects a Groovy android/app/build.gradle');
    mod.modResults.contents = applyReleaseSigning(mod.modResults.contents);
    return mod;
  });
};

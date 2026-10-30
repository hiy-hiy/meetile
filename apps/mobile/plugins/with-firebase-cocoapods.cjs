const { withPodfile } = require('expo/config-plugins');

// Firebase pods are autolinked even before registration files are available.
// The full Firebase plugin requires those files, so handle that setup state here.
function setFirebaseCocoaPods(contents) {
  const withoutFlag = contents.replace(
    /^\$RNFirebaseDisableSPM = (?:true|false)\r?\n/gm,
    '',
  );
  return `$RNFirebaseDisableSPM = true\n${withoutFlag}`;
}

module.exports = (config) =>
  withPodfile(config, (mod) => {
    mod.modResults.contents = setFirebaseCocoaPods(mod.modResults.contents);
    return mod;
  });
module.exports.setFirebaseCocoaPods = setFirebaseCocoaPods;

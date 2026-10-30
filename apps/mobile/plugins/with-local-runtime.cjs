const { withInfoPlist, withAndroidManifest } = require('expo/config-plugins');
module.exports = function withLocalRuntime(config, { enabled }) {
  config = withInfoPlist(config, (config) => {
    if (enabled) {
      config.modResults.PuzzleLocalMode = true;
      config.modResults.NSLocalNetworkUsageDescription =
        'ローカル検証のため、同じWi-Fi上のMacに接続します。';
      config.modResults.NSAppTransportSecurity ??= {};
      config.modResults.NSAppTransportSecurity.NSAllowsLocalNetworking = true;
    } else {
      delete config.modResults.PuzzleLocalMode;
    }
    return config;
  });
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android application is missing');
    application['meta-data'] = (application['meta-data'] ?? []).filter(
      (item) => item.$['android:name'] !== 'jp.puzzlesns.LOCAL_MODE',
    );
    if (enabled)
      application['meta-data'].push({
        $: {
          'android:name': 'jp.puzzlesns.LOCAL_MODE',
          'android:value': 'true',
        },
      });
    return config;
  });
};

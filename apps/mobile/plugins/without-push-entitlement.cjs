const { withEntitlementsPlist } = require('expo/config-plugins');
// Phase 6 uses scheduled local reminders only. Remote push (APNs/FCM) is a separate,
// unapproved cloud gate, so the app must not request the push entitlement yet.
module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (config) => {
    delete config.modResults['aps-environment'];
    return config;
  });
};

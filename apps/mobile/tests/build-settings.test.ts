import {
  localSettingsSchema,
  validateNativeRegistration,
} from '../src/build-settings';
const settings = {
  projectId: 'demo-puzzle-sns-development',
  iosServices: 'local.plist',
  androidServices: 'local.json',
  legal: {
    version: 'v1',
    terms: 'https://example.com/terms',
    privacy: 'https://example.com/privacy',
    community: 'https://example.com/community',
  },
};
test('rejects shared projects, non-HTTPS legal pages, production and staging emulators', () => {
  expect(localSettingsSchema.safeParse({ development: settings }).success).toBe(
    true,
  );
  expect(
    localSettingsSchema.safeParse({ development: settings, staging: settings })
      .success,
  ).toBe(false);
  expect(
    localSettingsSchema.safeParse({
      staging: { ...settings, emulatorHost: 'localhost' },
    }).success,
  ).toBe(false);
  expect(localSettingsSchema.safeParse({ production: settings }).success).toBe(
    false,
  );
  expect(
    localSettingsSchema.safeParse({
      development: {
        ...settings,
        legal: { ...settings.legal, terms: 'http://example.com' },
      },
    }).success,
  ).toBe(false);
});

test('checks native registration files against the selected Firebase project and app ID', () => {
  const projectId = 'demo-puzzle-sns-development';
  const bundle = 'jp.puzzlesns.app.development';
  const android = {
    project_info: { project_id: projectId },
    client: [
      { client_info: { android_client_info: { package_name: bundle } } },
    ],
  };
  const apple = `<plist><key>PROJECT_ID</key>\n<string>${projectId}</string><key>BUNDLE_ID</key>\n<string>${bundle}</string></plist>`;
  expect(() =>
    validateNativeRegistration(projectId, 'development', android, apple),
  ).not.toThrow();
  expect(() =>
    validateNativeRegistration(projectId, 'staging', android, apple),
  ).toThrow();
  expect(() =>
    validateNativeRegistration(
      'different-project',
      'development',
      android,
      apple,
    ),
  ).toThrow();
});

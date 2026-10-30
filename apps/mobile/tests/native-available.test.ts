import { requireOptionalNativeModule } from 'expo-modules-core';
import { hasNativeModule } from '../src/native-available';
import { notificationPermission } from '../src/notifications/scheduler';
import { sqliteGalleryStore } from '../src/gallery/store';

const mockLoaded: string[] = [];
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual<typeof import('expo-modules-core')>(
    'expo-modules-core',
  ),
  requireOptionalNativeModule: jest.fn(() => null),
}));
// In an older binary these packages throw while initializing; importing them must not happen.
jest.mock('expo-notifications', () => {
  mockLoaded.push('expo-notifications');
  throw new Error("Cannot find native module 'ExpoPushTokenManager'");
});
jest.mock('expo-sqlite', () => {
  mockLoaded.push('expo-sqlite');
  throw new Error("Cannot find native module 'ExpoSQLite'");
});
jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///documents' },
  Directory: class {
    uri = 'file:///documents/gallery';
    create() {}
  },
  File: class {},
}));

test('an older binary without the native modules never initializes those packages', async () => {
  expect(hasNativeModule('ExpoSQLite')).toBe(false);
  expect(await notificationPermission()).toBe('unavailable');
  await expect(sqliteGalleryStore('gallery').list()).rejects.toThrow(
    'Gallery storage unavailable in this build',
  );
  expect(mockLoaded).toEqual([]);
});

test('all named modules must be present', () => {
  jest
    .mocked(requireOptionalNativeModule)
    .mockImplementation((name: string) => (name === 'A' ? {} : null));
  expect(hasNativeModule('A')).toBe(true);
  expect(hasNativeModule('A', 'B')).toBe(false);
});

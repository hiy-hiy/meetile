import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * True when this binary contains the native module. A JS package whose native part is missing
 * (an older development build) throws while its module initializes, and the development runtime
 * reports that as a fatal error even if the import promise is caught, so check before importing.
 */
export function hasNativeModule(...names: string[]): boolean {
  try {
    return names.every((name) => requireOptionalNativeModule(name) !== null);
  } catch {
    return false;
  }
}

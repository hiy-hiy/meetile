import {
  eraseOwnData,
  resetInstallation,
  type InstallationReset,
  type OwnDataEraser,
} from '../src/installation';
function setup(fresh: boolean) {
  const calls: string[] = [];
  const port: InstallationReset = {
    needsReset: async () => fresh,
    signOut: async () => {
      calls.push('signOut');
    },
    removeSecureData: async () => {
      calls.push('secure');
    },
    purgeImages: () => {
      calls.push('cache');
    },
    commit: async () => {
      calls.push('commit');
    },
  };
  return { port, calls };
}
test('fresh install erases residual credentials and private cache before committing its marker', async () => {
  const { port, calls } = setup(true);
  await resetInstallation(port);
  expect(calls).toEqual(['signOut', 'secure', 'cache', 'commit']);
});
test('ordinary update keeps own credentials without invoking reset operations', async () => {
  const { port, calls } = setup(false);
  await resetInstallation(port);
  expect(calls).toEqual([]);
});
test('failure leaves marker uncommitted so the next launch retries erasure', async () => {
  const { port, calls } = setup(true);
  port.removeSecureData = async () => {
    throw new Error('Artificial keychain failure');
  };
  await expect(resetInstallation(port)).rejects.toThrow();
  expect(calls).toEqual(['signOut']);
});
test('ended-use erasure attempts every store even when one fails, then reports the failure', async () => {
  const calls: string[] = [];
  const port: OwnDataEraser = {
    removeSecureData: async (): Promise<void> => {
      calls.push('secure');
      throw new Error('Artificial keychain failure');
    },
    purgeImages: () => {
      calls.push('cache');
    },
    signOut: async () => {
      calls.push('signOut');
    },
  };
  await expect(eraseOwnData(port)).rejects.toThrow();
  expect(calls).toEqual(['secure', 'cache', 'signOut']);
  calls.length = 0;
  port.removeSecureData = async () => {
    calls.push('secure');
  };
  await expect(eraseOwnData(port)).resolves.toBeUndefined();
  expect(calls).toEqual(['secure', 'cache', 'signOut']);
});

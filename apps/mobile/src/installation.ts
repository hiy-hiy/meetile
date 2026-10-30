export interface InstallationReset {
  needsReset: () => Promise<boolean>;
  signOut: () => Promise<void>;
  removeSecureData: () => Promise<void>;
  purgeImages: () => void;
  commit: () => Promise<void>;
}
/** Commit only after erasing residual credentials; a failed/crashed reset retries on next launch. */
export async function resetInstallation(
  port: InstallationReset,
): Promise<void> {
  if (!(await port.needsReset())) return;
  await port.signOut();
  await port.removeSecureData();
  port.purgeImages();
  await port.commit();
}
export interface OwnDataEraser {
  removeSecureData: () => Promise<void>;
  purgeImages: () => void;
  signOut: () => Promise<void>;
}
/**
 * Erase own device data after the server accepted account termination.
 * Every step is attempted even if an earlier one fails, so one broken store
 * cannot leave the others behind; the failure is reported afterwards.
 */
export async function eraseOwnData(port: OwnDataEraser): Promise<void> {
  let failed = false;
  const attempt = async (step: () => void | Promise<void>) => {
    try {
      await step();
    } catch {
      failed = true;
    }
  };
  await attempt(() => port.removeSecureData());
  await attempt(() => port.purgeImages());
  await attempt(() => port.signOut());
  if (failed) throw new Error('Own data erasure incomplete');
}

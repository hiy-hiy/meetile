/** Firestore TTL metadata is storage-only; the FIT view contract (`fitViewSchema`) excludes it. */
export function fitViewData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const view: Record<string, unknown> = { ...value };
  delete view.expireAt;
  return view;
}

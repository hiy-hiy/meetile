'use client';
export async function api(operation: string, body?: unknown) {
  const response = await fetch('/api/admin?' + operation, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Puzzle-Admin': '1',
          },
          body: JSON.stringify(body),
        }),
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok)
    throw new Error(
      '操作できません。ログイン・権限・接続状態を確認し、もう一度お試しください。',
    );
  return response.json() as Promise<unknown>;
}
export function time(ms: number) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(ms);
}

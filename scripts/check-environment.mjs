import { readFile } from 'node:fs/promises';
export function validateProjects(config) {
  const names = ['development', 'staging', 'production'];
  const ids = names.map((name) => config[name]?.projectId);
  if (
    ids.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id) ||
        id.startsWith('demo-'),
    ) ||
    new Set(ids).size !== 3
  )
    throw new Error('Three distinct real project IDs are required');
  for (const name of names) {
    if (
      config[name].budgetApproved !== true ||
      !Number.isSafeInteger(config[name].maxInstances) ||
      config[name].maxInstances < 1 ||
      config[name].region !== 'asia-northeast1'
    )
      throw new Error(
        'Budget approval, maxInstances and Tokyo region are required',
      );
  }
  return config;
}
if (process.argv[1]?.endsWith('check-environment.mjs')) {
  validateProjects(
    JSON.parse(await readFile('firebase/projects.local.json', 'utf8')),
  );
  console.log(
    'Environment mapping verified; this command does not deploy or create services.',
  );
}

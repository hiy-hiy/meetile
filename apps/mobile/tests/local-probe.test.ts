import { probeAddress, verifyProbe } from '../src/local/probe';
const probe = 'e54f47e8-0d7a-4d70-b1c0-d469ff950f05';
const project = 'demo-puzzle-sns-local';
const settings = {
  mode: 'local',
  projectId: project,
  host: '192.168.1.2',
  iosServices: 'local.plist',
  androidServices: 'local.json',
};
test('builds only the fixed demo endpoint after native, Debug, and registration checks', () => {
  expect(probeAddress(settings, true, true, project, probe)).toBe(
    `http://192.168.1.2:15001/${project}/asia-northeast1/localHealth?probe=${probe}`,
  );
  expect(() => probeAddress(settings, false, true, project, probe)).toThrow();
  expect(() => probeAddress(settings, true, false, project, probe)).toThrow();
  expect(() =>
    probeAddress(settings, true, true, 'real-project', probe),
  ).toThrow();
  expect(() => probeAddress(undefined, true, true, project, probe)).toThrow();
  expect(() =>
    probeAddress(
      { ...settings, projectId: 'real-project' },
      true,
      true,
      project,
      probe,
    ),
  ).toThrow();
});
test('rejects wrong modes, projects, protocol, stale probes, and invalid server identities', () => {
  const response = {
    mode: 'local',
    projectId: project,
    protocol: 2,
    runId: probe,
    probe,
  };
  expect(() => verifyProbe(response, probe)).not.toThrow();
  for (const changed of [
    { mode: 'cloud' },
    { projectId: 'real-project' },
    { protocol: 1 },
    { probe: 'b7b910bb-f3bf-4be3-82fe-a2ee8700f946' },
    { runId: 'invalid' },
  ])
    expect(() => verifyProbe({ ...response, ...changed }, probe)).toThrow();
});
test('build resolution defaults to cloud and refuses staging local bundles', () => {
  const { runtimeFiles } = jest.requireActual<{
    runtimeFiles(mode?: string, variant?: string): Record<string, string>;
  }>('../runtime-files.cjs');
  expect(
    Object.values(runtimeFiles()).every((path) =>
      path.startsWith('src/cloud/'),
    ),
  ).toBe(true);
  expect(
    Object.values(runtimeFiles('local')).every((path) =>
      path.startsWith('src/local/'),
    ),
  ).toBe(true);
  expect(() => runtimeFiles('local', 'staging')).toThrow();
});

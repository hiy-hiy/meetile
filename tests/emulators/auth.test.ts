import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { execFileSync } from 'node:child_process';
import { backend, PROJECT, reset } from './helpers';

beforeEach(reset);
test('real anonymous Auth Emulator token verifies; callable rejects it without App Check', async () => {
  const app = initializeApp(
    {
      projectId: PROJECT,
      apiKey: 'emulator-only',
      authDomain: `${PROJECT}.firebaseapp.com`,
    },
    'auth-test',
  );
  try {
    const auth = getAuth(app);
    connectAuthEmulator(
      auth,
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`,
      { disableWarnings: true },
    );
    const credential = await signInAnonymously(auth);
    const token = await credential.user.getIdToken();
    const verifier = `
      const { initializeApp } = require('firebase-admin/app');
      const { getAuth } = require('firebase-admin/auth');
      const token = require('node:fs').readFileSync(0, 'utf8');
      (async () => {
        const decoded = await getAuth(initializeApp({ projectId: '${PROJECT}' })).verifyIdToken(token);
        if (decoded.uid !== process.argv[1] || decoded.firebase.sign_in_provider !== 'anonymous') throw new Error('Wrong identity');
        for (const projectId of ['demo-puzzle-sns-staging', 'demo-puzzle-sns-production']) {
          const other = getAuth(initializeApp({ projectId }, projectId));
          await other.verifyIdToken(token).then(() => { throw new Error('Cross-project token accepted'); }, error => {
            if (error.code !== 'auth/argument-error') throw error;
          });
        }
      })().catch(() => process.exitCode = 1);
    `;
    execFileSync(process.execPath, ['-e', verifier, credential.user.uid], {
      input: token,
      timeout: 30000,
    });
    expect(await backend.getDayState(credential.user.uid)).toMatchObject({
      photoState: 'not-created',
    });
    const response = await fetch(
      `http://127.0.0.1:5001/${PROJECT}/asia-northeast1/getDayState`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ data: {} }),
      },
    );
    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: { status: 'UNAUTHENTICATED' } });
  } finally {
    await deleteApp(app);
  }
});

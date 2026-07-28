import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { verifyAppLicense, type AppLicenseClaims } from './index.js';

test('verifies an EdDSA app license and enforces features', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const claims: AppLicenseClaims = { scope: 'app-license', iss: 'privos-marketplace', aud: 'demo-app', installationId: 'i1', workspaceId: 'w1', listingId: 'l1', tier: 'pro', features: ['export'], serial: 's1', iat: 1, exp: 100 };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey).toString('base64url');
  const license = verifyAppLicense(`${signingInput}.${signature}`, publicKey.export({ type: 'spki', format: 'pem' }).toString(), { audience: 'demo-app', now: 50 });
  assert.equal(license.hasFeature('export'), true);
  assert.throws(() => license.requireFeature('admin'));
});

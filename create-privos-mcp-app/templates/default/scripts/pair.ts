/**
 * `npm run pair`: connects this app to a workspace, once.
 *
 * The workspace admin issues a one-time pairing URL (Admin > Apps). Paste it
 * when asked: it is read from standard input and never from the command line,
 * so it does not land in shell history. The app announces its `privos-app.json`
 * over the pairing socket, then this command waits until an admin approves the
 * permissions in the workspace. On approval it writes the identity file
 * (`privos-standalone-identity.json`, mode 0600) that `npm run dev` and
 * `npm start` both pick up. It holds relay credentials and dispatch trust:
 * never commit it, copy it or put its contents in an environment file.
 *
 * There is one pairing for development and production alike. To pair again,
 * uninstall the app in the workspace and delete the identity file first.
 */
import readline from 'node:readline';

import { buildPairingMetadata, pairAndAwaitApproval, standaloneIdentityFileExists } from '@privos_ai/app-server';

import { buildDescriptor, loadManifest } from '../src/manifest.js';

async function readPairingUrl(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin });
  process.stdout.write('One-time pairing URL from the workspace (Admin > Apps): ');
  for await (const line of rl) {
    rl.close();
    return line.trim();
  }
  return '';
}

async function main(): Promise<void> {
  if (standaloneIdentityFileExists()) {
    throw new Error(
      'This app is already paired: the identity file exists. To pair again, uninstall the app in the workspace and delete privos-standalone-identity.json.',
    );
  }

  const pairingUrl = await readPairingUrl();
  try {
    new URL(pairingUrl);
  } catch {
    throw new Error('That is not a pairing URL.');
  }

  const manifest = loadManifest();
  console.log('\nRegistering. Once it is registered, approve the permissions in the workspace (Admin > Apps).');
  console.log('This command keeps waiting for the approval.');
  const paired = await pairAndAwaitApproval(
    pairingUrl,
    { ...buildPairingMetadata(buildDescriptor(manifest)), manifest: manifest as unknown as Record<string, unknown> },
    undefined,
    { onAwaitingApproval: () => process.stdout.write('.') },
  );

  if (paired.state !== 'complete' || !paired.identityFilePath) {
    throw new Error('The workspace did not return dispatch trust, so no identity file was written. It has to support standalone pairing.');
  }
  console.log(`\nPaired. Identity saved to ${paired.identityFilePath}`);
  console.log(`Check the fingerprint ${paired.fingerprint} with the person who issued the pairing URL before you rely on this pairing.`);
  console.log('Run the app with "npm run dev" (live UI) or "npm start" (built UI, after "npm run build").');
}

main().catch((error) => {
  console.error(`\nPairing failed: ${String(error instanceof Error ? error.message : error).replace(/^Pairing failed: /, '')}`);
  process.exit(1);
});

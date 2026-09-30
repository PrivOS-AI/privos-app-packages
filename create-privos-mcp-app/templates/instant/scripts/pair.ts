/**
 * `npm run pair`: connects this INSTANT app's preview to a workspace, once.
 *
 * The workspace admin issues a one-time pairing URL (Admin > Apps). Paste it
 * when asked: it is read from standard input and never from the command line,
 * so it does not land in shell history. The app announces its relay manifest
 * (`privos-app.json` plus one UI-only tool per entry point, see
 * relay-manifest.ts) over the pairing socket, then this command waits until an
 * admin approves the permissions in the workspace. On approval it writes the
 * identity file (`privos-standalone-identity.json`, mode 0600) that
 * `npm run dev` picks up. It holds relay credentials and dispatch trust: never
 * commit it, copy it or put its contents in an environment file.
 *
 * To pair again, uninstall the app in the workspace and delete the identity
 * file first. The Relay copy also blocks a marketplace install of the same app
 * id in that workspace: uninstall it before installing from the marketplace.
 */
import { existsSync } from 'node:fs';
import readline from 'node:readline';

import {
  buildPairingMetadata,
  pairAndAwaitApproval,
  resolveStandalonePendingIdentityFilePath,
  standaloneIdentityFileExists,
} from '@privos_ai/app-server';

import { buildDescriptor, buildRelayManifest, loadManifest } from './relay-manifest.js';

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

  const pendingFile = resolveStandalonePendingIdentityFilePath();
  if (existsSync(pendingFile)) {
    throw new Error(
      `An earlier pairing was started and never finished (${pendingFile} exists). Remove the half-registered app in the workspace (Admin > Apps), delete that file, and pair again with a new URL.`,
    );
  }

  const pairingUrl = await readPairingUrl();
  try {
    new URL(pairingUrl);
  } catch {
    throw new Error('That is not a pairing URL.');
  }

  const manifest = buildRelayManifest(loadManifest());
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
  console.log('Preview the app with "npm run dev".');
}

main().catch((error) => {
  console.error(`\nPairing failed: ${String(error instanceof Error ? error.message : error).replace(/^Pairing failed: /, '')}`);
  process.exit(1);
});

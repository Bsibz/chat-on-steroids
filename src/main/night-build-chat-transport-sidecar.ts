import { randomBytes } from 'node:crypto';
import process from 'node:process';

import { createNightBuildChatTransportSource } from './night-build-chat-transport-source.js';
import { startNightBuildChatTransportV1 } from './night-build-chat-transport-v1.js';
import { ownerStillCurrent, proveInstalledCoSOwner } from './night-build-bridge-owner.js';

function userDataArg(argv: string[]): string {
  const index = argv.indexOf('--user-data');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || !value.startsWith('/')) throw new Error('Usage: night-build:chat-sidecar -- --user-data /absolute/path');
  return value;
}

async function main(): Promise<void> {
  const userData = userDataArg(process.argv.slice(2));
  const owner = await proveInstalledCoSOwner(userData);
  const source = createNightBuildChatTransportSource(userData, randomBytes(32).toString('base64url'));
  const handle = await startNightBuildChatTransportV1(userData, source, {
    appVersion: owner.appVersion,
    ownerIsCurrent: ownerStillCurrent(userData, owner)
  });
  let stopping: Promise<void> | null = null;
  const stop = (): void => {
    if (!stopping) stopping = handle.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(() => { process.exitCode = 1; });

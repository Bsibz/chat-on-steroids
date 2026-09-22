import process from 'node:process';

import { createDurableSidecarSource } from './night-build-bridge-sidecar-source.js';
import { ownerStillCurrent, proveInstalledCoSOwner } from './night-build-bridge-owner.js';
import { startNightBuildBridgeV2 } from './night-build-bridge-v2.js';

function userDataArg(argv: string[]): string {
  const index = argv.indexOf('--user-data');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || !value.startsWith('/')) throw new Error('Usage: night-build:sidecar -- --user-data /absolute/path');
  return value;
}

async function main(): Promise<void> {
  const userData = userDataArg(process.argv.slice(2));
  const owner = await proveInstalledCoSOwner(userData);
  const source = createDurableSidecarSource(userData, owner);
  const handle = await startNightBuildBridgeV2(userData, source, {
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

void main().catch(() => {
  // This executable is intentionally quiet: userData paths, process facts and parser details
  // are local diagnostics and must never become a sidecar log surface.
  process.exitCode = 1;
});

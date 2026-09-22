import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const INSTALLED_COS_EXECUTABLE = '/Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids';
export const INSTALLED_COS_INFO_PLIST = '/Applications/Chat On Steroids.app/Contents/Info.plist';

const execFile = promisify(execFileCallback);

export interface InstalledCoSOwner {
  pid: number;
  startedAt: number;
  appVersion: string;
}

export interface InstalledCoSOwnerDeps {
  readLink(file: string): Promise<string>;
  readFile(file: string): Promise<string>;
  processInfo(pid: number): Promise<{ command: string; startedAt: number } | null>;
}

async function defaultProcessInfo(pid: number): Promise<{ command: string; startedAt: number } | null> {
  try {
    const result = await execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
    const line = result.stdout.trim();
    const match = /^(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) return null;
    const startedAt = Date.parse(match[1]!);
    const command = match[2]!.trim();
    if (!command || !Number.isFinite(startedAt)) return null;
    return { command, startedAt };
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: InstalledCoSOwnerDeps = {
  readLink: (file) => fs.readlink(file),
  readFile: (file) => fs.readFile(file, 'utf8'),
  processInfo: defaultProcessInfo
};

function pidFromSingletonLock(target: string): number {
  const match = /-(\d{1,10})$/.exec(target);
  if (!match) throw new Error('owner_singleton_lock_invalid');
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('owner_pid_invalid');
  return pid;
}

function installedVersion(plist: string): string {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,64})<\/string>/.exec(plist);
  const value = match?.[1]?.trim() ?? '';
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value)) throw new Error('owner_version_invalid');
  return value;
}

export async function proveInstalledCoSOwner(userData: string, deps: InstalledCoSOwnerDeps = DEFAULT_DEPS): Promise<InstalledCoSOwner> {
  if (process.platform !== 'darwin' && deps === DEFAULT_DEPS) throw new Error('owner_platform_unsupported');
  const target = await deps.readLink(path.join(userData, 'SingletonLock'));
  const pid = pidFromSingletonLock(target);
  const processInfo = await deps.processInfo(pid);
  if (!processInfo || processInfo.command !== INSTALLED_COS_EXECUTABLE) throw new Error('owner_process_mismatch');
  if (!Number.isSafeInteger(processInfo.startedAt) || processInfo.startedAt <= 0) throw new Error('owner_start_invalid');
  const appVersion = installedVersion(await deps.readFile(INSTALLED_COS_INFO_PLIST));
  return { pid, startedAt: processInfo.startedAt, appVersion };
}

export function ownerStillCurrent(userData: string, owner: InstalledCoSOwner, deps: InstalledCoSOwnerDeps = DEFAULT_DEPS): () => Promise<boolean> {
  return async () => {
    try {
      const target = await deps.readLink(path.join(userData, 'SingletonLock'));
      const pid = pidFromSingletonLock(target);
      if (pid !== owner.pid) return false;
      const processInfo = await deps.processInfo(pid);
      if (processInfo?.command !== INSTALLED_COS_EXECUTABLE || processInfo.startedAt !== owner.startedAt) return false;
      return installedVersion(await deps.readFile(INSTALLED_COS_INFO_PLIST)) === owner.appVersion;
    } catch {
      return false;
    }
  };
}

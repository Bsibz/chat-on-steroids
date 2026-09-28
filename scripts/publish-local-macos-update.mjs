/**
 * Build/publish one owner-local macOS update without touching the installed app.
 *
 * --build is the normal path: run complete source verification, package this machine's
 * architecture, prove packaged native/runtime/GUI surfaces, then publish the exact ZIP into
 * the fixed userData LocalUpdateChannel. The installed app remains untouched until its own
 * updater shows the candidate and the owner explicitly presses Install.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

if (process.platform !== 'darwin') throw new Error('Local macOS updates must be published on macOS, got ' + process.platform);
if (process.arch !== 'arm64' && process.arch !== 'x64') throw new Error('Unsupported macOS architecture: ' + process.arch);

const build = process.argv.includes('--build');
const arch = process.arch;
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Package version is not a release version: ' + version);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      path.basename(command) + ' ' + args.join(' ') + ' exited ' + result.status + ':\n' +
      (result.stderr || result.stdout || '(no output)')
    );
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

const LOCAL_BUNDLE_ID = 'com.chatonsteroids.app';

function appleDevelopmentIdentity() {
  const output = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = output
    .split('\n')
    .map((line) => /"([^"]+)"/.exec(line)?.[1] ?? '')
    .filter((name) => name.startsWith('Apple Development:'));
  const pinned = (process.env.COS_APPLE_DEVELOPMENT_IDENTITY ?? '').trim();
  const teamPin = (process.env.COS_DEVELOPMENT_TEAM ?? '').trim();
  const candidates = pinned
    ? identities.filter((name) => name === pinned)
    : teamPin
      ? identities.filter((name) => name.includes(`(${teamPin})`))
      : identities;
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? 'Local macOS dogfood requires exactly one Apple Development signing identity (or COS_APPLE_DEVELOPMENT_IDENTITY/COS_DEVELOPMENT_TEAM pin)'
        : 'Multiple Apple Development identities found; pin one with COS_APPLE_DEVELOPMENT_IDENTITY or COS_DEVELOPMENT_TEAM: ' + candidates.join('; ')
    );
  }
  return candidates[0];
}

function teamFromIdentity(identity) {
  const pem = run('/usr/bin/security', ['find-certificate', '-c', identity, '-p']);
  const subject = run('/usr/bin/openssl', ['x509', '-noout', '-subject'], { input: pem });
  const match = /\bOU=([A-Z0-9]{10})\b/.exec(subject);
  if (!match) throw new Error('Apple Development certificate is missing a 10-character Team ID (OU): ' + subject);
  return match[1];
}

function stableRequirementExpression(team) {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('Invalid Apple Team ID: ' + team);
  return (
    `identifier "${LOCAL_BUNDLE_ID}" and anchor apple generic and ` +
    'certificate 1[field.1.2.840.113635.100.6.2.1] and ' +
    'certificate leaf[field.1.2.840.113635.100.6.1.12] and ' +
    `certificate leaf[subject.OU] = ${team}`
  );
}

function stableRequirement(team) {
  return 'designated => ' + stableRequirementExpression(team);
}

function codesignOutput(app, requirement = false) {
  const args = requirement ? ['-d', '-r-', app] : ['-dv', '--verbose=4', app];
  const result = spawnSync('/usr/bin/codesign', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('codesign inspection failed for ' + app + ': ' + (result.stderr || result.stdout || result.error?.message || result.status));
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function inspectDevelopmentSignature(app) {
  const dump = codesignOutput(app);
  const requirementOutput = codesignOutput(app, true);
  const value = (prefix) =>
    dump.split('\n').find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
  const authority = dump
    .split('\n')
    .filter((line) => line.startsWith('Authority='))
    .map((line) => line.slice('Authority='.length).trim());
  // codesign writes its Executable= diagnostic and requirement to the same captured stream.
  // Keep only the one designated-requirement line so manifest metadata never absorbs an
  // unrelated absolute staging path after it.
  const requirementLine = requirementOutput
    .split('\n')
    .find((line) => line.includes('designated =>')) ?? '';
  const designatedRequirement = requirementLine.includes('=>')
    ? requirementLine.slice(requirementLine.indexOf('=>') + 2).trim()
    : '';
  return {
    signingIdentifier: value('Identifier='),
    teamIdentifier: value('TeamIdentifier='),
    signature: value('Signature='),
    authority,
    designatedRequirement
  };
}

function assertDevelopmentSignature(app, expected = {}) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const fields = inspectDevelopmentSignature(app);
  if (fields.signature.toLowerCase() === 'adhoc' || !fields.authority.some((item) => item.startsWith('Apple Development:'))) {
    throw new Error('Local dogfood app is not Apple Development signed: ' + JSON.stringify(fields));
  }
  if (fields.signingIdentifier !== LOCAL_BUNDLE_ID) {
    throw new Error('Local dogfood signing identifier is ' + fields.signingIdentifier + ', expected ' + LOCAL_BUNDLE_ID);
  }
  if (!/^[A-Z0-9]{10}$/.test(fields.teamIdentifier)) {
    throw new Error('Local dogfood signature has no stable TeamIdentifier');
  }
  if (
    !fields.designatedRequirement.includes(`identifier "${LOCAL_BUNDLE_ID}"`) ||
    !fields.designatedRequirement.includes(`certificate leaf[subject.OU] = ${fields.teamIdentifier}`)
  ) {
    throw new Error('Local dogfood designated requirement is not team-stable: ' + fields.designatedRequirement);
  }
  if (expected.teamIdentifier && fields.teamIdentifier !== expected.teamIdentifier) {
    throw new Error('Local dogfood TeamIdentifier changed: ' + fields.teamIdentifier + ' != ' + expected.teamIdentifier);
  }
  // codesign's -dr text is a diagnostic serialization, not a byte-stable API. Verify the code
  // against the exact semantic requirement instead of comparing two textual renderings.
  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '-R=' + stableRequirementExpression(expected.teamIdentifier || fields.teamIdentifier),
    app
  ]);
  return fields;
}

function signLocalDogfood(app) {
  const identity = appleDevelopmentIdentity();
  const team = teamFromIdentity(identity);
  const requirement = stableRequirement(team);
  run('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    identity,
    '--identifier',
    LOCAL_BUNDLE_ID,
    '--timestamp=none',
    '--requirements',
    '=' + requirement,
    app
  ]);
  return { identity, ...assertDevelopmentSignature(app, { teamIdentifier: team }) };
}

if (build) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run the build path through npm so the exact npm CLI can be reused for verification');
  run(process.execPath, [npmCli, 'run', 'verify:ci'], { stdio: 'inherit', encoding: undefined });
  run(process.execPath, ['scripts/package.mjs', '--platform', 'darwin', '--arch', arch], {
    stdio: 'inherit',
    encoding: undefined
  });
}

const unpacked = path.join(root, 'release', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Chat On Steroids.app');
const releaseZip = path.join(root, 'release', 'Chat-On-Steroids-macOS-' + arch + '.zip');
if (!existsSync(unpacked)) throw new Error('Missing packaged app: ' + unpacked + '. Run with --build or package macOS first.');
if (!existsSync(releaseZip)) throw new Error('Missing packaged ZIP: ' + releaseZip + '. Run with --build or package macOS first.');

// Prove the exact unpacked payload, its native runtime, and a real isolated GUI launch.
run(process.execPath, ['scripts/smoke-packaged-runtime.mjs', '--platform', 'darwin', '--arch', arch], {
  stdio: 'inherit',
  encoding: undefined
});
run(process.execPath, ['scripts/smoke-macos-bundle.mjs', arch, unpacked], { stdio: 'inherit', encoding: undefined });
run(process.execPath, ['scripts/smoke-macos-gui.mjs', arch], { stdio: 'inherit', encoding: undefined });

const gitSHA = run('git', ['rev-parse', 'HEAD']);
const branch = run('git', ['branch', '--show-current']) || '(detached)';
const workingTreeDirty = run('git', ['status', '--porcelain']).length > 0;
const artifact = 'Chat-On-Steroids-macOS-' + arch + '-' + version + '.zip';
const localStage = mkdtempSync(path.join(os.tmpdir(), 'cos-local-signed-'));
try {
  // Public macOS packaging intentionally remains ad-hoc/unnotarized. Local owner dogfood gets
  // its own copy with a stable Apple Development identity so TCC Accessibility/Screen Recording
  // grants bind to team + bundle identifier instead of this build's changing CDHash.
  const signedApp = path.join(localStage, 'Chat On Steroids.app');
  run('/usr/bin/ditto', [unpacked, signedApp]);
  const signing = signLocalDogfood(signedApp);
  run(process.execPath, ['scripts/smoke-macos-bundle.mjs', arch, signedApp, '--allow-apple-development'], {
    stdio: 'inherit',
    encoding: undefined
  });
  run(process.execPath, ['scripts/smoke-macos-gui.mjs', arch, signedApp], { stdio: 'inherit', encoding: undefined });

  const localZip = path.join(localStage, artifact);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', signedApp, localZip]);

  // The updater installs the ZIP, not the staged app directly. Extract and audit that exact signed
  // artifact so archive creation cannot drop modes, resources, or the stable signing requirement.
  const extracted = path.join(localStage, 'extracted');
  mkdirSync(extracted);
  run('/usr/bin/ditto', ['-x', '-k', localZip, extracted]);
  const extractedApp = path.join(extracted, 'Chat On Steroids.app');
  if (!existsSync(extractedApp)) throw new Error('Packaged ZIP does not contain Chat On Steroids.app at its root');
  run(process.execPath, ['scripts/smoke-macos-bundle.mjs', arch, extractedApp, '--allow-apple-development'], {
    stdio: 'inherit',
    encoding: undefined
  });
  assertDevelopmentSignature(extractedApp, signing);

  const extensionManifest = JSON.parse(
    readFileSync(path.join(extractedApp, 'Contents', 'Resources', 'extension', 'manifest.json'), 'utf8')
  );
  if (extensionManifest.version !== version) {
    throw new Error('Packaged extension ' + (extensionManifest.version || '(missing)') + ' does not match app ' + version);
  }
  const digest = createHash('sha256').update(readFileSync(localZip)).digest('hex');
  const channel = path.join(os.homedir(), 'Library', 'Application Support', 'chat-on-steroids', 'LocalUpdateChannel');
  mkdirSync(channel, { recursive: true, mode: 0o700 });
  chmodSync(channel, 0o700);

  const artifactTarget = path.join(channel, artifact);
  const artifactPart = artifactTarget + '.part';
  const manifestTarget = path.join(channel, 'manifest.json');
  const manifestPart = manifestTarget + '.part';
  rmSync(artifactPart, { force: true });
  rmSync(manifestPart, { force: true });
  copyFileSync(localZip, artifactPart);
  chmodSync(artifactPart, 0o600);
  const copiedDigest = createHash('sha256').update(readFileSync(artifactPart)).digest('hex');
  if (copiedDigest !== digest) {
    rmSync(artifactPart, { force: true });
    throw new Error('Local update archive changed while copying into the channel');
  }
  renameSync(artifactPart, artifactTarget);

  const manifest = {
    schemaVersion: 1,
    channel: 'local-development',
    version,
    arch,
    artifact,
    sha256: digest,
    bundleIdentifier: LOCAL_BUNDLE_ID,
    developmentSigningIdentity: signing.identity,
    teamIdentifier: signing.teamIdentifier,
    signingIdentifier: signing.signingIdentifier,
    designatedRequirement: signing.designatedRequirement,
    sourceGitSHA: gitSHA,
    sourceBranch: branch,
    workingTreeDirty,
    publishedAt: new Date().toISOString()
  };
  writeFileSync(manifestPart, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  renameSync(manifestPart, manifestTarget);

  // Manifest publication is the commit point. Only after it points at the new version can old local
  // artifacts be retired; a concurrent app read always has either the complete old pair or new pair.
  for (const name of readdirSync(channel)) {
    if (name.startsWith('Chat-On-Steroids-macOS-') && name.endsWith('.zip') && name !== artifact) {
      rmSync(path.join(channel, name), { force: true });
    }
  }

  process.stdout.write(
    [
      'Published local Chat On Steroids ' + version + ' (' + arch + ')',
      '  artifact: ' + artifact,
      '  sha256: ' + digest,
      '  signing identity: ' + signing.identity,
      '  team identifier: ' + signing.teamIdentifier,
      '  designated requirement: ' + signing.designatedRequirement,
      '  source: ' + gitSHA.slice(0, 12) + ' ' + branch + (workingTreeDirty ? ' (dirty local snapshot)' : ''),
      '  installed app: untouched',
      'Use the verified local updater to install it.'
    ].join('\n') + '\n'
  );
} finally {
  rmSync(localStage, { recursive: true, force: true });
}

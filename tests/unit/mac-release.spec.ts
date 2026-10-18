import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAC_RELEASE_SIGN_IGNORE,
  MAC_SIGNING_IDENTITY_VARIABLE,
  codesignDetailProblems,
  electronBuilderReleaseArgs,
  macReleaseAppPath,
  macReleaseDmgPath,
  macReleaseZipPath,
  macReleaseAuthority,
  macReleasePreflightProblems,
  macReleaseSigner,
  notarizeMacReleaseDmg,
  parseMacReleaseArches,
  parseNotarySubmission,
  verifyMacReleaseApp,
  verifyMacReleaseZip,
  type MacReleaseSigner,
  type ToolResult,
} from '../../electron.mac-release';
import type { PortableValue } from '@shared/models/portable';

/**
 * The signed macOS release path must refuse, visibly, whenever its signing or
 * notarization inputs are missing or ambiguous, whenever it would build
 * something it does not verify, and whenever the final DMG is not accepted,
 * stapled and assessed. electron-builder 26.15.3 on its own only warns.
 */

const repoRoot = join(__dirname, '../..');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));

/** A placeholder Developer ID signer; the real one comes from the release shell's environment. */
const SIGNER: MacReleaseSigner = { identity: 'Jane Doe (ABCDE12345)', teamId: 'ABCDE12345' };
const MAC_RELEASE_AUTHORITY = macReleaseAuthority(SIGNER);
const RELEASE_ENV = { APPLE_KEYCHAIN_PROFILE: 'release-notary', [MAC_SIGNING_IDENTITY_VARIABLE]: SIGNER.identity };

const SIGNED_DETAILS = [
  'Executable=/tmp/Interleaf.app/Contents/MacOS/Interleaf',
  'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded',
  `Authority=${MAC_RELEASE_AUTHORITY}`,
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=ABCDE12345',
].join('\n');

/** A DMG container signature: same signer, no hardened-runtime flag (not applicable to a disk image). */
const DMG_DETAILS = [
  'Executable=/tmp/Interleaf-1.2.3-arm64.dmg',
  'CodeDirectory v=20100 size=179 flags=0x0(none) hashes=1+2 location=embedded',
  `Authority=${MAC_RELEASE_AUTHORITY}`,
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=ABCDE12345',
].join('\n');

type Call = { readonly file: string; readonly args: readonly string[] };

/** Fake tool runner: every command succeeds unless an override matches it. */
function fakeTools(overrides: Partial<Record<string, ToolResult>> = {}) {
  const calls: Call[] = [];
  const run = (file: string, args: readonly string[]): ToolResult => {
    calls.push({ file, args });
    const key = `${file.split('/').pop() ?? file} ${args[0] ?? ''}`;
    const override = overrides[key];
    if (override !== undefined) return override;
    if (key === 'codesign -dvv') return { status: 0, stdout: '', stderr: SIGNED_DETAILS };
    if (key === 'lipo -archs') return { status: 0, stdout: 'arm64\n', stderr: '' };
    if (key === 'xcrun notarytool') return { status: 0, stdout: '{"id":"abc-123","status":"Accepted","message":"Processing complete"}', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const steps = () => calls.map((call) => `${call.file.split('/').pop() ?? ''} ${call.args.slice(0, 2).join(' ')}`);
  return { run, calls, steps };
}

describe('macOS release preflight', () => {
  it('accepts macOS with only the keychain profile and signing identity set', () => {
    expect(macReleasePreflightProblems(RELEASE_ENV, 'darwin')).toEqual([]);
  });

  it('refuses when the notary profile is missing or blank', () => {
    expect(macReleasePreflightProblems({ ...RELEASE_ENV, APPLE_KEYCHAIN_PROFILE: undefined }, 'darwin')).toHaveLength(1);
    expect(macReleasePreflightProblems({ ...RELEASE_ENV, APPLE_KEYCHAIN_PROFILE: '  ' }, 'darwin')).toHaveLength(1);
  });

  it('refuses a missing or malformed signing identity', () => {
    for (const identity of [undefined, '  ', 'Jane Doe', 'Developer ID Application: Jane Doe (ABCDE12345)', 'Jane Doe (abcde12345)', 'Jane Doe (ABCDE1234)', 'Jane\rDoe (ABCDE12345)', 'Jane\u2028Doe (ABCDE12345)', 'Jane\tDoe (ABCDE12345)']) {
      const problems = macReleasePreflightProblems({ ...RELEASE_ENV, [MAC_SIGNING_IDENTITY_VARIABLE]: identity }, 'darwin');
      expect(problems, String(identity)).toEqual([expect.stringContaining(MAC_SIGNING_IDENTITY_VARIABLE)]);
    }
  });

  it('reads the signer and its team identifier from the identity name', () => {
    expect(macReleaseSigner(RELEASE_ENV)).toEqual(SIGNER);
    expect(macReleaseSigner({ [MAC_SIGNING_IDENTITY_VARIABLE]: '  Jane Doe (ABCDE12345) ' })).toEqual(SIGNER);
    expect(macReleaseSigner({})).toBeUndefined();
  });

  it('refuses off macOS', () => {
    expect(macReleasePreflightProblems(RELEASE_ENV, 'linux')).toHaveLength(1);
  });

  it('refuses a shell that builds update smoke packages', () => {
    const problems = macReleasePreflightProblems({ ...RELEASE_ENV, INTERLEAF_UPDATE_SMOKE_TRUST: '{"origin":"x"}' }, 'darwin');
    expect(problems).toEqual([expect.stringContaining('INTERLEAF_UPDATE_SMOKE_TRUST')]);
    expect(problems.join('')).not.toContain('origin');
  });

  it('refuses competing credentials by name without echoing their values', () => {
    const problems = macReleasePreflightProblems(
      { ...RELEASE_ENV, APPLE_ID: 'someone@example.test', CSC_LINK: 'secret-cert-value' },
      'darwin',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('APPLE_ID');
    expect(problems[0]).toContain('CSC_LINK');
    expect(problems.join('\n')).not.toContain('someone@example.test');
    expect(problems.join('\n')).not.toContain('secret-cert-value');
  });
});

describe('macOS release arguments', () => {
  it('defaults to both configured arches and accepts an explicit subset', () => {
    expect(parseMacReleaseArches([])).toEqual(['arm64', 'x64']);
    expect(parseMacReleaseArches(['--arm64'])).toEqual(['arm64']);
  });

  it('rejects anything but an arch flag', () => {
    expect(() => parseMacReleaseArches(['--dir'])).toThrow(/Unsupported argument/);
    expect(() => parseMacReleaseArches(['-c.mac.identity=null'])).toThrow(/Unsupported argument/);
  });

  it('keeps the checked-in config free of a pinned identity so unsigned smoke builds stay unsigned', () => {
    const config = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8');
    expect(config).toMatch(/^ {2}notarize: true$/m);
    expect(config).not.toMatch(/^\s*identity:/m);
    expect(config).not.toMatch(/^\s*forceCodeSigning:/m);
  });

  it('locates the produced app bundles and DMGs', () => {
    expect(macReleaseAppPath('/repo', 'arm64')).toBe('/repo/release/mac-arm64/Interleaf.app');
    expect(macReleaseAppPath('/repo', 'x64')).toBe('/repo/release/mac/Interleaf.app');
    expect(macReleaseDmgPath('/repo', '1.2.3', 'arm64')).toBe('/repo/release/Interleaf-1.2.3-arm64.dmg');
    expect(macReleaseDmgPath('/repo', '1.2.3', 'x64')).toBe('/repo/release/Interleaf-1.2.3.dmg');
    expect(macReleaseZipPath('/repo', '1.2.3', 'arm64')).toBe('/repo/release/Interleaf-1.2.3-arm64-mac.zip');
    expect(macReleaseZipPath('/repo', '1.2.3', 'x64')).toBe('/repo/release/Interleaf-1.2.3-mac.zip');
  });
});

/**
 * Runs the release argv through the installed electron-builder's own CLI
 * parser and target resolution against the checked-in config, so a change in
 * either (or in the config's target matrix) cannot silently widen the build
 * beyond what the postflight verifies.
 */
describe('installed electron-builder resolution of the release argv', () => {
  const builder = requireFromRepo('electron-builder/out/builder');
  const { computeArchToTargetNamesMap } = requireFromRepo('app-builder-lib/out/targets/targetFactory');
  const { Platform, Arch } = requireFromRepo('app-builder-lib');
  const yaml = requireFromRepo('js-yaml');
  const config = yaml.load(readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8'));

  function resolve(argv: readonly string[]) {
    const options = builder.normalizeOptions(builder.configureBuildCommand(builder.createYargs()).parse([...argv]));
    const archToTargets: Map<number, string[]> = computeArchToTargetNamesMap(
      options.targets.get(Platform.MAC),
      { platformSpecificBuildOptions: config.mac },
      Platform.MAC,
    );
    const targets = [...archToTargets].map(([arch, names]): [string, string[]] => [String(Arch[arch]), names]);
    return { targets, config: options.config as PortableValue };
  }

  it('widens a bare --mac --arm64 to every configured target and arch (the reason target names are explicit)', () => {
    expect(resolve(['--mac', '--arm64']).targets).toEqual([
      ['arm64', ['dmg', 'zip']],
      ['x64', ['dmg', 'zip']],
    ]);
  });

  it('builds exactly the requested arch DMGs and update ZIPs', () => {
    expect(resolve(electronBuilderReleaseArgs(['arm64'], SIGNER)).targets).toEqual([['arm64', ['dmg', 'zip']]]);
    expect(resolve(electronBuilderReleaseArgs(['x64'], SIGNER)).targets).toEqual([['x64', ['dmg', 'zip']]]);
    expect(resolve(electronBuilderReleaseArgs(['arm64', 'x64'], SIGNER)).targets).toEqual([
      ['x64', ['dmg', 'zip']],
      ['arm64', ['dmg', 'zip']],
    ]);
  });

  it('never publishes from a release build and names only the public releases repository', () => {
    const args = electronBuilderReleaseArgs(['arm64'], SIGNER);
    expect(args.slice(args.indexOf('--publish'), args.indexOf('--publish') + 2)).toEqual(['--publish', 'never']);
    expect(config.publish).toEqual({ provider: 'github', owner: 'FrescoFlacko', repo: 'interleaf-releases', releaseType: 'draft' });
    expect(readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')).not.toMatch(/^\s*(token|private|vPrefixedTagName):/im);
  });

  it('passes the signing overrides as config, with an identity electron-builder accepts', () => {
    expect(resolve(electronBuilderReleaseArgs(['arm64'], SIGNER)).config).toEqual({
      forceCodeSigning: 'true',
      mac: { identity: SIGNER.identity, notarize: 'true', signIgnore: '[.]lproj/locale[.]pak$' },
      dmg: { sign: 'true' },
    });
    // electron-builder rejects a qualifier that still carries the certificate-type prefix.
    expect(SIGNER.identity.startsWith('Developer ID')).toBe(false);
  });

  it('coerces the overrides to the booleans dmg-builder and the mac packager test for', async () => {
    // dmg-builder signs the container only when `dmg.sign === true`; the CLI
    // yields the string "true", which the installed schema validator coerces
    // in place on the configuration the packager then uses.
    const { validateConfiguration } = requireFromRepo('app-builder-lib/out/util/config/config');
    const { deepAssign } = requireFromRepo('builder-util-runtime');
    // deepAssign merges into nested objects it copied by reference; clone so the shared config stays pristine.
    const merged = deepAssign({}, structuredClone(config), resolve(electronBuilderReleaseArgs(['arm64'], SIGNER)).config);
    await validateConfiguration(merged, { isEnabled: false });
    expect(merged.dmg.sign).toBe(true);
    expect(merged.forceCodeSigning).toBe(true);
    expect(merged.mac.notarize).toBe(true);
    expect(merged.mac.identity).toBe(SIGNER.identity);
    expect(merged.mac.signIgnore).toBe(MAC_RELEASE_SIGN_IGNORE);
  });

  it('never signs the DMG container or skips signing anything from the shared config', () => {
    expect(config.dmg?.sign).toBeUndefined();
    expect(config.mac?.signIgnore).toBeUndefined();
  });

  it('skips individual signing only for Chromium locale data inside .lproj directories', () => {
    // MacTargetHelper compiles each signIgnore entry with `new RegExp` and tests
    // it against the absolute path of every file considered for signing.
    const parsed = resolve(electronBuilderReleaseArgs(['arm64'], SIGNER)).config as { mac: { signIgnore: string } };
    const ignored = new RegExp(parsed.mac.signIgnore);
    const framework = '/repo/release/mac-arm64/Interleaf.app/Contents/Frameworks/Electron Framework.framework/Versions/A';
    for (const locale of ['en', 'pt_BR', 'zh_TW']) {
      expect(ignored.test(`${framework}/Resources/${locale}.lproj/locale.pak`)).toBe(true);
    }
    const signed = [
      '/repo/release/mac-arm64/Interleaf.app/Contents/MacOS/Interleaf',
      `${framework}/Electron Framework`,
      `${framework}/Libraries/libEGL.dylib`,
      `${framework}/Helpers/chrome_crashpad_handler`,
      '/repo/release/mac-arm64/Interleaf.app/Contents/Frameworks/Interleaf Helper.app/Contents/MacOS/Interleaf Helper',
      '/repo/release/mac-arm64/Interleaf.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      `${framework}/Resources/resources.pak`,
      `${framework}/Resources/en.lproj/locale.pak.node`,
      `${framework}/Resources/en.lproj/locale.pak/evil.dylib`,
      `${framework}/Resources/en.lproj/locale_pak`,
      `${framework}/Resources/enXlproj/locale.pak`,
      `${framework}/Resources/en.lproj/notlocale.pak.dylib`,
    ];
    for (const path of signed) {
      expect(ignored.test(path), path).toBe(false);
    }
  });
});

describe('macOS release verification', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'interleaf-mac-release-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a Developer ID, hardened-runtime signature', () => {
    expect(codesignDetailProblems(SIGNED_DETAILS, SIGNER)).toEqual([]);
  });

  it('rejects ad-hoc, foreign or non-hardened signatures', () => {
    expect(codesignDetailProblems('Signature=adhoc\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0', SIGNER)).toHaveLength(3);
    expect(codesignDetailProblems(SIGNED_DETAILS.replace('(runtime)', '(none)'), SIGNER)).toEqual(['hardened runtime flag is missing']);
    expect(codesignDetailProblems(SIGNED_DETAILS.replaceAll('ABCDE12345', 'ZYXWV98765'), SIGNER)).toHaveLength(2);
  });

  it('rejects a missing, stale, wrong-arch or unstapled app', () => {
    const app = join(root, 'Interleaf.app');
    expect(verifyMacReleaseApp(app, 'arm64', 0, SIGNER, fakeTools().run)).toEqual([`${app} was not produced`]);
    mkdirSync(app);
    expect(verifyMacReleaseApp(app, 'arm64', Date.now() + 60_000, SIGNER, fakeTools().run)).toEqual([`${app} predates this build`]);
    expect(verifyMacReleaseApp(app, 'arm64', 0, SIGNER, fakeTools().run)).toEqual([]);
    expect(verifyMacReleaseApp(app, 'x64', 0, SIGNER, fakeTools().run)).toEqual([`${app}: executable is not x86_64-only`]);
    const universal = fakeTools({ 'lipo -archs': { status: 0, stdout: 'x86_64 arm64\n', stderr: '' } });
    expect(verifyMacReleaseApp(app, 'arm64', 0, SIGNER, universal.run)).toEqual([`${app}: executable is not arm64-only`]);
    const unstapled = fakeTools({ 'xcrun stapler': { status: 65, stdout: '', stderr: '' } });
    expect(verifyMacReleaseApp(app, 'arm64', 0, SIGNER, unstapled.run)).toEqual([
      `${app}: no stapled notarization ticket (xcrun stapler validate failed)`,
    ]);
  });

  describe('update ZIP', () => {
    let zip = '';
    beforeEach(() => {
      zip = join(root, 'Interleaf-1.2.3-arm64-mac.zip');
      writeFileSync(zip, 'zip');
      writeFileSync(`${zip}.blockmap`, 'blockmap');
    });

    /** `ditto -x -k <zip> <dir>` stand-in that leaves an app where Squirrel.Mac would find it. */
    const extracting = (overrides: Partial<Record<string, ToolResult>> = {}) => {
      const tools = fakeTools(overrides);
      const run = (file: string, args: readonly string[]): ToolResult => {
        if (file.endsWith('ditto')) mkdirSync(join(args[3] ?? '', 'Interleaf.app'));
        return tools.run(file, args);
      };
      return { ...tools, run };
    };

    it('extracts the ZIP and verifies the app inside it like the built app', () => {
      const tools = extracting();
      expect(verifyMacReleaseZip(zip, 'arm64', 0, SIGNER, tools.run)).toEqual([]);
      expect(tools.steps().map((step) => step.split(' ').slice(0, 3).join(' ').replace(/ \/.*$/, ''))).toEqual([
        'ditto -x -k',
        'codesign --verify --deep',
        'codesign -dvv',
        'lipo -archs',
        'xcrun stapler validate',
      ]);
    });

    it('refuses a missing or stale ZIP or blockmap before extracting anything', () => {
      rmSync(`${zip}.blockmap`);
      const tools = extracting();
      expect(verifyMacReleaseZip(zip, 'arm64', 0, SIGNER, tools.run)).toEqual([`${zip}.blockmap was not produced`]);
      writeFileSync(`${zip}.blockmap`, 'blockmap');
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(zip, old, old);
      expect(verifyMacReleaseZip(zip, 'arm64', Date.now() - 60_000, SIGNER, tools.run)).toEqual([`${zip} predates this build`]);
      expect(tools.calls).toEqual([]);
    });

    it('refuses a ZIP whose app is unsigned, unstapled or the wrong arch', () => {
      const unstapled = extracting({ 'xcrun stapler': { status: 65, stdout: '', stderr: '' } });
      expect(verifyMacReleaseZip(zip, 'arm64', 0, SIGNER, unstapled.run)).toEqual([
        expect.stringMatching(/^.*arm64-mac\.zip: .*Interleaf\.app: no stapled notarization ticket/),
      ]);
      expect(verifyMacReleaseZip(zip, 'x64', 0, SIGNER, extracting().run)).toEqual([expect.stringMatching(/executable is not x86_64-only$/)]);
      const unsigned = extracting({ 'codesign --verify': { status: 1, stdout: '', stderr: '' } });
      expect(verifyMacReleaseZip(zip, 'arm64', 0, SIGNER, unsigned.run)).toContainEqual(expect.stringMatching(/codesign --verify --deep --strict failed$/));
    });

    it('refuses a ZIP ditto cannot extract', () => {
      const tools = fakeTools({ 'ditto -x': { status: 1, stdout: '', stderr: '' } });
      expect(verifyMacReleaseZip(zip, 'arm64', 0, SIGNER, tools.run)).toEqual([`${zip}: ditto could not extract it`]);
    });
  });

  describe('final DMG', () => {
    let dmg = '';
    beforeEach(() => {
      dmg = join(root, 'Interleaf-1.2.3-arm64.dmg');
      writeFileSync(dmg, 'dmg');
    });

    const signedDmg = { 'codesign -dvv': { status: 0, stdout: '', stderr: DMG_DETAILS } };
    const SIGNATURE_STEPS = ['codesign --verify --strict', 'codesign -dvv <dmg>'];
    const stepsWithDmg = (steps: string[]) => steps.map((step) => step.replace(dmg, '<dmg>'));

    it('checks the container signature, then submits, waits, staples, validates and assesses it', () => {
      const tools = fakeTools(signedDmg);
      expect(notarizeMacReleaseDmg(dmg, 'release-notary', 0, SIGNER, tools.run)).toEqual([]);
      expect(stepsWithDmg(tools.steps())).toEqual([
        ...SIGNATURE_STEPS, 'xcrun notarytool submit', 'xcrun stapler staple', 'xcrun stapler validate', 'spctl -a -t',
      ]);
      expect(tools.calls[0]?.args).toEqual(['--verify', '--strict', dmg]);
      expect(tools.calls[2]?.args).toEqual([
        'notarytool', 'submit', dmg, '--keychain-profile', 'release-notary', '--wait', '--timeout', '45m', '--output-format', 'json',
      ]);
      expect(tools.calls[5]?.args).toEqual(['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmg]);
    });

    it('refuses an unsigned DMG container before contacting the Notary Service', () => {
      // The first real release run: the app was signed, the container was not.
      const tools = fakeTools({
        'codesign --verify': { status: 1, stdout: '', stderr: `${dmg}: code object is not signed at all` },
        'codesign -dvv': { status: 1, stdout: '', stderr: `${dmg}: code object is not signed at all` },
      });
      expect(notarizeMacReleaseDmg(dmg, 'release-notary', 0, SIGNER, tools.run)).toEqual([
        `${dmg}: DMG container signature is missing or invalid (codesign --verify --strict failed)`,
      ]);
      expect(stepsWithDmg(tools.steps())).toEqual(['codesign --verify --strict']);
    });

    it('refuses a validly signed container from another signer or team before submission', () => {
      const tools = fakeTools({ 'codesign -dvv': { status: 0, stdout: '', stderr: DMG_DETAILS.replaceAll('ABCDE12345', 'ZYXWV98765') } });
      expect(notarizeMacReleaseDmg(dmg, 'release-notary', 0, SIGNER, tools.run)).toEqual([
        `${dmg}: DMG container not signed by ${MAC_RELEASE_AUTHORITY}; team identifier is not ABCDE12345`,
      ]);
      expect(stepsWithDmg(tools.steps())).toEqual(SIGNATURE_STEPS);
    });

    it('refuses a missing or stale DMG without contacting the Notary Service', () => {
      const tools = fakeTools();
      const absent = join(root, 'absent.dmg');
      expect(notarizeMacReleaseDmg(absent, 'release-notary', 0, SIGNER, tools.run)).toEqual([`${absent} was not produced`]);
      utimesSync(dmg, new Date(1_000), new Date(1_000));
      expect(notarizeMacReleaseDmg(dmg, 'release-notary', Date.now(), SIGNER, tools.run)).toEqual([`${dmg} predates this build`]);
      expect(tools.calls).toEqual([]);
    });

    it.each([
      ['Invalid', 0, '{"id":"abc-123","status":"Invalid","message":"Processing complete"}'],
      ['In Progress', 0, '{"id":"abc-123","status":"In Progress"}'],
      ['a failed wait', 1, '{"id":"abc-123","status":"Accepted"}'],
      ['unparseable output', 0, 'Successfully uploaded file'],
    ])('stops at notarization on %s and never staples', (_label, status, stdout) => {
      const tools = fakeTools({ ...signedDmg, 'xcrun notarytool': { status, stdout, stderr: '' } });
      const problems = notarizeMacReleaseDmg(dmg, 'release-notary', 0, SIGNER, tools.run);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/notarization not accepted/);
      expect(stepsWithDmg(tools.steps())).toEqual([...SIGNATURE_STEPS, 'xcrun notarytool submit']);
    });

    it('names the submission for the rejection log, without any credential', () => {
      const tools = fakeTools({ ...signedDmg, 'xcrun notarytool': { status: 0, stdout: '{"id":"abc-123","status":"Invalid"}', stderr: '' } });
      expect(notarizeMacReleaseDmg(dmg, 'release-notary', 0, SIGNER, tools.run)).toEqual([
        `${dmg}: notarization not accepted (status Invalid, exit 0); inspect with xcrun notarytool log abc-123 --keychain-profile release-notary`,
      ]);
    });

    it('refuses when stapling fails', () => {
      const tools = fakeTools({ ...signedDmg, 'xcrun stapler': { status: 65, stdout: '', stderr: '' } });
      expect(notarizeMacReleaseDmg(dmg, 'release-notary', 0, SIGNER, tools.run)).toEqual([`${dmg}: xcrun stapler staple failed`]);
      expect(stepsWithDmg(tools.steps())).toEqual([...SIGNATURE_STEPS, 'xcrun notarytool submit', 'xcrun stapler staple']);
    });

    it('refuses when Gatekeeper rejects the stapled DMG', () => {
      const tools = fakeTools({ ...signedDmg, 'spctl -a': { status: 3, stdout: '', stderr: 'rejected\nsource=no usable signature' } });
      expect(notarizeMacReleaseDmg(dmg, 'release-notary', 0, SIGNER, tools.run)).toEqual([
        `${dmg}: Gatekeeper (spctl -a -t open --context context:primary-signature) rejected it`,
      ]);
    });
  });

  it('parses notarytool JSON defensively', () => {
    expect(parseNotarySubmission('{"id":"x","status":"Accepted"}')).toEqual({ id: 'x', status: 'Accepted' });
    expect(parseNotarySubmission('null')).toEqual({ id: undefined, status: undefined });
    expect(parseNotarySubmission('{"status":1}')).toEqual({ id: undefined, status: undefined });
    expect(parseNotarySubmission('')).toEqual({ id: undefined, status: undefined });
  });
});

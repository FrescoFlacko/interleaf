# Interleaf Packaging Runbook

This project uses `electron-builder` 26.15.3 and the checked-in
`electron-builder.yml`. Packaging is intentionally separate from publishing:
all package scripts pass `--publish never`. Stable updates (macOS app and
Linux AppImage) come from the public releases-only repository through
signed manifests; only the release tool in [Stable updates](#stable-updates)
uploads anything, and only as a verified draft.

## Local build and host verification

### Production dependencies must be a real local install

electron-builder collects the app's production dependencies from the
checkout's own `node_modules`. Run `npm ci` in the checkout or worktree that
is being packaged. Do not symlink `node_modules` to another checkout: with
electron-builder 26.15.3 such a tree produces `cannot find path for
dependency` warnings for the modules it cannot resolve, yet the build still
packages (and, in a release, signs and notarizes) an app without them. The
0.2.0 arm64 DMG was built that way from a worktree whose `node_modules` linked
to the primary checkout; its `app.asar` lacked `htmlparser2`, `css-select`,
`cssom` and `uhyphen`, and the app failed at startup with `Cannot find module
'htmlparser2'` from linkedom.

`electron.package-dependencies.ts` enforces this from `package-lock.json`,
which is the only source of truth; it has no hard-coded module list. Dev-only
and optional lockfile entries are not required (optional entries are
platform prebuilds such as `@img/sharp-*`, of which only the host's variant is
installed).

- **Install check.** `node_modules` must exist and must not be a symlink.
  Every production package path in the lockfile must have a `package.json`
  there, and it must resolve inside that `node_modules`.
- **Package check.** Every production dependency edge in the lockfile
  (the app or a production package `a@x` depending on `b`, which the lockfile
  resolves to `b@y`) must resolve to `b@y` inside the packaged `app.asar`,
  following Node's `node_modules` lookup from each packaged copy of `a@x`.
  The check reads only the archive header and each `package.json`.
  electron-builder re-hoists the tree, so packaged paths differ from the
  lockfile's paths; the check compares what `require` would load, not paths.

Failures name the missing or mismatched packages and say to run `npm ci` in
the worktree.

Build the compiled application first:

```bash
npm run build
```

For an unsigned current-host smoke package on Apple Silicon, use a directory
target so no DMG signing or notarization is attempted:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --dir --mac --arm64 --publish never
```

The configured output root is `release/` (ignored by Git). A successful arm64
directory build contains `release/mac-arm64/Interleaf.app`, with the executable
under `Contents/MacOS/` and the asar under `Contents/Resources/app.asar`.
Before treating the package as usable, check that the packaging log has no
`cannot find path for dependency` lines, then run the dependency check on it:

```bash
node electron.package-dependencies.ts release/mac-arm64/Interleaf.app
```

It exits 0 and reports how many locked production dependency edges resolve
inside `app.asar`, or exits 1 and lists the problems. The dependency check
covers package contents only; it does not run the app. Then confirm startup the
way an installed app is launched:

```bash
node electron.package-startup.ts release/mac-arm64/Interleaf.app
```

It launches the packaged executable through Playwright's Electron driver with
the working directory set to `/`, a fresh temporary profile in
`INTERLEAF_USER_DATA`, a temporary `HOME` and `TMPDIR`, and an OS-only `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`, so no provider CLI is discoverable). It
waits up to 60 s for the first window, asks the running main process for its
cwd, `userData` path and `app.isPackaged`, closes the app (killing it after
15 s), and deletes the temporary directory. Exit 0 means the window opened
from `/` on the isolated profile. Exit 1 lists the problems, and exit 2 means
it refused to launch. The only location guard is that it refuses a bundle
whose canonical path is under `/Applications`; a copy installed anywhere else
(for example `~/Applications`) is launched like any other target. Every
target it launches runs on the temporary profile above, never the live
`Interleaf` profile. Run it against
`release/…` or the app inside a mounted DMG
(`/Volumes/Interleaf <version>-arm64/Interleaf.app`).

The launch from `/` matters. The 0.2.0 arm64 release resolved its preview
worker dependencies (`fflate`, `pdfjs-dist`, `@napi-rs/canvas`) from
`process.cwd()`. Every earlier check launched it from the source checkout,
whose own `node_modules` satisfied that lookup. The installed app was
launched from `/` and failed with `Cannot find module 'fflate'` (require
stack `//package.json`), even though `app.asar` contained the module. A
packaged app that throws while loading its main module shows that error only
in a modal dialog and writes nothing to stderr. The check therefore reports it
as "no window opened"; to read the error, launch the executable by hand from
`/` with an isolated profile:

```bash
cd / && INTERLEAF_USER_DATA="$(mktemp -d)" \
  "$OLDPWD/release/mac-arm64/Interleaf.app/Contents/MacOS/Interleaf"
```

The check does not open documents, so it covers what runs at startup (all
three worker paths above are resolved when the main module loads), not every
preview or import path. These commands are host verification only; they do
not create a signed release artifact.

## macOS development bundle identity

An unpackaged macOS run is not launched from the installed `Electron.app`.
`electron.dev-bundle.ts` clones it to `out/dev-app/Interleaf.app` and rewrites
the identity keys, because macOS takes the Dock name from the bundle directory
and the Dock icon from the bundle's `CFBundleIconFile` before the process can
say anything about itself. The clone therefore also gets `CFBundleIconFile`
set to `Interleaf.icns` and a copy of the app-owned `resources/icon.icns` in
`Contents/Resources`. `node_modules/electron` is never modified, and the clone
is excluded from packaging (`'!out/dev-app'` in `electron-builder.yml`).

The clone is rebuilt whenever the installed Electron, the applied identity, or
`resources/icon.icns` changes; the recorded stamp is `out/dev-app/identity.json`.
Deleting `out/dev-app` also forces a rebuild, which is the fix if macOS has
cached older artwork for that bundle path.

Because the clone's executable is named `Interleaf`, Electron's `app.isPackaged`
reports it as packaged. `applyDevelopmentDockIcon()` therefore also consults
`process.defaultApp`, which electron-vite's `electron <entry>` launch sets and a
packaged `app.asar` never does, so a real packaged build still keeps its bundled
icon.

Dev icon smoke check, after `npm run dev` has generated the clone at least once:

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' \
  out/dev-app/Interleaf.app/Contents/Info.plist          # -> Interleaf.icns
shasum out/dev-app/Interleaf.app/Contents/Resources/Interleaf.icns resources/icon.icns
```

Both digests must match, and the Dock tile for the running development app must
show the Interleaf book/leaf artwork rather than the Electron atom.

The normal targets are:

| Script/target | Artifacts | Build host |
|:---|:---|:---|
| `npm run package:mac` / `--mac` | DMG and ZIP, arm64 and x64 (not a release; see below) | macOS |
| `node electron.mac-release.ts [--arm64\|--x64]` | Notarized, stapled DMG per requested arch containing the Developer ID signed app | macOS with the release identity and notary profile |
| `npm run package:win` / `--win` | NSIS installer (`.exe`), x64 and arm64 | Prefer Windows CI/native Windows tooling |
| `npm run package:linux` / `--linux` | AppImage, Debian package, and pacman package | Prefer Linux CI/native Linux tooling |

The macOS arm64 directory target is the only cross-step package verification
claimed by the current host report. Windows and Linux configuration is checked
in but those artifacts are not claimed unless their native CI job produces and
inspects them.

## macOS signing and notarization

Release macOS distribution requires an Apple Developer **Developer ID
Application** certificate, hardened-runtime-compatible entitlements, and
notarization. The config enables `hardenedRuntime`, uses
`resources/entitlements.mac.plist` for the app and its helpers (only
`com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory`, which Electron's V8
needs under the hardened runtime), sets `gatekeeperAssess: false` for local
builder behavior, and sets `notarize: true`. Exact Apple account values,
passwords and notary profile contents must never be committed or logged.

### Local signed release (Developer ID + notarytool keychain profile)

A signed, notarized release is produced only by the fail-closed release
command, never by `npm run package:mac` or the `--dir` smoke build:

```bash
INTERLEAF_MAC_SIGNING_IDENTITY='<Name> (<TEAMID>)' \
APPLE_KEYCHAIN_PROFILE=<profile> node electron.mac-release.ts --arm64
```

Pass `--arm64`, `--x64`, or neither (both). No other arguments are accepted.
Prerequisites on the build Mac:

- The `Developer ID Application: <Name> (<TEAMID>)` identity and its
  private key in the login keychain. `INTERLEAF_MAC_SIGNING_IDENTITY` names it
  without the `Developer ID Application:` prefix; the team identifier is read
  from its parenthesized suffix.
- A notarytool keychain profile, created beforehand
  with `xcrun notarytool store-credentials`. Only the profile *name* is passed;
  the command never reads or prints its contents.

What the command does, and why each step exists with electron-builder 26.15.3:

1. **Preflight.** It refuses before building unless it runs on macOS with
   `APPLE_KEYCHAIN_PROFILE` and a well-formed `INTERLEAF_MAC_SIGNING_IDENTITY`
   set, and refuses if `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER`, `CSC_LINK` or `CSC_KEY_PASSWORD` is set. electron-builder
   prefers Apple ID and API-key credentials over the keychain profile, and
   `CSC_LINK` moves signing to a temporary keychain, so either would make the
   release inputs ambiguous. Only variable names appear in the refusal.
   It also runs the install check described in [Production dependencies must be a real local install](#production-dependencies-must-be-a-real-local-install)
   and refuses when `node_modules` is missing or symlinked or does not
   match `package-lock.json`. That refusal happens before anything is built,
   signed or submitted to Apple.
2. **Build and package** (`electron-vite build`, then `electron-builder --mac
   dmg zip --<arch> --publish never`) with five invocation-only overrides:
   `-c.forceCodeSigning=true`, `-c.mac.identity=<Name> (<TEAMID>)`,
   `-c.mac.notarize=true`, `-c.mac.signIgnore=[.]lproj/locale[.]pak$` and
   `-c.dmg.sign=true`. Without `forceCodeSigning`, a missing identity is
   only a warning and an unsigned package is still emitted. The identity is
   given without the `Developer ID Application:` prefix because electron-builder
   rejects a prefixed name and selects the certificate type itself. The `dmg`
   and `zip` target names are explicit on purpose: with no target names,
   electron-builder expands `--mac --arm64` to every target *and every arch* in
   `electron-builder.yml`, which would leave unverified artifacts beside the
   release. With them, only the requested arch's DMG and update ZIP (with its
   `.blockmap`) are built. A unit test runs the release argv through the
   installed electron-builder's own CLI parser and target resolution to pin
   this. electron-builder signs and notarizes the `.app` (notarytool
   submit, then staple) before it builds the DMG, so the DMG contains the
   stapled app. `dmg.sign=true` then makes dmg-builder sign the DMG container
   with the same Developer ID Application identity. The installed schema
   validator coerces the CLI string `"true"` to the boolean dmg-builder
   requires, and a unit test pins that too.
   `signIgnore` exists because three release runs failed while electron-builder
   signed the Electron Framework's roughly 220 `<lang>.lproj/locale.pak` files
   one by one: `The timestamp service is not available`. electron-builder tests
   the pattern against each file's absolute path and skips only the separate
   signature for a match. Those files are Chromium locale data, not code, and
   remain sealed as resources by the signed framework and app, so altering one
   still breaks `codesign --verify --deep --strict`. Timestamps, the hardened
   runtime and the app postflight below are unchanged, and Apple notarization
   plus the Gatekeeper assessment still gate the release. A unit test pins that
   the pattern matches only `locale.pak` directly inside a `.lproj` directory,
   never an executable, helper, framework binary or native library.
   `signIgnore` stays unset in `electron-builder.yml`, so other builds are
   unaffected.
3. **App postflight.** For every requested arch it requires
   `release/mac-arm64/Interleaf.app` (arm64) or `release/mac/Interleaf.app`
   (x64) to exist and be newer than the start of this run, pass
   `codesign --verify --deep --strict`, show
   `Authority=Developer ID Application: <Name> (<TEAMID>)`,
   `TeamIdentifier=<TEAMID>` and the `runtime` code-directory flag in
   `codesign -dvv`, contain only the requested arch (`lipo -archs` on
   `Contents/MacOS/Interleaf`), and pass `xcrun stapler validate`. This also
   catches the cases where electron-builder skips signing or notarization
   without failing: `notarize: true` with no Apple credentials in the
   environment, and builds it detects as pull-request CI. The app's
   `app.asar` must then pass the package check described above, so an app
   missing a runtime dependency is refused before the DMG is submitted. The
   app itself has already been notarized by electron-builder at that point;
   the install check in step 1 is what prevents that spend in the known
   symlinked-install case.
4. **DMG signature and notarization.** For every requested arch, the DMG
   (`release/Interleaf-<version>-arm64.dmg`, or `release/Interleaf-<version>.dmg`
   for x64) must exist and be newer than the start of this run. The command
   then runs, stopping at the first failure:
   - `codesign --verify --strict <dmg>`, then `codesign -dvv <dmg>`, which must
     show `Authority=Developer ID Application: <Name> (<TEAMID>)` and
     `TeamIdentifier=<TEAMID>`. dmg-builder skips container signing
     silently when it finds no identity, so this check is what makes an
     unsigned or foreign-signed DMG fatal. It runs before anything is sent to
     Apple.
   - `xcrun notarytool submit <dmg> --keychain-profile "$APPLE_KEYCHAIN_PROFILE"
     --wait --timeout 45m --output-format json`, bounded by a 50-minute process
     deadline. It requires exit 0 and a parsed JSON `status` of `Accepted`.
     `Invalid`, `In Progress`, `Rejected` or unparseable output fails. The
     refusal names the submission ID and the `notarytool log` command to use.
   - `xcrun stapler staple <dmg>`, then `xcrun stapler validate <dmg>`.
   - `spctl -a -t open --context context:primary-signature -vv <dmg>`.

   Only the profile name reaches argv. notarytool reads the credentials from
   the keychain itself.

Any failure exits 1 with the reason. Success is reported only after every
requested DMG has been signed, accepted, stapled, validated and assessed, and
every update ZIP has a fresh `.blockmap` and extracts to the same signed,
stapled, single-arch app. The command prints those paths. The DMGs, the update
ZIPs and the ZIP `.blockmap` files are the release artifacts that go into the
[release stage](#release-procedure-build-sign-draft-verify-promote). Other files
in `release/` (the unpacked `mac*/Interleaf.app`, the DMG `.blockmap` files,
builder metadata such as `latest-mac.yml`, and anything left from earlier runs)
are not release artifacts. Clear `release/` before a release build if you want
only this run's output there.

The release DMG container is Developer ID signed, notarized and stapled, and
the app inside it is signed, notarized and stapled as well. The container
signature is required: the first real arm64 release run left the DMG unsigned
(`dmg.sign` at its default `false`). Apple accepted that DMG for notarization
and it stapled and validated, but `spctl -a -t open --context
context:primary-signature` rejected it with `source=no usable signature`.
`dmg.sign` stays unset in `electron-builder.yml`, so `npm run package:mac` and
smoke builds never sign the container. Only the release command turns it on.

The identity is passed to the release command rather than set in
`electron-builder.yml` on purpose: electron-builder uses an explicit
`mac.identity` even when `CSC_IDENTITY_AUTO_DISCOVERY=false`, so pinning it in
the shared config would sign the unsigned smoke build on any Mac holding that
certificate. Each signer supplies their own identity through
`INTERLEAF_MAC_SIGNING_IDENTITY`; the release command then requires every app,
update ZIP and DMG it checks to carry that identity and team identifier.

`npm run package:mac` remains a generic packaging command. On a Mac with a
Developer ID identity in the keychain it may auto-discover and sign, but it
does not force signing and silently skips notarization without credentials, so
its output must not be labelled a release. Unsigned local packages are useful
for structure/smoke checks but must not be distributed as trusted macOS
releases. The `--dir` command above performs no signing or notarization.

A CI release pipeline would instead supply the certificate through
`CSC_LINK`/`CSC_KEY_PASSWORD` and notarization credentials through the CI
secret store; that path is not implemented by the local release command, which
refuses those variables.

## Windows Authenticode

Windows release installers require an Authenticode code-signing certificate and
timestamping policy. Supply the certificate and password to electron-builder
through CI-protected `CSC_LINK`/`CSC_KEY_PASSWORD` (or the Windows-specific
builder/signtool configuration); never put a PFX, password, or token in the
repository. The checked-in `signtoolOptions` selects SHA-256 signing hashes,
but does not constitute signing by itself. Build and validate the NSIS output
on a Windows runner before distribution.

## Linux artifacts

The Linux target is configured for AppImage, `.deb`, and `pacman` output with
the icon and metadata under `resources/`. Build and smoke-test these artifacts
on a Linux runner matching the intended architecture. No Linux signing or
repository publishing is configured here, and a macOS build must not be
described as a Linux artifact.

Every build that produces an AppImage also writes `README-AppImage.txt` beside
it, in the same output directory: short plain-text instructions for saving,
running and updating the AppImage and for a missing `libfuse.so.2`. The text
comes from the single template `resources/linux/README-AppImage.txt`, rendered
with the AppImage's file name by the `afterAllArtifactBuild` hook
(`electron.appimage-readme.ts`). The hook writes nothing for macOS, Windows,
deb/pacman-only or `--dir` builds. The README is not part of the app or its
update manifest.

### Identity and window association

Two settings pin the Linux identity to `productName`, and they must change
together:

- `linux.executableName: Interleaf` in `electron-builder.yml`. electron-builder
  names the installed binary (`/opt/Interleaf/Interleaf`), the hicolor icon
  files, the MIME XML, and the desktop entry
  (`/usr/share/applications/Interleaf.desktop`) after `executableName`. When it
  is unset, electron-builder defaults it to the lowercase package `name`
  (`interleaf`), not to `productName`.
- `"desktopName": "Interleaf.desktop"` in `package.json`. Electron sets its
  runtime desktop name from this field and derives the Wayland `app_id`
  (`Interleaf`) from it. Without the field, Electron falls back to a lowercased
  slug of `app.name` (`interleaf.desktop`).

Main additionally pins the X11 `WM_CLASS` to the same value for XWayland
fallback (`src/main/app/linux-platform.ts`), and the desktop entry declares
`StartupWMClass=Interleaf`. Hyprland window rules, Waybar, and Walker bind a
running window to the launcher entry through that key, and the matching file
name lets xdg-desktop-portal and GLib resolve the app_id to the entry.
`tests/unit/linux-packaging-config.spec.ts` keeps the two settings equal to
`productName`. The package name stays lowercase (`interleaf`), so the artifact
is `interleaf-<version>-<arch>.pkg.tar.xz` and `pacman -R interleaf` removes it.

`Comment` comes from `linux.description` and `Categories` from
`linux.category` (`Office`); electron-builder overwrites both after merging
`linux.desktop.entry`, so neither is repeated there. `MimeType` is not
written by hand either: electron-builder derives it from the top-level
`fileAssociations` list, so the entry advertises exactly the types the app
registers.

### File associations

`fileAssociations` registers Interleaf as an *Open With* viewer (role
`Viewer`, rank `Alternate`, so it never takes a type over from an editor)
for PDF, EPUB, MOBI/AZW/AZW3, DOCX, PPTX and Markdown. electron-builder turns
the list into macOS `CFBundleDocumentTypes`, the Windows NSIS registrations
and the Linux `MimeType`. A file delivered this way is opened without being
added to the library (ADR 0014). `tests/unit/file-associations-config.spec.ts`
keeps the list equal to main's `OPENABLE_EXTENSIONS`. To confirm the macOS
output, build an unsigned directory package
(`CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64 --publish never -c.mac.notarize=false`)
and read `CFBundleDocumentTypes` from the bundle's `Contents/Info.plist`.

### pacman target (Arch / Omarchy)

electron-builder drives `fpm` for the pacman target. The artifact name is
overridden to `${name}-${version}-${arch}.pkg.tar.xz` so the file is named
like any other package pacman installs; the archive is xz-compressed, and
pacman reads the real architecture from `.PKGINFO` rather than the filename.

`pacman.depends` is set explicitly. electron-builder's built-in pacman
dependency list still names packages that are no longer in the Arch
repositories (`http-parser`, `libappindicator-gtk3`), which makes `pacman -U`
fail to resolve on a current system. The declared list is `gtk3`, `nss`,
`alsa-lib`, `libxss`, `libnotify`, `libsecret`, and `xdg-utils`.

No custom `afterInstall`/`afterRemove` script is configured. electron-builder
already ships the standard fpm post-install/post-remove templates (chrome
sandbox permissions and symlink handling), and the desktop/icon database
refresh is left to the standard pacman hooks that Arch installs; adding a
bespoke hook here would duplicate them.

Build both Linux artifacts on a Linux host:

```bash
npm run build
npx electron-builder --linux AppImage pacman --publish never
```

Structure check on the produced package (the contents listing must include
`opt/Interleaf/Interleaf`, `opt/Interleaf/resources/app.asar`, the unpacked
`sharp`/`@img` directories required by ADR 0013, and the desktop entry):

```bash
tar -tf release/interleaf-*.pkg.tar.xz
tar -xOf release/interleaf-*.pkg.tar.xz usr/share/applications/Interleaf.desktop
```

### Installing on Omarchy

```bash
sudo pacman -U ./interleaf-<version>-<arch>.pkg.tar.xz
```

Launch it from Walker/`wofi` as **Interleaf**, or run `Interleaf` if
`/opt/Interleaf` is on `PATH` (the package installs the binary under `/opt`
and relies on the desktop entry's `Exec` line rather than a `/usr/bin`
symlink). Remove it with `sudo pacman -R interleaf`.

### Omarchy runtime prerequisites

Omarchy ships a Hyprland/Wayland session without a full GNOME/KDE service set,
so two host services matter:

- **Secret Service (credential storage).** Electron `safeStorage` on Linux
  stores its key through the Secret Service D-Bus API. Without a running
  provider the credential vault fails closed and API-key providers such as
  OpenRouter cannot be configured. Install and start a provider, for example
  `gnome-keyring` (`sudo pacman -S gnome-keyring`) with its daemon started and
  unlocked in the session, or KDE's `kwallet` equivalent. Reading, annotation,
  and local CLI providers do not require it.
- **`xdg-desktop-portal` (file dialogs).** Native open/save dialogs on Wayland
  go through the portal. Install `xdg-desktop-portal` together with the
  Hyprland backend (`xdg-desktop-portal-hyprland`, which Omarchy includes by
  default) and, where a GTK file chooser is wanted, `xdg-desktop-portal-gtk`.
  Without a portal, import and export dialogs do not appear.

Neither is declared as a hard package dependency: both are session services
rather than link-time requirements, and a headless or alternative-session
install should not be forced to pull them in.

### sharp prebuilds on Linux

`sharp` is pinned per ADR 0013 and has no install scripts; its platform
binaries arrive as optional dependencies. `npm ci` **on the Linux host or CI
runner** is what fetches `@img/sharp-linux-*` and the matching
`@img/sharp-libvips-linux-*` prebuilds. A `node_modules` tree installed on
macOS or Windows must never be reused for a Linux package: the resulting
artifact would ship no usable decoder. `asarUnpack` keeps
`node_modules/sharp/**` and `node_modules/@img/**` outside the archive so the
isolated raster worker can load them from
`resources/app.asar.unpacked/`; the CI structure check asserts both
directories are present in the package.

### Linux CI

`.github/workflows/linux-package.yml` runs on pushes and pull requests to
`develop`: `npm ci`, lint, typecheck, tests, build, then
`npx electron-builder --linux AppImage pacman --publish never` and the
structure/desktop-entry smoke check above, which also requires
`README-AppImage.txt` beside the AppImage naming it, and uploads the AppImage,
its README and the pacman package. It uses
no secrets and makes no paid provider call. Electron E2E is not run in that
job: it needs a display server that the job does not provide, and has not been
validated headless on a GitHub runner.

A second job, `update-smoke`, runs the packaged two-version AppImage update
smoke under `xvfb-run` on `ubuntu-24.04` (see [Packaged update smoke](#packaged-update-smoke)).
It installs `xvfb` and `libfuse2t64`, and lifts Ubuntu's AppArmor restriction
on unprivileged user namespaces so Chromium's sandbox can start from a
`nosuid` AppImage mount; the sandbox itself stays enabled. It uploads the
smoke report and screenshots, also when the run fails.

## CI and artifact hygiene

CI should run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build`, the native packaging command, and a package-structure/smoke
check before uploading artifacts. Signing/notarization secrets belong only in
the CI secret store. `release/`, package extensions, `out/`, test reports, and
coverage are ignored so generated files do not enter source changes. The
update signing key never belongs in CI: releases are signed on a release
machine by the tool below.

## Stable updates

Interleaf updates itself from one fixed place: the public, releases-only
repository [`FrescoFlacko/interleaf-releases`](https://github.com/FrescoFlacko/interleaf-releases).
The source repository is never a distribution channel; its
releases, workflow artifacts and `release/` output are never linked from the
website, the wiki or the README.

The production signing key is bootstrapped: `UPDATE_TRUST.signingKeys` in
`src/main/updates/update-trust.ts` pins its public half (key id
`b448deb8c896ef18`) starting with version 0.5.0. No binary has been released
yet: the releases repository has no release, so a self-updating build reports
that no stable release has been published. Builds before 0.5.0 pin no key and
can never verify an update, so 0.5.0 has to be installed by hand.

### What updates and what does not

| Install | Updates | How |
| --- | --- | --- |
| macOS app (arm64, x64) | Yes | electron-updater downloads the ZIP; Squirrel.Mac swaps the bundle only if its Developer ID signature satisfies the running app's designated requirement |
| Linux AppImage (x64) | Yes | electron-updater replaces the AppImage file (differential download through the embedded blockmap) |
| Linux `.deb` / pacman | No | The package manager owns these files. Settings explains this and links to the release page |
| Windows, development runs, DMG-mounted or translocated macOS copies, any other layout | No | Never contacts the feed |

The app reads `interleaf-stable-mac.json` or `interleaf-stable-linux-x64.json`
from `https://github.com/FrescoFlacko/interleaf-releases/releases/latest/download/`.
The file is an Ed25519-signed envelope. Before it believes anything in the
file, the app checks the signature against a pinned key, the product id, the
stable channel, the platform and the version (newer than the running one, never
a downgrade). Artifacts and blockmaps may come only from the same repository's
tagged `releases/download/v<version>/` paths, and every downloaded byte must
match the signed SHA-512. GitHub's own release metadata (`latest-mac.yml` and
friends) is never used. `electron-builder.yml` declares the same repository
under `publish` only so the package carries `app-update.yml` and the macOS ZIP
blockmaps; every package command still passes `--publish never`.

Checks run 60 s after launch and every 12 h while
`updates.automaticChecks` is on (the default; Settings ▸ About & Updates turns
it off). A check never downloads. Download and Restart are separate explicit
actions. Restart is refused while an agent run, a Reader Chat reply or an import
is active. Otherwise it flushes renderer state and passes the shutdown barrier
before the platform updater quits and installs. Nothing forces a restart. An
empty destination reports that no stable release has been published, and an
unreachable one reports a failed check; neither reports "up to date". The
database schema is unchanged.

### Update signing key

The release manifests and `SHA256SUMS.sig` are signed with an Ed25519 key that
never enters the repository, CI, artifacts or logs.

**Bootstrap (once).**

1. On the release machine, create the key outside the checkout:

   ```bash
   node electron.update-release.ts keygen            # default: ~/.config/interleaf-release-signing/
   node electron.update-release.ts keygen --dir /Volumes/secure/interleaf-signing
   ```

   It refuses a directory inside the checkout, makes it owner-only (`0700`),
   writes `update-signing-<keyId>.pem` (`0600`, never overwriting), and prints
   the public entry to pin. Back up the private key offline; losing it means
   shipping a rotation release signed by a key you still hold, or users
   reinstalling by hand.
2. Paste the printed `{ keyId, spkiBase64 }` entry into
   `UPDATE_TRUST.signingKeys` and ship that build as an ordinary release. Builds
   without the entry can never verify an update, so the first release that pins
   a key has to be installed by hand.

**Rotation.** Ship one release that pins both the current and the next key,
still signed by the current key. Sign every later release with the next key,
and drop the old entry in a following release. If a key is compromised, remove
it from `signingKeys` in the next release. Installed builds that still pin it
stay exposed until they update, so publish that release promptly.

`sign` loads the key only if it is owner-only, outside the checkout, Ed25519
and pinned in the source being released.

### Release procedure: build, sign, draft, verify, promote

The version in `package.json` names every asset. Each step refuses with a list
of problems rather than continuing.

1. **Build on each platform with `--publish never`.**
   - macOS: `INTERLEAF_MAC_SIGNING_IDENTITY='<Name> (<TEAMID>)' APPLE_KEYCHAIN_PROFILE=<profile> node electron.mac-release.ts`
     builds, signs, notarizes and verifies both DMGs, both update ZIPs and their
     blockmaps ([macOS signing and notarization](#macos-signing-and-notarization)).
   - Linux (an x64 Linux host or CI runner with a fresh `npm ci`):
     `npm run package:linux` builds the AppImage, `.deb` and pacman package.
     Pushing the version tag (`git tag v<v> && git push origin v<v>`) runs
     the `Linux package` workflow on that commit; its
     `interleaf-linux-artifacts` artifact holds all four Linux files
     (`gh run download <run-id> -n interleaf-linux-artifacts`). The workflow
     only builds; it never signs or publishes.
2. **Stage.** Copy exactly these files into one empty directory outside the
   checkout. `sign` refuses any missing or extra file.
   `Interleaf-<v>-arm64.dmg`, `Interleaf-<v>.dmg`,
   `Interleaf-<v>-arm64-mac.zip` (+ `.blockmap`), `Interleaf-<v>-mac.zip`
   (+ `.blockmap`), `Interleaf-<v>.AppImage`, `README-AppImage.txt` (from
   the same Linux build), `interleaf_<v>_amd64.deb`,
   `interleaf-<v>-x64.pkg.tar.xz`.
3. **Sign and verify locally.**

   ```bash
   node electron.update-release.ts sign --key ~/.config/interleaf-release-signing/update-signing-<keyId>.pem --stage /path/to/stage
   node electron.update-release.ts verify --stage /path/to/stage
   ```

   `sign` writes both signed manifests, `SHA256SUMS` and `SHA256SUMS.sig`
   (never overwriting), then runs `verify`. `verify` checks:
   - the exact asset set, so no third manifest or stray file is accepted;
   - each manifest's signature against a pinned key, then its strict payload
     (no unknown field): product, `stable` channel, platform, version and
     `v<version>` tag;
   - that each manifest names exactly its platform's files, once each: both
     macOS ZIPs with the right `arch` and `kind: zip` and no blockmap size, or
     the x64 AppImage with the blockmap size embedded in the staged file
     (`README-AppImage.txt` is a download only and never in a manifest);
   - every named file's size and SHA-512 against the staged bytes;
   - the signed checksum list: exactly one canonical, sorted
     `<sha256>  <name>` line for every asset except `SHA256SUMS` and its
     signature, with no duplicate, unknown, path-like or malformed entry, each
     matching the staged bytes;
   - that `README-AppImage.txt` is exactly the template rendered for
     `Interleaf-<v>.AppImage` (`sign` refuses a stale one before signing).
4. **Draft.** `gh` must be logged in with write access to
   `FrescoFlacko/interleaf-releases`.

   ```bash
   node electron.update-release.ts stage --stage /path/to/stage [--notes-file notes.md]
   ```

   This verifies the stage again and refuses if any release for `v<version>`
   already exists. It then creates a **draft** with exactly the staged assets,
   downloads every asset back from GitHub, requires identical bytes, and
   verifies the downloaded set on its own. Clients never see a draft. GitHub
   needs at least one commit in the releases repository to create a tag. If the
   repository is still empty, add a README commit to it first. The tool does not.
5. **Re-check whenever needed.** `verify-draft --stage …` repeats the remote
   check without changing anything.
6. **Promote.** `promote --stage …` re-verifies the draft, then publishes it as
   non-prerelease and `--latest`. It checks the published assets again and
   requires GitHub's `releases/latest` to report the new tag.

The tool only ever talks to the fixed repository. It runs `gh` with tokenized
arguments, no shell, a reduced environment and a deadline. It reads no token
itself and prints none. Both release commands (`electron.update-release.ts`
and `electron.mac-release.ts`) refuse to run while
`INTERLEAF_UPDATE_SMOKE_TRUST` is set.

**Checking a download by hand.** `SHA256SUMS` lists every asset. `SHA256SUMS.sig`
is `<keyId> <base64 signature>` over `interleaf-sha256sums/v1\n` followed by
the exact `SHA256SUMS` text, made with the same pinned key.
`node electron.update-release.ts verify --stage <dir with all assets>` checks
both files from a source checkout. `shasum -a 256 -c SHA256SUMS` checks the
hashes alone.

### Packaged update smoke

`node electron.update-smoke.ts [--evidence <dir>]` proves the whole path on real
packages, without the real feed, the real key or the installed app:

1. It generates a throwaway Ed25519 key in memory. It builds the app once with
   `INTERLEAF_UPDATE_SMOKE_TRUST` set, which inlines a trust anchor accepted only
   for `http://127.0.0.1:47613` with exactly that one key (any other value pins
   no key and fails closed). It then packages it as `1.0.0` and `1.0.1`
   (`--publish never`; on macOS a ZIP signed with the local Developer ID,
   `-c.mac.notarize=false`). A `finally` step rebuilds `out/` without the anchor.
2. It copies `1.0.0` into a temporary sandbox and serves a loopback feed laid
   out like the release repository, with single and multipart byte ranges.
3. It launches the app with an isolated `HOME`, `TMPDIR` and
   `INTERLEAF_USER_DATA` and a minimal environment. It also keeps the app off
   the host's secret store with `--use-mock-keychain` on macOS and
   `--password-store=basic` on Linux. A smoke build has the real app's name,
   bundle id and signer, so without that switch it would request the installed
   app's "Interleaf Safe Storage" keychain item, and the system prompt would
   block main. It turns off automatic
   checks, then drives Settings ▸ About & Updates through these cases:
   - an empty feed must report `no-release`;
   - a manifest signed by a foreign key must fail verification;
   - a genuine manifest over substituted bytes must fail verification at
     download;
   - the genuine release must download.
4. It restarts through the panel. It waits for the installed bundle (macOS:
   `CFBundleShortVersionString` 1.0.1, then `codesign --verify --deep --strict`)
   or the new AppImage (old file gone, new hash equal to 1.0.1). It relaunches
   and requires version 1.0.1 with the isolated settings preserved. No feed
   request may carry credentials.
5. It writes `report.json` and screenshots to the evidence directory and
   removes the sandbox. It refuses a destination under `/Applications`.

Linux runs it in CI (above). On macOS it needs the Developer ID identity in the
login keychain, because Squirrel.Mac refuses an unsigned bundle. On macOS the
smoke build does not relaunch itself after installing: LaunchServices would
start it without the isolated environment. The harness relaunches it instead.
Squirrel.Mac keeps its own staging cache under
`~/Library/Caches/com.interleaf.app.ShipIt`, outside the sandbox. It holds only
the throwaway smoke bundle and is replaced on the next update. Never set
`INTERLEAF_UPDATE_SMOKE_TRUST` in a shell that builds anything else.

### Website downloads

`website/site.config.json` keeps every download URL `null` until a release is
promoted, so the website shows disabled "Coming soon" buttons. The website's
buttons cover only the two macOS DMGs (`macos-arm64`, `macos-x64`). Adding
Linux buttons needs new `DOWNLOAD_KEYS` in `website.build.ts` and a separate
decision; do not advertise them before then. Windows packages are built
(`npm run package:win`, unsigned unless an Authenticode certificate is
supplied) but neither published nor updated.

The DMG names include the version, so point the site at tagged URLs and update
them each release:

```json
{ "downloads": {
    "macos-arm64": "https://github.com/FrescoFlacko/interleaf-releases/releases/download/v<version>/Interleaf-<version>-arm64.dmg",
    "macos-x64": "https://github.com/FrescoFlacko/interleaf-releases/releases/download/v<version>/Interleaf-<version>.dmg" } }
```

`website.build.ts` accepts only `https://` URLs whose path ends in `.dmg`,
with no user name or password. Before building the site, require every
configured URL to resolve:

```bash
curl -fsSIL "<configured url>" | grep -iE '^(HTTP/|content-length:)'
```

Treat any failure as a blocker: a URL that 404s is a broken download button.
Keep tokens, Apple account values and the signing key out of the repository,
the site configuration and logs.

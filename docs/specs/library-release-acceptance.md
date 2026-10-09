# Conversation library acceptance

Updated 2026-10-09. Implementation covers stages 1–4 of the [library specification](conversation-library-and-incremental-imports.md). The local artifacts are release candidates. **Public-release acceptance remains open** because actual target-desktop, credential-store and stable-browser checks cannot be established by a Linux compiler/container run.

All automated checks use generated exports, new browser profiles, disposable library/state/config directories and synthetic provider adapters. No real export, cached archive, library or provider credential is needed or authorized for these checks.

### Combined library and Ask Echo PR validation, 2026-10-09

The combined source tree passes 278 unit/integration tests across 32 files, all 66 Chromium desktop/mobile Playwright cases, TypeScript checking and the production build on Node 24.20.0. The synthetic server-backed Chromium flow also passes, including database draft restoration and response completion after tab closure. Its obsolete saved-status-label wait was removed; it still waits for the successful database save response before testing reload.

This includes time-based context windows, settings-page ChatGPT defaults, removal of discussion-file UI/HTTP transfer routes, full-width settings scrolling, reaction placement/tooltips, prompt focus fixes, nyx-kit 2.3.1, and the incremental-import improvements below. These checks use disposable synthetic inputs only. Packaged artifacts and earlier cross-platform acceptance results below are historical; packages were not rebuilt and target-platform/live-provider release gates remain open for this combined source revision.

### Import history performance fix, 2026-10-09

Subsequent review refinement adds common-participant self inference for initial imports, comparison with stored participant sets, and owner continuity from automatically matched history for single-thread updates. Exact titles and equal participants corroborate short message overlaps or identical nonempty sequences. Candidates sharing only resolved self are omitted unless their titles agree. Duplicate candidates, disjoint lookalikes, changed memberships and explicit owner conflicts remain unresolved. The resolution method is stored with owner evidence and new conversation observations use matcher version 2. Six added regressions passed with the full 267-test suite, as did the synthetic server-backed Chromium flow; the 20,000-message benchmark remains 0.471 seconds. A further explicit-owner-conflict regression covers refusing automatic inheritance despite matched history. These changes are also source-only until packages are rebuilt.

History matching no longer reads every shared-participant candidate's messages before checking participant-set compatibility. It preserves review alternatives, reuses the selected history where possible, and resolves identical observations through saved occurrence mappings. A generated incremental workload of 40 conversations with 20,000 existing messages reduced preview time from 17.291 seconds to 0.494 seconds, with exactly 40 additions and no duplicates. Import progress now reports live conversation/message/candidate counters and clears percentages between phases. Processing deadlines and cancellation checks cover matching/commit; cancellation between preview and commit cannot be cleared accidentally.

Validation passes: 261 unit tests across 31 files on bundled Node 24.21.0, TypeScript and production build, eight desktop/mobile navigation browser tests, and the full synthetic Chromium server-backed ZIP/folder/media/discussion/deletion flow. New regressions cover unrelated-history reads, live worker progress, phase changes, processing timeout and cancellation at the commit boundary. The packaged candidates and hashes recorded below predate this source fix; they have not been rebuilt for this change.

### Navigation refinement, 2026-10-08

Import and Settings now have dedicated routes. Settings uses explained NyxActionItem rows; the sidebar footer and inline search are removed. Conversations sort by full activity timestamps, and older activity displays its year. Navigation no longer leaves the completed import page covering a conversation, and refreshing after an import does not reopen the startup conversation. Leaving an incomplete transfer cancels it, including a pending create request.

Targeted validation passes: 35 tests covering archive parsing, API behavior, timestamp ordering and startup-versus-refresh navigation, plus TypeScript and the production build. Browser regressions were updated and six new desktop/mobile cases cover routing, settings and transfer cancellation. They initially could not run because the sandbox rejected the local web server with `listen EPERM`. That restriction is resolved; the 2026-10-09 revalidation below includes this refinement.

### NyxCommandPalette integration, 2026-10-08

Search menu and palette integration are implemented against the sibling nyx-kit 2.3.0 source and built public exports. The kit owns fuzzy filtering, overlay, keyboard and focus behavior. Echo supplies all titles/participants grouped by folder and routes selections after the dialog closes. Two synthetic rendering tests verify complete summary coverage beyond the sidebar batch, grouping/order, identity and inert rendering of untrusted labels. Desktop/mobile browser checks cover cross-folder keyboard and pointer navigation, dismissal, fresh queries and destination focus.

The published nyx-kit 2.3.0 package is installed and pinned in package.json and pnpm-lock.yaml, including its registry integrity. Standard TypeScript checking, the production build into dist, and all 11 targeted search/order/navigation/Markdown tests pass against the installed package without local aliases. The local-server restriction is now resolved; desktop/mobile interaction checks pass in Chromium, Firefox and WebKit as part of the 2026-10-09 revalidation below.

## Revalidation, 2026-10-09

The initial revalidation passed 257 unit tests across 31 files on Node 22.13.0 and 24.20.0, TypeScript checking, and the production build. All 62 desktop/narrow-viewport Playwright cases pass in Chromium and Firefox, including import routing, settings, transfer cancellation and command-palette navigation/focus. Browser test corrections wait for the actual menu focus and completed archive deletion, assert import completion as a live status, and allow fixtures with multiple Inbox conversations. These correct test assumptions without changing application behavior. The full server-backed flow also passes separately in Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6, Chrome Stable 153.0.8010.52 and Edge Stable 154.0.4258.62, with fresh disposable profiles.

WebKit exposed an actual timeline race: a media/resize notification could restore an old reading position before a newly queued scroll event ran, preventing older history from loading. The timeline now compares its observed scroll position before restoring an anchor. A deterministic late-media regression failed on desktop and mobile before the fix and passes afterward. All 60 runnable WebKit viewer cases now pass; the two legacy Blob-cache fixture cases remain explicitly skipped. Eight targeted timeline/navigation checks pass in each of Chromium and Firefox after the fix. A container helper reproduces the viewer and library checks with only an allowlist of source/dependency mounts and no network or private home access. An initial missing-index mount and a concurrent frontend rebuild were test-orchestration failures; both checks passed after correcting the harness and running against a stable build.

An isolated real GNOME Secret Service test reproduced truncation above secret-tool's 8192-byte stdin limit. The Linux adapter now uses bounded, verified parts with a final manifest switch, preserving the previous record on a staging failure. It also distinguishes a locked existing item from an empty keyring, serializes operations and handles UTF-8 pipe boundaries. Six new synthetic unit cases cover legacy migration, large Unicode records, partial writes, lost commit acknowledgement, corruption, concurrent operations, cleanup retries and locked-store refusal. The real-service check passes on Node 24.20.0 and the bundled 24.21.0 with an approximately 91 KB generated record, daemon restart, replacement, disconnect, locked-store preservation and unavailable-service refusal. Its private D-Bus session and bubblewrap filesystem cannot access the real home directory or desktop keyring. The ten credential/lock tests also pass on bundled Node 24.21.0.

Both Linux and Windows release candidates were rebuilt with nyx-kit 2.3.0, the credential, timeline and managed-media fixes; the Linux candidate also includes the installed uninstaller described below. The Linux installer check passes for bundled Node/Sharp/SQLite, command symlink, repeated launch, shutdown, update and preserved synthetic history. The private D-Bus desktop controller check passes for occupied-port recovery, browser opening, one tray, crash/retry, login opt-in/out, background login and Quit. Windows helper cross-compilation, dependency inspection and NSIS compilation pass; this remains build evidence, not Windows runtime acceptance.

A follow-up Linux installer audit found and closed two gaps: a missing marker inside a nonempty destination could be mistaken for an unused installation, and the package lacked an installed uninstall command. Installation now rejects foreign targets, command links and desktop entries before mutation. The installed `uninstall.sh` stops the authenticated instance, removes only application-owned files and matching launchers/login entries, and preserves the library and unrelated files. Expanded package checks pass for foreign-target refusal, uninstall while running, login-entry cleanup, reinstall with preserved history, and preservation of replaced launchers and user-added files.

A subsequent lifecycle audit reproduced two further gaps. The desktop entry silently did nothing when the tray helper was absent; it now starts and opens the service independently, then attempts the tray. The isolated controller check passes with a missing helper and an unavailable session bus, verifies exactly one browser opening, and exercises the actual desktop entry’s occupied-port error plus tray retry. Separately, the Linux installer could not repair a marked installation after its runtime was removed during an interrupted update. It now uses the intact package’s authenticated control code. Expanded package checks cover repair and uninstall retry with removed runtime/server files; both regressions failed before the corresponding fix. The 16 local-server/autostart unit checks also pass.

An expanded managed-media check found two application defects: attachment lookup advanced the slot inside the search predicate, losing later attachments, and the document media policy allowed only blob URLs, blocking authenticated server audio/video. Attachment lookup now uses each attachment's fixed slot, and media policy permits same-origin media. A multi-attachment regression failed before the lookup fix and passes afterward, including unavailable and remote entries. All 258 unit tests pass on Node 22.13.0 and bundled Node 24.21.0. TypeScript and the production build pass. The expanded library flow passes on Chromium, patched Firefox, WebKit, Chrome Stable 153.0.8010.52 and Edge Stable 154.0.4258.62 with image decoding, native audio metadata and HTTP byte ranges.

The library browser flow now also selects an actual generated directory through the extracted-folder input after importing its equivalent ZIP. Chromium, patched Firefox, WebKit, Chrome Stable and Edge Stable all report no history changes and retain working managed media. This closes the UI coverage gap left by the existing lower-level ZIP/folder equivalence tests.

Firefox Stable 156.0 additionally passes a separate WebDriver check using geckodriver 0.37.0: one-use file pairing, HttpOnly session, ZIP and repeat imports, route/reload, image/audio metadata and ranges, saved draft, context disclosure, a completed response after tab closure without resend, deletion and narrow-viewport Quit. Its fresh profile, application and driver run inside one isolated filesystem/network namespace with only generated input. The harness waits for the loaded timeline, rather than matching the sidebar preview before restored shelf state is ready. Native extracted-folder selection remains unverified in this stable-browser check: geckodriver rejects the directory upload command, so the harness reports that gate explicitly and tests repeat ZIP input instead. This does not replace actual OS-default-browser or desktop-session validation.

The final Linux candidate passes the expanded installation/uninstallation and interruption-recovery checks. Archive and Windows staging inspection confirm the current built UI and credential code; the Linux archive top-level entries match the package allowlist. Windows NSIS compilation passes, with execution on actual Windows still outstanding.

The current Linux tarball also passes the unprivileged offline package and private D-Bus controller checks in clean Ubuntu 22.04.5 (glibc 2.35) and Ubuntu 24.04.4 (glibc 2.39) containers. This includes native helper loading, bundled Node/SQLite/Sharp, installation/update/uninstall/recovery, retained synthetic library, occupied-port retry, one tray, crash recovery, login opt-in/out, background login, Quit and missing-tray fallback. Test images contain only official distribution packages; execution mounts the release package and three check scripts read-only, drops capabilities, uses disposable executable temporary storage and mounts no real home, library, browser profile or credential store. Early harness failures were Docker's default no-execute temporary mount and a missing password-database entry for the test UID; both were corrected before the successful runs. Ubuntu 22.04 is the minimum tested userspace baseline. These containers share the host kernel and do not establish actual desktop-shell/session, default-browser or keyring-prompt acceptance.

Artifact SHA-256 values for this build:

- `Echo-0.1.0-linux-x64.tar.gz`: `8c8c16b33265d3b3582980aa0daab3de869e945f06372196c31057714a7c0927`
- `Echo-0.1.0-windows-x64-setup.exe`: `a5427706f924aee90f149d83852d0a3fcdd37920f83b6f4382531e770f23c854`

## Implemented behavior and evidence

| Area | Evidence |
| --- | --- |
| Local authority and lifecycle | Unit checks for exact Host/Origin, one-use pairing, session isolation, authenticated readiness/control, replay rejection, occupied ports, concurrent launches, restart and bounded shutdown |
| Durable storage | SQLite migration/version checks, owner-consistent foreign keys, lossless JSON/numeric literals, repeated occurrences, stable IDs, media recovery, reading positions and preferences |
| ZIP/folder intake | Shared validation, CRC and ZIP64, traversal/alias/special-entry rejection, quotas, interruption/cancellation, injected disk failures, cleanup retry, ZIP/folder equivalence |
| Reconciliation | Repeat and overlapping imports, reordered/disjoint history, changed observations and attachment bytes, group-membership review, account mismatch rejection, persisted match/keep-separate decisions |
| Analysis and discussions | Automatic CAS drafts, immutable accumulated context, static-image processing, saved partial/final answers, no resend after restart/reconnect, portable discussion formats 1–5, account/revision checks, acceptance/shutdown races and delayed discussion refresh without reopening the composer early |
| Deletion | Explicit keyboard-accessible confirmation, all owned state removed, original input preserved, failed cleanup remains retryable after restart, no symlink following, rebuild into new internal IDs |
| Browser library flow | Actual file-form pairing, HttpOnly session, two tabs, separate-profile rejection, ZIP/extracted-folder equivalence through the file inputs, owner/conversation/occurrence review, repeat import, managed image/audio and byte ranges, draft restore, response completion after closing the tab, deletion and mobile keyboard Quit |
| Linux native controller | Real GLib helper on a private D-Bus session: occupied-port recovery, one tray, browser opener invocation, crash/retry, login opt-in/out, background login, tray Quit and external Quit removes the tray, missing-helper/session-bus fallback and desktop-entry startup failure/retry |
| Linux package | Per-user installation and command symlink, bundled Node/SQLite/Sharp, repeated launch, Quit, update, uninstall/reinstall with preserved synthetic library, foreign-target refusal, interrupted-update/uninstall recovery and unrelated-file preservation; actual tarball passes unprivileged Ubuntu 22.04/24.04 container checks |
| Windows package | MinGW cross-compilation, native dependency inspection and NSIS installer compilation; execution on actual Windows is still required |

At the 2026-10-07 baseline, all 244 unit tests across 27 files passed on Node 22.13.0 and Node 24.21.0. That baseline included 54 independent-viewer Playwright cases; current counts are above. TypeScript and the production build pass. Vite reports the existing large frontend chunk advisory; this does not fail the build.

Library browser checks pass on the Playwright-bundled Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 engines. WebKit runs in the isolated Playwright 1.63.0 Noble container with networking disabled. These are engine checks, **not certification of released Firefox or Safari versions**. The same isolated library flow also passes with Google Chrome Stable 153.0.8010.52 and Microsoft Edge Stable 154.0.4258.62 on Linux using a fresh temporary profile; no existing browser profile is opened. Edge was extracted under the ignored build directory from [Microsoft’s official package repository](https://packages.microsoft.com/repos/edge/) and checked against its published package SHA-256; it was not installed system-wide. The independent viewer suite covers folder selection, media, context disclosure and browser-cache behavior; current counts and explicit WebKit skips are recorded above. WebKit redirect rejection uses a failed interception because its protocol cannot fulfill a 302; Chromium/Firefox and unit checks exercise the redirect contract.

## Capacity and bounds

On this Linux development host, 100,000 generated message records across four source parts imported in 13.95 seconds; repeat import, pagination and reopening finished in 29.39 seconds total at 578 MiB peak process RSS. The repeat added no messages and did not advance the revision. A separate 32 MiB generated compressed entry verifies streamed extraction. See [import limits](library-import-engine.md) for all quotas and the bounded worker heap.

These measurements calibrate one large synthetic conversation and streaming extraction. They do not establish simultaneous worst-case use of every independent limit, performance on minimum-spec machines, or actual power-loss behavior. Large accumulated contexts fail visibly at the existing transfer ceiling instead of truncating source evidence.

## Reproduce locally

Use Node 24.21.0 and pnpm 10. Linux native checks require GCC, GLib/GIO development files, D-Bus, Python GObject introspection and a compiled helper. Use a clean checkout or explicitly excluded build directories. The Vite watcher excludes private exports and generated packages and does not follow directory symlinks.

```sh
pnpm test
pnpm build
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
pnpm test:library-browser
ECHO_BROWSER=chrome pnpm test:library-browser
ECHO_BROWSER=msedge pnpm test:library-browser
ECHO_BROWSER=firefox pnpm test:library-browser
ECHO_BROWSER=webkit pnpm test:library-browser
pnpm test:import-capacity
pnpm desktop:build-native
pnpm test:tray
pnpm test:desktop
node scripts/check-secret-service.mjs
node scripts/check-webkit-container.mjs
ECHO_GECKODRIVER=/path/to/geckodriver node scripts/check-firefox-stable.mjs
pnpm desktop:package
node scripts/check-linux-package.mjs
node scripts/check-linux-container.mjs
```

The Linux distribution check requires Docker and a built Linux tarball in `release/`. It builds Ubuntu 22.04 and 24.04 test images from a Dockerfile supplied on stdin with an empty build context, then runs the package and private controller checks offline as the invoking non-root UID. Pass `22.04` or `24.04` to run one baseline. Image construction fetches public OS packages; no application or private content enters that build.

The isolated Secret Service check additionally requires bubblewrap, gnome-keyring-daemon, secret-tool and gdbus. It mounts only system binaries and its generated temporary root, disables D-Bus service autoactivation and never uses an existing keyring.

The separate Firefox Stable harness requires Linux, bubblewrap, Firefox at `/usr/bin/firefox` and geckodriver 0.37.0 from the official Mozilla release. Set `ECHO_GECKODRIVER` to its executable (the default is `build/geckodriver/geckodriver`). It mounts only system binaries, an allowlist of application/dependency files and a disposable synthetic root, with no real home, browser profile, keyring or external network access. Native directory selection remains a manual gate when the driver rejects directories.

Branded channels require their installed browser; `ECHO_BROWSER_EXECUTABLE` can point to an extracted Chrome/Edge binary while retaining the fresh temporary profile. `ECHO_TEST_BROWSER=firefox` or `webkit` selects that engine for the viewer suite; Firefox’s narrow-viewport project does not emulate unsupported mobile/touch APIs. WebKit requires the system libraries for its bundled engine; `node scripts/check-webkit-container.mjs` runs the full browser suite and library flow in the matching Playwright Noble image when the Linux host lacks them. The container disables networking, mounts only an explicit source/dependency allowlist, and keeps generated browser profiles and test output disposable. It never mounts the repository root, private exports, the real home directory or desktop credential stores. Windows package builds require MinGW-w64 and NSIS, with `ECHO_DESKTOP_TARGET=win32`, `CC` and optionally `ECHO_NSIS` for cross-building. Package staging uses a fixed allowlist of server/shared code, built assets, dependencies and runtime; exports, credentials, tests, application source maps and development state are not bundled. Both artifacts bundle Node 24.21.0 and target x86-64; Linux requires glibc and a graphical session. See [desktop delivery](desktop-delivery.md).

## Required external release checks

Use disposable OS accounts and entirely generated archives. Record actual OS/build, stable browser versions and outcomes here when performed.

Availability confirmed 2026-10-09: no Windows 11 or macOS/Safari test machine is currently available. Their checks below remain blocked on access to those environments. Existing compiler, browser-engine and Linux container results do not satisfy those gates. The implementation and feasible local synthetic checks are recorded above; public-release acceptance remains open.

- **Linux desktop:** install on actual Ubuntu 22.04/24.04 desktops (and any additional distribution declared for release), validate the actual StatusNotifier host (including the chosen GNOME extension where applicable), missing-tray fallback, default-browser file handoff, log out/in startup, update/uninstall and filesystem behavior. A private D-Bus watcher proves the protocol/controller contract, not desktop-shell integration.
- **Windows 11 x86-64:** run the installer as a standard user; verify Node/Sharp/SQLite, private DACLs and rejection of foreign/reparse/hardlinked files, lock contention/process death, tray/Explorer restart, occupied-port errors/retry, default browser, HKCU login opt-in/out, update and uninstall while preserving the library. Cross-compilation and Wine initialization do not satisfy this gate.
- **Credential stores and live connection:** verify Linux desktop keyring unlock prompts/session integration and Credential Manager chunk replacement/recovery on Windows in disposable accounts. Locked/unavailable Linux storage and large-record persistence pass the isolated real-service check above; that does not establish desktop prompt integration. Then exercise the supported provider connection through the application's explicit consent UI. Development agents must not read existing credentials or real conversation context. Synthetic provider tests do not prove live eligibility or provider quota behavior.
- **Stable browsers:** test current released Chrome, Edge, Firefox and Safari where available. Cover extracted-folder selection and ZIP input, media/ranges, actual OS-default-browser pairing, session expiration, explicit context disclosure and response reconnect. Safari remains a UI requirement even though macOS packaging is deferred.
- **Durability and release operations:** exercise target-filesystem power-loss/storage-exhaustion recovery and large imports on minimum supported hardware. Choose publisher identity/signing credentials and distribution channel before signing or publishing. No signing identity or public release is configured by these implementation changes.

macOS packaging, NAS/container hosting, multi-user access, backup/restore and separately billed API fallback remain outside this release's agreed scope. The [desktop assessment](desktop-delivery.md) explains macOS's additional implementation and validation cost.

## Browser-cache compatibility

The independent viewer now writes bounded ArrayBuffer chunks in manifest format 3, avoiding WebKit’s Blob persistence failure in isolated contexts. Existing format-2 Blob chunks remain readable without rewriting the manifest; generated legacy fixtures verify that on Chromium/Firefox. Storage errors propagate outside the Web Locks callback so Firefox does not report already handled failures as uncaught callback exceptions. The local SQLite library does not use this browser cache.

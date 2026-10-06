# Local server library and incremental imports

Date: 2026-10-06. Status: agreed product direction; specification only. Implementation has not started. Linux is the proposed first validation target; release platforms and launcher packaging remain to be settled.

Echo becomes a locally installed background server with a browser interface, a launcher, and system-tray controls for a durable personal conversation library. Importing another export adds missing history and reconciles changed records without replacing the library or duplicating messages. The existing Vue interface and Ask Echo experience remain the foundation. The launcher starts the server and opens the default browser at `http://127.0.0.1:<port>`. SQLite stores structured history, and an application-managed media directory retains attachments independently of the original export.

Extend the existing Node service and use the same HTTP application interface locally and in a future NAS-hosted Docker deployment. Hosted deployment is an architectural requirement, not part of the first desktop release. Tauri is an optional future wrapper; neither a webview nor a Rust rewrite is required.

## Relationship to existing requirements

[PRODUCT.md](../../PRODUCT.md) describes the current browser viewer and archive cache. [ChatGPT connection and conversation analysis](chatgpt-connection.md) defines the existing Ask Echo contract. This feature proposes replacing the single cached export and manual discussion persistence with a durable library in the desktop edition. The existing standalone browser viewer retains its behavior until explicitly migrated; the installed edition also uses a browser, but its durable storage belongs to the local server.

For the proposed desktop edition, SQLite, managed attachment copies, accumulated imports, and automatic discussion persistence supersede the current cache-only and no-database restrictions. Source exports remain read-only. All development privacy requirements in [AGENTS.md](../../AGENTS.md) continue to apply. Update the implementation-facing product requirements when this feature enters implementation; this document does not claim the current application already has these capabilities.

This direction replaces the earlier Tauri-first proposal. The native packaging and mobile alternatives in [AI access and mobile options](ai-access-and-mobile-options.md) remain separate investigations.

## Scope

The first desktop release includes:

- The existing Vue, TypeScript, SCSS/BEM, and nyx-kit interface, preserving the kit's default colors and existing information and analysis shelves.
- A launcher and tray menu with Open Echo, Quit Echo, status, and optional start at login.
- A persistent local library containing conversations, source records, import history, attachments, reading positions, identity corrections, and Ask Echo discussions.
- Repeatable imports of extracted export folders, including overlapping exports and older history.
- Conservative message reconciliation with visible handling of ambiguous matches.
- Existing user-initiated ChatGPT text and static-image analysis, secure credential storage, and restart persistence.
- Backup, restore, and explicit library deletion.
- A shared HTTP API and application core that allow future NAS deployment without rewriting the UI or import rules.

Deferred: ZIP extraction, live account synchronization, message sending, mobile native packages, cloud accounts, multiple application users, automatic analysis, additional AI providers, audio/video analysis, hosted deployment, and synchronization between independent desktop libraries. Desktop packaging does not expand provider eligibility or supported analysis modalities.

## User experience

Launching Echo starts or reconnects to its local server, then opens the browser interface and restores the library and last active conversation. The viewer works offline with imported local content; AI requests and existing explicitly permitted remote media features still require connectivity.

The user chooses **Import export** and selects an extracted folder. Echo validates it, shows progress, and reconciles it with the library. A completion summary reports additions, matched records, changed records, unavailable assets, and unresolved matches. These details appear only in the private application UI. An identical repeat import reports no changes.

Routine unambiguous imports require no extra approval step. Ambiguous account, conversation, or message matches remain separate pending resolution; uncertainty must never silently remove a record. The user can resolve candidates locally, and those decisions persist for later imports. Import progress is cancelable before commit; an interrupted operation leaves the last committed library usable.

Importing history does not automatically select messages, expand a pending AI request, or send anything. Reading positions and discussion links survive imports through stable internal identifiers. Navigation uses opaque identifiers, never source paths or display names.

Distinguish **Disconnect ChatGPT**, **Delete discussion**, and **Delete library**. Library deletion requires an explicit destructive action, removes managed content and staged imports, and never deletes source exports. Report incomplete cleanup and allow retry. Provider-side deletion and credential revocation remain separate operations.

## Launcher and server lifecycle

The installed application follows a background-server and browser-interface model. The tray is the primary control surface when no browser tab is open.

| Action or event | Required behavior |
| --- | --- |
| Launch Echo | Start one server instance for the user's library, wait for authenticated readiness, then open the configured loopback URL in the default browser |
| Open Echo from tray | Open the running interface; opening another tab must not start another server |
| Close browser tab | Keep the server, library, and accepted background jobs running |
| Quit Echo from tray | Stop accepting work, cancel or finish pending work safely, commit or roll back writes, close the database, stop owned processes, and remove the tray icon |
| Start at login | Explicit opt-in, disabled by default; start in the background without opening a browser tab |
| Startup failure | Show an actionable local error and retry/quit options; do not open an unrelated service or silently leave a broken process running |
| Server crash | Show unavailable status; offer restart and recover committed state without automatically resending AI requests |

Use an OS-appropriate per-user instance lock and authenticated local control channel. Identify the existing Echo process before reusing it; an HTTP response on the expected port alone is insufficient. Prefer a stable configured port so the browser origin remains predictable. If another application owns it, report the conflict and allow a deliberate port change; do not kill that process. Browser reconnect and additional tabs must not duplicate accepted imports or AI sends.

Closing a tab does not cancel an accepted import or AI turn. The server owns job state and persists results; reopening the UI reconnects to that state without dispatching again. Drafts are saved through the API with visible save status; a browser unload event is not a reliable persistence mechanism. Quit requests provider cancellation where needed and records interrupted or uncertain outcomes. Show pending shutdown instead of claiming exit before cleanup completes; enforce a bounded shutdown with recovery on the next launch.

The tray helper owns only lifecycle and browser opening, not library or AI logic. Expose a protected Quit action in the UI as a fallback for desktop environments without a usable tray. Do not expose shutdown as an unauthenticated URL. In a future container deployment, the container supervisor owns startup/shutdown and the desktop tray is absent.

## Shared architecture

Use three layers with explicit dependencies:

1. **Shared Vue UI:** presentation, navigation, selection, composer state, and context disclosure. Components call a typed HTTP client and do not depend on a native wrapper.
2. **Node application server and core:** serve the built frontend and own import validation, reconciliation, database transactions, source fidelity, context preparation, discussion persistence, and job/request lifecycle. Keep domain logic independent of HTTP handlers and the tray.
3. **Host adapters:** platform paths, credential storage, launcher/tray integration, and import sources. The future NAS edition uses the same API and core with a hosted authentication and storage configuration.

| Operation | Local installation | Future NAS deployment |
| --- | --- | --- |
| Load conversations and messages | Same-origin HTTP API with pagination | Same API behind HTTPS and application login |
| Start and cancel imports | Browser-selected files streamed to the loopback server, with job progress | Upload to NAS or import from a configured server folder |
| Read attachments | Authorized local HTTP media responses | Authorized HTTPS media responses |
| Prepare and send analysis | HTTP requests and response streaming | Same request and streaming contracts |
| Store credentials | OS credential store | Protected server credential store |
| Persist library | Local SQLite and media directory | SQLite and media on persistent NAS storage |
| Start and stop | Launcher and system tray | Container lifecycle management |

Browser folder selection supplies files, not unrestricted access to an absolute local path. Stream selected file bytes and validated relative paths into bounded server staging. This loopback transfer stays on the user's machine; future NAS upload leaves the browser's machine and needs different disclosure. A later native folder picker can hand the server a narrowly scoped local import capability, but is not required for the first version.

Use versioned request/result types, stable identifiers, explicit cancellation, reconnectable progress, and safe error categories. Do not expose arbitrary SQL, filesystem paths, provider URLs, or executable commands to the UI. Serve attachments through authorized opaque IDs with streaming and range support for media playback, rather than embedding entire files in JSON.

Build the Vue application with Vite and serve its production assets from the application server. Vite's development server is tooling; `vite preview` is not the installed production server. [Vite deployment guidance](https://vite.dev/guide/static-deploy.html).

### Local service boundary

Bind explicitly to `127.0.0.1` by default and serve the UI and API from one origin. Preserve exact Host/Origin validation, local pairing/session authority, CSRF protection, request limits, and credential isolation from the current connection service. Loopback binding alone does not authorize callers. The launcher must use an authenticated readiness/control mechanism and preserve the established pairing flow; never publish reusable credentials at an unauthenticated bootstrap endpoint or place secrets in browser URLs.

Keep SQLite and the media directory outside the static frontend root. Protect library, import, media, AI, and lifecycle endpoints. Avoid private response caching and raw request logging. Do not broaden the existing remote-fetch rules when moving work into Node. LAN exposure is a separate hosted configuration, not an incidental change to the bind address.

### Runtime packaging

Extend the existing Node service rather than introducing a Rust core or Tauri sidecar. Bundle a supported Node runtime and required production dependencies for ordinary installations so users do not need Node, pnpm, or a development checkout. Include a thin platform-specific launcher/tray helper; choose its implementation based on supported platforms and lifecycle requirements. Native database and credential dependencies must be packaged and tested for the target OS and CPU architecture.

If a dedicated application window becomes useful later, a Tauri wrapper can open the same interface and manage the same server. Keep that optional and retain the browser and NAS paths.

## Library model

The following are logical entities; table names and indexes are implementation details.

| Entity | Purpose |
| --- | --- |
| Account namespace | Prevent accidental merging between different export owners; retain explicit mappings and corrections |
| Conversation | Stable internal identity and scoped source identity evidence; separate group and direct threads |
| Message | Stable internal identity used by timeline, selections, and citations |
| Message version | Immutable observed record, including unknown fields and exact source values |
| Import and source part | Import status, versioned fingerprints, original source representation, ordering, and provenance |
| Source occurrence | Links each observed occurrence to a source part, import, message, and version; preserves repeated identical messages |
| Asset | Content digest, managed location, format, integrity state, and source associations |
| Discussion and turn | Questions, responses, status, selected references, immutable context, and media actually submitted |
| Preferences | Reading positions, identity corrections, and established application settings |

Store source JSON losslessly, including unknown fields and numeric values; normalized display fields are an index, not a replacement for evidence. Identical source blobs may be stored once with multiple provenance references. Stable internal IDs must not depend on filenames, display names, or positions within one import.

Keep media bytes outside SQLite and deduplicate identical bytes by a cryptographic content digest. Different source paths can refer to the same asset; one source path can refer to changed bytes in a later import. Copy imported assets into managed storage so moving the original export does not break the library. Only assets within the selected import scope may be read; reject traversal and symlink escapes. Missing assets remain explicitly unavailable and can be filled by later imports.

## Incremental import and reconciliation

Treat exports as observations of history, not authoritative deletion instructions or append-only feeds. A latest-message timestamp is insufficient: an import can add older records, fill gaps, or contain changed observations.

### Matching rules

- Prefer stable source identifiers only where the format actually supplies and defines them. Scope them to account and conversation; never assume identifiers are globally unique.
- Conversation titles, participant display names, and filesystem names are not sufficient identity. Keep uncertain conversation matches separate until resolved. Group membership changes must not merge unrelated threads.
- Without stable message identifiers, generate candidates from multiple source attributes and ordered surrounding context. Version the matching algorithm and preserve the evidence behind a match locally.
- Fingerprints help find candidates; they are not proof that two occurrences are the same message. Preserve multiplicity when identical messages occur repeatedly, including at the same timestamp.
- Use ordered, one-to-one matching across overlapping history. Never merge solely on text, timestamp, or an attachment digest. Uncertain candidates stay unresolved rather than being destructively collapsed.
- A confident identity match with changed fields creates a new observed version. Reactions or edits must not automatically create a second timeline message. Import order alone does not establish which conflicting observation is newer; use verified source semantics or retain a visible conflict.
- Absence from a later export does not delete a stored message. Explicit source deletion events may be represented as evidence, while local library removal remains a user action.
- Repeating the same source observation must not duplicate messages, media, or versions. Preserve identity across changed partitioning or ordering when evidence supports it.

The exact fallback matcher requires synthetic format fixtures and an explicit decision before implementation. Do not inspect real archives through development tools to infer matching rules.

### Commit and recovery

Validate and stage an import before making it visible. Record a bounded, cancelable import job; serialize competing writes. Hash and copy assets in the background, then make completed files durable before committing database references. SQLite transactions do not atomically commit unrelated filesystem writes: use staging and recovery bookkeeping so a crash can leave reclaimable orphan files, but never a successful reference to an unfinished copy.

Commit the accepted import and its provenance together. Invalid metadata blocks commit with an actionable error; missing attachments may commit as explicitly unavailable. Failed or canceled imports leave existing data intact. Recovery removes abandoned staging files only after proving they are not referenced by committed records, retained source versions, or AI turns.

Keep import memory bounded through incremental parsing/copying and paginated database work. Report disk-space and permission failures without logging private source values. Import summaries and unresolved details belong in the application, not terminal output or telemetry.

## Ask Echo and source fidelity

Preserve selected-only, surrounding-default, and full-conversation scopes, direct explicit sending, historical-context disclosure, static-image limits, and the optional development inspector described in the connection spec. Importing or reopening a discussion never triggers inference.

In the library edition, **full conversation** means the full accumulated active conversation at the frozen library revision. It includes complete chosen source records and associated source metadata, preserving disjoint history and unresolved alternatives with clear provenance. Explain locally that this can cover multiple imports. Deduplicate byte-identical evidence without silently dropping conflicting observations or unknown fields. Never imply that the merged representation is one original export.

A prepared turn binds the account, provider, model, library revision, source versions, focus references, history, and actual media together. Relevant library changes invalidate an unsent preparation. An accepted request remains bound to its original immutable snapshot; later imports do not rewrite its context or citations.

Automatically save discussions and drafts locally, with visible saving/error state. Retain exact historical context and selected image representations, including after source updates. On restart, an interrupted response is marked interrupted or outcome-unknown; never resend it automatically. Export/import of discussions remains available for portability, subject to source-reference validation.

Use the system browser for OAuth and an app-owned loopback callback listener. The UI port and OAuth callback port may differ; preserve the provider's exact redirect requirements. Keep tokens out of browser JavaScript/storage, the library database, backups, diagnostics, and discussion files; use the OS credential store. Revalidate account eligibility, renewal, revocation, and text/image inference through the application on each supported platform. Current official open-source registration requires a `127.0.0.1` callback. [OpenAI registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

## Storage lifecycle and migration

Store the library outside the repository and installation directory, in the OS application-data location. Keep schema migrations ordered and versioned. Create a consistent backup before destructive migration; a failed migration must retain a recoverable prior library, and an older app must refuse an unsupported newer schema safely.

Provide a portable backup containing a consistent database snapshot, referenced media, and the format version. Exclude provider credentials. Coordinate backup with imports and discussion writes; copying a live SQLite file alone is not sufficient. Restore validates integrity and schema compatibility into staging before replacing the active library. Backup files contain private material and must be labeled accordingly.

The server library is independent of browser storage. Do not assume an existing IndexedDB cache is available: a different host, port, or browser profile has a different storage context. For initial migration, the user selects the original export through the browser UI and imports saved discussion files using the existing versioned migration rules. Do not inspect browser profiles or credential files. Keep the original cache and session files untouched until the user explicitly removes them.

All synthetic tests and development diagnostics must follow AGENTS.md. Do not record private database rows, import filenames, media, source identifiers, or request payloads in logs, fixtures, snapshots, build artifacts, or memory. Local storage does not imply encryption; database and backup encryption requirements remain a separate decision.

## Desktop distribution

Package the server, built Vue assets, runtime, launcher, and tray integration for each supported OS and CPU architecture. Target Linux first for validation; confirm Windows and macOS release scope before choosing the tray implementation. Test installation, repeated launch, login startup, shutdown, and credential storage on each supported platform. Signing and installer requirements depend on the chosen packaging technology; Tauri-specific build requirements no longer determine the release process.

The default browser renders the UI. Define a supported browser baseline and test folder selection, media playback, streaming, and session behavior against it. Platform-specific credential adapters remain necessary; the current Linux tooling does not establish Windows or macOS support. A CI build alone is not evidence of working installation or runtime behavior.

## Future NAS and Docker deployment

The hosted edition would run the same Node application server, built Vue interface, and HTTP API under Docker, with hosted authentication and configuration. A container would use persistent NAS storage for SQLite and media. SQLite remains a reasonable initial choice for a personal instance: the server owns the database, and clients use the API. Do not open the live database from multiple desktop clients over SMB/NFS. [SQLite deployment guidance](https://www.sqlite.org/whentouse.html).

Hosted imports require explicit upload to the NAS or access to a configured server folder; this changes the browser-local storage boundary and must be disclosed. Add application login, HTTPS, session and CSRF protection, authorized media access, upload limits, safe server credential storage, backups, and container builds for the NAS architecture. The desktop keyring adapter cannot simply be assumed available in a headless container.

If OpenAI later supports broader callbacks, verify hosted subscription eligibility, token handling, and registered callback requirements at that time. A callback policy change alone does not establish permission for the intended hosted service. Hosted viewing and storage are architecturally independent of that provider decision.

Multiple devices accessing one NAS library share central state. Offline synchronization between independent desktop databases is a separate feature requiring conflict resolution and credential boundaries; it is not implied by code reuse or database portability.

## Delivery stages and acceptance

| Stage | Deliverable | Acceptance evidence using synthetic data |
| --- | --- | --- |
| 1 | Local server, launcher, and tray | Built UI opens after server readiness; repeated launches reuse one instance; closing tabs leaves jobs running; Open/Quit and opt-in login startup work; local authority checks and OAuth remain effective |
| 2 | Durable library | Restart restores imported messages, media, reading state, and discussions; moving the source folder does not break media; backup/restore and migration failure recovery work |
| 3 | Incremental reconciliation | Identical imports make no changes; overlap, older history, reordered parts, repeated identical messages, changed reactions, missing assets, and ambiguous identities behave according to the rules above |
| 4 | Packaging and regression validation | Supported installers and credential adapters pass platform checks; privacy, context fidelity, import interruption, disk-full recovery, and deletion retries pass |
| Future | NAS deployment | Same server and API pass core contract tests, plus hosted authentication, upload, streaming, storage, and provider eligibility gates |

Lifecycle regression cases include a port occupied by another service, simultaneous launches, stale instance state, an unavailable tray, browser closure during a job, streaming reconnect, Quit during import or inference, server crash, and unauthorized local API/shutdown calls.

Required library regression cases include distinct accounts with similar threads, group membership changes, conflicting observations without stable IDs, an import during context preparation, source updates after a completed AI turn, crash recovery between asset installation and database commit, and restore into an unsupported app version. No private export or real credential is used in automated checks.

## Decisions before implementation

- First release OS support and whether distribution is personal or public.
- Launcher/tray implementation, bundled Node version, supported browser baseline, and installer formats.
- Default local port and authenticated launcher-to-server readiness/control mechanism.
- Exact fallback matching algorithm, supported format evidence, and local resolution flow for ambiguous matches.
- Backup location and whether encryption at rest is required for the library and portable backups.
- Whether one library may contain multiple account namespaces initially, or unrelated owners should be rejected until separately supported.
- Versioned representation of accumulated full-conversation context, including conflict and provenance metadata.

The agreed direction is a local Node server with a browser interface and launcher/tray controls, durable SQLite storage, conservative incremental imports, and the same server suitable for a later NAS edition. Tauri remains optional future packaging.

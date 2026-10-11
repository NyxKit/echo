# Google Drive exports and automatic library imports

Date: 2026-10-09. Status: exploratory specification; implementation and live-provider validation are not included. The requested direction is unattended daily ingestion of Meta exports delivered to Google Drive, with manual ZIP/folder importing retained.

## Goal and relationship to existing work

After setup, Echo discovers new export ZIP files in a configured Google Drive directory, downloads them, and incrementally merges their messages and attachments into the existing library. Previously handled files are tracked in the database so daily runs do not download and fully import the same exports repeatedly. The process runs at midnight while the background service is available, or catches up when the service first starts that day.

Build on the existing local Node service, SQLite library, managed media, durable jobs, and [import engine](library-import-engine.md). Both automated and manual imports must use the same validation, ownership, reconciliation, and transaction rules. The [conversation library spec](conversation-library-and-incremental-imports.md), [storage foundation](library-storage-foundation.md), [desktop delivery](desktop-delivery.md), and [PRODUCT.md](../../PRODUCT.md) remain authoritative for implemented behavior. The independent browser-only viewer does not gain an unattended background scheduler through this proposal.

This is a periodic archive refresh. Echo checks for exports that Meta has produced; checking Drive does not request an export from Meta or guarantee newly sent messages are available at midnight. It does not trigger Ask Echo or authorize sending imported content to OpenAI.

## Feasibility and evidence

The user reports that Meta can schedule daily exports into a Google Drive directory. Treat this as the intended upstream workflow. This research did not establish the exact personal-account message coverage, daily cadence, format, or delivery-completion contract from accessible official Meta documentation. The older [Meta connection investigation](meta-account-connection.md) also leaves recurring personal-message transfer unresolved; its historical browser-only architecture statements are superseded by the current library specs.

Before implementation, verify through current official documentation and, where necessary, a separately authorized application-level experiment using synthetic accounts:

- Eligibility for the intended account and region, and whether messages, groups, requests, reactions, and attachments are included.
- Whether daily recurrence is available, how long authorization lasts, and how delays or failed exports are reported.
- Whether delivery is JSON suitable for the existing importer, HTML, or a different schema. Unsupported formats must be detected rather than counted as successful imports.
- Whether delivery creates a new file ID each time, replaces existing file content, creates subdirectories, or produces several independent ZIPs. Establish how complete deliveries can be recognized.
- Whether exports are complete snapshots or date-limited observations, and whether the configured window overlaps enough history for reliable matching. A tiny export containing only new records may lack the evidence needed to associate a conversation.

Google's documented capabilities establish a viable downstream research route:

| Capability | Evidence and implication |
| --- | --- |
| Directory discovery | `files.list` supports query filters and pagination. Query a configured parent and exclude trashed files; finish pagination before treating discovery as complete. [Files list reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list) |
| ZIP retrieval | Binary files can be streamed using `files.get` with `alt=media`, subject to download permissions. [Download guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads) |
| File identity and changes | File metadata includes `id`, `version`, size, and optional content checksums. A version advances for metadata changes too, so it is a change signal rather than proof of new archive content. [Files resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) |
| Unattended authentication | Refresh tokens support access after short-lived access tokens expire, but can expire or be revoked. [OAuth lifecycle](https://developers.google.com/identity/protocols/oauth2) |
| Desktop authorization | Google's desktop OAuth flow supports PKCE and loopback redirects. A hosted edition needs a separately appropriate client and callback configuration. [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) |

These are documentation findings, not a tested integration. No real export, cached library, Drive account, or credential was inspected.

## Connection and permissions

Add a Google Drive section to Echo Settings. Initial setup connects a Google account, selects the destination directory, binds the source to the active library owner, and explicitly enables automatic imports. Explain that the authorized Echo service will periodically download archives and retain their imported records and attachments in the library. In a future hosted edition, disclose that downloads and storage happen on the server.

Meta's permission to place exports in Drive and Echo's permission to read them are separate grants. Keep Meta export setup in Accounts Center, with instructions or a link from Echo. Do not collect Meta passwords or reuse browser sessions.

Permission selection is an implementation gate:

- Investigate `drive.file` first, but prove access to previously unseen files created by Meta after setup. Google documents it as per-file access; selecting a directory must not be treated as a recursive grant to future children.
- `drive.readonly` permits reading and downloading all Drive files and is classified as restricted. If required, explain the actual breadth of the grant. Echo's directory filter is an application restriction, not a Google-enforced folder-only permission.
- Metadata-only access cannot download ZIP bytes. Do not request write/delete scope to support a read-only ingestion feature.
- Resolve Google verification and any assessment requirements for the chosen scope, distribution, and storage model, including the future hosted case, before promising release support. [Google scope definitions and requirements](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

Use a supported authorization-code flow with state, PKCE, and validated callbacks. A temporary desktop callback listener may have a different port from Echo's stable application origin. Keep refresh tokens in the existing OS credential-store boundary, with a separate Google credential namespace; SQLite holds only a credential reference and connection metadata. Browser code, URLs, logs, and static assets must not receive durable credentials. Verify unattended credential-store access on each desktop platform, including locked sessions. Do not treat testing-mode OAuth tokens as a durable release solution.

Settings should provide connection status, selected directory, automatic-import toggle, schedule/timezone, last completed check, last successful merge, pending/unavailable items, next attempt, Check now, and Disconnect. Details containing private source metadata appear only in the authenticated application. Changing the Google account or directory revalidates the binding; a Google account is not proof of the Meta export owner's identity.

Disconnect stops new provider work and removes local Google credentials. Offer provider grant revocation as a distinct, disclosed action because Google revocation may affect other grants in the same OAuth project. Disconnect retains imported library content. Manual importing remains available without Google connectivity. Never rename, move, delete, or mark Drive files remotely.

## Database tracking and duplicate prevention

Extend the library's migration-managed database with logical records below; exact tables and indexes are engineering choices. These identifiers describe a proposed schema, not real export values. Keep all provider metadata private to the application.

| Record | Minimum information |
| --- | --- |
| Drive connection | Internal ID, stable provider-account binding, credential-store reference, granted scopes, connection state |
| Import source | Library owner UUID, connection/account binding, directory ID, enabled state, source-configuration generation, timezone, schedule policy |
| Daily run | Source and local calendar date, attempts, discovery status, retry time, terminal summary, lease/fencing state |
| Remote file observation | Provider account, Drive file ID, observed version, size/checksum when supplied, discovery status; opaque provider integers stay lossless |
| Ingestion attempt | Remote observation, internal job ID, downloaded SHA-256, import-manifest fingerprint when available, importer/matcher versions, outcome, safe error category, retry and cleanup state |
| Successful receipt | Owner, provider account, file ID and handled version/content identity, committed import reference, result such as merged or unchanged |
| Pending source evidence | Validated unresolved observations, reason, matching evidence, replay state, and managed-media references; separate from successful receipts |

Use uniqueness constraints for `(owner, provider account, file ID, observed version)` and an active-attempt claim. Include library identity in shared infrastructure; provider identity must survive reconnecting the same account. Two directories or triggers discovering the same file cannot create competing imports. Never confuse a Drive file ID with a message-attachment asset ID.

Duplicate handling has several levels:

1. Skip a file observation already successfully handled at the same version before downloading it.
2. Reconsider a known file ID with a changed version. If an available strong content checksum and size match a verified prior receipt, link the observation as unchanged without extracting again. Otherwise download and calculate SHA-256; metadata-only changes can then be recognized without another full import.
3. Identical bytes under a new file ID can reuse a validated successful receipt only within the same library owner and compatible import-policy version. Establish the source binding before this shortcut; a checksum does not prove ownership.
4. Recompressed ZIPs, reorganized source parts, and equivalent folder imports still pass through the existing manifest/source-occurrence reconciliation when needed. Container hashes alone cannot identify equivalent message history.
5. Manual and automated imports share provenance and content deduplication. A folder import might not establish ZIP-byte equivalence, so a later Drive ZIP may require validation but must not duplicate stored messages or media.

Commit a successful receipt in the same SQLite transaction as its library changes and import provenance. A crash after commit but before job acknowledgement must recover from that receipt. A downloaded, discovered, rejected, interrupted, or unresolved file is not successfully imported. Retain separate suppression/retry state for unchanged rejected and pending observations so they are not repeatedly downloaded every day; new versions or an explicit retry can reconsider them. Parser/matcher upgrades need an explicit replay policy rather than silently invalidating all receipts.

File IDs avoid repeating completed archives; they cannot turn a full snapshot into a delta. A newly delivered ZIP may still require reading all its bytes and records. Message/source indexes and ordered reconciliation prevent duplicate history; date-limited upstream exports reduce transfer work only if their coverage and overlap are adequate. Do not skip records based on a latest-message timestamp.

## Discovery and intake pipeline

1. Claim the source's due run, verify the connection and library binding, and discover every page of eligible files in the selected directory. Default to direct children; recursive directory discovery is deferred until Meta's actual delivery layout requires it. Do not follow shortcuts or broaden the scan to unrelated Drive content.
2. Persist discovered file observations and pending work incrementally. A partial listing must not advance the completed-check marker. Respect API pagination, incomplete-search signals, request limits, and bounded scan budgets; preserve a continuation or restart safely on failure. A later full listing reconciles changes during pagination.
3. Queue all unhandled eligible observations, including older files found after an offline period. Never choose only the latest filename or modification time. Use deterministic ordering for reproducibility, without treating import order as authoritative history recency.
4. Fetch fresh metadata, check download capability, and stream the ZIP into private server-owned staging with the existing input/disk/time limits. Filter candidates using metadata, then validate actual ZIP structure; extension and MIME type are insufficient. Never fetch a source-controlled arbitrary URL.
5. Bind downloaded bytes to the observed file version. Compare fresh metadata/checksums before and after transfer; if content changes, discard the attempt and rediscover it. Validate actual size, available checksums, ZIP integrity, and supported source structure. Stable metadata across two checks is only a heuristic until the delivery contract is known.
6. Pass complete input into the same import worker as a manual ZIP. Validation, extraction, owner checks, media installation, source preservation, and reconciliation happen there. Serialize library writes with manual jobs and support cancellation between phases.
7. Atomically commit merged observations and their receipt, or durably classify unresolved/rejected work. Clean staged downloads after processing using existing retryable cleanup. Do not retain successful original ZIPs as an automatic archive backup.

If Meta produces multiple independent ZIP files, discover and process every file, retaining provenance separately. Missing attachments can be filled by a later part. Do not infer batch completion from a filename or a period of inactivity; require a documented manifest/completion signal to claim a whole export is complete. True split-volume ZIPs remain unsupported under the current intake contract. Unsupported delivery packaging is a feasibility failure to resolve before automation ships.

One corrupt or unrelated file should not block valid later files. Permission loss, storage exhaustion, or a library-wide integrity problem can pause the source. Use bounded retries with jitter and provider retry guidance for temporary network/quota failures. An unchanged malformed archive should settle into a visible rejected state, rather than consume a full download every day.

## Unattended reconciliation

The product goal is no per-run selection, confirmation, owner picker, or match-review prompt for supported routine exports after initial setup. This requires extending the current review-dependent importer deliberately; a scheduler around today's importer does not by itself satisfy the goal.

Use the existing versioned matching evidence and persisted decisions to resolve repeated observations. Stable source identifiers, supported explicit owner evidence, and ordered overlap can establish associations. Preserve repeated identical messages, unknown fields, exact values, attachment variants, and conflicting observations. Missing records in later exports never imply deletion. Background imports must preserve reading positions, discussion anchors, and completed immutable AI snapshots; unsent context follows existing revision checks.

No algorithm can guarantee correct identity for every ambiguous export lacking stable identifiers. Resolve this without forcing an interactive cron job:

| Situation | Proposed unattended behavior |
| --- | --- |
| Known owner and confident conversation/message match | Merge automatically, including new history, versions, and media |
| Known owner and clearly new conversation | Create a conversation automatically when existing rules establish it is new |
| Multiple plausible matches or insufficient overlap | Retain validated source observations and assets in a separate pending area; do not collapse identities or publish duplicate canonical history |
| Conflicting stable owner evidence | Reject for this library and leave existing history intact |
| Owner cannot be established | Hold privately outside canonical owner records pending stronger evidence; directory/account configuration alone is insufficient |
| Missing attachment | Preserve the record and mark the media unavailable; later imports may supply it |
| Unsupported or invalid source | Record an actionable failure; preserve existing history and continue eligible independent work |

This pending-evidence policy is proposed new behavior, replacing blocking review for the automated path only. It needs schema and importer work before implementation. A run with held evidence is partial, never a fully successful merge. Optional later review remains available, and later evidence or saved resolutions may automatically replay pending observations through the same transactional matcher. Replays must be idempotent and must not repeatedly create pending copies.

Apply explicit storage/size budgets to pending material. On exhaustion, stop accepting more held input and expose the source status; do not silently discard evidence or call it imported. Store supported source records and required managed media where possible, rather than retaining entire ZIPs indefinitely. Cleanup and deletion must include pending evidence.

Before enabling a source, bind it to an established library owner through the application. An empty library may use a one-time manual initial import or a validated setup flow. If the verified delivery format cannot provide enough identity evidence for routine unattended matching, record that limitation as a release blocker for the promised no-interaction workflow. Do not relax identity checks merely to remove a prompt.

## Scheduling, startup catch-up, and cron

The background service owns the scheduler and all jobs; the browser owns neither timers nor accepted work. Default to daily at 00:00 in a persisted IANA timezone, initially the machine's timezone and visible in Settings. Persist UTC instants for diagnostics and local calendar dates for scheduling. Define a timezone/configuration generation so changes do not accidentally replay completed days.

| Trigger | Behavior |
| --- | --- |
| Midnight while the service runs | Claim today's logical run and discover/import pending exports |
| First service start on a day without a completed due check | Start catch-up automatically; scan the full configured source for unhandled observations |
| UI opens while the service already runs | Display/reconnect to jobs; it must not create another competing daily import |
| Resume after sleep or a missed timer | Recompute whether a check is due and perform catch-up |
| Manual Check now | Request another discovery attempt through the same queue, independent of the daily limit |
| Future cron or system timer | Invoke the same internal operation and claims, with no separate merge implementation |

Persist last attempt, completed discovery, and successful merge separately. An empty directory is a completed check, not proof that a new export was imported. A failed check cannot suppress retries for the rest of the day. Pending file work remains retryable even after discovery completes. Do not start one historical scan per missed day: one catch-up scan discovers all still-available unhandled exports; archives removed upstream cannot be recovered by Echo.

Meta may deliver after midnight. Proposed default: bounded follow-up checks after an empty run or incomplete delivery at 15 minutes, 1 hour, and 4 hours, plus normal failure backoff. These are attempts within the same daily run, not duplicate imports. The next day's scan still catches later files. Confirm this policy against real delivery semantics before fixing retry constants.

Use database claims with expiry and fencing, the existing exclusive library-process lease, and the import queue to prevent races between midnight, startup, cron, retries, and manual work. A lease alone is insufficient if an expired worker can still commit: the commit must verify its current claim. A full local date is eligible once; repeated local times during daylight-saving transitions do not create duplicate daily runs. On clock rollback retain completed-date records; on a forward jump perform one catch-up scan. If local midnight is skipped, use the first valid instant of that date.

On restart, resolve committed receipts before retrying interrupted work, reclaim only abandoned staging, and reacquire claims. On Quit, stop scheduling and follow existing bounded cancellation/cleanup behavior. Closing a tab does not stop downloads or accepted imports. Explicit Pause automatic imports stops new attempts and cancels an active provider transfer before commit; committed library content remains available.

The local service can run at midnight only while the computer and service are running and required credentials are accessible. Login startup helps availability but does not wake a sleeping computer. Startup/resume catch-up covers these gaps. Creating an OS cron entry is unnecessary for the first desktop implementation.

For a future server edition, expose a proposed `import-sources run-due` command or equivalent service operation. If a service owns the library, the command signals it through authenticated control; it must not open a second SQLite writer outside the established runtime lease. A standalone headless mode can acquire the same lease when no service is running. Cron receives only an aggregate status/exit code, with no credentials or source metadata in arguments or output. Use the same timezone, receipts, claims, and retries as the desktop scheduler.

Hosted deployment also needs its own supported OAuth callback/client, protected persistent token storage accessible without a desktop keyring, authenticated UI, HTTPS, and existing owner/access boundaries. These remain separate deployment gates; this spec does not enable LAN exposure or install a server cron job.

## Manual importing and lifecycle

Keep the existing Import ZIP and Import folder flows. A disconnected/paused Google source never blocks manual intake. Both paths use the same serialized worker and deduplication rules, preserving the existing manual owner/match-review experience. Give user-requested jobs priority between automatic files so a large backlog cannot indefinitely starve manual work.

Delete library must disable its import sources, cancel provider work, invalidate queued claims, and remove receipts/pending evidence along with managed library content. An enabled connection must not silently repopulate a deleted library. Rebuilding requires explicit setup/enablement and rescans Drive because old receipts no longer represent data present in the new library. Google credentials follow the existing separate credential-lifecycle policy; remote source exports remain untouched.

Keep provider state, private source metadata, downloads, pending evidence, and credentials outside the repository and frontend assets. Only the authorized application runtime may ingest user archives. Development research, tests, diagnostics, and memory use synthetic data and mock provider responses exclusively, following [AGENTS.md](../../AGENTS.md).

## Acceptance and open decisions

Before implementing, settle Meta delivery coverage/completion, permission scope and future-child access, distributed OAuth feasibility, and the pending-evidence policy. Decide recursive directories and independent multi-ZIP batch behavior from the supported delivery contract. No message-format or ownership guarantee should depend on inspecting a real export with development tools.

Required synthetic acceptance covers:

- Paginated discovery, unchanged files skipped before download, changed content under one file ID, metadata-only changes, identical bytes under new IDs, and reconnection without receipt loss.
- Recompressed/repartitioned exports, full and incremental snapshots, older backfill, overlapping history, repeated identical messages, changed reactions, group membership changes, and attachment repair, with equivalent manual/automatic outcomes.
- No interactive step in supported scheduled imports; ambiguous observations held once, later evidence replayed, unrelated owners rejected, and valid later files processed despite held/rejected predecessors.
- First launch, midnight, sleep/resume, timezone changes, daylight-saving transitions, missed days, late deliveries, empty scans, partial pagination, and simultaneous cron/UI/manual triggers.
- Expired claims and stale workers, process death during download/extraction/media installation/commit, acknowledgement loss after commit, cleanup retry, cancellation, quota exhaustion, disk-full behavior, revoked tokens, and inaccessible credential stores.
- A changing remote file during transfer, missing parts, unsupported split archives, corrupt/encrypted ZIPs, excessive expansion, unsafe paths, shortcuts, and limits shared with manual intake.
- Delete library preventing automatic recreation, preserved historical AI snapshots, source-revision handling for unsent context, and no automatic analysis requests.

Live-provider acceptance, if separately authorized, must happen through the application with synthetic Meta/Google accounts and newly created exports. Prove delivery across repeated days, refresh after restart, future-file permission, and unattended operation on supported platforms. Report only sanitized capability conclusions in development artifacts.

The release bar is a repeatable supported workflow: one-time setup, unattended discovery and safe merging of valid routine exports, durable retry/idempotency, visible partial/failure states, and manual imports that remain usable throughout.

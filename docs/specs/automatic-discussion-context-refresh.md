# Automatic discussion context refresh after Instagram imports

Date: 2026-10-14. Status: implemented on the feature branch, with synthetic unit/service and browser validation.

## Problem and goal

An Ask Echo discussion can remain bound to the Instagram history available when its first response completed. After another import adds messages, a follow-up without a selection still reuses the old source context. The user can ask about a newly imported exchange that ChatGPT has never received. Adding a new selection can instead fail because the discussion's source version differs from the current library version.

Echo should determine locally whether committed source changes affect a discussion, then include the appropriate updated context on the next explicit Send. Continuing the same discussion should not require starting another discussion or manually refreshing its source. Detection must use source evidence and the established context policy, without asking a model to infer whether the question concerns newer messages.

For example, using entirely synthetic history: a discussion begins with Last week context. A later import adds a new exchange. The next unselected follow-up includes the latest Last week window and the previously shared context, allowing a question about that exchange to use current evidence. The earlier answer and its original snapshot remain unchanged.

## Relationship to existing requirements

Build on [PRODUCT.md](../../PRODUCT.md), [ChatGPT connection and analysis](chatgpt-connection.md), [library import reconciliation](library-import-engine.md), and [persisted discussions and jobs](library-discussions-and-jobs.md). The feature targets the persistent conversation library, regardless of whether a committed import came from the manual ZIP/folder workflow or a future supported import source. Automatic export discovery and scheduling remain separate work.

This spec supersedes the rule that a completed discussion must reuse frozen source context indefinitely, including the requirement to start a new discussion after a source revision. It preserves the fixed **scope choice**, immutable accepted requests, historical evidence, direct sending, and existing text/static-image sharing boundaries. PRODUCT.md and the connection/discussion specs describe this behavior; older frozen-source sections are superseded for the library edition.

The independent browser-only viewer is outside this feature's initial delivery. It must not display library freshness claims without an equivalent implementation.

## Context policy

The first completed turn establishes the scope choice. Refreshing does not change Last week into All time or widen Only selected messages. Global Settings defaults continue to apply only to new discussions.

| Established scope | Candidate context for a follow-up |
| --- | --- |
| Last 24h, 48h, week, month, 3 months, 6 months, or year; no new selection | Re-evaluate the chosen duration ending at the latest valid archived message timestamp in this conversation |
| Time scope with new selections | Resolve the same duration around each selected message, centering when possible and shifting within current archive boundaries, then merge overlaps and preserve gaps |
| All time | Resolve the full accumulated conversation at the committed revision |
| Only selected messages | Resolve the messages explicitly attached to this discussion, including any new explicit selections; include new observations of those messages, without adding unrelated messages |
| Legacy message-count scopes | Preserve their existing semantics using stable anchors; do not silently convert them into time scopes |

Use the existing inclusive elapsed-time window resolver and undated-message behavior. Time passing without a changed archive does not move a Last window. New selections remain focus anchors; automatically included records do not become selections or composer chips.

New surrounding windows use the shared [duration-driven boundary calculation](surrounding-window-boundaries.md). Persist their resolved bounds for future backfills. Imports that extend either archive boundary do not shift already established windows; legacy windows reconstructed from immutable evidence retain their original equal-halves bounds.

The next turn's source context is the union of completed historical evidence and the candidate context. Also re-evaluate previously established surrounding windows for newly imported records within those windows, and include newly observed versions of already shared messages. This lets an older backfill or an edit refresh relevant evidence even when the conversation's latest timestamp is unchanged. Previously shared records are retained when they fall outside the latest rolling window. Explain that retention in the existing sharing details.

Messages outside both the resolved windows and historical coverage are excluded. A question alone does not expand the scope; the user can select another passage within the existing scope policy or start a discussion with broader scope. Echo must never claim that a bounded discussion contains every message since it began. Several imports may leave a gap between the old and latest Last windows; retain that gap rather than silently expanding the duration.

## Detecting relevant changes

Run detection locally after an import commits, when reopening a discussion, and during preparation for every Send. Reopening and preparation must work after restart or missed browser notifications. Pending, failed, canceled, rejected, and unresolved imports do not affect canonical discussion context until accepted evidence commits.

Use a conversation-specific content generation or digest as a cheap invalidation signal. A library-wide revision is useful for transaction checks but is not sufficient evidence that this discussion needs new source context. Changes to other conversations, duplicate imports, reordering source parts, import receipts, and equivalent provenance-only observations must not trigger a substantive refresh by themselves.

After invalidation, compare the actual candidate evidence against the last completed coverage: stable message identities, immutable observed versions, relevant source metadata, and eligible source/media associations. Do not rely only on the newest timestamp, message count, display text, or export filenames. Backfills, changed reactions, equal-timestamp messages, unknown-field changes, and attachment observations can change context without advancing a timestamp. Preserve distinct repeated messages according to the import engine's identity decisions.

| Comparison result | Behavior |
| --- | --- |
| No completed turn | Prepare initial context from the current committed conversation |
| Candidate evidence is already covered | Reuse completed source coverage and history |
| New eligible records or observations | Prepare a new union snapshot on the next Send |
| Changed conversation, but changes are outside this discussion's coverage | Keep coverage; disclose the bounded scope without claiming all imported history is included |
| Missing or ambiguous source binding | Block preparation with a recoverable explanation; preserve the draft and selections |

Source conflicts remain separate observations with provenance; import order is not proof that one version supersedes another. Absence from a later export does not remove shared evidence or imply source deletion. Availability of an attachment alone does not authorize sharing its bytes.

## Preparing and accepting a refreshed turn

1. Resolve the established policy, historical coverage, current selection, and eligible source changes from one consistent committed library read. Prepare an exact accumulated envelope preserving unknown source fields and relevant metadata.
2. Retain the questions, completed answers, historical source evidence, and previously submitted image representations. Add eligible new evidence without rewriting any historical snapshot, answer, or citation.
3. Allocate stable, version-qualified evidence references for additions. Never reinterpret a historical positional reference against the newly sorted timeline. If the transport requires a new reference namespace, build a validated mapping into the new request without altering stored historical turns; distinguish changed observations of the same message.
4. Apply the existing image preparation and disclosure rules only to current explicit selections. New text context includes attachment metadata, not automatically added image bytes. Retained image copies remain exact; replacing an image's bytes requires a new explicit selection. Do not fetch linked resources or add audio/video analysis.
5. Bind the prepared payload and freshness summary to the discussion, owner, source generation, historical coverage, focus, model, provider account, actual media, and question. Validate transfer/image limits as usual. Never silently truncate, summarize, or change scope to fit limits.
6. At acceptance, atomically revalidate that the inputs and relevant evidence still match. Persist the exact new snapshot and accepted turn before dispatch, using existing request ownership and deduplication controls.

If relevant evidence changes between preparation and acceptance, reject the stale preparation before provider dispatch, preserve the draft, update the freshness disclosure, and require another explicit Send. Do not silently replace the reviewed payload or automatically resend. Unrelated library activity may be tolerated after proving the candidate is equivalent; a global revision change must not permanently prevent continuation.

An accepted or streaming turn stays bound to its accepted snapshot even if an import commits during generation. Surface pending updates for the following user-initiated turn. Completing the earlier request must not mark later evidence as covered.

Only a completed response establishes reusable discussion coverage. Failed, canceled, interrupted, or outcome-unknown turns retain their immutable submitted evidence and status, but do not advance the completed coverage marker. Distinguish completed coverage from evidence submitted in incomplete turns; keep the latter visible in sharing details. A subsequent send must not omit newly needed context because a failed request once attempted to share it. Retrying requires explicit action and follows the existing uncertain-delivery warning; restart, reconnect, and import never retry requests automatically.

## Application behavior and sharing

Keep the fixed scope label above the composer after completion. Add a compact local freshness indication where useful, such as “New imported context will be included” or “Using existing context.” Distinguish updates that are eligible for this discussion from newer history outside its scope. Do not label a discussion simply “up to date” when that could imply full-conversation coverage.

Send remains the authorization action, with no refresh confirmation modal or mandatory inspector. Detecting changes, importing, opening a discussion, typing, and preparing local disclosure send nothing to OpenAI. Explain automatic source refresh and historical retention in Settings sharing information. Exact prepared/submitted payload inspection stays optional and development-only.

On sent turns, retain the resolved scope/windows and source binding so users can distinguish earlier answers from answers using updated evidence. Library discussions continue to save automatically; add no discussion-file Save/Load controls. Preparation, limit, connection, and persistence failures preserve drafts and present actionable errors through the existing UI.

## Implementation outline

- In `server/library/discussions.mjs`, replace the unconditional no-selection historical-context shortcut with freshness-aware scope resolution. Replace the source-version mismatch prohibition with validated evidence union construction, not removal of source validation.
- In `server/library/core.mjs` and the import engine, separate relevant conversation content changes from the global transaction revision. Store coverage using immutable evidence identities and resolved window/anchor definitions rather than positional source indexes.
- Extend `server/library/prepare-context.mjs`, `server/library/analysis-jobs.mjs`, and acceptance validation to bind freshness summaries and reject relevant races. Review the shared analysis policy and HTTP/client types for any required versioned envelope changes.
- Persist the scope policy and completed coverage needed for reconstruction after restart. Migrate existing discussions using their immutable snapshots and validated source evidence. If an old binding cannot be reconstructed safely, keep history readable and explain how to start a new discussion; never guess based on titles, filenames, or ordinal positions.
- Update the analysis composer/discussion state to display local freshness and invalidate unsent preparations after committed changes. Reuse nyx-kit primitives, its default colors, and Vue/SCSS/BEM conventions.

The implementation uses schema version 5’s nullable `analysis_snapshots.coverage_json`, lazily reconstructed historical coverage, and append-only source parts preserving original references. Bounded refreshed turns explicitly declare `refresh: true`; full updates carry lossless metadata and attachment observations in `echo-library-context-update-v1` envelopes. Private preparation input stays server-side, and acceptance compares the exact evidence again. Preserve source evidence for all historical turns through migrations and library cleanup.

## Acceptance and validation

Use entirely synthetic archives, isolated browser state, and synthetic provider adapters. Assert the exact accepted payload, scope, reference mapping, and dispatch count; model recall is not evidence that the correct context was sent.

1. Complete a discussion, import newer messages into the same conversation, and send without new selections. The fixed time policy resolves against the latest archived timestamp; eligible new evidence and prior history reach the same discussion in one explicit dispatch.
2. Repeat the same import or import an unrelated conversation. No new coverage is reported, no duplicate records are added, and no automatic inference occurs.
3. Import older records inside an established surrounding window, an edit/reaction/unknown-field change to a shared message, and distinct messages sharing a timestamp. Detection finds the appropriate changes without relying on the latest timestamp or count.
4. Exercise every current time duration, disjoint selections, undated messages, a long gap between imports, All time, Only selected messages, and legacy scopes. Out-of-scope records remain excluded; historical coverage remains retained.
5. Import records that insert before old citation positions and conflicting observations of an old message. Old citations still resolve to their original evidence; new observations receive distinct references. No old payload or answer changes.
6. Commit an import between preparation and acceptance. Relevant changes reject dispatch and preserve the draft; equivalent unrelated changes can proceed after validation. Commit during streaming; the active snapshot stays immutable and the next turn can refresh.
7. Fail, cancel, interrupt, and ambiguously disconnect refreshed turns. None advances completed coverage or automatically retries. A later explicit Send still includes required new context.
8. Add or replace image assets through an import. No new image bytes are shared without a current explicit selection; retained historical representations remain unchanged. Verify transfer/image-limit failures preserve draft and context without reduction.
9. Restart the service or reconnect the browser after importing. Freshness is reconstructed without a live notification. Existing discussions migrate safely or remain readable with a clear recovery path.
10. Verify import, detection, reopening, preparation, and selection changes cause zero provider requests. No private source, cached export, credential, or saved real discussion is read by development tooling or written to logs, fixtures, snapshots, documentation, or memory.

Completion requires synthetic unit/service coverage for evidence comparison, union construction, migrations and races, plus browser coverage of disclosure, sending, errors, reopening, and draft preservation. PRODUCT.md and the superseded scope rules are updated with the implementation. Live account validation, if needed, belongs to a separately user-initiated application workflow.

# Persisted discussions and analysis jobs

Engineering decision, 2026-10-07. Preserve the existing direct-send and scope disclosure contract while moving accepted work into the library service.

The server constructs a versioned accumulated-context envelope from immutable message versions and source metadata. It retains exact JSON values and provenance, gives each observed version a stable reference within the frozen snapshot, and preserves distinct repeated occurrences. Full scope includes conflicting observations, attachment-observation digests/sizes and disjoint history; scoped requests contain only their declared record union and citation map. Conflicting attachment alternatives are disclosed as exclusions from image preparation. The UI explains that the envelope accumulates imports rather than representing one original export.

Discussions, drafts, turns and snapshots carry the active library owner's UUID. Save drafts during editing, with loading/error feedback and no routine saving/saved status; do not depend on unload. A revision check rejects stale unsent context. Accepted turns store their exact payload, actual prepared static-image representations, provider/account binding, model, source revision, and context references before dispatch. Credentials remain in the provider service and OS credential store, never in SQLite or snapshots.

The existing provider service remains responsible for OAuth, renewal, eligibility, model validation and transport. Expose a narrow internal job capability after browser provider authorization. The library API separately checks its paired session. Accepted jobs own their cancellation controller independently of the accepting response socket. Persist progressive answer text and final status; reconnect reads the existing job, never submits it again. Persist request IDs so resubmission cannot duplicate inference across process restarts.

On shutdown, wait for in-flight acceptance/preparation, cancel active provider work, retain partial answers and record uncertainty. On restart, mark formerly running turns interrupted/outcome-unknown without retry. A stopped or disconnected browser can reopen discussions and read saved answers. Explicit Stop, Disconnect ChatGPT, Delete discussion and Delete library remain distinct actions. Discussion-file import/export is no longer exposed in the browser UI or HTTP API; existing persisted discussions remain readable.

Validation uses synthetic provider adapters only: close the accepting tab, reopen and reconnect, cancel, crash/restart, duplicate submission, rejected owner references, changed library revision, immutable completed context after imports, malformed historical content, and storage failure. Live provider eligibility and secure-store behavior on release platforms require separate application-level validation; development tools never read real credentials.


## Server preparation and static images

The library service builds selected-only, elapsed-time windows, and accumulated all-time context (legacy surrounding scopes remain readable) from its own records. Prepared turns expire after five minutes, are bounded to four per server, and bind the exact payload and connected provider account. Accepting a changed preparation fails; repeating an accepted request only returns its durable state.

Static PNG, JPEG, and WebP are decoded in a worker using Sharp 0.35.5, with at most 40 million input pixels and 15 MiB source bytes. The worker applies orientation, fits within 1024×1024 without enlargement, strips metadata, and emits PNG. GIF/animated images and active formats remain excluded. Decode work has a 15-second deadline; the eight-image discussion limit remains unchanged. Production packages must include Sharp's target-specific native binaries. See [Sharp input limits](https://sharp.pixelplumbing.com/api-constructor/) and [metadata inspection](https://sharp.pixelplumbing.com/api-input/).

Discussion portability uses format 5: saved immutable payloads plus source-occurrence and conversation evidence (including empty drafts), validated against the active library conversation before a transaction creates new discussion IDs. Original source-part ordering is retained per import to validate existing versions 1–4 by their original source hash. Importing a discussion never dispatches a provider request. Imported historical context remains frozen; adding context after a source revision requires a new discussion.

Current time-window definitions, defaults, and settings placement are specified in PRODUCT.md under Current Ask Echo context and settings policy.

# Durable library storage foundation

Decision and implementation scope, 2026-10-07. This continues [the conversation library spec](conversation-library-and-incremental-imports.md).

## Decisions before implementation

Use Node's bundled `node:sqlite` in a dedicated worker. `DatabaseSync` is synchronous, so database and file-copy operations must not run on the HTTP thread. Node 24 remains the target runtime; the source launcher now needs at least Node 22.13, when SQLite no longer requires a command-line flag. The API remains experimental on these LTS lines, so keep it behind the storage adapter and validate runtime upgrades. See [Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).

Place the Linux library in `$XDG_DATA_HOME/echo` or `~/.local/share/echo`, separate from lifecycle state, static assets, and source exports. Use a separate library lease so different launcher-state directories cannot open the same library simultaneously. Directories are owner-only; database, journal, staging files, and installed assets must be regular owner-only files. Do not open a real library during development checks.

Use versioned SQLite migrations in one transaction, `foreign_keys=ON`, rollback journaling, and `synchronous=FULL`. Check the application ID and schema version before migration or recovery; refuse a newer schema without modifying it. Migrations are SQL-only in this slice. File-changing migrations require a separately designed staging protocol. No backups are created. SQLite documents [transactional commit](https://www.sqlite.org/atomiccommit.html) and [composite foreign keys](https://www.sqlite.org/foreignkeys.html).

Every logical record belongs to an opaque UUID `userId`. Composite foreign keys include ownership and the relevant conversation/message identity. Callers of the storage adapter do not choose the active owner for queries. This adapter is an internal capability, not browser authorization.

### Owner resolution

The intake adapter accepts explicit `owner.id`/`account_owner.id` decimal-string evidence and self markers, with synthetic fixtures for these shapes. Do not infer identity from display names, directory names, or the ChatGPT account. Without supported authoritative evidence, local owner review explicitly establishes self before committing history. The core allocates a random UUID and stores the exact evidence JSON. A later confirmation or correction must name the existing expected internal owner and retains that UUID; unconfirmed or mismatching owners are rejected. These methods are internal and must not be exposed as an unchecked caller-supplied ownership assertion. A future verified source adapter may add namespaced stable identifiers without changing existing internal IDs.

### Source storage and initial imports

Provide an internal atomic conversation-import operation accepting complete JSON source parts and already managed asset IDs. Preserve each original source string, unknown fields, numeric literals, and each ordered message occurrence. Normalized sender/text/timestamp values are display indexes only. Allocate random conversation, message, and version IDs. Never identify records from a title, participant name, filename, or message fingerprint.

The caller must explicitly supply an already resolved conversation ID for a repeat import. Byte-identical source parts and identical asset bindings for that conversation are a no-op, including reordered parts. Within this low-level primitive, changed observations return `library_reconciliation_required`; the user-facing importer uses the separately implemented conservative matcher. It does not overwrite or silently duplicate history. New unrelated conversations receive new IDs even if their content happens to match. This is a storage primitive, not the finished folder/ZIP importer or reconciliation algorithm.

Bound this initial operation to 32 MiB total source text, 8 MiB per part, 256 parts, and 100,000 messages. Reject oversized or malformed input atomically, without truncation. The user-facing importer streams files into staging and processes bounded conversation groups. The [import engine](library-import-engine.md) records its limits and synthetic calibration.

### Managed media

Accept byte chunks through a bounded worker protocol, never caller-supplied filesystem paths. Limit chunks to 1 MiB, each asset to 256 MiB, and one active upload per worker. Check free space while writing with a 256 MiB reserve. The caller streams bytes from a narrowly scoped import source; the storage adapter does not open source folders.

Hash into generated private staging files, flush complete bytes, install under a SHA-256 name, flush the managed directory, then commit the database asset reference. A crash can leave an unreferenced file, but a committed reference cannot point to an unfinished copy. Recovery removes abandoned staging and unreferenced generated content only after checking the database; it never follows links or removes referenced assets. Failed cleanup blocks readiness with a safe retryable category. Interrupted writes never become readable assets. Missing attachments are represented explicitly as unavailable associations.

## Scope of this slice

Implement and test the worker adapter, migrations, ownership, lossless conversation storage, stable paginated reads, managed media, and reading-position persistence. The production launcher opens and closes this library with its lifecycle. Browser endpoints require separate pairing/session authority and a typed HTTP client, now implemented in the subsequent [browser-access slice](library-browser-access.md). The local-server UI now reads its timeline, discussions and drafts from the library. Only standalone Vite/static mode retains browser archive and discussion storage.

Timeline integration, folder/ZIP intake and reconciliation, automatic discussion/turn persistence, immutable AI snapshots, durable background jobs, tray controls and package builds are implemented. See [release acceptance](library-release-acceptance.md) for remaining platform validation.

## Implementation and validation

The adapter lives in `server/library/`; its TypeScript declaration describes the internal capability boundary. The standalone launcher opens the library before publishing readiness and closes it before releasing its instance lease. Vite's standalone browser viewer does not open this database. The subsequent browser-access slice exposes protected reads, media, and reading positions; owner resolution and imports remain internal.

Synthetic checks validate exact JSON and large numeric-literal retention, distinct repeated occurrences, owner corrections without changing identity, rejected foreign references, byte-identical reimports, changed-source refusal, paginated reads, saved reading positions, and managed media after reopening. Additional checks force failures after conversation/provenance writes and after asset installation to verify rollback and orphan recovery. Newer schemas remain byte-for-byte unchanged; recovery does not run against them. Source records and occurrences reject updates at the database layer.

The storage and lifecycle tests pass on Linux with Node 22.13.0 and Node 24.21.0. The full unit suite, TypeScript validation, and frontend production build pass under Node 24. The existing frontend chunk-size advisory remains. A real CLI smoke check uses disposable state and data directories to verify initialization, shutdown, library reopening, and restart on the saved port. No export, existing browser cache, real library, or provider credential was inspected.

Release validation still requires actual target-desktop credential stores, browser integration and filesystem/power-loss checks. ZIP intake, library authorization, owner review, incremental matching, deletion retries and large synthetic imports now have automated coverage. Accepted import jobs own pending assets and cleanup; failures preserve the last committed library.


## Explicit deletion

Delete library first stops accepted work, closes intake, and commits removal of all owned rows with a durable cleanup-required flag. SQLite secure_delete is enabled; after row removal the database is vacuumed, managed media and staging are removed, and private import-job directories are removed with checks that prevent following symbolic links. Source exports are never addressed. Cleanup failure keeps the flag set and intake closed, exposing a retry action across restart. No success is reported until managed cleanup completes. This is application-content removal, not a claim of forensic erasure from the OS, disk snapshots, or provider storage. A new full export can establish a new owner and rebuild history after completion.

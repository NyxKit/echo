# Reaction updates across imports

Status: implemented on the feature branch. All development examples and checks use synthetic records.

When observations already matched to one message differ only in top-level `reactions`, treat them as one content version. Show reactions from the most recently committed import of that content version. Replace the entire reaction state, including removals or an absent reactions field; do not union old and new reactions. Do not show a source-version conflict for this case.

## Ordering and content changes

The library records committed import sequence, not export creation timestamps. Use the stored import row order because repeated imports can share a library revision. Re-importing an older export intentionally restores its reaction snapshot under this policy. An identical repeat of the current source set changes no visible state. Stored observation order breaks ties within one import deterministically.

Group matched observations by all source members except top-level reactions. Ignore insignificant JSON whitespace and top-level member order, while retaining unknown fields, duplicate members and exact numeric literals in comparison. Never round large identifiers or compare only sender, text and timestamp. Nested reaction fields, message text, share metadata, attachments and other source-field changes remain distinct content versions.

Content edits retain separate versions and the existing earliest-content timeline policy. Import order alone does not establish edit chronology. This change does not alter conversation matching, message identity or ambiguous-match review.

## Current state and historical evidence

The timeline, version count, source-version list and newly prepared analysis context use one current observation per content version. Existing reaction-only variants collapse automatically when the library is read, without a migration or re-import. Genuine edits and attachment-byte conflicts remain visible.

Original source parts and observations remain lossless provenance for immutable historical AI snapshots and citations. They are not separate current content versions. Never overwrite an accepted AI payload, invalidate an old reference, or remove historical evidence from an ongoing discussion.

New discussions include only current observations. A continued discussion retains its historical source union and adds eligible current observations on explicit Send. When retained history contains superseded reaction observations, `context.currentReferences` identifies the current observations, including reversions to an already shared record. Validate these references and bind them into acceptance checks. Importing, reading and local preparation trigger no inference.

## Implementation and validation

`server/library/message-versions.mjs` provides the shared canonical view for library message reads, snapshots and discussion preparation. A source-set change invalidates cached views even when every raw record was seen before. Scope page reads to requested messages and retain at most one complete conversation in the shared cache.

Use synthetic regression cases for reaction addition, replacement, removal, unchanged repeats, older re-imports, restart, distinct messages, real edits, unknown fields and large numeric literals. Verify exact new-discussion payloads and immutable existing-discussion snapshots for selected, time and all-time scopes. Confirm that an old observation can become current without being appended again to the historical source union.

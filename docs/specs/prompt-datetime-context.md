# Per-prompt datetime context

Date: 2026-10-15. Status: implemented on the feature branch; synthetic validation accompanies the change.

## Behavior

Every new Ask Echo analysis prompt includes hidden timing metadata captured when the user starts its Send preparation: a canonical UTC `sentAt` instant and the browser device’s IANA `timeZone`. The provider receives these values plus an ISO local datetime with its numeric UTC offset, calculated for that instant. This makes phrases such as “yesterday” and a short period without a reply interpretable in the user's local calendar and time of day. The visible question remains exactly what the user wrote.

The instructions tell the model to use timing only when it materially helps answer the question. It should avoid announcing the current time or adding time-based advice to unrelated requests. Another participant's timezone, whereabouts, work schedule, availability, or motives cannot be established from this metadata. Possible explanations for a delay must remain possibilities, not factual claims.

For a synthetic example, a prompt sent at 08:00 local time about lunch “yesterday” can support a measured observation that it is still early in the day. It does not establish why someone has not replied or guarantee that a response will come.

## Lifetime and persistence

- Each prompt owns its own clock. Initial prompts, selected-message prompts, attachment-free follow-ups, and new explicit retry attempts capture a new instant. Accepted payloads and duplicate request IDs retain their original captured time.
- Earlier questions keep their original timing in subsequent model history. The model must not reinterpret an earlier “yesterday” using a later prompt's clock.
- Existing turns without timing metadata remain readable and have unknown submission times. Never fabricate a timestamp while loading or migrating history.
- Both the library and independent browser viewer capture the device clock. The library preparation endpoint also supplies its local clock when called without timing metadata by an older client. Invalid explicitly supplied metadata is rejected.
- Timestamp and timezone are part of immutable turn JSON and request digests. No database schema migration is needed. Internal discussion portability and the existing compatibility readers preserve the optional metadata.
- A developer inspection previews its preparation time locally; the next explicit Send prepares again with a fresh clock. Preparation, inspection, typing, reopening, and connection actions do not transmit analysis content automatically.

Archived Instagram message times remain separate evidence. Scope windows still end at the latest archived message, and prompt timing neither expands source coverage nor implies that an archive is current. The clock reflects the user's device settings; it is not independently verified against a time service.

## Sharing and validation

Settings sharing information discloses the date, time and timezone metadata. It stays out of question bubbles and composer text; the optional developer inspector includes the exact outgoing representation. No new network requests, time synchronization service, or logging is introduced.

Synthetic tests cover timezone offsets, midnight and date boundaries, daylight-saving transitions, fractional offsets, malformed metadata, exact wire representation, independent clocks in historical turns, library persistence/restart, prepared-request tampering, and first/follow-up sends in both application editions. Browser checks verify that new sends capture fresh timing without adding it to the visible question. Model instructions are validated locally; these tests do not claim that a live model will always interpret relative dates correctly.

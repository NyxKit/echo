# User-provided conversation context

Date: 2026-10-20. Status: implemented for the persistent library; browser-only persistence remains deferred.

## Problem and goal

An Instagram archive does not explain everything about a relationship. The user may want to record how they know someone, shared history, or circumstances that help interpret an exchange without repeating that background in each Echo discussion.

Allow the user to write general context for a conversation in its Information shelf using nyx-kit's Tiptap-based Markdown editor. Each conversation owns one note, separate from its archived messages and individual Echo discussions. Group analysis also automatically uses available notes from the participants' individual conversations.

For a wholly synthetic example: “We met through a neighborhood club years ago. We stopped speaking for a while after a disagreement, then reconnected.” Another conversation has its own independent context.

Build on [PRODUCT.md](../../PRODUCT.md), [ChatGPT connection and analysis](chatgpt-connection.md), [persisted discussions and jobs](library-discussions-and-jobs.md), and [automatic discussion context refresh](automatic-discussion-context-refresh.md).

## Confirmed product decisions

The user confirmed the following behavior:

| Choice | Behavior |
| --- | --- |
| Sharing with Echo | Automatically include saved context whenever the user explicitly sends an analysis prompt; disclose this in Settings |
| Edits during an existing discussion | Use updated context on the next explicit Send; preserve earlier turns |
| Group conversations and ownership | One editable note per conversation. A group has its own general note and automatically inherits available individual context for its participants |

The user manages a participant's background in their individual conversation, once. They do not configure, copy, or maintain that participant's note separately in each group.

## Information shelf

Add a **Conversation context** section to the existing accordion, immediately after Participants and before History. Keep the conversation summary above the accordion. Start the new section expanded, consistent with the current sections, and preserve its draft when it is collapsed or the shelf closes.

Show one inline editing surface with the placeholder “Add background about this person or conversation…”. A short hint explains that this is background supplied by the user and says “Included when you send a question to Echo.” Full sharing details stay in Settings.

In a group, this editor changes only the group's general note. A compact read-only list below it identifies individual conversations whose context will also be included, with links to those conversations for editing. Do not add participant editors, inclusion toggles, or a group-specific mapping workflow. An empty group note does not prevent automatic inclusion of available individual notes.

Use `NyxEditor` from `nyx-kit/components` with a Markdown string model and Zen mode. The library source confirms `NyxEditorMode.Zen`, `NyxEditorFormat.Markdown`, the `change` and `blur` events, and the `hasSourceToggle` and `hasFooter` props. The editor is exported by the components entry. Use its existing formatting controls and keyboard editing rather than building a second editor. Keep the persistent toolbar, source toggle, footer, and annotation/comment UI out of the initial surface.

Save automatically locally after a short debounce, with a flush on blur or navigation where possible. Do not depend on tab unload to save. Clearing the document saves an empty value; an empty or whitespace-only note contributes no additional background text. Routine saved/saving messages stay hidden; loading, save failures, and an actionable retry appear beside the editor. Retain the user's draft on failure.

Loading must be distinguishable from an empty saved note. Do not let typing against an unresolved load overwrite existing content. Switching conversations must immediately bind the editor, pending saves, and undo history to the correct conversation; a delayed response must never replace another conversation's draft. Closing the shelf and switching to Echo must preserve unsaved edits.

Use a 400px Information shelf to give the editor more room, retaining the responsive overlay capped at the viewport width. The editor must fit the shelf, wrap long text, support keyboard entry and formatting, and have an accessible name associated with the section. Its text-selection and editing shortcuts must not trigger timeline message selection or Echo sending. Use Vue, SCSS/BEM, nyx-kit tokens, and its default colors.

## Storage and lifetime

The first delivery targets the persistent library. Store the Markdown in the existing local SQLite library, keyed by the stable owner and conversation identities, with a revision for concurrent updates. Do not key it by a title, participant name, export path, or current message ordering. Additive migration gives existing conversations empty context without inventing background.

Context is user-authored application data. Never write it into source exports or let an import replace it. Re-importing or incrementally extending a matched conversation retains its context. A separately created conversation starts empty, even if its title or participants resemble an existing one. Manual self-identity corrections do not move context between conversations. Deleting an Echo discussion leaves the conversation's context intact; Delete library removes it with the rest of the managed library data.

Use the existing paired, owner-scoped library API and optimistic revision checks. Concurrent edits must not silently overwrite one another; keep the local draft and offer recovery from a conflict. A failed read or write must not silently become an empty successful save. Keep sensitive note contents out of localStorage preferences, URLs, routine errors, logs, and telemetry.

The independent browser-only viewer remains usable. Persistent context there is deferred; do not show an editor that appears durable without implementing its archive-bound storage and Forget archive cleanup.

## Automatic individual context in groups

For each group Send, resolve the group's participants and look up their individual conversations within the same library owner. Exclude the library owner from this lookup. Include the nonempty notes from confidently matched one-to-one conversations alongside the group's own nonempty note. This works without a group note and without the user first opening the individual conversation in the current session.

Label the group's general background separately from each participant's background, retaining the participant association and source note identity/revision. Include each source note once even when several aliases resolve to it. If multiple distinct one-to-one conversations are confidently linked to the same person, retain their separate labeled notes rather than silently choosing or merging them. Missing individual conversations or empty notes require no action and add nothing.

Inheritance reads only user-authored notes. Never include messages, source metadata, images, or Echo histories from those individual conversations. Do not inherit notes from other groups or recursively traverse relationships. A direct conversation uses its own note, without automatically inheriting group notes. Group and individual notes are complementary background; do not silently discard one when they differ. The model should keep their scope and attribution clear and acknowledge relevant ambiguity rather than inventing a resolution.

Resolve people through validated participant account identifiers or an established identity mapping, never display-name similarity alone. A thread identifier is not automatically a participant account identifier. Unresolved or conflicting matches must not attach a potentially unrelated person's note; surface unavailable inheritance unobtrusively and keep the group's own note usable without adding a per-group management task. Distinguish unresolved identity from a confidently matched person who simply has no note.

Implementation prerequisite: the current library exposes participant labels and owner-scoped conversation aliases. These do not establish a cross-conversation person identity by themselves. Establish and validate the supported participant identity mapping with synthetic fixtures before claiming inheritance works. If the available source representation cannot resolve a participant, preserve the unresolved state rather than guessing or requiring the user to maintain each group separately.

## Echo integration

Every analysis Send automatically includes the resolved notes as separately labeled **User-provided conversation context**. This applies to initial prompts, attachment-free follow-ups, and selected-message prompts, including Only selected messages. Notes are additional background, not an expansion of the archived-message scope. They do not become selected-message chips or alter the visible question.

Treat notes as the user's account of the relationship, not independently verified evidence or higher-priority model instructions. Keep them distinct from original source records and assistant answers. They create no Instagram message citations and cannot authorize tools, fetch linked resources, or grant access to other conversation content. Echo's separate prompt-only subject-generation request continues to exclude them.

For each Send, preparation resolves the latest saved conversation note and applicable individual notes, includes their identities, revisions, and exact text in the immutable request binding, and retains the versions used by each accepted turn. Individual-note changes apply on the next Send in every matching group, without copying notes into group storage. Re-evaluate available notes and participant mappings each time so additions and removals also take effect.

The current set supersedes earlier background for the new answer, while historical questions, answers, source evidence, and submitted snapshots remain unchanged. Explicitly distinguish removed background from the current set when earlier versions remain in discussion history. Removing a note does not erase context already sent in previous turns or retract it from the provider; sharing details explain historical retention.

Before Send preparation, finish saving pending edits to any notes in this request that are being edited in the current client. If saving fails or conflicts, preserve the question, selection, and context drafts and show the error instead of sending older notes silently. Local inspection may preview drafts, but actual Send prepares again from committed data. Changes to a relevant note, resolved participant mapping, or applicable-note set between preparation and acceptance invalidate the preparation before dispatch, requiring another explicit Send. Changes after acceptance affect a later turn, never the running request. Unrelated note changes must not block the request.

Extend existing transfer-limit checks and prepared-request integrity validation to include all resolved notes. Never silently truncate or summarize them. Existing discussions without a context snapshot retain unknown/absent historical context; do not backfill old turns with today's notes. Preserve existing request deduplication, explicit retry, and uncertain-delivery behavior.

Opening a conversation, editing or saving context, importing, inspecting locally, or connecting ChatGPT must not trigger a provider request. Settings explains automatic individual-note inheritance in groups, exactly when notes are included, and how earlier versions remain in discussion history. The optional development-only inspector shows the exact outgoing blocks and their origins under its existing local inspection policy; it must not log or export the payload.

## Privacy and rendering

Treat this context as sensitive, like archived conversations and saved analysis. Development uses entirely synthetic notes and isolated temporary libraries/browser state. Never inspect a real archive, cached export, saved discussion, or user-authored note through development tools, and never copy such material into repository artifacts or memory.

Markdown and pasted content remain untrusted. Render raw HTML inertly, prevent script execution and unsafe link activation, and prevent automatic remote image or link fetching. The initial feature accepts text and formatting with automatic individual-note inheritance in groups. Note attachments, image uploads, AI-generated biographies, and a separate person-profile editor are outside the requested scope.

## Acceptance and validation

Implementation validation uses synthetic fixtures and mocked provider adapters. Inspect exact prepared and accepted requests rather than relying on what a model appears to remember.

1. Add and edit formatted context in Information using the actual nyx-kit editor. Verify Markdown round-tripping, keyboard access, narrow layouts, and an empty note.
2. Keep distinct context for two conversations, including identical synthetic display names. Switching, collapsing the section, closing the shelf, refreshing, and restarting retain the correct committed note without sharing undo history or misdirecting delayed saves.
3. Re-import a matched conversation, add history, correct self identity, and create a separate conversation. Existing context stays attached to its stable conversation; new conversations begin empty.
4. Exercise loading failure, save failure, navigation during debounce, and two concurrent editors. Preserve drafts, expose recoverable errors, and prevent silent overwrites or stale-context sends.
5. Verify automatic inclusion for initial sends, follow-ups, Only selected messages, and empty notes. A direct conversation includes its own note; a group includes its general note plus confidently matched participants' individual notes, even with an empty group note. No unrelated notes, private messages, source metadata, images, or discussion histories are inherited. Archived-message scope and subject-generation requests stay unchanged.
6. Exercise missing notes, ambiguous identities, identical display names, aliases, multiple direct threads, participant changes, and another owner. Deduplicate source notes, retain correct attribution, expose unresolved matching, and prevent inheritance from unrelated groups or recursive lookup. Group editing presents only the group's note and read-only links to inherited sources.
7. Edit or clear an individual note and a group note during an existing group discussion. The next explicit Send uses the updated applicable set, including new or removed notes, without reopening individual conversations or copying background into groups. Verify immutable old snapshots, historical-retention disclosure, and safe migration of legacy discussions.
8. Change a relevant note, participant mapping, or applicable-note set between preparation and acceptance and during streaming. Verify dispatch rejection for stale preparations, accepted-payload immutability, unrelated-change tolerance, transfer limits, explicit retries, and no duplicate inference.
9. Assert zero provider requests for opening, editing, saving, importing, inspection, and connection alone. Exercise unsafe pasted HTML, Markdown links/images, Delete library cleanup, and note non-exposure in logs and URLs.

## Delivery details

Schema version 7 adds owner/conversation-keyed `conversation_context` rows, with absent rows read as empty revision 0. Notes have a 256 KiB UTF-8 storage limit and optimistic revisions. The paired library API exposes GET/PUT on the conversation's `/context` resource. Imports, self-label corrections and discussion deletion do not move or replace notes; library deletion removes them.

The supported participant account contract is an explicit canonical decimal-string `participants[].user_id`, scoped to the active library owner. The owner must be identified by an account already validated through the import owner-resolution flow. Generic participant `id`, thread IDs, handles and labels are deliberately insufficient. Only consistent two-account observations containing the verified owner establish a direct partner. Known groups are excluded from direct-note lookup. Aliases claiming the same account deduplicate; missing or inconsistent claims keep inheritance unresolved. No per-group repair interface is introduced. Existing label-only exports therefore retain their own editable notes but do not acquire guessed participant links. This contract is validated with generated fixtures, not a claim that every Instagram export supplies account identifiers.

Inheritance resolves from the latest committed import's participant observations and reads only direct-note rows from the same owner. Preparation and acceptance bind a complete per-turn background set, including its source note revisions and relevant identity mapping. Empty sets explicitly supersede earlier background. Existing snapshots lacking this field retain absent historical background. Note edits do not advance archive evidence coverage or change source citations; the request byte limit includes all background blocks.

The client keeps drafts in memory per conversation, debounces writes by 400 ms and flushes on blur, component navigation and Send. Send resolves relevant direct-note IDs, including currently empty saved notes, before flushing local drafts. Conflicts preserve local text and present the saved version with explicit recovery actions. NyxEditor uses its Markdown/Zen defaults, without persistent toolbar, source toggle, footer or comments. Raw HTML and image syntax are rendered literally; rich HTML paste uses its plain-text alternative. Note links do not activate from the editor.

Validation uses isolated SQLite libraries, generated imports, mocked providers, mocked paired API responses and fresh Playwright browser contexts. It covers identity boundaries, source-note isolation, inheritance, next-Send changes, immutable history, stale acceptance, optimistic conflicts, delayed saves, cleanup, transfer limits, editor formatting, desktop/mobile layouts and inert content. Live-provider or real-export validation is outside these development checks.

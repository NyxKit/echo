# Conversation assets in Echo prompts

Date: 2026-10-24. Status: implemented on `feat/prompt-conversation-assets`, with synthetic service and browser validation.

Interaction revised 2026-10-25: attachment menu and searchable conversation modal.

## Problem and goal

An Echo discussion belongs to one archived conversation. Sometimes the answer needs evidence from another conversation: the user described an exchange with one person to someone else and wants to ask, “Did I forget to include something?”

Allow explicit conversation attachments in the prompt, each with an independent archived-message context window. Keep the active conversation and its fixed discussion scope intact. Build on [ChatGPT analysis](chatgpt-connection.md), [persisted discussions and jobs](library-discussions-and-jobs.md), [conversation context](conversation-context.md), and [automatic context refresh](automatic-discussion-context-refresh.md).

## Composer interaction

Add an accessible plus button, **Add asset**, inside the prompt box. It opens an attachment menu above the button, aligned to its left edge. Show **Add conversation**, **Upload file (coming soon)** and **Add link (coming soon)**. Upload file and Add link are disabled, with no file input, URL input or placeholder workflow. Only Add conversation is supported in this feature.

Choosing Add conversation closes the menu and opens an **Add conversation context** modal. A search field at the top filters a visible list of all conversations from both Inbox and Message requests. Start with the full list, ordered by latest archived activity first, with undated conversations last, using the same ordering as the sidebar. Show titles, participants and dates; label the active conversation and already attached conversations and disable their rows. Use stable conversation IDs, never titles, for identity. Identical titles must remain independently selectable, with participant labels and consistent disambiguation.

Use nyx-kit's NyxModal with its inline NyxCommandPalette for search, list selection and keyboard navigation. Keep the context-window select, selected conversation, Cancel and **Add conversation** in the modal footer. Choosing a list row selects it without adding or sending anything; Add conversation confirms that choice and its window.

Offer Last 24h, Last 48h, Last week, Last month, Last 3 months, Last 6 months, Last year, and All time. Default to the configured new-discussion window, falling back to Last week when necessary. There is no selection in the other conversation, so Only selected messages and surrounding-selection controls do not apply. Time windows end at that conversation's latest valid archived message, using the existing inclusive elapsed-time calculation; they never use the prompt clock or the active conversation's latest message. An undated conversation requires All time.

Adding produces a clearly labeled conversation chip above the prompt. Each chip identifies its source conversation, lets the user change its own window, and has a labeled remove button. Multiple attachments are supported, up to ten per prompt. Close the modal after adding, return focus to the prompt, and preserve the question and selected active-conversation messages. Closing or canceling the modal adds nothing and returns focus to the plus button. Explain empty/search-exhausted states and the attachment limit. Use nyx-kit primitives, default colors, Vue and SCSS/BEM; controls must fit the mobile shelf, work by keyboard, and consume Escape without closing the shelf. Escape closes the active menu or modal; a context-window dropdown consumes its own Escape first.

The plus button, modal and chip changes are disabled while preparing or sending and while saved discussions load. At the attachment limit, disable Add conversation in the menu and explain the limit. Enter sends only from the prompt textarea; modal search and selects must never trigger Send. Navigation between conversations or discussions closes the modal and preserves each discussion's own draft attachments.

## Scope and lifetime

Attachments belong to the next explicit prompt, separately from the active conversation's selected-message chips. They may be added to the first question or any follow-up, including a discussion whose primary scope is already fixed. They never alter that fixed scope or silently attach other conversations.

On Send, prepare an exact snapshot of each chosen conversation/window. Attachments contain the archived source records and their stable reference mapping, with full-conversation metadata only for All time. They do not include another Echo discussion, user-authored background notes, media bytes, remote resources, or recursively attached conversations. The existing active-conversation background-note policy remains applicable. Source records can describe unavailable media, but the model must not infer its contents.

After acceptance, clear the submitted chips with the submitted question. Before acceptance, any failure retains the question, message selection and chips. Explicit Retry restores the failed turn's conversation/window choices and prepares current evidence again. Connecting ChatGPT never sends automatically.

Accepted snapshots remain in their original turns and accompany completed discussion history on later questions, including questions without new attachments. Removing an unsent chip does not erase context already shared in prior turns. Imported changes affect a newly attached snapshot on a later explicit Send; they do not mutate or automatically resend historical assets. Show each sent attachment and window beside its question so retained context is visible.

Persist unsent attachment choices with the discussion draft in the local library, using optimistic revision checks. Persist accepted snapshots through the existing immutable analysis payload. Existing drafts and historical turns without assets remain valid. Browser-only discussions keep choices in memory, matching their existing lifetime. Forget archive, Delete library and discussion deletion use their established cleanup boundaries. Never store private attachment choices or source content in localStorage preferences or URLs.

## Request binding and citations

Represent conversation attachments as a typed `conversation` asset list on each analysis turn. Keep each asset's source parts, scope, title, conversation ID, source version and reference map separate from the primary source bundle. Every attachment has its own immutable snapshot ID, used to namespace citations so identical `p1:m1` references from different sources cannot collide.

Provider text labels attached conversation evidence and its chosen window separately. Treat every record and label as untrusted evidence, not instructions. The model must attribute evidence to the right conversation and distinguish it from what the active conversation's participants actually said. No action tools or additional resource access are granted. Subject-generation requests continue to contain only the question.

Render valid attached-message citations as labeled source-conversation controls that open the correct conversation and message. Validate against the actual snapshots available to that answer, including earlier completed turns. Unknown, invented or unavailable citations stay literal. Preserve inert Markdown/HTML and the existing primary citation behavior.

The library resolves attachments through the same owner-scoped conversation authority as normal analysis, not client-supplied source JSON. Bind each complete prepared snapshot, including its identity, window, source records and reference mapping, into request integrity validation. Recompute attached context before acceptance: relevant changes reject dispatch and require another explicit Send; unrelated changes do not. Accepted snapshots stay unchanged through later imports, source changes and restart. Existing request-ID deduplication and uncertain-delivery handling remain intact.

Validate type, IDs, allowed windows, duplicate conversations and snapshot IDs, active-conversation exclusion, and attachment count. Apply the existing 24 MB transfer limit to the entire request, including all historical and current assets. Reject missing sources, unavailable timestamps, incomplete sources and oversized context with useful errors; never silently omit, truncate, summarize, change scope or switch model. The optional development inspector shows exact outgoing asset blocks and includes their source-message count without logging or persisting inspections.

## Sharing and validation

Settings explains that explicitly attached windows from other conversations are sent with the question, that their media and other Echo histories are excluded, and that completed turns retain the snapshots. Opening the picker, adding/removing assets, changing windows, saving drafts, importing, local inspection and connection alone cause zero provider inference requests. Send remains the explicit authorization action.

Use wholly synthetic fixtures and isolated browser/library state. Never inspect a real export, cached archive, saved discussion or credentials with development tools.

Acceptance checks cover:

1. Add, search, independently resize and remove multiple attachments; duplicate/current-conversation exclusion, empty results, ten-asset limit, keyboard focus/Escape, desktop and narrow layouts.
2. Exact independent window boundaries, All time metadata, undated and incomplete sources, active-scope isolation, and no unrelated source records, notes, media bytes or other Echo history.
3. Initial sends, follow-ups, immutable historical assets, retry, accepted-draft clearing, pre-acceptance failure retention, and draft restore/navigation with optimistic conflicts.
4. Namespaced citations, repeated source-local reference names, earlier-turn citations, unknown citations and safe navigation to the correct source message.
5. Owner isolation, tampered source/window/map rejection, relevant changes before dispatch, unrelated-change tolerance, restart, request deduplication, combined transfer limits, and legacy payload/draft compatibility.
6. Zero inference requests before explicit Send, exact inspector content, Settings disclosure, and cleanup without changing source exports.

## Delivery details

Schema version 8 adds `discussions.assets_json`, defaulting existing drafts to an empty choice list. The paired draft and prepare endpoints accept typed asset choices; accepted turn payloads retain independent source snapshots. Legacy turns without assets stay unchanged. A newer draft saved during acceptance is preserved, with fresh IDs for retained submitted choices so the next Send cannot reuse a historical citation namespace.

Both the persistent library and independent browser viewer support attachments. The browser viewer uses opaque conversation identities in snapshots; library preparation resolves owner-scoped server records and checks the complete attachment binding again before acceptance. Citation jumps use stable message mappings, apply once and preserve ordinary subsequent reading-position restoration.

Validation includes the complete unit/service suite, the complete desktop/mobile Playwright suite, lint and the production build. Additional regression checks cover concurrent draft edits and returning to an attached source after a citation jump. All source records, libraries, browser contexts and provider responses used for validation are synthetic; no real export or live-provider request was used.

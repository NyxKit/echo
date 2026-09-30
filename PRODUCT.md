# Meta Chat

## Current delivery: local chat viewer

The first implementation is a bare-bones, read-only chat viewer. This scope takes precedence over the future AI specifications below.

- Included: local folder selection, conversation and participant search, conversation categories, chronological messages with progressive history loading, shelf-based conversation search with highlighted matches, reactions, shared links, and local image/audio/video previews.
- Messages from self appear on the right; other participants appear on the left. Use explicit account metadata when available, otherwise infer self from the unique participant present across multiple conversations. Keep a manual correction in conversation information when identification is ambiguous or needs changing.
- Use profile pictures from explicit local export references, with initials for missing, unassociated, or unreadable pictures. Never guess picture ownership from arbitrary filenames or fetch remote profile images.
- A reusable side shelf starts with a conversation summary outside the accordion, followed by three collapsible sections: participants; history containing conversation search, extended messages, and a Load all button; and shared media/files/links from the full conversation. Default to Photos & videos, combining these media types while keeping GIFs separate. A three-dot menu beside the asset heading selects exactly one category at a time: Photos & videos, GIFs, Audio, Files, or Links; do not mix categories or use type tabs. Show visual assets in a three-column grid. Each tile opens its lightbox and has a separate bottom-right message-jump icon with a View message tooltip. All message-jump controls, including search results and nonvisual assets, use compact icons with accessible labels and tooltips. Every media item links back to its original message. The shelf sits beside the timeline on wide screens and opens as a keyboard-accessible overlay on smaller screens. Its open/closed state belongs to the shared viewer store and persists across conversation switches and reloads using localStorage; the contents update to the active conversation. It will host future AI surfaces without implementing them now.
- Render exported GIFs inline. Recognized Giphy/Tenor GIF links load automatically from an explicit media-host allowlist, without credentials or referrers. Reject redirects, unsupported content types, malformed GIF structure, excessive dimensions, and downloads over 15 MiB; render validated bytes through local blob URLs. Provider/CORS failures show an unavailable state. Arbitrary links are never fetched automatically.
- Show link cards in the timeline and the shelf’s Links category, including HTTP(S) URLs in message text. Use explicitly associated exported titles, descriptions, and local thumbnails when available. Load remote crawler metadata only after an explicit Load preview action, using direct HTTPS requests where CORS permits; never use a backend or third-party proxy. Reject credentials in URLs, local destinations, redirects, unsupported content, and oversized responses. Parse metadata as inert text and display validated raster images through blob URLs. Preserve a usable link when metadata or images are blocked. Cache requested previews in memory for the current archive, clearing them when the archive changes or is forgotten; refresh requires another explicit request.
- Clicking a photo, GIF, or video opens a nyx-kit lightbox with previous/next controls, keyboard arrow navigation, Escape to close, and focus returned to the originating preview. From the chat, navigate all available visual assets across the full conversation in chronological order. From the shelf, respect the selected asset category and displayed order, including assets beyond the currently displayed batch. Skip missing local files; unavailable remote assets retain a failure state and allow continued navigation. Videos play in the lightbox; audio keeps inline playback.
- Keep the shelf summary permanently visible above the accordion, with participants separated from it. Wrap participants, history, and shared-assets sections in a nyx-kit accordion with independent expansion. Start all three expanded. Collapsing a section preserves its controls and state; use the kit’s keyboard navigation and focus management. Within history, order search first, extended messages second, and load-all controls last.
- Hide recognized automatic attachment notices and standalone like/reaction activity by default (extended messages). Preserve attachments, links, and reactions on ordinary messages. A keyboard-accessible Extended messages switch in the history section reveals these texts; the preference is shared across conversations for the session. Apply it to timeline pagination, search, and sidebar previews, keeping asset-to-message links stable. Match whole known notices conservatively so ordinary prose remains visible.
- Display plain hearts using emoji presentation in message text, reactions, search previews, and conversation previews, without changing source files.
- Show no asset-type badges or download buttons in the chat or shelf. Unsupported files show an unavailable preview state; suppress native media download controls where supported.
- Provide a home-screen Request a new export link to https://accountscenter.facebook.com/info_and_permissions/dyi, opening a new tab. The link is available in the mobile home layout too.
- Retain an internal self-identity confidence score. The unique participant common to all chats is the candidate; distinct participant groups strengthen confidence, while duplicate groups do not. This is a conservative heuristic, not a statistically calibrated probability: two distinct groups score 90%, three score 95%, and four score 97.5%, approaching a cap below certainty. Unambiguous explicit owner metadata scores 100%; missing or conflicting evidence scores zero. Show partner identity-correction buttons and the self checkmark at or below the configured threshold, and hide both above it. Configure SELF_CONFIDENCE_THRESHOLD in src/config.ts; the default is 0.95 (95%). Keep the score out of the UI and recompute it when restoring an archive.
- The sidebar defaults to Inbox. A three-dot menu aligned to the far right of the Conversations heading switches between Inbox and Message requests only, with a checked selection and keyboard navigation. The heading count reflects the selected folder. Opening a conversation through navigation or a restored URL selects its folder. Non-request threads without a recognized folder appear in Inbox.
- Use Vue, TypeScript, SCSS/BEM, and nyx-kit primitives with its default dark/light palettes.
- No AI implementation, OpenAI connection, AI discussion storage, message-selection workflow, backend, server database, or network upload.
- Import the selected folder in the browser and automatically cache its readable paths and file bytes in IndexedDB, including JSON and local media. Restore the cache on startup through the same importer, preserving directory-relative media references. No server or upload is involved. This browser database is an explicit exception to the original no-database scope.
- Report saving and saved status in the chat footer, replacing the linked-GIF notice; do not show this status in the sidebar. Also show status on the desktop welcome screen before a conversation is selected. Replace the saved archive atomically after a valid import; failed or canceled writes must leave the previous snapshot intact. If saving fails, allow browsing in memory and explain that a previous snapshot may reopen after refresh. If restoration fails, offer folder selection and Forget archive.
- Forget archive aborts pending import/save/restore work and removes all cached files and metadata, then closes the archive. It never modifies source files. Report deletion failures and keep a retry available; do not claim removal succeeded until the storage transaction completes.
- The cache belongs to the current browser profile and site origin. Clearing site data, private browsing, storage limits, or browser eviction may remove it. Keep the original export as the source of truth. Reading positions and manual identity corrections remain session-only. Shelf visibility and appearance persist as local preferences.
- Selecting a conversation updates its URL using a stable opaque identifier in the fragment, without names or export paths. Refresh restores the selected conversation after the saved archive loads. Browser Back/Forward navigates conversations; bookmarks for unavailable conversations return to the list. URLs identify a local conversation and do not share its data.
- Reading positions are retained when switching between conversations during the current session. Initially render the latest message batch, prepend earlier messages when scrolling near the top, and preserve the visible message anchor. Load all in the shelf expands the remaining history. Do not show Older/Newer navigation buttons. Media loads as it approaches the viewport.
- Disable remote font imports, telemetry, and automatic remote fetching except for validated GIF downloads described above. Prevent the development server from serving `data/` and keep it out of production builds.
- Verify parsing, split histories, unsafe paths, malformed input, and media handling with synthetic unit fixtures. Verify import, search, navigation, appearance, and responsive layouts with synthetic browser fixtures.

The passage-selection, AI, authentication, and discussion-persistence sections below describe future work and do not block release of this viewer. Do not expose placeholder AI controls in the current interface.

## Purpose

A private, local workspace for browsing an Instagram export and discussing selected passages with ChatGPT. Reading messages and revisiting shared media should feel calm, fast, and familiar. AI discussions stay attached to the Instagram conversation they concern.

This is an MVP specification, not a statement that the application or authentication integration already exists. Connection feasibility remains an explicit implementation gate.

## Product principles

- Local by default: browsing requires neither an Instagram login nor a remote service.
- Preserve the source: treat the export as immutable input.
- Clear context: distinguish original messages, the selected passage, and AI responses.
- Deliberate sharing: explain what leaves the device before an AI request.
- Consistent design: use nyx-kit primitives and default colors throughout.

## Technology and architecture

- Vue 3, with SCSS using BEM naming for application styles. TypeScript and Vite are the proposed implementation defaults.
- Use nyx-kit from the library maintained at `~/Projects/nyxkit/nyx-kit`. Adopt its applicable components, composables, utilities, icons, and tokens in addition to basic controls. Verify available exports against the implementation; README roadmap entries do not establish availability.
- Import the library stylesheet and preserve its default palette and semantic colors. Build custom conversation layouts from library primitives. Use native media elements where the library has no suitable implementation.
- Keep parsing, normalized conversation state, presentation, AI transport, and persistence separate.
- Use only browser-local IndexedDB for the archive cache; no server database, cloud storage, or application backend by default. The frontend development server is tooling, not a reason to add server-side product logic.
- Add a minimal local backend only if the chosen supported OpenAI integration needs it for authentication, credential storage, token refresh, or request mediation. This exception does not imply a database or hosted service.

## Data source and loading

The source is an Instagram export ZIP that the user has already extracted into `data/`. ZIP extraction, live Instagram access, and account synchronization are outside the MVP.

The browser cannot silently read an arbitrary filesystem directory. The backend-free baseline therefore lets the user select the extracted folder through browser-supported directory access. The application reads files locally without uploading them. Explain how to select `data/`, request access only when needed, and offer a folder-input fallback where supported. Reauthorization of folder access is distinct from OpenAI authentication.

- Discover supported conversation JSON and referenced local attachments at runtime.
- Combine all JSON parts belonging to one conversation, retain source fields for AI context, and normalize records for display without modifying files.
- Establish deterministic chronological ordering and stable internal references for messages, selections, and discussions. Do not use display names alone as identity.
- Handle Unicode, emoji, group conversations, reactions, system events, absent optional fields, and missing attachments gracefully.
- Unsupported export formats produce an actionable explanation. Invalid records must not crash unrelated conversations; make incomplete loading visible.
- Keep file access scoped to the selected export. Reject traversal and references outside that scope. Remote fetching is limited to the approved GIF flow in the current delivery scope.
- Never import the export into application source or copy it into a public assets directory. No private data may enter a distributable build.

The specification contains no private names, exact export paths, filenames, or file contents. The only authorized structural observation is the obfuscated layout below. The privacy rules in `AGENTS.md` apply to all development artifacts.

### Obfuscated folder structure

The following is a collapsed structural view from a directory-only inspection. Every label beneath `data/` is a semantic placeholder, not a literal path or filename. Repeated branches are merged; their order and multiplicity are intentionally omitted. A branch shows an observed kind of location, not a requirement that every conversation contain it. File categories were inferred from extensions only; file contents were not opened.

```text
data/
└── <messaging-section>/
    ├── <section-json-file>
    ├── <section-image-assets>/
    │   └── <image-file>
    ├── <inbox-category>/
    │   └── <conversation>/
    │       ├── <conversation-json-file>
    │       ├── <audio-assets>/
    │       │   └── <media-file>
    │       ├── <image-assets>/
    │       │   └── <image-or-other-file>
    │       └── <video-assets>/
    │           └── <video-file>
    └── <requests-category>/
        └── <conversation>/
            └── <conversation-json-file>
```

Importer requirements informed by this layout:

- Discover conversation containers across supported messaging categories, including requests, rather than assuming every conversation belongs to the inbox.
- Support a messaging section directly under the selected source root. Do not require an extra export-wrapper or activity directory; tolerate those wrappers when present in other exports.
- Distinguish section-level JSON from conversation JSON through schema validation during import. Directory inspection alone does not establish the meaning of either file type.
- Support section-level and conversation-level media locations. Resolve references within the selected source root rather than assuming every asset is beside its conversation JSON.
- Treat asset-directory names as organizational hints, not reliable media types. Determine safe rendering from validated file type and browser support; show an unsupported-file state when appropriate.
- Preserve support for multiple JSON parts per conversation as a general importer requirement. This directory-only inspection does not establish message schemas, attachment associations, or whether any conversation is split across files.

## Main experience

### Navigation and visual direction

Use a conversation sidebar, a central message timeline, and an optional AI discussion panel. At narrow widths, show one primary pane at a time with clear back navigation and retained position.

Take inspiration from Instagram web's recognizable conversation navigation and message hierarchy, while giving Meta Chat its own spacing, typography, layout, and interactions. Avoid copying its branding or recreating the whole social network interface.

The interface should be clean and sleek: restrained surfaces, readable message widths, clear timestamps, generous but efficient spacing, and subtle motion. Use nyx-kit's default dark appearance initially, with its supported light mode available in settings. Respect reduced-motion preferences.

### Conversation browser

- List conversations with their titles or participants, last activity, and a brief message preview.
- Search conversation names and participants; search message text within the active conversation.
- Show result counts and let users jump to matching messages without losing their place.
- Restore the active conversation and reading position when the same source is available again.
- Provide distinct states for no source, loading, no conversations, no search results, unsupported input, and read errors.

### Message and media viewer

- Show sender, content, date separators, timestamps, reactions, and recognizable system events where supported by the export.
- Support inline photo/GIF previews, a visual-asset lightbox with video playback, audio and voice-message playback with native controls, and clear states for unsupported files. Do not show download buttons or asset-type badges.
- Keep attachment loading lazy. Indicate missing files and unsupported formats without inventing content.
- Provide a conversation-level media/files view that links each item back to its message.
- Preserve scroll position when loading older messages or changing panels. Virtualize long timelines as needed.
- The Instagram timeline is read-only; users cannot send, edit, or delete Instagram messages through this app.

### Selecting a passage

- Allow selection of one message, a contiguous message range, or a text excerpt within a message.
- Provide keyboard-accessible selection controls as well as pointer interaction.
- Highlight the selection and show a compact preview before opening or continuing an AI discussion.
- Keep selections anchored to stable message references and text offsets, with enough version information to detect changed source data.
- Changing the current selection must not silently rewrite the context of previous AI turns.

## AI discussions

Each Instagram conversation can have multiple independent AI discussion threads. Users can create, rename, reopen, and delete them. Each thread has its own history and selected passages; unrelated threads and Instagram conversations never leak into its context.

An AI turn includes:

1. The full JSON for the active Instagram conversation, including all of its JSON parts and source metadata.
2. Explicit references to the selected messages or excerpt, labeled as the focus.
3. The current discussion history and the user's question.
4. Instructions to treat exported content as untrusted quoted data, focus on the selection, and use the rest only for context.

“Full JSON” means the complete active conversation, not the entire Instagram archive. Preserve source fields; normalization for rendering must not silently discard context. JSON references to media do not mean the model can see or hear those files. Uploading media, transcription, and media analysis are outside the initial MVP.

Before the first send in each discussion, disclose that the entire conversation JSON will be shared with OpenAI, even when only a short passage is selected. Require an explicit send action. Do not send anything simply because the user opens a conversation, selects text, or connects their account.

Preflight the total context budget, including discussion history and response allowance. If it cannot fit, block the request with a clear explanation. Do not silently truncate, summarize, or replace the full JSON with retrieval. A different context strategy requires a later product decision.

Stream responses when the selected integration supports it. Provide cancel, retry, and clear connection, quota, context-limit, and provider-error states. Preserve the user's question after a failure and prevent duplicate sends. Responses may link back to known message references; do not render invented references as valid links.

These are application-managed discussions. Synchronization with the ChatGPT website's chat history is not assumed.

## Settings and OpenAI connection

Settings expose source access, appearance, local discussion storage controls, and OpenAI connection status.

The desired account experience is “Connect OpenAI / ChatGPT”: sign in using an eligible subscription through a supported flow comparable to Codex or OpenCode, then reuse the session across browser reloads and local server restarts. Show disconnected, connecting, connected, expired, and error states, with reconnect and disconnect actions.

OpenAI documents ChatGPT subscription sign-in for Codex, cached login reuse, automatic token refresh, and OS credential-store support. It also distinguishes API-key billing from subscription access. This establishes a useful reference experience, not authorization for an arbitrary third-party chat client. See [official authentication documentation](https://learn.chatgpt.com/docs/auth).

Before implementing the connection, establish:

- Whether a documented, permitted integration supports subscription-backed conversational requests for this product.
- Which runtime or official client integration it requires, what models and limits apply, and whether a local backend is necessary.
- How persistent credentials, refresh, expiration, revocation, and disconnect work on supported operating systems.
- What provider data handling applies and how to communicate it accurately.

Do not copy another application's credentials, impersonate its OAuth client, reuse undocumented private endpoints, or assume adding a backend makes subscription access supported. An API key is a separately billed alternative and requires a product decision; do not silently substitute it for the requested subscription connection.

If subscription integration is unavailable, the local browser remains usable and AI is clearly marked unavailable. The complete AI MVP remains blocked until a supported connection is chosen.

Connection options, official-source findings, and the remaining feasibility gates are recorded in [the OpenAI / ChatGPT connection exploration](docs/specs/chatgpt-connection.md). This research does not change the current viewer-only implementation scope.

## Security and privacy requirements

The security objective is to prevent unauthorized access to authentication and private conversations. Absolute “100% secure” or “nobody can steal it” guarantees are not technically defensible; security must be established through explicit controls and verification.

- Long-lived provider credentials must stay outside browser JavaScript, browser storage, frontend bundles, URLs, logs, and the repository.
- If persistent credentials require a local service, use the operating system credential store. Fail clearly when secure storage is unavailable; never silently fall back to plaintext credentials.
- Refresh credentials without routine login prompts where supported. Reauthentication remains legitimate after revocation, expiration that cannot be refreshed, or provider policy changes.
- Disconnect clears this application's stored credentials and session state; revoke provider grants where supported and explain any remaining provider-side action.
- Any local backend binds to loopback, checks allowed host and origin values, authenticates local requests, and defends against CSRF and DNS rebinding. Loopback access alone is not authentication. Apply state and PKCE validation when required by the supported OAuth flow.
- Use HTTPS for provider traffic. Do not add a hosted proxy, telemetry, analytics, or remote error reporting to the MVP.
- Render source messages and model output as untrusted content. Sanitize rich text, restrict URL schemes, and prevent script execution through previews or attachments.
- Give the AI no filesystem, shell, browsing, or other action tools for conversation analysis. Conversation text cannot authorize tool use or access to other records.
- Never log payloads, private filenames, conversation text, or credentials. Validate with synthetic fixtures.
- Local machine compromise, malicious browser extensions, and provider-side handling remain boundaries the application cannot fully control.

## Local persistence without a database

Keep source files authoritative and unchanged. Store small non-sensitive settings in browser storage. Maintain AI discussions in memory and provide explicit save/load of a versioned local session file so users can retain multiple discussions without a database. Session files contain private material and must stay outside tracked project files; warn before overwriting a session file.

Automatic session-file saving may use browser file access after permission is granted, with a manual download/load fallback. Clearly distinguish saved and unsaved changes. Clearing local discussions must never delete the source export. Bind restored discussions to their source version and flag unavailable or changed message anchors.

Persisted OpenAI authentication is a separate requirement handled by the secure connection runtime; browser preferences or session files must never contain provider credentials.

## MVP boundaries

Included: one active extracted export, conversation navigation and search, messages and local attachments, passage selection, multiple saved AI discussions per conversation, settings, and a supported persistent OpenAI connection once feasibility is established.

Excluded: live Instagram integration, message sending, social feeds, ZIP extraction, cloud accounts, multi-user hosting, cross-device sync, server databases, automatic analysis, embeddings, transcription, and custom color palettes.

## Future full-product acceptance criteria

- A user can select an extracted export, browse supported conversations, search, and view or play available attachments without sending data off-device.
- Missing media, malformed input, and unsupported formats show useful states without breaking unrelated content.
- Long conversations remain responsive and preserve reading position across navigation.
- A selected excerpt or message range appears clearly in the AI composer; the full-conversation disclosure is visible before sending.
- Requests contain all active-conversation JSON parts plus the selected focus and the correct discussion history, or are blocked before sending when they exceed context capacity.
- At least two independent AI discussions can be created for one Instagram conversation, saved, reloaded, and resumed without mixing history.
- A valid supported OpenAI connection survives browser reload and local service restart without routine reauthentication. Revocation and disconnect behave correctly.
- Security verification covers credential non-exposure, persistent secure storage, untrusted content rendering, and local service request protection where applicable.
- Navigation, selection, dialogs, and media controls work with a keyboard; focus, labels, contrast, and reduced motion are verified.
- All applicable controls use nyx-kit, application styles follow BEM, and library default colors remain intact.
- Repository files, tests, documentation, logs, and distributable builds contain no export-derived private material. All reproducible checks use synthetic data.

# Meta Chat

A local, read-only viewer for an extracted Instagram JSON export. Built with Vue, TypeScript, SCSS/BEM, and nyx-kit. Uses browser-local IndexedDB storage; no backend, server database, or AI features.

## Run

Requires Node.js 20.19+ (or a supported newer LTS) and pnpm 10. The nyx-kit dependency uses the local checkout at `../../nyxkit/nyx-kit`, which must have its `dist/` build available. From that checkout, run `pnpm install` and `pnpm build` if needed.

```sh
pnpm install
pnpm dev
```

Open the local address printed by Vite. Select **Open export folder** and choose the extracted JSON export in `data/`. The folder picker reads files locally; it does not upload them. The sidebar opens to **Inbox**; use the three-dot menu beside **Conversations** to switch to **Message requests**. Select a conversation to browse messages, play media, or search its history. Scroll upward to load earlier messages automatically. Open **Conversation information** to search messages, **Load all** history, or browse participants and shared assets; **View message** jumps back to the source. The shelf keeps the conversation summary at the top, followed by independently collapsible **Participants**, **History**, and **Shared assets** sections, initially expanded. History places search before the extended-messages toggle. Shared assets defaults to **Photos & videos** in a three-column grid. Its three-dot menu selects one category: Photos & videos, GIFs, Audio, Files, or Links. Each visual tile opens the lightbox; its bottom-right arrow icon jumps to the original message. Hover or focus any message-jump icon for a **View message** tooltip.

The viewer infers your account from shared participants across conversations. **This is me** remains available for uncertain matches and disappears when internal confidence exceeds 95%.

Automatic attachment notices and like/reaction activity are hidden by default. Enable **Extended messages** in conversation information to show them. Attachments and ordinary reaction badges remain visible; search and sidebar previews follow this session-wide preference. Hearts display as ❤️.

Click a photo, GIF, or video to open the lightbox. Previous/next buttons and arrow keys navigate all visual assets when opened from the chat, or only the selected shelf category when opened there. Escape closes the lightbox and returns focus to the preview. Videos play inside the lightbox; audio plays inline.

Need a fresh archive? **Request a new export** on the home screen opens Meta’s export page in a new tab. Request JSON and extract the ZIP before choosing its folder.

Your messages appear on the right. The viewer identifies you from account metadata or the unique participant present across multiple chats. If that is ambiguous or incorrect, choose **This is me** beside your name in conversation information. This choice applies across the current archive and stays in memory. Profile pictures use explicit local export references, falling back to initials when unavailable.

Use an up-to-date desktop browser with folder-input support. Mobile layouts are supported, but folder selection depends on the mobile browser and operating system. JSON exports are supported; ZIP archives and HTML-only exports are not.

The selected archive and its local media are saved automatically in this browser. Wait for **Saved in this browser** in the chat footer (or desktop welcome screen) before refreshing; the archive will restore without another folder selection. **Forget archive** removes the cached copy and closes it, leaving the original files untouched. Conversation selection updates the URL, so refresh restores the same chat and browser Back/Forward works. URLs use opaque IDs and do not share archive data. Shelf visibility and appearance persist in localStorage; reading positions and manual identity corrections last for the current session.

If browser storage is unavailable or full, you can still browse the selected folder for the session. A failed replacement keeps the previous saved archive intact and explains that it may reopen after refresh. The cache is specific to the browser profile and site address (including the port); clearing site data, private browsing, or browser eviction can remove it. Keep your original export. Missing or unsupported attachments remain visible as unavailable items.

## Verify and build

```sh
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
pnpm preview
```

Tests generate synthetic exports in temporary directories. Browser screenshots contain only synthetic data and are ignored by Git. Never point automated browser capture at a private export.

## Privacy

Original exports are read-only, ignored by Git, excluded from builds, and blocked by the development server. The app’s browser-local cache contains private export material too; use Forget archive to remove it. The app uses local blob URLs for attachments and removes remote font imports from the nyx-kit stylesheet. No telemetry or upload service is included.

Linked GIFs from approved Giphy/Tenor media hosts load automatically as they approach the viewport. Those hosts receive a download request, but no conversation payload, credentials, or referrer. The viewer rejects redirects, verifies GIF content type and structure, and limits download size, dimensions, and frame count before displaying the bytes. If a host disallows browser access or verification fails, the GIF shows as unavailable. Other external links open only when clicked; remote profile pictures are not loaded.

See `AGENTS.md` for mandatory handling rules and `PRODUCT.md` for current scope and future specifications.

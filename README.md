# Echo

A closer look at your conversations.

A local, read-only conversation library with incremental Instagram JSON imports and optional, user-initiated ChatGPT analysis. Built with Vue, TypeScript, SCSS/BEM, and nyx-kit. The installed/server edition keeps its library in SQLite and managed media files; the independent Vite viewer retains browser-local archive storage.

## Run the local library

Use Node.js 22.13+ on the 22 or 24 LTS line and pnpm 10. Linux needs util-linux flock and xdg-open; ChatGPT additionally needs Secret Service and secret-tool. The optional Linux tray build needs a C compiler and GLib/GIO development files. Windows uses the compiled native helper for locking, private file permissions, browser opening, tray controls, and Credential Manager; its real-platform release validation is still outstanding.

```sh
pnpm install
pnpm build
pnpm desktop:build-native
pnpm server:start
pnpm server:status
pnpm server:quit
```

Start waits for authenticated readiness, pairs the default browser through a private one-use local file, and opens `http://127.0.0.1:47831`. Repeated launches reuse the server. Closing the terminal or browser keeps accepted imports and analysis running. Use the tray or **Settings → Quit Echo** to stop Echo. Without a usable tray, the browser and CLI controls remain available.

`pnpm server:start --background` starts without opening a browser. **Start at login** is an explicit tray opt-in and opens no tab. `pnpm server:start --port 47832` deliberately changes the remembered origin after shutdown; port conflicts never stop or open an unrelated service.

Open the sidebar **Settings** cog, then choose **Import export** for a JSON export ZIP or extracted folder. Import is also available on the empty welcome screen. Settings contains appearance, ChatGPT connection and defaults, Delete library and Quit Echo with explanations. Import and Settings have their own routes and support browser Back/Forward. Input transfers only to the local loopback server. Valid imports preserve older history, stable message IDs, source observations and managed media; uncertain owner or history matches require inline review. Identical imports report no history changes. Source exports remain read-only and may move after import. Imported HTML is never rendered.

Discussions and drafts save automatically to the local database, with visible errors when saving fails. Accepted answers continue after tab closure and remain attached to immutable source context. Restart retains partial responses without resending them. Discussion-file Save/Load controls and import/export endpoints are no longer offered; existing database history is retained. Context defaults to Last week, or Surrounding week when messages are attached. Choose 24h, 48h, week, month, year, All time, or Only selected messages before the first response. Last windows end at the latest archived timestamp; Surrounding windows extend equally before and after each selection. Default context and model live in Settings. Full-conversation analysis can cover multiple imports and conflicting observations. Actual sending and provider connection remain explicit application actions.

**Delete library** removes Echo's managed history, media, discussions, drafts, preferences and staged imports after a destructive confirmation. Incomplete cleanup remains retryable. It leaves source exports and the separate provider connection untouched. There is no library backup/restore feature: a new full Instagram export can rebuild only the history it contains.

Linux stores lifecycle state in `$XDG_STATE_HOME/echo` (otherwise `~/.local/state/echo`) and the library in `$XDG_DATA_HOME/echo` (otherwise `~/.local/share/echo`). Windows uses `%LOCALAPPDATA%/Echo/state` and `%LOCALAPPDATA%/Echo/library`. These locations, browser sessions and OS credentials are sensitive; never inspect real contents through development tools or commit them. Sessions expire after twelve hours or server restart; reopen through the launcher to reconnect.

See the [library specification](docs/specs/conversation-library-and-incremental-imports.md), [import decisions](docs/specs/library-import-engine.md), [discussion and job decisions](docs/specs/library-discussions-and-jobs.md), and [desktop delivery decisions](docs/specs/desktop-delivery.md). The [release acceptance record](docs/specs/library-release-acceptance.md) distinguishes implementation and synthetic checks from platform and live-provider gates.

## Build desktop packages

`pnpm desktop:package` bundles Node 24.21.0, production dependencies, the built UI and native helper. Linux produces a tar.gz with `install.sh`; Windows produces a per-user NSIS installer and requires MinGW-w64 and NSIS on the build machine. The Linux installer supports `--prefix /absolute/prefix` for isolated installation checks. Packages keep library content outside the installation directory. Login startup defaults off.

On Linux, run `~/.local/opt/echo/uninstall.sh` to remove the installed application and its matching desktop/login entries. For a custom prefix, use `<prefix>/opt/echo/uninstall.sh`, or run `./install.sh --uninstall --prefix /absolute/prefix` from the extracted package. Uninstall stops Echo and retains the library and separate provider connection. If an interrupted update or uninstall removed the installed runtime, rerun `install.sh` from an intact extracted package to repair it, or use that package’s `./install.sh --uninstall --prefix /absolute/prefix` to finish removal. Use Delete library in Echo first if you also want to remove managed history.

The Linux candidate passes unprivileged package/runtime checks on Ubuntu 22.04 (glibc 2.35) and 24.04 (glibc 2.39); Ubuntu 22.04 is the minimum tested userspace baseline. Actual desktop-shell, login-session and keyring integration still require release validation. Other distributions are not established by these checks.

Artifacts are local release candidates, not published or signed releases. macOS packaging is deferred because Keychain, login items, signing/notarization and a macOS test host add another unvalidated release path. Modern browser engines remain supported independently.

## Run in development

Use a supported Node.js LTS release (22.13+ or 24) and pnpm 10. The nyx-kit dependency must have its `dist/` build available when using the local checkout at `../../nyxkit/nyx-kit`; build that checkout first if needed.

```sh
pnpm install
pnpm dev
```

This development command runs the independent browser-cache edition. Use the local server above to exercise the persistent library. Open the local address printed by Vite. Select **Open export folder** and choose your extracted JSON export folder from anywhere on your device. The folder picker reads files locally; it does not upload them. The sidebar opens to **Inbox**; use the three-dot menu beside **Conversations** to switch to **Message requests**. Select a conversation to browse messages, play media, or search its history. Scroll upward to load earlier messages automatically. Open **Conversation information** to search messages, **Load all** history, or browse participants and shared assets; **View message** jumps back to the source. The shelf keeps the conversation summary at the top, followed by independently collapsible **Participants**, **History**, and **Shared assets** sections, initially expanded. History places search before the extended-messages toggle. Shared assets defaults to **Photos & videos** in a three-column grid. Its three-dot menu selects one category: Photos & videos, GIFs, Audio, Files, or Links. Each visual tile opens the lightbox; its bottom-right arrow icon jumps to the original message. Hover or focus any message-jump icon for a **View message** tooltip.

The viewer infers your account from shared participants across conversations. **This is me** remains available for uncertain matches and disappears when internal confidence exceeds 95%.

Automatic attachment notices and like/reaction activity are hidden by default. Enable **Extended messages** in conversation information to show them. Attachments and ordinary reaction badges remain visible; search and sidebar previews follow this session-wide preference. Hearts display as ❤️.

Click a photo, GIF, or video to open the lightbox. Previous/next buttons and arrow keys navigate all visual assets when opened from the chat, or only the selected shelf category when opened there. Escape closes the lightbox and returns focus to the preview. Videos play inside the lightbox; audio plays inline.

Need a fresh archive? **Request a new export** on the home screen opens Meta’s export page in a new tab. Request JSON and extract the ZIP before choosing its folder.

Your messages appear on the right. The viewer identifies you from account metadata or the unique participant present across multiple chats. If that is ambiguous or incorrect, choose **This is me** beside your name in conversation information. This choice applies across the current archive and stays in memory. Profile pictures use explicit local export references, falling back to initials when unavailable.

Use an up-to-date desktop browser with folder-input support. Mobile layouts are supported, but folder selection depends on the mobile browser and operating system. The independent Vite viewer accepts extracted JSON folders. Direct ZIP imports belong to the local-library edition; HTML-only exports are unsupported in both.

The selected archive and its local media are saved automatically in this browser. Wait for **Saved in this browser** in the chat footer (or desktop welcome screen) before refreshing; the archive will restore without another folder selection. **Forget archive** removes the cached copy and closes it, leaving the original files untouched. Conversation selection updates the URL, so refresh restores the same chat and browser Back/Forward works. URLs use opaque IDs and do not share archive data. Shelf visibility and appearance persist in localStorage; reading positions and manual identity corrections last for the current session.

If browser storage is unavailable or full, you can still browse the selected folder for the session. A failed replacement keeps the previous saved archive intact and explains that it may reopen after refresh. The cache is specific to the browser profile and site address (including the port); clearing site data, private browsing, or browser eviction can remove it. Keep your original export. Missing or unsupported attachments remain visible as unavailable items.

## Verify and build

```sh
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
pnpm test:library-browser
pnpm desktop:build-native
pnpm test:tray
pnpm test:desktop
node scripts/check-secret-service.mjs
pnpm test:import-capacity
pnpm desktop:package
node scripts/check-linux-package.mjs
node scripts/check-linux-container.mjs
pnpm preview
```

Tests generate synthetic exports in temporary directories. Browser screenshots contain only synthetic data and are ignored by Git. Never point automated browser capture at a private export.

For Firefox Stable on Linux, `ECHO_GECKODRIVER=/path/to/geckodriver node scripts/check-firefox-stable.mjs` uses installed Firefox, bubblewrap and a disposable profile. It tests the library with generated input in an isolated filesystem/network namespace. Native folder selection remains a manual check when the driver rejects directory uploads. See the [acceptance record](docs/specs/library-release-acceptance.md) for browser versions, prerequisites and remaining platform checks.

## Privacy

Original exports are read-only, ignored by Git, excluded from builds, and blocked by the development server. Both the managed library and the independent viewer’s browser cache contain private export material. Use Delete library or Forget archive for the edition in use. The app uses local blob URLs for attachments and removes remote font imports from the nyx-kit stylesheet. No telemetry or upload service is included.

Linked GIFs from approved Giphy/Tenor media hosts load automatically as they approach the viewport. Those hosts receive a download request, but no conversation payload, credentials, or referrer. The viewer rejects redirects, verifies GIF content type and structure, and limits download size, dimensions, and frame count before displaying the bytes. If a host disallows browser access or verification fails, the GIF shows as unavailable. Link cards appear in the chat and the shelf’s Links category. Explicitly associated exported thumbnails and metadata display locally. **Load preview** contacts the linked HTTPS website and, when provided, its crawler-image host without cookies or referrers. No conversation payload is sent and no third-party preview service is used. Many sites block browser requests through CORS, so previews are best effort: the original link always remains available. Remote previews are cached in memory for the current archive, cleared on archive replacement or Forget archive, and require another click after refresh. Remote profile pictures are not loaded.

See `AGENTS.md` for mandatory handling rules and `PRODUCT.md` for current scope and future specifications.

# Local browser access to the library

Engineering decision, 2026-10-07. Builds on the [server foundation](local-server-foundation.md) and [storage core](library-storage-foundation.md).

## Authorization

Opening Echo through its launcher is an OS-account action. After signed readiness, the launcher requests a signed `launch` control operation. The server writes a generated, owner-only HTML file in its private lifecycle directory. The file contains a random, one-use code with a 60-second lifetime and automatically submits a form to the exact loopback session endpoint. The launcher opens this file in the default browser. The server consumes the code, removes the file, sets an HttpOnly, host-only, SameSite=Strict cookie, and redirects to `/`. Neither the one-use code nor the reusable session token appears in a browser URL. The form has a restrictive CSP and no remote resources.

The code is available only through the OS-owned file, not a public HTTP bootstrap endpoint. Limit outstanding launch files to eight and live sessions to sixteen; a new OS-authorized launch evicts the oldest session when necessary. Keep session hashes in memory for up to twelve hours; restart invalidates them. Additional tabs in the paired browser reuse its cookie. A deliberate new launch pairs another browser session without requiring a separate Echo password or a ChatGPT account. A background launch does not create a browser session.

Remove unused launch files on expiration, clean startup, and shutdown. Report cleanup failures rather than pretending they succeeded. Expired or replayed codes cannot create a session. Validate Host, loopback peer, exact request path, method, content type, body size, and the form's Origin/Fetch Metadata. A file form has an opaque origin; it is accepted only with a valid one-use code. No CORS allow-origin response is added. Cookie behavior follows [Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

This is a desktop local-access mechanism, not hosted authentication. Provider OAuth, provider credentials, and its existing consent flow remain separate.

## HTTP interface

Expose explicit `/api/library/v1/` routes for status, paginated conversations/messages, exact source parts, reading positions, authorized asset bytes, session disconnect, and Quit Echo. The server chooses the library owner. Reject caller-supplied ownership, unknown/duplicate query parameters, malformed IDs, oversized bodies, and unsupported operations. Do not expose the internal owner-resolution, raw import, SQL, arbitrary filesystem, or worker-dispatch methods.

JSON requests require the session cookie and `X-Echo-Request: 1`. Mutations additionally require the exact Origin and bounded JSON input or an explicitly bodyless request. Media requests use the same session and exact-origin checks, with same-origin Fetch Metadata for native media elements. Use `no-store`, `nosniff`, a restrictive CSP, and no referrer on private responses. Unknown file formats are refused for inline display; do not serve HTML/SVG or arbitrary attachments as active content. Read media in bounded chunks, respect backpressure and disconnect, and implement single byte-range requests and HEAD. Follow [HTTP range semantics](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests).

The browser client calls a typed set of routes, never persists session tokens, and does not retry mutations automatically. A non-secret runtime marker in server-rendered HTML enables the connection control only in the local-server edition. Vite/static builds retain their current behavior without probing a nonexistent library backend.

## UI and scope

The sidebar cog opens the dedicated `#/settings` page. The sidebar has no footer. Settings uses `NyxActionItem` rows to explain appearance, importing, library deletion and quitting. Keep connecting, connected, needs-launch, unavailable and stopping states with a retry action where appropriate. Provide a protected Quit Echo action as the tray fallback. Report shutdown requested rather than claiming cleanup has completed before the process exits.

Import lives at `#/import`. Selecting a conversation replaces that page; Back/Forward and refresh restore the route. Completion refreshes the sidebar while retaining the import result. Leaving during an incomplete transfer aborts and cancels that transfer; accepted server jobs continue. Both pages provide Back to conversations on narrow screens. Sidebar summaries are sorted by their full activity timestamp after all API pages load, independent of ID-based API pagination. Years are shown for older activity.

The inline search field is replaced by Search at the bottom of the conversation folder menu. It opens NyxCommandPalette from nyx-kit 2.3.0, searching titles and participants in every loaded summary across both folders and beyond the sidebar batch. No message loading, provider request or persisted query is involved. Selection waits for the kit's native dialog closure before navigating, so its focus restoration does not override the destination heading. Escape returns to the folder-menu trigger; reopening clears the query. The published 2.3.0 dependency and lockfile are installed; standard type checking, production build and targeted tests pass. Desktop/mobile browser interaction checks now pass in Chromium, Firefox and WebKit after the local-server restriction was lifted (see the acceptance record).

The completed local edition uses server-backed timeline/discussion state, folder/ZIP transfer, trusted owner review, import jobs and reconciliation. Existing browser caches are neither inspected nor migrated automatically. Sending to OpenAI remains a separate explicit UI action. Synthetic tests must exercise actual file-form navigation in isolated browser contexts as well as API authorization, expiry/replay, media ranges, shutdown, and unchanged standalone behavior.

## Implementation and validation

Implemented in `server/library/browser-sessions.mjs` and `server/library/http.mjs`, with shared TypeScript record types, `src/lib/library-api.ts`, and `ServerConnection.vue`. Synthetic API tests cover authority, expiry/replay, repeated launches, session revocation, query boundaries, exact source reads, reading positions, media ranges, and launch-file cleanup. `pnpm test:library-browser` exercises the production build in fresh Chromium, Firefox or WebKit contexts with disposable state/library directories and a mocked provider service. It verifies actual file-form navigation, cookie isolation, multiple tabs, keyboard Quit at a narrow viewport, and standalone behavior. Run `pnpm build` and install the selected Playwright engine first; set `ECHO_BROWSER=firefox` or `webkit` to change engines.

The public app shell permits top-level navigation following the file-form redirect; private API authorization remains mandatory. Tests do not access a real export, browser profile, library, or provider credential. All three Playwright engines pass the isolated library flow; actual stable Chrome/Edge/Firefox/Safari and OS-default-browser integration remain release gates.

See [release acceptance](library-release-acceptance.md) for current versions and evidence. The complete 244-test unit suite also passes under the minimum supported Node 22.13.0. The production build retains its existing bundle-size advisory. Narrow-screen connection controls and deletion were visually checked using only generated fixtures and fresh browser profiles.

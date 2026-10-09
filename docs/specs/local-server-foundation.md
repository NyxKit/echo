# Local server foundation

Implementation decision for the first slice of [the conversation library](conversation-library-and-incremental-imports.md), 2026-10-06.

## Boundary and decisions

This document records the initial production HTTP server and Linux launcher decisions. Subsequent work supplies [worker-owned SQLite](library-storage-foundation.md), [paired browser access](library-browser-access.md), [incremental imports](library-import-engine.md), [durable discussions and jobs](library-discussions-and-jobs.md), and [Linux/Windows desktop adapters and packaging](desktop-delivery.md). Current evidence and platform gates are recorded in [release acceptance](library-release-acceptance.md).

- Target Node 24 LTS for the eventual bundled runtime. The source launcher now requires Node 22.13+ on a supported LTS line (22 or 24), to support the subsequent SQLite adapter without an experimental command-line flag. Node's [release policy](https://nodejs.org/en/about/previous-releases) recommends Active or Maintenance LTS for production. The desktop adapter now bundles Node 24.21.0 in Linux x86-64 and Windows x86-64 packages.
- Use `node:http` to serve only `index.html` and allowed built assets from `dist`. Do not expose the repository, source maps, arbitrary files, or a generic directory server. Reject symlinked assets. The browser UI uses fragment navigation, so unknown paths return 404. [Vite explicitly distinguishes preview from a production server](https://vite.dev/guide/static-deploy.html).
- Bind to `127.0.0.1:47831`; an explicit `--port` selects a different stable origin. Do not choose a random fallback port when occupied. Save the successfully bound port separately from instance credentials so it survives Quit and restart. Subsequent launches reuse it unless an explicit different port is requested while stopped.
- Reuse the Linux `flock` lease adapter, already covered by synthetic contention and process-death tests. Place lifecycle state in `$XDG_STATE_HOME/echo` (otherwise `~/.local/state/echo`), with a private directory and owner-only files. Use one instance lease per state directory, independent of the requested port. Do not inspect existing browser or credential storage. This is lifecycle state, not the future library database.
- Generate a new instance ID and 256-bit control secret on each server start. Atomically publish them with the port only after the server listens. The launcher reads this private state; no secret appears in URLs, arguments, logs, frontend assets, or public bootstrap responses.
- Authenticate control requests and replies using domain-separated HMAC-SHA256 over a versioned message, instance ID, method/path, time, nonce, and reply body. Enforce short request lifetimes, one-use nonces, bodyless requests, exact loopback Host, and absence of browser Origin/Fetch Metadata. A service occupying the port sees no reusable secret; its response cannot pass readiness validation. The launcher opens the browser only after verified readiness.
- Keep lifecycle control separate from browser and provider authority. The existing OAuth pairing, cookies, Host/Origin checks, CSRF header, and OS keyring remain implemented by the existing ChatGPT service. No new library/media endpoint is exposed before browser session authority is implemented for it.
- Detach the server from the launcher and its terminal; closing the browser leaves it running. On Quit stop admission immediately, close the ChatGPT service, stop HTTP connections within a bounded deadline, then remove instance state and release the lease. If service cleanup times out, the standalone server process must exit before releasing its OS lease; a new process can recover stale state. No process is killed based on an unverified PID or a port conflict.
- Return only fixed, actionable error categories. Never include filesystem errors, request bodies, or provider diagnostics in launcher output. Production dependencies include the existing `jose` module.

## Validation plan

Use disposable synthetic build/state directories and mocked credential/provider adapters. Cover allowed static assets, methods, traversal and symlink rejection, exact Host/Origin checks, unchanged OAuth flow, authenticated readiness and shutdown, replay rejection, occupied ports, concurrent launches, stale state, reuse across port options, launcher death, and shutdown waiting/bounds. Run existing unit tests and the production build. Validate the actual detached CLI under Node 24 with a synthetic application root and stub browser opener; never open a real browser profile or read its cached archive.

Stage 1 implementation now includes tray Open/Quit/status, protected UI Quit, opt-in login startup and reconnectable job ownership. Accepted library analysis continues after tab closure; the standalone Vite viewer retains its original browser storage and request lifecycle. Actual desktop acceptance remains separate from protocol tests.

## Implemented and checked

The source launcher now exposes `pnpm server:start`, `pnpm server:status`, and `pnpm server:quit`, with `--background` and explicit `--port` options for start. `jose` is a production dependency because the standalone server imports the existing ChatGPT service without Vite.

Validation on Linux with Node 24.21.0:

- Synthetic unit checks cover the production static boundary, OAuth pairing, control signatures and replay, shutdown waiting and timeout, private state permissions, lease contention, occupied ports, concurrent detached launch, abrupt server death, credential rotation on recovery, and stable custom ports across clean restarts.
- The production build and TypeScript validation pass. Vite still reports its large-chunk advisory for the existing frontend bundle.
- The built UI loads in a new headless Chromium context with no existing browser storage, no imported export, and a mocked disconnected provider service. Nonlocal requests are blocked during this check.
- The real CLI starts a detached server, reuses it, reports status, stops it, and retains the custom port after restart, using a disposable lifecycle directory and no browser opening or real credentials.

These foundation checks are supplemented by the current [release acceptance record](library-release-acceptance.md), including durable jobs, library browser flows, native Linux tray/controller tests and package checks. Real target-desktop and provider acceptance must not be inferred from the synthetic checks.

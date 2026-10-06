# Project instructions

## Privacy: mandatory

- Treat everything inside `data/` as personal, privacy-bound material. The directory name may be documented as configuration; its contents must never be referenced, quoted, summarized, copied, linked, or reproduced in any Markdown file or other development artifact.
- This includes names, handles, messages, filenames, internal paths, identifiers, timestamps, counts, screenshots, inferred relationships, and any other details derived from the export.
- Explicitly authorized exception: `PRODUCT.md` may contain an obfuscated, collapsed description of the folder structure. Use semantic placeholders only, merge repeated branches, and omit actual names, filenames, paths, identifiers, counts, and content. This exception permits local directory traversal with sanitization before tool output; it does not permit reading file contents or recording a mapping from placeholders to private names.
- Do not put export-derived material in documentation, source comments, fixtures, tests, snapshots, logs, terminal output, commits, issue descriptions, external tools, or agent memory. Use entirely synthetic examples and fixtures.
- Exclude `data/` from repository-wide searches and routine inspection. Documentation inspection is limited to the explicitly authorized obfuscated structure exception above. If implementation requires local inspection, minimize access and prevent private values from appearing in tool output or retained artifacts.
- Keep the export read-only and untracked. Never bundle it into public assets, builds, source maps, or deployments.
- The intended application may display the export locally. Sending a conversation to OpenAI is a separate, explicit user action with disclosure of the full context being sent; it does not authorize development tools or agents to ingest private material.
- Treat browser-cached exports, locally saved AI conversations, and authentication credentials as sensitive too. Never commit or log them.

## Implementation conventions

- Follow `PRODUCT.md` for product requirements and unresolved decisions.
- Current authorized scope includes the local read-only viewer plus the ChatGPT connection and conversation analysis in docs/specs/chatgpt-connection.md. Use separate information and analysis shelves; analysis shares available width equally with the timeline. Keep agent settings in a cog modal, direct message selection with composer chips, explicit context scopes (selected, surrounding by default, or full active conversation), direct user-initiated sending with visible context disclosure and an optional development-only inline inspector, and text/static-image analysis. Audio/video analysis and separately billed API fallback remain deferred. Authorization belongs in the application UI.
- Use Vue and SCSS with BEM naming (`block__element--modifier`).
- Use nyx-kit for all available primitives and other applicable components, composables, utilities, and design tokens. Consult `~/Projects/nyxkit/nyx-kit`; confirm actual exports instead of assuming roadmap items exist.
- Preserve nyx-kit's default colors. Compose application-specific components from its primitives; avoid parallel primitive or theme systems.
- Browser-local IndexedDB storage is authorized for caching the selected export across refreshes. Keep it local, provide Forget archive, and never access a real cached export through development tools. No server database or application backend in the default MVP architecture. A minimal local backend is allowed if required for a supported, secure OpenAI connection.
- Do not claim absolute security or assume Codex subscription credentials authorize arbitrary OpenAI API access. Resolve the connection feasibility gate before implementation.

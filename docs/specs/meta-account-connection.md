# Meta / Instagram account connection

Status: initial feasibility research, 2026-09-29. No integration selected or authorized for implementation.

Follow-up check, 2026-09-30: direct retrieval of the messaging guide was rate-limited, and the portability parameters and FAQ could not be retrieved. No new official evidence resolved personal-message coverage, recurring transfer, or local destination eligibility. The preliminary conclusion and research gates below remain unchanged; these retrieval failures are not evidence that the capabilities are unavailable.

## Goal and preliminary conclusion

Let a user keep their chat viewer up to date without repeatedly requesting, downloading, extracting, and selecting an Instagram export.

**An official connection that replaces a complete personal chat archive has not been established.** The documented professional-account messaging route has coverage gaps. Meta's data portability route deserves further investigation before concluding that personal-account automation is unavailable.

Distinguish three outcomes:

- Reopen an existing archive: the product already specifies a browser-local IndexedDB cache. This does not fetch new messages.
- Refresh periodically with less manual work: a transfer or improved import flow could satisfy this without real-time access.
- Synchronize messages continuously: requires a supported data source, reliable catch-up, and a runtime able to receive or fetch updates.

This document explores future scope. [PRODUCT.md](../../PRODUCT.md) remains authoritative: the current delivery is the local read-only viewer. Its backend exception is specifically for a supported OpenAI connection; it does not authorize a Meta backend, hosted receiver, or cloud storage.

## Evidence and limitations of this research

Research used public documentation only. No personal export, cached archive, authenticated account, or credential was inspected. No live API experiment was performed.

Meta's official Postman documentation was available through search indexing. Several direct Meta developer documentation requests failed with HTTP 429 or cache errors, including the Conversations API and data portability guides. Indexed documentation may lag current behavior. Treat the verified findings below as documentation evidence, not a tested integration contract; recheck before implementation.

The repository's Hindsight knowledge page was empty and supplied no architectural findings. Product constraints here come from repository instructions and PRODUCT.md.

## Candidate routes

| Route | Potential benefit | Feasibility for this product |
| --- | --- | --- |
| Instagram API with Instagram Login | Account-authorized professional messaging access | Candidate for a deliberately limited professional inbox; fails the group-chat requirement described below |
| Instagram API with Facebook Login | Access through a linked Facebook Page | Professional-account alternative; does not unlock consumer accounts |
| Meta data portability / Export Your Information | Potentially reduce repeated export work | Priority research question; message coverage, recurrence, destination eligibility, and local delivery remain unverified |
| Easier local archive refresh | Reduce extraction and selection steps | Fits the local architecture, but still depends on obtaining an updated export |
| Private endpoints, session-cookie reuse, or browser scraping | Attempt access outside the documented APIs | Not selected; no supported integration contract established |

### Instagram Login: verified scope

Meta documents Instagram Login for Business and Creator accounts, without a linked Facebook Page. Its current scope names include `instagram_business_basic` and `instagram_business_manage_messages`. Messaging excludes group conversations; requests inactive for 30 days are omitted from API results. Shared-post webhook payloads may contain only a URL. [Meta's Instagram API collection](https://www.postman.com/meta/workspace/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00)

**Product assessment:** these exclusions prevent treating this route as an export-equivalent archive. It may still support a narrower professional inbox. Do not recommend account conversion as a proven solution: first establish the user's account type, willingness to change it, and acceptable coverage.

Unresolved API details that must be checked in the current [Conversations API documentation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api/):

- How far historical message details can be retrieved, including conversations predating authorization. Verify any recent-message cap explicitly; pagination alone does not establish full history access.
- Incoming and outgoing message coverage, including messages sent through Instagram's own clients.
- Supported attachments, reactions, edits, unsends, system events, requests, and stable identifiers.
- Media URL expiration and whether supported, permitted local caching can preserve previews.
- Rate limits, token lifetime and renewal, revocation, and recovery after an extended offline period.
- Required permissions and access level for an app-role test versus unrelated users; App Review, verification, and approved use-case requirements for this particular read-only viewer.

Sending-window rules must not be mistaken for history-retention rules. This viewer needs read coverage and performs no message sending.

### Facebook Login and the meaning of “Meta account”

Meta's Facebook Login configuration requires a professional Instagram account linked to a Facebook Page and explicitly excludes consumer Instagram accounts. [Meta's Facebook Login collection](https://www.postman.com/meta/instagram/folder/9cgqucg/instagram-api-with-facebook-login)

**Product assessment:** a generic “Connect Meta” label would obscure which account, resource, and permission the app needs. Successful sign-in or Accounts Center linkage is not evidence of access to all associated private messages. Select the supported Instagram data route before defining the connection experience. Personal Facebook Messenger history would be a separate feasibility study.

### Data portability: priority unresolved route

The European Commission's developer resources link to Meta's Data Portability Developer Guide. This establishes an official research route, not proof of a usable messaging integration. [European Commission developer resources](https://digital-markets-act.ec.europa.eu/businesses-portal/resources-developers_en)

Meta's 2023 announcement confirms Instagram download and transfer tools in Accounts Center, describing transfer of photos and videos. That announcement does not establish current DM coverage or recurring message delivery. [Meta's Accounts Center announcement](https://about.fb.com/news/2023/10/manage-your-information-across-apps/)

Resolve these questions against the current [Data Portability guide](https://developers.facebook.com/docs/data-portability/), [onboarding guide](https://developers.facebook.com/docs/data-portability/onboarding-guide), [deep-link guide](https://developers.facebook.com/docs/data-portability/deep-link-guide), [data parameters](https://developers.facebook.com/docs/data-portability/deep-link-params/), and [FAQ](https://developers.facebook.com/docs/data-portability/data-port-faq):

1. Can an ordinary personal Instagram account transfer messages, including both sides of conversations, groups, requests, and attachments?
2. Which regions and accounts qualify? Do not infer eligibility from the developer's location.
3. Can this project register as a destination? What review, organization, security, and operating requirements apply?
4. Is transfer one-off or recurring? What cadence, delays, renewal, and user interaction apply?
5. Does the destination receive full snapshots or deltas? What formats, identities, deletion semantics, and completion signals exist?
6. Can delivery reach an authorized local application, or does it require a public service or a supported cloud destination?
7. Does a deep link only preselect an export request, or establish an ongoing authorization? Never equate the two.

**Research hypothesis:** a supported recurring transfer could meet the convenience goal better than a professional messaging API. It would remain a periodic archive refresh unless a documented change stream exists. This hypothesis is not verified; neither message support nor a particular schedule is promised.

### Local refresh improvements

These are product proposals, not implemented changes:

- Accept an export ZIP directly and validate/extract it in the browser, reducing manual preparation. ZIP support is outside today's MVP scope.
- Add an explicit refresh from a previously authorized folder where browser support permits; preserve a folder-selection fallback. Folder access cannot request a new export from Meta.
- Investigate a supported scheduled transfer to a user-controlled destination only after verifying message inclusion and cadence. A cloud destination introduces another holder of private conversations and changes the local-only privacy model.

Prefer atomic snapshot replacement initially. Partial updates require an explicit merge model; neither matching display names nor equal message text proves that records are the same.

### Unofficial access

Password collection, copied browser cookies, reverse-engineered mobile/private endpoints, and automated authenticated-page scraping are not proposed implementation paths. A library that technically retrieves messages would not by itself establish permission, stable coverage, or a maintainable authentication flow. This research does not authorize accessing an existing browser session or testing any of these approaches.

## Architecture implications if a route passes feasibility

The following are proposed requirements, not claims about Meta capabilities:

- Keep archive import and provider ingestion separate, feeding a shared normalized viewer model. Preserve source provenance, account boundaries, and known coverage gaps.
- Retain offline browsing. Show last successful refresh, current refresh failure, and incomplete history separately from connection status.
- Do not put provider app secrets or persistent tokens in browser JavaScript, IndexedDB, repository files, URLs, or logs. If the supported OAuth exchange requires a secret, the static frontend alone is insufficient.
- Evaluate a local companion only after accepting that scope change. Use an OS credential store, authenticated local requests, origin/host checks, CSRF defenses, and the provider-supported OAuth protections. Verify redirect and client-type support rather than assuming localhost or PKCE is accepted.
- Polling while the app runs may leave gaps while it is closed. Webhooks require a receiver Meta can reach; a loopback-only process is not publicly reachable. A hosted receiver changes who processes messages and needs a separate product decision. A development tunnel is not a production architecture.
- Persist updates transactionally, deduplicate retries, handle pagination and backoff, and detect incomplete catch-up. An omitted API record is not proof that a message was deleted.
- Never silently merge an archive and API history without a verified identity mapping. Preserve the archive as its own source when reconciliation is uncertain.
- Keep access read-only in the application. Disclose actual granted scope if Meta combines read and write capabilities; a read-only UI does not narrow an OAuth grant.
- Separate Disconnect from Forget archive: stop synchronization and clear credentials on disconnect; remove retained local content through explicit deletion controls. Document provider-side grant revocation and deletion requirements once verified.
- Connecting Instagram does not authorize sending any conversation to OpenAI. AI remains deferred.

## Decision gates and next research

| Gate | Evidence needed | Current status |
| --- | --- | --- |
| Audience | Personal/professional account; required groups; historical depth; acceptable delay | Product questions open; do not assume professional-only scope |
| Supported access | Current official contract for the chosen account and message categories | Partial professional route documented; personal portability unresolved |
| Completeness | History, attachments, requests, changes, and offline catch-up demonstrated | Not established; known professional group exclusion |
| Local architecture | Supported auth, secure credential lifecycle, and approved delivery destination | Not established |
| Distribution | Requirements for self-use versus connecting unrelated users | Not established |
| Validation | Isolated test accounts containing only synthetic conversations | Not performed |

Next steps, in order:

1. Retrieve the current portability documentation and settle personal-message transfer, recurrence, and destination eligibility. Record explicit exclusions as well as supported categories.
2. Clarify whether periodic refresh is sufficient and whether a professional-only connection would be useful. These determine which route merits further work.
3. If professional access remains relevant, verify historical limits and permission/review requirements before designing OAuth or sync code.
4. Once a viable route and architecture are selected, define a separate synthetic-account experiment. Test history before authorization, groups and requests, outgoing messages, media, duplicate delivery, revocation, offline gaps, and failed refresh recovery. Keep raw credentials and payloads out of development artifacts.
5. Amend PRODUCT.md only after the integration scope is chosen. Until then, preserve the existing viewer and export flow.

**Working recommendation:** prioritize portability research for personal accounts. Consider professional messaging only as an explicitly partial option. If neither route meets the requirements, improve the export-refresh experience without presenting it as account synchronization.

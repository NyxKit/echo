# Surrounding windows at archive boundaries

Status: implemented on `feat/surrounding-window-boundaries`. Validation uses synthetic records only.

Surrounding context should provide the chosen elapsed duration wherever the conversation archive permits. Center the window on each selected message, then shift it within the archive when it reaches either boundary. A recent selection should receive more earlier history rather than lose the unavailable future half of its window.

## Duration driven calculation

Resolve the selected timeframe into a positive duration `D` in milliseconds before calculating boundaries. The window algorithm accepts this duration directly and contains no timeframe names, preset-specific cutoffs, or fixed half-window constants. Presets are 24h, 48h, 7 days, 30 days, 90 days (3 months), 180 days (6 months), and 365 days. The composer and Settings label the new presets as 3 months and 6 months; numeric labels make the durations explicit without suggesting calendar quarters. Both are multiples of the existing 30-day month. Future presets and custom timeframes use the same calculation once their duration is resolved. Custom timeframe controls and calendar-month semantics remain deferred.

For the active conversation, let `A` and `B` be the earliest and latest valid archived message timestamps. For each selected message with timestamp `T`:

```text
width = min(D, B - A)
start = clamp(T - floor(width / 2), A, B - width)
end = start + width
```

Here, `clamp(value, minimum, maximum)` limits the value to that interval. Include both endpoints. Calculations use elapsed milliseconds rather than calendar-day boundaries or the current clock; an odd millisecond goes on the later side of an otherwise centered window.

If the archive spans less than `D`, the window covers its full dated history. A single valid timestamp produces a zero-width inclusive window. Sparse history does not cause further expansion to reach a message count. Resolve bounds from the complete active conversation, independently of timeline filters or rendered rows.

## Selection and discussion behavior

- Resolve each selection independently, then merge overlapping windows. Preserve gaps between disjoint windows.
- Explicitly selected undated messages remain included without creating a window. Other undated messages remain excluded from time windows. Preserve the existing behavior when no valid timestamps are available.
- Without a selection, Last windows continue to end at the latest archived timestamp and extend backward by `D`. All time and Only selected messages retain their current behavior.
- Use one shared duration-based resolver for the browser viewer and persistent library, including preparation and relevant import refreshes.
- Keep completed turns, citations, and historical evidence immutable. Preserve already established window bounds and historical coverage; do not retroactively shift old windows when an import changes archive boundaries. Newly resolved surrounding windows use the new rule, and library refresh retains the existing union-of-evidence policy.
- Settings sharing copy explains that windows center when possible and shift at archive boundaries. This policy supersedes the unconditional equal-halves wording in PRODUCT.md and the connection/refresh specs for newly resolved windows.

## Synthetic examples and acceptance

For an archive spanning elapsed day 0 through day 1000:

| Duration | Selected day | Included interval |
| --- | --- | --- |
| 365 days | 500 | 317.5 through 682.5 |
| 365 days | 999 | 635 through 1000 |
| 365 days | 1 | 0 through 365 |
| 90 days | 999 | 910 through 1000 |
| 180 days | 1 | 0 through 180 |

Verify the same algorithm with every current preset and arbitrary synthetic durations that have no preset entry, including an odd millisecond duration. Cover both archive edges, exact inclusive endpoints, short and single-timestamp archives, sparse history, overlapping and disjoint selections, and undated selections. Confirm identical browser/library results, unchanged Last behavior, and retained historical bounds and evidence after imports. Use only synthetic records and isolated storage.

`shared/context-windows.mjs` exposes `resolveTimeWindows(messages, selectedIndexes, duration)` for both message selection and persisted library coverage. Legacy snapshots without saved coverage retain the original equal-halves reconstruction. Regression coverage lives in `tests/context-windows.test.ts`, `tests/library-context-refresh.test.mjs`, and `tests/viewer.spec.ts`.

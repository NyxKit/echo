import { computed, reactive } from 'vue'
import { expect, it } from 'vitest'
import { discussionTimestamp, newestDiscussionsFirst } from '../src/lib/discussion-order'
import type { AnalysisThread } from '../src/stores/analysis'

const thread = (id: string, lastInteractionAt?: string | null): AnalysisThread => ({
  id, title: 'Synthetic discussion', draft: '', scope: 'week', turns: [], lastInteractionAt,
})

it('sorts discussions by the full latest interaction timestamp with stable ties and unknown dates last', () => {
  const threads = [thread('unknown-b'), thread('previous-year', '2025-12-31T23:00:00.000Z'),
    thread('earlier', '2026-10-27T08:00:00.000Z'), thread('latest-b', '2026-10-27T09:00:00.000Z'),
    thread('invalid', 'invalid'), thread('latest-a', '2026-10-27T09:00:00.000Z'), thread('unknown-a', null)]
  expect([...threads].sort(newestDiscussionsFirst).map(item => item.id)).toEqual([
    'latest-a', 'latest-b', 'earlier', 'previous-year', 'invalid', 'unknown-a', 'unknown-b',
  ])
  expect(discussionTimestamp(thread('epoch', '1970-01-01T00:00:00.000Z'))).toBe(0)
  expect(discussionTimestamp(thread('missing'))).toBeNull()
})

it('reactively promotes a new interaction while keeping drafts, titles and source order independent', () => {
  const threads = reactive([thread('older', '2026-10-26T09:00:00.000Z'), thread('newer', '2026-10-27T09:00:00.000Z')])
  const ordered = computed(() => [...threads].sort(newestDiscussionsFirst).map(item => item.id))
  expect(ordered.value).toEqual(['newer', 'older'])
  threads[0]!.draft = 'Synthetic unsent draft'
  threads[0]!.title = 'Synthetic renamed discussion'
  expect(ordered.value).toEqual(['newer', 'older'])
  threads[0]!.turns.push({ id: 'synthetic-turn', question: 'Synthetic question', answer: '', status: 'sending',
    promptTime: { sentAt: '2026-10-28T09:00:00.000Z', timeZone: 'Europe/Brussels' },
    focus: [], context: { scope: 'discussion' }, images: [], excluded: [],
  })
  expect(ordered.value).toEqual(['older', 'newer'])
  expect(threads.map(item => item.id)).toEqual(['older', 'newer'])
  threads[0]!.turns[0]!.status = 'failed'
  expect(ordered.value).toEqual(['older', 'newer'])
})

import { describe, expect, it, vi } from 'vitest'
import { backfillDiscussionSubjects } from '../src/lib/discussion-subject-backfill'

function fixture() {
  const api = {
    discussionSubjectCandidates: vi.fn()
      .mockResolvedValueOnce({ version: 1, items: [], after: 'next-page' })
      .mockResolvedValueOnce({ version: 1, items: ['first', 'second'], after: null }),
    generateDiscussionSubject: vi.fn()
      .mockResolvedValueOnce({ version: 1, updated: true })
      .mockResolvedValueOnce({ version: 1, updated: false }),
  }
  const progress = vi.fn(), controller = new AbortController()
  return { api, progress, controller }
}

describe('explicit discussion subject backfill', () => {
  it('traverses empty candidate pages and saves subjects sequentially with progress', async () => {
    const { api, progress, controller } = fixture()
    const result = await backfillDiscussionSubjects(api, 'chosen-model', controller.signal, progress)
    expect(result).toEqual({ total: 2, processed: 2, updated: 1, skipped: 1 })
    expect(api.discussionSubjectCandidates.mock.calls.map(call => call[0])).toEqual(['', 'next-page'])
    expect(api.generateDiscussionSubject.mock.calls).toEqual([['first', 'chosen-model', controller.signal], ['second', 'chosen-model', controller.signal]])
    expect(progress.mock.calls.map(call => call[0].processed)).toEqual([0, 1, 2])
  })
  it('stops before sending another prompt when canceled', async () => {
    const { api, progress, controller } = fixture()
    api.generateDiscussionSubject.mockReset().mockImplementationOnce(async () => { controller.abort(); return { version: 1, updated: true } })
    await expect(backfillDiscussionSubjects(api, 'chosen-model', controller.signal, progress)).rejects.toThrow()
    expect(api.generateDiscussionSubject).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenLastCalledWith({ total: 2, processed: 1, updated: 1, skipped: 0 })
  })
  it('stops on provider failure and retains progress for subjects already saved', async () => {
    const { api, progress, controller } = fixture()
    api.generateDiscussionSubject.mockReset().mockResolvedValueOnce({ version: 1, updated: true }).mockRejectedValueOnce(new Error('unavailable'))
    await expect(backfillDiscussionSubjects(api, 'chosen-model', controller.signal, progress)).rejects.toThrow('unavailable')
    expect(progress).toHaveBeenLastCalledWith({ total: 2, processed: 1, updated: 1, skipped: 0 })
  })
})

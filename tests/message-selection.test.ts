import { describe, expect, it } from 'vitest'
import { toggleMessageSelection } from '../src/lib/message-selection'

describe('message selection', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  it('toggles independent messages and anchors the most recent ordinary toggle', () => {
    let selection = toggleMessageSelection({ ids: [] }, 'a', ids)
    selection = toggleMessageSelection(selection, 'd', ids)
    expect(selection.ids).toEqual(['a', 'd'])
    selection = toggleMessageSelection(selection, 'a', ids)
    expect(selection).toEqual({ ids: ['d'], anchor: 'a' })
  })
  it('adds a range in either direction without losing noncontiguous selections', () => {
    const selected = { ids: ['a', 'e'], anchor: 'e' }
    expect(toggleMessageSelection(selected, 'c', ids, true)).toEqual({ ids: ['a', 'e', 'c', 'd'], anchor: 'e' })
    expect(toggleMessageSelection({ ids: ['b'], anchor: 'b' }, 'd', ids, true).ids).toEqual(['b', 'c', 'd'])
  })
  it('uses the full visible history, excludes filtered messages, and handles a hidden anchor', () => {
    expect(toggleMessageSelection({ ids: ['a'], anchor: 'a' }, 'e', ids, true).ids).toEqual(ids)
    expect(toggleMessageSelection({ ids: ['a'], anchor: 'a' }, 'e', ['a', 'c', 'e'], true).ids).toEqual(['a', 'c', 'e'])
    expect(toggleMessageSelection({ ids: ['b'], anchor: 'b' }, 'e', ['a', 'e'], true)).toEqual({ ids: ['b', 'e'], anchor: 'e' })
  })
})

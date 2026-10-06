export interface MessageSelection { ids: string[]; anchor?: string }

export function toggleMessageSelection(selection: MessageSelection, id: string, orderedIds: string[], range = false): MessageSelection {
  const target = orderedIds.indexOf(id)
  if (target < 0) return selection
  const anchor = selection.anchor ? orderedIds.indexOf(selection.anchor) : -1
  const ids = new Set(selection.ids)
  if (range && anchor >= 0) {
    for (const value of orderedIds.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)) ids.add(value)
    return { ids: [...ids], anchor: selection.anchor }
  }
  if (ids.has(id)) ids.delete(id)
  else ids.add(id)
  return { ids: [...ids], anchor: id }
}

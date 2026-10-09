import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { DomUtils, parseDocument } from 'htmlparser2'
import ConversationSearch from '../src/components/ConversationSearch.vue'
import type { Conversation } from '../src/lib/archive'

function conversation(id: string, category: Conversation['category'], timestamp: number): Conversation {
  return { id, title: `Synthetic ${id}`, participants: ['Synthetic participant'], category, pictures: {}, messages: [], preview: { text: '', timestamp } }
}

async function render(conversations: Conversation[]) {
  const app = createSSRApp({ render: () => h(ConversationSearch, { conversations, loading: false, activeId: '' }) })
  app.provide('libEnv', {})
  const document = parseDocument(await renderToString(app))
  return {
    text: DomUtils.textContent(document),
    options: DomUtils.findAll(node => node.attribs.role === 'option', document.children),
    elements: (name: string) => DomUtils.findAll(node => node.name === name, document.children),
  }
}

describe('conversation palette integration', () => {
  it('provides both folders, including summaries beyond the sidebar batch, without requiring messages', async () => {
    const conversations = Array.from({ length: 151 }, (_, index) => conversation(`inbox-${index}`, 'Inbox', index))
    conversations.push(conversation('request', 'Requests', 200), conversation('other', 'Other', 300))
    const ids = conversations.map(item => item.id)
    const result = await render(conversations)
    expect(result.options).toHaveLength(153)
    expect(result.options[0]!.attribs['aria-label']).toBe('Synthetic other')
    expect(result.options.at(-1)!.attribs['aria-label']).toBe('Synthetic request')
    expect(result.options.some(item => item.attribs['aria-label'] === 'Synthetic inbox-150')).toBe(true)
    expect(result.text).toContain('Synthetic participant')
    expect(conversations.map(item => item.id)).toEqual(ids)
  })

  it('keeps duplicate titles distinct by identity and renders untrusted names as text', async () => {
    const conversations = [conversation('one', 'Inbox', 1), conversation('two', 'Requests', 2)]
    for (const item of conversations) item.title = '<img src="https://example.invalid/private">'
    const result = await render(conversations)
    expect(result.options).toHaveLength(2)
    expect(new Set(result.options.map(item => item.attribs.id)).size).toBe(2)
    expect(result.elements('img')).toHaveLength(0)
    expect(result.text).toContain('<img src="https://example.invalid/private">')
    expect(result.elements('dialog')[0]!.attribs.open).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parseDocument, DomUtils } from 'htmlparser2'
import AnalysisAnswer from '../src/components/AnalysisAnswer.vue'
import type { Conversation, Message } from '../src/lib/archive'

const { findAll, textContent } = DomUtils

const conversation: Conversation = {
  id: 'synthetic', title: 'Synthetic', participants: [], category: 'Inbox', pictures: {},
  messages: [{ id: 'synthetic-message', sourceReference: { part: 0, index: 7 } } as Message],
}
async function render(text: string, source = conversation) {
  const app = createSSRApp({ render: () => h(AnalysisAnswer, { text, conversation: source }) })
  app.provide('libEnv', {})
  const html = await renderToString(app)
  const document = parseDocument(html)
  return {
    html,
    text: textContent(document),
    elements: (tag: string) => findAll(node => node.name === tag, document.children),
  }
}

describe('assistant Markdown integration', () => {
  it('renders the complete document with formatting and citations nested inside list items', async () => {
    const result = await render('# Summary\n\n- **Synthetic statement.**  \n  A second line.  \n  *An explanation.* [[p1:m8]]\n\n---\n\n| Topic | Detail |\n| --- | --- |\n| Time | Noon |')
    expect(result.elements('h3')).toHaveLength(1)
    expect(result.elements('strong')).toHaveLength(1)
    expect(result.elements('em')).toHaveLength(1)
    expect(result.elements('br')).toHaveLength(2)
    expect(result.elements('hr')).toHaveLength(1)
    expect(result.elements('table')).toHaveLength(1)
    const buttons = result.elements('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].attribs['aria-label']).toBe('View cited message 1')
    expect(textContent(buttons[0])).toBe('Message 1')
    expect(textContent(result.elements('li')[0])).toContain('Message 1')
  })

  it('keeps missing, escaped, code, and link-label references literal', async () => {
    const result = await render('Unknown [[p9:m9]] and \\[[p1:m8]] and `[[p1:m8]]`.\n\n```text\n[[p1:m8]]\n```\n\n[Example [[p1:m8]]](https://example.invalid/)\n\nMessage 1')
    expect(result.elements('button')).toHaveLength(0)
    expect(result.text).toContain('[[p9:m9]]')
    expect(result.elements('code')).toHaveLength(2)
    expect(textContent(result.elements('a')[0])).toContain('[[p1:m8]]')
  })

  it('accepts a citation completed by streaming and resolves it against the supplied conversation', async () => {
    const partial = await render('**Answer:** [[p1:m')
    expect(partial.elements('button')).toHaveLength(0)
    expect(partial.text).toContain('[[p1:m')
    const complete = await render('**Answer:** [[p1:m8]]')
    expect(complete.elements('button')).toHaveLength(1)
    const other = await render('**Answer:** [[p1:m8]]', { ...conversation, messages: [] })
    expect(other.elements('button')).toHaveLength(0)
    expect(other.text).toContain('[[p1:m8]]')
  })

  it('does not activate raw HTML, unsafe destinations, or remote images', async () => {
    const result = await render('<script>alert("synthetic")</script>\n\n<img src="https://example.invalid/pixel.png" onerror="alert(1)">\n\n[Unsafe](javascript:alert%281%29) ![Synthetic image](https://example.invalid/image.png)\n\n[Safe](https://example.invalid/)')
    expect(result.elements('script')).toHaveLength(0)
    expect(result.elements('img')).toHaveLength(0)
    expect(result.text).toContain('<script>')
    expect(result.text).toContain('Synthetic image')
    expect(result.elements('a')).toHaveLength(1)
    expect(result.elements('a')[0].attribs).toMatchObject({ href: 'https://example.invalid/', target: '_blank', rel: 'noopener noreferrer' })
  })
})

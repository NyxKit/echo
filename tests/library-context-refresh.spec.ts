import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
test.use({ timezoneId: 'Europe/Brussels' })

// Isolated browser state and fully generated API responses, never a real library.
test('discloses imported context, keeps a rejected draft, sends explicitly, and reopens the refreshed discussion',async({ page })=>{
  await page.clock.setFixedTime(new Date('2026-10-15T06:00:00.000Z'))
  const conversationId=randomUUID(),discussionId=randomUUID(),userId=randomUUID(),messageIds=[randomUUID(),randomUUID()]
  const sources=[1,2].map(index=>JSON.stringify({ sender_name: 'Synthetic Self',content: `Synthetic archived ${index}`,timestamp_ms: index }))
  const sourceParts=[`{"messages":{"0":${sources[0]}}}`]
  const first={ id: randomUUID(),userId,sequence: 0,question: 'Synthetic first question',promptTime: { sentAt: '2026-10-14T14:00:00.000Z',timeZone: 'Europe/Brussels' },focus: [],context: { scope: 'week',references: ['p1:m1'] },
    images: [],excluded: [],answer: 'Synthetic original answer [[p1:m1]]',status: 'complete',referenceMap: { 'p1:m1': messageIds[0] } }
  const saved={ id: discussionId,userId,conversationId,title: 'Synthetic discussion',draft: '',draftRevision: 2,scope: 'week',sourceVersion: 'a'.repeat(64),
    contextSource: { sourceVersion: 'a'.repeat(64),sourceParts },turns: [first] }
  let preparations=0,acceptances=0,reject=true,statusChecks=0
  let pending: any
  await page.route(request=>request.pathname==='/',async route=>{
    const response=await route.fetch()
    await route.fulfill({ response,body: (await response.text()).replace('<head>','<head><meta name="echo-runtime" content="local-library">') })
  })
  await page.route('**/api/chatgpt/**',route=>route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/models')
    ? { models: [{ id: 'synthetic-model',name: 'Synthetic model' }] } : { state: 'connected' } }))
  await page.route('**/api/library/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.replace('/api/library/v1/',''),method=route.request().method()
    let value: any={}
    if(path==='status') value={ schemaVersion: 5,revision: 2,owner: { userId,label: 'Synthetic Self' } }
    else if(path==='conversations') value={ items: [{ id: conversationId,userId,title: 'Synthetic refresh thread',participants: ['Synthetic Self'],pictures: [],category: 'Inbox',messageCount: 2,preview: { text: 'Synthetic archived 2',timestamp: 2 } }] }
    else if(path==='preferences') value={ values: { activeConversation: conversationId } }
    else if(path.endsWith('/messages')) value={ items: sources.map((sourceJson,index)=>({ id: messageIds[index],ordinal: index,sourceJson,sourceAssets: [],attachments: [],versionCount: 1,assetConflictCount: 0 })) }
    else if(path.endsWith('/position')) value={ position: null }
    else if(path.endsWith('/discussions')) value={ items: [saved] }
    else if(path===`discussions/${discussionId}`) {
      if(method==='PUT') { const input=route.request().postDataJSON(); Object.assign(saved,{ draft: input.draft,title: input.title,scope: input.scope,draftRevision: saved.draftRevision+1 }) }
      value=saved
    } else if(path.endsWith('/context-status')) {
      statusChecks++
      value={ status: saved.turns.length===1?'update':'existing',scope: 'week',generation: 'b'.repeat(64) }
    } else if(path.endsWith('/prepare')) {
      preparations++
      const input=route.request().postDataJSON()
      expect(input.promptTime).toEqual({ sentAt: preparations===1?'2026-10-15T06:00:00.000Z':'2026-10-15T06:05:00.000Z',timeZone: 'Europe/Brussels' })
      pending={ requestId: randomUUID(),model: input.model,sourceVersion: 'b'.repeat(64),contextVersion: 'c'.repeat(64),
        sourceParts: [...sourceParts,`{"messages":{"0":${sources[1]}}}`],history: [{ question: first.question,promptTime: first.promptTime,focus: first.focus,context: first.context,images: [],excluded: [],answer: first.answer }],
        turn: { question: input.question,promptTime: input.promptTime,focus: [],context: { scope: 'week',references: ['p1:m1','p2:m1'],refresh: true },images: [],excluded: [] } }
      value={ payload: pending,revision: 2,referenceMap: { 'p1:m1': messageIds[0],'p2:m1': messageIds[1] },freshness: { status: 'update',scope: 'week',generation: 'b'.repeat(64) } }
    } else if(path.endsWith('/turns')) {
      acceptances++
      if(reject) { reject=false; await route.fulfill({ status: 409,json: { code: 'library_context_changed' } }); return }
      const turn={ ...pending.turn,id: pending.requestId,userId,sequence: 1,referenceMap: { 'p1:m1': messageIds[0],'p2:m1': messageIds[1] },answer: 'Synthetic refreshed answer [[p2:m1]]',status: 'complete' }
      saved.turns.push(turn); saved.draft=''; saved.draftRevision++; saved.sourceVersion=pending.sourceVersion
      saved.contextSource={ sourceVersion: pending.sourceVersion,sourceParts: pending.sourceParts }
      value={ accepted: true,turn,discussion: { title: saved.title,draft: '',draftRevision: saved.draftRevision } }
    } else if(path.startsWith('turns/')) value={ turn: saved.turns.at(-1) }
    await route.fulfill({ json: { version: 1,...value } })
  })
  await page.goto('/')
  await page.getByRole('button',{ name: 'Ask Echo',exact: true }).click()
  await expect(page.getByText('New imported context will be included',{ exact: true })).toBeVisible()
  await expect(page.getByText('Context: Last week',{ exact: true })).toBeVisible()
  expect(statusChecks).toBeGreaterThan(0); expect(preparations).toBe(0); expect(acceptances).toBe(0)
  const composer=page.getByLabel('Ask about this conversation',{ exact: true })
  await composer.fill('What changed in the new exchange?')
  await page.getByRole('button',{ name: 'Send message',exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('source or discussion changed')
  await expect(composer).toHaveValue('What changed in the new exchange?')
  expect(saved.turns).toHaveLength(1)
  await page.clock.setFixedTime(new Date('2026-10-15T06:05:00.000Z'))
  await page.getByRole('button',{ name: 'Send message',exact: true }).click()
  await expect(page.getByText('Synthetic refreshed answer',{ exact: false })).toBeVisible()
  await expect(composer).toHaveValue('')
  await expect(page.getByText('Using existing context',{ exact: true })).toBeVisible()
  expect(preparations).toBe(2); expect(acceptances).toBe(2)
  expect(saved.turns[0].promptTime.sentAt).toBe('2026-10-14T14:00:00.000Z')
  expect(saved.turns[1].promptTime.sentAt).toBe('2026-10-15T06:05:00.000Z')
  await expect(page.locator('.conversation-analysis__question').last()).not.toContainText('2026-10-15')
  await expect(page.locator('.conversation-analysis__question').last()).toContainText('Updated context')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.reload()
  await page.getByRole('button',{ name: 'Ask Echo',exact: true }).click()
  await expect(page.getByText('Using existing context',{ exact: true })).toBeVisible()
  await expect(page.locator('.conversation-analysis__turns > li')).toHaveCount(2)
  expect(preparations).toBe(2); expect(acceptances).toBe(2)
})

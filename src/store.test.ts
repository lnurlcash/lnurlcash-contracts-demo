// @vitest-environment happy-dom

import {beforeEach, describe, expect, it} from 'vitest'
import {clearStore, loadStore, saveStore, withExclusiveBrowserLock, type DemoStore} from './store'

const demoStore = (): DemoStore => ({
  identities: {} as DemoStore['identities'],
  requests: {},
  payouts: {rider: [], driver: []},
  resolutions: {}
})

describe('contract persistence', () => {
  beforeEach(() => clearStore())

  it('keeps a chosen resolution across a browser reload', () => {
    const store = demoStore()
    store.resolutions['01'.repeat(16)] = 'rider_cancel'
    saveStore(store)
    expect(loadStore().resolutions['01'.repeat(16)]).toBe('rider_cancel')
  })

  it('does not restore an invented resolution from altered storage', () => {
    const store = demoStore()
    localStorage.setItem('lnurlcash_contracts_demo_v1', JSON.stringify({...store, resolutions: {['01'.repeat(16)]: 'referee_wins'}}))
    expect(loadStore().resolutions).toEqual({})
  })

  it('serialises two tabs trying to mutate the same contract', async () => {
    const order: string[] = []
    let releaseFirst = (): void => undefined
    let markStarted = (): void => undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = withExclusiveBrowserLock('contract:race', async () => {
      order.push('first:start')
      markStarted()
      await gate
      order.push('first:end')
    })
    await started
    const second = withExclusiveBrowserLock('contract:race', async () => { order.push('second') })
    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })
})

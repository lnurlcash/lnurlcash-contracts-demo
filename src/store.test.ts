// @vitest-environment happy-dom

import {beforeEach, describe, expect, it} from 'vitest'
import {clearStore, loadStore, saveStore, type DemoStore} from './store'

const demoStore = (): DemoStore => ({
  identities: {} as DemoStore['identities'],
  requests: {},
  payouts: {rider: [], driver: []}
})

describe('contract persistence', () => {
  beforeEach(() => clearStore())

  it('keeps a chosen resolution across a browser reload', () => {
    const store = demoStore()
    store.resolution = 'rider_cancel'
    saveStore(store)
    expect(loadStore().resolution).toBe('rider_cancel')
  })

  it('does not restore an invented resolution from altered storage', () => {
    const store = demoStore()
    localStorage.setItem('lnurlcash_contracts_demo_v1', JSON.stringify({...store, resolution: 'referee_wins'}))
    expect(loadStore().resolution).toBeUndefined()
  })
})

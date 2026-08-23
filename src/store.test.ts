// @vitest-environment happy-dom

import {beforeEach, describe, expect, it} from 'vitest'
import {clearStore, legacyRecoveryJson, loadStore, saveStore, withExclusiveBrowserLock, type DemoStore} from './store'

const demoStore = (): DemoStore => ({
  identities: {},
  enrolments: {},
  requests: {},
  contracts: {},
  payoutTargets: {},
  settlements: [],
  resolutions: {}
})

describe('contract persistence', () => {
  beforeEach(() => localStorage.clear())

  it('keeps a chosen generic resolution across browser reload', () => {
    const store = demoStore()
    store.resolutions['01'.repeat(32)] = 'party_a_cancel'
    saveStore(store)
    expect(loadStore().resolutions['01'.repeat(32)]).toBe('party_a_cancel')
  })

  it('does not restore an invented resolution from altered storage', () => {
    localStorage.setItem('lnurlcash_contracts_demo_v2', JSON.stringify({...demoStore(), resolutions: {['01'.repeat(32)]: 'arbiter_wins'}}))
    expect(loadStore().resolutions).toEqual({})
  })

  it('does not overwrite earlier inspector secrets during the v2 migration', () => {
    const legacy = JSON.stringify({requests: {old: {receiverSecretHex: '11'.repeat(32)}}})
    localStorage.setItem('lnurlcash_contracts_demo_v1', legacy)
    saveStore(demoStore())
    clearStore()
    expect(legacyRecoveryJson()).toBe(legacy)
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

  it('refuses money movement when cross-context locks are unavailable', async () => {
    Object.defineProperty(navigator, 'locks', {value: undefined, configurable: true})
    await expect(withExclusiveBrowserLock('spend:unsafe', async () => 'moved', {requireCrossContext: true})).rejects.toThrow('cannot safely serialise')
  })
})

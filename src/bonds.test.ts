import {describe, expect, it} from 'vitest'
import {bondSetForContract, resolveHeldBonds} from './bonds'
import {createIdentity, outputHashOf, randomSecretHex, signRequest, type ContractParticipants, type PaymentPurpose, type ReceiverLockedIntent} from './protocol'
import type {DemoStore, StoredRequest} from './store'

const mint = {
  host: 'mint.forgesworn.dev',
  withdrawLink: 'https://mint.forgesworn.dev/w',
  mintPubkey: '03bcd4846649e7b7d27e044ed7305547a5cf0209bd9629aa1de67f47d0c41b4407'
}

const emptyStore = (): DemoStore => ({
  identities: {} as DemoStore['identities'], requests: {}, payouts: {rider: [], driver: []}, resolutions: {}
})

const participantsByReferee = new Map<string, ContractParticipants>()

const addBond = (
  store: DemoStore,
  referee: {secretHex: string; pubkey: string},
  contractId: string,
  purpose: Extract<PaymentPurpose, 'rider_bond' | 'driver_bond'>,
  funded = true,
  expires = Math.floor(Date.now() / 1000) + 300
): string => {
  let participants = participantsByReferee.get(referee.pubkey)
  if (!participants) {
    participants = {rider: createIdentity().pubkey, driver: createIdentity().pubkey, referee: referee.pubkey}
    participantsByReferee.set(referee.pubkey, participants)
  }
  const receiverSecretHex = randomSecretHex()
  const intent: ReceiverLockedIntent = {
    v: 1, rideId: contractId, fareVersion: 1, purpose, role: 'referee', amount: '10', currency: 'sat',
    mint, outputHash: outputHashOf(receiverSecretHex), expires, memo: `${purpose} test`, participants
  }
  const signed = signRequest(intent, referee.secretHex)
  const record: StoredRequest = {encoded: signed.encoded, intent: signed.intent, receiverSecretHex}
  if (funded) record.received = {
    noteUrl: `${mint.withdrawLink}?k1=${receiverSecretHex}&amount=10000`, amountMsat: 10_000,
    callback: `${mint.withdrawLink}/cb`, signatureVerified: null
  }
  store.requests[signed.event.id] = record
  return signed.event.id
}

const redirect = async (_held: NonNullable<StoredRequest['received']>, _old: string, beneficiary: string) => ({
  noteUrl: `${mint.withdrawLink}?k1=${beneficiary}&amount=10000`, amountMsat: 10_000,
  callback: `${mint.withdrawLink}/cb`, signatureVerified: null
})

describe('adversarial bond resolution', () => {
  it('resolves only the selected contract and never sweeps another contract', async () => {
    const store = emptyStore()
    const referee = createIdentity()
    const first = '01'.repeat(16)
    const second = '02'.repeat(16)
    const firstIds = [addBond(store, referee, first, 'rider_bond'), addBond(store, referee, first, 'driver_bond')]
    const secondIds = [addBond(store, referee, second, 'rider_bond'), addBond(store, referee, second, 'driver_bond')]
    await resolveHeldBonds(store, first, 'complete', {persist: () => undefined, redirect})
    expect(firstIds.every(id => !store.requests[id]!.received)).toBe(true)
    expect(secondIds.every(id => Boolean(store.requests[id]!.received))).toBe(true)
    expect(store.payouts.rider.concat(store.payouts.driver).map(payout => payout.bondRequestId).sort()).toEqual(firstIds.sort())
    expect(store.resolutions).toEqual({[first]: 'complete'})
  })

  it('refuses duplicate roles even when all requests are validly signed', () => {
    const store = emptyStore()
    const referee = createIdentity()
    const contractId = '03'.repeat(16)
    addBond(store, referee, contractId, 'rider_bond')
    addBond(store, referee, contractId, 'rider_bond')
    expect(() => bondSetForContract(store, contractId)).toThrow('Duplicate or missing')
  })

  it('fails closed when browser storage swaps the only held-note secret', () => {
    const store = emptyStore()
    const referee = createIdentity()
    const contractId = '06'.repeat(16)
    const requestId = addBond(store, referee, contractId, 'rider_bond')
    addBond(store, referee, contractId, 'driver_bond')
    store.requests[requestId]!.receiverSecretHex = randomSecretHex()
    expect(() => bondSetForContract(store, contractId)).toThrow('receiver secret')
  })

  it('refunds one funded bond only after setup expires', async () => {
    const store = emptyStore()
    const referee = createIdentity()
    const contractId = '04'.repeat(16)
    const expires = Math.floor(Date.now() / 1000) + 300
    const funded = addBond(store, referee, contractId, 'rider_bond', true, expires)
    const unfunded = addBond(store, referee, contractId, 'driver_bond', false, expires)
    await expect(resolveHeldBonds(store, contractId, 'setup_abort', {persist: () => undefined, redirect, nowSeconds: expires - 1})).rejects.toThrow('deadline')
    await resolveHeldBonds(store, contractId, 'setup_abort', {persist: () => undefined, redirect, nowSeconds: expires + 1})
    expect(store.requests[funded]!.received).toBeUndefined()
    expect(store.requests[unfunded]!.received).toBeUndefined()
    expect(store.payouts.rider).toHaveLength(1)
    expect(store.payouts.driver).toHaveLength(0)
  })

  it('journals a stable output secret before a partial settlement and safely resumes', async () => {
    const store = emptyStore()
    const referee = createIdentity()
    const contractId = '05'.repeat(16)
    addBond(store, referee, contractId, 'rider_bond')
    addBond(store, referee, contractId, 'driver_bond')
    let calls = 0
    await expect(resolveHeldBonds(store, contractId, 'rider_cancel', {
      persist: () => undefined,
      redirect: async (...args) => {
        calls += 1
        if (calls === 2) throw new TypeError('connection dropped after mutation')
        return redirect(...args)
      }
    })).rejects.toThrow('connection dropped')
    const staged = store.payouts.driver.find(payout => payout.state === 'staged')!
    const stagedSecret = staged.secretHex
    await resolveHeldBonds(store, contractId, 'rider_cancel', {persist: () => undefined, redirect})
    expect(staged.secretHex).toBe(stagedSecret)
    expect(store.payouts.driver).toHaveLength(2)
    expect(store.payouts.driver.every(payout => payout.state === 'settled')).toBe(true)
  })
})

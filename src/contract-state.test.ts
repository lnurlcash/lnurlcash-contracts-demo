import {describe, expect, it} from 'vitest'
import {
  importVerifiedContractMessage,
  importVerifiedContractPacket,
  normaliseStoredContract
} from './contract-state'
import {
  decodeContractPacket,
  encodeContractPacket,
  signAcceptance,
  signArbiterDecision,
  signContractOffer,
  signOutcomeStatement,
  signSettlementNotice
} from './coordination'
import {coordinationFixture} from './coordination.fixture'
import {evaluateResolutionEvidence} from './bonds'
import {outputHashOf, randomSecretHex, signRequest} from './protocol'
import type {DemoStore} from './store'

const emptyStore = (): DemoStore => ({
  identities: {},
  enrolments: {},
  requests: {},
  contracts: {},
  payoutTargets: {},
  settlements: [],
  resolutions: {}
})

describe('fail-closed contract state', () => {
  it('refuses two signed offers that reuse one contract id with different terms', () => {
    const {offer, arbiter} = coordinationFixture()
    const store = emptyStore()
    importVerifiedContractMessage(store, offer)
    const fork = signContractOffer({...offer.terms, title: 'Conflicting terms'}, arbiter.secretHex)
    expect(() => importVerifiedContractMessage(store, fork)).toThrow('Conflicting signed offers reuse this contract id')
    expect(Object.keys(store.contracts)).toEqual([offer.event.id])
  })

  it('preserves the first acceptance and exposes participant equivocation', () => {
    const {offer, acceptances, partyA} = coordinationFixture()
    const store = emptyStore()
    importVerifiedContractMessage(store, offer)
    importVerifiedContractMessage(store, acceptances.party_a)
    const conflicting = signAcceptance(offer, 'party_a', {
      party_a: outputHashOf(randomSecretHex()),
      party_b: outputHashOf(randomSecretHex())
    }, partyA.secretHex)
    expect(() => importVerifiedContractMessage(store, conflicting)).toThrow('Conflicting signed party a acceptances')
    expect(store.contracts[offer.event.id]!.acceptances.party_a).toBe(acceptances.party_a.encoded)
  })

  it('will not replace a canonical packet with another valid arbiter-signed bond set', () => {
    const {packet, arbiter} = coordinationFixture()
    const store = emptyStore()
    importVerifiedContractPacket(store, packet)
    const replacementA = signRequest({...packet.bondRequests.party_a.intent, outputHash: outputHashOf(randomSecretHex())}, arbiter.secretHex)
    const replacementB = signRequest({...packet.bondRequests.party_b.intent, outputHash: outputHashOf(randomSecretHex())}, arbiter.secretHex)
    const conflicting = decodeContractPacket(encodeContractPacket({
      offer: packet.offer,
      acceptances: packet.acceptances,
      bondRequests: {party_a: replacementA, party_b: replacementB}
    }))
    expect(() => importVerifiedContractPacket(store, conflicting)).toThrow('different signed bond packet is already canonical')
    expect(store.contracts[packet.offer.event.id]!.packet).toBe(packet.encoded)
  })

  it('requires a locally owned participant packet to match its private payout secrets', () => {
    const {packet, partyA, secrets} = coordinationFixture()
    const store = emptyStore()
    store.identities.party_a = partyA
    store.payoutTargets[packet.offer.event.id] = {
      party_a: {
        secrets: {...secrets.party_a},
        outputHashes: {...packet.acceptances.party_a.payoutHashes},
        acceptance: packet.acceptances.party_a.encoded,
        received: {}
      }
    }
    importVerifiedContractPacket(store, packet)

    const damaged = emptyStore()
    damaged.identities.party_a = partyA
    damaged.payoutTargets[packet.offer.event.id] = {
      party_a: {
        secrets: {...secrets.party_a, party_b: randomSecretHex()},
        outputHashes: {...packet.acceptances.party_a.payoutHashes},
        acceptance: packet.acceptances.party_a.encoded,
        received: {}
      }
    }
    expect(() => importVerifiedContractPacket(damaged, packet)).toThrow("payout target does not match this browser's private secret")
  })

  it('retains conflicting arbiter decisions so equivocation freezes settlement', () => {
    const {packet, partyA, arbiter} = coordinationFixture()
    const store = emptyStore()
    importVerifiedContractPacket(store, packet)
    const dispute = signOutcomeStatement(packet, 'dispute', partyA.secretHex)
    importVerifiedContractMessage(store, dispute)
    const first = signArbiterDecision(packet, 'award_party_a', outputHashOf(randomSecretHex()), 'service_failure', arbiter.secretHex)
    const second = signArbiterDecision(packet, 'award_party_b', outputHashOf(randomSecretHex()), 'service_failure', arbiter.secretHex)
    importVerifiedContractMessage(store, first)
    importVerifiedContractMessage(store, second)
    const decisions = store.contracts[packet.offer.event.id]!.decisions
    expect(decisions).toHaveLength(2)
    expect(evaluateResolutionEvidence(packet, [dispute.encoded], decisions, first.event.created_at + 10_000)).toMatchObject({
      state: 'disputed',
      reason: 'The arbiter signed conflicting decisions. Refuse settlement.'
    })
  })

  it('refuses conflicting settlement notices for the same source bond', () => {
    const {packet, arbiter} = coordinationFixture()
    const store = emptyStore()
    importVerifiedContractPacket(store, packet)
    const notice = (beneficiary: 'party_a' | 'party_b') => signSettlementNotice(packet, {
      sourceRole: 'party_a',
      beneficiary,
      outputHash: packet.acceptances[beneficiary].payoutHashes.party_a,
      amountMsat: Number(packet.bondRequests.party_a.intent.amount) * 1000,
      mutationOutcome: 'confirmed'
    }, arbiter.secretHex)
    importVerifiedContractMessage(store, notice('party_a'))
    expect(() => importVerifiedContractMessage(store, notice('party_b'))).toThrow('Conflicting arbiter settlement notices')
  })

  it('migrates an earlier single decision slot without losing evidence', () => {
    const {offer, packet, arbiter} = coordinationFixture()
    const decision = signArbiterDecision(packet, 'refund_both', outputHashOf(randomSecretHex()), 'other', arbiter.secretHex)
    const store = emptyStore()
    ;(store.contracts as Record<string, unknown>)[offer.event.id] = {
      offer: offer.encoded,
      acceptances: {},
      fundingAcks: {},
      outcomes: [],
      decision: decision.encoded,
      settlementNotices: [],
      payoutAcks: []
    }
    expect(normaliseStoredContract(store, offer.event.id, offer.encoded).decisions).toEqual([decision.encoded])
  })
})

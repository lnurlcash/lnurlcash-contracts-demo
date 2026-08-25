import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  applyPayoutAcknowledgement,
  contractActivationState,
  disputeTerminalAt,
  hasTerminalRefund,
  evaluateResolutionEvidence,
  resolveHeldCommitments
} from './bonds'
import {
  decodeContractPacket,
  encodeContractPacket,
  signAcceptance,
  signArbiterDecision,
  signContractOffer,
  signFundingAcknowledgement,
  signOutcomeStatement,
  signPayoutAcknowledgement,
  signSettlementNotice
} from './coordination'
import {CONTRACT_TEMPLATES, type ContractTemplate, type ContractTerms, type PartyRole} from './contract-types'
import {createIdentity, outputHashOf, randomId, randomSecretHex, signRequest, type CommitmentIntent} from './protocol'
import type {DemoStore, StoredRequest} from './store'

const mint = {
  host: 'mint.forgesworn.dev',
  withdrawLink: 'https://mint.forgesworn.dev/w',
  mintPubkey: '03bcd4846649e7b7d27e044ed7305547a5cf0209bd9629aa1de67f47d0c41b4407'
}

const emptyStore = (): DemoStore => ({identities: {}, enrolments: {}, requests: {}, contracts: {}, payoutTargets: {}, settlements: [], resolutions: {}})

const fixture = (options: {fundedA?: boolean; fundedB?: boolean; expires?: number; template?: ContractTemplate} = {}) => {
  const partyA = createIdentity()
  const partyB = createIdentity()
  const arbiter = createIdentity()
  const now = Math.floor(Date.now() / 1000)
  const terms: ContractTerms = {
    v: 1,
    contractId: randomId(),
    template: options.template ?? 'work',
    title: 'Review one pull request',
    memo: '',
    labels: {party_a: 'Client', party_b: 'Reviewer', arbiter: 'Project arbiter'},
    participants: {party_a: partyA.pubkey, party_b: partyB.pubkey, arbiter: arbiter.pubkey},
    bonds: {party_a: '10', party_b: '15'},
    mint,
    setupExpires: options.expires ?? now + 600,
    serviceStarts: now + 3600,
    settlementExpires: now + 86_400,
    policy: {id: 'bilateral-arbiter-v2', version: 2, challengeSeconds: 60}
  }
  const offer = signContractOffer(terms, arbiter.secretHex)
  const payoutSecrets = {
    party_a: {party_a: randomSecretHex(), party_b: randomSecretHex()},
    party_b: {party_a: randomSecretHex(), party_b: randomSecretHex()}
  }
  const acceptances = {
    party_a: signAcceptance(offer, 'party_a', {
      party_a: outputHashOf(payoutSecrets.party_a.party_a), party_b: outputHashOf(payoutSecrets.party_a.party_b)
    }, partyA.secretHex),
    party_b: signAcceptance(offer, 'party_b', {
      party_a: outputHashOf(payoutSecrets.party_b.party_a), party_b: outputHashOf(payoutSecrets.party_b.party_b)
    }, partyB.secretHex)
  }
  const receiverSecrets = {party_a: randomSecretHex(), party_b: randomSecretHex()}
  const request = (role: PartyRole) => {
    const intent: CommitmentIntent = {
      v: 2, contractId: terms.contractId, revision: 1, purpose: 'commitment', receiverRole: 'arbiter',
      payerRole: role, offerId: offer.event.id, participants: terms.participants, amount: terms.bonds[role], currency: 'sat',
      mint, outputHash: outputHashOf(receiverSecrets[role]), expires: terms.setupExpires, memo: `${terms.labels[role]} commitment`
    }
    return signRequest(intent, arbiter.secretHex)
  }
  const bondRequests = {party_a: request('party_a'), party_b: request('party_b')}
  const packet = decodeContractPacket(encodeContractPacket({offer, acceptances, bondRequests}))
  const store = emptyStore()
  const addRequest = (role: PartyRole, funded: boolean): void => {
    const signed = packet.bondRequests[role]
    const record: StoredRequest = {encoded: signed.encoded, intent: signed.intent, receiverSecretHex: receiverSecrets[role]}
    if (funded) record.received = {
      noteUrl: `${mint.withdrawLink}?k1=${receiverSecrets[role]}&amount=${Number(signed.intent.amount) * 1000}`,
      amountMsat: Number(signed.intent.amount) * 1000,
      callback: `${mint.withdrawLink}/cb`,
      signatureVerified: null,
      mintPubkey: mint.mintPubkey
    }
    store.requests[signed.event.id] = record
  }
  addRequest('party_a', options.fundedA ?? true)
  addRequest('party_b', options.fundedB ?? true)
  store.contracts[offer.event.id] = {
    offer: offer.encoded,
    acceptances: {party_a: acceptances.party_a.encoded, party_b: acceptances.party_b.encoded},
    packet: packet.encoded,
    fundingAcks: {},
    outcomes: [],
    decisions: [],
    settlementNotices: [],
    payoutAcks: []
  }
  store.contracts[offer.event.id]!.fundingAcks.party_a = signFundingAcknowledgement(packet, 'party_a', partyA.secretHex).encoded
  store.contracts[offer.event.id]!.fundingAcks.party_b = signFundingAcknowledgement(packet, 'party_b', partyB.secretHex).encoded
  return {store, packet, partyA, partyB, arbiter, payoutSecrets, receiverSecrets}
}

const confirmedRedirect = async (held: NonNullable<StoredRequest['received']>, _secret: string, outputHash: string) => ({
  amountMsat: held.amountMsat,
  mintHost: mint.host,
  outputHash,
  outcome: 'confirmed' as const,
  createdAt: Date.now()
})

describe('generic activation and authority', () => {
  afterEach(() => vi.useRealTimers())

  it('activates only when both mint outputs and both named-payer acknowledgements exist', () => {
    const {store, packet} = fixture()
    expect(contractActivationState(store, packet).active).toBe(true)
    delete store.contracts[packet.offer.event.id]!.fundingAcks.party_b
    expect(contractActivationState(store, packet)).toMatchObject({active: false, acknowledged: {party_a: true, party_b: false}})
  })

  it('requires matching completion statements but lets a party self-cancel unilaterally', () => {
    const {packet, partyA, partyB} = fixture()
    const aComplete = signOutcomeStatement(packet, 'complete', partyA.secretHex)
    expect(evaluateResolutionEvidence(packet, [aComplete.encoded])).toMatchObject({state: 'pending'})
    const bComplete = signOutcomeStatement(packet, 'complete', partyB.secretHex)
    expect(evaluateResolutionEvidence(packet, [aComplete.encoded, bComplete.encoded])).toMatchObject({state: 'executable', resolution: 'complete'})
    const aCancel = signOutcomeStatement(packet, 'party_a_cancel', partyA.secretHex)
    expect(evaluateResolutionEvidence(packet, [aCancel.encoded])).toMatchObject({state: 'executable', resolution: 'party_a_cancel'})
  })

  it.each(CONTRACT_TEMPLATES)('applies the same signed bilateral bond policy to the %s template', template => {
    const {packet, partyA, partyB} = fixture({template})
    expect(packet.offer.terms.template).toBe(template)
    const complete = [
      signOutcomeStatement(packet, 'complete', partyA.secretHex).encoded,
      signOutcomeStatement(packet, 'complete', partyB.secretHex).encoded
    ]
    expect(evaluateResolutionEvidence(packet, complete)).toMatchObject({state: 'executable', resolution: 'complete'})
    expect(evaluateResolutionEvidence(packet, [signOutcomeStatement(packet, 'party_b_cancel', partyB.secretHex).encoded])).toMatchObject({
      state: 'executable', resolution: 'party_b_cancel'
    })
  })

  it('freezes disputes and enforces the signed challenge period before a decision', () => {
    const {packet, partyA, arbiter} = fixture()
    const dispute = signOutcomeStatement(packet, 'dispute', partyA.secretHex)
    const decision = signArbiterDecision(packet, 'award_party_a', outputHashOf('aa'.repeat(32)), 'service_failure', arbiter.secretHex)
    expect(evaluateResolutionEvidence(packet, [dispute.encoded], decision.encoded, decision.event.created_at + 59)).toMatchObject({state: 'disputed'})
    expect(evaluateResolutionEvidence(packet, [dispute.encoded], decision.encoded, decision.event.created_at + 60)).toMatchObject({state: 'executable', resolution: 'award_party_a'})
    expect(() => evaluateResolutionEvidence(packet, [], decision.encoded, decision.event.created_at + 60)).toThrow('neither party raised')
  })

  it('does not let matching completion signatures suppress an imported dispute', () => {
    const {packet, partyA, partyB} = fixture()
    const outcomes = [
      signOutcomeStatement(packet, 'complete', partyA.secretHex).encoded,
      signOutcomeStatement(packet, 'complete', partyB.secretHex).encoded,
      signOutcomeStatement(packet, 'dispute', partyA.secretHex).encoded
    ]
    expect(evaluateResolutionEvidence(packet, outcomes)).toMatchObject({state: 'disputed', reason: 'A participant raised a dispute.'})
  })

  it('refuses an arbiter decision signed before the dispute existed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T10:00:00Z'))
    const {packet, partyA, arbiter} = fixture()
    const decision = signArbiterDecision(packet, 'award_party_a', outputHashOf('aa'.repeat(32)), 'service_failure', arbiter.secretHex)
    vi.setSystemTime(new Date('2026-08-23T10:00:02Z'))
    const dispute = signOutcomeStatement(packet, 'dispute', partyA.secretHex)
    expect(() => evaluateResolutionEvidence(packet, [dispute.encoded], decision.encoded, decision.event.created_at + 1_000)).toThrow('predates the dispute')
  })

  it('fails closed when both parties submit contradictory self-cancellations', () => {
    const {packet, partyA, partyB} = fixture()
    const a = signOutcomeStatement(packet, 'party_a_cancel', partyA.secretHex)
    const b = signOutcomeStatement(packet, 'party_b_cancel', partyB.secretHex)
    expect(evaluateResolutionEvidence(packet, [a.encoded, b.encoded])).toMatchObject({state: 'disputed', reason: 'Contradictory self-cancellations require an arbiter decision.'})
  })
})

describe('beneficiary-owned settlement', () => {
  it('refuses to move value from an arbitrary UI-selected resolution', async () => {
    const {store, packet} = fixture()
    await expect(resolveHeldCommitments(store, packet, {kind: 'messages', outcomes: []}, {persist: () => undefined, redirect: confirmedRedirect})).rejects.toThrow('No executable outcome')
    expect(store.settlements).toHaveLength(0)
  })

  it('redirects both inputs to distinct targets signed by the winner without learning either secret', async () => {
    const {store, packet, partyA, payoutSecrets} = fixture()
    const cancel = signOutcomeStatement(packet, 'party_a_cancel', partyA.secretHex)
    const seen: string[] = []
    await resolveHeldCommitments(store, packet, {kind: 'messages', outcomes: [cancel.encoded]}, {
      persist: () => undefined,
      redirect: async (held, secret, outputHash) => {
        expect(Object.values(payoutSecrets.party_b)).not.toContain(secret)
        seen.push(outputHash)
        return confirmedRedirect(held, secret, outputHash)
      }
    })
    expect(seen).toEqual([
      packet.acceptances.party_b.payoutHashes.party_a,
      packet.acceptances.party_b.payoutHashes.party_b
    ])
    expect(new Set(seen).size).toBe(2)
    expect(store.settlements.every(item => item.beneficiary === 'party_b' && item.state === 'confirmed')).toBe(true)
  })

  it('refunds one funded side only after setup expiry', async () => {
    const now = Math.floor(Date.now() / 1000)
    const {store, packet} = fixture({fundedA: true, fundedB: false, expires: now + 120})
    await expect(resolveHeldCommitments(store, packet, {kind: 'setup_timeout'}, {persist: () => undefined, redirect: confirmedRedirect, nowSeconds: now + 119})).rejects.toThrow('deadline')
    await resolveHeldCommitments(store, packet, {kind: 'setup_timeout'}, {persist: () => undefined, redirect: confirmedRedirect, nowSeconds: now + 121})
    expect(store.settlements).toHaveLength(1)
    expect(store.settlements[0]).toMatchObject({beneficiary: 'party_a', outputHash: packet.acceptances.party_a.payoutHashes.party_a})
  })

  it('refunds both donated outputs after setup expiry when a named payer never acknowledged activation', async () => {
    const {store, packet} = fixture()
    delete store.contracts[packet.offer.event.id]!.fundingAcks.party_b
    await resolveHeldCommitments(store, packet, {kind: 'setup_timeout'}, {
      persist: () => undefined, redirect: confirmedRedirect, nowSeconds: packet.offer.terms.setupExpires + 1
    })
    expect(store.settlements.map(item => item.beneficiary)).toEqual(['party_a', 'party_b'])
  })

  it('fails closed when local storage swaps an arbiter receiver secret', () => {
    const {store, packet} = fixture()
    store.requests[packet.bondRequests.party_a.event.id]!.receiverSecretHex = randomSecretHex()
    expect(() => contractActivationState(store, packet)).toThrow('arbiter secret')
  })

  it('journals an ambiguous mutation and refuses any automatic retry or target change', async () => {
    const {store, packet, partyA, partyB, arbiter} = fixture()
    const cancel = signOutcomeStatement(packet, 'party_a_cancel', partyA.secretHex)
    let calls = 0
    await expect(resolveHeldCommitments(store, packet, {kind: 'messages', outcomes: [cancel.encoded]}, {
      persist: () => undefined,
      redirect: async (held, _secret, outputHash) => {
        calls += 1
        return {amountMsat: held.amountMsat, mintHost: mint.host, outputHash, outcome: 'beneficiary_must_probe', createdAt: Date.now()}
      }
    })).rejects.toThrow('beneficiary must probe')
    const journal = store.settlements[0]!
    expect(journal).toMatchObject({state: 'ambiguous', outputHash: packet.acceptances.party_b.payoutHashes.party_a})
    await expect(resolveHeldCommitments(store, packet, {kind: 'messages', outcomes: [cancel.encoded]}, {
      persist: () => undefined, redirect: confirmedRedirect
    })).rejects.toThrow('must probe')
    expect(calls).toBe(1)
    const notice = signSettlementNotice(packet, {
      sourceRole: 'party_a', beneficiary: 'party_b', outputHash: journal.outputHash,
      amountMsat: journal.receipt!.amountMsat, mutationOutcome: journal.receipt!.outcome
    }, arbiter.secretHex)
    const payoutAck = signPayoutAcknowledgement(notice, packet, partyB.secretHex)
    applyPayoutAcknowledgement(store, packet, notice, payoutAck, () => undefined)
    await resolveHeldCommitments(store, packet, {kind: 'messages', outcomes: [cancel.encoded]}, {
      persist: () => undefined, redirect: confirmedRedirect
    })
    expect(store.settlements).toHaveLength(2)
    expect(store.settlements.every(item => item.state === 'confirmed')).toBe(true)
  })

  it('refunds a fully active but unresolved contract after its settlement window without assigning guilt', async () => {
    const {store, packet} = fixture()
    const after = packet.offer.terms.settlementExpires + 1
    await expect(resolveHeldCommitments(store, packet, {kind: 'contract_timeout', outcomes: []}, {
      persist: () => undefined, redirect: confirmedRedirect, nowSeconds: packet.offer.terms.settlementExpires - 1
    })).rejects.toThrow('deadline')
    await resolveHeldCommitments(store, packet, {kind: 'contract_timeout', outcomes: []}, {
      persist: () => undefined, redirect: confirmedRedirect, nowSeconds: after
    })
    expect(store.settlements.map(item => item.beneficiary)).toEqual(['party_a', 'party_b'])
  })

  it('does not let contract timeout erase a dispute', async () => {
    const {store, packet, partyA} = fixture()
    const dispute = signOutcomeStatement(packet, 'dispute', partyA.secretHex)
    await expect(resolveHeldCommitments(store, packet, {kind: 'contract_timeout', outcomes: [dispute.encoded]}, {
      persist: () => undefined, redirect: confirmedRedirect, nowSeconds: packet.offer.terms.settlementExpires + 1
    })).rejects.toThrow('still requires attributable resolution')
    expect(store.settlements).toHaveLength(0)
  })

  it('lets an arbiter decision resolve contradictory self-cancellations', () => {
    const {packet, partyA, partyB, arbiter} = fixture()
    const a = signOutcomeStatement(packet, 'party_a_cancel', partyA.secretHex)
    const b = signOutcomeStatement(packet, 'party_b_cancel', partyB.secretHex)
    const decision = signArbiterDecision(packet, 'refund_both', outputHashOf(randomSecretHex()), 'other', arbiter.secretHex)
    const outcomes = [a.encoded, b.encoded]
    expect(evaluateResolutionEvidence(packet, outcomes)).toMatchObject({state: 'disputed', reason: 'Contradictory self-cancellations require an arbiter decision.'})
    expect(evaluateResolutionEvidence(packet, outcomes, decision.encoded, decision.event.created_at + 59)).toMatchObject({state: 'disputed'})
    expect(evaluateResolutionEvidence(packet, outcomes, decision.encoded, decision.event.created_at + 60))
      .toMatchObject({state: 'executable', resolution: 'refund_both'})
  })

  it('lets both parties agree their way out of contradictory self-cancellations', () => {
    const {packet, partyA, partyB} = fixture()
    const a = signOutcomeStatement(packet, 'party_a_cancel', partyA.secretHex)
    const b = signOutcomeStatement(packet, 'party_b_cancel', partyB.secretHex)
    const cancelA = signOutcomeStatement(packet, 'mutual_cancel', partyA.secretHex)
    const cancelB = signOutcomeStatement(packet, 'mutual_cancel', partyB.secretHex)
    expect(evaluateResolutionEvidence(packet, [a.encoded, b.encoded, cancelA.encoded, cancelB.encoded]))
      .toMatchObject({state: 'executable', resolution: 'mutual_cancel'})
  })

  it('refunds a dispute no-fault once the challenge period can no longer produce a decision', async () => {
    const {store, packet, partyA} = fixture()
    const dispute = signOutcomeStatement(packet, 'dispute', partyA.secretHex)
    const terminal = disputeTerminalAt(packet)
    expect(terminal).toBe(packet.offer.terms.settlementExpires + packet.offer.terms.policy.challengeSeconds)
    await expect(resolveHeldCommitments(store, packet, {kind: 'contract_timeout', outcomes: [dispute.encoded]}, {
      persist: () => undefined, redirect: confirmedRedirect, nowSeconds: terminal - 1
    })).rejects.toThrow('still requires attributable resolution')
    await resolveHeldCommitments(store, packet, {kind: 'contract_timeout', outcomes: [dispute.encoded]}, {
      persist: () => undefined, redirect: confirmedRedirect, nowSeconds: terminal
    })
    expect(store.settlements.map(item => item.beneficiary)).toEqual(['party_a', 'party_b'])
  })

  it('never lets the terminal refund override an executable decision', async () => {
    const {store, packet, partyA, arbiter} = fixture()
    const dispute = signOutcomeStatement(packet, 'dispute', partyA.secretHex)
    const decision = signArbiterDecision(packet, 'award_party_a', outputHashOf(randomSecretHex()), 'no_show', arbiter.secretHex)
    await expect(resolveHeldCommitments(store, packet, {kind: 'contract_timeout', outcomes: [dispute.encoded], decisions: [decision.encoded]}, {
      persist: () => undefined, redirect: confirmedRedirect, nowSeconds: disputeTerminalAt(packet)
    })).rejects.toThrow('Executable signed authority exists')
    expect(store.settlements).toHaveLength(0)
  })

  it('does not extend the terminal refund to a contract accepted under v1', async () => {
    const {store, packet, partyA} = fixture()
    const dispute = signOutcomeStatement(packet, 'dispute', partyA.secretHex)
    expect(hasTerminalRefund(packet)).toBe(true)
    // A v1 contract never agreed a terminal refund. Refunding both would leave a
    // party who should have been awarded both bonds materially worse off.
    const legacy = {...packet, offer: {...packet.offer, terms: {...packet.offer.terms, policy: {id: 'bilateral-arbiter-v1', version: 1, challengeSeconds: 60} as const}}}
    expect(hasTerminalRefund(legacy)).toBe(false)
    await expect(resolveHeldCommitments(store, legacy, {kind: 'contract_timeout', outcomes: [dispute.encoded]}, {
      persist: () => undefined, redirect: confirmedRedirect, nowSeconds: disputeTerminalAt(legacy) + 10_000
    })).rejects.toThrow('no terminal refund')
    expect(store.settlements).toHaveLength(0)
  })

  it('resolves only requests from the selected signed packet', async () => {
    const first = fixture()
    const second = fixture()
    first.store.requests = {...first.store.requests, ...second.store.requests}
    first.store.contracts = {...first.store.contracts, ...second.store.contracts}
    const completionA = signOutcomeStatement(first.packet, 'complete', first.partyA.secretHex)
    const completionB = signOutcomeStatement(first.packet, 'complete', first.partyB.secretHex)
    await resolveHeldCommitments(first.store, first.packet, {kind: 'messages', outcomes: [completionA.encoded, completionB.encoded]}, {persist: () => undefined, redirect: confirmedRedirect})
    expect(first.store.requests[second.packet.bondRequests.party_a.event.id]!.received).toBeDefined()
    expect(first.store.requests[second.packet.bondRequests.party_b.event.id]!.received).toBeDefined()
  })
})

import {describe, expect, it} from 'vitest'
import {finalizeEvent} from 'nostr-tools'
import {
  CONTRACT_OFFER_KIND,
  MESSAGE_PREFIX,
  assertAcceptance,
  assertArbiterDecision,
  assertFundingAcknowledgement,
  assertOutcomeStatement,
  assertPayoutAcknowledgement,
  assertSettlementNotice,
  decisionExecutableAt,
  decodeContractMessage,
  decodeContractPacket,
  encodeContractPacket,
  signAcceptance,
  signArbiterDecision,
  signContractOffer,
  signEnrolment,
  signFundingAcknowledgement,
  signOutcomeStatement,
  signPayoutAcknowledgement,
  signSettlementNotice,
  type ContractPacket
} from './coordination'
import {createIdentity, outputHashOf, randomId, randomSecretHex, signRequest, type CommitmentIntent} from './protocol'
import {hexToBytes} from '@noble/hashes/utils.js'
import type {BilateralPolicy, ContractTerms, PartyRole} from './contract-types'

const mint = {
  host: 'mint.forgesworn.dev',
  withdrawLink: 'https://mint.forgesworn.dev/w',
  mintPubkey: '03bcd4846649e7b7d27e044ed7305547a5cf0209bd9629aa1de67f47d0c41b4407'
}

const fixture = () => {
  const partyA = createIdentity()
  const partyB = createIdentity()
  const arbiter = createIdentity()
  const now = Math.floor(Date.now() / 1000)
  const terms: ContractTerms = {
    v: 1,
    contractId: randomId(),
    template: 'delivery',
    title: 'Deliver one parcel',
    memo: 'Collection and delivery agreed off-protocol.',
    labels: {party_a: 'Customer', party_b: 'Courier', arbiter: 'Dispatch arbiter'},
    participants: {party_a: partyA.pubkey, party_b: partyB.pubkey, arbiter: arbiter.pubkey},
    bonds: {party_a: '11', party_b: '17'},
    mint,
    setupExpires: now + 600,
    serviceStarts: now + 3600,
    settlementExpires: now + 86_400,
    policy: {id: 'bilateral-arbiter-v2', version: 2, challengeSeconds: 300}
  }
  const offer = signContractOffer(terms, arbiter.secretHex)
  const secrets = {
    party_a: {party_a: randomSecretHex(), party_b: randomSecretHex()},
    party_b: {party_a: randomSecretHex(), party_b: randomSecretHex()}
  }
  const acceptance = (role: PartyRole) => signAcceptance(offer, role, {
    party_a: outputHashOf(secrets[role].party_a),
    party_b: outputHashOf(secrets[role].party_b)
  }, role === 'party_a' ? partyA.secretHex : partyB.secretHex)
  const acceptances = {party_a: acceptance('party_a'), party_b: acceptance('party_b')}
  const request = (role: PartyRole) => {
    const receiverSecret = randomSecretHex()
    const intent: CommitmentIntent = {
      v: 2,
      contractId: terms.contractId,
      revision: 1,
      purpose: 'commitment',
      receiverRole: 'arbiter',
      payerRole: role,
      offerId: offer.event.id,
      participants: terms.participants,
      amount: terms.bonds[role],
      currency: 'sat',
      mint,
      outputHash: outputHashOf(receiverSecret),
      expires: terms.setupExpires,
      memo: `${terms.labels[role]} commitment`
    }
    return signRequest(intent, arbiter.secretHex)
  }
  const bondRequests = {party_a: request('party_a'), party_b: request('party_b')}
  const encoded = encodeContractPacket({offer, acceptances, bondRequests})
  const packet = decodeContractPacket(encoded)
  return {partyA, partyB, arbiter, offer, acceptances, bondRequests, encoded, packet, secrets}
}

// A superseded offer can only be produced by signing it the way an older build
// did, so build the event directly rather than through signContractOffer.
const signOfferWithPolicy = (policy: BilateralPolicy, arbiterSecretHex: string, arbiterPubkey: string): string => {
  const now = Math.floor(Date.now() / 1000)
  const terms: ContractTerms = {
    v: 1,
    contractId: randomId(),
    template: 'delivery',
    title: 'Deliver one parcel',
    memo: '',
    labels: {party_a: 'Customer', party_b: 'Courier', arbiter: 'Dispatch arbiter'},
    participants: {party_a: createIdentity().pubkey, party_b: createIdentity().pubkey, arbiter: arbiterPubkey},
    bonds: {party_a: '11', party_b: '17'},
    mint,
    setupExpires: now + 600,
    serviceStarts: now + 3600,
    settlementExpires: now + 86_400,
    policy
  }
  const event = finalizeEvent({
    kind: CONTRACT_OFFER_KIND,
    created_at: now,
    tags: [
      ['d', terms.contractId],
      ['t', 'cash-contract-offer'],
      ['policy', terms.policy.id, String(terms.policy.version)],
      ['template', terms.template],
      ['p', terms.participants.party_a, 'party_a'],
      ['p', terms.participants.party_b, 'party_b'],
      ['p', terms.participants.arbiter, 'arbiter'],
      ['amount', terms.bonds.party_a, 'sat', 'party_a'],
      ['amount', terms.bonds.party_b, 'sat', 'party_b'],
      ['mint', terms.mint.host]
    ],
    content: JSON.stringify(terms)
  }, hexToBytes(arbiterSecretHex))
  return MESSAGE_PREFIX + btoa(JSON.stringify(event)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

describe('superseded policy handling', () => {
  it('still decodes a v1 offer so an in-flight contract can be resolved', () => {
    const arbiter = createIdentity()
    const encoded = signOfferWithPolicy({id: 'bilateral-arbiter-v1', version: 1, challengeSeconds: 300}, arbiter.secretHex, arbiter.pubkey)
    const decoded = decodeContractMessage(encoded)
    expect(decoded.type).toBe('contract_offer')
    if (decoded.type !== 'contract_offer') throw new Error('unreachable')
    expect(decoded.terms.policy).toEqual({id: 'bilateral-arbiter-v1', version: 1, challengeSeconds: 300})
  })

  it('refuses to issue any new offer under a superseded policy', () => {
    const partyA = createIdentity()
    const partyB = createIdentity()
    const arbiter = createIdentity()
    const now = Math.floor(Date.now() / 1000)
    const terms: ContractTerms = {
      v: 1,
      contractId: randomId(),
      template: 'delivery',
      title: 'Deliver one parcel',
      memo: '',
      labels: {party_a: 'Customer', party_b: 'Courier', arbiter: 'Dispatch arbiter'},
      participants: {party_a: partyA.pubkey, party_b: partyB.pubkey, arbiter: arbiter.pubkey},
      bonds: {party_a: '11', party_b: '17'},
      mint,
      setupExpires: now + 600,
      serviceStarts: now + 3600,
      settlementExpires: now + 86_400,
      policy: {id: 'bilateral-arbiter-v1', version: 1, challengeSeconds: 300}
    }
    expect(() => signContractOffer(terms, arbiter.secretHex)).toThrow('must use bilateral-arbiter-v2')
  })

  it('refuses an offer whose policy id and version disagree', () => {
    const arbiter = createIdentity()
    const encoded = signOfferWithPolicy({id: 'bilateral-arbiter-v1', version: 2, challengeSeconds: 300} as unknown as BilateralPolicy, arbiter.secretHex, arbiter.pubkey)
    expect(() => decodeContractMessage(encoded)).toThrow('policy id and version disagree')
  })
})

describe('portable bilateral coordination', () => {
  it('uses signed neutral-role enrolments rather than trusting pasted public keys', () => {
    const party = createIdentity()
    const enrolment = signEnrolment('party_a', party.secretHex)
    expect(decodeContractMessage(enrolment.encoded)).toMatchObject({type: 'enrolment', role: 'party_a'})
    expect(enrolment.event.pubkey).toBe(party.pubkey)
  })

  it('binds a canonical offer to its named arbiter and rejects another signer', () => {
    const {offer} = fixture()
    expect(decodeContractMessage(offer.encoded)).toMatchObject({type: 'contract_offer', terms: offer.terms})
    expect(() => signContractOffer(offer.terms, createIdentity().secretHex)).toThrow('named arbiter')
  })

  it('requires independent acceptances and two unique payout targets per party', () => {
    const {offer, partyA, acceptances} = fixture()
    assertAcceptance(acceptances.party_a, offer)
    expect(() => signAcceptance(offer, 'party_a', {
      party_a: '11'.repeat(32),
      party_b: '11'.repeat(32)
    }, partyA.secretHex)).toThrow('different payout target')
    expect(() => signAcceptance(offer, 'party_a', {
      party_a: '11'.repeat(32),
      party_b: '22'.repeat(32)
    }, createIdentity().secretHex)).toThrow('not the contract')
  })

  it('revalidates every signed component after packet transport', () => {
    const {encoded, packet} = fixture()
    expect(packet.encoded).toBe(encoded)
    expect(packet.offer.terms.template).toBe('delivery')
    expect(packet.bondRequests.party_a.intent).toMatchObject({purpose: 'commitment', payerRole: 'party_a'})
    const last = encoded.at(-1)!
    expect(() => decodeContractPacket(`${encoded.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`)).toThrow()
  })

  it('binds a payer acknowledgement to its exact role, request and bond set', () => {
    const {packet, partyA} = fixture()
    const ack = signFundingAcknowledgement(packet, 'party_a', partyA.secretHex)
    assertFundingAcknowledgement(ack, packet)
    expect(() => assertFundingAcknowledgement({...ack, bondRequestId: 'ff'.repeat(32)}, packet)).toThrow('another contract packet')
    expect(() => signFundingAcknowledgement(packet, 'party_a', createIdentity().secretHex)).toThrow('Only party a')
  })

  it('accepts portable self-cancellation only from the self-cancelling party', () => {
    const {packet, partyA, partyB} = fixture()
    const honest = signOutcomeStatement(packet, 'party_a_cancel', partyA.secretHex)
    expect(assertOutcomeStatement(honest, packet)).toBe('party_a')
    expect(() => signOutcomeStatement(packet, 'party_a_cancel', partyB.secretHex)).toThrow('Only Party A')
    const other = fixture().packet
    expect(() => assertOutcomeStatement(honest, other)).toThrow('another contract packet')
  })

  it('makes an arbiter decision attributable and challenge-delayed', () => {
    const {packet, arbiter} = fixture()
    const decision = signArbiterDecision(packet, 'award_party_b', outputHashOf('ab'.repeat(32)), 'no_show', arbiter.secretHex)
    assertArbiterDecision(decision, packet)
    expect(decisionExecutableAt(decision, packet.offer)).toBe(decision.event.created_at + 300)
    expect(() => signArbiterDecision(packet, 'award_party_b', 'ab', 'no_show', arbiter.secretHex)).toThrow('Evidence hash')
  })

  it('signs a settlement notice only for an already accepted per-input target', () => {
    const {packet, arbiter, partyB} = fixture()
    const notice = signSettlementNotice(packet, {
      sourceRole: 'party_a',
      beneficiary: 'party_b',
      outputHash: packet.acceptances.party_b.payoutHashes.party_a,
      amountMsat: Number(packet.bondRequests.party_a.intent.amount) * 1000,
      mutationOutcome: 'confirmed'
    }, arbiter.secretHex)
    assertSettlementNotice(notice, packet)
    const acknowledgement = signPayoutAcknowledgement(notice, packet, partyB.secretHex)
    assertPayoutAcknowledgement(acknowledgement, notice, packet)
    expect(() => signPayoutAcknowledgement(notice, packet, createIdentity().secretHex)).toThrow('named beneficiary')
    const otherNotice = signSettlementNotice(packet, {
      sourceRole: 'party_b', beneficiary: 'party_b', outputHash: packet.acceptances.party_b.payoutHashes.party_b,
      amountMsat: Number(packet.bondRequests.party_b.intent.amount) * 1000, mutationOutcome: 'confirmed'
    }, arbiter.secretHex)
    expect(() => assertPayoutAcknowledgement(acknowledgement, otherNotice, packet)).toThrow('another settlement notice')
    expect(() => signSettlementNotice(packet, {
      sourceRole: 'party_a', beneficiary: 'party_b', outputHash: 'ff'.repeat(32), amountMsat: 11_000, mutationOutcome: 'confirmed'
    }, arbiter.secretHex)).toThrow('not signed')
  })

  it('refuses oversized message and packet envelopes before decoding attacker-controlled JSON', () => {
    expect(() => decodeContractMessage(`cashmsg1${'A'.repeat(17_000)}`)).toThrow('too large')
    expect(() => decodeContractPacket(`cashpacket1${'A'.repeat(66_000)}`)).toThrow('too large')
  })
})

export type CoordinationFixture = ReturnType<typeof fixture>
export const coordinationFixture = (): CoordinationFixture => fixture()

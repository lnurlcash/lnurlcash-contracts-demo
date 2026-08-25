import {
  assertAcceptance,
  assertArbiterDecision,
  assertFundingAcknowledgement,
  assertOfferOpen,
  assertOutcomeStatement,
  assertPayoutAcknowledgement,
  assertSettlementNotice,
  decodeContractMessage,
  decodeContractPacket,
  type ContractMessage,
  type ContractPacket,
  type SignedContractOffer
} from './coordination'
import {evaluateResolutionEvidence} from './bonds'
import {PARTY_ROLES} from './contract-types'
import {outputHashOf} from './protocol'
import type {DemoStore, StoredContract} from './store'

type LegacyStoredContract = Omit<StoredContract, 'decisions'> & {
  decisions?: string[]
  decision?: string
}

export const normaliseStoredContract = (store: DemoStore, offerId: string, offerEncoded: string): StoredContract => {
  const existing = store.contracts[offerId] as LegacyStoredContract | undefined
  if (existing) {
    existing.acceptances ??= {}
    existing.fundingAcks ??= {}
    existing.outcomes ??= []
    existing.decisions ??= existing.decision ? [existing.decision] : []
    existing.settlementNotices ??= []
    existing.payoutAcks ??= []
    delete existing.decision
    return existing as StoredContract
  }
  const created: StoredContract = {
    offer: offerEncoded,
    acceptances: {},
    fundingAcks: {},
    outcomes: [],
    decisions: [],
    settlementNotices: [],
    payoutAcks: []
  }
  store.contracts[offerId] = created
  return created
}

export const assertOfferHasNoKnownFork = (store: DemoStore, offer: SignedContractOffer): void => {
  for (const record of Object.values(store.contracts)) {
    const existing = decodeContractMessage(record.offer, 0)
    if (existing.type !== 'contract_offer') throw new Error('A stored contract offer has the wrong message type.')
    if (existing.terms.contractId === offer.terms.contractId && existing.event.id !== offer.event.id) {
      throw new Error('Conflicting signed offers reuse this contract id. Refuse both until the participants compare fingerprints.')
    }
  }
}

export const assertLocalParticipantPacketContinuity = (store: DemoStore, packet: ContractPacket): void => {
  for (const role of PARTY_ROLES) {
    const local = store.identities[role]
    if (!local || local.pubkey !== packet.offer.terms.participants[role]) continue
    const target = store.payoutTargets[packet.offer.event.id]?.[role]
    if (!target?.acceptance) throw new Error(`This browser owns ${role.replace('_', ' ')} but has no local acceptance and payout secrets for this packet.`)
    const localAcceptance = decodeContractMessage(target.acceptance, 0)
    if (localAcceptance.type !== 'acceptance' || localAcceptance.role !== role) throw new Error('The local participant acceptance is malformed.')
    if (localAcceptance.event.id !== packet.acceptances[role].event.id) {
      throw new Error(`The packet substitutes another valid ${role.replace('_', ' ')} acceptance. Do not fund it.`)
    }
    for (const sourceRole of PARTY_ROLES) {
      const expected = packet.acceptances[role].payoutHashes[sourceRole]
      if (target.outputHashes[sourceRole] !== expected || outputHashOf(target.secrets[sourceRole]) !== expected) {
        throw new Error(`The packet's ${role.replace('_', ' ')} payout target does not match this browser's private secret.`)
      }
    }
  }
}

export const importVerifiedContractMessage = (store: DemoStore, message: ContractMessage): void => {
  if (message.type === 'enrolment') throw new Error('Use an enrolment in the arbiter offer form; it does not accept a contract by itself.')
  if (message.type === 'contract_offer') {
    assertOfferOpen(message)
    assertOfferHasNoKnownFork(store, message)
    normaliseStoredContract(store, message.event.id, message.encoded)
    return
  }
  const record = store.contracts[message.offerId]
  if (!record) throw new Error('Import the referenced contract offer or packet first.')
  normaliseStoredContract(store, message.offerId, record.offer)
  const offerMessage = decodeContractMessage(record.offer, 0)
  if (offerMessage.type !== 'contract_offer') throw new Error('Stored offer is malformed.')
  const packet = record.packet ? decodeContractPacket(record.packet, 0) : undefined
  if (message.type === 'acceptance') {
    assertAcceptance(message, offerMessage)
    const existing = record.acceptances[message.role]
    if (existing && decodeContractMessage(existing, 0).event.id !== message.event.id) {
      throw new Error(`Conflicting signed ${message.role.replace('_', ' ')} acceptances were received for one offer.`)
    }
    record.acceptances[message.role] = message.encoded
    return
  }
  if (!packet) throw new Error('Import the full contract packet before funding, outcome, decision or settlement messages.')
  if (message.type === 'funding_ack') {
    assertFundingAcknowledgement(message, packet)
    record.fundingAcks[message.role] ??= message.encoded
  } else if (message.type === 'outcome') {
    assertOutcomeStatement(message, packet)
    if (!record.outcomes.some(encoded => decodeContractMessage(encoded, 0).event.id === message.event.id)) record.outcomes.push(message.encoded)
  } else if (message.type === 'arbiter_decision') {
    assertArbiterDecision(message, packet)
    if (record.decisions.some(encoded => decodeContractMessage(encoded, 0).event.id === message.event.id)) return
    if (evaluateResolutionEvidence(packet, record.outcomes, []).state !== 'disputed') {
      throw new Error('An arbiter decision cannot be imported before a signed dispute exists.')
    }
    evaluateResolutionEvidence(packet, record.outcomes, [...record.decisions, message.encoded], message.event.created_at)
    record.decisions.push(message.encoded)
  } else if (message.type === 'settlement_notice') {
    assertSettlementNotice(message, packet)
    const existing = record.settlementNotices.find(encoded => {
      const notice = decodeContractMessage(encoded, 0)
      return notice.type === 'settlement_notice' && notice.bondRequestId === message.bondRequestId
    })
    if (existing && decodeContractMessage(existing, 0).event.id !== message.event.id) {
      throw new Error('Conflicting arbiter settlement notices were received for one source bond.')
    }
    if (!existing) record.settlementNotices.push(message.encoded)
  } else {
    const noticeInput = record.settlementNotices.find(encoded => decodeContractMessage(encoded, 0).event.id === message.noticeId)
    if (!noticeInput) throw new Error('Import the referenced settlement notice before its payout acknowledgement.')
    const notice = decodeContractMessage(noticeInput, 0)
    if (notice.type !== 'settlement_notice') throw new Error('Stored settlement notice is malformed.')
    assertPayoutAcknowledgement(message, notice, packet)
    if (!record.payoutAcks.some(encoded => decodeContractMessage(encoded, 0).event.id === message.event.id)) record.payoutAcks.push(message.encoded)
  }
}

export const importVerifiedContractPacket = (store: DemoStore, packet: ContractPacket): void => {
  assertOfferHasNoKnownFork(store, packet.offer)
  const record = normaliseStoredContract(store, packet.offer.event.id, packet.offer.encoded)
  if (record.packet && record.packet !== packet.encoded) throw new Error('A different signed bond packet is already canonical for this offer.')
  for (const role of PARTY_ROLES) {
    const existing = record.acceptances[role]
    if (existing && decodeContractMessage(existing, 0).event.id !== packet.acceptances[role].event.id) {
      throw new Error(`The packet conflicts with the stored ${role.replace('_', ' ')} acceptance.`)
    }
  }
  assertLocalParticipantPacketContinuity(store, packet)
  record.acceptances.party_a = packet.acceptances.party_a.encoded
  record.acceptances.party_b = packet.acceptances.party_b.encoded
  record.packet = packet.encoded
}

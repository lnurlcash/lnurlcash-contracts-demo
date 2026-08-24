import {hexToBytes} from '@noble/hashes/utils.js'
import {finalizeEvent, getPublicKey, verifyEvent, type Event} from 'nostr-tools'
import {
  MAX_CLOCK_SKEW_SECONDS,
  MAX_DEMO_SATS,
  MAX_REQUEST_LIFETIME_SECONDS,
  bondSetHashOf,
  decodeRequest,
  isCommitmentIntent,
  type SignedRequest
} from './protocol'
import {
  CONTRACT_TEMPLATES,
  CURRENT_POLICY_ID,
  PARTY_ROLES,
  POLICY_VERSIONS,
  isPartyRole,
  type BilateralPolicy,
  type ContractTerms,
  type PartyRole
} from './contract-types'

export const MESSAGE_PREFIX = 'cashmsg1'
export const PACKET_PREFIX = 'cashpacket1'
export const ENROLMENT_KIND = 2530
export const CONTRACT_OFFER_KIND = 2531
export const ACCEPTANCE_KIND = 2532
export const FUNDING_ACK_KIND = 2533
export const CONTRACT_OUTCOME_KIND = 2534
export const ARBITER_DECISION_KIND = 2535
export const SETTLEMENT_NOTICE_KIND = 2536
export const PAYOUT_ACK_KIND = 2537

const HEX_32 = /^[0-9a-f]{64}$/
const CONTRACT_ID = /^[0-9a-f]{32}$/
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/
const MAX_SERVICE_WINDOW_SECONDS = 30 * 24 * 60 * 60
const MAX_MESSAGE_LENGTH = 16_384
const MAX_PACKET_LENGTH = 65_536
const CHALLENGE_MIN_SECONDS = 60
const CHALLENGE_MAX_SECONDS = 7 * 24 * 60 * 60

export type SignedEnrolment = {
  type: 'enrolment'
  encoded: string
  role: PartyRole
  event: Event
}

export type SignedContractOffer = {
  type: 'contract_offer'
  encoded: string
  terms: ContractTerms
  event: Event
}

export type SignedAcceptance = {
  type: 'acceptance'
  encoded: string
  offerId: string
  contractId: string
  role: PartyRole
  payoutHashes: Record<PartyRole, string>
  event: Event
}

export type SignedFundingAcknowledgement = {
  type: 'funding_ack'
  encoded: string
  offerId: string
  contractId: string
  bondSetHash: string
  bondRequestId: string
  role: PartyRole
  event: Event
}

export const PARTICIPANT_OUTCOMES = ['complete', 'mutual_cancel', 'party_a_cancel', 'party_b_cancel', 'dispute'] as const
export type ParticipantOutcome = typeof PARTICIPANT_OUTCOMES[number]

export type SignedOutcomeStatement = {
  type: 'outcome'
  encoded: string
  offerId: string
  contractId: string
  bondSetHash: string
  outcome: ParticipantOutcome
  event: Event
}

export const DECISION_RESOLUTIONS = ['refund_both', 'award_party_a', 'award_party_b'] as const
export type DecisionResolution = typeof DECISION_RESOLUTIONS[number]
export const DECISION_REASONS = ['no_show', 'service_failure', 'safety', 'other'] as const
export type DecisionReason = typeof DECISION_REASONS[number]

export type SignedArbiterDecision = {
  type: 'arbiter_decision'
  encoded: string
  offerId: string
  contractId: string
  bondSetHash: string
  resolution: DecisionResolution
  evidenceHash: string
  reason: DecisionReason
  event: Event
}

export type SignedSettlementNotice = {
  type: 'settlement_notice'
  encoded: string
  offerId: string
  contractId: string
  bondSetHash: string
  bondRequestId: string
  sourceRole: PartyRole
  beneficiary: PartyRole
  outputHash: string
  amountMsat: number
  mutationOutcome: 'confirmed' | 'beneficiary_must_probe'
  mintSignature?: string
  event: Event
}

export type SignedPayoutAcknowledgement = {
  type: 'payout_ack'
  encoded: string
  offerId: string
  contractId: string
  bondSetHash: string
  noticeId: string
  bondRequestId: string
  sourceRole: PartyRole
  beneficiary: PartyRole
  outputHash: string
  event: Event
}

export type ContractMessage =
  | SignedEnrolment
  | SignedContractOffer
  | SignedAcceptance
  | SignedFundingAcknowledgement
  | SignedOutcomeStatement
  | SignedArbiterDecision
  | SignedSettlementNotice
  | SignedPayoutAcknowledgement

export type ContractPacket = {
  encoded: string
  offer: SignedContractOffer
  acceptances: Record<PartyRole, SignedAcceptance>
  bondRequests: Record<PartyRole, SignedRequest>
  bondSetHash: string
}

type PacketBody = {
  v: 1
  offer: string
  acceptances: Record<PartyRole, string>
  bondRequests: Record<PartyRole, string>
}

const encodeBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

const decodeBase64Url = (text: string): string => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder(undefined, {fatal: true}).decode(bytes)
}

const exactKeys = (value: Record<string, unknown>, expected: string[], name: string): void => {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${name} has missing or unknown fields.`)
  }
}

const objectOf = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is not an object.`)
  return value as Record<string, unknown>
}

const positiveInteger = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number.`)
  return value
}

const decimalSats = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be whole sats as decimal text.`)
  const sats = Number(value)
  if (!Number.isSafeInteger(sats) || sats > MAX_DEMO_SATS) throw new Error(`${name} exceeds the ${MAX_DEMO_SATS} sat public-lab cap.`)
  return value
}

const boundedText = (value: unknown, name: string, max: number, allowEmpty = false): string => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim().length === 0) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} is malformed.`)
  }
  return value
}

const validateCreatedAt = (event: Event, nowSeconds: number): void => {
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 1) throw new Error('The message creation time is invalid.')
  if (nowSeconds !== 0 && event.created_at > nowSeconds + MAX_CLOCK_SKEW_SECONDS) throw new Error('The message was signed too far in the future.')
}

const validateTerms = (value: unknown, createdAt: number): ContractTerms => {
  const raw = objectOf(value, 'Contract terms')
  exactKeys(raw, ['v', 'contractId', 'template', 'title', 'memo', 'labels', 'participants', 'bonds', 'mint', 'setupExpires', 'serviceStarts', 'settlementExpires', 'policy'], 'Contract terms')
  if (raw.v !== 1) throw new Error('Unsupported contract version.')
  if (typeof raw.contractId !== 'string' || !CONTRACT_ID.test(raw.contractId)) throw new Error('contract id must be 16 random bytes.')
  if (!CONTRACT_TEMPLATES.includes(raw.template as ContractTerms['template'])) throw new Error('Unknown contract template.')
  const labels = objectOf(raw.labels, 'Contract labels')
  exactKeys(labels, ['party_a', 'party_b', 'arbiter'], 'Contract labels')
  const participants = objectOf(raw.participants, 'Contract participants')
  exactKeys(participants, ['party_a', 'party_b', 'arbiter'], 'Contract participants')
  const participantValues = [participants.party_a, participants.party_b, participants.arbiter]
  if (participantValues.some(value => typeof value !== 'string' || !HEX_32.test(value))) throw new Error('A participant signing key is malformed.')
  if (new Set(participantValues).size !== 3) throw new Error('Party A, Party B and the arbiter must use different keys.')
  const bonds = objectOf(raw.bonds, 'Contract bonds')
  exactKeys(bonds, ['party_a', 'party_b'], 'Contract bonds')
  const mint = objectOf(raw.mint, 'Contract mint')
  exactKeys(mint, mint.mintPubkey === undefined ? ['host', 'withdrawLink'] : ['host', 'withdrawLink', 'mintPubkey'], 'Contract mint')
  if (typeof mint.host !== 'string' || mint.host.trim() === '' || typeof mint.withdrawLink !== 'string') throw new Error('Contract mint details are missing.')
  const withdraw = new URL(mint.withdrawLink)
  if (withdraw.protocol !== 'https:' && !(withdraw.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(withdraw.hostname))) throw new Error('Contract mint links must use HTTPS, except on loopback.')
  if (withdraw.host.toLowerCase() !== mint.host.toLowerCase()) throw new Error('Contract mint host and withdraw link disagree.')
  if (mint.mintPubkey !== undefined && (typeof mint.mintPubkey !== 'string' || !COMPRESSED_PUBKEY.test(mint.mintPubkey))) throw new Error('The contract mint key is malformed.')
  const setupExpires = positiveInteger(raw.setupExpires, 'setupExpires')
  const serviceStarts = positiveInteger(raw.serviceStarts, 'serviceStarts')
  const settlementExpires = positiveInteger(raw.settlementExpires, 'settlementExpires')
  if (setupExpires <= createdAt || setupExpires - createdAt > MAX_REQUEST_LIFETIME_SECONDS) throw new Error('Contract setup must close inside the 15 minute funding window.')
  if (serviceStarts < setupExpires || serviceStarts - createdAt > MAX_SERVICE_WINDOW_SECONDS) throw new Error('Service start is outside the supported contract window.')
  if (settlementExpires <= serviceStarts || settlementExpires - serviceStarts > MAX_SERVICE_WINDOW_SECONDS) throw new Error('Settlement expiry is outside the supported contract window.')
  const policy = objectOf(raw.policy, 'Contract policy')
  exactKeys(policy, ['id', 'version', 'challengeSeconds'], 'Contract policy')
  if (typeof policy.id !== 'string' || POLICY_VERSIONS[policy.id] === undefined) throw new Error('Unsupported contract policy.')
  if (policy.version !== POLICY_VERSIONS[policy.id]) throw new Error('The contract policy id and version disagree.')
  const challengeSeconds = positiveInteger(policy.challengeSeconds, 'challengeSeconds')
  if (challengeSeconds < CHALLENGE_MIN_SECONDS || challengeSeconds > CHALLENGE_MAX_SECONDS) throw new Error('Challenge period must be between one minute and seven days.')
  return {
    v: 1,
    contractId: raw.contractId,
    template: raw.template as ContractTerms['template'],
    title: boundedText(raw.title, 'Contract title', 100),
    memo: boundedText(raw.memo, 'Contract memo', 280, true),
    labels: {
      party_a: boundedText(labels.party_a, 'Party A label', 40),
      party_b: boundedText(labels.party_b, 'Party B label', 40),
      arbiter: boundedText(labels.arbiter, 'Arbiter label', 40)
    },
    participants: {
      party_a: participants.party_a as string,
      party_b: participants.party_b as string,
      arbiter: participants.arbiter as string
    },
    bonds: {
      party_a: decimalSats(bonds.party_a, 'Party A bond'),
      party_b: decimalSats(bonds.party_b, 'Party B bond')
    },
    mint: {
      host: mint.host.toLowerCase(),
      withdrawLink: withdraw.toString(),
      ...(mint.mintPubkey ? {mintPubkey: mint.mintPubkey as string} : {})
    },
    setupExpires,
    serviceStarts,
    settlementExpires,
    policy: {id: policy.id, version: policy.version, challengeSeconds} as BilateralPolicy
  }
}

const tagsForEnrolment = (role: PartyRole): string[][] => [['t', 'cash-contract-enrolment'], ['role', role]]

const tagsForOffer = (terms: ContractTerms): string[][] => [
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
]

const tagsForAcceptance = (value: Omit<SignedAcceptance, 'type' | 'encoded' | 'event'>): string[][] => [
  ['d', value.contractId], ['e', value.offerId], ['t', 'cash-contract-acceptance'], ['role', value.role],
  ['h', value.payoutHashes.party_a, 'party_a'], ['h', value.payoutHashes.party_b, 'party_b']
]

const tagsForFundingAck = (value: Omit<SignedFundingAcknowledgement, 'type' | 'encoded' | 'event'>): string[][] => [
  ['d', value.contractId], ['e', value.offerId], ['request', value.bondRequestId], ['bond_set', value.bondSetHash], ['t', 'cash-contract-funding-ack'], ['role', value.role]
]

const tagsForOutcome = (value: Omit<SignedOutcomeStatement, 'type' | 'encoded' | 'event'>): string[][] => [
  ['d', value.contractId], ['e', value.offerId], ['bond_set', value.bondSetHash], ['t', 'cash-contract-outcome'], ['outcome', value.outcome]
]

const tagsForDecision = (value: Omit<SignedArbiterDecision, 'type' | 'encoded' | 'event'>): string[][] => [
  ['d', value.contractId], ['e', value.offerId], ['bond_set', value.bondSetHash], ['t', 'cash-contract-decision'], ['resolution', value.resolution], ['evidence', value.evidenceHash], ['reason', value.reason]
]

const tagsForSettlementNotice = (value: Omit<SignedSettlementNotice, 'type' | 'encoded' | 'event'>): string[][] => [
  ['d', value.contractId], ['e', value.offerId], ['request', value.bondRequestId], ['bond_set', value.bondSetHash],
  ['t', 'cash-contract-settlement'], ['source', value.sourceRole], ['beneficiary', value.beneficiary], ['h', value.outputHash], ['amount', String(value.amountMsat), 'msat']
]

const tagsForPayoutAck = (value: Omit<SignedPayoutAcknowledgement, 'type' | 'encoded' | 'event'>): string[][] => [
  ['d', value.contractId], ['e', value.offerId], ['notice', value.noticeId], ['request', value.bondRequestId], ['bond_set', value.bondSetHash],
  ['t', 'cash-contract-payout-ack'], ['source', value.sourceRole], ['beneficiary', value.beneficiary], ['h', value.outputHash]
]

const sameTags = (actual: string[][], expected: string[][]): boolean => JSON.stringify(actual) === JSON.stringify(expected)

const signEvent = (kind: number, tags: string[][], body: object, signerSecretHex: string): {encoded: string; event: Event} => {
  const event = finalizeEvent({kind, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(body)}, hexToBytes(signerSecretHex))
  return {event, encoded: MESSAGE_PREFIX + encodeBase64Url(JSON.stringify(event))}
}

export const signEnrolment = (role: PartyRole, signerSecretHex: string): SignedEnrolment => {
  if (!isPartyRole(role)) throw new Error('Only Party A or Party B can enrol.')
  const signed = signEvent(ENROLMENT_KIND, tagsForEnrolment(role), {v: 1, role}, signerSecretHex)
  return {type: 'enrolment', role, ...signed}
}

export const signContractOffer = (termsInput: ContractTerms, arbiterSecretHex: string): SignedContractOffer => {
  const createdAt = Math.floor(Date.now() / 1000)
  const terms = validateTerms(termsInput, createdAt)
  // Superseded policies stay decodable so contracts already under way can still
  // resolve. They must never be issued again.
  if (terms.policy.id !== CURRENT_POLICY_ID) throw new Error(`New offers must use ${CURRENT_POLICY_ID}.`)
  const event = finalizeEvent({kind: CONTRACT_OFFER_KIND, created_at: createdAt, tags: tagsForOffer(terms), content: JSON.stringify(terms)}, hexToBytes(arbiterSecretHex))
  if (event.pubkey !== terms.participants.arbiter) throw new Error('Only the named arbiter may sign the contract offer.')
  return {type: 'contract_offer', terms, event, encoded: MESSAGE_PREFIX + encodeBase64Url(JSON.stringify(event))}
}

export const signAcceptance = (offer: SignedContractOffer, role: PartyRole, payoutHashes: Record<PartyRole, string>, signerSecretHex: string): SignedAcceptance => {
  if (PARTY_ROLES.some(source => !HEX_32.test(payoutHashes[source]))) throw new Error('Each beneficiary payout hash must be 32 bytes.')
  if (payoutHashes.party_a === payoutHashes.party_b) throw new Error('A participant must use a different payout target for each source bond.')
  const body = {v: 1, offerId: offer.event.id, contractId: offer.terms.contractId, role, payoutHashes}
  const unsigned = {offerId: body.offerId, contractId: body.contractId, role, payoutHashes}
  const signed = signEvent(ACCEPTANCE_KIND, tagsForAcceptance(unsigned), body, signerSecretHex)
  if (signed.event.pubkey !== offer.terms.participants[role]) throw new Error(`This key is not the contract's ${role.replace('_', ' ')}.`)
  if (signed.event.created_at > offer.terms.setupExpires) throw new Error('The setup window has closed.')
  return {type: 'acceptance', ...unsigned, ...signed}
}

export const signFundingAcknowledgement = (
  packet: ContractPacket,
  role: PartyRole,
  signerSecretHex: string
): SignedFundingAcknowledgement => {
  const request = packet.bondRequests[role]
  const body = {v: 1, offerId: packet.offer.event.id, contractId: packet.offer.terms.contractId, bondSetHash: packet.bondSetHash, bondRequestId: request.event.id, role}
  const unsigned = {...body}
  delete (unsigned as Partial<typeof body>).v
  const signed = signEvent(FUNDING_ACK_KIND, tagsForFundingAck(unsigned), body, signerSecretHex)
  if (signed.event.pubkey !== packet.offer.terms.participants[role]) throw new Error(`Only ${role.replace('_', ' ')} may acknowledge this funding request.`)
  if (signed.event.created_at > request.intent.expires) throw new Error('The bond funding request has expired.')
  return {type: 'funding_ack', ...unsigned, ...signed}
}

export const signOutcomeStatement = (
  packet: ContractPacket,
  outcome: ParticipantOutcome,
  signerSecretHex: string
): SignedOutcomeStatement => {
  if (!PARTICIPANT_OUTCOMES.includes(outcome)) throw new Error('Unknown participant outcome.')
  const signerPubkey = getPublicKey(hexToBytes(signerSecretHex))
  const role = PARTY_ROLES.find(candidate => packet.offer.terms.participants[candidate] === signerPubkey)
  if (!role) throw new Error('Only a named contract party may sign an outcome.')
  if (outcome === 'party_a_cancel' && role !== 'party_a') throw new Error('Only Party A may sign Party A self-cancellation.')
  if (outcome === 'party_b_cancel' && role !== 'party_b') throw new Error('Only Party B may sign Party B self-cancellation.')
  const body = {v: 1, offerId: packet.offer.event.id, contractId: packet.offer.terms.contractId, bondSetHash: packet.bondSetHash, outcome}
  const unsigned = {...body}
  delete (unsigned as Partial<typeof body>).v
  const signed = signEvent(CONTRACT_OUTCOME_KIND, tagsForOutcome(unsigned), body, signerSecretHex)
  if (signed.event.created_at > packet.offer.terms.settlementExpires) throw new Error('The settlement window has closed.')
  return {type: 'outcome', ...unsigned, ...signed}
}

export const signArbiterDecision = (
  packet: ContractPacket,
  resolution: DecisionResolution,
  evidenceHash: string,
  reason: DecisionReason,
  arbiterSecretHex: string
): SignedArbiterDecision => {
  if (!DECISION_RESOLUTIONS.includes(resolution)) throw new Error('Unknown arbiter resolution.')
  if (!DECISION_REASONS.includes(reason)) throw new Error('Unknown arbiter reason.')
  if (!HEX_32.test(evidenceHash)) throw new Error('Evidence hash must be 32 bytes.')
  const body = {v: 1, offerId: packet.offer.event.id, contractId: packet.offer.terms.contractId, bondSetHash: packet.bondSetHash, resolution, evidenceHash, reason}
  const unsigned = {...body}
  delete (unsigned as Partial<typeof body>).v
  const signed = signEvent(ARBITER_DECISION_KIND, tagsForDecision(unsigned), body, arbiterSecretHex)
  if (signed.event.pubkey !== packet.offer.terms.participants.arbiter) throw new Error('Only the named arbiter may sign a decision.')
  return {type: 'arbiter_decision', ...unsigned, ...signed}
}

export const signSettlementNotice = (
  packet: ContractPacket,
  args: {
    sourceRole: PartyRole
    beneficiary: PartyRole
    outputHash: string
    amountMsat: number
    mutationOutcome: 'confirmed' | 'beneficiary_must_probe'
    mintSignature?: string
  },
  arbiterSecretHex: string
): SignedSettlementNotice => {
  const request = packet.bondRequests[args.sourceRole]
  if (!HEX_32.test(args.outputHash)) throw new Error('Settlement output hash is malformed.')
  if (!Number.isSafeInteger(args.amountMsat) || args.amountMsat < 1000 || args.amountMsat !== Number(request.intent.amount) * 1000) throw new Error('Settlement amount disagrees with its source bond.')
  if (args.outputHash !== packet.acceptances[args.beneficiary].payoutHashes[args.sourceRole]) throw new Error('Settlement target was not signed by its beneficiary.')
  if (args.mintSignature !== undefined && (typeof args.mintSignature !== 'string' || args.mintSignature.length > 512)) throw new Error('Mint settlement signature is malformed.')
  const body = {
    v: 1,
    offerId: packet.offer.event.id,
    contractId: packet.offer.terms.contractId,
    bondSetHash: packet.bondSetHash,
    bondRequestId: request.event.id,
    sourceRole: args.sourceRole,
    beneficiary: args.beneficiary,
    outputHash: args.outputHash,
    amountMsat: args.amountMsat,
    mutationOutcome: args.mutationOutcome,
    ...(args.mintSignature ? {mintSignature: args.mintSignature} : {})
  }
  const unsigned = {...body}
  delete (unsigned as Partial<typeof body>).v
  const signed = signEvent(SETTLEMENT_NOTICE_KIND, tagsForSettlementNotice(unsigned), body, arbiterSecretHex)
  if (signed.event.pubkey !== packet.offer.terms.participants.arbiter) throw new Error('Only the named arbiter may sign a settlement notice.')
  return {type: 'settlement_notice', ...unsigned, ...signed}
}

export const signPayoutAcknowledgement = (
  notice: SignedSettlementNotice,
  packet: ContractPacket,
  beneficiarySecretHex: string
): SignedPayoutAcknowledgement => {
  assertSettlementNotice(notice, packet)
  const body = {
    v: 1,
    offerId: notice.offerId,
    contractId: notice.contractId,
    bondSetHash: notice.bondSetHash,
    noticeId: notice.event.id,
    bondRequestId: notice.bondRequestId,
    sourceRole: notice.sourceRole,
    beneficiary: notice.beneficiary,
    outputHash: notice.outputHash
  }
  const unsigned = {...body}
  delete (unsigned as Partial<typeof body>).v
  const signed = signEvent(PAYOUT_ACK_KIND, tagsForPayoutAck(unsigned), body, beneficiarySecretHex)
  if (signed.event.pubkey !== packet.offer.terms.participants[notice.beneficiary]) throw new Error('Only the named beneficiary may acknowledge payout receipt.')
  return {type: 'payout_ack', ...unsigned, ...signed}
}

const decodeRawEvent = (input: string, nowSeconds: number): {encoded: string; event: Event; body: Record<string, unknown>} => {
  const encoded = input.trim()
  if (!encoded.startsWith(MESSAGE_PREFIX)) throw new Error(`Contract messages begin ${MESSAGE_PREFIX}.`)
  if (encoded.length > MAX_MESSAGE_LENGTH) throw new Error('The contract message is too large.')
  const event = JSON.parse(decodeBase64Url(encoded.slice(MESSAGE_PREFIX.length))) as Event
  if (!verifyEvent(event)) throw new Error('The contract message signature does not verify.')
  validateCreatedAt(event, nowSeconds)
  return {encoded, event, body: objectOf(JSON.parse(event.content), 'Contract message body')}
}

const decodeEnrolment = (raw: ReturnType<typeof decodeRawEvent>): SignedEnrolment => {
  exactKeys(raw.body, ['v', 'role'], 'Enrolment')
  if (raw.body.v !== 1 || !isPartyRole(raw.body.role)) throw new Error('The enrolment body is malformed.')
  if (!sameTags(raw.event.tags, tagsForEnrolment(raw.body.role))) throw new Error('The enrolment tags and body disagree.')
  return {type: 'enrolment', encoded: raw.encoded, event: raw.event, role: raw.body.role}
}

const decodeOffer = (raw: ReturnType<typeof decodeRawEvent>): SignedContractOffer => {
  const terms = validateTerms(raw.body, raw.event.created_at)
  if (!sameTags(raw.event.tags, tagsForOffer(terms))) throw new Error('The contract-offer tags and body disagree.')
  if (raw.event.pubkey !== terms.participants.arbiter) throw new Error('The offer was not signed by its named arbiter.')
  return {type: 'contract_offer', encoded: raw.encoded, event: raw.event, terms}
}

const bodyReference = (body: Record<string, unknown>, name: string): {offerId: string; contractId: string; bondSetHash?: string; role?: PartyRole} => {
  if (typeof body.offerId !== 'string' || !HEX_32.test(body.offerId)) throw new Error(`${name} offer id is malformed.`)
  if (typeof body.contractId !== 'string' || !CONTRACT_ID.test(body.contractId)) throw new Error(`${name} contract id is malformed.`)
  if (body.bondSetHash !== undefined && (typeof body.bondSetHash !== 'string' || !HEX_32.test(body.bondSetHash))) throw new Error(`${name} bond set hash is malformed.`)
  if (body.role !== undefined && !isPartyRole(body.role)) throw new Error(`${name} role is malformed.`)
  return {
    offerId: body.offerId,
    contractId: body.contractId,
    ...(body.bondSetHash ? {bondSetHash: body.bondSetHash as string} : {}),
    ...(body.role ? {role: body.role as PartyRole} : {})
  }
}

const decodeAcceptance = (raw: ReturnType<typeof decodeRawEvent>): SignedAcceptance => {
  exactKeys(raw.body, ['v', 'offerId', 'contractId', 'role', 'payoutHashes'], 'Acceptance')
  const payoutHashes = objectOf(raw.body.payoutHashes, 'Acceptance payout hashes')
  exactKeys(payoutHashes, ['party_a', 'party_b'], 'Acceptance payout hashes')
  if (raw.body.v !== 1 || PARTY_ROLES.some(source => typeof payoutHashes[source] !== 'string' || !HEX_32.test(payoutHashes[source] as string))) throw new Error('The acceptance body is malformed.')
  const ref = bodyReference(raw.body, 'Acceptance')
  const value = {offerId: ref.offerId, contractId: ref.contractId, role: ref.role!, payoutHashes: {party_a: payoutHashes.party_a as string, party_b: payoutHashes.party_b as string}}
  if (!sameTags(raw.event.tags, tagsForAcceptance(value))) throw new Error('The acceptance tags and body disagree.')
  return {type: 'acceptance', encoded: raw.encoded, event: raw.event, ...value}
}

const decodeFundingAck = (raw: ReturnType<typeof decodeRawEvent>): SignedFundingAcknowledgement => {
  exactKeys(raw.body, ['v', 'offerId', 'contractId', 'bondSetHash', 'bondRequestId', 'role'], 'Funding acknowledgement')
  if (raw.body.v !== 1 || typeof raw.body.bondRequestId !== 'string' || !HEX_32.test(raw.body.bondRequestId)) throw new Error('The funding acknowledgement body is malformed.')
  const ref = bodyReference(raw.body, 'Funding acknowledgement')
  const value = {offerId: ref.offerId, contractId: ref.contractId, bondSetHash: ref.bondSetHash!, bondRequestId: raw.body.bondRequestId, role: ref.role!}
  if (!sameTags(raw.event.tags, tagsForFundingAck(value))) throw new Error('The funding acknowledgement tags and body disagree.')
  return {type: 'funding_ack', encoded: raw.encoded, event: raw.event, ...value}
}

const decodeOutcome = (raw: ReturnType<typeof decodeRawEvent>): SignedOutcomeStatement => {
  exactKeys(raw.body, ['v', 'offerId', 'contractId', 'bondSetHash', 'outcome'], 'Outcome statement')
  if (raw.body.v !== 1 || !PARTICIPANT_OUTCOMES.includes(raw.body.outcome as ParticipantOutcome)) throw new Error('The outcome body is malformed.')
  const ref = bodyReference(raw.body, 'Outcome statement')
  const value = {offerId: ref.offerId, contractId: ref.contractId, bondSetHash: ref.bondSetHash!, outcome: raw.body.outcome as ParticipantOutcome}
  if (!sameTags(raw.event.tags, tagsForOutcome(value))) throw new Error('The outcome tags and body disagree.')
  return {type: 'outcome', encoded: raw.encoded, event: raw.event, ...value}
}

const decodeDecision = (raw: ReturnType<typeof decodeRawEvent>): SignedArbiterDecision => {
  exactKeys(raw.body, ['v', 'offerId', 'contractId', 'bondSetHash', 'resolution', 'evidenceHash', 'reason'], 'Arbiter decision')
  if (
    raw.body.v !== 1 ||
    !DECISION_RESOLUTIONS.includes(raw.body.resolution as DecisionResolution) ||
    !DECISION_REASONS.includes(raw.body.reason as DecisionReason) ||
    typeof raw.body.evidenceHash !== 'string' || !HEX_32.test(raw.body.evidenceHash)
  ) throw new Error('The arbiter decision body is malformed.')
  const ref = bodyReference(raw.body, 'Arbiter decision')
  const value = {
    offerId: ref.offerId,
    contractId: ref.contractId,
    bondSetHash: ref.bondSetHash!,
    resolution: raw.body.resolution as DecisionResolution,
    evidenceHash: raw.body.evidenceHash,
    reason: raw.body.reason as DecisionReason
  }
  if (!sameTags(raw.event.tags, tagsForDecision(value))) throw new Error('The decision tags and body disagree.')
  return {type: 'arbiter_decision', encoded: raw.encoded, event: raw.event, ...value}
}

const decodeSettlementNotice = (raw: ReturnType<typeof decodeRawEvent>): SignedSettlementNotice => {
  const hasSignature = raw.body.mintSignature !== undefined
  exactKeys(raw.body, ['v', 'offerId', 'contractId', 'bondSetHash', 'bondRequestId', 'sourceRole', 'beneficiary', 'outputHash', 'amountMsat', 'mutationOutcome', ...(hasSignature ? ['mintSignature'] : [])], 'Settlement notice')
  const ref = bodyReference(raw.body, 'Settlement notice')
  if (
    raw.body.v !== 1 ||
    typeof raw.body.bondRequestId !== 'string' || !HEX_32.test(raw.body.bondRequestId) ||
    !isPartyRole(raw.body.sourceRole) || !isPartyRole(raw.body.beneficiary) ||
    typeof raw.body.outputHash !== 'string' || !HEX_32.test(raw.body.outputHash) ||
    typeof raw.body.amountMsat !== 'number' || !Number.isSafeInteger(raw.body.amountMsat) || raw.body.amountMsat < 1000 ||
    !['confirmed', 'beneficiary_must_probe'].includes(String(raw.body.mutationOutcome)) ||
    (hasSignature && (typeof raw.body.mintSignature !== 'string' || raw.body.mintSignature.length > 512))
  ) throw new Error('The settlement notice body is malformed.')
  const value = {
    offerId: ref.offerId,
    contractId: ref.contractId,
    bondSetHash: ref.bondSetHash!,
    bondRequestId: raw.body.bondRequestId,
    sourceRole: raw.body.sourceRole,
    beneficiary: raw.body.beneficiary,
    outputHash: raw.body.outputHash,
    amountMsat: raw.body.amountMsat,
    mutationOutcome: raw.body.mutationOutcome as SignedSettlementNotice['mutationOutcome'],
    ...(hasSignature ? {mintSignature: raw.body.mintSignature as string} : {})
  }
  if (!sameTags(raw.event.tags, tagsForSettlementNotice(value))) throw new Error('The settlement notice tags and body disagree.')
  return {type: 'settlement_notice', encoded: raw.encoded, event: raw.event, ...value}
}

const decodePayoutAck = (raw: ReturnType<typeof decodeRawEvent>): SignedPayoutAcknowledgement => {
  exactKeys(raw.body, ['v', 'offerId', 'contractId', 'bondSetHash', 'noticeId', 'bondRequestId', 'sourceRole', 'beneficiary', 'outputHash'], 'Payout acknowledgement')
  const ref = bodyReference(raw.body, 'Payout acknowledgement')
  if (
    raw.body.v !== 1 ||
    typeof raw.body.noticeId !== 'string' || !HEX_32.test(raw.body.noticeId) ||
    typeof raw.body.bondRequestId !== 'string' || !HEX_32.test(raw.body.bondRequestId) ||
    !isPartyRole(raw.body.sourceRole) || !isPartyRole(raw.body.beneficiary) ||
    typeof raw.body.outputHash !== 'string' || !HEX_32.test(raw.body.outputHash)
  ) throw new Error('The payout acknowledgement body is malformed.')
  const value = {
    offerId: ref.offerId,
    contractId: ref.contractId,
    bondSetHash: ref.bondSetHash!,
    noticeId: raw.body.noticeId,
    bondRequestId: raw.body.bondRequestId,
    sourceRole: raw.body.sourceRole,
    beneficiary: raw.body.beneficiary,
    outputHash: raw.body.outputHash
  }
  if (!sameTags(raw.event.tags, tagsForPayoutAck(value))) throw new Error('The payout acknowledgement tags and body disagree.')
  return {type: 'payout_ack', encoded: raw.encoded, event: raw.event, ...value}
}

export const decodeContractMessage = (input: string, nowSeconds = Math.floor(Date.now() / 1000)): ContractMessage => {
  const raw = decodeRawEvent(input, nowSeconds)
  if (raw.event.kind === ENROLMENT_KIND) return decodeEnrolment(raw)
  if (raw.event.kind === CONTRACT_OFFER_KIND) return decodeOffer(raw)
  if (raw.event.kind === ACCEPTANCE_KIND) return decodeAcceptance(raw)
  if (raw.event.kind === FUNDING_ACK_KIND) return decodeFundingAck(raw)
  if (raw.event.kind === CONTRACT_OUTCOME_KIND) return decodeOutcome(raw)
  if (raw.event.kind === ARBITER_DECISION_KIND) return decodeDecision(raw)
  if (raw.event.kind === SETTLEMENT_NOTICE_KIND) return decodeSettlementNotice(raw)
  if (raw.event.kind === PAYOUT_ACK_KIND) return decodePayoutAck(raw)
  throw new Error('Unknown contract message kind.')
}

export const assertOfferOpen = (offer: SignedContractOffer, nowSeconds = Math.floor(Date.now() / 1000)): void => {
  if (nowSeconds > offer.terms.setupExpires) throw new Error('The contract setup window has closed.')
}

export const assertAcceptance = (acceptance: SignedAcceptance, offer: SignedContractOffer): void => {
  if (acceptance.offerId !== offer.event.id || acceptance.contractId !== offer.terms.contractId) throw new Error('The acceptance belongs to another offer.')
  if (acceptance.event.pubkey !== offer.terms.participants[acceptance.role]) throw new Error('The acceptance signer is not the named party.')
  if (acceptance.event.created_at < offer.event.created_at || acceptance.event.created_at > offer.terms.setupExpires) throw new Error('The acceptance was signed outside setup.')
}

export const assertAcceptancePair = (acceptances: Record<PartyRole, SignedAcceptance>, offer: SignedContractOffer): void => {
  for (const role of PARTY_ROLES) {
    if (acceptances[role].role !== role) throw new Error('The acceptance is stored under the wrong role.')
    assertAcceptance(acceptances[role], offer)
  }
  const targets = PARTY_ROLES.flatMap(beneficiary => PARTY_ROLES.map(source => acceptances[beneficiary].payoutHashes[source]))
  if (new Set(targets).size !== targets.length) throw new Error('Every beneficiary and source bond must have a different payout target.')
}

const assertRequestForRole = (request: SignedRequest, role: PartyRole, offer: SignedContractOffer): void => {
  if (!isCommitmentIntent(request.intent)) throw new Error('A contract packet contains a non-commitment request.')
  if (
    request.intent.contractId !== offer.terms.contractId ||
    request.intent.offerId !== offer.event.id ||
    request.intent.payerRole !== role ||
    request.intent.amount !== offer.terms.bonds[role] ||
    JSON.stringify(request.intent.participants) !== JSON.stringify(offer.terms.participants) ||
    JSON.stringify(request.intent.mint) !== JSON.stringify(offer.terms.mint)
  ) throw new Error(`The ${role.replace('_', ' ')} bond request disagrees with the signed offer.`)
  if (request.event.pubkey !== offer.terms.participants.arbiter) throw new Error('A bond request was not signed by the named arbiter.')
}

export const encodeContractPacket = (args: {
  offer: SignedContractOffer
  acceptances: Record<PartyRole, SignedAcceptance>
  bondRequests: Record<PartyRole, SignedRequest>
}): string => {
  assertAcceptancePair(args.acceptances, args.offer)
  for (const role of PARTY_ROLES) assertRequestForRole(args.bondRequests[role], role, args.offer)
  const body: PacketBody = {
    v: 1,
    offer: args.offer.encoded,
    acceptances: {party_a: args.acceptances.party_a.encoded, party_b: args.acceptances.party_b.encoded},
    bondRequests: {party_a: args.bondRequests.party_a.encoded, party_b: args.bondRequests.party_b.encoded}
  }
  return PACKET_PREFIX + encodeBase64Url(JSON.stringify(body))
}

export const decodeContractPacket = (input: string, nowSeconds = 0): ContractPacket => {
  const encoded = input.trim()
  if (!encoded.startsWith(PACKET_PREFIX)) throw new Error(`Contract packets begin ${PACKET_PREFIX}.`)
  if (encoded.length > MAX_PACKET_LENGTH) throw new Error('The contract packet is too large.')
  const body = objectOf(JSON.parse(decodeBase64Url(encoded.slice(PACKET_PREFIX.length))), 'Contract packet')
  exactKeys(body, ['v', 'offer', 'acceptances', 'bondRequests'], 'Contract packet')
  if (body.v !== 1 || typeof body.offer !== 'string') throw new Error('Unsupported contract packet.')
  const acceptanceInputs = objectOf(body.acceptances, 'Packet acceptances')
  const requestInputs = objectOf(body.bondRequests, 'Packet bond requests')
  exactKeys(acceptanceInputs, ['party_a', 'party_b'], 'Packet acceptances')
  exactKeys(requestInputs, ['party_a', 'party_b'], 'Packet bond requests')
  if ([acceptanceInputs.party_a, acceptanceInputs.party_b, requestInputs.party_a, requestInputs.party_b].some(value => typeof value !== 'string')) throw new Error('A packet component is missing.')
  const offerMessage = decodeContractMessage(body.offer, nowSeconds)
  if (offerMessage.type !== 'contract_offer') throw new Error('The packet does not contain a contract offer.')
  const acceptanceMessages = PARTY_ROLES.map(role => decodeContractMessage(acceptanceInputs[role] as string, nowSeconds))
  if (acceptanceMessages.some(message => message.type !== 'acceptance')) throw new Error('The packet contains a non-acceptance message.')
  const acceptances = {
    party_a: acceptanceMessages[0] as SignedAcceptance,
    party_b: acceptanceMessages[1] as SignedAcceptance
  }
  assertAcceptancePair(acceptances, offerMessage)
  const bondRequests = {
    party_a: decodeRequest(requestInputs.party_a as string, nowSeconds),
    party_b: decodeRequest(requestInputs.party_b as string, nowSeconds)
  }
  for (const role of PARTY_ROLES) assertRequestForRole(bondRequests[role], role, offerMessage)
  const bondSetHash = bondSetHashOf(PARTY_ROLES.map(role => bondRequests[role].event.id))
  return {encoded, offer: offerMessage, acceptances, bondRequests, bondSetHash}
}

export const assertFundingAcknowledgement = (ack: SignedFundingAcknowledgement, packet: ContractPacket): void => {
  const expected = packet.bondRequests[ack.role]
  if (
    ack.offerId !== packet.offer.event.id ||
    ack.contractId !== packet.offer.terms.contractId ||
    ack.bondSetHash !== packet.bondSetHash ||
    ack.bondRequestId !== expected.event.id
  ) throw new Error('The funding acknowledgement belongs to another contract packet.')
  if (ack.event.pubkey !== packet.offer.terms.participants[ack.role]) throw new Error('The funding acknowledgement signer is not the named payer.')
  if (ack.event.created_at < expected.event.created_at || ack.event.created_at > expected.intent.expires) throw new Error('The funding acknowledgement was signed outside the request window.')
}

export const assertOutcomeStatement = (statement: SignedOutcomeStatement, packet: ContractPacket): PartyRole => {
  if (
    statement.offerId !== packet.offer.event.id ||
    statement.contractId !== packet.offer.terms.contractId ||
    statement.bondSetHash !== packet.bondSetHash
  ) throw new Error('The outcome belongs to another contract packet.')
  const role = PARTY_ROLES.find(candidate => packet.offer.terms.participants[candidate] === statement.event.pubkey)
  if (!role) throw new Error('The outcome signer is not a named party.')
  if (statement.outcome === 'party_a_cancel' && role !== 'party_a') throw new Error('Party A self-cancellation was signed by somebody else.')
  if (statement.outcome === 'party_b_cancel' && role !== 'party_b') throw new Error('Party B self-cancellation was signed by somebody else.')
  if (statement.event.created_at < packet.offer.event.created_at || statement.event.created_at > packet.offer.terms.settlementExpires) throw new Error('The outcome was signed outside the contract window.')
  return role
}

export const assertArbiterDecision = (decision: SignedArbiterDecision, packet: ContractPacket): void => {
  if (
    decision.offerId !== packet.offer.event.id ||
    decision.contractId !== packet.offer.terms.contractId ||
    decision.bondSetHash !== packet.bondSetHash
  ) throw new Error('The decision belongs to another contract packet.')
  if (decision.event.pubkey !== packet.offer.terms.participants.arbiter) throw new Error('The decision signer is not the named arbiter.')
  if (decision.event.created_at < packet.offer.event.created_at || decision.event.created_at > packet.offer.terms.settlementExpires) throw new Error('The decision was signed outside the contract window.')
}

export const assertSettlementNotice = (notice: SignedSettlementNotice, packet: ContractPacket): void => {
  const request = packet.bondRequests[notice.sourceRole]
  if (
    notice.offerId !== packet.offer.event.id ||
    notice.contractId !== packet.offer.terms.contractId ||
    notice.bondSetHash !== packet.bondSetHash ||
    notice.bondRequestId !== request.event.id ||
    notice.outputHash !== packet.acceptances[notice.beneficiary].payoutHashes[notice.sourceRole] ||
    notice.amountMsat !== Number(request.intent.amount) * 1000
  ) throw new Error('The settlement notice disagrees with the signed contract packet.')
  if (notice.event.pubkey !== packet.offer.terms.participants.arbiter) throw new Error('The settlement notice signer is not the named arbiter.')
}

export const assertPayoutAcknowledgement = (ack: SignedPayoutAcknowledgement, notice: SignedSettlementNotice, packet: ContractPacket): void => {
  assertSettlementNotice(notice, packet)
  if (
    ack.offerId !== notice.offerId ||
    ack.contractId !== notice.contractId ||
    ack.bondSetHash !== notice.bondSetHash ||
    ack.noticeId !== notice.event.id ||
    ack.bondRequestId !== notice.bondRequestId ||
    ack.sourceRole !== notice.sourceRole ||
    ack.beneficiary !== notice.beneficiary ||
    ack.outputHash !== notice.outputHash
  ) throw new Error('The payout acknowledgement belongs to another settlement notice.')
  if (ack.event.pubkey !== packet.offer.terms.participants[notice.beneficiary]) throw new Error('The payout acknowledgement signer is not the named beneficiary.')
  if (ack.event.created_at < notice.event.created_at) throw new Error('The payout acknowledgement predates its settlement notice.')
}

export const decisionExecutableAt = (decision: SignedArbiterDecision, offer: SignedContractOffer): number => decision.event.created_at + offer.terms.policy.challengeSeconds

export const messageFingerprint = (message: ContractMessage): string => message.event.id.slice(0, 12)

export const packetFingerprint = (packet: ContractPacket): string => packet.bondSetHash.slice(0, 12)

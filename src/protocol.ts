import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools'
import {isPartyRole, type ContractParticipants, type MintTrust, type PartyRole} from './contract-types'

export type {ContractParticipants, MintTrust, PartyRole} from './contract-types'

export const REQUEST_PREFIX = 'lnurlcashlock1'
export const REQUEST_KIND = 2526
export const MAX_DEMO_SATS = 500
export const MAX_REQUEST_LIFETIME_SECONDS = 15 * 60
export const MAX_CLOCK_SKEW_SECONDS = 2 * 60

const HEX_32 = /^[0-9a-f]{64}$/
const CONTRACT_ID = /^[0-9a-f]{32}$/
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/

export type LegacyPaymentPurpose = 'fare' | 'rider_bond' | 'driver_bond' | 'bond_payout'

export type LegacyParticipants = {
  rider: string
  driver: string
  referee: string
}

export type LegacyReceiverLockedIntent = {
  v: 1
  rideId: string
  fareVersion: number
  purpose: LegacyPaymentPurpose
  role: 'rider' | 'driver' | 'referee'
  amount: string
  currency: 'sat'
  mint: MintTrust
  outputHash: string
  expires: number
  memo: string
  participants?: LegacyParticipants
}

type ReceiverLockedBase = {
  v: 2
  contractId: string
  revision: 1
  amount: string
  currency: 'sat'
  mint: MintTrust
  outputHash: string
  expires: number
  memo: string
}

export type DirectPaymentIntent = ReceiverLockedBase & {
  purpose: 'payment'
  receiverRole: 'recipient'
}

export type CommitmentIntent = ReceiverLockedBase & {
  purpose: 'commitment'
  receiverRole: 'arbiter'
  payerRole: PartyRole
  offerId: string
  participants: ContractParticipants
}

export type ReceiverLockedIntent = LegacyReceiverLockedIntent | DirectPaymentIntent | CommitmentIntent
export type PaymentPurpose = ReceiverLockedIntent['purpose']

export type SignedRequest = {
  encoded: string
  event: Event
  intent: ReceiverLockedIntent
}

export const randomSecretHex = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

export const randomId = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(16)))

export const outputHashOf = (secretHex: string): string => bytesToHex(sha256(hexToBytes(secretHex)))

export const createIdentity = (): {secretHex: string; pubkey: string} => {
  const secret = generateSecretKey()
  return {secretHex: bytesToHex(secret), pubkey: getPublicKey(secret)}
}

export const isCommitmentIntent = (intent: ReceiverLockedIntent): intent is CommitmentIntent => intent.v === 2 && intent.purpose === 'commitment'

export const isDirectPaymentIntent = (intent: ReceiverLockedIntent): intent is DirectPaymentIntent => intent.v === 2 && intent.purpose === 'payment'

export const contractIdOf = (intent: ReceiverLockedIntent): string => intent.v === 1 ? intent.rideId : intent.contractId

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

const parsePositiveInteger = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number.`)
  return value
}

const exactKeys = (raw: Record<string, unknown>, expected: string[], name: string): void => {
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${name} has missing or unknown fields.`)
}

const objectOf = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is not an object.`)
  return value as Record<string, unknown>
}

const validateMint = (value: unknown): MintTrust => {
  const mint = objectOf(value, 'Mint details')
  exactKeys(mint, mint.mintPubkey === undefined ? ['host', 'withdrawLink'] : ['host', 'withdrawLink', 'mintPubkey'], 'Mint details')
  if (typeof mint.host !== 'string' || mint.host.trim() === '' || typeof mint.withdrawLink !== 'string') throw new Error('Missing mint details.')
  const withdraw = new URL(mint.withdrawLink)
  if (withdraw.protocol !== 'https:' && !(withdraw.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(withdraw.hostname))) {
    throw new Error('Mint withdraw links must use HTTPS, except on loopback.')
  }
  if (withdraw.host.toLowerCase() !== mint.host.toLowerCase()) throw new Error('Mint host and withdraw link disagree.')
  if (mint.mintPubkey !== undefined && (typeof mint.mintPubkey !== 'string' || !COMPRESSED_PUBKEY.test(mint.mintPubkey))) throw new Error('The mint signing key is malformed.')
  return {
    host: mint.host.toLowerCase(),
    withdrawLink: withdraw.toString(),
    ...(mint.mintPubkey ? {mintPubkey: mint.mintPubkey as string} : {})
  }
}

const validateCommon = (raw: Record<string, unknown>): Pick<ReceiverLockedBase, 'amount' | 'currency' | 'mint' | 'outputHash' | 'expires' | 'memo'> => {
  if (typeof raw.amount !== 'string' || !/^[1-9][0-9]*$/u.test(raw.amount)) throw new Error('amount must be whole sats as decimal text.')
  const sats = Number(raw.amount)
  if (!Number.isSafeInteger(sats) || sats < 1 || sats > MAX_DEMO_SATS) throw new Error(`This demo is capped at ${MAX_DEMO_SATS} sats per transfer.`)
  if (raw.currency !== 'sat') throw new Error('Only sat is supported.')
  const mint = validateMint(raw.mint)
  if (typeof raw.outputHash !== 'string' || !HEX_32.test(raw.outputHash)) throw new Error('outputHash must be 32 bytes of lowercase hex.')
  const expires = parsePositiveInteger(raw.expires, 'expires')
  if (typeof raw.memo !== 'string' || raw.memo.length > 280 || /[\u0000-\u001f\u007f]/u.test(raw.memo)) throw new Error('memo must be no more than 280 printable characters.')
  return {amount: raw.amount, currency: 'sat', mint, outputHash: raw.outputHash, expires, memo: raw.memo}
}

const validateLegacyIntent = (raw: Record<string, unknown>): LegacyReceiverLockedIntent => {
  const expected = ['v', 'rideId', 'fareVersion', 'purpose', 'role', 'amount', 'currency', 'mint', 'outputHash', 'expires', 'memo', ...(raw.participants === undefined ? [] : ['participants'])]
  exactKeys(raw, expected, 'Legacy request')
  if (typeof raw.rideId !== 'string' || !CONTRACT_ID.test(raw.rideId)) throw new Error('contract id must be 16 random bytes.')
  const fareVersion = parsePositiveInteger(raw.fareVersion, 'fareVersion')
  if (!['fare', 'rider_bond', 'driver_bond', 'bond_payout'].includes(String(raw.purpose))) throw new Error('Unknown legacy payment purpose.')
  if (!['rider', 'driver', 'referee'].includes(String(raw.role))) throw new Error('Unknown legacy receiver role.')
  const common = validateCommon(raw)
  const isBond = ['rider_bond', 'driver_bond'].includes(String(raw.purpose))
  let participants: LegacyParticipants | undefined
  if (isBond) {
    const party = objectOf(raw.participants, 'Legacy bond participants')
    exactKeys(party, ['rider', 'driver', 'referee'], 'Legacy bond participants')
    if ([party.rider, party.driver, party.referee].some(key => typeof key !== 'string' || !HEX_32.test(key))) throw new Error('A participant signing key is malformed.')
    if (new Set([party.rider, party.driver, party.referee]).size !== 3) throw new Error('Rider, driver and referee must use different keys.')
    participants = {rider: party.rider as string, driver: party.driver as string, referee: party.referee as string}
  } else if (raw.participants !== undefined) {
    throw new Error('Direct payments must not smuggle legacy bond participant keys.')
  }
  return {
    v: 1,
    rideId: raw.rideId,
    fareVersion,
    purpose: raw.purpose as LegacyPaymentPurpose,
    role: raw.role as LegacyReceiverLockedIntent['role'],
    ...common,
    ...(participants ? {participants} : {})
  }
}

const validateV2Intent = (raw: Record<string, unknown>): DirectPaymentIntent | CommitmentIntent => {
  const commitment = raw.purpose === 'commitment'
  exactKeys(raw, [
    'v', 'contractId', 'revision', 'purpose', 'receiverRole', 'amount', 'currency', 'mint', 'outputHash', 'expires', 'memo',
    ...(commitment ? ['payerRole', 'offerId', 'participants'] : [])
  ], 'Receiver-locked request')
  if (typeof raw.contractId !== 'string' || !CONTRACT_ID.test(raw.contractId)) throw new Error('contract id must be 16 random bytes.')
  if (raw.revision !== 1) throw new Error('Unsupported request revision.')
  const common = validateCommon(raw)
  if (raw.purpose === 'payment') {
    if (raw.receiverRole !== 'recipient') throw new Error('Direct payment receiver role must be recipient.')
    return {v: 2, contractId: raw.contractId, revision: 1, purpose: 'payment', receiverRole: 'recipient', ...common}
  }
  if (!commitment) throw new Error('Unknown payment purpose.')
  if (raw.receiverRole !== 'arbiter' || !isPartyRole(raw.payerRole)) throw new Error('Commitment payer or receiver role is malformed.')
  if (typeof raw.offerId !== 'string' || !HEX_32.test(raw.offerId)) throw new Error('Commitment offer id is malformed.')
  const participantsRaw = objectOf(raw.participants, 'Commitment participants')
  exactKeys(participantsRaw, ['party_a', 'party_b', 'arbiter'], 'Commitment participants')
  const keys = [participantsRaw.party_a, participantsRaw.party_b, participantsRaw.arbiter]
  if (keys.some(key => typeof key !== 'string' || !HEX_32.test(key))) throw new Error('A commitment participant key is malformed.')
  if (new Set(keys).size !== 3) throw new Error('Party A, Party B and the arbiter must use different keys.')
  return {
    v: 2,
    contractId: raw.contractId,
    revision: 1,
    purpose: 'commitment',
    receiverRole: 'arbiter',
    payerRole: raw.payerRole,
    offerId: raw.offerId,
    participants: {
      party_a: participantsRaw.party_a as string,
      party_b: participantsRaw.party_b as string,
      arbiter: participantsRaw.arbiter as string
    },
    ...common
  }
}

const validateIntent = (value: unknown): ReceiverLockedIntent => {
  const raw = objectOf(value, 'Request body')
  if (raw.v === 1) return validateLegacyIntent(raw)
  if (raw.v === 2) return validateV2Intent(raw)
  throw new Error('Unsupported request version.')
}

const tagsFor = (intent: ReceiverLockedIntent): string[][] => {
  if (intent.v === 1) {
    return [
      ['d', intent.rideId],
      ['t', 'lnurlcash-contract-payment'],
      ['purpose', intent.purpose],
      ['amount', intent.amount, intent.currency],
      ['mint', intent.mint.host],
      ['h', intent.outputHash],
      ['fare_version', String(intent.fareVersion)],
      ...(intent.participants ? [
        ['p', intent.participants.rider, 'rider'],
        ['p', intent.participants.driver, 'driver'],
        ['p', intent.participants.referee, 'referee']
      ] : [])
    ]
  }
  return [
    ['d', intent.contractId],
    ['t', 'lnurlcash-contract-payment'],
    ['purpose', intent.purpose],
    ['amount', intent.amount, intent.currency],
    ['mint', intent.mint.host],
    ['h', intent.outputHash],
    ['revision', String(intent.revision)],
    ...(intent.purpose === 'commitment' ? [
      ['e', intent.offerId],
      ['payer', intent.payerRole],
      ['p', intent.participants.party_a, 'party_a'],
      ['p', intent.participants.party_b, 'party_b'],
      ['p', intent.participants.arbiter, 'arbiter']
    ] : [])
  ]
}

const assertNamedSigner = (intent: ReceiverLockedIntent, signerPubkey: string): void => {
  if (intent.v === 1 && intent.participants && signerPubkey !== intent.participants.referee) throw new Error('Only the named referee may sign a legacy bond request.')
  if (isCommitmentIntent(intent) && signerPubkey !== intent.participants.arbiter) throw new Error('Only the named arbiter may sign a commitment request.')
}

export const signRequest = (intentInput: ReceiverLockedIntent, signerSecretHex: string): SignedRequest => {
  const intent = validateIntent(intentInput)
  const event = finalizeEvent({kind: REQUEST_KIND, created_at: Math.floor(Date.now() / 1000), tags: tagsFor(intent), content: JSON.stringify(intent)}, hexToBytes(signerSecretHex))
  assertNamedSigner(intent, event.pubkey)
  return {encoded: REQUEST_PREFIX + encodeBase64Url(JSON.stringify(event)), event, intent}
}

export const decodeRequest = (input: string, nowSeconds = Math.floor(Date.now() / 1000)): SignedRequest => {
  const encoded = input.trim()
  if (!encoded.startsWith(REQUEST_PREFIX)) throw new Error(`Requests begin ${REQUEST_PREFIX}.`)
  if (encoded.length > 8192) throw new Error('The request is too large.')
  const event = JSON.parse(decodeBase64Url(encoded.slice(REQUEST_PREFIX.length))) as Event
  if (event.kind !== REQUEST_KIND || !verifyEvent(event)) throw new Error('The Nostr request signature does not verify.')
  const intent = validateIntent(JSON.parse(event.content))
  if (JSON.stringify(event.tags) !== JSON.stringify(tagsFor(intent))) throw new Error('The signed tags and request body disagree.')
  assertNamedSigner(intent, event.pubkey)
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 1) throw new Error('The request creation time is invalid.')
  if (intent.expires <= event.created_at || intent.expires - event.created_at > MAX_REQUEST_LIFETIME_SECONDS) throw new Error('The request lifetime is outside the 15 minute safety window.')
  if (nowSeconds !== 0) {
    if (event.created_at > nowSeconds + MAX_CLOCK_SKEW_SECONDS) throw new Error('The request was signed too far in the future.')
    if (intent.expires <= nowSeconds) throw new Error('The request has expired.')
  }
  return {encoded, event, intent}
}

export const requestFingerprint = (request: SignedRequest): string => request.event.id.slice(0, 12)

export const bondSetHashOf = (requestEventIds: string[]): string => {
  if (requestEventIds.length !== 2 || new Set(requestEventIds).size !== 2 || requestEventIds.some(id => !HEX_32.test(id))) {
    throw new Error('A bond set must contain two different signed request ids.')
  }
  return bytesToHex(sha256(new TextEncoder().encode([...requestEventIds].sort().join(':'))))
}

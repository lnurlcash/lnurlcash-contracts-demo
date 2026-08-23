import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event
} from 'nostr-tools'

export const REQUEST_PREFIX = 'lnurlcashlock1'
export const REQUEST_KIND = 2526
export const OUTCOME_KIND = 2527
export const MAX_DEMO_SATS = 500
export const MAX_REQUEST_LIFETIME_SECONDS = 15 * 60
export const MAX_CLOCK_SKEW_SECONDS = 2 * 60

const HEX_32 = /^[0-9a-f]{64}$/
const CONTRACT_ID = /^[0-9a-f]{32}$/
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/

export type PaymentPurpose = 'fare' | 'rider_bond' | 'driver_bond' | 'bond_payout'

export type ContractParticipants = {
  rider: string
  driver: string
  referee: string
}

export type ReceiverLockedIntent = {
  v: 1
  rideId: string
  fareVersion: number
  purpose: PaymentPurpose
  role: 'rider' | 'driver' | 'referee'
  amount: string
  currency: 'sat'
  mint: {
    host: string
    withdrawLink: string
    mintPubkey?: string
  }
  outputHash: string
  expires: number
  memo: string
  participants?: ContractParticipants
}

export type SignedRequest = {
  encoded: string
  event: Event
  intent: ReceiverLockedIntent
}

export type RideOutcome = 'complete' | 'rider_cancel' | 'driver_cancel'

export type SignedOutcome = {
  rideId: string
  bondSetHash: string
  outcome: RideOutcome
  event: Event
}

export const randomSecretHex = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

export const randomId = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(16)))

export const outputHashOf = (secretHex: string): string => bytesToHex(sha256(hexToBytes(secretHex)))

export const createIdentity = (): {secretHex: string; pubkey: string} => {
  const secret = generateSecretKey()
  return {secretHex: bytesToHex(secret), pubkey: getPublicKey(secret)}
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

const parsePositiveInteger = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number.`)
  }
  return value
}

const validateIntent = (value: unknown): ReceiverLockedIntent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The request body is not an object.')
  const raw = value as Record<string, unknown>
  const known = new Set(['v', 'rideId', 'fareVersion', 'purpose', 'role', 'amount', 'currency', 'mint', 'outputHash', 'expires', 'memo', 'participants'])
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`Unknown request field ${key}.`)
  if (raw.v !== 1) throw new Error('Unsupported request version.')
  if (typeof raw.rideId !== 'string' || !CONTRACT_ID.test(raw.rideId)) throw new Error('contract id must be 16 random bytes.')
  const fareVersion = parsePositiveInteger(raw.fareVersion, 'fareVersion')
  if (!['fare', 'rider_bond', 'driver_bond', 'bond_payout'].includes(String(raw.purpose))) throw new Error('Unknown payment purpose.')
  if (!['rider', 'driver', 'referee'].includes(String(raw.role))) throw new Error('Unknown receiver role.')
  if (typeof raw.amount !== 'string' || !/^[1-9][0-9]*$/u.test(raw.amount)) throw new Error('amount must be whole sats as decimal text.')
  const sats = Number(raw.amount)
  if (!Number.isSafeInteger(sats) || sats < 1 || sats > MAX_DEMO_SATS) throw new Error(`This demo is capped at ${MAX_DEMO_SATS} sats per transfer.`)
  if (raw.currency !== 'sat') throw new Error('Only sat is supported.')
  if (!raw.mint || typeof raw.mint !== 'object' || Array.isArray(raw.mint)) throw new Error('Missing mint details.')
  const mint = raw.mint as Record<string, unknown>
  if (typeof mint.host !== 'string' || mint.host.trim() === '') throw new Error('Missing mint host.')
  if (typeof mint.withdrawLink !== 'string') throw new Error('Missing mint withdraw link.')
  const withdraw = new URL(mint.withdrawLink)
  if (withdraw.protocol !== 'https:' && !(withdraw.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(withdraw.hostname))) {
    throw new Error('Mint withdraw links must use HTTPS, except on loopback.')
  }
  if (withdraw.host.toLowerCase() !== mint.host.toLowerCase()) throw new Error('Mint host and withdraw link disagree.')
  if (mint.mintPubkey !== undefined && (typeof mint.mintPubkey !== 'string' || !COMPRESSED_PUBKEY.test(mint.mintPubkey))) {
    throw new Error('The mint signing key is malformed.')
  }
  if (typeof raw.outputHash !== 'string' || !HEX_32.test(raw.outputHash)) throw new Error('outputHash must be 32 bytes of lowercase hex.')
  const expires = parsePositiveInteger(raw.expires, 'expires')
  if (typeof raw.memo !== 'string' || raw.memo.length > 280) throw new Error('memo must be no more than 280 characters.')
  const isBond = ['rider_bond', 'driver_bond'].includes(String(raw.purpose))
  let participants: ContractParticipants | undefined
  if (isBond) {
    if (!raw.participants || typeof raw.participants !== 'object' || Array.isArray(raw.participants)) throw new Error('Bond requests must bind all participant keys.')
    const party = raw.participants as Record<string, unknown>
    if (JSON.stringify(Object.keys(party).sort()) !== JSON.stringify(['driver', 'referee', 'rider'])) throw new Error('The participant key set is malformed.')
    if ([party.rider, party.driver, party.referee].some(key => typeof key !== 'string' || !HEX_32.test(key))) throw new Error('A participant signing key is malformed.')
    if (new Set([party.rider, party.driver, party.referee]).size !== 3) throw new Error('Rider, driver and referee must use different keys.')
    participants = {rider: party.rider as string, driver: party.driver as string, referee: party.referee as string}
  } else if (raw.participants !== undefined) {
    throw new Error('Direct payments must not smuggle bond participant keys.')
  }
  return {
    v: 1,
    rideId: raw.rideId,
    fareVersion,
    purpose: raw.purpose as PaymentPurpose,
    role: raw.role as ReceiverLockedIntent['role'],
    amount: raw.amount,
    currency: 'sat',
    mint: {
      host: mint.host.toLowerCase(),
      withdrawLink: withdraw.toString(),
      ...(mint.mintPubkey ? {mintPubkey: mint.mintPubkey as string} : {})
    },
    outputHash: raw.outputHash,
    expires,
    memo: raw.memo,
    ...(participants ? {participants} : {})
  }
}

const tagsFor = (intent: ReceiverLockedIntent): string[][] => [
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

export const signRequest = (intentInput: ReceiverLockedIntent, signerSecretHex: string): SignedRequest => {
  const intent = validateIntent(intentInput)
  const unsigned = {
    kind: REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: tagsFor(intent),
    content: JSON.stringify(intent)
  }
  const event = finalizeEvent(unsigned, hexToBytes(signerSecretHex))
  if (intent.participants && event.pubkey !== intent.participants.referee) throw new Error('Only the named referee may sign a bond request.')
  const encoded = REQUEST_PREFIX + encodeBase64Url(JSON.stringify(event))
  return {encoded, event, intent}
}

const sameTags = (actual: string[][], expected: string[][]): boolean => JSON.stringify(actual) === JSON.stringify(expected)

export const decodeRequest = (input: string, nowSeconds = Math.floor(Date.now() / 1000)): SignedRequest => {
  const trimmed = input.trim()
  if (!trimmed.startsWith(REQUEST_PREFIX)) throw new Error(`Requests begin ${REQUEST_PREFIX}.`)
  if (trimmed.length > 8192) throw new Error('The request is too large.')
  const event = JSON.parse(decodeBase64Url(trimmed.slice(REQUEST_PREFIX.length))) as Event
  if (event.kind !== REQUEST_KIND || !verifyEvent(event)) throw new Error('The Nostr request signature does not verify.')
  const intent = validateIntent(JSON.parse(event.content))
  if (!sameTags(event.tags, tagsFor(intent))) throw new Error('The signed tags and request body disagree.')
  if (intent.participants && event.pubkey !== intent.participants.referee) throw new Error('The bond request was not signed by its named referee.')
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 1) throw new Error('The request creation time is invalid.')
  if (intent.expires <= event.created_at || intent.expires - event.created_at > MAX_REQUEST_LIFETIME_SECONDS) {
    throw new Error('The request lifetime is outside the 15 minute safety window.')
  }
  if (nowSeconds !== 0) {
    if (event.created_at > nowSeconds + MAX_CLOCK_SKEW_SECONDS) throw new Error('The request was signed too far in the future.')
    if (intent.expires <= nowSeconds) throw new Error('The request has expired.')
  }
  return {encoded: trimmed, event, intent}
}

export const requestFingerprint = (request: SignedRequest): string => request.event.id.slice(0, 12)

export const bondSetHashOf = (requestEventIds: string[]): string => {
  if (requestEventIds.length !== 2 || new Set(requestEventIds).size !== 2 || requestEventIds.some(id => !HEX_32.test(id))) {
    throw new Error('A bond set must contain two different signed request ids.')
  }
  return bytesToHex(sha256(new TextEncoder().encode([...requestEventIds].sort().join(':'))))
}

export const signOutcome = (rideId: string, bondSetHash: string, outcome: RideOutcome, signerSecretHex: string): SignedOutcome => {
  if (!CONTRACT_ID.test(rideId)) throw new Error('contract id must be 16 random bytes.')
  if (!HEX_32.test(bondSetHash)) throw new Error('bond set hash must be 32 bytes.')
  const unsigned = {
    kind: OUTCOME_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', rideId], ['bond_set', bondSetHash], ['t', 'lnurlcash-contract-outcome'], ['outcome', outcome]],
    content: JSON.stringify({v: 1, rideId, bondSetHash, outcome})
  }
  return {rideId, bondSetHash, outcome, event: finalizeEvent(unsigned, hexToBytes(signerSecretHex))}
}

export const verifyOutcome = (
  signed: SignedOutcome,
  identities: {rider: string; driver: string},
  expectedBondSetHash = signed.bondSetHash
): boolean => {
  try {
    if (!verifyEvent(signed.event) || signed.event.kind !== OUTCOME_KIND) return false
    if (signed.bondSetHash !== expectedBondSetHash || !HEX_32.test(signed.bondSetHash)) return false
    const expectedSigner = signed.outcome === 'rider_cancel'
      ? identities.rider
      : signed.outcome === 'driver_cancel'
        ? identities.driver
        : null
    if (expectedSigner && signed.event.pubkey !== expectedSigner) return false
    if (!expectedSigner && ![identities.rider, identities.driver].includes(signed.event.pubkey)) return false
    const expectedTags = [['d', signed.rideId], ['bond_set', signed.bondSetHash], ['t', 'lnurlcash-contract-outcome'], ['outcome', signed.outcome]]
    if (JSON.stringify(signed.event.tags) !== JSON.stringify(expectedTags)) return false
    const body = JSON.parse(signed.event.content) as Record<string, unknown>
    return body.v === 1 && body.rideId === signed.rideId && body.bondSetHash === signed.bondSetHash && body.outcome === signed.outcome
  } catch {
    return false
  }
}

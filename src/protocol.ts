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

const HEX_16 = /^[0-9a-f]{16}$/
const HEX_32 = /^[0-9a-f]{64}$/
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/

export type PaymentPurpose = 'fare' | 'rider_bond' | 'driver_bond' | 'bond_payout'

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
}

export type SignedRequest = {
  encoded: string
  event: Event
  intent: ReceiverLockedIntent
}

export type RideOutcome = 'complete' | 'rider_cancel' | 'driver_cancel'

export type SignedOutcome = {
  rideId: string
  outcome: RideOutcome
  event: Event
}

export const randomSecretHex = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

export const randomId = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(8)))

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
  const known = new Set(['v', 'rideId', 'fareVersion', 'purpose', 'role', 'amount', 'currency', 'mint', 'outputHash', 'expires', 'memo'])
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`Unknown request field ${key}.`)
  if (raw.v !== 1) throw new Error('Unsupported request version.')
  if (typeof raw.rideId !== 'string' || !HEX_16.test(raw.rideId)) throw new Error('rideId must be 8 random bytes.')
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
    memo: raw.memo
  }
}

const tagsFor = (intent: ReceiverLockedIntent): string[][] => [
  ['d', intent.rideId],
  ['t', 'lnurlcash-contract-payment'],
  ['purpose', intent.purpose],
  ['amount', intent.amount, intent.currency],
  ['mint', intent.mint.host],
  ['h', intent.outputHash],
  ['fare_version', String(intent.fareVersion)]
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
  const encoded = REQUEST_PREFIX + encodeBase64Url(JSON.stringify(event))
  return {encoded, event, intent}
}

const sameTags = (actual: string[][], expected: string[][]): boolean => {
  const relevant = actual.filter(tag => ['d', 't', 'purpose', 'amount', 'mint', 'h', 'fare_version'].includes(tag[0] ?? ''))
  return JSON.stringify(relevant) === JSON.stringify(expected)
}

export const decodeRequest = (input: string, nowSeconds = Math.floor(Date.now() / 1000)): SignedRequest => {
  const trimmed = input.trim()
  if (!trimmed.startsWith(REQUEST_PREFIX)) throw new Error(`Requests begin ${REQUEST_PREFIX}.`)
  if (trimmed.length > 8192) throw new Error('The request is too large.')
  const event = JSON.parse(decodeBase64Url(trimmed.slice(REQUEST_PREFIX.length))) as Event
  if (event.kind !== REQUEST_KIND || !verifyEvent(event)) throw new Error('The Nostr request signature does not verify.')
  const intent = validateIntent(JSON.parse(event.content))
  if (!sameTags(event.tags, tagsFor(intent))) throw new Error('The signed tags and request body disagree.')
  if (nowSeconds !== 0 && intent.expires <= nowSeconds) throw new Error('The request has expired.')
  return {encoded: trimmed, event, intent}
}

export const requestFingerprint = (request: SignedRequest): string => request.event.id.slice(0, 12)

export const signOutcome = (rideId: string, outcome: RideOutcome, signerSecretHex: string): SignedOutcome => {
  if (!HEX_16.test(rideId)) throw new Error('rideId must be 8 random bytes.')
  const unsigned = {
    kind: OUTCOME_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', rideId], ['t', 'lnurlcash-contract-outcome'], ['outcome', outcome]],
    content: JSON.stringify({v: 1, rideId, outcome})
  }
  return {rideId, outcome, event: finalizeEvent(unsigned, hexToBytes(signerSecretHex))}
}

export const verifyOutcome = (
  signed: SignedOutcome,
  identities: {rider: string; driver: string}
): boolean => {
  try {
    if (!verifyEvent(signed.event) || signed.event.kind !== OUTCOME_KIND) return false
    const expectedSigner = signed.outcome === 'rider_cancel'
      ? identities.rider
      : signed.outcome === 'driver_cancel'
        ? identities.driver
        : null
    if (expectedSigner && signed.event.pubkey !== expectedSigner) return false
    if (!expectedSigner && ![identities.rider, identities.driver].includes(signed.event.pubkey)) return false
    const expectedTags = [['d', signed.rideId], ['t', 'lnurlcash-contract-outcome'], ['outcome', signed.outcome]]
    if (JSON.stringify(signed.event.tags) !== JSON.stringify(expectedTags)) return false
    const body = JSON.parse(signed.event.content) as Record<string, unknown>
    return body.v === 1 && body.rideId === signed.rideId && body.outcome === signed.outcome
  } catch {
    return false
  }
}

import {describe, expect, it} from 'vitest'
import {finalizeEvent} from 'nostr-tools'
import {hexToBytes} from '@noble/hashes/utils.js'
import {
  REQUEST_KIND,
  REQUEST_PREFIX,
  bondSetHashOf,
  createIdentity,
  decodeRequest,
  outputHashOf,
  randomId,
  randomSecretHex,
  signOutcome,
  signRequest,
  verifyOutcome,
  type ReceiverLockedIntent
} from './protocol'

const intent = (): ReceiverLockedIntent => {
  const receiverSecret = randomSecretHex()
  return {
    v: 1,
    rideId: randomId(),
    fareVersion: 1,
    purpose: 'fare',
    role: 'driver',
    amount: '21',
    currency: 'sat',
    mint: {
      host: 'mint.test',
      withdrawLink: 'https://mint.test/w',
      mintPubkey: `02${'11'.repeat(32)}`
    },
    outputHash: outputHashOf(receiverSecret),
    expires: Math.floor(Date.now() / 1000) + 300,
    memo: 'final fare'
  }
}

describe('receiver-locked requests', () => {
  it('round-trips a signed request and binds the readable tags to its body', () => {
    const signer = createIdentity()
    const request = signRequest(intent(), signer.secretHex)
    const decoded = decodeRequest(request.encoded)
    expect(decoded.intent).toEqual(request.intent)
    expect(decoded.event.pubkey).toBe(signer.pubkey)
  })

  it('refuses a changed body even when the original Nostr event was valid', () => {
    const signer = createIdentity()
    const request = signRequest(intent(), signer.secretHex)
    const payload = request.encoded.slice('lnurlcashlock1'.length)
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4)
    const event = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {content: string}
    event.content = event.content.replace('"amount":"21"', '"amount":"210"')
    const tampered = `lnurlcashlock1${Buffer.from(JSON.stringify(event)).toString('base64url')}`
    expect(() => decodeRequest(tampered)).toThrow('signature')
  })

  it('lets a receiver inspect an expired request without making it payable again', () => {
    const signer = createIdentity()
    const expired = intent()
    expired.expires = 2
    const event = finalizeEvent({
      kind: REQUEST_KIND,
      created_at: 1,
      tags: [
        ['d', expired.rideId], ['t', 'lnurlcash-contract-payment'], ['purpose', expired.purpose],
        ['amount', expired.amount, expired.currency], ['mint', expired.mint.host], ['h', expired.outputHash],
        ['fare_version', String(expired.fareVersion)]
      ],
      content: JSON.stringify(expired)
    }, hexToBytes(signer.secretHex))
    const encoded = REQUEST_PREFIX + Buffer.from(JSON.stringify(event)).toString('base64url')
    expect(() => decodeRequest(encoded)).toThrow('expired')
    expect(decodeRequest(encoded, 0).intent.expires).toBe(2)
  })

  it('refuses signed tag smuggling instead of letting clients parse different contracts', () => {
    const signer = createIdentity()
    const body = intent()
    const event = finalizeEvent({
      kind: REQUEST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', body.rideId], ['t', 'lnurlcash-contract-payment'], ['purpose', body.purpose],
        ['amount', body.amount, body.currency], ['mint', body.mint.host], ['h', body.outputHash],
        ['fare_version', String(body.fareVersion)], ['beneficiary', 'attacker']
      ],
      content: JSON.stringify(body)
    }, hexToBytes(signer.secretHex))
    const encoded = REQUEST_PREFIX + Buffer.from(JSON.stringify(event)).toString('base64url')
    expect(() => decodeRequest(encoded)).toThrow('tags')
  })

  it('refuses a signed request with an excessive replay window', () => {
    const signer = createIdentity()
    const longLived = intent()
    longLived.expires = Math.floor(Date.now() / 1000) + 60 * 60
    expect(() => decodeRequest(signRequest(longLived, signer.secretHex).encoded)).toThrow('15 minute')
  })

  it('binds every bond to distinct rider, driver and referee keys', () => {
    const referee = createIdentity()
    const rider = createIdentity()
    const driver = createIdentity()
    const attacker = createIdentity()
    const bond = intent()
    bond.purpose = 'rider_bond'
    bond.role = 'referee'
    expect(() => signRequest(bond, referee.secretHex)).toThrow('participant keys')
    bond.participants = {rider: rider.pubkey, driver: driver.pubkey, referee: referee.pubkey}
    expect(() => signRequest(bond, attacker.secretHex)).toThrow('named referee')
    expect(decodeRequest(signRequest(bond, referee.secretHex).encoded).intent.participants).toEqual(bond.participants)
  })
})

describe('outcome authority', () => {
  it('accepts self-cancellation only from the cancelling party', () => {
    const rider = createIdentity()
    const driver = createIdentity()
    const identities = {rider: rider.pubkey, driver: driver.pubkey}
    const contractId = '01'.repeat(16)
    const bondSetHash = bondSetHashOf(['11'.repeat(32), '22'.repeat(32)])
    const honest = signOutcome(contractId, bondSetHash, 'rider_cancel', rider.secretHex)
    const framed = signOutcome(contractId, bondSetHash, 'rider_cancel', driver.secretHex)
    expect(verifyOutcome(honest, identities)).toBe(true)
    expect(verifyOutcome(framed, identities)).toBe(false)
  })

  it('accepts completion attestations only from the two contract parties', () => {
    const rider = createIdentity()
    const driver = createIdentity()
    const stranger = createIdentity()
    const identities = {rider: rider.pubkey, driver: driver.pubkey}
    const contractId = '01'.repeat(16)
    const bondSetHash = bondSetHashOf(['11'.repeat(32), '22'.repeat(32)])
    expect(verifyOutcome(signOutcome(contractId, bondSetHash, 'complete', rider.secretHex), identities)).toBe(true)
    expect(verifyOutcome(signOutcome(contractId, bondSetHash, 'complete', driver.secretHex), identities)).toBe(true)
    expect(verifyOutcome(signOutcome(contractId, bondSetHash, 'complete', stranger.secretHex), identities)).toBe(false)
  })

  it('does not replay a valid outcome over a different pair of bond requests', () => {
    const rider = createIdentity()
    const driver = createIdentity()
    const first = bondSetHashOf(['11'.repeat(32), '22'.repeat(32)])
    const second = bondSetHashOf(['11'.repeat(32), '33'.repeat(32)])
    const signed = signOutcome('01'.repeat(16), first, 'rider_cancel', rider.secretHex)
    expect(verifyOutcome(signed, {rider: rider.pubkey, driver: driver.pubkey}, first)).toBe(true)
    expect(verifyOutcome(signed, {rider: rider.pubkey, driver: driver.pubkey}, second)).toBe(false)
  })
})

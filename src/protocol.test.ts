import {describe, expect, it} from 'vitest'
import {
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
    expired.expires = 1
    const request = signRequest(expired, signer.secretHex)
    expect(() => decodeRequest(request.encoded)).toThrow('expired')
    expect(decodeRequest(request.encoded, 0).intent.expires).toBe(1)
  })
})

describe('outcome authority', () => {
  it('accepts self-cancellation only from the cancelling party', () => {
    const rider = createIdentity()
    const driver = createIdentity()
    const identities = {rider: rider.pubkey, driver: driver.pubkey}
    const honest = signOutcome('0123456789abcdef', 'rider_cancel', rider.secretHex)
    const framed = signOutcome('0123456789abcdef', 'rider_cancel', driver.secretHex)
    expect(verifyOutcome(honest, identities)).toBe(true)
    expect(verifyOutcome(framed, identities)).toBe(false)
  })

  it('accepts completion attestations only from the two contract parties', () => {
    const rider = createIdentity()
    const driver = createIdentity()
    const stranger = createIdentity()
    const identities = {rider: rider.pubkey, driver: driver.pubkey}
    expect(verifyOutcome(signOutcome('0123456789abcdef', 'complete', rider.secretHex), identities)).toBe(true)
    expect(verifyOutcome(signOutcome('0123456789abcdef', 'complete', driver.secretHex), identities)).toBe(true)
    expect(verifyOutcome(signOutcome('0123456789abcdef', 'complete', stranger.secretHex), identities)).toBe(false)
  })
})

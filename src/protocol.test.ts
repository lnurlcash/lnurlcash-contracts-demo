import {hexToBytes} from '@noble/hashes/utils.js'
import {finalizeEvent} from 'nostr-tools'
import {describe, expect, it} from 'vitest'
import {
  REQUEST_KIND,
  REQUEST_PREFIX,
  bondSetHashOf,
  contractIdOf,
  createIdentity,
  decodeRequest,
  isCommitmentIntent,
  outputHashOf,
  randomId,
  randomSecretHex,
  signRequest,
  type CommitmentIntent,
  type DirectPaymentIntent,
  type LegacyReceiverLockedIntent
} from './protocol'

const mint = {host: 'mint.test', withdrawLink: 'https://mint.test/w', mintPubkey: `02${'11'.repeat(32)}`}

const directIntent = (): DirectPaymentIntent => ({
  v: 2,
  contractId: randomId(),
  revision: 1,
  purpose: 'payment',
  receiverRole: 'recipient',
  amount: '21',
  currency: 'sat',
  mint,
  outputHash: outputHashOf(randomSecretHex()),
  expires: Math.floor(Date.now() / 1000) + 300,
  memo: 'service payment'
})

const commitmentIntent = (): {intent: CommitmentIntent; arbiter: ReturnType<typeof createIdentity>} => {
  const partyA = createIdentity()
  const partyB = createIdentity()
  const arbiter = createIdentity()
  return {
    arbiter,
    intent: {
      v: 2,
      contractId: randomId(),
      revision: 1,
      purpose: 'commitment',
      receiverRole: 'arbiter',
      payerRole: 'party_a',
      offerId: '44'.repeat(32),
      participants: {party_a: partyA.pubkey, party_b: partyB.pubkey, arbiter: arbiter.pubkey},
      amount: '13',
      currency: 'sat',
      mint,
      outputHash: outputHashOf(randomSecretHex()),
      expires: Math.floor(Date.now() / 1000) + 300,
      memo: 'Party A commitment'
    }
  }
}

describe('receiver-locked request v2', () => {
  it('round-trips a generic direct payment and binds readable tags to its body', () => {
    const signer = createIdentity()
    const request = signRequest(directIntent(), signer.secretHex)
    const decoded = decodeRequest(request.encoded)
    expect(decoded.intent).toEqual(request.intent)
    expect(decoded.event.pubkey).toBe(signer.pubkey)
    expect(contractIdOf(decoded.intent)).toBe(contractIdOf(request.intent))
  })

  it('refuses a changed body even when the original Nostr event was valid', () => {
    const signer = createIdentity()
    const request = signRequest(directIntent(), signer.secretHex)
    const payload = request.encoded.slice(REQUEST_PREFIX.length)
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4)
    const event = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {content: string}
    event.content = event.content.replace('"amount":"21"', '"amount":"210"')
    const tampered = `${REQUEST_PREFIX}${Buffer.from(JSON.stringify(event)).toString('base64url')}`
    expect(() => decodeRequest(tampered)).toThrow('signature')
  })

  it('refuses exact-tag smuggling', () => {
    const signer = createIdentity()
    const body = directIntent()
    const event = finalizeEvent({
      kind: REQUEST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', body.contractId], ['t', 'lnurlcash-contract-payment'], ['purpose', body.purpose],
        ['amount', body.amount, body.currency], ['mint', body.mint.host], ['h', body.outputHash],
        ['revision', '1'], ['beneficiary', 'attacker']
      ],
      content: JSON.stringify(body)
    }, hexToBytes(signer.secretHex))
    const encoded = REQUEST_PREFIX + Buffer.from(JSON.stringify(event)).toString('base64url')
    expect(() => decodeRequest(encoded)).toThrow('tags')
  })

  it('refuses a request with an excessive replay window', () => {
    const body = directIntent()
    body.expires = Math.floor(Date.now() / 1000) + 60 * 60
    expect(() => decodeRequest(signRequest(body, createIdentity().secretHex).encoded)).toThrow('15 minute')
  })

  it('binds a commitment to neutral party roles, its exact offer and the named arbiter', () => {
    const {intent, arbiter} = commitmentIntent()
    const attacker = createIdentity()
    expect(() => signRequest(intent, attacker.secretHex)).toThrow('named arbiter')
    const decoded = decodeRequest(signRequest(intent, arbiter.secretHex).encoded)
    expect(isCommitmentIntent(decoded.intent)).toBe(true)
    expect(decoded.intent).toMatchObject({payerRole: 'party_a', offerId: '44'.repeat(32), receiverRole: 'arbiter'})
    expect(decoded.event.tags.some(tag => tag.join(':').includes('rider'))).toBe(false)
    expect(decoded.event.tags.some(tag => tag.join(':').includes('driver'))).toBe(false)
  })

  it('requires a 128-bit contract id and rejects unknown request fields', () => {
    const signer = createIdentity()
    expect(() => signRequest({...directIntent(), contractId: '01'.repeat(8)}, signer.secretHex)).toThrow('16 random bytes')
    expect(() => signRequest({...directIntent(), hiddenRule: 'attacker'} as DirectPaymentIntent, signer.secretHex)).toThrow('unknown fields')
  })
})

describe('wire compatibility and input binding', () => {
  it('still decodes an already-issued v1 direct-payment request', () => {
    const signer = createIdentity()
    const legacy: LegacyReceiverLockedIntent = {
      v: 1,
      rideId: randomId(),
      fareVersion: 1,
      purpose: 'fare',
      role: 'driver',
      amount: '21',
      currency: 'sat',
      mint,
      outputHash: outputHashOf(randomSecretHex()),
      expires: Math.floor(Date.now() / 1000) + 300,
      memo: 'legacy payment'
    }
    expect(decodeRequest(signRequest(legacy, signer.secretHex).encoded).intent).toEqual(legacy)
  })

  it('hashes exactly two distinct signed request ids into one order-independent set', () => {
    const first = bondSetHashOf(['11'.repeat(32), '22'.repeat(32)])
    expect(first).toBe(bondSetHashOf(['22'.repeat(32), '11'.repeat(32)]))
    expect(() => bondSetHashOf(['11'.repeat(32), '11'.repeat(32)])).toThrow('different')
  })
})

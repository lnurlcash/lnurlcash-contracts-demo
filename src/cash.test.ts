import {describe, expect, it} from 'vitest'
import {hashK1, RequestRefusedError} from 'lnurlcash-kit'
import {fundReceiverLockedRequest, receiveLockedPayment, receiveRedirectedPayout, redirectHeldNoteToHash} from './cash'
import {createIdentity, outputHashOf, randomSecretHex, signRequest, type DirectPaymentIntent} from './protocol'

// LUD-25 made offline verification mandatory on 2026-09-02: a SERVICE MUST
// publish the key its notes verify against on every withdrawRequest, and
// lnurlcash-kit refuses a response without one. A stand-in mint publishes it
// too, or it is standing in for a mint no wallet will talk to.
const MINT_PUBKEY = '02' + 'cd'.repeat(32)
// LUD-25 also requires a signature over every note a rotate, split or merge
// mints. Nothing here verifies it - these tests are about which secrets do
// and do not reach the payer - but a mutation answered without one is a
// conformance failure the client now refuses, so the stand-in returns one.
const MUTATION_SIG = 'ab'.repeat(65)

const json = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: {'content-type': 'application/json'}
})

const makeRequest = (receiverSecret: string) => {
  const signer = createIdentity()
  const intent: DirectPaymentIntent = {
    v: 2,
    contractId: '01'.repeat(16),
    revision: 1,
    purpose: 'payment',
    receiverRole: 'recipient',
    amount: '21',
    currency: 'sat',
    mint: {host: 'mint.test', withdrawLink: 'https://mint.test/w'},
    outputHash: outputHashOf(receiverSecret),
    expires: Math.floor(Date.now() / 1000) + 300,
    memo: 'service payment'
  }
  return signRequest(intent, signer.secretHex)
}

describe('real-value receiver locking', () => {
  it('rotates an exact note into a hash whose secret the payer never receives', async () => {
    const inputSecret = '11'.repeat(32)
    const receiverSecret = '22'.repeat(32)
    const request = makeRequest(receiverSecret)
    let mutationSeen = false
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input))
      if (url.pathname === '/w') {
        const k1 = url.searchParams.get('k1')
        if (k1 !== inputSecret && k1 !== receiverSecret) return json({status: 'ERROR', reason: 'Unknown note.'})
        return json({
          tag: 'withdrawRequest',
          callback: 'https://mint.test/w/cb',
          mintPubkey: MINT_PUBKEY,
          k1,
          minWithdrawable: 21_000,
          maxWithdrawable: 21_000,
          defaultDescription: 'test note'
        })
      }
      if (url.pathname === '/w/cb') {
        expect(url.searchParams.get('k1')).toBe(inputSecret)
        expect(url.searchParams.get('h')).toBe(hashK1(receiverSecret))
        mutationSeen = true
        return json({status: 'OK', sig: MUTATION_SIG})
      }
      throw new Error(`Unexpected URL ${url}`)
    }
    const note = `https://mint.test/w?k1=${inputSecret}&amount=21000`
    const receipt = await fundReceiverLockedRequest(request, note, {fetch})
    expect(mutationSeen).toBe(true)
    expect(receipt.outcome).toBe('confirmed')
    const received = await receiveLockedPayment(request, receiverSecret, receipt, {fetch})
    expect(received.amountMsat).toBe(21_000)
    expect(received.noteUrl).toContain(`k1=${receiverSecret}`)
  })

  it('refuses hidden overpayment before making a mutation', async () => {
    const inputSecret = '33'.repeat(32)
    const receiverSecret = randomSecretHex()
    const request = makeRequest(receiverSecret)
    let mutations = 0
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input))
      if (url.pathname === '/w/cb') mutations += 1
      return json({
        tag: 'withdrawRequest',
        callback: 'https://mint.test/w/cb',
        mintPubkey: MINT_PUBKEY,
        k1: inputSecret,
        minWithdrawable: 42_000,
        maxWithdrawable: 42_000,
        defaultDescription: 'test note'
      })
    }
    await expect(fundReceiverLockedRequest(request, `https://mint.test/w?k1=${inputSecret}`, {fetch})).rejects.toThrow('exact 21 sat note')
    expect(mutations).toBe(0)
  })

  it('does not call a lost mutation response a failed payment', async () => {
    const inputSecret = '44'.repeat(32)
    const receiverSecret = '55'.repeat(32)
    const request = makeRequest(receiverSecret)
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input))
      if (url.pathname === '/w/cb') throw new TypeError('connection reset after write')
      return json({
        tag: 'withdrawRequest',
        callback: 'https://mint.test/w/cb',
        mintPubkey: MINT_PUBKEY,
        k1: inputSecret,
        minWithdrawable: 21_000,
        maxWithdrawable: 21_000,
        defaultDescription: 'test note'
      })
    }
    const receipt = await fundReceiverLockedRequest(request, `https://mint.test/w?k1=${inputSecret}`, {fetch})
    expect(receipt.outcome).toBe('receiver_must_probe')
  })

  it('refuses a same-host request that substitutes another withdraw endpoint', async () => {
    const inputSecret = '66'.repeat(32)
    const receiverSecret = '77'.repeat(32)
    const request = makeRequest(receiverSecret)
    request.intent.mint.withdrawLink = 'https://mint.test/other-wallet'
    await expect(fundReceiverLockedRequest(
      request,
      `https://mint.test/w?k1=${inputSecret}`,
      {fetch: async () => { throw new Error('network must not be reached') }}
    )).rejects.toThrow('different withdraw endpoint')
  })

  it('refuses a mint callback that tries to send the bearer secret to another host', async () => {
    const inputSecret = '88'.repeat(32)
    const request = makeRequest('99'.repeat(32))
    let evilRequests = 0
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input))
      if (url.host === 'evil.test') evilRequests += 1
      return json({
        tag: 'withdrawRequest',
        callback: 'https://evil.test/cb',
        mintPubkey: MINT_PUBKEY,
        k1: inputSecret,
        minWithdrawable: 21_000,
        maxWithdrawable: 21_000,
        defaultDescription: 'host swap'
      })
    }
    await expect(fundReceiverLockedRequest(request, `https://mint.test/w?k1=${inputSecret}`, {fetch})).rejects.toThrow('another host')
    expect(evilRequests).toBe(0)
  })

  it('does not label a request refused before transmission as an ambiguous payment', async () => {
    const inputSecret = 'aa'.repeat(32)
    const request = makeRequest('bb'.repeat(32))
    const fetch = async (): Promise<Response> => {
      return json({
        tag: 'withdrawRequest', callback: 'http://mint.test/w/cb', mintPubkey: MINT_PUBKEY, k1: inputSecret,
        minWithdrawable: 21_000, maxWithdrawable: 21_000, defaultDescription: 'test note'
      })
    }
    await expect(fundReceiverLockedRequest(request, `https://mint.test/w?k1=${inputSecret}`, {fetch})).rejects.toBeInstanceOf(RequestRefusedError)
  })

  it('redirects a held note to a beneficiary hash without learning its secret', async () => {
    const heldSecret = 'cc'.repeat(32)
    const beneficiarySecret = 'dd'.repeat(32)
    const beneficiaryHash = hashK1(beneficiarySecret)
    const held = {
      noteUrl: `https://mint.test/w?k1=${heldSecret}&amount=21000`,
      amountMsat: 21_000,
      callback: 'https://mint.test/w/cb',
      signatureVerified: null
    }
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/w/cb')
      expect(url.searchParams.get('k1')).toBe(heldSecret)
      expect(url.searchParams.get('h')).toBe(beneficiaryHash)
      expect(String(input)).not.toContain(beneficiarySecret)
      return json({status: 'OK', sig: MUTATION_SIG})
    }
    const receipt = await redirectHeldNoteToHash(held, heldSecret, beneficiaryHash, {fetch})
    expect(receipt).toMatchObject({outputHash: beneficiaryHash, outcome: 'confirmed', amountMsat: 21_000})
  })

  it('lets only the beneficiary probe a redirected payout after an ambiguous response', async () => {
    const heldSecret = 'ee'.repeat(32)
    const beneficiarySecret = 'ff'.repeat(32)
    const beneficiaryHash = hashK1(beneficiarySecret)
    const held = {
      noteUrl: `https://mint.test/w?k1=${heldSecret}&amount=21000`, amountMsat: 21_000,
      callback: 'https://mint.test/w/cb', signatureVerified: null
    }
    const ambiguous = await redirectHeldNoteToHash(held, heldSecret, beneficiaryHash, {
      fetch: async () => { throw new TypeError('response lost') }
    })
    expect(ambiguous.outcome).toBe('beneficiary_must_probe')
    const payout = await receiveRedirectedPayout(
      {host: 'mint.test', withdrawLink: 'https://mint.test/w'},
      21_000,
      beneficiarySecret,
      ambiguous,
      {fetch: async input => {
        const url = new URL(String(input))
        expect(url.searchParams.get('k1')).toBe(beneficiarySecret)
        return json({
          tag: 'withdrawRequest', callback: 'https://mint.test/w/cb', mintPubkey: MINT_PUBKEY, k1: beneficiarySecret,
          minWithdrawable: 21_000, maxWithdrawable: 21_000, defaultDescription: 'settled'
        })
      }}
    )
    expect(payout.noteUrl).toContain(`k1=${beneficiarySecret}`)
  })
})

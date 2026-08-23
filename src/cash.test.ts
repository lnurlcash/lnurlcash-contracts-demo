import {describe, expect, it} from 'vitest'
import {hashK1} from 'lnurlcash-kit'
import {fundReceiverLockedRequest, receiveLockedPayment} from './cash'
import {createIdentity, outputHashOf, randomSecretHex, signRequest, type ReceiverLockedIntent} from './protocol'

const json = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: {'content-type': 'application/json'}
})

const makeRequest = (receiverSecret: string) => {
  const signer = createIdentity()
  const intent: ReceiverLockedIntent = {
    v: 1,
    rideId: '0123456789abcdef',
    fareVersion: 1,
    purpose: 'fare',
    role: 'driver',
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
        return json({status: 'OK'})
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
})

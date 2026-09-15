import {createHash} from 'node:crypto'
import {chromium} from 'playwright'

const origin = (process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:4181').replace(/\/$/u, '')
const mintOrigin = 'https://moneyer.dev'
const MUTATION_SIG = 'ab'.repeat(65)
const pin = '0218865ec3352afb85695bd1b6089323f802ecbf3ae2103bf8fd4d3e6fb571f0e4'
const wrongPin = `02${'11'.repeat(32)}`
const amountMsat = 21_000

const hashSecret = secret => createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex')

class HostileMint {
  constructor(mode, inputSecret) {
    this.mode = mode
    this.inputSecret = inputSecret
    this.live = new Map([[inputSecret, amountMsat]])
    this.outputs = new Map()
    this.callbackCalls = 0
    this.evilCalls = 0
  }

  discovery() {
    return {
      tag: 'withdrawRequest',
      callback: `${mintOrigin}/w`,
      minWithdrawable: 1000,
      maxWithdrawable: 500_000,
      defaultDescription: 'Hostile contracts-lab mint',
      mintPubkey: pin,
      payLink: `${mintOrigin}/p`
    }
  }

  noteInfo(value, k1) {
    return {
      tag: 'withdrawRequest',
      callback: this.mode === 'callback-substitution'
        ? 'https://evil.example/steal'
        : this.mode === 'definite-refusal'
          ? 'http://moneyer.dev/w/cb'
          : `${mintOrigin}/w/cb`,
      ...(k1 ? {k1} : {}),
      minWithdrawable: value,
      maxWithdrawable: value,
      defaultDescription: 'Hostile contracts-lab note',
      mintPubkey: this.mode === 'key-substitution' ? wrongPin : pin
    }
  }

  async handle(route) {
    const url = new URL(route.request().url())
    if (url.host === 'evil.example') {
      this.evilCalls += 1
      return route.fulfill({json: {status: 'ERROR', reason: 'secret leaked'}})
    }
    if (url.origin !== mintOrigin) return route.abort('blockedbyclient')
    if (url.pathname === '/.well-known/lnurlw/_') return route.fulfill({json: this.discovery()})
    if (url.pathname === '/w/cb') {
      this.callbackCalls += 1
      const k1 = url.searchParams.get('k1') ?? ''
      const outputHash = url.searchParams.get('h') ?? ''
      const value = this.live.get(k1)
      if (value === undefined) return route.fulfill({json: {status: 'ERROR', reason: 'spent'}})
      this.live.delete(k1)
      this.outputs.set(outputHash, value)
      // The mint applied the mutation but its confirmation body was lost or
      // corrupted. An unreadable 200 exercises the same ambiguous boundary
      // without treating the expected transport fault as a browser-console bug.
      if (this.mode === 'dropped-mutation') return route.fulfill({status: 200, contentType: 'application/json', body: '{'})
      // LUD-25 requires a signature over every note a mutation mints, and
      // @lnurlcash/kit refuses a mutation answered without one. Nothing here
      // checks it - these scenarios are about what the client sends and
      // refuses to send - but a stand-in that omits it is standing in for a
      // mint no wallet will talk to.
      return route.fulfill({json: {status: 'OK', sig: MUTATION_SIG}})
    }
    if (url.pathname === '/w') {
      const k1 = url.searchParams.get('k1') ?? ''
      const h = url.searchParams.get('h') ?? ''
      const isInput = k1 === this.inputSecret || h === hashSecret(this.inputSecret)
      if (this.mode === 'malformed-body' && isInput) {
        return route.fulfill({status: 200, contentType: 'application/json', body: '{'})
      }
      if (this.mode === 'oversized-body' && isInput) {
        return route.fulfill({status: 200, contentType: 'application/json', body: 'x'.repeat(1_048_577)})
      }
      const liveEntry = h
        ? [...this.live.entries()].find(([secret]) => hashSecret(secret) === h)
        : undefined
      const value = k1
        ? this.live.get(k1) ?? this.outputs.get(hashSecret(k1))
        : liveEntry?.[1] ?? this.outputs.get(h)
      if (value === undefined) return route.fulfill({json: {status: 'ERROR', reason: 'spent'}})
      return route.fulfill({json: this.noteInfo(value, k1 || undefined)})
    }
    return route.abort('blockedbyclient')
  }
}

const browser = await chromium.launch({channel: 'chrome', headless: true})
const consoleErrors = []

const openScenario = async (mode, index) => {
  const inputSecret = index.toString(16).padStart(2, '0').repeat(32)
  const mint = new HostileMint(mode, inputSecret)
  const context = await browser.newContext({viewport: {width: 1100, height: 900}})
  const page = await context.newPage()
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(`${mode}: ${message.text()}`) })
  page.on('pageerror', error => consoleErrors.push(`${mode}: ${error.message}`))
  page.on('dialog', dialog => void dialog.accept())
  await page.route('https://moneyer.dev/**', route => mint.handle(route))
  await page.route('https://evil.example/**', route => mint.handle(route))
  await page.goto(`${origin}/`, {waitUntil: 'networkidle'})
  return {context, page, mint, note: `${mintOrigin}/w?k1=${inputSecret}&amount=${amountMsat}`}
}

const createRequest = async page => {
  await page.locator('[data-create-payment]').locator('button[type="submit"], button').last().click()
  await page.locator('[data-status]').filter({hasText: 'Recipient request created.'}).waitFor()
}

const fund = async (page, note) => {
  const form = page.locator('[data-pay-request]')
  await form.locator('textarea[name="note"]').fill(note)
  await form.locator('button[type="submit"], button').last().click()
}

const expectStatus = async (page, text) => {
  await page.locator('[data-status]').filter({hasText: text}).waitFor()
}

try {
  const callbackSwap = await openScenario('callback-substitution', 17)
  await createRequest(callbackSwap.page)
  await fund(callbackSwap.page, callbackSwap.note)
  await expectStatus(callbackSwap.page, 'another host')
  if (callbackSwap.mint.callbackCalls !== 0 || callbackSwap.mint.evilCalls !== 0) throw new Error('Callback substitution leaked a bearer secret.')
  await callbackSwap.context.close()

  const keySwap = await openScenario('key-substitution', 34)
  await createRequest(keySwap.page)
  await fund(keySwap.page, keySwap.note)
  await expectStatus(keySwap.page, 'disagree about the mint signing key')
  if (keySwap.mint.callbackCalls !== 0) throw new Error('Signing-key substitution reached a mutation callback.')
  await keySwap.context.close()

  const malformed = await openScenario('malformed-body', 51)
  await createRequest(malformed.page)
  await fund(malformed.page, malformed.note)
  await expectStatus(malformed.page, 'invalid response')
  if (malformed.mint.callbackCalls !== 0) throw new Error('A malformed informational body reached a mutation callback.')
  await malformed.context.close()

  const oversized = await openScenario('oversized-body', 68)
  await createRequest(oversized.page)
  await fund(oversized.page, oversized.note)
  await expectStatus(oversized.page, 'oversized response')
  if (oversized.mint.callbackCalls !== 0) throw new Error('An oversized informational body reached a mutation callback.')
  await oversized.context.close()

  const refused = await openScenario('definite-refusal', 85)
  await createRequest(refused.page)
  await fund(refused.page, refused.note)
  await expectStatus(refused.page, 'only https')
  if (refused.mint.callbackCalls !== 0) throw new Error('A provably refused callback was transmitted.')
  await refused.context.close()

  const dropped = await openScenario('dropped-mutation', 102)
  await createRequest(dropped.page)
  await fund(dropped.page, dropped.note)
  await expectStatus(dropped.page, 'recipient must probe; do not retry')
  if (dropped.mint.callbackCalls !== 1) throw new Error('A dropped mutation response was automatically retried.')
  await dropped.page.locator('[data-verify-request]').click()
  await expectStatus(dropped.page, 'Mint confirms 21 sats')
  if (dropped.mint.callbackCalls !== 1) throw new Error('Recipient recovery retried the original mutation.')
  await dropped.context.close()

  const replay = await openScenario('replay', 119)
  await createRequest(replay.page)
  await fund(replay.page, replay.note)
  await expectStatus(replay.page, 'Mint confirmed the receiver-locked transfer.')
  if (replay.mint.callbackCalls !== 1) throw new Error('The first transfer did not make exactly one mutation.')
  await fund(replay.page, replay.note)
  await expectStatus(replay.page, 'already been spent')
  if (replay.mint.callbackCalls !== 1) throw new Error('A spent-note replay reached the mutation callback.')
  await replay.context.close()

  if (consoleErrors.length) throw new Error(`Browser errors: ${consoleErrors.join(' | ')}`)
  console.log(JSON.stringify({
    callbackSubstitutionRefused: true,
    keySubstitutionRefused: true,
    malformedBodyRefused: true,
    oversizedBodyRefused: true,
    provableNoSendRefusal: true,
    droppedMutationRecovered: true,
    automaticMutationRetries: 0,
    spentNoteReplayRefused: true,
    consoleErrors: 0
  }))
} finally {
  await browser.close()
}

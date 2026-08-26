import {createHash} from 'node:crypto'
import {chromium} from 'playwright'

const origin = (process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:4181').replace(/\/$/u, '')
const mintOrigin = 'https://mint.forgesworn.dev'
const pin = '03bcd4846649e7b7d27e044ed7305547a5cf0209bd9629aa1de67f47d0c41b4407'
const storeKey = 'lnurlcash_contracts_demo_v2'
const inputA = 'aa'.repeat(32)
const inputB = 'bb'.repeat(32)

const hashSecret = secret => createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex')

class StatefulMockMint {
  constructor() {
    this.live = new Map([[inputA, 10_000], [inputB, 15_000]])
    this.outputs = new Map()
    this.callbackCalls = 0
  }

  discovery() {
    return {
      tag: 'withdrawRequest',
      callback: `${mintOrigin}/w`,
      minWithdrawable: 1000,
      maxWithdrawable: 500_000,
      defaultDescription: 'Contracts-lab lifecycle mint',
      mintPubkey: pin,
      payLink: `${mintOrigin}/p`
    }
  }

  async handle(route) {
    const url = new URL(route.request().url())
    if (url.pathname === '/.well-known/lnurlw/_') return route.fulfill({json: this.discovery()})
    if (url.pathname === '/w') {
      const k1 = url.searchParams.get('k1') ?? ''
      const value = this.live.get(k1) ?? this.outputs.get(hashSecret(k1))
      if (value === undefined) return route.fulfill({json: {status: 'ERROR', reason: 'spent'}})
      return route.fulfill({json: {
        tag: 'withdrawRequest',
        callback: `${mintOrigin}/w/cb`,
        k1,
        minWithdrawable: value,
        maxWithdrawable: value,
        defaultDescription: 'Contracts-lab lifecycle note',
        mintPubkey: pin
      }})
    }
    if (url.pathname === '/w/cb') {
      this.callbackCalls += 1
      const k1 = url.searchParams.get('k1') ?? ''
      const outputHash = url.searchParams.get('h') ?? ''
      const heldHash = hashSecret(k1)
      const value = this.live.get(k1) ?? this.outputs.get(heldHash)
      if (value === undefined) return route.fulfill({json: {status: 'ERROR', reason: 'spent'}})
      this.live.delete(k1)
      this.outputs.delete(heldHash)
      this.outputs.set(outputHash, value)
      // Calls one and two fund the arbiter. Call three is the first settlement
      // leg: apply it, then lose the confirmation body. The browser must stop,
      // let the beneficiary probe, reconcile the signed acknowledgement and
      // only then continue to call four for the second leg.
      if (this.callbackCalls === 3) return route.fulfill({status: 200, contentType: 'application/json', body: '{'})
      return route.fulfill({json: {status: 'OK'}})
    }
    return route.abort('blockedbyclient')
  }
}

const mint = new StatefulMockMint()
const browser = await chromium.launch({channel: 'chrome', headless: true})
const errors = []

const makePage = async viewport => {
  const context = await browser.newContext({viewport})
  const page = await context.newPage()
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => void dialog.accept())
  await page.route('https://mint.forgesworn.dev/**', route => mint.handle(route))
  await page.goto(`${origin}/`, {waitUntil: 'networkidle'})
  return {context, page}
}

const waitStatus = (page, text) => page.locator('[data-status]').filter({hasText: text}).waitFor()

const openMessage = async (page, encoded) => {
  await page.goto('about:blank')
  await page.goto(`${origin}/#${new URLSearchParams({message: encoded})}`, {waitUntil: 'networkidle'})
  await page.locator('[data-import-incoming-message]').click()
  await waitStatus(page, 'Signed contract message verified and imported.')
}

const openPacket = async (page, packet) => {
  await page.goto('about:blank')
  await page.goto(`${origin}/#${new URLSearchParams({packet})}`, {waitUntil: 'networkidle'})
  await page.locator('[data-import-incoming-packet]').click()
  await waitStatus(page, 'Every signed packet component verified and imported.')
}

const importPayload = async (page, encoded) => {
  const form = page.locator('[data-import-contract]')
  await form.locator('textarea[name="encoded"]').fill(encoded)
  await form.locator('button').click()
  await waitStatus(page, 'Signed payload verified and imported.')
}

const contractRecord = page => page.evaluate(key => {
  const state = JSON.parse(localStorage.getItem(key))
  return Object.values(state.contracts)[0]
}, storeKey)

try {
  const partyA = await makePage({width: 1100, height: 900})
  const partyB = await makePage({width: 1100, height: 900})
  const arbiter = await makePage({width: 1440, height: 1000})

  await partyA.page.locator('[data-create-enrolment="party_a"]').click()
  await waitStatus(partyA.page, 'party a enrolment signed')
  const enrolmentA = await partyA.page.locator('article.card').filter({hasText: 'Party A · key'}).locator('textarea').inputValue()
  await partyB.page.locator('[data-create-enrolment="party_b"]').click()
  await waitStatus(partyB.page, 'party b enrolment signed')
  const enrolmentB = await partyB.page.locator('article.card').filter({hasText: 'Party B · key'}).locator('textarea').inputValue()

  await arbiter.page.locator('[data-create-arbiter]').click()
  const offerForm = arbiter.page.locator('[data-create-contract]')
  await offerForm.locator('textarea[name="enrolmentA"]').fill(enrolmentA)
  await offerForm.locator('textarea[name="enrolmentB"]').fill(enrolmentB)
  await offerForm.locator('textarea[name="memo"]').fill('Stateful mock lifecycle with an ambiguous first settlement leg.')
  await offerForm.locator('button[type="submit"], button').last().click()
  await waitStatus(arbiter.page, 'Canonical offer signed')
  const offer = await arbiter.page.locator('.contract-summary [data-share-kind="message"]').getAttribute('data-share')
  if (!offer?.startsWith('cashmsg1')) throw new Error('The mock lifecycle offer is missing.')

  await openMessage(partyA.page, offer)
  await partyA.page.locator('[data-accept-role="party_a"]').click()
  await waitStatus(partyA.page, 'accepted. Two private payout secrets')
  const acceptanceA = await partyA.page.locator('article.card').filter({hasText: 'Rider · acceptance'}).locator('[data-share-kind="message"]').getAttribute('data-share')
  await openMessage(partyB.page, offer)
  await partyB.page.locator('[data-accept-role="party_b"]').click()
  await waitStatus(partyB.page, 'accepted. Two private payout secrets')
  const acceptanceB = await partyB.page.locator('article.card').filter({hasText: 'Driver · acceptance'}).locator('[data-share-kind="message"]').getAttribute('data-share')
  if (!acceptanceA || !acceptanceB) throw new Error('The mock lifecycle acceptances are missing.')

  await importPayload(arbiter.page, acceptanceA)
  await importPayload(arbiter.page, acceptanceB)
  await arbiter.page.locator('[data-create-packet]').click()
  await waitStatus(arbiter.page, 'Both arbiter-held receiver secrets were persisted')
  const packet = await arbiter.page.locator('[data-share-kind="packet"]').getAttribute('data-share')
  if (!packet?.startsWith('cashpacket1')) throw new Error('The mock lifecycle packet is missing.')
  await openPacket(partyA.page, packet)
  await openPacket(partyB.page, packet)

  const fundBond = async (party, role, note, label) => {
    const form = party.page.locator(`[data-fund-contract="${role}"]`)
    await form.locator('textarea[name="note"]').fill(note)
    await form.locator('button').click()
    await waitStatus(party.page, 'Funding submitted and a named-payer acknowledgement signed.')
    const ack = await party.page.locator('article.card').filter({hasText: label}).locator('[data-share-kind="message"]').last().getAttribute('data-share')
    if (!ack?.startsWith('cashmsg1')) throw new Error(`${label} funding acknowledgement is missing.`)
    return ack
  }
  const fundingAckA = await fundBond(partyA, 'party_a', `${mintOrigin}/w?k1=${inputA}&amount=10000`, 'Rider · 10 sat bond')
  const fundingAckB = await fundBond(partyB, 'party_b', `${mintOrigin}/w?k1=${inputB}&amount=15000`, 'Driver · 15 sat bond')
  await importPayload(arbiter.page, fundingAckB)
  await importPayload(arbiter.page, fundingAckA)

  await arbiter.page.locator('[data-verify-bond="party_a"]').click()
  await waitStatus(arbiter.page, 'independently verified 10 sats')
  await arbiter.page.locator('[data-verify-bond="party_b"]').click()
  await waitStatus(arbiter.page, 'independently verified 15 sats')
  const activation = await arbiter.page.locator('.state-list').textContent()
  if (!activation?.includes('both held + both acknowledged')) throw new Error(`Mock lifecycle did not activate: ${activation}`)

  await partyA.page.locator('[data-sign-outcome="complete"][data-sign-role="party_a"]').click()
  await waitStatus(partyA.page, 'signed complete')
  const outcomeA = await partyA.page.locator('.message-list [data-share-kind="message"]').last().getAttribute('data-share')
  await partyB.page.locator('[data-sign-outcome="complete"][data-sign-role="party_b"]').click()
  await waitStatus(partyB.page, 'signed complete')
  const outcomeB = await partyB.page.locator('.message-list [data-share-kind="message"]').last().getAttribute('data-share')
  if (!outcomeA || !outcomeB) throw new Error('The completion messages are missing.')
  await importPayload(arbiter.page, outcomeB)
  await importPayload(arbiter.page, outcomeA)

  await arbiter.page.locator('[data-settle-contract]').click()
  await waitStatus(arbiter.page, 'beneficiary must probe its signed payout target')
  let record = await contractRecord(arbiter.page)
  if (record.settlementNotices.length !== 1) throw new Error('The ambiguous first leg did not publish exactly one signed notice.')
  const noticeA = record.settlementNotices[0]
  await importPayload(partyA.page, noticeA)
  await partyA.page.locator('[data-probe-payout]').click()
  await waitStatus(partyA.page, 'Beneficiary independently found the redirected payout.')
  const ackA = (await contractRecord(partyA.page)).payoutAcks[0]
  if (!ackA) throw new Error('Party A payout acknowledgement is missing.')
  await importPayload(arbiter.page, ackA)
  await arbiter.page.locator('[data-reconcile-payout]').click()
  await waitStatus(arbiter.page, 'reconciled the ambiguous leg')

  await arbiter.page.locator('[data-settle-contract]').click()
  await waitStatus(arbiter.page, 'Held inputs were redirected only')
  record = await contractRecord(arbiter.page)
  if (record.settlementNotices.length !== 2) throw new Error('The confirmed second leg did not publish its signed notice.')
  const noticeB = record.settlementNotices[1]
  await importPayload(partyB.page, noticeB)
  await partyB.page.locator('[data-probe-payout]').click()
  await waitStatus(partyB.page, 'Beneficiary independently found the redirected payout.')
  const ackB = (await contractRecord(partyB.page)).payoutAcks[0]
  if (!ackB) throw new Error('Party B payout acknowledgement is missing.')
  await importPayload(arbiter.page, ackB)

  const finalArbiter = await arbiter.page.evaluate(key => {
    const state = JSON.parse(localStorage.getItem(key))
    const contract = Object.values(state.contracts)[0]
    return {
      fundingAcks: Object.keys(contract.fundingAcks).length,
      outcomes: contract.outcomes.length,
      notices: contract.settlementNotices.length,
      payoutAcks: contract.payoutAcks.length,
      settlementStates: state.settlements.map(item => item.state)
    }
  }, storeKey)
  if (JSON.stringify(finalArbiter) !== JSON.stringify({
    fundingAcks: 2,
    outcomes: 2,
    notices: 2,
    payoutAcks: 2,
    settlementStates: ['confirmed', 'confirmed']
  })) throw new Error(`Unexpected final mock lifecycle state: ${JSON.stringify(finalArbiter)}`)
  if (mint.callbackCalls !== 4) throw new Error(`Expected four serialised mutations, saw ${mint.callbackCalls}.`)
  if (mint.outputs.size !== 2) throw new Error('The mock mint did not end with exactly two beneficiary-owned outputs.')
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`)

  console.log(JSON.stringify({
    separateProfiles: 3,
    exactBondInputs: 2,
    fundingAcknowledgements: 2,
    arbiterMintProbes: 2,
    matchingCompletionStatements: 2,
    ambiguousFirstLegStopped: true,
    beneficiaryAcknowledgementReconciled: true,
    secondLegResumed: true,
    signedSettlementNotices: 2,
    signedPayoutAcknowledgements: 2,
    automaticMutationRetries: 0,
    finalBeneficiaryOutputs: 2,
    realSatsMoved: false,
    consoleErrors: 0
  }))
} finally {
  await browser.close()
}

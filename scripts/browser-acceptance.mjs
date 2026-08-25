import {chromium} from 'playwright'

const origin = (process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:4181').replace(/\/$/u, '')
const artifactDirectory = process.env.ARTIFACT_DIR ?? '/tmp'
const browser = await chromium.launch({channel: 'chrome', headless: true})
const errors = []
const pin = '03bcd4846649e7b7d27e044ed7305547a5cf0209bd9629aa1de67f47d0c41b4407'
const discovery = {
  tag: 'withdrawRequest',
  callback: 'https://mint.forgesworn.dev/w',
  minWithdrawable: 1000,
  maxWithdrawable: 500000,
  defaultDescription: 'Contracts lab test mint',
  mintPubkey: pin,
  payLink: 'https://mint.forgesworn.dev/p'
}

try {
  const makePage = async viewport => {
    const context = await browser.newContext({viewport})
    const page = await context.newPage()
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    if (process.env.LIVE_MINT !== '1') {
      await page.route('https://mint.forgesworn.dev/.well-known/lnurlw/_', route => route.fulfill({json: discovery}))
    }
    await page.goto(`${origin}/`, {waitUntil: 'networkidle'})
    return {context, page}
  }

  const partyA = await makePage({width: 1100, height: 900})
  const partyB = await makePage({width: 1100, height: 900})
  const arbiter = await makePage({width: 1440, height: 1000})

  await partyA.page.locator('[data-create-enrolment="party_a"]').click()
  const enrolmentA = await partyA.page.locator('article.card').filter({hasText: 'Party A · key'}).locator('textarea').inputValue()
  if (!enrolmentA.startsWith('cashmsg1')) throw new Error('Party A enrolment is missing.')

  await partyB.page.locator('[data-create-enrolment="party_b"]').click()
  const enrolmentB = await partyB.page.locator('article.card').filter({hasText: 'Party B · key'}).locator('textarea').inputValue()
  if (!enrolmentB.startsWith('cashmsg1')) throw new Error('Party B enrolment is missing.')

  await arbiter.page.locator('[data-create-arbiter]').click()
  const offerForm = arbiter.page.locator('[data-create-contract]')
  await offerForm.locator('select[name="template"]').selectOption('delivery')
  await offerForm.locator('input[name="title"]').fill('Deliver a signed test parcel')
  await offerForm.locator('textarea[name="enrolmentA"]').fill(enrolmentA)
  await offerForm.locator('textarea[name="enrolmentB"]').fill(enrolmentB)
  await offerForm.locator('textarea[name="memo"]').fill('Three-profile browser acceptance without moving sats.')
  await offerForm.locator('button[type="submit"], button').last().click()
  await arbiter.page.locator('.contract-summary').waitFor({state: 'visible'})
  if (!await arbiter.page.locator('.contract-summary').getByText('Customer', {exact: true}).count()) throw new Error('Delivery Party A label was not applied.')
  if (!await arbiter.page.locator('.contract-summary').getByText('Courier', {exact: true}).count()) throw new Error('Delivery Party B label was not applied.')
  const offer = await arbiter.page.locator('.contract-summary [data-share-kind="message"]').getAttribute('data-share')
  if (!offer?.startsWith('cashmsg1')) throw new Error('Arbiter offer is missing.')

  const openMessage = async (page, encoded) => {
    await page.goto('about:blank')
    await page.goto(`${origin}/#${new URLSearchParams({message: encoded})}`, {waitUntil: 'networkidle'})
    await page.locator('[data-status]').evaluate(node => { node.textContent = '' })
    await page.locator('[data-import-incoming-message]').click()
    await page.locator('[data-status]').filter({hasText: 'Signed contract message verified and imported.'}).waitFor()
  }
  await openMessage(partyA.page, offer)
  await partyA.page.locator('[data-accept-role="party_a"]').click()
  const acceptanceA = await partyA.page.locator('article.card').filter({hasText: 'Customer · acceptance'}).locator('[data-share-kind="message"]').getAttribute('data-share')
  if (!acceptanceA?.startsWith('cashmsg1')) throw new Error('Party A acceptance is missing.')

  await openMessage(partyB.page, offer)
  await partyB.page.locator('[data-accept-role="party_b"]').click()
  const acceptanceB = await partyB.page.locator('article.card').filter({hasText: 'Courier · acceptance'}).locator('[data-share-kind="message"]').getAttribute('data-share')
  if (!acceptanceB?.startsWith('cashmsg1')) throw new Error('Party B acceptance is missing.')

  const importPayload = async (page, encoded, expectedStatus = 'Signed payload verified and imported.') => {
    const form = page.locator('[data-import-contract]')
    await form.locator('textarea[name="encoded"]').fill(encoded)
    await page.locator('[data-status]').evaluate(node => { node.textContent = '' })
    await form.locator('button').click()
    await page.locator('[data-status]').filter({hasText: expectedStatus}).waitFor()
  }
  await importPayload(arbiter.page, acceptanceA)
  await importPayload(arbiter.page, acceptanceB)
  await arbiter.page.locator('[data-create-packet]').click()
  const packet = await arbiter.page.locator('[data-share-kind="packet"]').getAttribute('data-share')
  if (!packet?.startsWith('cashpacket1')) throw new Error('The full activation packet is missing.')

  const packetRequests = []
  partyA.page.on('request', request => packetRequests.push(request.url()))
  partyB.page.on('request', request => packetRequests.push(request.url()))
  const openPacket = async page => {
    await page.goto('about:blank')
    await page.goto(`${origin}/#${new URLSearchParams({packet})}`, {waitUntil: 'networkidle'})
    await page.locator('[data-status]').evaluate(node => { node.textContent = '' })
    await page.locator('[data-import-incoming-packet]').click()
    await page.locator('[data-status]').filter({hasText: 'Every signed packet component verified and imported.'}).waitFor()
  }
  await openPacket(partyA.page)
  await openPacket(partyB.page)
  if (packetRequests.some(url => url.includes('cashpacket1') || url.includes(packet.slice(0, 80)))) throw new Error('A packet fragment leaked into an HTTP request.')

  const storeKey = 'lnurlcash_contracts_demo_v2'
  const intactPartyAStore = await partyA.page.evaluate(key => localStorage.getItem(key), storeKey)
  await partyA.page.evaluate(key => {
    const state = JSON.parse(localStorage.getItem(key))
    const target = Object.values(state.payoutTargets)[0].party_a
    target.secrets.party_b = '00'.repeat(32)
    localStorage.setItem(key, JSON.stringify(state))
  }, storeKey)
  await partyA.page.reload({waitUntil: 'networkidle'})
  await importPayload(partyA.page, packet, "payout target does not match this browser's private secret")
  const continuityError = await partyA.page.locator('[data-status]').textContent()
  if (!continuityError?.includes("payout target does not match this browser's private secret")) throw new Error('A locally corrupted payout secret was not visibly refused.')
  await partyA.page.evaluate(({key, value}) => localStorage.setItem(key, value), {key: storeKey, value: intactPartyAStore})
  await partyA.page.reload({waitUntil: 'networkidle'})

  await partyA.page.locator('[data-sign-outcome="complete"][data-sign-role="party_a"]').click()
  const outcomeA = await partyA.page.locator('.message-list [data-share-kind="message"]').last().getAttribute('data-share')
  await partyB.page.locator('[data-sign-outcome="complete"][data-sign-role="party_b"]').click()
  const outcomeB = await partyB.page.locator('.message-list [data-share-kind="message"]').last().getAttribute('data-share')
  if (!outcomeA?.startsWith('cashmsg1') || !outcomeB?.startsWith('cashmsg1')) throw new Error('Portable completion outcomes are missing.')
  await importPayload(arbiter.page, outcomeA)
  await importPayload(arbiter.page, outcomeB)
  if (!await arbiter.page.locator('.state-list').getByText(/Outcome authority · complete/u).count()) throw new Error('Two remote completion signatures did not become executable authority.')
  if (await arbiter.page.locator('[data-settle-contract]').count()) throw new Error('Settlement became available without both held outputs and funding acknowledgements.')

  await partyA.page.locator('[data-sign-outcome="dispute"][data-sign-role="party_a"]').click()
  const dispute = await partyA.page.locator('.message-list [data-share-kind="message"]').last().getAttribute('data-share')
  if (!dispute?.startsWith('cashmsg1')) throw new Error('Portable dispute is missing.')
  await importPayload(arbiter.page, dispute)
  const authorityState = await arbiter.page.locator('.state-list').textContent()
  if (!authorityState?.includes('A participant raised a dispute.')) throw new Error(`A signed dispute did not override matching completion before settlement: ${authorityState}`)
  if (await arbiter.page.locator('[data-create-decision]').count() !== 1) throw new Error('The arbiter decision form did not appear for the signed dispute.')

  const stateOf = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storeKey)
  const stateA = await stateOf(partyA.page)
  const stateB = await stateOf(partyB.page)
  const stateArbiter = await stateOf(arbiter.page)
  if (JSON.stringify(Object.keys(stateA.identities).sort()) !== JSON.stringify(['party_a'])) throw new Error('Party A browser owns an unexpected identity.')
  if (JSON.stringify(Object.keys(stateB.identities).sort()) !== JSON.stringify(['party_b'])) throw new Error('Party B browser owns an unexpected identity.')
  if (JSON.stringify(Object.keys(stateArbiter.identities).sort()) !== JSON.stringify(['arbiter'])) throw new Error('Arbiter browser owns an unexpected identity.')
  const hashesA = Object.values(stateA.payoutTargets)[0].party_a.outputHashes
  const hashesB = Object.values(stateB.payoutTargets)[0].party_b.outputHashes
  if (new Set([...Object.values(hashesA), ...Object.values(hashesB)]).size !== 4) throw new Error('The four beneficiary/source payout hashes are not unique.')
  if (Object.keys(stateArbiter.payoutTargets).length) throw new Error('The arbiter browser learned participant payout secrets.')

  const hostile = await makePage({width: 800, height: 700})
  const last = offer.at(-1)
  const tampered = `${offer.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`
  await hostile.page.goto('about:blank')
  await hostile.page.goto(`${origin}/#${new URLSearchParams({message: tampered})}`, {waitUntil: 'networkidle'})
  if (!await hostile.page.locator('.incoming--bad').textContent()) throw new Error('A tampered offer was not visibly refused.')
  if (await hostile.page.locator('[data-import-incoming-message]').count()) throw new Error('A tampered offer remained importable.')

  await arbiter.page.screenshot({path: `${artifactDirectory}/cash-contracts-arbiter.png`, fullPage: true})
  await partyA.page.setViewportSize({width: 390, height: 844})
  await partyA.page.screenshot({path: `${artifactDirectory}/cash-contracts-party-a-mobile.png`, fullPage: true})

  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify({
    separateProfiles: 3,
    neutralDeliveryLabels: true,
    enrolments: 2,
    independentAcceptances: 2,
    uniquePayoutTargets: 4,
    packetComponentsReverified: true,
    packetFragmentStayedClientSide: true,
    localPayoutContinuityRefused: true,
    portableOutcomeSignatures: 3,
    disputeOverrodeCompletion: true,
    activationFailedClosedWithoutMoney: true,
    arbiterPayoutSecrets: 0,
    tamperedOfferRefused: true,
    consoleErrors: 0
  }))
} finally {
  await browser.close()
}

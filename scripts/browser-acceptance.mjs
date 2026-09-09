import {chromium} from 'playwright'

const origin = (process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:4181').replace(/\/$/u, '')
const artifactDirectory = process.env.ARTIFACT_DIR ?? '/tmp'
const browser = await chromium.launch({channel: 'chrome', headless: true})
const errors = []
const pin = '0218865ec3352afb85695bd1b6089323f802ecbf3ae2103bf8fd4d3e6fb571f0e4'
const discovery = {
  tag: 'withdrawRequest',
  callback: 'https://moneyer.dev/w',
  minWithdrawable: 1000,
  maxWithdrawable: 500000,
  defaultDescription: 'Contracts lab test mint',
  mintPubkey: pin,
  payLink: 'https://moneyer.dev/.well-known/lnurlp/_'
}

try {
  const makePage = async viewport => {
    const context = await browser.newContext({viewport})
    const page = await context.newPage()
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    if (process.env.LIVE_MINT !== '1') {
      await page.route('https://moneyer.dev/.well-known/lnurlw/_', route => route.fulfill({json: discovery}))
    }
    await page.goto(`${origin}/`, {waitUntil: 'networkidle'})
    return {context, page}
  }

  const partyA = await makePage({width: 1100, height: 900})
  const partyB = await makePage({width: 1100, height: 900})
  const coordinator = await makePage({width: 1440, height: 1000})

  const forbiddenSelectors = [
    '[data-create-packet]', '[data-fund-contract]', '[data-verify-bond]', '[data-sign-outcome]',
    '[data-create-decision]', '[data-settle-contract]', '[data-abort-setup]', '[data-timeout-contract]',
    '[data-probe-payout]', '[data-reconcile-payout]'
  ]
  for (const {page} of [partyA, partyB, coordinator]) {
    if (!await page.getByText('New arbiter-held bonds are disabled.').count()) throw new Error('The public custody boundary is not visible.')
    if (!await page.getByText('Protocol demo, not an escrow service.').count()) throw new Error('The publisher/implementer boundary is not visible.')
    if ((await page.locator('body').textContent())?.includes('UK commercial pilot blocked')) throw new Error('The retired blanket UK block is still visible.')
    for (const selector of forbiddenSelectors) {
      if (await page.locator(selector).count()) throw new Error(`Forbidden custody control is present: ${selector}`)
    }
  }

  await partyA.page.locator('[data-create-enrolment="party_a"]').click()
  const enrolmentA = await partyA.page.locator('article.card').filter({hasText: 'Party A · key'}).locator('textarea').inputValue()
  await partyB.page.locator('[data-create-enrolment="party_b"]').click()
  const enrolmentB = await partyB.page.locator('article.card').filter({hasText: 'Party B · key'}).locator('textarea').inputValue()
  if (!enrolmentA.startsWith('cashmsg1') || !enrolmentB.startsWith('cashmsg1')) throw new Error('Independent enrolments are missing.')

  await coordinator.page.locator('[data-create-arbiter]').click()
  const offerForm = coordinator.page.locator('[data-create-contract]')
  await offerForm.locator('select[name="template"]').selectOption('ride')
  await offerForm.locator('textarea[name="enrolmentA"]').fill(enrolmentA)
  await offerForm.locator('textarea[name="enrolmentB"]').fill(enrolmentB)
  await offerForm.locator('textarea[name="memo"]').fill('Remote evidence-only acceptance. No bond funding.')
  await offerForm.locator('button').last().click()
  await coordinator.page.locator('.contract-summary').waitFor()
  const offer = await coordinator.page.locator('.contract-summary [data-share-kind="message"]').getAttribute('data-share')
  if (!offer?.startsWith('cashmsg1')) throw new Error('Evidence-only offer is missing.')

  const openMessage = async (page, encoded) => {
    await page.goto('about:blank')
    await page.goto(`${origin}/#${new URLSearchParams({message: encoded})}`, {waitUntil: 'networkidle'})
    await page.locator('[data-import-incoming-message]').click()
    await page.locator('[data-status]').filter({hasText: 'Signed contract message verified and imported.'}).waitFor()
  }
  await openMessage(partyA.page, offer)
  await partyA.page.locator('[data-accept-role="party_a"]').click()
  await partyA.page.locator('[data-status]').filter({hasText: 'No bond was created or funded.'}).waitFor()
  const acceptanceA = await partyA.page.locator('article.card').filter({hasText: 'Rider · acceptance'}).locator('[data-share-kind="message"]').getAttribute('data-share')
  await openMessage(partyB.page, offer)
  await partyB.page.locator('[data-accept-role="party_b"]').click()
  await partyB.page.locator('[data-status]').filter({hasText: 'No bond was created or funded.'}).waitFor()
  const acceptanceB = await partyB.page.locator('article.card').filter({hasText: 'Driver · acceptance'}).locator('[data-share-kind="message"]').getAttribute('data-share')
  if (!acceptanceA?.startsWith('cashmsg1') || !acceptanceB?.startsWith('cashmsg1')) throw new Error('Independent acceptances are missing.')

  const importMessage = async (encoded, expectedAcceptances) => {
    const form = coordinator.page.locator('[data-import-contract]')
    await form.locator('textarea[name="encoded"]').fill(encoded)
    await form.locator('button').click()
    await coordinator.page.locator('.state-list').filter({hasText: `Independent acceptance · ${expectedAcceptances}/2`}).waitFor()
    await coordinator.page.locator('[data-status]').filter({hasText: 'Evidence-only signed message verified and imported.'}).waitFor()
  }
  await importMessage(acceptanceA, 1)
  await importMessage(acceptanceB, 2)
  const stateText = await coordinator.page.locator('.state-list').textContent()
  if (!stateText?.includes('Independent acceptance · 2/2') || !stateText.includes('Real bond funding · disabled')) {
    throw new Error(`The evidence agreement did not stop at the public boundary: ${stateText}`)
  }

  await coordinator.page.goto('about:blank')
  await coordinator.page.goto(`${origin}/#${new URLSearchParams({packet: 'cashpacket1historical'})}`, {waitUntil: 'networkidle'})
  const refusal = await coordinator.page.locator('.incoming--bad').textContent()
  if (!refusal?.includes('Historical custodial bond packets are not accepted')) throw new Error('A historical bond packet was not visibly refused.')
  if (await coordinator.page.locator('[data-import-incoming-packet]').count()) throw new Error('A refused packet remained importable.')

  await coordinator.page.goto(`${origin}/`, {waitUntil: 'networkidle'})
  const calculator = coordinator.page.locator('[data-cancellation-model]')
  await calculator.locator('input[name="price"]').fill('1000')
  await calculator.locator('input[name="loss"]').fill('400')
  await calculator.locator('input[name="notice"]').fill('12')
  await calculator.locator('button').click()
  if (!await coordinator.page.locator('[data-cancellation-result]').getByText('250 sats').count()) throw new Error('The 25% late-cancellation cap was not rendered.')
  await calculator.locator('select[name="reason"]').selectOption('safety')
  await calculator.locator('button').click()
  if (!await coordinator.page.locator('[data-cancellation-result]').getByText('0 sats').count()) throw new Error('The safety exception did not reduce the recommendation to zero.')

  const directForm = coordinator.page.locator('[data-create-payment]')
  await directForm.locator('input[name="amount"]').fill('21')
  await directForm.locator('button').click()
  await coordinator.page.locator('[data-status]').filter({hasText: 'Recipient request created.'}).waitFor()
  if (!await coordinator.page.locator('[data-pay-request]').count()) throw new Error('The recipient-owned direct-payment flow disappeared.')

  await coordinator.page.screenshot({path: `${artifactDirectory}/cash-contracts-public-boundary.png`, fullPage: true})
  await partyA.page.setViewportSize({width: 390, height: 844})
  await partyA.page.screenshot({path: `${artifactDirectory}/cash-contracts-evidence-mobile.png`, fullPage: true})

  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`)
  console.log(JSON.stringify({
    separateProfiles: 3,
    independentEnrolments: 2,
    independentAcceptances: 2,
    bondFundingControls: 0,
    settlementControls: 0,
    historicalPacketRefused: true,
    proportionalCancellationRendered: true,
    protectedCancellationRendered: true,
    directRecipientOwnedPaymentAvailable: true,
    realSatsMoved: false,
    consoleErrors: 0
  }))
} finally {
  await browser.close()
}

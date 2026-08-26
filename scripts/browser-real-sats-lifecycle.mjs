import {mkdirSync} from 'node:fs'
import {chromium} from 'playwright'

if (process.env.REAL_SATS !== '25_SAT_ACCEPTANCE') {
  throw new Error('Refusing real value. Set REAL_SATS=25_SAT_ACCEPTANCE only for the capped funded acceptance run.')
}

const origin = (process.env.DEMO_ORIGIN ?? 'https://labs.moneyer.dev').replace(/\/$/u, '')
if (origin !== 'https://labs.moneyer.dev') throw new Error('The funded acceptance is pinned to https://labs.moneyer.dev.')
const walletHome = process.env.NOTECASE_HOME
const walletPin = process.env.NOTECASE_PIN
if (!walletHome || !walletPin) throw new Error('The isolated Notecase home and PIN are required.')

const notecaseModule = new URL('../../notecase/dist/index.js', import.meta.url)
const {Wallet, createWalletFetch, openWallet} = await import(notecaseModule.href)
const walletStore = await openWallet({home: walletHome, pin: walletPin})
const wallet = new Wallet(walletStore.data, walletStore.save, {fetch: createWalletFetch()})
const mintHost = 'mint.forgesworn.dev'
const storeKey = 'lnurlcash_contracts_demo_v2'
const profileRoot = `${walletHome}/browser-profiles`
mkdirSync(profileRoot, {recursive: true, mode: 0o700})

const consoleErrors = []
const contexts = []

const makePage = async (name, viewport) => {
  const context = await chromium.launchPersistentContext(`${profileRoot}/${name}`, {
    channel: 'chrome',
    headless: true,
    viewport
  })
  contexts.push(context)
  const pages = context.pages()
  const page = pages[0] ?? await context.newPage()
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(`${name}: ${message.text()}`) })
  page.on('pageerror', error => consoleErrors.push(`${name}: ${error.message}`))
  page.on('dialog', dialog => void dialog.accept())
  await page.goto(`${origin}/`, {waitUntil: 'networkidle'})
  return {context, page}
}

const waitStatus = (page, text) => page.locator('[data-status]').filter({hasText: text}).waitFor()

const clickAndWaitForFreshStatus = async (page, locator, text) => {
  await page.locator('[data-status]').evaluate(element => { element.textContent = '' })
  await locator.click()
  await waitStatus(page, text)
}

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
  await clickAndWaitForFreshStatus(page, form.locator('button'), 'Signed payload verified and imported.')
}

const browserStore = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storeKey)
const contractRecord = async page => Object.values((await browserStore(page)).contracts)[0]

try {
  const partyA = await makePage('party-a', {width: 1100, height: 900})
  const partyB = await makePage('party-b', {width: 1100, height: 900})
  const arbiter = await makePage('arbiter', {width: 1440, height: 1000})

  const existingInputs = wallet.sentNotes().filter(note => note.mintHost === mintHost && note.amountMsat === 10_000)
  const profileStates = await Promise.all([partyA.page, partyB.page, arbiter.page].map(browserStore))
  const isPopulated = state => Boolean(state && (Object.keys(state.contracts ?? {}).length || Object.keys(state.identities ?? {}).length))
  const resuming = profileStates.some(isPopulated)
  let noteA
  let noteB

  if (resuming) {
    if (process.env.REAL_SATS_RECOVERY !== 'FUNDED_PROFILE') {
      throw new Error('Persistent profiles contain a ceremony. Refuse a second spend; set REAL_SATS_RECOVERY=FUNDED_PROFILE only to continue it.')
    }
    if (!profileStates.every(isPopulated)) throw new Error('Only some persistent profiles contain state; manual inspection is required.')
    const expectedRoles = [['party_a'], ['party_b'], ['arbiter']]
    const contractIds = []
    for (let index = 0; index < profileStates.length; index += 1) {
      const state = profileStates[index]
      const roles = Object.keys(state.identities ?? {}).sort()
      if (roles.join(',') !== expectedRoles[index].join(',')) throw new Error('A persistent profile owns an unexpected identity.')
      const ids = Object.keys(state.contracts ?? {})
      if (ids.length !== 1) throw new Error('A persistent profile does not contain exactly one recoverable contract.')
      contractIds.push(ids[0])
    }
    if (new Set(contractIds).size !== 1) throw new Error('The persistent profiles do not refer to the same contract.')
    if (existingInputs.length !== 2 || existingInputs[0].id === existingInputs[1].id) {
      throw new Error('The encrypted wallet does not contain exactly two distinct sent 10-sat inputs for recovery.')
    }
    ;[noteA, noteB] = existingInputs
  } else {
    await clickAndWaitForFreshStatus(partyA.page, partyA.page.locator('[data-create-enrolment="party_a"]'), 'party a enrolment signed')
    const enrolmentA = await partyA.page.locator('article.card').filter({hasText: 'Party A · key'}).locator('textarea').inputValue()
    await clickAndWaitForFreshStatus(partyB.page, partyB.page.locator('[data-create-enrolment="party_b"]'), 'party b enrolment signed')
    const enrolmentB = await partyB.page.locator('article.card').filter({hasText: 'Party B · key'}).locator('textarea').inputValue()

    await arbiter.page.locator('[data-create-arbiter]').click()
    const offerForm = arbiter.page.locator('[data-create-contract]')
    await offerForm.locator('input[name="bondA"]').fill('10')
    await offerForm.locator('input[name="bondB"]').fill('10')
    await offerForm.locator('textarea[name="enrolmentA"]').fill(enrolmentA)
    await offerForm.locator('textarea[name="enrolmentB"]').fill(enrolmentB)
    await offerForm.locator('textarea[name="memo"]').fill('Capped 20-sat funded acceptance from an isolated 25-sat wallet.')
    await clickAndWaitForFreshStatus(arbiter.page, offerForm.locator('button[type="submit"], button').last(), 'Canonical offer signed')
    const offer = await arbiter.page.locator('.contract-summary [data-share-kind="message"]').getAttribute('data-share')
    if (!offer?.startsWith('cashmsg1')) throw new Error('The funded acceptance offer is missing.')

    await openMessage(partyA.page, offer)
    await clickAndWaitForFreshStatus(partyA.page, partyA.page.locator('[data-accept-role="party_a"]'), 'accepted. Two private payout secrets')
    const acceptanceA = await partyA.page.locator('article.card').filter({hasText: 'Rider · acceptance'}).locator('[data-share-kind="message"]').getAttribute('data-share')
    await openMessage(partyB.page, offer)
    await clickAndWaitForFreshStatus(partyB.page, partyB.page.locator('[data-accept-role="party_b"]'), 'accepted. Two private payout secrets')
    const acceptanceB = await partyB.page.locator('article.card').filter({hasText: 'Driver · acceptance'}).locator('[data-share-kind="message"]').getAttribute('data-share')
    if (!acceptanceA || !acceptanceB) throw new Error('The funded acceptance signatures are missing.')

    await importPayload(arbiter.page, acceptanceA)
    await importPayload(arbiter.page, acceptanceB)
    await clickAndWaitForFreshStatus(arbiter.page, arbiter.page.locator('[data-create-packet]'), 'Both arbiter-held receiver secrets were persisted')
    const packet = await arbiter.page.locator('[data-share-kind="packet"]').getAttribute('data-share')
    if (!packet?.startsWith('cashpacket1')) throw new Error('The funded acceptance packet is missing.')
    await openPacket(partyA.page, packet)
    await openPacket(partyB.page, packet)

    noteA = existingInputs[0] ?? await wallet.send(10_000, mintHost)
    noteB = existingInputs.find(note => note.id !== noteA.id) ?? await wallet.send(10_000, mintHost)
    const noteUrlA = wallet.noteUrlFor(noteA)
    const noteUrlB = wallet.noteUrlFor(noteB)

    const fundBond = async (party, role, noteUrl, label) => {
      const form = party.page.locator(`[data-fund-contract="${role}"]`)
      await form.locator('textarea[name="note"]').fill(noteUrl)
      await clickAndWaitForFreshStatus(party.page, form.locator('button'), 'Funding submitted and a named-payer acknowledgement signed.')
      const acknowledgement = await party.page.locator('article.card').filter({hasText: label}).locator('[data-share-kind="message"]').last().getAttribute('data-share')
      if (!acknowledgement?.startsWith('cashmsg1')) throw new Error(`${label} funding acknowledgement is missing.`)
      return acknowledgement
    }
    const fundingAckA = await fundBond(partyA, 'party_a', noteUrlA, 'Rider · 10 sat bond')
    const fundingAckB = await fundBond(partyB, 'party_b', noteUrlB, 'Driver · 10 sat bond')
    await importPayload(arbiter.page, fundingAckB)
    await importPayload(arbiter.page, fundingAckA)
  }

  for (const role of ['party_a', 'party_b']) {
    const verify = arbiter.page.locator(`[data-verify-bond="${role}"]`)
    if (await verify.count()) await clickAndWaitForFreshStatus(arbiter.page, verify, 'independently verified 10 sats')
  }
  const activationText = await arbiter.page.locator('.state-list').textContent()
  if (!activationText?.includes('both held + both acknowledged')) throw new Error(`The funded contract did not activate: ${activationText}`)

  const ensureCompletion = async (party, role) => {
    const row = party.page.locator('.message-list li').filter({hasText: `${role.replace('_', ' ')} signed complete`})
    if (!await row.count()) {
      const existing = await contractRecord(party.page)
      if (existing.outcomes.length) throw new Error(`${role} has a non-completion outcome in its persistent profile.`)
      await clickAndWaitForFreshStatus(party.page, party.page.locator(`[data-sign-outcome="complete"][data-sign-role="${role}"]`), 'signed complete')
    }
    const record = await contractRecord(party.page)
    if (record.outcomes.length !== 1) throw new Error(`${role} does not have exactly one completion statement.`)
    return record.outcomes[0]
  }
  const outcomeA = await ensureCompletion(partyA, 'party_a')
  const outcomeB = await ensureCompletion(partyB, 'party_b')
  let arbiterRecord = await contractRecord(arbiter.page)
  if (!arbiterRecord.outcomes.includes(outcomeB)) await importPayload(arbiter.page, outcomeB)
  arbiterRecord = await contractRecord(arbiter.page)
  if (!arbiterRecord.outcomes.includes(outcomeA)) await importPayload(arbiter.page, outcomeA)

  const importedNotices = new Set()
  const importedAcks = new Set()
  for (let pass = 0; pass < 4; pass += 1) {
    if (await arbiter.page.locator('[data-settle-contract]').count()) {
      await clickAndWaitForFreshStatus(arbiter.page, arbiter.page.locator('[data-settle-contract]'), 'Held inputs were redirected')
    }

    const record = await contractRecord(arbiter.page)
    for (const notice of record.settlementNotices) {
      if (importedNotices.has(notice)) continue
      for (const party of [partyA, partyB]) {
        const localRecord = await contractRecord(party.page)
        if (!localRecord.settlementNotices.includes(notice)) await importPayload(party.page, notice)
      }
      importedNotices.add(notice)
    }

    for (const party of [partyA, partyB]) {
      while (await party.page.locator('[data-probe-payout]').count()) {
        await clickAndWaitForFreshStatus(party.page, party.page.locator('[data-probe-payout]').first(), 'Beneficiary independently found the redirected payout.')
      }
      const localRecord = await contractRecord(party.page)
      for (const acknowledgement of localRecord.payoutAcks) {
        if (importedAcks.has(acknowledgement)) continue
        const currentArbiterRecord = await contractRecord(arbiter.page)
        if (!currentArbiterRecord.payoutAcks.includes(acknowledgement)) await importPayload(arbiter.page, acknowledgement)
        importedAcks.add(acknowledgement)
      }
    }

    while (await arbiter.page.locator('[data-reconcile-payout]').count()) {
      await clickAndWaitForFreshStatus(arbiter.page, arbiter.page.locator('[data-reconcile-payout]').first(), 'reconciled the ambiguous leg')
    }

    const state = await browserStore(arbiter.page)
    if (state.settlements.length === 2 && state.settlements.every(item => item.state === 'confirmed')) break
  }

  const finalArbiterState = await browserStore(arbiter.page)
  const finalRecord = Object.values(finalArbiterState.contracts)[0]
  if (
    finalArbiterState.settlements.length !== 2 ||
    !finalArbiterState.settlements.every(item => item.state === 'confirmed') ||
    finalRecord.settlementNotices.length !== 2 ||
    finalRecord.payoutAcks.length !== 2
  ) throw new Error('Both real-sat settlement legs did not finish with beneficiary acknowledgements.')

  const payoutUrls = []
  for (const [role, party] of [['party_a', partyA], ['party_b', partyB]]) {
    const state = await browserStore(party.page)
    const target = state.payoutTargets[Object.keys(state.contracts)[0]][role]
    for (const received of Object.values(target.received)) payoutUrls.push(received.noteUrl)
  }
  if (payoutUrls.length !== 2) throw new Error('The two beneficiary payout notes were not recoverable from their persistent profiles.')

  const recovered = []
  for (const payoutUrl of payoutUrls) recovered.push((await wallet.receive(payoutUrl)).note)
  for (const sent of [noteA, noteB]) {
    const current = wallet.sentNotes().find(note => note.id === sent.id)
    if (current) await wallet.markTaken(current)
  }
  if (recovered.map(note => note.amountMsat).sort((a, b) => a - b).join(',') !== '10000,10000') {
    throw new Error('The recovered wallet notes do not equal the two signed bond values.')
  }
  const check = await wallet.checkNotes({apply: false, mintHost})
  if (check.spent.length || check.unknown.length || check.pending.length || check.unreachable.length) {
    throw new Error('Notecase could not independently verify every recovered note at the mint.')
  }
  if (consoleErrors.length) throw new Error(`Browser errors: ${consoleErrors.join(' | ')}`)

  console.log(JSON.stringify({
    origin,
    separatePersistentProfiles: 3,
    paidBondSats: 20,
    payerAcknowledgements: 2,
    independentlyProbedHeldOutputs: 2,
    bilateralCompletionSignatures: 2,
    confirmedSettlementLegs: 2,
    beneficiaryPayoutAcknowledgements: 2,
    recoveredToEncryptedWalletSats: 20,
    walletNotesVerifiedAtMint: check.checked,
    consoleErrors: 0
  }))
} finally {
  await Promise.all(contexts.map(context => context.close().catch(() => {})))
}

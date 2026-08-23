import {fetchMintAddress, hashK1, noteK1, resolveNoteInput} from 'lnurlcash-kit'
import {bondSetForContract, contractFundingState, resolveHeldBonds} from './bonds'
import {fundReceiverLockedRequest, receiveLockedPayment, redirectHeldNote, type FundingReceipt} from './cash'
import {
  MAX_DEMO_SATS,
  createIdentity,
  decodeRequest,
  outputHashOf,
  randomId,
  randomSecretHex,
  requestFingerprint,
  signOutcome,
  signRequest,
  verifyOutcome,
  type ContractParticipants,
  type PaymentPurpose,
  type ReceiverLockedIntent,
  type SignedRequest
} from './protocol'
import {clearStore, loadStore, saveStore, withExclusiveBrowserLock, type DemoStore, type StoredRequest} from './store'
import {assertTrustedMint, TRUSTED_MINTS} from './trust'

const app = document.querySelector<HTMLDivElement>('#app')!
let store: DemoStore = loadStore()
let incomingRequest: SignedRequest | undefined
let incomingRequestError = ''

const DEFAULT_DISCOVERY = 'https://mint.forgesworn.dev/.well-known/lnurlw/_'

const esc = (value: unknown): string => String(value).replace(/[&<>'"]/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[character]!))

const roleIdentity = (role: 'rider' | 'driver' | 'referee') => {
  const existing = store.identities[role]
  if (existing) return existing
  const created = createIdentity()
  store.identities[role] = created
  saveStore(store)
  return created
}

const status = (message: string, tone: 'ok' | 'warn' | 'bad' = 'ok'): void => {
  const output = document.querySelector<HTMLElement>('[data-status]')
  if (!output) return
  output.className = `status status--${tone}`
  output.textContent = message
}

const copy = async (value: string): Promise<void> => {
  await navigator.clipboard.writeText(value)
  status('Copied. Treat request strings as contract data and note strings as money.')
}

const shareUrl = (encoded: string): string => {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = new URLSearchParams({request: encoded}).toString()
  return url.toString()
}

const copyInternetLink = async (encoded: string): Promise<void> => {
  await navigator.clipboard.writeText(shareUrl(encoded))
  status('Internet hand-off link copied. The signed request is in the URL fragment, not sent to the web server.')
}

const readIncomingRequest = (): void => {
  incomingRequest = undefined
  incomingRequestError = ''
  const encoded = new URLSearchParams(window.location.hash.slice(1)).get('request')
  if (!encoded) return
  try {
    incomingRequest = decodeRequest(encoded)
    assertTrustedMint(incomingRequest.intent.mint)
  } catch (error) {
    incomingRequestError = (error as Error).message
  }
}

const storedByEncoded = (encoded: string): StoredRequest | undefined => Object.values(store.requests).find(record => record.encoded === encoded)

const createRequest = async (args: {
  purpose: PaymentPurpose
  role: 'driver' | 'referee'
  rideId: string
  amountSats: number
  memo: string
  discoveryUrl: string
  persist?: boolean
  participants?: ContractParticipants
}): Promise<StoredRequest> => {
  if (!Number.isSafeInteger(args.amountSats) || args.amountSats < 1 || args.amountSats > MAX_DEMO_SATS) {
    throw new Error(`Keep each demo transfer between 1 and ${MAX_DEMO_SATS} sats.`)
  }
  const discoveryUrl = new URL(args.discoveryUrl)
  if (!TRUSTED_MINTS[discoveryUrl.host.toLowerCase()]) throw new Error('That mint is not allowlisted by this public lab.')
  if (['rider_bond', 'driver_bond'].includes(args.purpose) && Object.values(store.requests).some(record => (
    record.intent.rideId === args.rideId && record.intent.purpose === args.purpose
  ))) throw new Error(`This contract already has a ${args.purpose.replace('_', ' ')} request.`)
  const mint = await fetchMintAddress(discoveryUrl.toString())
  const amountMsat = args.amountSats * 1000
  if (amountMsat < mint.minWithdrawable || amountMsat > mint.maxWithdrawable) {
    throw new Error(`The allowlisted mint currently accepts ${mint.minWithdrawable / 1000} to ${mint.maxWithdrawable / 1000} sats.`)
  }
  const receiverSecretHex = randomSecretHex()
  const intent: ReceiverLockedIntent = {
    v: 1,
    rideId: args.rideId,
    fareVersion: 1,
    purpose: args.purpose,
    role: args.role,
    amount: String(args.amountSats),
    currency: 'sat',
    mint: {
      host: discoveryUrl.host,
      // The discovery callback is the mint's note-information door in the
      // deployed LUD-25 implementations. A live note GET returns the actual
      // mutation callback separately.
      withdrawLink: mint.callback,
      ...(mint.mintPubkey ? {mintPubkey: mint.mintPubkey} : {})
    },
    outputHash: outputHashOf(receiverSecretHex),
    expires: Math.floor(Date.now() / 1000) + 15 * 60,
    memo: args.memo,
    ...(args.participants ? {participants: args.participants} : {})
  }
  assertTrustedMint(intent.mint)
  const signed = signRequest(intent, roleIdentity(args.role).secretHex)
  const record: StoredRequest = {encoded: signed.encoded, intent, receiverSecretHex}
  store.requests[signed.event.id] = record
  if (args.persist !== false) saveStore(store)
  return record
}

const render = (): void => {
  const requests = Object.entries(store.requests)
  const fare = requests.filter(([, record]) => record.intent.purpose === 'fare').at(-1)
  const latestBond = requests.filter(([, record]) => ['rider_bond', 'driver_bond'].includes(record.intent.purpose)).at(-1)
  const bondContractId = latestBond?.[1].intent.rideId
  const riderBond = requests.filter(([, record]) => record.intent.purpose === 'rider_bond' && record.intent.rideId === bondContractId).at(-1)
  const driverBond = requests.filter(([, record]) => record.intent.purpose === 'driver_bond' && record.intent.rideId === bondContractId).at(-1)
  const rideId = bondContractId ?? fare?.[1].intent.rideId ?? randomId()
  const setupExpired = Boolean(riderBond && driverBond && Math.floor(Date.now() / 1000) >= Math.max(riderBond[1].intent.expires, driverBond[1].intent.expires))
  const fundedBondCount = [riderBond?.[1].received, driverBond?.[1].received].filter(Boolean).length
  const payerRequest = incomingRequest?.encoded ?? fare?.[1].encoded ?? ''
  const incomingPayer = incomingRequest?.intent.purpose === 'rider_bond'
    ? incomingRequest.intent.participants?.rider
    : incomingRequest?.intent.purpose === 'driver_bond'
      ? incomingRequest.intent.participants?.driver
      : undefined
  app.innerHTML = `
    <header class="hero">
      <div class="hero__mark" aria-hidden="true">CC</div>
      <div>
        <p class="eyebrow">LNURLCASH CONTRACTS LAB</p>
        <h1>Real sats. Explicit trust.</h1>
        <p class="lede">A live protocol lab for payments the sender cannot claw back and commitment bonds a named referee can redirect. The second sentence is the important one.</p>
        <p class="custody-note">“Real sats” here means live bearer liabilities at a mint. Ownership changes at the mint; Lightning moves when somebody mints or cashes out.</p>
      </div>
      <span class="live-pill"><i></i> real-mint path enabled</span>
    </header>

    <main>
      <section class="handoff" aria-label="Remote hand-off">
        <div><p class="eyebrow">INTERNET HAND-OFF</p><h2>Different people. Different devices.</h2></div>
        <p>Copy a signed internet link and send it over Signal, email, Nostr or any channel you already trust. The fragment carries no spend secret and is not included in the HTTP request to this site. Never put a bearer note in a link.</p>
        ${incomingRequest ? `<p class="incoming"><b>Incoming ${esc(incomingRequest.intent.purpose.replaceAll('_', ' '))}:</b> ${esc(incomingRequest.intent.amount)} sats · contract ${esc(incomingRequest.intent.rideId)} · request ${esc(requestFingerprint(incomingRequest))}${incomingPayer ? ` · named payer ${esc(incomingPayer.slice(0, 16))}…` : ''}</p>` : ''}
        ${incomingRequestError ? `<p class="incoming incoming--bad"><b>Incoming request refused:</b> ${esc(incomingRequestError)}</p>` : ''}
      </section>
      <section class="truth-grid" aria-label="What the demo proves">
        <article><span>01</span><h2>Locked payment</h2><p>The recipient chooses the output secret. The sender funds its hash and never learns the spend key.</p></article>
        <article><span>02</span><h2>Commitment bond</h2><p>Both sides hand a small note to an explicit referee. Completion refunds both; a signed self-cancellation forfeits the canceller’s note.</p></article>
        <article><span>03</span><h2>Hard boundary</h2><p>Silence, GPS and accusations do not decide guilt. A disputed no-show needs an arbiter or a richer mint condition.</p></article>
      </section>

      <section class="panel" id="fare">
        <div class="panel__heading"><div><p class="eyebrow">FLOW A · NO ESCROW</p><h2>Recipient-locked payment</h2></div><span class="assurance">sender cannot double-spend output</span></div>
        <div class="columns">
          <form data-create-fare class="card">
            <h3>Recipient · request</h3>
            <label>Contract id<input name="rideId" value="${esc(rideId)}" pattern="[0-9a-f]{32}" required /></label>
            <label>Payment, sats<input name="amount" type="number" min="1" max="${MAX_DEMO_SATS}" value="21" required /></label>
            <label>Allowlisted mint discovery<input name="mint" value="${DEFAULT_DISCOVERY}" readonly required /></label>
            <button>Create signed request</button>
            ${fare ? `<textarea readonly aria-label="Signed fare request">${esc(fare[1].encoded)}</textarea><div class="button-row"><button type="button" data-copy="${esc(fare[1].encoded)}" class="secondary">Copy request</button><button type="button" data-share="${esc(fare[1].encoded)}" class="secondary">Copy internet link</button></div>` : ''}
          </form>
          <form data-pay-request class="card">
            <h3>Sender · pay</h3>
            <label>Signed request<textarea name="request" required>${esc(payerRequest)}</textarea></label>
            <label>Exact-value bearer note<textarea name="note" placeholder="lnurlw://…?k1=…" required></textarea></label>
            <p class="micro">This browser will see and spend that one note. Use a disposable note of exactly the requested value.</p>
            <button>Fund receiver hash</button>
          </form>
          <div class="card">
            <h3>Recipient · verify</h3>
            ${fare ? `<p><b>${fare[1].intent.amount} sats</b> · request ${esc(fare[0].slice(0, 12))}</p><p class="state">${fare[1].received ? 'Mint confirms the recipient-owned output.' : fare[1].receipt ? 'Funding submitted. Receiver must verify.' : 'Waiting for funding.'}</p><button data-verify="${fare[0]}">Check my output at mint</button>${fare[1].received ? `<details><summary>Received note</summary><textarea readonly>${esc(fare[1].received.noteUrl)}</textarea><button data-copy="${esc(fare[1].received.noteUrl)}" class="secondary">Copy into wallet</button></details>` : ''}` : '<p>Create the request on this browser first.</p>'}
          </div>
        </div>
      </section>

      <section class="panel panel--bond" id="bond">
        <div class="panel__heading"><div><p class="eyebrow">FLOW B · REFEREE CUSTODY</p><h2>Both parties put skin in the game</h2></div><span class="assurance assurance--amber">not trustless</span></div>
        <p class="panel__intro">The referee receives both bearer notes under secrets it controls. It can refund or redirect them, which is precisely why it can enforce a penalty and precisely why it is a custodian.</p>
        <p class="scenario"><b>Worked scenario:</b> a ride booking, with rider and driver bonds. The same state machine applies to a delivery, marketplace booking or contracted job.</p>
        <form data-create-bonds class="bond-setup">
          <label>Contract id<input name="rideId" value="${esc(rideId)}" pattern="[0-9a-f]{32}" required /></label>
          <label>Rider bond, sats<input name="rider" type="number" min="1" max="${MAX_DEMO_SATS}" value="10" required /></label>
          <label>Driver bond, sats<input name="driver" type="number" min="1" max="${MAX_DEMO_SATS}" value="15" required /></label>
          <label>Allowlisted mint discovery<input name="mint" value="${DEFAULT_DISCOVERY}" readonly required /></label>
          <button>Create both bond requests</button>
        </form>
        <div class="bond-grid">
          ${bondCard('rider', riderBond)}
          ${bondCard('driver', driverBond)}
          <article class="card referee">
            <h3>Referee · resolve</h3>
            <p>${riderBond?.[1].received ? '✓ Rider bond locked' : '○ Rider bond not verified'}</p>
            <p>${driverBond?.[1].received ? '✓ Driver bond locked' : '○ Driver bond not verified'}</p>
            <div class="outcomes">
              <button data-resolve="complete" data-contract="${esc(bondContractId ?? '')}" ${riderBond?.[1].received && driverBond?.[1].received ? '' : 'disabled'}>Ride completed · refund both</button>
              <button data-resolve="rider_cancel" data-contract="${esc(bondContractId ?? '')}" class="danger" ${riderBond?.[1].received && driverBond?.[1].received ? '' : 'disabled'}>Rider signed cancel · both to driver</button>
              <button data-resolve="driver_cancel" data-contract="${esc(bondContractId ?? '')}" class="danger" ${riderBond?.[1].received && driverBond?.[1].received ? '' : 'disabled'}>Driver signed cancel · both to rider</button>
              <button data-resolve="setup_abort" data-contract="${esc(bondContractId ?? '')}" class="secondary" ${setupExpired && fundedBondCount === 1 ? '' : 'disabled'}>Setup expired · refund funded bond</button>
            </div>
            <p class="micro">No “declare the other person cancelled” button exists. Identity decides who may sign a self-cancellation.</p>
            ${riderBond?.[1].intent.participants ? `<p class="micro">Bound keys · rider ${esc(riderBond[1].intent.participants.rider.slice(0, 12))}… · driver ${esc(riderBond[1].intent.participants.driver.slice(0, 12))}… · referee ${esc(riderBond[1].intent.participants.referee.slice(0, 12))}…</p>` : ''}
            <p class="micro boundary">This inspector currently simulates all outcome signatures in one browser. Remote identity enrolment and signed outcome return are the next acceptance gate, not a capability claim.</p>
          </article>
        </div>
        ${payouts(bondContractId)}
      </section>

      <section class="attack-lab">
        <div><p class="eyebrow">ATTACK LAB</p><h2>What a bad actor still tries</h2></div>
        <ul>
          <li><b>Alter fields or smuggle tags:</b> exact signed tags and body must agree.</li>
          <li><b>Swap mint, key or callback host:</b> the public trust pins refuse the spend before mutation.</li>
          <li><b>Replay an outcome on other bonds:</b> every outcome commits to the exact two request ids.</li>
          <li><b>Race another browser tab:</b> cross-context locks and a durable payout journal serialise money movement.</li>
          <li><b>Fund only one side:</b> it never activates the contract and is refundable after setup expiry.</li>
          <li><b>Disappear instead of signing cancel:</b> still forces a dispute; silence is not an oracle.</li>
          <li><b>Malicious referee or delivered JavaScript:</b> still able to steal in this build. Those are explicit open risks.</li>
        </ul>
      </section>
    </main>

    <footer><span>Experimental · LUD-25 is still a draft</span><button class="text-button" data-reset>Erase this browser’s demo secrets</button></footer>
    <div data-status class="status" role="status" aria-live="polite">Ready. Use tiny disposable notes only.</div>
  `
  bind()
}

const bondCard = (role: 'rider' | 'driver', pair: [string, StoredRequest] | undefined): string => `
  <article class="card">
    <h3>${role === 'rider' ? 'Rider' : 'Driver'} · bond</h3>
    ${pair ? `<p><b>${pair[1].intent.amount} sats</b> · ${pair[1].received ? 'locked' : pair[1].receipt ? 'submitted' : 'waiting'}</p><textarea readonly>${esc(pair[1].encoded)}</textarea><div class="button-row"><button data-copy="${esc(pair[1].encoded)}" class="secondary">Copy request</button><button data-share="${esc(pair[1].encoded)}" class="secondary">Copy internet link</button></div><form data-fund-bond="${pair[0]}"><label>Exact ${pair[1].intent.amount} sat note<textarea name="note" required></textarea></label><button>Lock ${role} bond</button></form>${pair[1].receipt && !pair[1].received ? `<button data-verify="${pair[0]}" class="secondary">Referee checks mint</button>` : ''}` : '<p>Create the bond contract first.</p>'}
  </article>`

const payouts = (contractId: string | undefined): string => {
  if (!contractId) return ''
  const belongsToContract = (payout: DemoStore['payouts']['rider'][number]): boolean => store.requests[payout.bondRequestId]?.intent.rideId === contractId
  const rows = (['rider', 'driver'] as const).flatMap(role => store.payouts[role].filter(belongsToContract).map(payout => `<li><b>${role}</b><span>${payout.note ? `${payout.note.amountMsat / 1000} sats` : 'staged · needs reconciliation'}</span>${payout.note ? `<button data-copy="${esc(payout.note.noteUrl)}" class="secondary">Copy note</button>` : '<span></span>'}</li>`)).join('')
  const resolution = store.resolutions[contractId]
  const staged = (['rider', 'driver'] as const).some(role => store.payouts[role].some(payout => belongsToContract(payout) && payout.state === 'staged'))
  return rows ? `<div class="payouts"><h3>Resolved bearer outputs</h3><ul>${rows}</ul>${resolution && staged ? `<button data-resolve="${resolution}" data-contract="${esc(contractId)}" class="secondary">Reconcile staged settlement</button>` : ''}<p class="micro">Import and rotate these in a proper wallet. In production the beneficiary wallet would generate the output hash, so the referee would never know this secret.</p></div>` : ''
}

const parseForm = (form: HTMLFormElement): FormData => new FormData(form)

const bind = (): void => {
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach(button => button.addEventListener('click', () => void copy(button.dataset.copy ?? '')))
  document.querySelectorAll<HTMLElement>('[data-share]').forEach(button => button.addEventListener('click', () => void copyInternetLink(button.dataset.share ?? '')))

  document.querySelector<HTMLFormElement>('[data-create-fare]')?.addEventListener('submit', event => void run(event, async form => {
    const data = parseForm(form)
    const contractId = String(data.get('rideId'))
    await withExclusiveBrowserLock(`contract:${contractId}`, async () => {
      store = loadStore()
      await createRequest({purpose: 'fare', role: 'driver', rideId: contractId, amountSats: Number(data.get('amount')), memo: 'Recipient-locked service payment', discoveryUrl: String(data.get('mint'))})
    })
    render()
    status('Recipient request created. Its receiver secret was persisted before the request was shown.')
  }))

  document.querySelector<HTMLFormElement>('[data-pay-request]')?.addEventListener('submit', event => void run(event, async form => {
    const data = parseForm(form)
    const request = decodeRequest(String(data.get('request')))
    assertTrustedMint(request.intent.mint)
    const namedPayer = request.intent.purpose === 'rider_bond' ? request.intent.participants?.rider : request.intent.purpose === 'driver_bond' ? request.intent.participants?.driver : undefined
    if (!confirm(`Fund ${request.intent.amount} sats for ${request.intent.purpose.replaceAll('_', ' ')}?\n\nContract: ${request.intent.rideId}\nMint: ${request.intent.mint.host}\nSigner: ${request.event.pubkey.slice(0, 16)}…${namedPayer ? `\nContract names payer: ${namedPayer.slice(0, 16)}…` : ''}\nRequest: ${requestFingerprint(request)}`)) return
    const noteInput = String(data.get('note'))
    const resolvedNote = resolveNoteInput(noteInput)
    const spendSecret = resolvedNote ? noteK1(resolvedNote) : null
    if (!spendSecret) throw new Error('That is not an LNURLcash bearer note.')
    let receipt: FundingReceipt | undefined
    await withExclusiveBrowserLock(`spend:${hashK1(spendSecret)}`, async () => {
      receipt = await fundReceiverLockedRequest(request, noteInput)
      store = loadStore()
      const local = storedByEncoded(request.encoded)
      if (local) local.receipt = receipt
      saveStore(store)
    }, {requireCrossContext: true})
    render()
    status(receipt!.outcome === 'confirmed' ? 'Mint confirmed the receiver-locked transfer.' : 'Mutation outcome is unknown. The receiver must probe; do not retry or discard anything.', receipt!.outcome === 'confirmed' ? 'ok' : 'warn')
  }))

  document.querySelector<HTMLFormElement>('[data-create-bonds]')?.addEventListener('submit', event => void run(event, async form => {
    const data = parseForm(form)
    const contractId = String(data.get('rideId'))
    await withExclusiveBrowserLock(`contract:${contractId}`, async () => {
      store = loadStore()
      const participants = {
        rider: roleIdentity('rider').pubkey,
        driver: roleIdentity('driver').pubkey,
        referee: roleIdentity('referee').pubkey
      }
      const base = {role: 'referee' as const, rideId: contractId, discoveryUrl: String(data.get('mint')), participants}
      try {
        await createRequest({...base, purpose: 'rider_bond', amountSats: Number(data.get('rider')), memo: 'Rider commitment bond', persist: false})
        await createRequest({...base, purpose: 'driver_bond', amountSats: Number(data.get('driver')), memo: 'Driver commitment bond', persist: false})
        saveStore(store)
      } catch (error) {
        store = loadStore()
        throw error
      }
    })
    render()
    status('Both bond requests created and signed by the referee identity.')
  }))

  document.querySelectorAll<HTMLFormElement>('[data-fund-bond]').forEach(form => form.addEventListener('submit', event => void run(event, async submitted => {
    const id = submitted.dataset.fundBond!
    const original = store.requests[id]
    if (!original) throw new Error('That bond request is no longer stored.')
    const noteInput = String(parseForm(submitted).get('note'))
    const resolvedNote = resolveNoteInput(noteInput)
    const spendSecret = resolvedNote ? noteK1(resolvedNote) : null
    if (!spendSecret) throw new Error('That is not an LNURLcash bearer note.')
    await withExclusiveBrowserLock(`contract:${original.intent.rideId}`, async () => withExclusiveBrowserLock(`spend:${hashK1(spendSecret)}`, async () => {
      store = loadStore()
      const record = store.requests[id]
      if (!record) throw new Error('That bond request is no longer stored.')
      const request = decodeRequest(record.encoded)
      assertTrustedMint(request.intent.mint)
      record.receipt = await fundReceiverLockedRequest(request, noteInput)
      saveStore(store)
      try { record.received = await receiveLockedPayment(request, record.receiverSecretHex, record.receipt) } catch { /* surfaced as submitted; referee can probe again */ }
      saveStore(store)
    }, {requireCrossContext: true}), {requireCrossContext: true})
    const record = store.requests[id]!
    render()
    status(record.received ? 'Referee now controls that real-sat bond.' : 'Bond mutation submitted. Referee must probe the output before treating it as locked.', record.received ? 'ok' : 'warn')
  })))

  document.querySelectorAll<HTMLElement>('[data-verify]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const id = button.dataset.verify!
    const original = store.requests[id]
    if (!original) throw new Error('Request not found.')
    await withExclusiveBrowserLock(`contract:${original.intent.rideId}`, async () => {
      store = loadStore()
      const record = store.requests[id]
      if (!record) throw new Error('Request not found.')
      const request = decodeRequest(record.encoded, 0)
      assertTrustedMint(request.intent.mint)
      record.received = await receiveLockedPayment(request, record.receiverSecretHex, record.receipt)
      saveStore(store)
    })
    const record = store.requests[id]!
    render()
    status(`Mint confirms ${record.intent.amount} sats under the receiver-only secret.`)
  })))

  document.querySelectorAll<HTMLElement>('[data-resolve]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const outcome = button.dataset.resolve as 'complete' | 'rider_cancel' | 'driver_cancel' | 'setup_abort'
    const contractId = button.dataset.contract
    if (!contractId) throw new Error('No contract is selected for resolution.')
    await withExclusiveBrowserLock(`contract:${contractId}`, async () => {
      store = loadStore()
      await resolveBonds(contractId, outcome)
    }, {requireCrossContext: true})
    render()
    status(outcome === 'setup_abort' ? 'The funded setup bond was returned after the deadline.' : 'The old bond outputs were spent. In this inspector the referee still knows each payout secret until the beneficiary rotates it.', outcome === 'setup_abort' ? 'ok' : 'warn')
  })))

  document.querySelector<HTMLElement>('[data-reset]')?.addEventListener('click', () => {
    if (!confirm('Erase this browser’s stored request, bond and payout secrets? Export any live notes first.')) return
    clearStore()
    store = loadStore()
    render()
  })
}

const resolveBonds = async (rideId: string, outcome: 'complete' | 'rider_cancel' | 'driver_cancel' | 'setup_abort'): Promise<void> => {
  const bondSet = bondSetForContract(store, rideId)
  contractFundingState(store, rideId)
  const identities = {rider: bondSet.participants.rider, driver: bondSet.participants.driver}
  if (outcome === 'complete') {
    const riderSigned = signOutcome(rideId, bondSet.bondSetHash, outcome, roleIdentity('rider').secretHex)
    const driverSigned = signOutcome(rideId, bondSet.bondSetHash, outcome, roleIdentity('driver').secretHex)
    if (
      !verifyOutcome(riderSigned, identities, bondSet.bondSetHash) ||
      !verifyOutcome(driverSigned, identities, bondSet.bondSetHash) ||
      riderSigned.event.pubkey !== identities.rider ||
      driverSigned.event.pubkey !== identities.driver
    ) throw new Error('Both completion signatures are required.')
  } else if (outcome !== 'setup_abort') {
    const canceller = outcome === 'rider_cancel' ? 'rider' : 'driver'
    const signed = signOutcome(rideId, bondSet.bondSetHash, outcome, roleIdentity(canceller).secretHex)
    if (!verifyOutcome(signed, identities, bondSet.bondSetHash)) throw new Error('The cancellation signature does not belong to the cancelling party.')
  }
  await resolveHeldBonds(store, rideId, outcome, {persist: saveStore, redirect: redirectHeldNote})
}

const run = async (event: Event | null, work: (form: HTMLFormElement) => Promise<void>): Promise<void> => {
  event?.preventDefault()
  try {
    const target = event?.currentTarget
    await work(target instanceof HTMLFormElement ? target : document.createElement('form'))
  } catch (error) {
    status((error as Error).message, 'bad')
  }
}

readIncomingRequest()
render()
if (incomingRequestError) status(incomingRequestError, 'bad')

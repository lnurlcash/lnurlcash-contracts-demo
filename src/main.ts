import {fetchMintAddress} from 'lnurlcash-kit'
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
  type PaymentPurpose,
  type ReceiverLockedIntent,
  type SignedRequest
} from './protocol'
import {clearStore, loadStore, saveStore, type DemoStore, type StoredRequest} from './store'

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
  status('Copied. Treat request strings as ride data and note strings as money.')
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
}): Promise<StoredRequest> => {
  if (!Number.isSafeInteger(args.amountSats) || args.amountSats < 1 || args.amountSats > MAX_DEMO_SATS) {
    throw new Error(`Keep each demo transfer between 1 and ${MAX_DEMO_SATS} sats.`)
  }
  const discoveryUrl = new URL(args.discoveryUrl)
  const mint = await fetchMintAddress(discoveryUrl.toString())
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
    memo: args.memo
  }
  const signed = signRequest(intent, roleIdentity(args.role).secretHex)
  const record: StoredRequest = {encoded: signed.encoded, intent, receiverSecretHex}
  store.requests[signed.event.id] = record
  saveStore(store)
  return record
}

const render = (): void => {
  const requests = Object.entries(store.requests)
  const fare = requests.filter(([, record]) => record.intent.purpose === 'fare').at(-1)
  const riderBond = requests.filter(([, record]) => record.intent.purpose === 'rider_bond').at(-1)
  const driverBond = requests.filter(([, record]) => record.intent.purpose === 'driver_bond').at(-1)
  const rideId = riderBond?.[1].intent.rideId ?? driverBond?.[1].intent.rideId ?? fare?.[1].intent.rideId ?? randomId()
  const payerRequest = incomingRequest?.encoded ?? fare?.[1].encoded ?? ''
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
        ${incomingRequest ? `<p class="incoming"><b>Incoming ${esc(incomingRequest.intent.purpose.replaceAll('_', ' '))}:</b> ${esc(incomingRequest.intent.amount)} sats · contract ${esc(incomingRequest.intent.rideId)} · request ${esc(requestFingerprint(incomingRequest))}</p>` : ''}
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
            <label>Contract id<input name="rideId" value="${esc(rideId)}" pattern="[0-9a-f]{16}" required /></label>
            <label>Payment, sats<input name="amount" type="number" min="1" max="${MAX_DEMO_SATS}" value="21" required /></label>
            <label>Mint discovery<input name="mint" value="${DEFAULT_DISCOVERY}" required /></label>
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
          <label>Contract id<input name="rideId" value="${esc(rideId)}" pattern="[0-9a-f]{16}" required /></label>
          <label>Rider bond, sats<input name="rider" type="number" min="1" max="${MAX_DEMO_SATS}" value="10" required /></label>
          <label>Driver bond, sats<input name="driver" type="number" min="1" max="${MAX_DEMO_SATS}" value="15" required /></label>
          <label>Mint discovery<input name="mint" value="${DEFAULT_DISCOVERY}" required /></label>
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
              <button data-resolve="complete" ${riderBond?.[1].received && driverBond?.[1].received ? '' : 'disabled'}>Ride completed · refund both</button>
              <button data-resolve="rider_cancel" class="danger" ${riderBond?.[1].received && driverBond?.[1].received ? '' : 'disabled'}>Rider signed cancel · both to driver</button>
              <button data-resolve="driver_cancel" class="danger" ${riderBond?.[1].received && driverBond?.[1].received ? '' : 'disabled'}>Driver signed cancel · both to rider</button>
            </div>
            <p class="micro">No “declare the other person cancelled” button exists. Identity decides who may sign a self-cancellation.</p>
            <p class="micro boundary">This inspector currently simulates all outcome signatures in one browser. Remote identity enrolment and signed outcome return are the next acceptance gate, not a capability claim.</p>
          </article>
        </div>
        ${payouts()}
      </section>

      <section class="attack-lab">
        <div><p class="eyebrow">ATTACK LAB</p><h2>What a bad actor still tries</h2></div>
        <ul>
          <li><b>Alter amount or recipient hash:</b> breaks the Nostr signature.</li>
          <li><b>Replay the payment:</b> a hardened mint refuses the used input and never reissues the burned output id.</li>
          <li><b>Claim payment failed:</b> the receiver probes its own secret directly at the mint.</li>
          <li><b>Blame the other party:</b> only a party’s own signed cancellation is automatic.</li>
          <li><b>Disappear or allege no-show:</b> funds freeze for dispute; GPS alone is not an oracle.</li>
          <li><b>Malicious referee:</b> can steal both bonds in this flow. Conditional mint outputs are the route out.</li>
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

const payouts = (): string => {
  const rows = (['rider', 'driver'] as const).flatMap(role => store.payouts[role].map(payout => `<li><b>${role}</b><span>${payout.note ? `${payout.note.amountMsat / 1000} sats` : 'staged · needs reconciliation'}</span>${payout.note ? `<button data-copy="${esc(payout.note.noteUrl)}" class="secondary">Copy note</button>` : '<span></span>'}</li>`)).join('')
  return rows ? `<div class="payouts"><h3>Resolved bearer outputs</h3><ul>${rows}</ul>${store.resolution && (store.payouts.rider.some(payout => payout.state === 'staged') || store.payouts.driver.some(payout => payout.state === 'staged')) ? `<button data-resolve="${store.resolution}" class="secondary">Reconcile staged settlement</button>` : ''}<p class="micro">Import and rotate these in a proper wallet. In production the beneficiary wallet would generate the output hash, so the referee would never know this secret.</p></div>` : ''
}

const parseForm = (form: HTMLFormElement): FormData => new FormData(form)

const bind = (): void => {
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach(button => button.addEventListener('click', () => void copy(button.dataset.copy ?? '')))
  document.querySelectorAll<HTMLElement>('[data-share]').forEach(button => button.addEventListener('click', () => void copyInternetLink(button.dataset.share ?? '')))

  document.querySelector<HTMLFormElement>('[data-create-fare]')?.addEventListener('submit', event => void run(event, async form => {
    const data = parseForm(form)
    await createRequest({purpose: 'fare', role: 'driver', rideId: String(data.get('rideId')), amountSats: Number(data.get('amount')), memo: 'Recipient-locked service payment', discoveryUrl: String(data.get('mint'))})
    render()
    status('Driver request created. Its receiver secret was persisted before the request was shown.')
  }))

  document.querySelector<HTMLFormElement>('[data-pay-request]')?.addEventListener('submit', event => void run(event, async form => {
    const data = parseForm(form)
    const request = decodeRequest(String(data.get('request')))
    if (!confirm(`Fund ${request.intent.amount} sats for ${request.intent.purpose.replaceAll('_', ' ')}?\n\nContract: ${request.intent.rideId}\nMint: ${request.intent.mint.host}\nSigner: ${request.event.pubkey.slice(0, 16)}…\nRequest: ${requestFingerprint(request)}`)) return
    const receipt = await fundReceiverLockedRequest(request, String(data.get('note')))
    const local = storedByEncoded(request.encoded)
    if (local) local.receipt = receipt
    saveStore(store)
    render()
    status(receipt.outcome === 'confirmed' ? 'Mint confirmed the receiver-locked transfer.' : 'Mutation outcome is unknown. The receiver must probe; do not retry or discard anything.', receipt.outcome === 'confirmed' ? 'ok' : 'warn')
  }))

  document.querySelector<HTMLFormElement>('[data-create-bonds]')?.addEventListener('submit', event => void run(event, async form => {
    const data = parseForm(form)
    const base = {role: 'referee' as const, rideId: String(data.get('rideId')), discoveryUrl: String(data.get('mint'))}
    await createRequest({...base, purpose: 'rider_bond', amountSats: Number(data.get('rider')), memo: 'Rider commitment bond'})
    await createRequest({...base, purpose: 'driver_bond', amountSats: Number(data.get('driver')), memo: 'Driver commitment bond'})
    render()
    status('Both bond requests created and signed by the referee identity.')
  }))

  document.querySelectorAll<HTMLFormElement>('[data-fund-bond]').forEach(form => form.addEventListener('submit', event => void run(event, async submitted => {
    const id = submitted.dataset.fundBond!
    const record = store.requests[id]
    if (!record) throw new Error('That bond request is no longer stored.')
    const request = decodeRequest(record.encoded, 0)
    record.receipt = await fundReceiverLockedRequest(request, String(parseForm(submitted).get('note')))
    saveStore(store)
    try { record.received = await receiveLockedPayment(request, record.receiverSecretHex, record.receipt) } catch { /* surfaced as submitted; referee can probe again */ }
    saveStore(store)
    render()
    status(record.received ? 'Referee now controls that real-sat bond.' : 'Bond mutation submitted. Referee must probe the output before treating it as locked.', record.received ? 'ok' : 'warn')
  })))

  document.querySelectorAll<HTMLElement>('[data-verify]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const id = button.dataset.verify!
    const record = store.requests[id]
    if (!record) throw new Error('Request not found.')
    const request = decodeRequest(record.encoded)
    record.received = await receiveLockedPayment(request, record.receiverSecretHex, record.receipt)
    saveStore(store)
    render()
    status(`Mint confirms ${record.intent.amount} sats under the receiver-only secret.`)
  })))

  document.querySelectorAll<HTMLElement>('[data-resolve]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const outcome = button.dataset.resolve as 'complete' | 'rider_cancel' | 'driver_cancel'
    await resolveBonds(outcome)
    render()
    status('Both bonds were redirected to fresh beneficiary hashes. The referee no longer controls the old notes.')
  })))

  document.querySelector<HTMLElement>('[data-reset]')?.addEventListener('click', () => {
    if (!confirm('Erase this browser’s stored request, bond and payout secrets? Export any live notes first.')) return
    clearStore()
    store = loadStore()
    render()
  })
}

const resolveBonds = async (outcome: 'complete' | 'rider_cancel' | 'driver_cancel'): Promise<void> => {
  if (store.resolution && store.resolution !== outcome) throw new Error(`This contract is already resolving as ${store.resolution}.`)
  const entries = Object.entries(store.requests).filter(([, record]) => ['rider_bond', 'driver_bond'].includes(record.intent.purpose))
  if (entries.length < 2 || entries.some(([id, record]) => !record.received && ![...store.payouts.rider, ...store.payouts.driver].some(payout => payout.bondRequestId === id))) {
    throw new Error('Both bonds must be verified before resolution.')
  }
  const rideId = entries[0]![1].intent.rideId
  if (entries.some(([, record]) => record.intent.rideId !== rideId)) throw new Error('The two bonds belong to different rides.')
  const identities = {rider: roleIdentity('rider').pubkey, driver: roleIdentity('driver').pubkey}
  if (outcome === 'complete') {
    const riderSigned = signOutcome(rideId, outcome, roleIdentity('rider').secretHex)
    const driverSigned = signOutcome(rideId, outcome, roleIdentity('driver').secretHex)
    if (
      !verifyOutcome(riderSigned, identities) ||
      !verifyOutcome(driverSigned, identities) ||
      riderSigned.event.pubkey !== identities.rider ||
      driverSigned.event.pubkey !== identities.driver
    ) throw new Error('Both completion signatures are required.')
  } else {
    const canceller = outcome === 'rider_cancel' ? 'rider' : 'driver'
    const signed = signOutcome(rideId, outcome, roleIdentity(canceller).secretHex)
    if (!verifyOutcome(signed, identities)) throw new Error('The cancellation signature does not belong to the cancelling party.')
  }
  store.resolution = outcome
  saveStore(store)
  for (const [requestId, record] of entries) {
    const bondOwner = record.intent.purpose === 'rider_bond' ? 'rider' : 'driver'
    const beneficiary: 'rider' | 'driver' = outcome === 'complete' ? bondOwner : outcome === 'rider_cancel' ? 'driver' : 'rider'
    const existing = [...store.payouts.rider, ...store.payouts.driver].find(payout => payout.bondRequestId === requestId)
    if (existing?.state === 'settled') continue
    if (!record.received) throw new Error('A staged settlement lost its held input; stop and inspect storage.')
    const payout = existing ?? {bondRequestId: requestId, beneficiary, secretHex: randomSecretHex(), state: 'staged' as const}
    if (!existing) store.payouts[beneficiary].push(payout)
    // Persist the only copy before disclosing its hash to the mint.
    saveStore(store)
    payout.note = await redirectHeldNote(record.received, record.receiverSecretHex, payout.secretHex)
    payout.state = 'settled'
    delete record.received
    saveStore(store)
  }
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

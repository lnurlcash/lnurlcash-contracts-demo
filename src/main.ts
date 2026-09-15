import {fetchMintAddress, hashK1, noteK1, resolveNoteInput} from '@lnurlcash/kit'
import {
  fundReceiverLockedRequest,
  receiveLockedPayment,
  type FundingReceipt
} from './cash'
import {
  assertAcceptance,
  assertOfferOpen,
  decodeContractMessage,
  messageFingerprint,
  signAcceptance,
  signContractOffer,
  signEnrolment,
  type ContractMessage,
  type SignedContractOffer
} from './coordination'
import {
  importVerifiedContractMessage,
  normaliseStoredContract
} from './contract-state'
import {CONTRACT_TEMPLATES, PARTY_ROLES, isPartyRole, type ContractTemplate, type ContractTerms, type PartyRole} from './contract-types'
import {
  MAX_DEMO_SATS,
  contractIdOf,
  createIdentity,
  decodeRequest,
  isCommitmentIntent,
  isDirectPaymentIntent,
  outputHashOf,
  randomId,
  randomSecretHex,
  requestFingerprint,
  signRequest,
  type DirectPaymentIntent,
  type SignedRequest
} from './protocol'
import {
  PUBLIC_BOND_MODE,
  assertPublicCoordinationMessageType,
  assertPublicPacketImportDisabled,
  cancellationRecommendation,
  type ProtectedCancellationReason
} from './product-policy'
import {
  clearLegacyStore,
  clearStore,
  legacyRecoveryJson,
  loadStore,
  saveStore,
  withExclusiveBrowserLock,
  type DemoStore,
  type IdentityRole,
  type StoredContract,
  type StoredIdentity,
  type StoredRequest
} from './store'
import {assertTrustedMint, TRUSTED_MINTS} from './trust'

const app = document.querySelector<HTMLDivElement>('#app')!
const DEFAULT_DISCOVERY = 'https://moneyer.dev/.well-known/lnurlw/_'
const TEMPLATE_DEFAULTS: Record<ContractTemplate, {title: string; partyA: string; partyB: string; arbiter: string}> = {
  ride: {title: 'Point-to-point ride', partyA: 'Rider', partyB: 'Driver', arbiter: 'Evidence coordinator'},
  delivery: {title: 'Item delivery', partyA: 'Customer', partyB: 'Courier', arbiter: 'Evidence coordinator'},
  booking: {title: 'Reserved booking', partyA: 'Guest', partyB: 'Provider', arbiter: 'Evidence coordinator'},
  work: {title: 'Contracted work', partyA: 'Client', partyB: 'Contractor', arbiter: 'Evidence coordinator'},
  custom: {title: 'Bilateral commitment', partyA: 'Party A', partyB: 'Party B', arbiter: 'Evidence coordinator'}
}

let store: DemoStore = loadStore()
let incomingRequest: SignedRequest | undefined
let incomingMessage: ContractMessage | undefined
let incomingError = ''

const esc = (value: unknown): string => String(value).replace(/[&<>'"]/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[character]!))

const status = (message: string, tone: 'ok' | 'warn' | 'bad' = 'ok'): void => {
  const output = document.querySelector<HTMLElement>('[data-status]')
  if (!output) return
  output.className = `status status--${tone}`
  output.textContent = message
}

const copy = async (value: string): Promise<void> => {
  await navigator.clipboard.writeText(value)
  status('Copied. Signed messages are contract data; bearer notes and payout secrets are money.')
}

const shareUrl = (kind: 'request' | 'message' | 'packet', encoded: string): string => {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = new URLSearchParams({[kind]: encoded}).toString()
  return url.toString()
}

const copyInternetLink = async (kind: 'request' | 'message' | 'packet', encoded: string): Promise<void> => {
  await navigator.clipboard.writeText(shareUrl(kind, encoded))
  status('Internet hand-off link copied. The payload is in the URL fragment and is not sent to this server.')
}

const clearFragment = (): void => {
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  incomingRequest = undefined
  incomingMessage = undefined
  incomingError = ''
}

const readIncoming = (): void => {
  incomingRequest = undefined
  incomingMessage = undefined
  incomingError = ''
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  try {
    const request = fragment.get('request')
    const message = fragment.get('message')
    const packet = fragment.get('packet')
    const count = [request, message, packet].filter(Boolean).length
    if (count > 1) throw new Error('A hand-off link may contain exactly one payload.')
    if (request) {
      incomingRequest = decodeRequest(request)
      assertTrustedMint(incomingRequest.intent.mint)
    } else if (message) {
      incomingMessage = decodeContractMessage(message)
      assertPublicCoordinationMessageType(incomingMessage.type)
    } else if (packet) {
      assertPublicPacketImportDisabled()
    }
  } catch (error) {
    incomingError = (error as Error).message
  }
}

const identity = (role: IdentityRole, create = false): StoredIdentity | undefined => {
  const existing = store.identities[role]
  if (existing || !create) return existing
  const created = createIdentity()
  store.identities[role] = created
  saveStore(store)
  return created
}

const normaliseContract = (offerId: string, offerEncoded: string): StoredContract => {
  return normaliseStoredContract(store, offerId, offerEncoded)
}

const latestDirect = (): [string, StoredRequest] | undefined => Object.entries(store.requests).filter(([, record]) => (
  isDirectPaymentIntent(record.intent) || (record.intent.v === 1 && record.intent.purpose === 'fare')
)).at(-1)

const latestContract = (): {offerId: string; record: StoredContract; offer: SignedContractOffer; packet?: string} | undefined => {
  const pair = Object.entries(store.contracts).at(-1)
  if (!pair) return undefined
  const message = decodeContractMessage(pair[1].offer, 0)
  if (message.type !== 'contract_offer') throw new Error('Stored contract offer has the wrong message type.')
  return {offerId: pair[0], record: normaliseContract(pair[0], pair[1].offer), offer: message, ...(pair[1].packet ? {packet: pair[1].packet} : {})}
}

const localPartyRoles = (offer: SignedContractOffer): PartyRole[] => PARTY_ROLES.filter(role => store.identities[role]?.pubkey === offer.terms.participants[role])

const createDirectRequest = async (contractId: string, amountSats: number, discoveryInput: string): Promise<void> => {
  if (!Number.isSafeInteger(amountSats) || amountSats < 1 || amountSats > MAX_DEMO_SATS) throw new Error(`Keep each demo transfer between 1 and ${MAX_DEMO_SATS} sats.`)
  const discoveryUrl = new URL(discoveryInput)
  if (!TRUSTED_MINTS[discoveryUrl.host.toLowerCase()]) throw new Error('That mint is not allowlisted by this public lab.')
  const mintAddress = await fetchMintAddress(discoveryUrl.toString())
  const amountMsat = amountSats * 1000
  if (amountMsat < mintAddress.minWithdrawable || amountMsat > mintAddress.maxWithdrawable) throw new Error(`The allowlisted mint currently accepts ${mintAddress.minWithdrawable / 1000} to ${mintAddress.maxWithdrawable / 1000} sats.`)
  const receiverSecretHex = randomSecretHex()
  const intent: DirectPaymentIntent = {
    v: 2,
    contractId,
    revision: 1,
    purpose: 'payment',
    receiverRole: 'recipient',
    amount: String(amountSats),
    currency: 'sat',
    mint: {host: discoveryUrl.host, withdrawLink: mintAddress.callback, ...(mintAddress.mintPubkey ? {mintPubkey: mintAddress.mintPubkey} : {})},
    outputHash: outputHashOf(receiverSecretHex),
    expires: Math.floor(Date.now() / 1000) + 15 * 60,
    memo: 'Recipient-locked service payment'
  }
  assertTrustedMint(intent.mint)
  const recipient = identity('recipient', true)!
  const signed = signRequest(intent, recipient.secretHex)
  store.requests[signed.event.id] = {encoded: signed.encoded, intent: signed.intent, receiverSecretHex}
  saveStore(store)
}

const importContractMessage = (message: ContractMessage): void => {
  assertPublicCoordinationMessageType(message.type)
  importVerifiedContractMessage(store, message)
  saveStore(store)
}

const messageSummary = (message: ContractMessage): string => {
  if (message.type === 'contract_offer') return `contract offer · ${message.terms.title}`
  if (message.type === 'enrolment') return `${message.role.replace('_', ' ')} enrolment`
  if (message.type === 'acceptance') return `${message.role.replace('_', ' ')} acceptance`
  return 'disabled value-lifecycle message'
}

const handoffHtml = (): string => {
  let incoming = ''
  if (incomingRequest) incoming = `<p class="incoming"><b>Incoming receiver request:</b> ${esc(incomingRequest.intent.amount)} sats · contract ${esc(contractIdOf(incomingRequest.intent))} · request ${esc(requestFingerprint(incomingRequest))}</p>`
  if (incomingMessage) incoming = `<p class="incoming"><b>Incoming ${esc(messageSummary(incomingMessage))}</b> · message ${esc(messageFingerprint(incomingMessage))}<button type="button" data-import-incoming-message>Verify and import</button></p>`
  if (incomingError) incoming = `<p class="incoming incoming--bad"><b>Incoming payload refused:</b> ${esc(incomingError)}</p>`
  return `<section class="handoff" aria-label="Remote hand-off"><div><p class="eyebrow">INTERNET HAND-OFF</p><h2>Different people. Independent keys.</h2></div><p>Enrolments, offers and acceptances travel as signed fragment links. The server never receives the fragment. Bond packets and every value-lifecycle message are refused by this public build.</p>${incoming}</section>`
}

const directHtml = (): string => {
  const direct = latestDirect()
  const contractId = direct ? contractIdOf(direct[1].intent) : randomId()
  const payerRequest = incomingRequest?.encoded ?? direct?.[1].encoded ?? ''
  return `<section class="panel" id="payment">
    <div class="panel__heading"><div><p class="eyebrow">FLOW A · NO ESCROW</p><h2>Recipient-locked payment</h2></div><span class="assurance">sender cannot reclaim output</span></div>
    <div class="columns">
      <form data-create-payment class="card"><h3>Recipient · request</h3>
        <label>Contract id<input name="contractId" value="${esc(contractId)}" pattern="[0-9a-f]{32}" required /></label>
        <label>Payment, sats<input name="amount" type="number" min="1" max="${MAX_DEMO_SATS}" value="21" required /></label>
        <label>Allowlisted mint<input name="mint" value="${DEFAULT_DISCOVERY}" readonly required /></label>
        <button>Create signed request</button>
        ${direct ? `<textarea readonly aria-label="Signed payment request">${esc(direct[1].encoded)}</textarea><div class="button-row"><button type="button" data-copy="${esc(direct[1].encoded)}" class="secondary">Copy request</button><button type="button" data-share-kind="request" data-share="${esc(direct[1].encoded)}" class="secondary">Copy internet link</button></div>` : ''}
      </form>
      <form data-pay-request class="card"><h3>Sender · pay</h3>
        <label>Signed request<textarea name="request" required>${esc(payerRequest)}</textarea></label>
        <label>Exact-value bearer note<textarea name="note" placeholder="lnurlw://…?k1=…" required></textarea></label>
        <p class="micro">Use a disposable note of exactly the signed value. This is a direct recipient-owned payment; commitment-bond funding is disabled.</p>
        <button>Fund receiver hash</button>
      </form>
      <div class="card"><h3>Recipient · verify</h3>
        ${direct ? `<p><b>${esc(direct[1].intent.amount)} sats</b> · request ${esc(direct[0].slice(0, 12))}</p><p class="state">${direct[1].received ? 'Mint confirms the recipient-owned output.' : direct[1].receipt ? 'Funding submitted. Recipient must verify.' : 'Waiting for funding.'}</p><button data-verify-request="${esc(direct[0])}">Check my output at mint</button>${direct[1].received ? `<details><summary>Received note</summary><textarea readonly>${esc(direct[1].received.noteUrl)}</textarea><button data-copy="${esc(direct[1].received.noteUrl)}" class="secondary">Copy into wallet</button></details>` : ''}` : '<p>Create the request on this browser first.</p>'}
      </div>
    </div>
  </section>`
}

const enrolmentCard = (role: PartyRole): string => {
  const id = store.identities[role]
  const enrolment = store.enrolments?.[role]
  return `<article class="card"><h3>${role === 'party_a' ? 'Party A' : 'Party B'} · key</h3>${id ? `<p class="keyprint">${esc(id.pubkey.slice(0, 20))}…</p>${enrolment ? `<textarea readonly>${esc(enrolment)}</textarea><div class="button-row"><button class="secondary" data-copy="${esc(enrolment)}">Copy enrolment</button><button class="secondary" data-share-kind="message" data-share="${esc(enrolment)}">Copy link</button></div>` : `<button data-create-enrolment="${role}">Sign enrolment</button>`}` : `<p>Create this role only in the browser profile belonging to that person.</p><button data-create-enrolment="${role}">Create key and enrolment</button>`}</article>`
}

const contractStatus = (contract: ReturnType<typeof latestContract>): string => {
  if (!contract) return '<p>No contract imported or created in this browser yet.</p>'
  const {offer, record, packet} = contract
  const accepted = PARTY_ROLES.map(role => Boolean(record.acceptances[role]))
  return `<div class="contract-summary">
    <div><p class="eyebrow">CURRENT EVIDENCE AGREEMENT</p><h3>${esc(offer.terms.title)}</h3><p>${esc(offer.terms.template)} · archived wire policy ${esc(offer.terms.policy.id)} · offer ${esc(offer.event.id.slice(0, 12))}</p></div>
    <dl><div><dt>${esc(offer.terms.labels.party_a)}</dt><dd>${esc(offer.terms.bonds.party_a)} sat reference exposure · ${esc(offer.terms.participants.party_a.slice(0, 12))}…</dd></div><div><dt>${esc(offer.terms.labels.party_b)}</dt><dd>${esc(offer.terms.bonds.party_b)} sat reference exposure · ${esc(offer.terms.participants.party_b.slice(0, 12))}…</dd></div><div><dt>${esc(offer.terms.labels.arbiter)}</dt><dd>evidence coordinator only · ${esc(offer.terms.participants.arbiter.slice(0, 12))}…</dd></div></dl>
    <div class="button-row"><button class="secondary" data-copy="${esc(offer.encoded)}">Copy offer</button><button class="secondary" data-share-kind="message" data-share="${esc(offer.encoded)}">Copy offer link</button></div>
    <ol class="state-list"><li class="${accepted[0] && accepted[1] ? 'done' : ''}">Independent acceptance · ${accepted.filter(Boolean).length}/2</li><li>Real bond funding · disabled</li><li>Operator value control · none</li><li>Publisher role · protocol demo, not escrow operator</li></ol>
    ${packet ? '<p class="boundary">This browser contains a historical custodial packet. The public build will not import, fund, verify or settle it. Export any live bearer notes with the retired client before erasing local state.</p>' : ''}
  </div>`
}

const acceptanceHtml = (contract: NonNullable<ReturnType<typeof latestContract>>): string => {
  const localRoles = localPartyRoles(contract.offer)
  const rows = PARTY_ROLES.map(role => {
    const encoded = contract.record.acceptances[role]
    return `<article class="card"><h3>${esc(contract.offer.terms.labels[role])} · acceptance</h3>${encoded ? `<p>✓ Signed independently</p><textarea readonly>${esc(encoded)}</textarea><div class="button-row"><button class="secondary" data-copy="${esc(encoded)}">Copy acceptance</button><button class="secondary" data-share-kind="message" data-share="${esc(encoded)}">Copy link</button></div>` : localRoles.includes(role) ? `<p>This browser owns the named key. The archived v2 acceptance includes private payout hashes, but this public build cannot turn them into a bond.</p><button data-accept-role="${role}">Accept evidence-only terms</button>` : '<p>Waiting for the named party’s signed acceptance.</p>'}</article>`
  }).join('')
  return `<div class="stage"><div class="stage__heading"><span>02</span><div><h3>Parties countersign the exact offer</h3><p>This is portable evidence only. It creates no escrow and moves no money.</p></div></div><div class="two-columns">${rows}</div></div>`
}

const contractHtml = (): string => {
  let contract: ReturnType<typeof latestContract>
  try { contract = latestContract() } catch (error) { return `<section class="panel panel--bond"><p class="incoming incoming--bad">Stored contract refused: ${esc((error as Error).message)}</p></section>` }
  return `<section class="panel panel--bond" id="contract">
    <div class="panel__heading"><div><p class="eyebrow">FLOW B · EVIDENCE ONLY</p><h2>Independent people sign the same promise</h2></div><span class="assurance assurance--amber">real bonds disabled</span></div>
    <p class="panel__intro">The wire protocol still proves who enrolled and exactly what each side accepted. The public build stops there: no bond packet, funding acknowledgement, outcome decision or settlement path is accepted.</p>
    <p class="boundary"><b>Protocol demo, not an escrow service.</b> Moneyer publishes static demo source. It does not hold participant keys or funds, contract as either party, decide a forfeiture or move bilateral bond money. Anyone who turns this protocol into a customer service is responsible for that deployment’s controls, terms and legal position.</p>
    <div class="stage"><div class="stage__heading"><span>01</span><div><h3>Enrol keys and sign one canonical offer</h3><p>Do this in separate browser profiles for a real remote demonstration.</p></div></div><div class="three-columns">${enrolmentCard('party_a')}${enrolmentCard('party_b')}<article class="card"><h3>Evidence coordinator · key</h3>${store.identities.arbiter ? `<p class="keyprint">${esc(store.identities.arbiter.pubkey.slice(0, 20))}…</p>` : '<p>The coordinator signs the shared offer; it never creates either party key or decides what happened.</p><button data-create-arbiter>Create coordinator key</button>'}</article></div>
      <form data-create-contract class="contract-form"><h3>Evidence coordinator creates offer</h3><label>Template<select name="template">${CONTRACT_TEMPLATES.map(value => `<option value="${value}" ${value === 'ride' ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Title<input name="title" value="${esc(TEMPLATE_DEFAULTS.ride.title)}" maxlength="100" required /></label><label>Party A label<input name="partyA" value="Rider" maxlength="40" required /></label><label>Party B label<input name="partyB" value="Driver" maxlength="40" required /></label><label>Coordinator label<input name="arbiter" value="Evidence coordinator" maxlength="40" required /></label><label>Party A reference exposure, sats<input name="bondA" type="number" min="1" max="${MAX_DEMO_SATS}" value="10" required /></label><label>Party B reference exposure, sats<input name="bondB" type="number" min="1" max="${MAX_DEMO_SATS}" value="15" required /></label><label>Service starts in, minutes<input name="startsIn" type="number" min="16" max="43200" value="60" required /></label><label>Evidence window, hours<input name="settlementHours" type="number" min="1" max="720" value="24" required /></label><label>Review period, seconds<input name="challenge" type="number" min="60" max="604800" value="300" required /></label><label class="wide">Party A signed enrolment<textarea name="enrolmentA" required></textarea></label><label class="wide">Party B signed enrolment<textarea name="enrolmentB" required></textarea></label><label class="wide">Memo<textarea name="memo" maxlength="280"></textarea></label><label class="wide">Archived wire-format mint reference, not used<input name="mint" value="${DEFAULT_DISCOVERY}" readonly /></label><button class="wide">Create evidence-only signed offer</button></form>
    </div>
    ${contractStatus(contract)}
    ${contract ? acceptanceHtml(contract) : ''}
    <form data-import-contract class="import-form"><h3>Import an evidence-only signed message</h3><p>Only enrolment, offer and acceptance messages are accepted.</p><label><textarea name="encoded" required></textarea></label><button>Verify and import</button></form>
  </section>`
}

const cancellationHtml = (): string => `<section class="panel" id="cancellation">
  <div class="panel__heading"><div><p class="eyebrow">CANCELLATION MODEL</p><h2>Compensate loss. Don’t punish.</h2></div><span class="assurance">recommendation only</span></div>
  <p class="panel__intro">This symmetric model produces a transparent maximum recommendation. It never creates an entitlement, decides disputed facts or moves money.</p>
  <div class="columns">
    <form data-cancellation-model class="card"><h3>Try the schedule</h3>
      <label>Agreed service price, sats<input name="price" type="number" min="0" step="1" value="1000" required /></label>
      <label>Evidenced direct loss, sats<input name="loss" type="number" min="0" step="1" value="300" required /></label>
      <label>Notice before start, minutes<input name="notice" type="number" min="0" step="1" value="12" required /></label>
      <label>Protected reason<select name="reason"><option value="none">None</option><option value="safety">Safety</option><option value="emergency">Emergency</option><option value="force_majeure">Force majeure</option><option value="mutual">Mutual agreement</option></select></label>
      <button>Calculate maximum recommendation</button>
    </form>
    <article class="card cancellation-result" data-cancellation-result><h3>Current result</h3><p class="recommendation">Enter the facts and calculate.</p><p class="micro">The same schedule applies whether rider or driver cancels.</p></article>
    <article class="card"><h3>Guardrails</h3><ul class="plain-list"><li>30+ minutes or a protected reason: zero.</li><li>5–29 minutes: lower of evidenced direct loss and 25% of price.</li><li>Under 5 minutes or no-show: lower of evidenced direct loss and 50% of price.</li><li>Safety, emergency, force majeure and mutual agreement override timing.</li><li>This is an example protocol policy, not a Moneyer contract term or liability decision.</li></ul></article>
  </div>
</section>`

const recoveryHtml = (): string => {
  const legacy = legacyRecoveryJson()
  if (!legacy) return ''
  return `<section class="legacy-recovery"><h3>Earlier inspector data preserved</h3><p>The v2 lab did not overwrite the previous browser store. Copy its recovery JSON before deliberately erasing it.</p><div class="button-row"><button class="secondary" data-copy-legacy>Copy legacy recovery JSON</button><button class="danger" data-clear-legacy>Erase legacy store</button></div></section>`
}

const render = (): void => {
  app.innerHTML = `<header class="hero"><div class="hero__mark" aria-hidden="true">CC</div><div><p class="eyebrow">MONEYER PROTOCOL LAB</p><h1>Real payments. No platform custody.</h1><p class="lede">A live lab for recipient-owned LNURLcash payments and remotely signed bilateral evidence. New arbiter-held bonds are disabled.</p><p class="custody-note">The earlier 20-sat custodial completion remains reproducible historical evidence. It is not an invitation to fund another one.</p></div><span class="live-pill"><i></i> evidence-only v1</span></header>
  <main>${handoffHtml()}<section class="truth-grid"><article><span>01</span><h2>Direct money</h2><p>Real sats may move only to a recipient-owned output. Moneyer never gets the spend secret.</p></article><article><span>02</span><h2>Portable evidence</h2><p>Each person enrols and accepts on their own device. Signed evidence is not physical-world truth.</p></article><article><span>03</span><h2>Hard stop</h2><p>Bond packets, funding, forfeiture decisions and settlements are rejected by the public build.</p></article></section>${directHtml()}${contractHtml()}${cancellationHtml()}<section class="attack-lab"><div><p class="eyebrow">PUBLIC BOUNDARY</p><h2>What now fails closed</h2></div><ul><li><b>Import a bond packet:</b> refused before it enters browser state.</li><li><b>Import funding or settlement authority:</b> refused by message type.</li><li><b>Ask Moneyer to decide a forfeiture:</b> there is no public decision or execution path.</li><li><b>Use a blanket cancellation penalty:</b> the model caps recommendations by evidenced direct loss and timing.</li><li><b>Cancel for safety or emergency:</b> protected reasons return zero regardless of timing.</li><li><b>Pretend a signature proves the ride:</b> signatures prove authorship and agreed text, not real-world events.</li><li><b>Mistake source for a service:</b> publishing this protocol does not make Moneyer a ride counterparty, escrow provider or dispute adjudicator.</li><li><b>Modify delivered JavaScript:</b> cannot make Moneyer a custodian because the public bundle contains no bond funding or settlement calls.</li></ul></section>${recoveryHtml()}</main>
  <footer><span>Experimental · ${esc(PUBLIC_BOND_MODE.id)} · real bonds disabled</span><button class="text-button" data-reset>Erase this browser’s lab secrets</button></footer><div data-status class="status" role="status" aria-live="polite">Ready. Direct payments only; bilateral value movement is disabled.</div>`
  bind()
}

const formData = (form: HTMLFormElement): FormData => new FormData(form)

const run = async (event: Event | null, work: (form: HTMLFormElement) => Promise<void>): Promise<void> => {
  event?.preventDefault()
  try {
    const target = event?.currentTarget
    await work(target instanceof HTMLFormElement ? target : document.createElement('form'))
  } catch (error) {
    status((error as Error).message, 'bad')
  }
}

const bind = (): void => {
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach(button => button.addEventListener('click', () => void copy(button.dataset.copy ?? '')))
  document.querySelectorAll<HTMLElement>('[data-share]').forEach(button => button.addEventListener('click', () => void copyInternetLink(button.dataset.shareKind as 'request' | 'message' | 'packet', button.dataset.share ?? '')))

  document.querySelector<HTMLElement>('[data-import-incoming-message]')?.addEventListener('click', () => void run(null, async () => {
    if (!incomingMessage) throw new Error('No incoming message is available.')
    const message = incomingMessage
    const offerId = message.type === 'contract_offer' ? message.event.id : message.type === 'enrolment' ? message.event.id : message.offerId
    await withExclusiveBrowserLock(`contract:${offerId}`, async () => {
      store = loadStore()
      importContractMessage(message)
    }, {requireCrossContext: true})
    clearFragment()
    render()
    status('Signed contract message verified and imported.')
  }))
  document.querySelector<HTMLFormElement>('[data-create-payment]')?.addEventListener('submit', event => void run(event, async form => {
    const data = formData(form)
    const contractId = String(data.get('contractId'))
    await withExclusiveBrowserLock(`contract:${contractId}`, async () => {
      store = loadStore()
      await createDirectRequest(contractId, Number(data.get('amount')), String(data.get('mint')))
    })
    render()
    status('Recipient request created. Its secret was persisted before the signed hash was shown.')
  }))

  document.querySelector<HTMLFormElement>('[data-pay-request]')?.addEventListener('submit', event => void run(event, async form => {
    const data = formData(form)
    const request = decodeRequest(String(data.get('request')))
    if (isCommitmentIntent(request.intent)) throw new Error('Fund a commitment only from its verified full contract packet.')
    assertTrustedMint(request.intent.mint)
    if (!confirm(`Fund ${request.intent.amount} sats?\n\nContract: ${contractIdOf(request.intent)}\nMint: ${request.intent.mint.host}\nSigner: ${request.event.pubkey.slice(0, 16)}…\nRequest: ${requestFingerprint(request)}`)) return
    const noteInput = String(data.get('note'))
    const noteUrl = resolveNoteInput(noteInput)
    const spendSecret = noteUrl ? noteK1(noteUrl) : null
    if (!spendSecret) throw new Error('That is not an LNURLcash bearer note.')
    let receipt: FundingReceipt | undefined
    await withExclusiveBrowserLock(`request:${request.event.id}`, async () => {
      await withExclusiveBrowserLock(`spend:${hashK1(spendSecret)}`, async () => {
        receipt = await fundReceiverLockedRequest(request, noteInput)
        store = loadStore()
        const local = Object.values(store.requests).find(record => record.encoded === request.encoded)
        if (local) local.receipt = receipt
        saveStore(store)
      }, {requireCrossContext: true})
    }, {requireCrossContext: true})
    render()
    status(receipt!.outcome === 'confirmed' ? 'Mint confirmed the receiver-locked transfer.' : 'Mutation response was lost. The recipient must probe; do not retry.', receipt!.outcome === 'confirmed' ? 'ok' : 'warn')
  }))

  document.querySelectorAll<HTMLElement>('[data-verify-request]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const requestId = button.dataset.verifyRequest!
    const record = store.requests[requestId]
    if (!record) throw new Error('Request not found.')
    const request = decodeRequest(record.encoded, 0)
    assertTrustedMint(request.intent.mint)
    record.received = await receiveLockedPayment(request, record.receiverSecretHex, record.receipt)
    saveStore(store)
    render()
    status(`Mint confirms ${record.intent.amount} sats under the recipient-owned secret.`)
  })))

  document.querySelectorAll<HTMLElement>('[data-create-enrolment]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const role = button.dataset.createEnrolment
    if (!isPartyRole(role)) throw new Error('Unknown participant role.')
    const local = identity(role, true)!
    store.enrolments ??= {}
    store.enrolments[role] = signEnrolment(role, local.secretHex).encoded
    saveStore(store)
    render()
    status(`${role.replace('_', ' ')} enrolment signed. Share it with the evidence coordinator.`)
  })))

  document.querySelector<HTMLElement>('[data-create-arbiter]')?.addEventListener('click', () => {
    identity('arbiter', true)
    render()
    status('Evidence coordinator key created in this browser only.')
  })

  document.querySelector<HTMLSelectElement>('[data-create-contract] select[name="template"]')?.addEventListener('change', event => {
    const form = (event.currentTarget as HTMLElement).closest<HTMLFormElement>('form')!
    const template = (event.currentTarget as HTMLSelectElement).value as ContractTemplate
    const preset = TEMPLATE_DEFAULTS[template]
    ;(form.elements.namedItem('title') as HTMLInputElement).value = preset.title
    ;(form.elements.namedItem('partyA') as HTMLInputElement).value = preset.partyA
    ;(form.elements.namedItem('partyB') as HTMLInputElement).value = preset.partyB
    ;(form.elements.namedItem('arbiter') as HTMLInputElement).value = preset.arbiter
  })

  document.querySelector<HTMLFormElement>('[data-create-contract]')?.addEventListener('submit', event => void run(event, async form => {
    const data = formData(form)
    const enrolmentA = decodeContractMessage(String(data.get('enrolmentA')))
    const enrolmentB = decodeContractMessage(String(data.get('enrolmentB')))
    if (enrolmentA.type !== 'enrolment' || enrolmentA.role !== 'party_a') throw new Error('The Party A enrolment is not signed for Party A.')
    if (enrolmentB.type !== 'enrolment' || enrolmentB.role !== 'party_b') throw new Error('The Party B enrolment is not signed for Party B.')
    const arbiter = identity('arbiter', true)!
    const discoveryUrl = new URL(String(data.get('mint')))
    if (!TRUSTED_MINTS[discoveryUrl.host.toLowerCase()]) throw new Error('That mint is not allowlisted.')
    const mintAddress = await fetchMintAddress(discoveryUrl.toString())
    const mint = {host: discoveryUrl.host, withdrawLink: mintAddress.callback, ...(mintAddress.mintPubkey ? {mintPubkey: mintAddress.mintPubkey} : {})}
    assertTrustedMint(mint)
    const now = Math.floor(Date.now() / 1000)
    const serviceStarts = now + Number(data.get('startsIn')) * 60
    const terms: ContractTerms = {
      v: 1,
      contractId: randomId(),
      template: String(data.get('template')) as ContractTemplate,
      title: String(data.get('title')),
      memo: String(data.get('memo')),
      labels: {party_a: String(data.get('partyA')), party_b: String(data.get('partyB')), arbiter: String(data.get('arbiter'))},
      participants: {party_a: enrolmentA.event.pubkey, party_b: enrolmentB.event.pubkey, arbiter: arbiter.pubkey},
      bonds: {party_a: String(data.get('bondA')), party_b: String(data.get('bondB'))},
      mint,
      setupExpires: now + 15 * 60,
      serviceStarts,
      settlementExpires: serviceStarts + Number(data.get('settlementHours')) * 3600,
      policy: {id: 'bilateral-arbiter-v2', version: 2, challengeSeconds: Number(data.get('challenge'))}
    }
    const offer = signContractOffer(terms, arbiter.secretHex)
    normaliseContract(offer.event.id, offer.encoded)
    saveStore(store)
    render()
    status('Canonical offer signed by the evidence coordinator. Both parties must independently accept it.')
  }))

  document.querySelectorAll<HTMLElement>('[data-accept-role]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const role = button.dataset.acceptRole
    if (!isPartyRole(role)) throw new Error('Unknown acceptance role.')
    const contract = latestContract()
    if (!contract) throw new Error('No contract offer is selected.')
    await withExclusiveBrowserLock(`contract:${contract.offerId}`, async () => {
      store = loadStore()
      const current = latestContract()
      if (!current || current.offerId !== contract.offerId) throw new Error('The selected contract changed before acceptance.')
      assertOfferOpen(current.offer)
      const local = store.identities[role]
      if (!local || local.pubkey !== current.offer.terms.participants[role]) throw new Error('This browser does not own the named participant key.')
      store.payoutTargets[current.offerId] ??= {}
      let target = store.payoutTargets[current.offerId]![role]
      const storedAcceptance = current.record.acceptances[role]
      if (storedAcceptance) {
        const accepted = decodeContractMessage(storedAcceptance, 0)
        if (accepted.type !== 'acceptance' || accepted.role !== role) throw new Error('The stored participant acceptance is malformed.')
        assertAcceptance(accepted, current.offer)
        if (!target?.acceptance || decodeContractMessage(target.acceptance, 0).event.id !== accepted.event.id) throw new Error('The stored acceptance has lost its private payout continuity. Refuse to replace it.')
        for (const sourceRole of PARTY_ROLES) {
          if (target.outputHashes[sourceRole] !== accepted.payoutHashes[sourceRole] || outputHashOf(target.secrets[sourceRole]) !== accepted.payoutHashes[sourceRole]) {
            throw new Error('The stored acceptance payout secret no longer matches its signed hash.')
          }
        }
        return
      }
      if (!target) {
        const secrets = {party_a: randomSecretHex(), party_b: randomSecretHex()}
        target = {
          secrets,
          outputHashes: {party_a: outputHashOf(secrets.party_a), party_b: outputHashOf(secrets.party_b)},
          received: {}
        }
        store.payoutTargets[current.offerId]![role] = target
        saveStore(store)
      }
      const acceptance = signAcceptance(current.offer, role, target.outputHashes, local.secretHex)
      target.acceptance = acceptance.encoded
      current.record.acceptances[role] = acceptance.encoded
      saveStore(store)
    }, {requireCrossContext: true})
    render()
    status(`${contract.offer.terms.labels[role]} accepted the evidence-only offer. No bond was created or funded.`)
  })))

  document.querySelector<HTMLFormElement>('[data-cancellation-model]')?.addEventListener('submit', event => void run(event, async form => {
    const data = formData(form)
    const recommendation = cancellationRecommendation({
      agreedPriceSats: Number(data.get('price')),
      evidencedDirectLossSats: Number(data.get('loss')),
      noticeMinutes: Number(data.get('notice')),
      protectedReason: String(data.get('reason')) as ProtectedCancellationReason
    })
    const output = document.querySelector<HTMLElement>('[data-cancellation-result]')
    if (!output) throw new Error('The cancellation result panel is missing.')
    output.innerHTML = `<h3>Maximum recommendation</h3><p class="recommendation"><b>${recommendation.maximumSats} sats</b></p><p>${esc(recommendation.explanation)}</p><p class="micro">Money moved by this calculator: no. This is not a finding of liability.</p>`
    status(`Maximum recommendation: ${recommendation.maximumSats} sats. No money moved.`)
  }))

  document.querySelector<HTMLFormElement>('[data-import-contract]')?.addEventListener('submit', event => void run(event, async form => {
    const encoded = String(formData(form).get('encoded')).trim()
    if (encoded.startsWith('cashpacket1')) {
      assertPublicPacketImportDisabled()
    } else {
      const message = decodeContractMessage(encoded)
      assertPublicCoordinationMessageType(message.type)
      const offerId = message.type === 'contract_offer' ? message.event.id : message.type === 'enrolment' ? message.event.id : message.offerId
      await withExclusiveBrowserLock(`contract:${offerId}`, async () => {
        store = loadStore()
        importContractMessage(message)
      }, {requireCrossContext: true})
    }
    render()
    status('Evidence-only signed message verified and imported.')
  }))

  document.querySelector<HTMLElement>('[data-copy-legacy]')?.addEventListener('click', () => void copy(legacyRecoveryJson() ?? ''))
  document.querySelector<HTMLElement>('[data-clear-legacy]')?.addEventListener('click', () => {
    if (!confirm('Permanently erase the earlier inspector store? Copy its recovery JSON first if it may contain live note secrets.')) return
    clearLegacyStore()
    render()
    status('Earlier inspector store erased.', 'warn')
  })
  document.querySelector<HTMLElement>('[data-reset]')?.addEventListener('click', () => {
    if (!confirm('Erase this browser’s lab keys and local signed evidence? Export any direct-payment notes first.')) return
    clearStore()
    store = loadStore()
    render()
    status('This browser’s lab state was erased.', 'warn')
  })
}

readIncoming()
render()
if (incomingError) status(incomingError, 'bad')

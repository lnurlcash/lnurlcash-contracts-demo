import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {fetchMintAddress, hashK1, noteK1, resolveNoteInput} from 'lnurlcash-kit'
import {applyPayoutAcknowledgement, contractActivationState, disputeTerminalAt, evaluateResolutionEvidence, resolveHeldCommitments} from './bonds'
import {
  fundReceiverLockedRequest,
  receiveLockedPayment,
  receiveRedirectedPayout,
  redirectHeldNoteToHash,
  type FundingReceipt,
  type SettlementReceipt
} from './cash'
import {
  assertAcceptance,
  assertArbiterDecision,
  assertFundingAcknowledgement,
  assertOfferOpen,
  assertOutcomeStatement,
  assertPayoutAcknowledgement,
  assertSettlementNotice,
  decodeContractMessage,
  decodeContractPacket,
  encodeContractPacket,
  messageFingerprint,
  packetFingerprint,
  signAcceptance,
  signArbiterDecision,
  signContractOffer,
  signEnrolment,
  signFundingAcknowledgement,
  signOutcomeStatement,
  signPayoutAcknowledgement,
  signSettlementNotice,
  type ContractMessage,
  type ContractPacket,
  type SignedContractOffer,
  type SignedSettlementNotice
} from './coordination'
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
  type CommitmentIntent,
  type DirectPaymentIntent,
  type SignedRequest
} from './protocol'
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
const DEFAULT_DISCOVERY = 'https://mint.forgesworn.dev/.well-known/lnurlw/_'
const TEMPLATE_DEFAULTS: Record<ContractTemplate, {title: string; partyA: string; partyB: string; arbiter: string}> = {
  ride: {title: 'Point-to-point ride', partyA: 'Rider', partyB: 'Driver', arbiter: 'Ride arbiter'},
  delivery: {title: 'Item delivery', partyA: 'Customer', partyB: 'Courier', arbiter: 'Dispatch arbiter'},
  booking: {title: 'Reserved booking', partyA: 'Guest', partyB: 'Provider', arbiter: 'Booking arbiter'},
  work: {title: 'Contracted work', partyA: 'Client', partyB: 'Contractor', arbiter: 'Project arbiter'},
  custom: {title: 'Bilateral commitment', partyA: 'Party A', partyB: 'Party B', arbiter: 'Arbiter'}
}

let store: DemoStore = loadStore()
let incomingRequest: SignedRequest | undefined
let incomingMessage: ContractMessage | undefined
let incomingPacket: ContractPacket | undefined
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
  incomingPacket = undefined
  incomingError = ''
}

const readIncoming = (): void => {
  incomingRequest = undefined
  incomingMessage = undefined
  incomingPacket = undefined
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
    } else if (packet) {
      incomingPacket = decodeContractPacket(packet, 0)
      assertTrustedMint(incomingPacket.offer.terms.mint)
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
  const existing = store.contracts[offerId]
  if (existing) {
    existing.acceptances ??= {}
    existing.fundingAcks ??= {}
    existing.outcomes ??= []
    existing.settlementNotices ??= []
    existing.payoutAcks ??= []
    return existing
  }
  const created: StoredContract = {offer: offerEncoded, acceptances: {}, fundingAcks: {}, outcomes: [], settlementNotices: [], payoutAcks: []}
  store.contracts[offerId] = created
  return created
}

const latestDirect = (): [string, StoredRequest] | undefined => Object.entries(store.requests).filter(([, record]) => (
  isDirectPaymentIntent(record.intent) || (record.intent.v === 1 && record.intent.purpose === 'fare')
)).at(-1)

const latestContract = (): {offerId: string; record: StoredContract; offer: SignedContractOffer; packet?: ContractPacket} | undefined => {
  const pair = Object.entries(store.contracts).at(-1)
  if (!pair) return undefined
  const message = decodeContractMessage(pair[1].offer, 0)
  if (message.type !== 'contract_offer') throw new Error('Stored contract offer has the wrong message type.')
  return {offerId: pair[0], record: normaliseContract(pair[0], pair[1].offer), offer: message, ...(pair[1].packet ? {packet: decodeContractPacket(pair[1].packet, 0)} : {})}
}

const localPartyRoles = (offer: SignedContractOffer): PartyRole[] => PARTY_ROLES.filter(role => store.identities[role]?.pubkey === offer.terms.participants[role])

const localArbiter = (offer: SignedContractOffer): StoredIdentity | undefined => {
  const value = store.identities.arbiter
  return value?.pubkey === offer.terms.participants.arbiter ? value : undefined
}

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
  if (message.type === 'enrolment') throw new Error('Use an enrolment in the arbiter offer form; it does not accept a contract by itself.')
  if (message.type === 'contract_offer') {
    assertOfferOpen(message)
    normaliseContract(message.event.id, message.encoded)
    saveStore(store)
    return
  }
  const record = store.contracts[message.offerId]
  if (!record) throw new Error('Import the referenced contract offer or packet first.')
  const offerMessage = decodeContractMessage(record.offer, 0)
  if (offerMessage.type !== 'contract_offer') throw new Error('Stored offer is malformed.')
  const packet = record.packet ? decodeContractPacket(record.packet, 0) : undefined
  if (message.type === 'acceptance') {
    assertAcceptance(message, offerMessage)
    record.acceptances[message.role] = message.encoded
  } else {
    if (!packet) throw new Error('Import the full contract packet before funding, outcome, decision or settlement messages.')
    if (message.type === 'funding_ack') {
      assertFundingAcknowledgement(message, packet)
      record.fundingAcks[message.role] = message.encoded
    } else if (message.type === 'outcome') {
      assertOutcomeStatement(message, packet)
      if (!record.outcomes.some(encoded => decodeContractMessage(encoded, 0).event.id === message.event.id)) record.outcomes.push(message.encoded)
    } else if (message.type === 'arbiter_decision') {
      assertArbiterDecision(message, packet)
      record.decision = message.encoded
    } else if (message.type === 'settlement_notice') {
      assertSettlementNotice(message, packet)
      if (!record.settlementNotices.some(encoded => decodeContractMessage(encoded, 0).event.id === message.event.id)) record.settlementNotices.push(message.encoded)
    } else {
      const noticeInput = record.settlementNotices.find(encoded => decodeContractMessage(encoded, 0).event.id === message.noticeId)
      if (!noticeInput) throw new Error('Import the referenced settlement notice before its payout acknowledgement.')
      const notice = decodeContractMessage(noticeInput, 0)
      if (notice.type !== 'settlement_notice') throw new Error('Stored settlement notice is malformed.')
      assertPayoutAcknowledgement(message, notice, packet)
      if (!record.payoutAcks.some(encoded => decodeContractMessage(encoded, 0).event.id === message.event.id)) record.payoutAcks.push(message.encoded)
    }
  }
  saveStore(store)
}

const importPacket = (packet: ContractPacket): void => {
  assertTrustedMint(packet.offer.terms.mint)
  const record = normaliseContract(packet.offer.event.id, packet.offer.encoded)
  record.acceptances.party_a = packet.acceptances.party_a.encoded
  record.acceptances.party_b = packet.acceptances.party_b.encoded
  record.packet = packet.encoded
  saveStore(store)
}

const messageSummary = (message: ContractMessage): string => {
  if (message.type === 'contract_offer') return `contract offer · ${message.terms.title}`
  if (message.type === 'enrolment') return `${message.role.replace('_', ' ')} enrolment`
  if (message.type === 'acceptance') return `${message.role.replace('_', ' ')} acceptance`
  if (message.type === 'funding_ack') return `${message.role.replace('_', ' ')} funding acknowledgement`
  if (message.type === 'outcome') return `${message.outcome.replaceAll('_', ' ')} outcome`
  if (message.type === 'arbiter_decision') return `${message.resolution.replaceAll('_', ' ')} arbiter decision`
  if (message.type === 'settlement_notice') return `${message.beneficiary.replace('_', ' ')} settlement notice`
  return `${message.beneficiary.replace('_', ' ')} payout acknowledgement`
}

const handoffHtml = (): string => {
  let incoming = ''
  if (incomingRequest) incoming = `<p class="incoming"><b>Incoming receiver request:</b> ${esc(incomingRequest.intent.amount)} sats · contract ${esc(contractIdOf(incomingRequest.intent))} · request ${esc(requestFingerprint(incomingRequest))}</p>`
  if (incomingMessage) incoming = `<p class="incoming"><b>Incoming ${esc(messageSummary(incomingMessage))}</b> · message ${esc(messageFingerprint(incomingMessage))}<button type="button" data-import-incoming-message>Verify and import</button></p>`
  if (incomingPacket) incoming = `<p class="incoming"><b>Incoming full contract packet:</b> ${esc(incomingPacket.offer.terms.title)} · packet ${esc(packetFingerprint(incomingPacket))}<button type="button" data-import-incoming-packet>Verify every component and import</button></p>`
  if (incomingError) incoming = `<p class="incoming incoming--bad"><b>Incoming payload refused:</b> ${esc(incomingError)}</p>`
  return `<section class="handoff" aria-label="Remote hand-off"><div><p class="eyebrow">INTERNET HAND-OFF</p><h2>Different people. Independent keys.</h2></div><p>Offers, acceptances, funding acknowledgements and outcomes travel as signed fragment links. The server never receives the fragment. Each browser revalidates every component before it changes state.</p>${incoming}</section>`
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
        <p class="micro">Use a disposable note of exactly the signed value. Commitment bonds must be funded from a complete contract packet below.</p>
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
  let activation: ReturnType<typeof contractActivationState> | undefined
  if (packet && localArbiter(offer) && PARTY_ROLES.every(role => store.requests[packet.bondRequests[role].event.id])) {
    try { activation = contractActivationState(store, packet) } catch { /* rendered as not active and surfaced on action */ }
  }
  const outcomes = record.outcomes.map(encoded => {
    const message = decodeContractMessage(encoded, 0)
    if (message.type !== 'outcome') throw new Error('Stored outcome is malformed.')
    const signerRole = packet ? assertOutcomeStatement(message, packet) : undefined
    return {message, signerRole}
  })
  const evidence = packet ? evaluateResolutionEvidence(packet, record.outcomes, record.decision) : undefined
  return `<div class="contract-summary">
    <div><p class="eyebrow">CURRENT CONTRACT</p><h3>${esc(offer.terms.title)}</h3><p>${esc(offer.terms.template)} · ${esc(offer.terms.policy.id)} · offer ${esc(offer.event.id.slice(0, 12))}</p></div>
    <dl><div><dt>${esc(offer.terms.labels.party_a)}</dt><dd>${esc(offer.terms.bonds.party_a)} sats · ${esc(offer.terms.participants.party_a.slice(0, 12))}…</dd></div><div><dt>${esc(offer.terms.labels.party_b)}</dt><dd>${esc(offer.terms.bonds.party_b)} sats · ${esc(offer.terms.participants.party_b.slice(0, 12))}…</dd></div><div><dt>${esc(offer.terms.labels.arbiter)}</dt><dd>${esc(offer.terms.participants.arbiter.slice(0, 12))}…</dd></div></dl>
    <div class="button-row"><button class="secondary" data-copy="${esc(offer.encoded)}">Copy offer</button><button class="secondary" data-share-kind="message" data-share="${esc(offer.encoded)}">Copy offer link</button></div>
    <ol class="state-list"><li class="${accepted[0] && accepted[1] ? 'done' : ''}">Independent acceptance · ${accepted.filter(Boolean).length}/2</li><li class="${packet ? 'done' : ''}">Exact bond packet · ${packet ? esc(packetFingerprint(packet)) : 'not created'}</li><li class="${activation?.active ? 'done' : ''}">Activation · ${activation?.active ? 'both held + both acknowledged' : 'not proved in this browser'}</li><li class="${evidence?.state === 'executable' ? 'done' : ''}">Outcome authority · ${evidence ? esc(evidence.state === 'pending' ? evidence.reason : evidence.state === 'disputed' ? `disputed${evidence.challengeEnds ? ` until ${new Date(evidence.challengeEnds * 1000).toLocaleTimeString()}` : ''}` : evidence.resolution.replaceAll('_', ' ')) : 'waiting for packet'}</li></ol>
    ${outcomes.length ? `<ul class="message-list">${outcomes.map(({message, signerRole}) => `<li><span>${esc(signerRole?.replace('_', ' ') ?? 'unknown')} signed <b>${esc(message.outcome.replaceAll('_', ' '))}</b> · ${esc(message.event.id.slice(0, 12))}</span><div class="button-row"><button class="secondary" data-copy="${esc(message.encoded)}">Copy outcome</button><button class="secondary" data-share-kind="message" data-share="${esc(message.encoded)}">Copy link</button></div></li>`).join('')}</ul>` : ''}
  </div>`
}

const acceptanceHtml = (contract: NonNullable<ReturnType<typeof latestContract>>): string => {
  const localRoles = localPartyRoles(contract.offer)
  const rows = PARTY_ROLES.map(role => {
    const encoded = contract.record.acceptances[role]
    return `<article class="card"><h3>${esc(contract.offer.terms.labels[role])} · acceptance</h3>${encoded ? `<p>✓ Signed independently</p><textarea readonly>${esc(encoded)}</textarea><div class="button-row"><button class="secondary" data-copy="${esc(encoded)}">Copy acceptance</button><button class="secondary" data-share-kind="message" data-share="${esc(encoded)}">Copy link</button></div>` : localRoles.includes(role) ? `<p>This browser owns the named key. It will generate and persist two payout secrets before signing their hashes.</p><button data-accept-role="${role}">Accept terms and make payout targets</button>` : '<p>Waiting for the named party’s signed acceptance.</p>'}</article>`
  }).join('')
  return `<div class="stage"><div class="stage__heading"><span>02</span><div><h3>Parties countersign the exact offer</h3><p>The arbiter cannot substitute payout destinations later.</p></div></div><div class="two-columns">${rows}</div>${localArbiter(contract.offer) && PARTY_ROLES.every(role => contract.record.acceptances[role]) && !contract.packet ? '<button data-create-packet>Create exact bond requests and activation packet</button>' : ''}</div>`
}

const fundingCard = (contract: NonNullable<ReturnType<typeof latestContract>>, role: PartyRole): string => {
  const packet = contract.packet!
  const request = packet.bondRequests[role]
  const isLocal = localPartyRoles(contract.offer).includes(role)
  const ack = contract.record.fundingAcks[role]
  const arbiterRecord = store.requests[request.event.id]
  return `<article class="card"><h3>${esc(contract.offer.terms.labels[role])} · ${esc(request.intent.amount)} sat bond</h3><p>Request ${esc(request.event.id.slice(0, 12))} · ${ack ? 'payer acknowledged' : 'no payer acknowledgement'} · ${arbiterRecord?.received ? 'arbiter verified' : 'not verified here'}</p>${isLocal && !ack ? `<form data-fund-contract="${role}"><label>Exact ${esc(request.intent.amount)} sat bearer note<textarea name="note" required></textarea></label><button>Fund my signed commitment</button></form>` : ''}${ack ? `<textarea readonly>${esc(ack)}</textarea><div class="button-row"><button class="secondary" data-copy="${esc(ack)}">Copy funding ack</button><button class="secondary" data-share-kind="message" data-share="${esc(ack)}">Copy link</button></div>` : ''}${localArbiter(contract.offer) && arbiterRecord && !arbiterRecord.received ? `<button class="secondary" data-verify-bond="${role}">Arbiter probes mint output</button>` : ''}</article>`
}

const outcomeHtml = (contract: NonNullable<ReturnType<typeof latestContract>>): string => {
  if (!contract.packet) return ''
  const packet = contract.packet
  const localRoles = localPartyRoles(contract.offer)
  let activation: ReturnType<typeof contractActivationState> | undefined
  if (localArbiter(contract.offer) && PARTY_ROLES.every(role => store.requests[packet.bondRequests[role].event.id])) {
    try { activation = contractActivationState(store, packet) } catch { /* fail closed */ }
  }
  const evidence = evaluateResolutionEvidence(packet, contract.record.outcomes, contract.record.decision)
  const settlementRows = contract.record.settlementNotices.map(encoded => {
    const notice = decodeContractMessage(encoded, 0)
    if (notice.type !== 'settlement_notice') throw new Error('Stored settlement notice is malformed.')
    const localBeneficiary = localRoles.includes(notice.beneficiary)
    const target = store.payoutTargets[contract.offerId]?.[notice.beneficiary]
    const received = target?.received[notice.sourceRole]
    const payoutAck = contract.record.payoutAcks.find(value => {
      const message = decodeContractMessage(value, 0)
      return message.type === 'payout_ack' && message.noticeId === notice.event.id
    })
    const journal = store.settlements.find(item => item.bondRequestId === notice.bondRequestId)
    const canReconcile = Boolean(payoutAck && localArbiter(contract.offer) && journal?.state === 'ambiguous')
    return `<li><div><b>${esc(contract.offer.terms.labels[notice.beneficiary])}</b> receives ${notice.amountMsat / 1000} sats from ${esc(contract.offer.terms.labels[notice.sourceRole])}'s bond · ${esc(notice.mutationOutcome.replaceAll('_', ' '))} · ${payoutAck ? 'beneficiary acknowledged' : 'awaiting beneficiary probe'}</div><div class="button-row"><button class="secondary" data-copy="${esc(encoded)}">Copy notice</button><button class="secondary" data-share-kind="message" data-share="${esc(encoded)}">Copy link</button></div>${localBeneficiary && target && !received ? `<button data-probe-payout="${esc(notice.event.id)}">Probe my private payout target</button>` : ''}${received ? `<textarea readonly>${esc(received.noteUrl)}</textarea><button class="secondary" data-copy="${esc(received.noteUrl)}">Copy note into wallet</button>` : ''}${payoutAck ? `<div class="button-row"><button class="secondary" data-copy="${esc(payoutAck)}">Copy payout ack</button><button class="secondary" data-share-kind="message" data-share="${esc(payoutAck)}">Copy ack link</button></div>` : ''}${canReconcile ? `<button class="secondary" data-reconcile-payout="${esc(notice.event.id)}">Reconcile acknowledged ambiguous leg</button>` : ''}</li>`
  }).join('')
  const setupExpired = Math.floor(Date.now() / 1000) >= contract.offer.terms.setupExpires
  const heldCount = activation ? PARTY_ROLES.filter(role => activation!.held[role]).length : 0
  const nowSeconds = Math.floor(Date.now() / 1000)
  const contractExpired = nowSeconds >= contract.offer.terms.settlementExpires
  // Two distinct no-fault exits. A dispute never becomes 'pending', so without
  // the second test the terminal refund would be unreachable from this browser.
  const timeoutLabel = evidence.state === 'disputed'
    ? 'Dispute unresolved past the challenge deadline · refund both, no fault assigned'
    : 'Settlement window expired · refund both'
  const canTimeout = Boolean(activation?.active) && (
    (contractExpired && evidence.state === 'pending') ||
    (evidence.state === 'disputed' && nowSeconds >= disputeTerminalAt(packet))
  )
  return `<div class="stage"><div class="stage__heading"><span>04</span><div><h3>Imported authority moves value</h3><p>No button manufactures a party signature.</p></div></div>
    ${localRoles.map(role => `<article class="outcome-maker"><h4>Sign as ${esc(contract.offer.terms.labels[role])}</h4><div class="outcome-actions"><button data-sign-outcome="complete" data-sign-role="${role}">Complete</button><button class="secondary" data-sign-outcome="mutual_cancel" data-sign-role="${role}">Mutual cancel</button><button class="danger" data-sign-outcome="${role}_cancel" data-sign-role="${role}">I self-cancel</button><button class="secondary" data-sign-outcome="dispute" data-sign-role="${role}">Raise dispute</button></div></article>`).join('')}
    ${evidence.state === 'disputed' && localArbiter(contract.offer) ? `<form data-create-decision class="decision-form"><h4>Arbiter decision</h4><label>Resolution<select name="resolution"><option value="refund_both">Refund both</option><option value="award_party_a">Award ${esc(contract.offer.terms.labels.party_a)}</option><option value="award_party_b">Award ${esc(contract.offer.terms.labels.party_b)}</option></select></label><label>Reason<select name="reason"><option value="no_show">No show</option><option value="service_failure">Service failure</option><option value="safety">Safety</option><option value="other">Other</option></select></label><label>Evidence summary<textarea name="evidence" required></textarea></label><button>Sign challenge-delayed decision</button></form>` : ''}
    ${contract.record.decision ? `<textarea readonly>${esc(contract.record.decision)}</textarea><div class="button-row"><button class="secondary" data-copy="${esc(contract.record.decision)}">Copy decision</button><button class="secondary" data-share-kind="message" data-share="${esc(contract.record.decision)}">Copy decision link</button></div>` : ''}
    ${localArbiter(contract.offer) && evidence.state === 'executable' && activation?.active ? `<button data-settle-contract>Execute ${esc(evidence.resolution.replaceAll('_', ' '))} into signed payout targets</button>` : ''}
    ${localArbiter(contract.offer) && setupExpired && heldCount > 0 && !activation?.active ? '<button class="secondary" data-abort-setup>Setup expired · refund every funded but unactivated side</button>' : ''}
    ${localArbiter(contract.offer) && canTimeout ? `<button class="secondary" data-timeout-contract>${esc(timeoutLabel)}</button>` : ''}
    ${settlementRows ? `<div class="payouts"><h3>Arbiter-signed settlement notices</h3><ul>${settlementRows}</ul></div>` : ''}
  </div>`
}

const contractHtml = (): string => {
  let contract: ReturnType<typeof latestContract>
  try { contract = latestContract() } catch (error) { return `<section class="panel panel--bond"><p class="incoming incoming--bad">Stored contract refused: ${esc((error as Error).message)}</p></section>` }
  return `<section class="panel panel--bond" id="contract">
    <div class="panel__heading"><div><p class="eyebrow">FLOW B · GENERIC BILATERAL COMMITMENT</p><h2>Independent people put skin in the game</h2></div><span class="assurance assurance--amber">arbiter custody</span></div>
    <p class="panel__intro">The wire protocol knows Party A, Party B and arbiter. Ride, delivery, booking and contracted work are signed labels and templates over the same fixed policy.</p>
    <div class="stage"><div class="stage__heading"><span>01</span><div><h3>Enrol keys and sign one canonical offer</h3><p>Do this in separate browser profiles for a real remote demonstration.</p></div></div><div class="three-columns">${enrolmentCard('party_a')}${enrolmentCard('party_b')}<article class="card"><h3>Arbiter · key</h3>${store.identities.arbiter ? `<p class="keyprint">${esc(store.identities.arbiter.pubkey.slice(0, 20))}…</p>` : '<p>The arbiter creates its own key; it never creates either party key.</p><button data-create-arbiter>Create arbiter key</button>'}</article></div>
      <form data-create-contract class="contract-form"><h3>Arbiter creates offer</h3><label>Template<select name="template">${CONTRACT_TEMPLATES.map(value => `<option value="${value}" ${value === 'ride' ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Title<input name="title" value="${esc(TEMPLATE_DEFAULTS.ride.title)}" maxlength="100" required /></label><label>Party A label<input name="partyA" value="Rider" maxlength="40" required /></label><label>Party B label<input name="partyB" value="Driver" maxlength="40" required /></label><label>Arbiter label<input name="arbiter" value="Ride arbiter" maxlength="40" required /></label><label>Party A bond, sats<input name="bondA" type="number" min="1" max="${MAX_DEMO_SATS}" value="10" required /></label><label>Party B bond, sats<input name="bondB" type="number" min="1" max="${MAX_DEMO_SATS}" value="15" required /></label><label>Service starts in, minutes<input name="startsIn" type="number" min="16" max="43200" value="60" required /></label><label>Settlement window, hours<input name="settlementHours" type="number" min="1" max="720" value="24" required /></label><label>Challenge period, seconds<input name="challenge" type="number" min="60" max="604800" value="300" required /></label><label class="wide">Party A signed enrolment<textarea name="enrolmentA" required></textarea></label><label class="wide">Party B signed enrolment<textarea name="enrolmentB" required></textarea></label><label class="wide">Memo<textarea name="memo" maxlength="280"></textarea></label><label class="wide">Allowlisted mint<input name="mint" value="${DEFAULT_DISCOVERY}" readonly /></label><button class="wide">Create arbiter-signed offer</button></form>
    </div>
    ${contractStatus(contract)}
    ${contract ? acceptanceHtml(contract) : ''}
    ${contract?.packet ? `<div class="stage"><div class="stage__heading"><span>03</span><div><h3>Each named payer funds its exact request</h3><p>The arbiter separately probes both outputs. Neither fact substitutes for the other.</p></div></div><textarea readonly>${esc(contract.packet.encoded)}</textarea><div class="button-row"><button class="secondary" data-copy="${esc(contract.packet.encoded)}">Copy full packet</button><button class="secondary" data-share-kind="packet" data-share="${esc(contract.packet.encoded)}">Copy packet link</button></div><div class="two-columns">${fundingCard(contract, 'party_a')}${fundingCard(contract, 'party_b')}</div></div>${outcomeHtml(contract)}` : ''}
    <form data-import-contract class="import-form"><h3>Import a signed message or full packet</h3><label><textarea name="encoded" required></textarea></label><button>Verify and import</button></form>
  </section>`
}

const recoveryHtml = (): string => {
  const legacy = legacyRecoveryJson()
  if (!legacy) return ''
  return `<section class="legacy-recovery"><h3>Earlier inspector data preserved</h3><p>The v2 lab did not overwrite the previous browser store. Copy its recovery JSON before deliberately erasing it.</p><div class="button-row"><button class="secondary" data-copy-legacy>Copy legacy recovery JSON</button><button class="danger" data-clear-legacy>Erase legacy store</button></div></section>`
}

const render = (): void => {
  app.innerHTML = `<header class="hero"><div class="hero__mark" aria-hidden="true">CC</div><div><p class="eyebrow">LNURLCASH CONTRACTS LAB</p><h1>Real sats. Explicit authority.</h1><p class="lede">A live protocol lab for recipient-owned payments and portable bilateral commitments. The arbiter is still a custodian; the parties are no longer simulated.</p><p class="custody-note">“Real sats” means live bearer liabilities at a mint. Keep every experiment tiny and disposable.</p></div><span class="live-pill"><i></i> remote protocol v2</span></header>
  <main>${handoffHtml()}<section class="truth-grid"><article><span>01</span><h2>Neutral core</h2><p>Party A, Party B and arbiter. Human labels are signed display terms, never authority.</p></article><article><span>02</span><h2>Separate authority</h2><p>Each person enrols, accepts, funds and signs outcomes on their own device.</p></article><article><span>03</span><h2>Private payouts</h2><p>Beneficiaries precommit two unique output hashes. The arbiter never learns those spend secrets.</p></article></section>${directHtml()}${contractHtml()}<section class="attack-lab"><div><p class="eyebrow">ATTACK LAB</p><h2>What now fails closed</h2></div><ul><li><b>Relabel a role:</b> authority follows neutral signed roles, not display text.</li><li><b>Invent acceptance or outcomes:</b> imported events must come from exact enrolled keys.</li><li><b>Donate anonymously:</b> activation needs both mint outputs and named-payer acknowledgements.</li><li><b>Swap a payout:</b> every input uses a distinct hash countersigned before funding.</li><li><b>Replay another contract:</b> messages bind offer id and exact bond-set hash.</li><li><b>Use silence as guilt:</b> silence freezes; an attributable decision waits through the signed challenge period.</li><li><b>Malicious arbiter or JavaScript:</b> still able to steal held bonds before settlement. That remains the hard custody boundary.</li></ul></section>${recoveryHtml()}</main>
  <footer><span>Experimental · bilateral-arbiter-v2 · 500 sat hard cap</span><button class="text-button" data-reset>Erase this browser’s v2 secrets</button></footer><div data-status class="status" role="status" aria-live="polite">Ready. Use tiny disposable notes only.</div>`
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

const createPacket = (): void => {
  const contract = latestContract()
  if (!contract) throw new Error('No contract offer is selected.')
  if (contract.record.packet) throw new Error('This offer already has a canonical bond packet.')
  assertOfferOpen(contract.offer)
  const arbiter = localArbiter(contract.offer)
  if (!arbiter) throw new Error('This browser does not own the named arbiter key.')
  const acceptances = {} as ContractPacket['acceptances']
  for (const role of PARTY_ROLES) {
    const encoded = contract.record.acceptances[role]
    if (!encoded) throw new Error('Both participant acceptances are required first.')
    const message = decodeContractMessage(encoded, 0)
    if (message.type !== 'acceptance') throw new Error('A stored acceptance has the wrong type.')
    assertAcceptance(message, contract.offer)
    acceptances[role] = message
  }
  const staged = {} as Record<PartyRole, {signed: SignedRequest; receiverSecretHex: string}>
  for (const role of PARTY_ROLES) {
    const receiverSecretHex = randomSecretHex()
    const intent: CommitmentIntent = {
      v: 2,
      contractId: contract.offer.terms.contractId,
      revision: 1,
      purpose: 'commitment',
      receiverRole: 'arbiter',
      payerRole: role,
      offerId: contract.offer.event.id,
      participants: contract.offer.terms.participants,
      amount: contract.offer.terms.bonds[role],
      currency: 'sat',
      mint: contract.offer.terms.mint,
      outputHash: outputHashOf(receiverSecretHex),
      expires: contract.offer.terms.setupExpires,
      memo: `${contract.offer.terms.labels[role]} commitment bond`
    }
    staged[role] = {signed: signRequest(intent, arbiter.secretHex), receiverSecretHex}
  }
  for (const role of PARTY_ROLES) store.requests[staged[role].signed.event.id] = {encoded: staged[role].signed.encoded, intent: staged[role].signed.intent, receiverSecretHex: staged[role].receiverSecretHex}
  saveStore(store)
  const packetEncoded = encodeContractPacket({offer: contract.offer, acceptances, bondRequests: {party_a: staged.party_a.signed, party_b: staged.party_b.signed}})
  contract.record.packet = packetEncoded
  saveStore(store)
}

const settlementNoticeReceipt = (notice: SignedSettlementNotice, mintHost: string): SettlementReceipt => ({
  amountMsat: notice.amountMsat,
  mintHost,
  outputHash: notice.outputHash,
  ...(notice.mintSignature ? {signature: notice.mintSignature} : {}),
  outcome: notice.mutationOutcome,
  createdAt: notice.event.created_at * 1000
})

const issueSettlementNotices = (contract: NonNullable<ReturnType<typeof latestContract>>): void => {
  if (!contract.packet) return
  const arbiter = localArbiter(contract.offer)
  if (!arbiter) return
  for (const settlement of store.settlements) {
    const sourceRole = PARTY_ROLES.find(role => contract.packet!.bondRequests[role].event.id === settlement.bondRequestId)
    if (!sourceRole || !settlement.receipt) continue
    const already = contract.record.settlementNotices.some(encoded => {
      const message = decodeContractMessage(encoded, 0)
      return message.type === 'settlement_notice' && message.bondRequestId === settlement.bondRequestId
    })
    if (already) continue
    const notice = signSettlementNotice(contract.packet, {
      sourceRole,
      beneficiary: settlement.beneficiary,
      outputHash: settlement.outputHash,
      amountMsat: settlement.receipt.amountMsat,
      mutationOutcome: settlement.receipt.outcome,
      ...(settlement.receipt.signature ? {mintSignature: settlement.receipt.signature} : {})
    }, arbiter.secretHex)
    contract.record.settlementNotices.push(notice.encoded)
  }
  saveStore(store)
}

const bind = (): void => {
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach(button => button.addEventListener('click', () => void copy(button.dataset.copy ?? '')))
  document.querySelectorAll<HTMLElement>('[data-share]').forEach(button => button.addEventListener('click', () => void copyInternetLink(button.dataset.shareKind as 'request' | 'message' | 'packet', button.dataset.share ?? '')))

  document.querySelector<HTMLElement>('[data-import-incoming-message]')?.addEventListener('click', () => void run(null, async () => {
    if (!incomingMessage) throw new Error('No incoming message is available.')
    importContractMessage(incomingMessage)
    clearFragment()
    render()
    status('Signed contract message verified and imported.')
  }))
  document.querySelector<HTMLElement>('[data-import-incoming-packet]')?.addEventListener('click', () => void run(null, async () => {
    if (!incomingPacket) throw new Error('No incoming packet is available.')
    importPacket(incomingPacket)
    clearFragment()
    render()
    status('Every signed packet component verified and imported.')
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
    status(`${role.replace('_', ' ')} enrolment signed. Share it with the arbiter.`)
  })))

  document.querySelector<HTMLElement>('[data-create-arbiter]')?.addEventListener('click', () => {
    identity('arbiter', true)
    render()
    status('Arbiter key created in this browser only.')
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
    status('Canonical offer signed by the arbiter. Both parties must independently accept it.')
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
    status(`${contract.offer.terms.labels[role]} accepted. Two private payout secrets remain in this browser.`)
  })))

  document.querySelector<HTMLElement>('[data-create-packet]')?.addEventListener('click', () => void run(null, async () => {
    const contract = latestContract()
    if (!contract) throw new Error('No contract offer is selected.')
    await withExclusiveBrowserLock(`contract:${contract.offerId}`, async () => {
      store = loadStore()
      createPacket()
    }, {requireCrossContext: true})
    render()
    status('Both arbiter-held receiver secrets were persisted before the full signed packet was shown.')
  }))

  document.querySelectorAll<HTMLFormElement>('[data-fund-contract]').forEach(form => form.addEventListener('submit', event => void run(event, async submitted => {
    const role = submitted.dataset.fundContract
    if (!isPartyRole(role)) throw new Error('Unknown funding role.')
    const contract = latestContract()
    if (!contract?.packet) throw new Error('Import the full contract packet first.')
    const livePacket = decodeContractPacket(contract.packet.encoded, Math.floor(Date.now() / 1000))
    const local = store.identities[role]
    if (!local || local.pubkey !== livePacket.offer.terms.participants[role]) throw new Error('This browser does not own the named payer key.')
    const noteInput = String(formData(submitted).get('note'))
    const noteUrl = resolveNoteInput(noteInput)
    const spendSecret = noteUrl ? noteK1(noteUrl) : null
    if (!spendSecret) throw new Error('That is not an LNURLcash bearer note.')
    const request = livePacket.bondRequests[role]
    if (!confirm(`Commit ${request.intent.amount} sats as ${livePacket.offer.terms.labels[role]}?\n\nOffer: ${livePacket.offer.event.id.slice(0, 16)}…\nBond set: ${livePacket.bondSetHash.slice(0, 16)}…\nMint: ${request.intent.mint.host}`)) return
    let receipt: FundingReceipt | undefined
    await withExclusiveBrowserLock(`request:${request.event.id}`, async () => {
      await withExclusiveBrowserLock(`spend:${hashK1(spendSecret)}`, async () => {
        receipt = await fundReceiverLockedRequest(request, noteInput)
        store = loadStore()
        const current = normaliseContract(livePacket.offer.event.id, livePacket.offer.encoded)
        const localRequest = store.requests[request.event.id]
        if (localRequest) localRequest.receipt = receipt
        current.fundingAcks[role] = signFundingAcknowledgement(livePacket, role, local.secretHex).encoded
        saveStore(store)
      }, {requireCrossContext: true})
    }, {requireCrossContext: true})
    render()
    status(receipt!.outcome === 'confirmed' ? 'Funding submitted and a named-payer acknowledgement signed. The arbiter must still probe.' : 'Funding response was lost. Acknowledgement says submitted; the arbiter must probe before activation.', receipt!.outcome === 'confirmed' ? 'ok' : 'warn')
  })))

  document.querySelectorAll<HTMLElement>('[data-verify-bond]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const role = button.dataset.verifyBond
    if (!isPartyRole(role)) throw new Error('Unknown bond role.')
    const contract = latestContract()
    if (!contract?.packet || !localArbiter(contract.offer)) throw new Error('This browser is not the named arbiter.')
    const request = contract.packet.bondRequests[role]
    const record = store.requests[request.event.id]
    if (!record) throw new Error('The arbiter receiver secret is not stored here.')
    record.received = await receiveLockedPayment(request, record.receiverSecretHex, record.receipt)
    saveStore(store)
    render()
    status(`Arbiter independently verified ${request.intent.amount} sats for ${contract.offer.terms.labels[role]}.`)
  })))

  document.querySelectorAll<HTMLElement>('[data-sign-outcome]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const role = button.dataset.signRole
    if (!isPartyRole(role)) throw new Error('Unknown signer role.')
    const contract = latestContract()
    if (!contract?.packet) throw new Error('No contract packet is selected.')
    const local = store.identities[role]
    if (!local || local.pubkey !== contract.offer.terms.participants[role]) throw new Error('This browser does not own that participant key.')
    const outcome = String(button.dataset.signOutcome) as Parameters<typeof signOutcomeStatement>[1]
    const statement = signOutcomeStatement(contract.packet, outcome, local.secretHex)
    if (!contract.record.outcomes.some(encoded => decodeContractMessage(encoded, 0).event.id === statement.event.id)) contract.record.outcomes.push(statement.encoded)
    saveStore(store)
    render()
    status(`${contract.offer.terms.labels[role]} signed ${outcome.replaceAll('_', ' ')}. Share that message with the arbiter.`)
  })))

  document.querySelector<HTMLFormElement>('[data-create-decision]')?.addEventListener('submit', event => void run(event, async form => {
    const contract = latestContract()
    if (!contract?.packet) throw new Error('No contract packet is selected.')
    const arbiter = localArbiter(contract.offer)
    if (!arbiter) throw new Error('This browser is not the named arbiter.')
    const data = formData(form)
    const evidenceHash = bytesToHex(sha256(new TextEncoder().encode(String(data.get('evidence')))))
    const decision = signArbiterDecision(
      contract.packet,
      String(data.get('resolution')) as Parameters<typeof signArbiterDecision>[1],
      evidenceHash,
      String(data.get('reason')) as Parameters<typeof signArbiterDecision>[3],
      arbiter.secretHex
    )
    contract.record.decision = decision.encoded
    saveStore(store)
    render()
    status(`Decision signed. Value remains frozen for the ${contract.offer.terms.policy.challengeSeconds}-second challenge period.`, 'warn')
  }))

  document.querySelector<HTMLElement>('[data-settle-contract]')?.addEventListener('click', () => void run(null, async () => {
    const contract = latestContract()
    if (!contract?.packet || !localArbiter(contract.offer)) throw new Error('This browser is not the named arbiter.')
    await withExclusiveBrowserLock(`contract:${contract.offerId}`, async () => {
      store = loadStore()
      const current = latestContract()!
      try {
        await resolveHeldCommitments(store, current.packet!, {kind: 'messages', outcomes: current.record.outcomes, ...(current.record.decision ? {decision: current.record.decision} : {})}, {persist: saveStore, redirect: redirectHeldNoteToHash})
      } finally {
        issueSettlementNotices(latestContract()!)
      }
    }, {requireCrossContext: true})
    render()
    status('Held inputs were redirected only to the beneficiaries’ pre-signed per-input hashes. Share the settlement notices for private probing.', 'warn')
  }))

  document.querySelector<HTMLElement>('[data-abort-setup]')?.addEventListener('click', () => void run(null, async () => {
    const contract = latestContract()
    if (!contract?.packet || !localArbiter(contract.offer)) throw new Error('This browser is not the named arbiter.')
    await withExclusiveBrowserLock(`contract:${contract.offerId}`, async () => {
      store = loadStore()
      const current = latestContract()!
      try {
        await resolveHeldCommitments(store, current.packet!, {kind: 'setup_timeout'}, {persist: saveStore, redirect: redirectHeldNoteToHash})
      } finally {
        issueSettlementNotices(latestContract()!)
      }
    }, {requireCrossContext: true})
    render()
    status('The only funded setup bond was returned to its owner’s pre-signed target.')
  }))

  document.querySelector<HTMLElement>('[data-timeout-contract]')?.addEventListener('click', () => void run(null, async () => {
    const contract = latestContract()
    if (!contract?.packet || !localArbiter(contract.offer)) throw new Error('This browser is not the named arbiter.')
    await withExclusiveBrowserLock(`contract:${contract.offerId}`, async () => {
      store = loadStore()
      const current = latestContract()!
      try {
        await resolveHeldCommitments(store, current.packet!, {kind: 'contract_timeout', outcomes: current.record.outcomes, ...(current.record.decision ? {decision: current.record.decision} : {})}, {persist: saveStore, redirect: redirectHeldNoteToHash})
      } finally {
        issueSettlementNotices(latestContract()!)
      }
    }, {requireCrossContext: true})
    render()
    status('The unresolved contract timed out without assigning guilt. Both bonds were returned to their signed owners.')
  }))

  document.querySelectorAll<HTMLElement>('[data-probe-payout]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const contract = latestContract()
    if (!contract?.packet) throw new Error('No contract packet is selected.')
    const encoded = contract.record.settlementNotices.find(value => decodeContractMessage(value, 0).event.id === button.dataset.probePayout)
    if (!encoded) throw new Error('Settlement notice not found.')
    const message = decodeContractMessage(encoded, 0)
    if (message.type !== 'settlement_notice') throw new Error('The selected message is not a settlement notice.')
    assertSettlementNotice(message, contract.packet)
    const local = store.identities[message.beneficiary]
    if (!local || local.pubkey !== contract.offer.terms.participants[message.beneficiary]) throw new Error('This browser does not own the named beneficiary key.')
    const target = store.payoutTargets[contract.offerId]?.[message.beneficiary]
    if (!target) throw new Error('This browser has no private payout secrets for that acceptance.')
    const secret = target.secrets[message.sourceRole]
    if (outputHashOf(secret) !== message.outputHash) throw new Error('The stored payout secret does not match the signed settlement target.')
    target.received[message.sourceRole] = await receiveRedirectedPayout(contract.offer.terms.mint, message.amountMsat, secret, settlementNoticeReceipt(message, contract.offer.terms.mint.host))
    const beneficiaryIdentity = store.identities[message.beneficiary]
    if (!beneficiaryIdentity) throw new Error('The beneficiary signing key is not stored here.')
    const acknowledgement = signPayoutAcknowledgement(message, contract.packet, beneficiaryIdentity.secretHex)
    if (!contract.record.payoutAcks.some(encoded => decodeContractMessage(encoded, 0).event.id === acknowledgement.event.id)) contract.record.payoutAcks.push(acknowledgement.encoded)
    saveStore(store)
    render()
    status('Beneficiary independently found the redirected payout. Import and rotate it in a proper wallet.')
  })))

  document.querySelectorAll<HTMLElement>('[data-reconcile-payout]').forEach(button => button.addEventListener('click', () => void run(null, async () => {
    const contract = latestContract()
    if (!contract?.packet || !localArbiter(contract.offer)) throw new Error('This browser is not the named arbiter.')
    await withExclusiveBrowserLock(`contract:${contract.offerId}`, async () => {
      store = loadStore()
      const current = latestContract()
      if (!current?.packet || current.offerId !== contract.offerId) throw new Error('The selected contract changed before reconciliation.')
      const noticeEncoded = current.record.settlementNotices.find(value => decodeContractMessage(value, 0).event.id === button.dataset.reconcilePayout)
      if (!noticeEncoded) throw new Error('Settlement notice not found.')
      const notice = decodeContractMessage(noticeEncoded, 0)
      if (notice.type !== 'settlement_notice') throw new Error('The selected message is not a settlement notice.')
      const acknowledgementEncoded = current.record.payoutAcks.find(value => {
        const message = decodeContractMessage(value, 0)
        return message.type === 'payout_ack' && message.noticeId === notice.event.id
      })
      if (!acknowledgementEncoded) throw new Error('No beneficiary payout acknowledgement has been imported.')
      const acknowledgement = decodeContractMessage(acknowledgementEncoded, 0)
      if (acknowledgement.type !== 'payout_ack') throw new Error('The selected acknowledgement has the wrong type.')
      applyPayoutAcknowledgement(store, current.packet, notice, acknowledgement, saveStore)
    }, {requireCrossContext: true})
    render()
    status('The beneficiary acknowledgement reconciled the ambiguous leg. Settlement may now resume.')
  })))

  document.querySelector<HTMLFormElement>('[data-import-contract]')?.addEventListener('submit', event => void run(event, async form => {
    const encoded = String(formData(form).get('encoded')).trim()
    if (encoded.startsWith('cashpacket1')) importPacket(decodeContractPacket(encoded, 0))
    else importContractMessage(decodeContractMessage(encoded))
    render()
    status('Signed payload verified and imported.')
  }))

  document.querySelector<HTMLElement>('[data-copy-legacy]')?.addEventListener('click', () => void copy(legacyRecoveryJson() ?? ''))
  document.querySelector<HTMLElement>('[data-clear-legacy]')?.addEventListener('click', () => {
    if (!confirm('Permanently erase the earlier inspector store? Copy its recovery JSON first if it may contain live note secrets.')) return
    clearLegacyStore()
    render()
    status('Earlier inspector store erased.', 'warn')
  })
  document.querySelector<HTMLElement>('[data-reset]')?.addEventListener('click', () => {
    if (!confirm('Erase this browser’s v2 keys, receiver secrets, payout secrets and settlement records? Export any live notes first.')) return
    clearStore()
    store = loadStore()
    render()
    status('This browser’s v2 lab state was erased.', 'warn')
  })
}

readIncoming()
render()
if (incomingError) status(incomingError, 'bad')

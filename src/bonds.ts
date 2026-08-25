import {noteK1} from 'lnurlcash-kit'
import type {ReceivedNote, SettlementReceipt} from './cash'
import {
  assertArbiterDecision,
  assertFundingAcknowledgement,
  assertOutcomeStatement,
  assertPayoutAcknowledgement,
  decisionExecutableAt,
  decodeContractMessage,
  type ContractPacket,
  type SignedArbiterDecision,
  type SignedFundingAcknowledgement,
  type SignedOutcomeStatement,
  type SignedPayoutAcknowledgement,
  type SignedSettlementNotice
} from './coordination'
import {PARTY_ROLES, POLICY_CAPABILITIES, type PartyRole} from './contract-types'
import {decodeRequest, isCommitmentIntent, outputHashOf} from './protocol'
import type {DemoStore, SettlementResolution, StoredRequest, StoredSettlement} from './store'

export type CommitmentEntry = [requestId: string, record: StoredRequest]

export type CommitmentSet = {
  offerId: string
  contractId: string
  packet: ContractPacket
  entries: Record<PartyRole, CommitmentEntry>
  setupExpires: number
}

export type ActivationState = {
  held: Record<PartyRole, boolean>
  acknowledged: Record<PartyRole, boolean>
  active: boolean
}

export type EvidenceState =
  | {state: 'pending'; reason: string}
  | {state: 'disputed'; reason: string; challengeEnds?: number; decision?: SignedArbiterDecision}
  | {state: 'executable'; resolution: Exclude<SettlementResolution, 'setup_abort'>; authorityIds: string[]}

const receivedMatches = (record: StoredRequest): void => {
  const signed = decodeRequest(record.encoded, 0)
  if (!isCommitmentIntent(signed.intent)) throw new Error('A stored commitment is not a generic v2 request.')
  if (outputHashOf(record.receiverSecretHex) !== signed.intent.outputHash) throw new Error('A stored arbiter secret does not match its signed output hash.')
  if (!record.received) return
  if (noteK1(record.received.noteUrl) !== record.receiverSecretHex.toLowerCase()) throw new Error('A held note does not match its stored arbiter secret.')
  if (record.received.amountMsat !== Number(signed.intent.amount) * 1000) throw new Error('A held note does not match its signed amount.')
  if (new URL(record.received.noteUrl).host.toLowerCase() !== signed.intent.mint.host) throw new Error('A held note belongs to another mint.')
  if (new URL(record.received.callback).host.toLowerCase() !== signed.intent.mint.host) throw new Error('A held note callback belongs to another mint.')
  if (record.received.mintPubkey && record.received.mintPubkey !== signed.intent.mint.mintPubkey) throw new Error('A held note carries another mint signing key.')
}

export const commitmentSetForPacket = (store: DemoStore, packet: ContractPacket): CommitmentSet => {
  const entries = {} as Record<PartyRole, CommitmentEntry>
  for (const role of PARTY_ROLES) {
    const expected = packet.bondRequests[role]
    const record = store.requests[expected.event.id]
    if (!record) throw new Error(`The arbiter browser has no stored ${role.replace('_', ' ')} bond secret.`)
    const decoded = decodeRequest(record.encoded, 0)
    if (
      decoded.event.id !== expected.event.id ||
      decoded.encoded !== expected.encoded ||
      JSON.stringify(decoded.intent) !== JSON.stringify(expected.intent) ||
      JSON.stringify(record.intent) !== JSON.stringify(expected.intent)
    ) throw new Error('Stored commitment data disagrees with the signed contract packet.')
    receivedMatches(record)
    entries[role] = [expected.event.id, record]
  }
  return {
    offerId: packet.offer.event.id,
    contractId: packet.offer.terms.contractId,
    packet,
    entries,
    setupExpires: packet.offer.terms.setupExpires
  }
}

const fundingAckFor = (store: DemoStore, packet: ContractPacket, role: PartyRole): SignedFundingAcknowledgement | undefined => {
  const encoded = store.contracts[packet.offer.event.id]?.fundingAcks[role]
  if (!encoded) return undefined
  const decoded = decodeContractMessage(encoded, 0)
  if (decoded.type !== 'funding_ack') throw new Error('Stored funding authority is not a funding acknowledgement.')
  assertFundingAcknowledgement(decoded, packet)
  if (decoded.role !== role) throw new Error('A funding acknowledgement is stored under the wrong role.')
  return decoded
}

export const contractActivationState = (store: DemoStore, packet: ContractPacket): ActivationState => {
  const set = commitmentSetForPacket(store, packet)
  const held = {
    party_a: Boolean(set.entries.party_a[1].received || settlementFor(store, set.entries.party_a[0])),
    party_b: Boolean(set.entries.party_b[1].received || settlementFor(store, set.entries.party_b[0]))
  }
  const acknowledged = {
    party_a: Boolean(fundingAckFor(store, packet, 'party_a')),
    party_b: Boolean(fundingAckFor(store, packet, 'party_b'))
  }
  return {held, acknowledged, active: PARTY_ROLES.every(role => held[role] && acknowledged[role])}
}

const importedOutcomes = (encoded: string[], packet: ContractPacket): Array<{statement: SignedOutcomeStatement; role: PartyRole}> => {
  const seen = new Set<string>()
  return encoded.map(value => {
    const message = decodeContractMessage(value, 0)
    if (message.type !== 'outcome') throw new Error('Stored outcome authority contains another message type.')
    if (seen.has(message.event.id)) throw new Error('The same outcome statement was imported twice.')
    seen.add(message.event.id)
    return {statement: message, role: assertOutcomeStatement(message, packet)}
  })
}

export const evaluateResolutionEvidence = (
  packet: ContractPacket,
  outcomeInputs: string[],
  decisionInput: string | string[] = [],
  nowSeconds = Math.floor(Date.now() / 1000)
): EvidenceState => {
  const statements = importedOutcomes(outcomeInputs, packet)
  const selfCancels = statements.filter(({statement}) => ['party_a_cancel', 'party_b_cancel'].includes(statement.outcome))
  const explicitDisputes = statements.filter(({statement}) => statement.outcome === 'dispute')
  const contradictorySelfCancels = new Set(selfCancels.map(({statement}) => statement.outcome)).size > 1
  const disputeOpenedAt = explicitDisputes.length
    ? Math.min(...explicitDisputes.map(({statement}) => statement.event.created_at))
    : contradictorySelfCancels
      ? Math.max(...selfCancels.map(({statement}) => statement.event.created_at))
      : undefined
  const decisionInputs = typeof decisionInput === 'string' ? [decisionInput] : decisionInput
  const decisions = decisionInputs.map(value => {
    const message = decodeContractMessage(value, 0)
    if (message.type !== 'arbiter_decision') throw new Error('Stored decision authority contains another message type.')
    assertArbiterDecision(message, packet)
    return message
  })
  if (new Set(decisions.map(decision => decision.event.id)).size !== decisions.length) throw new Error('The same arbiter decision was imported twice.')

  const bilateralAgreement = (): Extract<EvidenceState, {state: 'executable'}> | undefined => {
    for (const outcome of ['complete', 'mutual_cancel'] as const) {
      const matching = statements.filter(({statement}) => statement.outcome === outcome)
      const roles = new Set(matching.map(({role}) => role))
      if (roles.size === 2) return {state: 'executable', resolution: outcome, authorityIds: matching.map(({statement}) => statement.event.id)}
    }
    return undefined
  }
  const bilateral = bilateralAgreement()

  // Contradictory admissions open a dispute rather than a terminal state, and the
  // dispute branch runs before any self-cancel or matching outcome. Executing an
  // outcome first would make every later branch unreachable, so no decision, no
  // bilateral agreement and no timeout could ever move the held bonds again.
  if (disputeOpenedAt !== undefined) {
    // An explicit dispute outranks ordinary participant outcomes. Contradictory
    // self-cancellations do not: both parties later signing the same outcome is
    // stronger authority than their earlier conflicting admissions, and refusing
    // it would freeze the bonds until an arbiter acts on a disagreement the
    // parties have themselves settled.
    if (!explicitDisputes.length && bilateral) return bilateral
    if (!decisions.length) return {state: 'disputed', reason: contradictorySelfCancels ? 'Contradictory self-cancellations require an arbiter decision.' : 'A participant raised a dispute.'}
    if (decisions.length > 1) return {state: 'disputed', reason: 'The arbiter signed conflicting decisions. Refuse settlement.'}
    const decision = decisions[0]!
    if (decision.event.created_at < disputeOpenedAt) throw new Error('The arbiter decision predates the dispute it claims to resolve.')
    const challengeEnds = decisionExecutableAt(decision, packet.offer)
    if (nowSeconds < challengeEnds) return {state: 'disputed', reason: 'The arbiter decision is still challenge-delayed.', challengeEnds, decision}
    return {state: 'executable', resolution: decision.resolution, authorityIds: [decision.event.id, ...explicitDisputes.map(({statement}) => statement.event.id), ...selfCancels.map(({statement}) => statement.event.id)]}
  }
  if (decisions.length) throw new Error('An arbiter decision cannot create a dispute that neither party raised.')

  if (selfCancels.length) {
    const selected = selfCancels[0]!.statement
    return {state: 'executable', resolution: selected.outcome as 'party_a_cancel' | 'party_b_cancel', authorityIds: [selected.event.id]}
  }

  if (bilateral) return bilateral

  const unilateral = statements.find(({statement}) => ['complete', 'mutual_cancel'].includes(statement.outcome))
  return {state: 'pending', reason: unilateral ? 'The other party has not signed the matching outcome.' : 'No executable outcome authority has been imported.'}
}

// A dispute freezes value until an attributable decision executes. Without a
// terminal deadline that freeze is permanent: no decision or outcome statement
// can be signed after the settlement window, so a merely late arbiter would
// strand both bonds forever. After this instant the contract refunds no-fault.
//
// This is a v2 rule. A v1 contract has no such row in the table its parties
// accepted, and a refund is not merely a safe default: a party who would have
// been awarded both bonds is worse off under one. Superseded packets therefore
// keep the v1 behaviour and stay frozen until a decision is imported.
export const disputeTerminalAt = (packet: ContractPacket): number =>
  packet.offer.terms.settlementExpires + packet.offer.terms.policy.challengeSeconds

export const hasTerminalRefund = (packet: ContractPacket): boolean =>
  POLICY_CAPABILITIES[packet.offer.terms.policy.id]?.terminalRefund === true

const allSettlementsFor = (store: DemoStore, requestId: string): StoredSettlement[] => store.settlements.filter(item => item.bondRequestId === requestId)

const settlementFor = (store: DemoStore, requestId: string): StoredSettlement | undefined => {
  const matches = allSettlementsFor(store, requestId)
  if (matches.length > 1) throw new Error('Duplicate settlement journals make this contract unsafe to resolve.')
  return matches[0]
}

export const beneficiaryFor = (owner: PartyRole, resolution: SettlementResolution): PartyRole => {
  if (['complete', 'mutual_cancel', 'refund_both', 'setup_abort', 'contract_timeout'].includes(resolution)) return owner
  if (resolution === 'party_a_cancel' || resolution === 'award_party_b') return 'party_b'
  if (resolution === 'party_b_cancel' || resolution === 'award_party_a') return 'party_a'
  throw new Error('Unknown settlement resolution.')
}

export type ResolveOptions = {
  nowSeconds?: number
  persist: (store: DemoStore) => void
  redirect: (held: ReceivedNote, receiverSecretHex: string, beneficiaryOutputHash: string) => Promise<SettlementReceipt>
}

export type ResolveAuthority =
  | {kind: 'messages'; outcomes: string[]; decisions?: string[]}
  | {kind: 'setup_timeout'}
  | {kind: 'contract_timeout'; outcomes: string[]; decisions?: string[]}

export const resolveHeldCommitments = async (
  store: DemoStore,
  packet: ContractPacket,
  authority: ResolveAuthority,
  options: ResolveOptions
): Promise<CommitmentSet> => {
  const set = commitmentSetForPacket(store, packet)
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  let resolution: SettlementResolution
  if (authority.kind === 'setup_timeout') {
    resolution = 'setup_abort'
  } else if (authority.kind === 'contract_timeout') {
    if (now < packet.offer.terms.settlementExpires) throw new Error('The contract settlement deadline has not passed yet.')
    const evidence = evaluateResolutionEvidence(packet, authority.outcomes, authority.decisions, now)
    // Executable authority is checked first so a decision that becomes executable
    // exactly at the terminal deadline still wins over the no-fault refund.
    if (evidence.state === 'executable') throw new Error('Executable signed authority exists; contract timeout cannot replace it.')
    if (evidence.state === 'disputed') {
      if (!hasTerminalRefund(packet)) {
        throw new Error(`This contract was accepted under ${packet.offer.terms.policy.id}, which has no terminal refund. It stays frozen until a signed decision is imported.`)
      }
      if (now < disputeTerminalAt(packet)) throw new Error('A dispute was raised before timeout and still requires attributable resolution.')
    }
    resolution = 'contract_timeout'
  } else {
    const evidence = evaluateResolutionEvidence(packet, authority.outcomes, authority.decisions, now)
    if (evidence.state !== 'executable') throw new Error(evidence.state === 'disputed' ? 'The contract is disputed and cannot move value yet.' : evidence.reason)
    resolution = evidence.resolution
  }
  const existing = store.resolutions[set.offerId]
  if (existing && existing !== resolution) throw new Error(`This contract is already resolving as ${existing}.`)
  const activation = contractActivationState(store, packet)
  if (resolution === 'setup_abort') {
    if (!existing && now < set.setupExpires) throw new Error('The setup deadline has not passed yet.')
    if (!existing && activation.active) throw new Error('The contract is already active; setup cannot be aborted.')
    if (!PARTY_ROLES.some(role => activation.held[role] || settlementFor(store, set.entries[role][0]))) throw new Error('There is no funded bond to refund.')
  } else if (!activation.active) {
    throw new Error('Both held bonds and both payer acknowledgements are required before resolution.')
  }

  store.resolutions[set.offerId] = resolution
  options.persist(store)
  for (const role of PARTY_ROLES) {
    const [requestId, record] = set.entries[role]
    const beneficiary = beneficiaryFor(role, resolution)
    const target = packet.acceptances[beneficiary].payoutHashes[role]
    let settlement = settlementFor(store, requestId)
    if (resolution === 'setup_abort' && !record.received && !settlement) continue
    if (settlement && (settlement.beneficiary !== beneficiary || settlement.outputHash !== target)) throw new Error('The settlement journal names the wrong signed beneficiary target.')
    if (settlement?.state === 'confirmed') continue
    if (settlement?.state === 'ambiguous') throw new Error('A settlement response was lost. The beneficiary must probe the signed target before any retry.')
    if (settlement?.state === 'staged') throw new Error('A staged settlement may already have mutated the mint. Stop and reconcile it without changing the target.')
    if (!record.received) throw new Error('A settlement lost its held input; stop and inspect browser storage.')
    settlement = {bondRequestId: requestId, beneficiary, outputHash: target, state: 'staged'}
    store.settlements.push(settlement)
    options.persist(store)
    const receipt = await options.redirect(record.received, record.receiverSecretHex, target)
    settlement.receipt = receipt
    settlement.state = receipt.outcome === 'confirmed' ? 'confirmed' : 'ambiguous'
    if (settlement.state === 'confirmed') delete record.received
    options.persist(store)
    if (settlement.state === 'ambiguous') throw new Error('The mint response was lost. The beneficiary must probe its signed payout target; do not choose another output.')
  }
  return set
}

export const applyPayoutAcknowledgement = (
  store: DemoStore,
  packet: ContractPacket,
  notice: SignedSettlementNotice,
  acknowledgement: SignedPayoutAcknowledgement,
  persist: (store: DemoStore) => void
): void => {
  assertPayoutAcknowledgement(acknowledgement, notice, packet)
  const settlement = settlementFor(store, notice.bondRequestId)
  if (!settlement) throw new Error('The arbiter has no settlement journal for this payout acknowledgement.')
  if (
    settlement.beneficiary !== notice.beneficiary ||
    settlement.outputHash !== notice.outputHash ||
    settlement.receipt?.amountMsat !== notice.amountMsat
  ) throw new Error('The payout acknowledgement disagrees with the arbiter settlement journal.')
  settlement.state = 'confirmed'
  const record = store.requests[notice.bondRequestId]
  if (record) delete record.received
  persist(store)
}

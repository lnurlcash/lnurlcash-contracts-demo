import type {ReceivedNote} from './cash'
import {noteK1} from 'lnurlcash-kit'
import {bondSetHashOf, decodeRequest, outputHashOf, randomSecretHex, type ContractParticipants, type RideOutcome} from './protocol'
import type {ContractOutcome, DemoStore, StoredPayout, StoredRequest} from './store'

export type BondEntry = [requestId: string, record: StoredRequest]

export type BondSet = {
  contractId: string
  entries: [BondEntry, BondEntry]
  bondSetHash: string
  refereePubkey: string
  participants: ContractParticipants
  setupExpires: number
}

const comparableMint = (record: StoredRequest): string => JSON.stringify(record.intent.mint)

export const bondSetForContract = (store: DemoStore, contractId: string): BondSet => {
  const entries = Object.entries(store.requests)
    .filter(([, record]) => record.intent.rideId === contractId && ['rider_bond', 'driver_bond'].includes(record.intent.purpose))
  if (entries.length !== 2) throw new Error('A contract must have exactly one rider bond and one driver bond.')
  const rider = entries.filter(([, record]) => record.intent.purpose === 'rider_bond')
  const driver = entries.filter(([, record]) => record.intent.purpose === 'driver_bond')
  if (rider.length !== 1 || driver.length !== 1) throw new Error('Duplicate or missing bond roles make this contract unsafe to resolve.')
  const ordered = [rider[0]!, driver[0]!] as [BondEntry, BondEntry]
  const decoded = ordered.map(([requestId, record]) => {
    const signed = decodeRequest(record.encoded, 0)
    if (signed.event.id !== requestId || JSON.stringify(signed.intent) !== JSON.stringify(record.intent)) {
      throw new Error('Stored bond data disagrees with its signed request.')
    }
    if (outputHashOf(record.receiverSecretHex) !== signed.intent.outputHash) throw new Error('A stored receiver secret does not match its signed output hash.')
    if (record.received) {
      if (noteK1(record.received.noteUrl) !== record.receiverSecretHex.toLowerCase()) throw new Error('A held note does not match its stored receiver secret.')
      if (record.received.amountMsat !== Number(signed.intent.amount) * 1000) throw new Error('A held note does not match its signed amount.')
      if (new URL(record.received.noteUrl).host.toLowerCase() !== signed.intent.mint.host) throw new Error('A held note belongs to another mint.')
      if (new URL(record.received.callback).host.toLowerCase() !== signed.intent.mint.host) throw new Error('A held note callback belongs to another mint.')
      if (record.received.mintPubkey && record.received.mintPubkey !== signed.intent.mint.mintPubkey) throw new Error('A held note carries another mint signing key.')
    }
    if (signed.intent.role !== 'referee') throw new Error('A commitment bond must be receiver-locked to the referee.')
    return signed
  })
  if (decoded[0]!.event.pubkey !== decoded[1]!.event.pubkey) throw new Error('The two bonds name different referees.')
  const participants = decoded[0]!.intent.participants
  if (!participants || JSON.stringify(participants) !== JSON.stringify(decoded[1]!.intent.participants)) throw new Error('The two bonds name different participant keys.')
  if (comparableMint(ordered[0][1]) !== comparableMint(ordered[1][1])) throw new Error('The two bonds name different mint trust roots.')
  if (ordered[0][1].intent.expires !== ordered[1][1].intent.expires) throw new Error('The two bonds have different setup deadlines.')
  return {
    contractId,
    entries: ordered,
    bondSetHash: bondSetHashOf(ordered.map(([id]) => id)),
    refereePubkey: decoded[0]!.event.pubkey,
    participants,
    setupExpires: ordered[0][1].intent.expires
  }
}

const allPayouts = (store: DemoStore): StoredPayout[] => [...store.payouts.rider, ...store.payouts.driver]

const payoutFor = (store: DemoStore, requestId: string): StoredPayout | undefined => {
  const matches = allPayouts(store).filter(payout => payout.bondRequestId === requestId)
  if (matches.length > 1) throw new Error('Duplicate payout journals make this contract unsafe to resolve.')
  const payout = matches[0]
  if (payout?.state === 'settled' && !payout.note) throw new Error('A settled payout is missing its bearer output.')
  if (payout?.note) {
    const request = store.requests[requestId]
    if (!request) throw new Error('A payout journal has lost its signed bond request.')
    if (noteK1(payout.note.noteUrl) !== payout.secretHex.toLowerCase()) throw new Error('A payout note does not match its staged secret.')
    if (payout.note.amountMsat !== Number(request.intent.amount) * 1000) throw new Error('A payout note has the wrong value.')
    if (new URL(payout.note.noteUrl).host.toLowerCase() !== request.intent.mint.host) throw new Error('A payout note belongs to another mint.')
  }
  return payout
}

export const contractFundingState = (store: DemoStore, contractId: string): {verified: number; complete: boolean; expires: number} => {
  const bondSet = bondSetForContract(store, contractId)
  const verified = bondSet.entries.filter(([requestId, record]) => record.received || payoutFor(store, requestId)).length
  return {verified, complete: verified === 2, expires: bondSet.setupExpires}
}

const beneficiaryFor = (owner: 'rider' | 'driver', outcome: ContractOutcome): 'rider' | 'driver' => {
  if (outcome === 'complete' || outcome === 'setup_abort') return owner
  return outcome === 'rider_cancel' ? 'driver' : 'rider'
}

export type ResolveOptions = {
  nowSeconds?: number
  persist: (store: DemoStore) => void
  redirect?: (held: ReceivedNote, receiverSecretHex: string, beneficiarySecretHex: string) => Promise<ReceivedNote>
  randomSecret?: () => string
}

export const resolveHeldBonds = async (
  store: DemoStore,
  contractId: string,
  outcome: RideOutcome | 'setup_abort',
  options: ResolveOptions
): Promise<BondSet> => {
  const bondSet = bondSetForContract(store, contractId)
  const existingResolution = store.resolutions[contractId]
  if (existingResolution && existingResolution !== outcome) {
    throw new Error(`This contract is already resolving as ${existingResolution}.`)
  }
  const payouts = bondSet.entries.map(([requestId]) => payoutFor(store, requestId))
  const verified = bondSet.entries.map(([requestId, record], index) => Boolean(record.received || payouts[index]))
  if (outcome === 'setup_abort') {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (!existingResolution && now < bondSet.setupExpires) throw new Error('The setup deadline has not passed yet.')
    if (!existingResolution && verified.every(Boolean)) throw new Error('Both bonds are already active; setup cannot be aborted.')
    if (!verified.some(Boolean)) throw new Error('There is no funded bond to refund.')
  } else if (!verified.every(Boolean)) {
    throw new Error('Both bonds must be verified before resolution.')
  }

  store.resolutions[contractId] = outcome
  options.persist(store)
  for (const [requestId, record] of bondSet.entries) {
    const owner = record.intent.purpose === 'rider_bond' ? 'rider' : 'driver'
    const beneficiary = beneficiaryFor(owner, outcome)
    let payout = payoutFor(store, requestId)
    if (outcome === 'setup_abort' && !record.received && !payout) continue
    if (payout && payout.beneficiary !== beneficiary) throw new Error('The payout journal names the wrong beneficiary.')
    if (payout?.state === 'settled') continue
    if (!record.received) throw new Error('A staged settlement lost its held input; stop and inspect storage.')
    if (!payout) {
      payout = {
        bondRequestId: requestId,
        beneficiary,
        secretHex: (options.randomSecret ?? randomSecretHex)(),
        state: 'staged'
      }
      store.payouts[beneficiary].push(payout)
      options.persist(store)
    }
    const redirect = options.redirect
    if (!redirect) throw new Error('No settlement redirect was provided.')
    payout.note = await redirect(record.received, record.receiverSecretHex, payout.secretHex)
    payout.state = 'settled'
    delete record.received
    options.persist(store)
  }
  return bondSet
}

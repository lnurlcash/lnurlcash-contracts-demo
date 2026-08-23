import type {FundingReceipt, ReceivedNote, SettlementReceipt} from './cash'
import type {PartyRole} from './contract-types'
import type {ReceiverLockedIntent} from './protocol'

const STORE_KEY = 'lnurlcash_contracts_demo_v2'
const LEGACY_STORE_KEY = 'lnurlcash_contracts_demo_v1'

export type IdentityRole = 'recipient' | PartyRole | 'arbiter'

export type StoredIdentity = {secretHex: string; pubkey: string}

export type StoredRequest = {
  encoded: string
  intent: ReceiverLockedIntent
  receiverSecretHex: string
  receipt?: FundingReceipt
  received?: ReceivedNote
}

export type StoredContract = {
  offer: string
  acceptances: Partial<Record<PartyRole, string>>
  packet?: string
  fundingAcks: Partial<Record<PartyRole, string>>
  outcomes: string[]
  decision?: string
  settlementNotices: string[]
  payoutAcks: string[]
}

export type StoredPayoutTarget = {
  secrets: Record<PartyRole, string>
  outputHashes: Record<PartyRole, string>
  acceptance?: string
  received: Partial<Record<PartyRole, ReceivedNote>>
}

export type SettlementResolution =
  | 'complete'
  | 'mutual_cancel'
  | 'party_a_cancel'
  | 'party_b_cancel'
  | 'refund_both'
  | 'award_party_a'
  | 'award_party_b'
  | 'setup_abort'
  | 'contract_timeout'

export type StoredSettlement = {
  bondRequestId: string
  beneficiary: PartyRole
  outputHash: string
  state: 'staged' | 'confirmed' | 'ambiguous'
  receipt?: SettlementReceipt
}

export type DemoStore = {
  identities: Partial<Record<IdentityRole, StoredIdentity>>
  enrolments: Partial<Record<PartyRole, string>>
  requests: Record<string, StoredRequest>
  contracts: Record<string, StoredContract>
  payoutTargets: Record<string, Partial<Record<PartyRole, StoredPayoutTarget>>>
  settlements: StoredSettlement[]
  resolutions: Record<string, SettlementResolution>
}

const empty = (): DemoStore => ({
  identities: {},
  enrolments: {},
  requests: {},
  contracts: {},
  payoutTargets: {},
  settlements: [],
  resolutions: {}
})

const isResolution = (value: unknown): value is SettlementResolution => [
  'complete', 'mutual_cancel', 'party_a_cancel', 'party_b_cancel', 'refund_both', 'award_party_a', 'award_party_b', 'setup_abort', 'contract_timeout'
].includes(String(value))

export const loadStore = (): DemoStore => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<DemoStore> | null
    if (!parsed || typeof parsed !== 'object') return empty()
    return {
      identities: parsed.identities ?? {},
      enrolments: parsed.enrolments ?? {},
      requests: parsed.requests ?? {},
      contracts: parsed.contracts ?? {},
      payoutTargets: parsed.payoutTargets ?? {},
      settlements: Array.isArray(parsed.settlements) ? parsed.settlements : [],
      resolutions: Object.fromEntries(Object.entries(parsed.resolutions ?? {}).filter((entry): entry is [string, SettlementResolution] => isResolution(entry[1])))
    }
  } catch {
    return empty()
  }
}

export const saveStore = (store: DemoStore): void => localStorage.setItem(STORE_KEY, JSON.stringify(store))

export const clearStore = (): void => localStorage.removeItem(STORE_KEY)

export const legacyRecoveryJson = (): string | null => localStorage.getItem(LEGACY_STORE_KEY)

export const clearLegacyStore = (): void => localStorage.removeItem(LEGACY_STORE_KEY)

const fallbackLocks = new Map<string, Promise<void>>()

export const withExclusiveBrowserLock = async <T>(
  name: string,
  work: () => Promise<T>,
  options: {requireCrossContext?: boolean} = {}
): Promise<T> => {
  const lockName = `lnurlcash-contracts:${name}`
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(lockName, {mode: 'exclusive'}, work)
  if (options.requireCrossContext) throw new Error('This browser cannot safely serialise money movement across tabs.')
  const previous = fallbackLocks.get(lockName) ?? Promise.resolve()
  let release = (): void => undefined
  const current = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => current)
  fallbackLocks.set(lockName, tail)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (fallbackLocks.get(lockName) === tail) fallbackLocks.delete(lockName)
  }
}

import type {FundingReceipt, ReceivedNote} from './cash'
import type {ReceiverLockedIntent, RideOutcome} from './protocol'

const STORE_KEY = 'lnurlcash_contracts_demo_v1'

export type StoredRequest = {
  encoded: string
  intent: ReceiverLockedIntent
  receiverSecretHex: string
  receipt?: FundingReceipt
  received?: ReceivedNote
}

export type StoredPayout = {
  bondRequestId: string
  beneficiary: 'rider' | 'driver'
  secretHex: string
  note?: ReceivedNote
  state: 'staged' | 'settled'
}

export type ContractOutcome = RideOutcome | 'setup_abort'

export type DemoStore = {
  identities: Record<'rider' | 'driver' | 'referee', {secretHex: string; pubkey: string}>
  requests: Record<string, StoredRequest>
  payouts: Record<'rider' | 'driver', StoredPayout[]>
  resolutions: Record<string, ContractOutcome>
}

const empty = (): DemoStore => ({
  identities: {} as DemoStore['identities'],
  requests: {},
  payouts: {rider: [], driver: []},
  resolutions: {}
})

const isOutcome = (value: unknown): value is ContractOutcome => ['complete', 'rider_cancel', 'driver_cancel', 'setup_abort'].includes(String(value))

export const loadStore = (): DemoStore => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as (Partial<DemoStore> & {resolution?: unknown}) | null
    if (!parsed || typeof parsed !== 'object') return empty()
    const requests = parsed.requests ?? {}
    const resolutions = Object.fromEntries(
      Object.entries(parsed.resolutions ?? {}).filter((entry): entry is [string, ContractOutcome] => isOutcome(entry[1]))
    )
    if (isOutcome(parsed.resolution) && Object.keys(resolutions).length === 0) {
      const legacyContracts = [...new Set(Object.values(requests)
        .filter(record => ['rider_bond', 'driver_bond'].includes(record.intent.purpose))
        .map(record => record.intent.rideId))]
      if (legacyContracts.length === 1) resolutions[legacyContracts[0]!] = parsed.resolution
    }
    return {
      identities: (parsed.identities ?? {}) as DemoStore['identities'],
      requests,
      payouts: parsed.payouts ?? {rider: [], driver: []},
      resolutions
    }
  } catch {
    return empty()
  }
}

export const saveStore = (store: DemoStore): void => localStorage.setItem(STORE_KEY, JSON.stringify(store))

export const clearStore = (): void => localStorage.removeItem(STORE_KEY)

const fallbackLocks = new Map<string, Promise<void>>()

export const withExclusiveBrowserLock = async <T>(
  name: string,
  work: () => Promise<T>,
  options: {requireCrossContext?: boolean} = {}
): Promise<T> => {
  const lockName = `lnurlcash-contracts:${name}`
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(lockName, {mode: 'exclusive'}, work)
  }
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

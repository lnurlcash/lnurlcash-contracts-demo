import type {FundingReceipt, ReceivedNote} from './cash'
import type {ReceiverLockedIntent} from './protocol'

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

export type DemoStore = {
  identities: Record<'rider' | 'driver' | 'referee', {secretHex: string; pubkey: string}>
  requests: Record<string, StoredRequest>
  payouts: Record<'rider' | 'driver', StoredPayout[]>
  resolution?: 'complete' | 'rider_cancel' | 'driver_cancel'
}

const empty = (): DemoStore => ({
  identities: {} as DemoStore['identities'],
  requests: {},
  payouts: {rider: [], driver: []}
})

export const loadStore = (): DemoStore => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<DemoStore> | null
    if (!parsed || typeof parsed !== 'object') return empty()
    const resolution = ['complete', 'rider_cancel', 'driver_cancel'].includes(String(parsed.resolution))
      ? parsed.resolution as DemoStore['resolution']
      : undefined
    return {
      identities: (parsed.identities ?? {}) as DemoStore['identities'],
      requests: parsed.requests ?? {},
      payouts: parsed.payouts ?? {rider: [], driver: []},
      ...(resolution ? {resolution} : {})
    }
  } catch {
    return empty()
  }
}

export const saveStore = (store: DemoStore): void => localStorage.setItem(STORE_KEY, JSON.stringify(store))

export const clearStore = (): void => localStorage.removeItem(STORE_KEY)

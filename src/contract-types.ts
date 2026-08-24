export const PARTY_ROLES = ['party_a', 'party_b'] as const
export type PartyRole = typeof PARTY_ROLES[number]
export type ContractRole = PartyRole | 'arbiter'

export const CONTRACT_TEMPLATES = ['ride', 'delivery', 'booking', 'work', 'custom'] as const
export type ContractTemplate = typeof CONTRACT_TEMPLATES[number]

export type ContractParticipants = Record<ContractRole, string>

export type ContractLabels = Record<ContractRole, string>

export type ContractBonds = Record<PartyRole, string>

export type MintTrust = {
  host: string
  withdrawLink: string
  mintPubkey?: string
}

// v1 offers remain decodable so an in-flight contract can still be resolved.
// Only v2 may be created: see CURRENT_POLICY_ID and signContractOffer.
export type BilateralPolicy =
  | {id: 'bilateral-arbiter-v1'; version: 1; challengeSeconds: number}
  | {id: 'bilateral-arbiter-v2'; version: 2; challengeSeconds: number}

export const CURRENT_POLICY_ID = 'bilateral-arbiter-v2' as const

export const POLICY_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  'bilateral-arbiter-v1': 1,
  'bilateral-arbiter-v2': 2
})

export type ContractTerms = {
  v: 1
  contractId: string
  template: ContractTemplate
  title: string
  memo: string
  labels: ContractLabels
  participants: ContractParticipants
  bonds: ContractBonds
  mint: MintTrust
  setupExpires: number
  serviceStarts: number
  settlementExpires: number
  policy: BilateralPolicy
}

export const isPartyRole = (value: unknown): value is PartyRole => PARTY_ROLES.includes(value as PartyRole)

export const otherParty = (role: PartyRole): PartyRole => role === 'party_a' ? 'party_b' : 'party_a'

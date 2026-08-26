export const PUBLIC_BOND_MODE = Object.freeze({
  id: 'evidence-only-v1',
  fundingEnabled: false,
  settlementEnabled: false,
  operatorCanMoveFunds: false,
  publisherRole: 'protocol-and-demo-source',
  serviceOperated: false,
  implementationReview: 'deployment-specific'
} as const)

export const PUBLIC_COORDINATION_MESSAGE_TYPES = Object.freeze([
  'enrolment',
  'contract_offer',
  'acceptance'
] as const)

export type PublicCoordinationMessageType = typeof PUBLIC_COORDINATION_MESSAGE_TYPES[number]

export const assertPublicCoordinationMessageType: (type: string) => asserts type is PublicCoordinationMessageType = type => {
  if (!(PUBLIC_COORDINATION_MESSAGE_TYPES as readonly string[]).includes(type)) {
    throw new Error('The public lab is evidence-only. Bond packets, funding, decisions and settlement messages are disabled.')
  }
}

export const assertPublicPacketImportDisabled = (): never => {
  throw new Error('Historical custodial bond packets are not accepted by the public lab. No new real bond funding is available.')
}

export type ProtectedCancellationReason = 'none' | 'safety' | 'emergency' | 'force_majeure' | 'mutual'

export type CancellationBand = 'protected' | 'early' | 'late' | 'very_late'

export type CancellationRecommendation = {
  band: CancellationBand
  capPercent: 0 | 25 | 50
  maximumSats: number
  agreedPriceSats: number
  evidencedDirectLossSats: number
  noticeMinutes: number
  protectedReason: ProtectedCancellationReason
  moneyMoved: false
  explanation: string
}

const wholeNonNegative = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative whole number of sats.`)
  return value
}

export const cancellationRecommendation = (input: {
  agreedPriceSats: number
  evidencedDirectLossSats: number
  noticeMinutes: number
  protectedReason?: ProtectedCancellationReason
}): CancellationRecommendation => {
  const agreedPriceSats = wholeNonNegative(input.agreedPriceSats, 'Agreed price')
  const evidencedDirectLossSats = wholeNonNegative(input.evidencedDirectLossSats, 'Evidenced direct loss')
  const noticeMinutes = wholeNonNegative(input.noticeMinutes, 'Notice')
  const protectedReason = input.protectedReason ?? 'none'

  if (protectedReason !== 'none') {
    return {
      band: 'protected', capPercent: 0, maximumSats: 0, agreedPriceSats, evidencedDirectLossSats,
      noticeMinutes, protectedReason, moneyMoved: false,
      explanation: 'Protected or mutually agreed cancellation: no compensation recommended.'
    }
  }

  if (noticeMinutes >= 30) {
    return {
      band: 'early', capPercent: 0, maximumSats: 0, agreedPriceSats, evidencedDirectLossSats,
      noticeMinutes, protectedReason, moneyMoved: false,
      explanation: 'At least 30 minutes notice: no compensation recommended.'
    }
  }

  const capPercent = noticeMinutes >= 5 ? 25 : 50
  const maximumSats = Math.min(evidencedDirectLossSats, Math.floor(agreedPriceSats * capPercent / 100))
  return {
    band: noticeMinutes >= 5 ? 'late' : 'very_late',
    capPercent,
    maximumSats,
    agreedPriceSats,
    evidencedDirectLossSats,
    noticeMinutes,
    protectedReason,
    moneyMoved: false,
    explanation: `${noticeMinutes >= 5 ? '5 to 29' : 'Under 5'} minutes notice: at most the lower of evidenced direct loss and ${capPercent}% of the agreed price.`
  }
}

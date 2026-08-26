import {describe, expect, it} from 'vitest'
import {
  PUBLIC_BOND_MODE,
  assertPublicCoordinationMessageType,
  assertPublicPacketImportDisabled,
  cancellationRecommendation
} from './product-policy'

describe('public product boundary', () => {
  it('cannot fund, settle or let the operator move a bond', () => {
    expect(PUBLIC_BOND_MODE).toMatchObject({
      fundingEnabled: false,
      settlementEnabled: false,
      operatorCanMoveFunds: false,
      commercialPilot: 'blocked-pending-uk-perimeter-opinion'
    })
  })

  it.each(['enrolment', 'contract_offer', 'acceptance'])('accepts evidence-only message type %s', type => {
    expect(() => assertPublicCoordinationMessageType(type)).not.toThrow()
  })

  it.each(['funding_ack', 'outcome', 'arbiter_decision', 'settlement_notice', 'payout_ack'])('refuses value-lifecycle message type %s', type => {
    expect(() => assertPublicCoordinationMessageType(type)).toThrow('evidence-only')
  })

  it('refuses every historical custodial packet', () => {
    expect(() => assertPublicPacketImportDisabled()).toThrow('No new real bond funding')
  })
})

describe('cancellation recommendation', () => {
  it.each(['safety', 'emergency', 'force_majeure', 'mutual'] as const)('recommends zero for protected reason %s', protectedReason => {
    expect(cancellationRecommendation({agreedPriceSats: 1000, evidencedDirectLossSats: 900, noticeMinutes: 0, protectedReason})).toMatchObject({
      band: 'protected', capPercent: 0, maximumSats: 0, moneyMoved: false
    })
  })

  it('recommends zero with at least 30 minutes notice', () => {
    expect(cancellationRecommendation({agreedPriceSats: 1000, evidencedDirectLossSats: 900, noticeMinutes: 30})).toMatchObject({
      band: 'early', maximumSats: 0
    })
  })

  it('caps a late cancellation at the lower of loss and 25 percent', () => {
    expect(cancellationRecommendation({agreedPriceSats: 1000, evidencedDirectLossSats: 400, noticeMinutes: 12})).toMatchObject({
      band: 'late', capPercent: 25, maximumSats: 250
    })
    expect(cancellationRecommendation({agreedPriceSats: 1000, evidencedDirectLossSats: 90, noticeMinutes: 12}).maximumSats).toBe(90)
  })

  it('caps a very late cancellation at the lower of loss and 50 percent', () => {
    expect(cancellationRecommendation({agreedPriceSats: 999, evidencedDirectLossSats: 900, noticeMinutes: 0})).toMatchObject({
      band: 'very_late', capPercent: 50, maximumSats: 499
    })
  })

  it('rejects fractional, negative and unsafe inputs', () => {
    expect(() => cancellationRecommendation({agreedPriceSats: 1.5, evidencedDirectLossSats: 0, noticeMinutes: 0})).toThrow('whole number')
    expect(() => cancellationRecommendation({agreedPriceSats: 1, evidencedDirectLossSats: -1, noticeMinutes: 0})).toThrow('non-negative')
    expect(() => cancellationRecommendation({agreedPriceSats: 1, evidencedDirectLossSats: 0, noticeMinutes: Number.MAX_SAFE_INTEGER + 1})).toThrow('whole number')
  })
})

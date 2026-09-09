import {describe, expect, it} from 'vitest'
import {assertTrustedMint} from './trust'

const trusted = () => ({
  host: 'moneyer.dev',
  withdrawLink: 'https://moneyer.dev/w',
  mintPubkey: '0218865ec3352afb85695bd1b6089323f802ecbf3ae2103bf8fd4d3e6fb571f0e4'
})

describe('public mint policy', () => {
  it('accepts the exact allowlisted endpoint and signing key', () => {
    expect(() => assertTrustedMint(trusted())).not.toThrow()
  })

  it('refuses a receiver-selected mint even when its request is correctly signed', () => {
    expect(() => assertTrustedMint({...trusted(), host: 'attacker.example', withdrawLink: 'https://attacker.example/w'})).toThrow('does not trust')
  })

  it('refuses endpoint and key substitution on an allowlisted host', () => {
    expect(() => assertTrustedMint({...trusted(), withdrawLink: 'https://moneyer.dev/other'})).toThrow('withdraw endpoint')
    expect(() => assertTrustedMint({...trusted(), mintPubkey: `02${'11'.repeat(32)}`})).toThrow('signing key')
  })
})

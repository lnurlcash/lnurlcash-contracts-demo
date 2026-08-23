import {describe, expect, it} from 'vitest'
import {assertTrustedMint} from './trust'

const trusted = () => ({
  host: 'mint.forgesworn.dev',
  withdrawLink: 'https://mint.forgesworn.dev/w',
  mintPubkey: '03bcd4846649e7b7d27e044ed7305547a5cf0209bd9629aa1de67f47d0c41b4407'
})

describe('public mint policy', () => {
  it('accepts the exact allowlisted endpoint and signing key', () => {
    expect(() => assertTrustedMint(trusted())).not.toThrow()
  })

  it('refuses a receiver-selected mint even when its request is correctly signed', () => {
    expect(() => assertTrustedMint({...trusted(), host: 'attacker.example', withdrawLink: 'https://attacker.example/w'})).toThrow('does not trust')
  })

  it('refuses endpoint and key substitution on an allowlisted host', () => {
    expect(() => assertTrustedMint({...trusted(), withdrawLink: 'https://mint.forgesworn.dev/other'})).toThrow('withdraw endpoint')
    expect(() => assertTrustedMint({...trusted(), mintPubkey: `02${'11'.repeat(32)}`})).toThrow('signing key')
  })
})

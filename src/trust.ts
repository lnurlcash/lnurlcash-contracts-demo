import type {ReceiverLockedIntent} from './protocol'

export type MintPin = {
  withdrawLink: string
  mintPubkeys: readonly string[]
}

export const TRUSTED_MINTS: Readonly<Record<string, MintPin>> = Object.freeze({
  'mint.forgesworn.dev': Object.freeze({
    withdrawLink: 'https://mint.forgesworn.dev/w',
    mintPubkeys: Object.freeze([
      '03bcd4846649e7b7d27e044ed7305547a5cf0209bd9629aa1de67f47d0c41b4407'
    ])
  })
})

export const assertTrustedMint = (mint: ReceiverLockedIntent['mint']): void => {
  const pin = TRUSTED_MINTS[mint.host.toLowerCase()]
  if (!pin) throw new Error(`This public lab does not trust ${mint.host}. Fork the lab to test another mint.`)
  if (new URL(mint.withdrawLink).toString() !== new URL(pin.withdrawLink).toString()) {
    throw new Error('The request does not use the allowlisted withdraw endpoint.')
  }
  if (!mint.mintPubkey || !pin.mintPubkeys.includes(mint.mintPubkey)) {
    throw new Error('The request does not carry an allowlisted mint signing key.')
  }
}

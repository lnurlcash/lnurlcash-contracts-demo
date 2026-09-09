import type {ReceiverLockedIntent} from './protocol'

export type MintPin = {
  withdrawLink: string
  mintPubkeys: readonly string[]
}

export const TRUSTED_MINTS: Readonly<Record<string, MintPin>> = Object.freeze({
  'moneyer.dev': Object.freeze({
    withdrawLink: 'https://moneyer.dev/w',
    mintPubkeys: Object.freeze([
      '0218865ec3352afb85695bd1b6089323f802ecbf3ae2103bf8fd4d3e6fb571f0e4'
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

import {
  buildNoteUrl,
  AmbiguousMintError,
  fetchNoteInfo,
  hashK1,
  noteK1,
  resolveNoteInput,
  rotateNoteWithHash,
  verifyNoteSignature,
  withNewK1
} from '@lnurlcash/kit'
import {contractIdOf, type MintTrust, type ReceiverLockedIntent, type SignedRequest} from './protocol'

export type FundingReceipt = {
  requestEventId: string
  contractId: string
  rideId?: string
  amountMsat: number
  mintHost: string
  outputHash: string
  signature?: string
  outcome: 'confirmed' | 'receiver_must_probe'
  createdAt: number
}

export type SettlementReceipt = {
  amountMsat: number
  mintHost: string
  outputHash: string
  signature?: string
  outcome: 'confirmed' | 'beneficiary_must_probe'
  createdAt: number
}

export type ReceivedNote = {
  noteUrl: string
  amountMsat: number
  callback: string
  signatureVerified: boolean | null
  mintPubkey?: string
}

const amountMsatOf = (intent: ReceiverLockedIntent): number => Number(intent.amount) * 1000

const assertCallbackAtMint = (callback: string, mintHost: string): void => {
  if (new URL(callback).host.toLowerCase() !== mintHost.toLowerCase()) {
    throw new Error('The mint tried to move the bearer spend to another host.')
  }
}

const noteUrlWithSignature = (withdrawLink: string, secretHex: string, amountMsat: number, signature?: string): string => {
  const basic = buildNoteUrl(withdrawLink, secretHex, amountMsat)
  return signature ? withNewK1(basic, secretHex, amountMsat, signature) : basic
}

export const fundReceiverLockedRequest = async (
  request: SignedRequest,
  noteInput: string
): Promise<FundingReceipt> => {
  const noteUrl = resolveNoteInput(noteInput)
  if (!noteUrl) throw new Error('That is not an LNURLcash bearer note.')
  const note = new URL(noteUrl)
  if (note.host.toLowerCase() !== request.intent.mint.host.toLowerCase()) {
    throw new Error(`This request takes ${request.intent.mint.host} notes, not ${note.host}.`)
  }
  const inputWithdrawLink = new URL(noteUrl)
  inputWithdrawLink.search = ''
  inputWithdrawLink.hash = ''
  if (inputWithdrawLink.toString() !== new URL(request.intent.mint.withdrawLink).toString()) {
    throw new Error('The request names a different withdraw endpoint from the note being spent.')
  }
  const k1 = noteK1(noteUrl)
  if (!k1) throw new Error('The note has no spend secret.')
  const info = await fetchNoteInfo(noteUrl)
  assertCallbackAtMint(info.callback, request.intent.mint.host)
  if (request.intent.mint.mintPubkey && info.mintPubkey !== request.intent.mint.mintPubkey) {
    throw new Error('The request and live note disagree about the mint signing key.')
  }
  const required = amountMsatOf(request.intent)
  if (info.maxWithdrawable !== required) {
    throw new Error(`Use an exact ${request.intent.amount} sat note. The pasted note is worth ${info.maxWithdrawable / 1000} sat.`)
  }
  try {
    const result = await rotateNoteWithHash(info.callback, k1, request.intent.outputHash)
    return {
      requestEventId: request.event.id,
      contractId: contractIdOf(request.intent),
      amountMsat: required,
      mintHost: request.intent.mint.host,
      outputHash: request.intent.outputHash,
      ...(result.signature ? {signature: result.signature} : {}),
      outcome: 'confirmed',
      createdAt: Date.now()
    }
  } catch (error) {
    if (!(error instanceof AmbiguousMintError)) throw error
    // The mutating GET may have landed even when its response did not. The
    // payer cannot probe the output because deliberately only the receiver
    // knows its secret. Never call this a failure and never retry with a
    // different output hash: the receiver checks the mint independently.
    return {
      requestEventId: request.event.id,
      contractId: contractIdOf(request.intent),
      amountMsat: required,
      mintHost: request.intent.mint.host,
      outputHash: request.intent.outputHash,
      outcome: 'receiver_must_probe',
      createdAt: Date.now()
    }
  }
}

export const receiveLockedPayment = async (
  request: SignedRequest,
  receiverSecretHex: string,
  receipt?: FundingReceipt
): Promise<ReceivedNote> => {
  if (hashK1(receiverSecretHex) !== request.intent.outputHash) throw new Error('The stored receiver secret does not belong to this request.')
  const expected = amountMsatOf(request.intent)
  if (receipt && (
    receipt.requestEventId !== request.event.id ||
    receipt.outputHash !== request.intent.outputHash ||
    (receipt.contractId ?? receipt.rideId) !== contractIdOf(request.intent) ||
    receipt.amountMsat !== expected ||
    receipt.mintHost !== request.intent.mint.host
  )) {
    throw new Error('The funding receipt belongs to another request.')
  }
  const candidate = noteUrlWithSignature(request.intent.mint.withdrawLink, receiverSecretHex, expected, receipt?.signature)
  const info = await fetchNoteInfo(candidate)
  assertCallbackAtMint(info.callback, request.intent.mint.host)
  if (info.maxWithdrawable !== expected) throw new Error(`The mint reports ${info.maxWithdrawable} msat, not the requested ${expected} msat.`)
  if (request.intent.mint.mintPubkey && info.mintPubkey !== request.intent.mint.mintPubkey) {
    throw new Error('The request and received note disagree about the mint signing key.')
  }
  let signatureVerified: boolean | null = null
  if (receipt?.signature && request.intent.mint.mintPubkey) {
    signatureVerified = verifyNoteSignature(receiverSecretHex, expected, receipt.signature, request.intent.mint.mintPubkey)
    if (!signatureVerified) throw new Error('The mint signature on this output does not verify.')
  }
  return {
    noteUrl: candidate,
    amountMsat: expected,
    callback: info.callback,
    signatureVerified,
    ...(request.intent.mint.mintPubkey ? {mintPubkey: request.intent.mint.mintPubkey} : {})
  }
}

export const redirectHeldNoteToHash = async (
  held: ReceivedNote,
  receiverSecretHex: string,
  beneficiaryOutputHash: string
): Promise<SettlementReceipt> => {
  const heldHost = new URL(held.noteUrl).host
  assertCallbackAtMint(held.callback, heldHost)
  if (!/^[0-9a-f]{64}$/u.test(beneficiaryOutputHash)) throw new Error('The beneficiary output hash is malformed.')
  try {
    const result = await rotateNoteWithHash(held.callback, receiverSecretHex, beneficiaryOutputHash)
    return {
      amountMsat: held.amountMsat,
      mintHost: heldHost,
      outputHash: beneficiaryOutputHash,
      ...(result.signature ? {signature: result.signature} : {}),
      outcome: 'confirmed',
      createdAt: Date.now()
    }
  } catch (error) {
    if (!(error instanceof AmbiguousMintError)) throw error
    return {
      amountMsat: held.amountMsat,
      mintHost: heldHost,
      outputHash: beneficiaryOutputHash,
      outcome: 'beneficiary_must_probe',
      createdAt: Date.now()
    }
  }
}

export const receiveRedirectedPayout = async (
  mint: MintTrust,
  amountMsat: number,
  beneficiarySecretHex: string,
  receipt?: SettlementReceipt
): Promise<ReceivedNote> => {
  const outputHash = hashK1(beneficiarySecretHex)
  if (receipt && (
    receipt.outputHash !== outputHash ||
    receipt.amountMsat !== amountMsat ||
    receipt.mintHost !== mint.host
  )) throw new Error('The settlement receipt belongs to another payout target.')
  const nextUrl = noteUrlWithSignature(mint.withdrawLink, beneficiarySecretHex, amountMsat, receipt?.signature)
  const info = await fetchNoteInfo(nextUrl)
  assertCallbackAtMint(info.callback, mint.host)
  if (info.maxWithdrawable !== amountMsat) throw new Error('The settlement output has the wrong value.')
  if (mint.mintPubkey && info.mintPubkey !== mint.mintPubkey) throw new Error('The settlement output changed mint signing key.')
  const signatureVerified = receipt?.signature && mint.mintPubkey
    ? verifyNoteSignature(beneficiarySecretHex, amountMsat, receipt.signature, mint.mintPubkey)
    : null
  if (signatureVerified === false) throw new Error('The mint signature on the settlement output does not verify.')
  return {
    noteUrl: nextUrl,
    amountMsat,
    callback: info.callback,
    signatureVerified,
    ...(mint.mintPubkey ? {mintPubkey: mint.mintPubkey} : {})
  }
}

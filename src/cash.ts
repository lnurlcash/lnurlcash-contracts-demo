import {
  buildNoteUrl,
  fetchNoteInfo,
  hashK1,
  noteK1,
  resolveNoteInput,
  rotateNoteWithHash,
  verifyNoteSignature,
  withNewK1,
  type LnurlcashOptions
} from 'lnurlcash-kit'
import type {ReceiverLockedIntent, SignedRequest} from './protocol'

export type FundingReceipt = {
  requestEventId: string
  rideId: string
  amountMsat: number
  mintHost: string
  outputHash: string
  signature?: string
  outcome: 'confirmed' | 'receiver_must_probe'
  createdAt: number
}

export type ReceivedNote = {
  noteUrl: string
  amountMsat: number
  callback: string
  signatureVerified: boolean | null
}

const amountMsatOf = (intent: ReceiverLockedIntent): number => Number(intent.amount) * 1000

const noteUrlWithSignature = (withdrawLink: string, secretHex: string, amountMsat: number, signature?: string): string => {
  const basic = buildNoteUrl(withdrawLink, secretHex, amountMsat)
  return signature ? withNewK1(basic, secretHex, amountMsat, signature) : basic
}

export const fundReceiverLockedRequest = async (
  request: SignedRequest,
  noteInput: string,
  options: LnurlcashOptions = {}
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
  const info = await fetchNoteInfo(noteUrl, options)
  if (request.intent.mint.mintPubkey && info.mintPubkey !== request.intent.mint.mintPubkey) {
    throw new Error('The request and live note disagree about the mint signing key.')
  }
  const required = amountMsatOf(request.intent)
  if (info.maxWithdrawable !== required) {
    throw new Error(`Use an exact ${request.intent.amount} sat note. The pasted note is worth ${info.maxWithdrawable / 1000} sat.`)
  }
  try {
    const result = await rotateNoteWithHash(info.callback, k1, request.intent.outputHash, options)
    return {
      requestEventId: request.event.id,
      rideId: request.intent.rideId,
      amountMsat: required,
      mintHost: request.intent.mint.host,
      outputHash: request.intent.outputHash,
      ...(result.signature ? {signature: result.signature} : {}),
      outcome: 'confirmed',
      createdAt: Date.now()
    }
  } catch {
    // The mutating GET may have landed even when its response did not. The
    // payer cannot probe the output because deliberately only the receiver
    // knows its secret. Never call this a failure and never retry with a
    // different output hash: the receiver checks the mint independently.
    return {
      requestEventId: request.event.id,
      rideId: request.intent.rideId,
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
  receipt?: FundingReceipt,
  options: LnurlcashOptions = {}
): Promise<ReceivedNote> => {
  if (hashK1(receiverSecretHex) !== request.intent.outputHash) throw new Error('The stored receiver secret does not belong to this request.')
  const expected = amountMsatOf(request.intent)
  if (receipt && (
    receipt.requestEventId !== request.event.id ||
    receipt.outputHash !== request.intent.outputHash ||
    receipt.rideId !== request.intent.rideId ||
    receipt.amountMsat !== expected ||
    receipt.mintHost !== request.intent.mint.host
  )) {
    throw new Error('The funding receipt belongs to another request.')
  }
  const candidate = noteUrlWithSignature(request.intent.mint.withdrawLink, receiverSecretHex, expected, receipt?.signature)
  const info = await fetchNoteInfo(candidate, options)
  if (info.maxWithdrawable !== expected) throw new Error(`The mint reports ${info.maxWithdrawable} msat, not the requested ${expected} msat.`)
  if (request.intent.mint.mintPubkey && info.mintPubkey !== request.intent.mint.mintPubkey) {
    throw new Error('The request and received note disagree about the mint signing key.')
  }
  let signatureVerified: boolean | null = null
  if (receipt?.signature && request.intent.mint.mintPubkey) {
    signatureVerified = verifyNoteSignature(receiverSecretHex, expected, receipt.signature, request.intent.mint.mintPubkey)
    if (!signatureVerified) throw new Error('The mint signature on this output does not verify.')
  }
  return {noteUrl: candidate, amountMsat: expected, callback: info.callback, signatureVerified}
}

export const redirectHeldNote = async (
  held: ReceivedNote,
  receiverSecretHex: string,
  beneficiarySecretHex: string,
  options: LnurlcashOptions = {}
): Promise<ReceivedNote> => {
  const outputHash = hashK1(beneficiarySecretHex)
  let signature: string | undefined
  try {
    signature = (await rotateNoteWithHash(held.callback, receiverSecretHex, outputHash, options)).signature
  } catch {
    // Probe below. An ambiguous rotate may already have produced the output.
  }
  const nextUrl = noteUrlWithSignature(new URL(held.noteUrl).origin + new URL(held.noteUrl).pathname, beneficiarySecretHex, held.amountMsat, signature)
  const info = await fetchNoteInfo(nextUrl, options)
  if (info.maxWithdrawable !== held.amountMsat) throw new Error('The settlement output has the wrong value.')
  return {noteUrl: nextUrl, amountMsat: held.amountMsat, callback: info.callback, signatureVerified: null}
}

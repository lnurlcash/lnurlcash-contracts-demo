import {decodeContractPacket, encodeContractPacket, signAcceptance, signContractOffer} from './coordination'
import type {ContractTerms, PartyRole} from './contract-types'
import {createIdentity, outputHashOf, randomId, randomSecretHex, signRequest, type CommitmentIntent} from './protocol'

export const mint = {
  host: 'mint.forgesworn.dev',
  withdrawLink: 'https://mint.forgesworn.dev/w',
  mintPubkey: '03bcd4846649e7b7d27e044ed7305547a5cf0209bd9629aa1de67f47d0c41b4407'
}

export const coordinationFixture = () => {
  const partyA = createIdentity()
  const partyB = createIdentity()
  const arbiter = createIdentity()
  const now = Math.floor(Date.now() / 1000)
  const terms: ContractTerms = {
    v: 1,
    contractId: randomId(),
    template: 'delivery',
    title: 'Deliver one parcel',
    memo: 'Collection and delivery agreed off-protocol.',
    labels: {party_a: 'Customer', party_b: 'Courier', arbiter: 'Dispatch arbiter'},
    participants: {party_a: partyA.pubkey, party_b: partyB.pubkey, arbiter: arbiter.pubkey},
    bonds: {party_a: '11', party_b: '17'},
    mint,
    setupExpires: now + 600,
    serviceStarts: now + 3600,
    settlementExpires: now + 86_400,
    policy: {id: 'bilateral-arbiter-v2', version: 2, challengeSeconds: 300}
  }
  const offer = signContractOffer(terms, arbiter.secretHex)
  const secrets = {
    party_a: {party_a: randomSecretHex(), party_b: randomSecretHex()},
    party_b: {party_a: randomSecretHex(), party_b: randomSecretHex()}
  }
  const acceptance = (role: PartyRole) => signAcceptance(offer, role, {
    party_a: outputHashOf(secrets[role].party_a),
    party_b: outputHashOf(secrets[role].party_b)
  }, role === 'party_a' ? partyA.secretHex : partyB.secretHex)
  const acceptances = {party_a: acceptance('party_a'), party_b: acceptance('party_b')}
  const request = (role: PartyRole) => {
    const receiverSecret = randomSecretHex()
    const intent: CommitmentIntent = {
      v: 2,
      contractId: terms.contractId,
      revision: 1,
      purpose: 'commitment',
      receiverRole: 'arbiter',
      payerRole: role,
      offerId: offer.event.id,
      participants: terms.participants,
      amount: terms.bonds[role],
      currency: 'sat',
      mint,
      outputHash: outputHashOf(receiverSecret),
      expires: terms.setupExpires,
      memo: `${terms.labels[role]} commitment`
    }
    return signRequest(intent, arbiter.secretHex)
  }
  const bondRequests = {party_a: request('party_a'), party_b: request('party_b')}
  const encoded = encodeContractPacket({offer, acceptances, bondRequests})
  const packet = decodeContractPacket(encoded)
  return {partyA, partyB, arbiter, offer, acceptances, bondRequests, encoded, packet, secrets}
}

export type CoordinationFixture = ReturnType<typeof coordinationFixture>

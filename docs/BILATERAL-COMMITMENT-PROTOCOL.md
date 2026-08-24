# Bilateral commitment protocol

## Scope

This lab implements one reusable shape: two named parties make bounded commitments to an agreement and one named arbiter temporarily controls both bonds. A ride, delivery, booking or contracted job is a template over that shape. It is not a general smart-contract language and it is not trustless escrow.

Wire roles are deliberately neutral:

- `party_a`
- `party_b`
- `arbiter`

Human labels such as rider and driver belong to the signed contract terms. They never decide authority.

## Canonical signed objects

Every object is a complete Nostr event with an exact tag set and a strict JSON body. Unknown fields and tags are rejected.

1. **Enrolment** proves control of a proposed Party A or Party B key. It is reusable, so it does not by itself accept any contract.
2. **Contract offer** is signed by the arbiter. It binds the two party keys, labels, template, title, memo, bond values, mint trust root, setup deadline, service start, challenge period and policy version.
3. **Participant acceptance** is signed independently by each named party. It binds the exact offer event id and two beneficiary-generated payout hashes, one for each possible source bond. All four targets are distinct. The payout secrets never leave that participant's browser.
4. **Bond request** is signed by the arbiter only after both acceptances verify. It binds the exact offer id, payer role, amount, receiver hash and mint.
5. **Contract packet** carries the offer, both acceptances and both bond requests. It is only an envelope; every signed component is revalidated after transport.
6. **Funding acknowledgement** is signed by the named payer after it submits its exact bond request. Activation requires both acknowledgements and the arbiter independently finding both outputs at the mint. An acknowledgement alone never proves money moved.
7. **Outcome statement** is signed on the participant device and binds the exact offer and exact pair of bond request ids.
8. **Arbiter decision** may resolve a dispute only after the contract's challenge period. It includes a reason code and evidence hash. This is attributable judgement, not objective truth.
9. **Settlement notice** is signed by the arbiter and binds a source bond to the beneficiary's already accepted output hash. The participant still probes the mint independently; the notice is not proof of solvency or receipt.
10. **Payout acknowledgement** is signed by the beneficiary only after its browser finds the private target at the mint. It lets an ambiguous two-leg settlement resume without revealing the payout secret or choosing another hash.

## Resolution table

| Resolution | Required signed authority | Party A bond | Party B bond |
| --- | --- | --- | --- |
| Complete | matching statements from A and B | refund A | refund B |
| Mutual cancel | matching statements from A and B | refund A | refund B |
| Party A self-cancels | A statement | forfeit to B | refund B |
| Party B self-cancels | B statement | refund A | forfeit to A |
| Dispute | either party | freeze | freeze |
| Dispute unresolved one challenge period past settlement expiry | signed timeout policy | refund A | refund B |
| Arbiter awards A | arbiter decision after challenge | pay A | pay A |
| Arbiter awards B | arbiter decision after challenge | pay B | pay B |
| Arbiter refunds both | arbiter decision after challenge | refund A | refund B |
| Setup expires before full activation | signed timeout policy | refund any funded side | refund any funded side |
| No outcome before settlement expiry | signed timeout policy | refund A | refund B |

Silence never selects a losing party. A dispute freezes value, but not forever: no outcome
statement or decision can be signed after the settlement window, so an unresolved dispute
refunds both sides once one further challenge period has elapsed. Contradictory
self-cancellations are treated as a dispute rather than a terminal state, so an arbiter
decision — or the two parties simply agreeing — can still resolve them.

## Activation invariant

A contract is active only when all of the following agree:

- one valid offer signed by the named arbiter;
- one acceptance from each exact party key;
- one exact bond request per party under the same offer and mint;
- one funding acknowledgement per bond from its named payer;
- both receiver outputs independently visible to the arbiter.

Anybody can donate a note to a public receiver hash. The funding acknowledgement attributes the commitment; the mint probe establishes the value. Neither substitutes for the other.

## Settlement invariant

The arbiter redirects each held note to the output hash already countersigned by the selected beneficiary. It does not generate or learn the beneficiary secret and therefore cannot spend a correctly redirected output.

An ambiguous mutation response is journalled against that same output hash. It is never changed to a different beneficiary and it is never described as failed. The beneficiary probes independently.

The arbiter can still steal before redirecting because it knows each held bond secret. Preventing that requires mint-enforced conditions or threshold custody; browser messages cannot manufacture that property.

## Policy version 2

`bilateral-arbiter-v2` fixes these rules:

- complete and mutual cancel require both parties;
- self-cancellation is unilateral and forfeits only the canceller's bond;
- disputes freeze until a signed decision becomes executable, and refund no-fault if none can still be signed;
- setup timeout refunds whichever side actually funded;
- settlement authority commits to inputs and beneficiary output hashes;
- contract ids are 128 random bits;
- every transfer remains capped at 500 sats in this public lab.

New semantics require a new policy id or version. A UI label, template or memo cannot silently change settlement behaviour.

`bilateral-arbiter-v2` supersedes `bilateral-arbiter-v1`. A v1 offer still decodes, so a contract
already under way can be resolved, but no new v1 offer can be issued. Version 1 contained two
reachable states in which no signed authority could ever move the held bonds:
contradictory self-cancellations returned a terminal result before any decision or bilateral
agreement was read, and a dispute that received no decision inside the settlement window could
never be resolved or timed out. Version 2 adds the terminal refund and treats contradictory
admissions as an ordinary dispute. No outcome that was executable under version 1 resolves
differently under version 2; only states that were previously stuck became reachable. That is why
existing v1 contracts resolve under the version 2 rules: the change can only free value that was
otherwise lost, so no party accepting v1 is disadvantaged by it.

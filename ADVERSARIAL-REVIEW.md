# Adversarial review

Reviewed against the current source and live ForgeSworn mint on 23 August 2026.

## Verdict

The lab now has a defensible hostile-path demonstration for a capped recipient-locked transfer and for referee-custodied bonds. It is not adversarially complete, trustless escrow or production-ready.

The distinction matters:

| Claim | Verdict |
| --- | --- |
| Sender cannot reclaim a successfully rotated recipient output | implemented and negatively tested |
| Signed request survives hostile transport without silent field changes | implemented and negatively tested |
| Two referee-held bonds follow the demonstrated state machine | implemented and negatively tested |
| Remote people are cryptographically enrolled and acknowledge funding | not implemented |
| Referee cannot steal or misdirect bonds | false by design in this version |
| Mint cannot steal, censor or become insolvent | false for every custodial bearer mint |
| A malicious no-show is automatically identified | impossible from silence or GPS alone |
| A compromised website cannot steal pasted notes | false until spending moves into a wallet |

## Invariants now enforced

- Contract ids are 128 random bits.
- Requests have one exact signed tag set, a maximum 15-minute lifetime and bounded clock skew.
- Bond requests bind distinct rider, driver and referee public keys and must be signed by the named referee.
- An outcome binds the exact two signed bond request ids, not only a reusable contract label.
- A resolvable bond set contains exactly one rider bond and one driver bond, with the same referee, participant keys, mint trust root and setup deadline.
- Resolution is monotonic per contract. One contract cannot sweep bonds from another.
- The public build accepts only an allowlisted withdraw endpoint and pinned mint signing key.
- A mint callback cannot move a bearer secret to another host.
- The authoritative mint value must exactly match the request. No overpayment or implicit change is accepted.
- Receiver and payout secrets are journalled before their hashes reach the mint.
- Settlement can resume with the same staged secret after an ambiguous or partial response.
- Money movement is serialised across same-origin tabs using the Web Locks API. Browsers without cross-context locking are refused.
- If setup expires with one funded bond, the referee path refunds it. If both are active, setup abort is refused.
- Expiry stops new funding but does not stop the receiver checking an output that may have been funded just before the deadline.

## Open critical and high risks

### A1. Referee custody

The referee knows both held bond secrets and can spend them without an outcome signature. No browser protocol can repair this. Removing that power requires mint-enforced conditional outputs or a threshold custody arrangement.

### A2. Remote enrolment and acknowledgements

The signed bond requests now contain the three expected keys, but this inspector generates all three locally. It does not yet prove how remote keys were authenticated. It also cannot prove the named participant funded a bond: anybody can donate a valid note to a public output hash. Before activation, each named participant must countersign the complete contract and a funding acknowledgement bound to the exact request id.

### A3. Silence is the rational cancellation attack

A malicious party will not sign a self-cancellation that costs it money. It may disappear and force a dispute. Silence cannot safely trigger forfeiture because a relay outage, dead phone or censored connection looks identical. A practical service needs a named adjudicator, evidence rules, challenge period and reputation consequence. The bond alone does not solve this game-theory problem.

### A4. Delivered JavaScript and browser storage

The site reads pasted bearer notes and stores receiver/referee secrets in origin storage. Compromised hosting, an extension, XSS or local profile theft can steal them. CSP and build hashes narrow the attack surface but do not make a mutable web origin trustworthy. Meaningful value requires wallet-mediated spending/signing and encrypted recoverable secret storage outside page JavaScript.

### A5. Payout hand-off remains custodial

The inspector generates payout secrets in the referee browser and displays bearer notes for collection. The referee therefore knows the new secret until the beneficiary imports and rotates it. A real remote flow must ask the beneficiary wallet for an output hash before settlement, so the referee never learns the payout secret.

### A6. Mint custody and availability

Key pinning detects identity substitution; it does not prove reserves or force redemption. The mint can steal, censor, link activity, disappear or report liabilities it cannot honour.

## Smarter service policy

The bond should price expected disruption, not merely copy a percentage of the fare. A useful policy is:

- symmetric base commitment for both parties;
- a cancellation penalty that rises as the agreed start approaches;
- a hard cap displayed before either party commits;
- automatic mutual cancellation refunds;
- self-cancellation settled immediately from the canceller's own signature;
- allegations and no-shows frozen for a challenge window;
- a signed referee decision containing an evidence hash, policy version and reason code;
- repeated disputes affecting matching reputation even when money cannot move automatically;
- setup expiry refunding the only funded side;
- no service activation until contract, funding and participant acknowledgements all agree.

This reduces cheap griefing. It does not create an objective truth oracle.

## Gates before a public real-sat bond claim

1. Three clean browser profiles enrol independent keys and countersign one canonical contract.
2. Each participant funds and returns a signed funding acknowledgement.
3. Portable completion, self-cancel and referee-decision messages verify after copy/paste and NIP-59 delivery.
4. Beneficiary-generated payout hashes leave the referee unable to spend settled outputs.
5. Normal completion, each cancellation, setup timeout, dispute freeze, ambiguous HTTP and partial two-leg settlement run with real disposable notes.
6. A hostile mock mint exercises callback substitution, key substitution, replay, malformed bodies, oversized bodies, automatic retry and dropped responses.
7. The deployed commit and production asset hashes are published and independently reproduced.
8. A fresh browser with no Web Locks, an expired request and altered local storage fails closed.

Until those gates pass, keep the 500-sat hard cap and describe the bond screen as a protocol inspector with explicit referee custody.

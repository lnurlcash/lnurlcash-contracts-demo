# Adversarial review

Reviewed against the hardened v2 source and three independent browser profiles on 25 August 2026.

## Verdict

The lab now demonstrates a generic, remotely coordinated bilateral commitment protocol rather than a one-browser ride simulation. Its authority and state transitions are defensible for a capped arbiter-custodied experiment. It is still not trustless escrow or production-ready.

| Claim | Verdict and evidence |
| --- | --- |
| Sender cannot reclaim a successfully rotated recipient output | implemented; unit and hostile-path tested |
| Transport cannot silently change signed fields, tags or roles | implemented; strict decoding and tamper tests |
| Party keys, acceptance and outcomes are independent of the arbiter | implemented; three clean browser profiles pass |
| A named participant acknowledged its exact bond request | implemented as a signed message; real-sat lifecycle acceptance remains |
| Activation needs both payer authority and both mint outputs | implemented and negatively tested |
| The arbiter cannot substitute settlement destinations | implemented in the honest client; four distinct per-input targets are countersigned before funding |
| The arbiter never learns beneficiary payout secrets | implemented and proved across separate browser storage; real-sat settlement remains |
| An ambiguous payout can resume without changing its target | implemented through beneficiary probe and signed payout acknowledgement |
| A malicious arbiter cannot steal held bonds | false by design; the arbiter knows both held secrets |
| A malicious mint cannot steal, censor or become insolvent | false for every custodial bearer mint |
| The protocol objectively identifies a no-show | false; silence and GPS are not trustworthy oracles |
| A compromised website cannot steal pasted notes or browser keys | false until spending and signing move into a wallet |

## Enforced invariants

- Contract ids contain 128 random bits.
- `party_a`, `party_b` and `arbiter` are wire authority. Template labels have no authority.
- Every event has a strict body and exact ordered tags; unknown fields and tags are refused.
- Offers bind the exact keys, labels, template, values, mint trust root, setup and settlement windows, challenge period and `bilateral-arbiter-v2` policy.
- All three keys must be different. Only the named arbiter signs the offer and bond requests.
- Each party independently countersigns the exact offer id and two per-source payout hashes.
- All four payout targets are distinct, preventing two source notes from colliding at one receiver hash.
- A full packet revalidates its offer, both acceptances and exactly one commitment request per role.
- Each commitment request binds the offer id, named payer, complete participant set, exact amount, mint and arbiter-owned receiver hash.
- Activation requires both participant funding acknowledgements and both outputs independently visible to the arbiter.
- Outcomes, decisions, notices and payout acknowledgements bind both the exact offer and exact bond-set hash.
- Known reuse of one contract id with different offers, acceptance replacement, packet replacement and per-source settlement-notice replacement all fail closed.
- A locally named participant cannot fund or sign an outcome unless its packet acceptance still matches both private payout secrets in that browser.
- Completion and mutual cancellation require both parties. Self-cancellation can only be signed by the self-cancelling party.
- Contradictory self-cancellations fail into dispute. An explicit dispute takes precedence over otherwise executable participant outcomes, and freezes value until a decision executes or the terminal refund deadline passes.
- Arbiter decisions contain a reason and evidence hash, must follow a signed dispute and cannot execute until the signed challenge period ends.
- Distinct decisions are retained rather than overwritten and make settlement refuse as arbiter equivocation.
- Setup timeout refunds every funded but unactivated side. Contract timeout refunds both active sides without assigning guilt when no dispute or executable authority exists.
- Resolution is monotonic. Another contract, resolution or output hash cannot replace a staged journal.
- Every settlement input uses the exact target accepted by its selected beneficiary for that source role.
- The arbiter signs a settlement notice but cannot probe the private target. The beneficiary probes and signs receipt acknowledgement.
- An ambiguous mutation is never described as failed or retried automatically. A matching beneficiary acknowledgement can reconcile it without revealing the secret.
- Money movement is serialised across same-origin tabs using Web Locks. Browsers without cross-context locks are refused.
- The public build accepts only the pinned ForgeSworn endpoint and mint key, exact-value notes and transfers no larger than 500 sats.

## Open critical and high risks

### A1. Arbiter custody remains absolute before settlement

The arbiter knows both held bond secrets and can spend either without presenting the signed outcome to the mint. Client validation constrains an honest implementation, not a malicious custodian. Removing that power requires mint-enforced conditional outputs or threshold custody.

### A2. Key control is not real-world identity

Signed enrolment proves possession of a key. It does not prove that the key belongs to the intended rider, courier, client or provider. Participants must compare fingerprints over an already authenticated channel. An application may bind those fingerprints to its own account or reputation system, but that is outside this rail.

### A3. Delivered JavaScript and local storage remain hot

The page reads payer notes and stores signing keys, arbiter receiver secrets and beneficiary payout secrets in origin storage. CSP, no third-party code and reproducible asset hashes narrow the attack surface but cannot make a mutable origin or browser extension trustworthy. Meaningful value needs wallet-mediated spending/signing and encrypted recoverable storage outside page JavaScript.

### A4. Mint custody, privacy and availability

The mint can steal, refuse redemption, link rotations, disappear or claim liabilities it cannot honour. A pinned signing key establishes continuity of mint identity; it does not establish reserves or availability.

### A5. No-show truth and arbiter incentives

A rational bad actor may refuse to self-cancel and raise or force a dispute. Silence cannot safely forfeit a bond because outage, censorship and a dead phone look identical. The v2 policy makes any judgement attributable and challenge-delayed, but a malicious or bribed arbiter can still decide dishonestly and already controls the funds.

### A6. Ambiguous mutation where the beneficiary finds nothing

If an arbiter loses the mutation response, the beneficiary may find the output and acknowledge it, which safely resumes the second leg. If the beneficiary finds nothing, there is no cryptographic proof of non-receipt and the lab refuses automatic retry. A production mint needs replay-safe idempotence for the exact input and output hash.

### A7. Transport metadata and delivery

The three-profile test proves copy/paste and fragment hand-off. It does not prove NIP-59 delivery, ordering, retries or authenticated messenger UX. Fragments stay out of HTTP requests but remain visible to endpoints, history and extensions.

### A8. Independent build provenance

The repository, locked dependencies, Node 24 build commands, deployed source commit and public asset hashes are all published. This release has not yet received a third-party rebuild attestation or signed software provenance. That is a remaining release-transparency check, not a cryptographic protocol gap.

### A9. Split-view equivocation discovery

The client now fails closed when it sees conflicting signed offers, acceptances, packets, decisions or settlement notices. A malicious arbiter can still show one fork to Party A and another to Party B if the parties never compare the same transcript. Copy/paste transport provides no global consistency or gossip proof. The packet and offer fingerprints must be compared over an authenticated shared channel; a production coordinator should publish an append-only contract transcript.

## Smarter policy now implemented

- neutral bilateral roles with signed use-case templates;
- activation only after contract acceptance, payer acknowledgement and independent mint verification all agree;
- two private payout targets per beneficiary so every possible input has a unique destination;
- unilateral self-cancellation but bilateral completion and mutual cancellation;
- dispute freeze plus reasoned, evidence-hashed, challenge-delayed arbiter decisions;
- setup refund based on activation rather than merely seeing two donated notes;
- no-fault refund after the settlement window when nobody produced executable authority or a dispute;
- contradictory self-cancellations treated as a dispute rather than an unrecoverable state;
- a terminal no-fault refund one challenge period after settlement expiry, so no reachable state freezes value permanently;
- durable, monotonic per-input settlement journals;
- beneficiary acknowledgements that reconcile successful ambiguous settlement without target substitution.
- canonical signed-state slots, local payout-secret continuity and retained decision-equivocation evidence.

This improves griefing resistance and auditability. It does not manufacture an objective service oracle or remove custody.

## Remaining gates before a public real-sat bond claim

1. Run normal completion, both self-cancellations, mutual cancellation, setup timeout, contract timeout, dispute decision and ambiguous first/second-leg recovery with real disposable notes across three browser profiles.
2. Exercise every portable message through the intended NIP-59 or application transport, including duplicate, delayed, reordered and dropped delivery.
3. Run a browser-level hostile mock mint covering callback substitution, key substitution, replay, malformed and oversized bodies, definite refusal, dropped mutation responses and non-idempotent retry behaviour.
4. Move note spending and participant signing behind a wallet API so the page never receives long-lived keys or arbitrary bearer notes.
5. Have an independent developer rebuild the published source commit and compare all four asset hashes; add signed provenance before treating deployment identity as independently attested.
6. Replace single-arbiter custody with mint-enforced conditions or a documented threshold custodian before raising the cap or making a trustless claim.

Until those gates pass, retain the 500-sat cap and the explicit `arbiter custody` label.

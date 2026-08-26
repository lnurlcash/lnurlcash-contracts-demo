# LNURLcash Contracts Lab

A static real-sats protocol lab for two deliberately different things:

1. A sender funds a recipient-generated output hash and never learns the resulting spend secret.
2. Two independently identified parties put bounded commitments under an explicitly custodial arbiter and exchange portable signed authority for activation and settlement.

The second flow is not trustless escrow. The arbiter controls both held bond secrets and can steal them before settlement. The useful improvement is narrower and real: the arbiter cannot invent participant acceptance or outcomes, and it no longer learns the beneficiaries' settlement secrets.

The public build talks only to the allowlisted experimental ForgeSworn mint. It pins the withdraw endpoint and mint signing key, accepts exact-value notes only, and caps every transfer at 500 sats. It has no application backend, analytics, service worker, remote JavaScript or remote assets.

## Generic bilateral contract

The wire roles are `party_a`, `party_b` and `arbiter`. Ride, delivery, booking, contracted work and custom agreements are templates containing signed human labels. A label such as rider or courier never decides authority.

The remote ceremony is:

1. Party A and Party B create their keys in separate browser profiles and send signed enrolments to the arbiter.
2. The arbiter signs one canonical offer containing the parties, labels, bond values, mint, setup deadline, settlement window, challenge period and immutable policy id.
3. Each party imports that offer and signs an acceptance. Before signing, its browser persists two unique payout secrets, one for each possible source bond, and reveals only their hashes.
4. Only after both acceptances verify does the arbiter create the two receiver-locked bond requests and package every signed component together.
5. Each named party funds only its request and returns a funding acknowledgement. The arbiter separately probes both outputs. The contract activates only when both facts agree for both parties.
6. Completion and mutual cancellation require matching portable statements from both parties. Self-cancellation requires only the self-cancelling party. A dispute freezes value.
7. A dispute decision is signed by the arbiter with a reason and evidence hash, then waits through the contract's signed challenge period.
8. Settlement redirects each held input to the exact per-input hash accepted by its beneficiary. The arbiter publishes signed settlement notices; beneficiaries probe privately and acknowledge receipt without revealing their secrets.

If setup never activates, every funded side is refundable after the setup deadline. If an active contract reaches its settlement deadline with no dispute or executable outcome, both sides are refunded without assigning guilt. Silence never causes forfeiture.

The canonical message model and resolution table are in [docs/BILATERAL-COMMITMENT-PROTOCOL.md](docs/BILATERAL-COMMITMENT-PROTOCOL.md).
The exact role mapping, supported templates and cases this policy deliberately does not cover are in [docs/USE-CASE-MATRIX.md](docs/USE-CASE-MATRIX.md).

## What is experimental

`lnurlcashlock1`, `cashmsg1`, `cashpacket1` and Nostr kinds 2530–2537 are lab formats, not published interoperability standards. Existing v1 direct-payment requests remain decodable so an already-issued receiver secret is not orphaned. The v2 browser store is separate, and the UI exposes earlier v1 recovery JSON before deletion.

Fragment links carry signed contract data but no bearer note or payout secret. A fragment is not sent to this static server, although it remains visible to the recipient, messenger, browser history, extensions and screenshots. Never put an LNURLcash `k1` in a hand-off link.

The remote protocol is transport-agnostic. Copy and paste works now. The application import path is tested with duplicate, dropped, delayed and reordered messages across every portable message type. NIP-59, Signal or another authenticated channel may carry the same bytes, but this repo does not yet claim a field-tested NIP-59 relay integration.

## Run it

```bash
npm install
npm run check
npm run dev
npm run acceptance:browser
```

The browser acceptance expects Chrome and defaults to `http://127.0.0.1:4181`. It runs the separate-profile ceremony, a hostile-mint matrix and a complete stateful mock lifecycle with ambiguous-settlement recovery. Set `DEMO_ORIGIN=https://labs.moneyer.dev LIVE_MINT=1` to exercise the deployed site and live pinned mint discovery without moving sats. The mock lifecycle deliberately moves no real sats and reports that fact.

One capped real-sat normal-completion run has also passed against the public site: two independent persistent party profiles committed 10 sats each, the arbiter profile verified both held outputs, both parties signed completion, both settlement legs confirmed, both beneficiaries acknowledged their private outputs and the full 20 sats returned to an encrypted Notecase wallet. The guarded runner is `npm run acceptance:browser:real-sats`; it requires a fresh isolated Notecase home, the sibling Notecase build, `REAL_SATS=25_SAT_ACCEPTANCE` and an explicit wallet PIN. If a funded run stops, preserve all three profiles and use `REAL_SATS_RECOVERY=FUNDED_PROFILE` to continue the same contract. Never start again with different notes.

For a real transfer, create an exact-value disposable note in Notecase or another compatible LUD-25 wallet. Do not use meaningful balances.

## Security boundaries

- The arbiter is a custodian until the mint enforces conditional spending or custody becomes threshold-based.
- A valid Nostr signature proves key control, not the real-world identity behind that key. Compare fingerprints over an authenticated channel.
- Delivered JavaScript and browser extensions can read locally held keys and bearer secrets. Production spending and signing belong in a wallet.
- The mint can steal, censor, link activity or become insolvent. Key pinning detects substitution, not solvency.
- A no-show is evidence for an attributable human decision, not an objective fact produced by GPS or silence.
- A second valid signature can still be malicious. Known offer, acceptance, packet, decision and settlement forks are detected and fail closed rather than replacing the first state.

See [THREAT-MODEL.md](THREAT-MODEL.md) and [ADVERSARIAL-REVIEW.md](ADVERSARIAL-REVIEW.md) for the current verdict and remaining acceptance gates.

Arbiter custody is not a design choice that better client code can undo. An output hash must be published before funding, so exactly one entity knows each spend secret. [docs/CONDITIONAL-OUTPUTS-PROPOSAL.md](docs/CONDITIONAL-OUTPUTS-PROPOSAL.md) sets out why thresholds cannot sit on a hash-lock, and argues that the answer is the `locked notes` option already on the [lnurlcash-conformance](https://github.com/TheCryptoDonkey/lnurlcash-conformance) threat scorecard, generalised with a threshold and a timelock.

## Hosting

The public lab is [labs.moneyer.dev](https://labs.moneyer.dev). Deployment evidence, asset hashes and rollback locations are recorded in [DEPLOY.md](DEPLOY.md).
The exact source is public at [TheCryptoDonkey/lnurlcash-contracts-demo](https://github.com/TheCryptoDonkey/lnurlcash-contracts-demo), so other LNURLcash developers can inspect the signed-state model and run the same browser ceremony themselves.

The static host sends a mint-specific CSP, disables framing and browser capabilities the lab does not need, prevents HTML caching and gives immutable caching only to fingerprinted assets.

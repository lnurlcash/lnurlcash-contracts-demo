# Conditional outputs for LNURLcash

Status: additive implementation proposal for eventual LUD-25 adoption.

This document records an argument and the evidence behind it. It does not modify the upstream
[LUD-25 draft](https://github.com/lnurl/luds/pull/301) or dni's reference repositories, and it
does not yet propose a wire format.

The short version: **option G in the conformance suite's threat scorecard is the right trade, and
escrow needs it generalised.** Locked notes replace preimage redemption with signature redemption
for a single holder. Multi-party settlement needs the same trade plus a threshold and an absolute
refund branch. Everything below argues why, using a working implementation as the evidence.

## Relationship to the existing scorecard

`vectors/threat-suite.json` in [`lnurlcash-conformance`](https://github.com/lnurlcash/lnurlcash-conformance)
already scores candidate options against fixed attacks. Two entries there matter here.

Option G, *locked notes*, proposes that redemption require an LUD-04 signature from a linkingKey
registered at mint or rotate time, over the full redemption request. The file describes it as "a
second asset class, not a bearer variant".

The suite's `coreTheorem` states the reason:

> Re-encrypting a bearer credential to the party that redeems it never shrinks its exposure set:
> the mint honors the ciphertext, so the ciphertext IS the note. The only encryption that helps is
> encrypting to the holder, which kills bearer-ness — option G takes that trade deliberately, via
> signatures rather than ciphertext.

This document reaches the same conclusion from a different direction. The scorecard arrives at it
by asking who can *observe* a credential. The contracts lab arrives at it by asking who can
*spend* one when three parties are involved. Both end at: the mint must check a signature, not a
preimage.

**Conditional outputs are option G with a threshold and a timelock.** That framing matters, because
it means this is not a separate design programme — it is the multi-party case of a proposal already
on the board.

## Why a threshold cannot be built on top

The scorecard's scenarios T1–T11 cover transport exposure and races. None cover multi-party
settlement authority, so the following is not yet represented there.

An LNURLcash output is keyed by `sha256(k1)`, and that hash must be published **before** anyone
funds it. Publishing it requires knowing `k1`. Therefore, at the moment any output is created,
exactly one entity knows the whole secret and can spend it alone.

No client-side construction removes this:

- **Secret sharing does not help.** Splitting `k1` into `t`-of-`n` shares after the fact gives
  threshold *reconstruction*, but the dealer already knows the secret and cannot prove otherwise.
- **Dealerless generation is not available.** It would require computing `sha256(k1)` from shares
  without ever assembling `k1`. SHA-256 is not homomorphic.
- **Moving the dealer does not help.** A payer who generates their own bond secret can reclaim it
  the moment an outcome goes against them, and nobody else can detect this, because probing an
  output requires its secret. A counterparty who generates it can take it at will.

**Hash-locks provide 1-of-1 and, through `mergeNotesWithHash`, n-of-n. They cannot provide t-of-n.**
Every escrow or arbitrated-settlement design on this rail therefore places unilateral spending
power with a custodian. That is a protocol limit, not an implementation choice — which is exactly
the shape of the `coreTheorem`, one party further along.

## Evidence from a working implementation

[`lnurlcash-contracts-demo`](https://github.com/TheCryptoDonkey/lnurlcash-contracts-demo) implements
bilateral commitments carefully: neutral wire roles, strict exact-tag decoding, independent
acceptance, precommitted per-input payout targets, monotonic settlement journals. It still cannot
prevent its arbiter from stealing, because no amount of client rigour can.

### Dividing custody does not remove it

Custody can be divided without mint changes: fund a bond as `k` slices, each locked to a hash from
a different custodian, and settle each slice independently. Single-party theft is then capped at
`1/k` and attributable to a named key.

Measured against the lab's message set that costs roughly `8 + 2k` setup messages instead of 8,
`4k` settlement messages instead of 4, `6k` distinct output hashes instead of 6, and `2k` funding
mutations instead of 2 — each with its own ambiguous-response risk. It also distributes
verification, because no participant can probe an output whose secret it does not hold.

A large increase in coordination for a model that still ends at "a third of the bond can be
stolen". It is a waypoint, not a destination.

### Two freeze states a timelock would have made impossible

The lab's `bilateral-arbiter-v1` policy contained two reachable states in which value was
permanently stuck. Both are now fixed in client logic, and both are worth reading as requirements
rather than as bugs:

1. **Contradictory self-cancellations.** Both parties admitting fault returned a terminal result
   before any decision or bilateral agreement was read, so no signed authority could move the bonds
   again.
2. **A dispute with no in-window decision.** A dispute blocks the no-fault timeout, but no decision
   or outcome statement can be signed after the settlement window closes. An honest but merely late
   arbiter stranded both bonds forever.

The fixes are **conventions, not enforcement**. They bind an honest client. A custodian that
ignores them keeps the money. An absolute, mint-honoured refund branch makes both states
structurally impossible instead of merely handled — nobody's cooperation required, including the
custodian's.

Fixing them also produced a third result worth recording: the first attempt applied the new
terminal refund retroactively to contracts accepted under the old policy, on the reasoning that a
refund can only free value that would otherwise be lost. That reasoning is wrong. A refund is worse
than a favourable award for the party who would have won one, and it can fire merely because a
valid decision has not reached that client. **Settlement capabilities must be keyed to the policy a
contract was accepted under, never to whichever policy is current.** Any conditional-output design
inherits this: an output must carry its own rules, and an upgraded mint must keep honouring the
rules an output was created under.

## What exists today

From `lnurlcash-kit@0.5.0`, cross-checked against the current LUD-25 draft
profile used by the ForgeSworn conformance suite:

| Concern | Current shape |
| --- | --- |
| Note URL | `<withdrawLink>?k1=<hex>&amount=<msat>` plus optional `sig` |
| Hash-locked mutation | GET the callback with `k1`, `h`, `amount` |
| Available mutations | `rotateNoteWithHash`, `splitNoteWithHash` (two outputs, with change), `mergeNotesWithHash` |
| Mint identity | `mintPubkey` in the mint address document, signature over `(k1, amountMsat)` |
| Baseline mint commitment | `commentAllowed >= 64`; every new mint quote carries `comment=hex(sha256(secret))` |
| Additive capability advertisement | `mintToHash` boolean in the mint address and pay-request documents |

Two of these carry most of the design. There is already a **capability-flag precedent**
(`mintToHash`, and the receipt negotiation in the conformance suite's
`docs/BOUND-MINT-RECEIPTS.md`), so conditional support needs no new discovery mechanism. The
mandatory `comment` closes the mint-time preimage race; it does **not** add conditional
redemption. That remains a separate mint-enforced extension because the mint must evaluate the
spending witness, not merely know how the output hash was chosen. The mutation endpoint already
takes an opaque `h` — the mint does not care how that hash was derived.

## Sketch

Deliberately a sketch. The normative text should be written after the questions below are settled,
and it belongs alongside the other extension documents in `lnurlcash-conformance/docs/`.

**Core idea.** Keep `h` as it is. Allow it to commit to a **condition** rather than to a spend
secret. Creating a conditional output is then wire-identical to creating any output today; only
redemption changes, presenting the condition preimage and a witness satisfying it. The mint checks
`sha256(canonical(condition)) == h`, then verifies the witness.

**Relation to option G.** A single-branch, single-key, no-timelock condition *is* a locked note. If
G lands first, conditional outputs are the generalisation of its verification step from one
signature to a branch table. If conditions land first, G is a profile of them. Landing them
independently would produce two overlapping mechanisms, so they should be designed together.

**Illustrative condition.** Not a proposed wire format; included to make the requirements concrete.

```json
{
  "v": 1,
  "sigflag": "inputs_and_outputs",
  "branches": [
    {"id": "settle",     "keys": ["<pk_a>", "<pk_b>"], "n_sigs": 2},
    {"id": "adjudicate", "keys": ["<pk_w>"],           "n_sigs": 1, "after": 1780000000},
    {"id": "refund",     "keys": ["<pk_owner>"],       "n_sigs": 1, "after": 1780086400}
  ]
}
```

`settle` is the happy path where both parties agree and the third key is never contacted;
`adjudicate` is the arbitrated path, available only after the challenge period; `refund` is the
absolute backstop that makes both freeze states impossible.

`sigflag: "inputs_and_outputs"` is load-bearing, and it is the same requirement option G already
states — the signature must cover the full redemption request. A witness committing only to the
input can be replayed against a different destination, which reintroduces exactly the substitution
attack the lab's precommitted payout hashes exist to prevent.

**Fail-closed negotiation.** An output committed to a condition its mint cannot evaluate is
permanently unspendable, so a client MUST NOT create one unless the mint advertises every construct
it uses, checked against the same pinned `mintPubkey`, and a mint that withdraws support MUST keep
honouring outputs already created under it.

## Requirements

1. Named secp256k1 keys and their encoding, consistent with option G's linkingKey registration.
2. Explicit branches with thresholds, and deterministic resolution when two are simultaneously
   satisfiable.
3. Witness commitment covering both the input and the chosen outputs.
4. An absolute refund branch, and a setup-phase refund for outputs that never reach their intended
   state.
5. Unique per-input receiver hashes, or an explicit statement that a mint accepts multiple inputs
   at one output hash.
6. Atomic multi-input settlement, or a specified partial-failure protocol.
7. Replay-safe idempotence keyed on the exact `(input, output hash)` pair — the existing
   `retried-mutation.json` vectors already draw this line for unconditional notes and should extend
   to conditional ones.
8. Capability and policy-version negotiation that fails closed.
9. Canonical serialisation, so `sha256(canonical(condition))` is reproducible across
   implementations.
10. Clock semantics — whose clock, what skew, and behaviour at a boundary.
11. Federation and key rotation, including outputs created under a previous `mintPubkey`.
12. Rules travel with the output. A mint that has moved to a newer condition version MUST continue
    to settle an existing output under the version it was created with.

## Open questions

- **Canonicalisation.** JCS, or a binary encoding? A byte of ambiguity makes an output unspendable
  at one implementation and spendable at another.
- **Where the witness travels.** New query parameters, or a POST body? Conditions plus signatures
  will exceed comfortable URL lengths, and `callbacks.json` currently pins the exact query each
  operation puts on the wire.
- **Privacy.** Revealing the condition at redemption discloses the branch structure and every named
  key to the mint. A hash tree over branches would reveal only the branch taken. Worth the
  complexity? This interacts directly with T6, operator correlation.
- **Does the mint verify, or merely record?** Verification is the point, but it puts consensus-like
  logic into a custodial service that can lie anyway. What does enforcement buy against a dishonest
  *mint*, as distinct from a dishonest *counterparty*? This deserves an explicit answer rather than
  an assumed one, and it is the question most likely to sink the proposal.
- **Interaction with `splitNoteWithHash`.** If one input satisfies a condition and produces two
  outputs, requirement 3 says the witness must commit to both, which makes split-with-conditions
  strictly harder than rotate-with-conditions.

## Conformance

`lnurlcash-conformance` already has the machinery, so this proposal should add to it rather than
invent a parallel suite. Three additions:

**A `conditional-outputs.json` vector file**, in the same shape as the existing files, covering:
each branch satisfied correctly and one second before its `after`; two simultaneously satisfiable
branches, checked for deterministic resolution; a witness valid for the input but naming a
different output, refused; replay of an identical `(input, output hash)` mutation, idempotent;
replay of the same witness against a different input, refused; a condition using an unadvertised
construct, refused at creation rather than discovered at redemption; malformed, oversized and
non-canonical encodings; an output created before a `mintPubkey` rotation, redeemed after it; and
clock-boundary behaviour at each `after`.

**Mock-mint misbehaviours** for the adversarial cases: a mint that advertises a construct and then
refuses it, one that accepts a witness committing to the wrong output, and one that applies a newer
condition version to an older output.

**New threat-suite scenarios.** T1–T11 are transport and race scenarios; multi-party settlement
authority is unrepresented. Candidates in the existing format: custodian spends a held bond before
settlement; contract reaches a state with no signed exit; wrong beneficiary selected because
authority did not reach the settling client; and a settlement capability changed by an upgrade
rather than by the output's own rules. Option A pins today's vulnerable behaviour for all four, and
the PR landing conditional outputs inverts them — which is precisely the `redGreen` policy the file
already describes.

## Where this should live

The evidence and the argument belong here, next to the implementation that produced them. The
normative text, once the open questions are settled, belongs in `lnurlcash-conformance/docs/`
alongside `BOUND-MINT-RECEIPTS.md` and `NWC-PROFILE.md`, with the vectors beside it — and it should
be written jointly with option G rather than as a competing mechanism.

# Conditional outputs for LNURLcash (draft proposal)

## Status

Draft for discussion. Not a published standard and not an agreed extension to LUD-25.

Written against `lnurlcash-kit@0.2.1` and the contracts lab in this repository. Wire details
below were read from that client, not from a specification document. Anything marked **open**
needs an answer before this could be implemented by two parties independently.

## Why this is needed

### The impossibility result

An LNURLcash output is keyed by `sha256(k1)`, and that hash must be published **before** anyone
funds it. Publishing it requires knowing `k1`. Therefore, at the moment any output is created,
exactly one entity knows the whole secret, and that entity can spend it alone.

This is not a property that better client software can remove:

- **Secret sharing does not help.** Splitting `k1` into `t`-of-`n` shares after the fact gives
  threshold *reconstruction*, but the dealer already knows the secret and cannot prove otherwise.
- **Dealerless generation is not available.** It would require computing `sha256(k1)` from shares
  without ever assembling `k1`. SHA-256 is not homomorphic.
- **Moving the dealer does not help.** A payer who generates their own bond secret can reclaim it
  the moment an outcome goes against them, and nobody else can even detect this, because probing
  an output requires its secret. A counterparty who generates it can take it at will.

**Hash-locks provide 1-of-1 and, through `mergeNotesWithHash`, n-of-n. They cannot provide
t-of-n.** Every escrow, bonded-commitment or arbitrated-settlement design on this rail therefore
places unilateral spending power with a custodian. That is a protocol limit, not an implementation
choice.

### The workaround does not remove custody

Custody can be *divided* without mint changes: fund a bond as `k` slices, each locked to a hash
from a different custodian, and settle by redirecting each slice independently. Single-party theft
is then capped at `1/k` and is attributable to a named key.

Measured against this lab's message set, that costs roughly `8 + 2k` setup messages instead of 8,
`4k` settlement messages instead of 4, `6k` distinct output hashes instead of 6, and `2k` funding
mutations instead of 2 — each with its own ambiguous-response risk. It also distributes
verification, because no participant can probe an output whose secret it does not hold.

That is a large increase in coordination for a trust model that still ends in "a third of the bond
can be stolen". It is a waypoint, not a destination.

### Two freeze states that a timelock would make impossible

The lab's `bilateral-arbiter-v1` policy previously contained two reachable states in which value
was permanently stuck, both now fixed in client logic:

1. **Contradictory self-cancellations.** Both parties admitting fault returned a terminal
   `disputed` state before any arbiter decision or bilateral agreement was read, so no signed
   authority could ever move the bonds again.
2. **A dispute with no in-window decision.** A dispute blocks the no-fault timeout, but no decision
   or outcome statement can be signed after the settlement window closes. An honest but merely late
   arbiter stranded both bonds forever.

Both were fixed by adding client-side policy: treat contradictory admissions as an ordinary
dispute, and add a terminal refund at `settlementExpires + challengeSeconds`.

The point for this proposal is that **those fixes are conventions, not enforcement**. They bind an
honest client. A custodian that ignores them keeps the money. An absolute, mint-honoured refund
branch would make both states structurally impossible rather than merely handled — nobody's
cooperation required, including the custodian's.

## What exists today

From `lnurlcash-kit@0.2.1`:

| Concern | Current shape |
| --- | --- |
| Note URL | `<withdrawLink>?k1=<hex>&amount=<msat>` plus optional `sig` |
| Hash-locked mutation | GET the callback with `k1`, `h`, `amount` |
| Available mutations | `rotateNoteWithHash`, `splitNoteWithHash` (two outputs, with change), `mergeNotesWithHash` |
| Mint identity | `mintPubkey` in the mint address document, signature over `(k1, amountMsat)` |
| Capability advertisement | `mintToHash` boolean in the mint address and pay-request documents |

Two of these matter a great deal for what follows. There is already a **capability flag
precedent** (`mintToHash`), so conditional support does not need a new discovery mechanism. And
the mutation endpoint already takes an opaque `h` — the mint does not care how that hash was
derived.

## Proposal

### Core idea

Keep `h` exactly as it is. Allow it to commit to a **condition** rather than to a spend secret.

- **Creating** a conditional output is wire-identical to creating any output today. The payer
  sends `h`. The mint stores it. No new fields.
- **Spending** a conditional output presents the condition preimage and a witness satisfying it,
  instead of `k1`. The mint checks `sha256(canonical(condition)) == h`, then verifies the witness.

This is deliberately minimal. It adds no new output type, no new note format, and nothing for a
mint to store beyond what it stores now.

### Capability negotiation, fail-closed

This is the safety-critical part. An output committed to a condition that its mint cannot evaluate
is **permanently unspendable**. Negotiation must therefore fail closed:

1. The mint advertises `conditions: {v: 1, sigflags: [...], branches: [...]}` in its address
   document, alongside `mintToHash`.
2. A client MUST NOT rotate into a condition-committed `h` unless the mint advertises support for
   every construct that condition uses.
3. A client MUST re-check the advertisement against the same `mintPubkey` it pinned, so a
   downgrade cannot be induced by substituting the mint document.
4. A mint that stops supporting a construct MUST continue to honour outputs already created under
   it. **Open:** how long, and what a mint does when it cannot.

### Illustrative condition shape

Not a proposed wire format. Included to make the requirements concrete.

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

Read against the lab's actual needs: `settle` is the happy path where both parties agree and the
third key is never contacted; `adjudicate` is the arbitrated path, available only after the
challenge period; `refund` is the absolute backstop that makes both freeze states impossible.

`sigflag: "inputs_and_outputs"` is load-bearing. A witness that commits only to the input can be
replayed against a different destination, which reintroduces exactly the substitution attack the
lab's precommitted payout hashes exist to prevent.

### What this changes for the lab

Under a mint that enforces the above, the third party **signs but never holds**. The accurate word
for a key that only matters when two people disagree is *witness* or *tiebreaker*, not *arbiter*,
and the custody warnings in `THREAT-MODEL.md` become obsolete rather than merely mitigated.

## Requirements

Any conditional-output design for this rail must specify:

1. Named secp256k1 keys and their encoding.
2. Explicit branches with thresholds, and deterministic resolution when two branches are
   simultaneously satisfiable.
3. Witness commitment covering both the input and the chosen outputs.
4. An absolute refund branch, and a setup-phase refund for outputs that never reach their intended
   state.
5. Unique per-input receiver hashes, or an explicit statement that a mint accepts multiple inputs
   at one output hash.
6. Atomic multi-input settlement, or a specified partial-failure protocol.
7. Replay-safe idempotence keyed on the exact `(input, output hash)` pair, so a lost response can
   be retried without risk of double-spending or double-crediting.
8. Capability and policy-version negotiation that fails closed.
9. Canonical serialisation, so `sha256(canonical(condition))` is reproducible across
   implementations.
10. Clock semantics — whose clock, what skew is tolerated, and what a mint does at a boundary.
11. Federation and key-rotation behaviour, including outputs created under a previous `mintPubkey`.
12. Lost-key and recovery behaviour.

## Open questions

- **Canonicalisation.** JCS, or a binary encoding? A single byte of ambiguity makes an output
  unspendable at one implementation and spendable at another.
- **Where the witness travels.** New query parameters on the existing callback, or a POST body?
  Conditions plus signatures will exceed comfortable URL lengths.
- **Privacy.** Revealing the condition at spend time discloses the branch structure and every named
  key to the mint. A hash-tree over branches would reveal only the branch taken. Worth the
  complexity?
- **Does the mint verify, or merely record?** Verification is the point, but it puts consensus-like
  logic into a custodial service that can lie anyway. What does enforcement actually buy against a
  dishonest mint, as distinct from a dishonest counterparty? This deserves an honest answer in the
  proposal rather than an assumed one.
- **Interaction with `splitNoteWithHash`.** If one input satisfies a condition and produces two
  outputs, does the witness commit to both? Point 3 says it must, which makes split-with-conditions
  strictly harder than rotate-with-conditions.

## Conformance suite

A proposal without one will produce incompatible implementations. At minimum:

- Each branch satisfied correctly, and each branch satisfied one second before its `after`.
- Two simultaneously satisfiable branches, checked for deterministic resolution.
- A witness valid for the input but naming a different output, which must be refused.
- Replay of an identical `(input, output hash)` mutation, which must be idempotent.
- Replay of the same witness against a different input, which must be refused.
- A condition using a construct the mint does not advertise, refused at creation rather than
  discovered at spend.
- Malformed, oversized and non-canonical condition encodings.
- An output created before a `mintPubkey` rotation, spent after it.
- Clock-boundary behaviour at each `after`.

## Relationship to other work

Cashu's spending-condition work (P2PK with signature thresholds, locktime and refund keys) is the
closest precedent and solves a recognisably similar problem. This proposal does not claim those
formats transfer directly — the note model differs — but the branch-and-timelock structure and the
fail-closed capability question are the same shape, and divergence should be deliberate rather than
accidental.

## What this repository contributes

This lab is the worked negative example. It implements bilateral commitments carefully — neutral
wire roles, strict exact-tag decoding, independent acceptance, precommitted per-input payout
targets, monotonic settlement journals — and it still cannot prevent the custodian from stealing,
because no amount of client rigour can. That is the argument for conditional outputs, stated as
running code rather than as an assertion.

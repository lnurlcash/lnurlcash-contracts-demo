# Conditional service bonds

## Blunt conclusion

Receiver-locked LNURLcash solves payment delivery. It does not solve conditional escrow.

A plain LUD-25 output is keyed by `sha256(k1)`. Anyone holding `k1` can spend it and nobody else can. There is no alternative signature branch, threshold or timeout refund. Giving `k1` to a counterparty transfers the bond immediately. Giving it to an arbiter creates custody.

## Generic bilateral policy

The v2 lab fixes one reusable policy for Party A and Party B:

| Outcome | Required authority | Party A bond | Party B bond |
| --- | --- | --- | --- |
| Complete | A + B | refund A | refund B |
| Mutual cancel | A + B | refund A | refund B |
| A self-cancels | A | forfeit to B | refund B |
| B self-cancels | B | refund A | forfeit to A |
| Dispute | either party | freeze | freeze |
| Arbiter awards A | arbiter after challenge | pay A | pay A |
| Arbiter awards B | arbiter after challenge | pay B | pay B |
| Arbiter refunds both | arbiter after challenge | refund A | refund B |
| Setup never activates | setup timeout | refund funded A | refund funded B |
| No outcome by settlement expiry | contract timeout | refund A | refund B |

Silence never identifies a guilty party. It can eventually produce a no-fault refund only when nobody raised a dispute or supplied executable signed authority.

Ride, delivery, booking and contracted work change labels and commercial evidence, not this settlement table. A materially different rule requires a new policy id and new acceptance.

## Route implemented now: explicit arbiter

The arbiter receives two notes under secrets it controls. That lets the honest client enforce the table and also lets a malicious arbiter steal.

Participants now generate two payout secrets on their own devices and countersign only their hashes. Two are required because one beneficiary may receive both source bonds and a mint cannot safely be assumed to accept two independent notes at one output hash. During settlement the arbiter redirects each input to its exact beneficiary/source hash and never receives the secret.

That removes payout-secret custody after a correct redirect. It does not remove custody of the held inputs before redirect.

DonkeyRide's HODL-invoice provider has the same essential boundary: an operator controls settlement and must compensate the selected party. The generic lab makes participant authority and payout destinations portable and auditable, but it does not make the operator trustless.

## Route worth standardising: mint-enforced conditions

Removing arbiter custody requires an optional mint capability with fail-closed negotiation. Useful precedent exists in Cashu's spending-condition and P2PK locktime/refund work, but this lab does not claim those formats apply directly to LUD-25.

A bilateral bond condition needs at least:

- named secp256k1/Nostr keys;
- explicit threshold and alternative branches;
- signatures committing to both inputs and chosen outputs;
- an absolute setup refund and final timeout;
- unique per-input receiver hashes;
- atomic settlement or a specified partial-failure protocol;
- replay-safe idempotence for the same input/output mutation;
- capability and policy-version negotiation;
- lost-key and federation behaviour;
- a conformance suite covering clock edges and conflicting branches.

Illustrative policy shape only:

```json
{
  "policy": "bilateral-arbiter-v1",
  "contract": "<canonical-offer-id>",
  "inputs": ["party_a_bond", "party_b_bond"],
  "branches": {
    "complete": ["party_a", "party_b"],
    "self_cancel_a": ["party_a"],
    "self_cancel_b": ["party_b"],
    "decision": ["arbiter", "challenge_elapsed"]
  },
  "after": {
    "time": 1780000000,
    "resolution": "refund_original_owners"
  },
  "sigflag": "inputs_and_outputs"
}
```

That is not a proposed wire format. The hard work is consensus over branch semantics, output commitment, federation, clocks, recovery and upgrade safety.

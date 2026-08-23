# Conditional service bonds

## Blunt conclusion

Receiver-locked LNURLcash solves payment delivery. It does not solve conditional escrow.

A plain LUD-25 output is keyed by `sha256(k1)`. Anyone holding `k1` can spend it and nobody else can. There is no second branch saying “the owner may refund after completion”, no signature threshold and no timeout. Giving `k1` to the counterparty transfers the bond immediately. Giving it to a referee creates custody.

## A workable contract

The application state should distinguish outcomes that are cryptographically attributable from outcomes that need judgement. A ride is the worked example here; the same pattern covers deliveries, bookings and contracted work:

| Outcome | Required authority | Rider bond | Driver bond |
| --- | --- | --- | --- |
| Both sign complete | rider + driver | refund rider | refund driver |
| Rider signs self-cancel | rider | forfeit to driver | refund driver |
| Driver signs self-cancel | driver | refund rider | forfeit to rider |
| Both sign mutual cancel | rider + driver | refund rider | refund driver |
| Alleged no-show | arbiter after evidence | policy decision | policy decision |
| Contract setup expires before both fund | timeout | refund funded bond | refund funded bond |

Silence must not be treated as a confession. Otherwise a relay outage, flat battery or crashed app becomes a financial attack.

## Route available now: explicit referee

The demo's referee controls two LNURLcash notes during the ride. It applies the table above and redirects each note into a beneficiary-generated output hash. This is enforceable and easy to audit, but the referee can steal. A federation can reduce single-operator risk but remains a custody system.

DonkeyRide's existing LND HODL provider has the same essential boundary. The operator holds the preimage, may settle the held invoice into its own node, and must then compensate the wronged party. Automatic invoice timeout limits the hold, but does not make outcome selection or the compensation leg trustless.

## Route worth discussing with LNURLcash developers

Add an optional mint-enforced conditional output, advertised before use and rejected by mints that do not understand it. The useful precedent is Cashu's well-known spending-condition secret and P2PK locktime/refund rules, not an invented claim that a hash alone is a smart contract.

A ride bond needs, at minimum:

- signatures from named Nostr/secp256k1 keys;
- a threshold or explicit alternative branches;
- signatures over both inputs and chosen outputs, so an authorised party cannot redirect a valid settlement;
- an absolute refund time;
- fail-closed capability negotiation;
- a canonical contract id binding ride id, parties, amounts, mint, expiry and payout policy;
- atomic settlement and replay-safe mutation records.

One possible policy shape is:

```json
{
  "kind": "P2PK",
  "contract": "<ride-contract-id>",
  "before": {
    "complete": ["rider", "driver"],
    "self_cancel": ["canceller", "arbiter"],
    "dispute": ["party", "arbiter"]
  },
  "after": {
    "time": 1780000000,
    "refund": "original-owner"
  },
  "sigflag": "inputs_and_outputs"
}
```

That is illustrative, not a proposed wire format. The hard work is branch semantics, signature coverage, clock behaviour, lost-key recovery, federation and upgrade safety. It belongs in a separate draft and conformance suite before anybody puts meaningful money into it.

# Use-case matrix

> **Research matrix, not a current product promise.** These outcomes describe the archived custodial state machine. The public build demonstrates only signed enrolment, offer and acceptance evidence; real bonds and forfeiture execution are disabled.

The lab is generic across one deliberately bounded family: two parties each post a whole-sat commitment bond, one arbiter temporarily holds both, and the same fixed policy decides whether each bond returns to its owner or goes to the other party.

| Template | Party A | Party B | What the bonds can demonstrate | What stays outside this rail |
| --- | --- | --- | --- | --- |
| Ride | rider | driver | mutual commitment to one agreed ride | fare calculation, matching, location truth, safety response |
| Delivery | customer | courier | collection/delivery commitment | item value, tracking truth, carrier insurance |
| Booking | guest | provider | attendance and reservation commitment | booking inventory, tax, refunds of the underlying purchase |
| Work | client | contractor | commitment to one bounded job or review | milestones, acceptance criteria, wages or invoice payment |
| Custom | Party A | Party B | another bilateral whole-bond agreement using the exact same policy | bespoke settlement logic hidden in labels or memo text |

The signed wire authority is always `party_a`, `party_b` and `arbiter`. Display labels cannot change settlement. Every template therefore has the same resolution matrix:

- matching completion or mutual cancellation returns both bonds;
- a party's signed self-cancellation forfeits only that party's bond;
- either party may raise a dispute, which takes precedence over ordinary outcomes and freezes both bonds;
- contradictory self-cancellations also become a dispute;
- exactly one arbiter decision may resolve the dispute after it was raised and after the signed delay;
- conflicting arbiter decisions freeze settlement as detectable equivocation;
- setup and unresolved-contract timeouts assign no guilt.

## Honest limit of “generic”

This is not a general smart-contract language. It does not correctly model three or more parties, partial bond awards, staged milestones, recurring commitments, auctions, insurance pools, loans, collateral price changes or automatic real-world facts. Those need a new explicit policy and new signed fields, not a clever template label.

The separate recipient-locked payment flow can demonstrate paying an exact amount. The bilateral policy moves only commitment bonds. It does not silently treat either bond as the fare, purchase price, booking charge or contractor invoice.

That boundary is useful: developers can reuse one reviewed state machine for genuinely equivalent bilateral commitments without pretending it covers unrelated financial products.

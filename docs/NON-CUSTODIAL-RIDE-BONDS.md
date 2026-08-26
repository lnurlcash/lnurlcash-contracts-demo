# Non-custodial ride bonds

The product goal remains useful: rider and driver should make a credible commitment, and a late cancellation should expose the cancelling party to proportionate compensation. The reference design must achieve that without making the platform custodian, judge and payment executor.

## Current boundary

- Direct recipient-owned LNURLcash payments are live. The recipient generates the output secret; the payer and Moneyer never learn it.
- Bilateral enrolment, offer and acceptance messages are live as portable signed evidence.
- Real bond packets, funding acknowledgements, arbiter decisions and settlements are disabled in the public build.
- The earlier `bilateral-arbiter-v2` implementation and one 20-sat completion are retained as protocol research. They prove mechanics, not a lawful or non-custodial product.

## Required settlement primitive

A production candidate needs a mint-enforced output with all of these properties:

1. Neither Moneyer nor the ride operator can spend a participant's bond alone.
2. The participant can recover automatically after an agreed timelock if no valid settlement path executes.
3. The accepted contract fixes the participant keys, maximum exposure, output destinations, evidence policy and deadlines before funding.
4. Ordinary completion and mutual cancellation resolve without a discretionary platform decision.
5. Any discretionary path uses an appropriately authorised independent provider or a threshold in which the platform alone has no control.
6. Conflicting valid signatures, split views and ambiguous mint responses fail closed and remain recoverable.
7. Wallets show the exact maximum exposure and refund deadline before signing or funding.

The current LUD-25 hash lock cannot express that. One entity necessarily knows the spend secret behind a published hash. Adding multiple signatures around a single bearer secret does not make the mint enforce a threshold. The required change belongs at the mint/output protocol layer; see [CONDITIONAL-OUTPUTS-PROPOSAL.md](CONDITIONAL-OUTPUTS-PROPOSAL.md).

## Cancellation recommendation

The public calculator is symmetric and non-executing:

- safety, emergency, force majeure, mutual agreement, or 30+ minutes notice: zero;
- 5–29 minutes notice: lower of evidenced direct loss and 25% of the agreed price;
- under 5 minutes or no-show: lower of evidenced direct loss and 50% of the agreed price.

This is a design hypothesis for legal review, not an entitlement or a finding that either party breached the agreement. It deliberately refuses blanket forfeiture. Real customer terms must define evidence, appeals, accessibility, complaints and exceptions in detail.

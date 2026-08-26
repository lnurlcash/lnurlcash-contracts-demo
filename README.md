# Moneyer protocol lab

Live at [labs.moneyer.dev](https://labs.moneyer.dev).

The public build now has a hard product boundary:

1. A sender can make a real payment to a recipient-generated LNURLcash output hash. Moneyer never knows the recipient's spend secret.
2. Two remote people can create independently signed enrolment, offer and acceptance evidence.
3. The flow stops before custody. Bond packets, funding acknowledgements, arbiter decisions and settlement messages are rejected.
4. A symmetric cancellation calculator recommends a maximum based on notice and evidenced direct loss. It does not decide liability or move money.

This is published protocol research and runnable demo source, not a Moneyer-operated ride, payment or escrow service. An implementer that turns the protocol into a customer service is responsible for that deployment's terms, controls and legal position. See [docs/IMPLEMENTER-BOUNDARY.md](docs/IMPLEMENTER-BOUNDARY.md) and [docs/NON-CUSTODIAL-RIDE-BONDS.md](docs/NON-CUSTODIAL-RIDE-BONDS.md).

## Why the custody path was retired

The earlier `bilateral-arbiter-v2` research made the arbiter custodian of both bearer secrets. Participant signatures constrained the honest client, and beneficiaries kept private payout secrets, but the arbiter could still steal held bonds. A 25-sat funded acceptance completed once: 23 sats were minted after fees, two 10-sat bonds completed and settled, and 20 sats returned. That is useful historical protocol evidence. It is not a non-custodial primitive, so the funded runner has been removed from the public demo.

The underlying protocol modules and tests remain so LNURLcash developers can audit the result and design a mint-enforced replacement. They are not imported into the public application's value path.

## Direct recipient-owned payment

1. The recipient creates a random secret and signs a request containing only its SHA-256 output hash.
2. The sender verifies the request and transfers an exact-value disposable note to that hash.
3. The recipient probes the mint with its private secret and imports the resulting note into a wallet.

The static site receives no request fragment, key or bearer note. Browser JavaScript and extensions can still read local state, so keep demonstrations tiny and rotate received notes into a proper wallet immediately.

## Evidence-only bilateral flow

The wire roles remain `party_a`, `party_b` and `arbiter` for compatibility with the archived research format. On the public site the arbiter is an evidence coordinator only:

- each participant creates their own key and enrolment;
- the coordinator signs one canonical offer;
- each participant verifies and countersigns the exact offer in a separate browser profile;
- signed fragment links can be handed to somebody elsewhere on the internet;
- the public build accepts only `enrolment`, `contract_offer` and `acceptance` message types.

A signature proves which key signed which bytes. It does not prove a ride occurred, identify a person, establish legal liability or prove Lightning settlement.

## Cancellation model

The calculator currently proposes:

- protected reason or at least 30 minutes notice: zero;
- 5–29 minutes: lower of evidenced direct loss and 25% of the agreed price;
- under 5 minutes or no-show: lower of evidenced direct loss and 50% of the agreed price.

Protected reasons are safety, emergency, force majeure and mutual agreement. This is an example protocol policy, not a Moneyer contract term, finding of liability or production tariff. An operator may adopt, change or reject it after assessing its own deployment.

## Develop and verify

Use Node 24.

```bash
npm ci
npm run check
npm run dev -- --host 127.0.0.1 --port 4181
npm run acceptance:browser
```

The browser gate uses three independent profiles, completes the remote signed-evidence ceremony, proves every custody control is absent, visibly rejects a historical bond packet, exercises the proportional and protected cancellation outcomes, and creates a direct recipient-owned request without moving sats. Set `DEMO_ORIGIN=https://labs.moneyer.dev LIVE_MINT=1` to run the same gate against the deployed site and pinned live mint discovery.

## Security and release boundaries

- Only `https://mint.forgesworn.dev` is allowlisted, with a pinned signing key.
- Direct transfers are capped at 500 sats and require exact-value disposable notes.
- Fragment links are not sent to the static server, but remain visible to the recipient, browser history, extensions and screenshots.
- Mutation calls are never retried automatically after an ambiguous response.
- Stored historical packets are displayed only as retired local state; new packet import is refused.
- The static server must not gain request logging that captures fragments, analytics, mint credentials or write access to the mint.

See [ADVERSARIAL-REVIEW.md](ADVERSARIAL-REVIEW.md), [THREAT-MODEL.md](THREAT-MODEL.md) and [DEPLOY.md](DEPLOY.md) for the audit and release evidence.

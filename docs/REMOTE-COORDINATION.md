# Remote coordination

The contract protocol is transport-agnostic. The static site does not need an account system, matching server or WebSocket connection for one person to pay another.

## What works in this build

1. The recipient creates and signs a receiver-locked request on its own device.
2. The site packages that request into a URL fragment.
3. The recipient sends the link through an existing authenticated channel.
4. The payer opens it in another browser, verifies the amount, mint, signer fingerprint and contract id, then spends an exact-value disposable note.
5. The recipient probes its secret at the mint. No receipt from the payer is needed to decide whether the output exists.

The same hand-off funds each referee-held bond. The fragment is client-side and is not included in the HTTP request to the static host. It is still visible to the person receiving it, the transport, browser history, extensions and screenshots. It is contract data, not a bearer spend secret.

## What does not work remotely yet

The worked bond outcome screen generates the rider, driver and referee identities in one browser. That is an inspectable state-machine demo, not proof of remote identity enrolment or remote adjudication.

The next protocol slice is:

1. Rider and driver each generate or select a signing key on their own device.
2. Their public keys are exchanged over an authenticated channel.
3. The referee signs a contract containing both participant keys, its own key, both bond amounts, the mint identity, expiry and outcome rules. The current request format now binds those keys, but the public-key exchange is not yet implemented.
4. Each participant countersigns its commitment before funding.
5. Both funded outputs are independently visible before the contract becomes active.
6. Completion requires both participant signatures. Self-cancellation requires the cancelling participant's signature. Silence creates a dispute and moves nothing.
7. Signed outcome messages return to the referee by copy/paste, a fragment link, NIP-59 gift wrap or another transport.

This must pass with three clean browser profiles, no shared local storage and relays disabled after message delivery. A relay delivers messages; it does not decide contract truth.

## “Away from us” has two meanings

The host is not a coordinator or custodian in this design, but a browser still trusts the code it downloads. A compromised host could replace the JavaScript and read a pasted bearer note. The public lab therefore needs:

- a tiny hard value cap;
- no analytics, third-party scripts or remote assets;
- a strict Content Security Policy;
- published source, release commit and production asset hashes;
- an immutable downloadable build for independent verification;
- the existing mint allowlist and pinned signing key kept current through an explicit rotation procedure;
- ultimately, wallet-mediated spending approval so the page never receives `k1`.

Until the wallet-mediated path exists, this is a real-value protocol demonstration, not a sensible place for meaningful balances.

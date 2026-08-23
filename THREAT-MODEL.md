# Threat model

## Assets

- Every LNURLcash `k1` in browser storage or a pasted note. Whoever learns it owns that note.
- Receiver secrets generated before a request is published. Losing one after its hash is funded destroys access to the output.
- The two parties' and referee's Nostr keys. They attribute requests and self-cancellation; they do not custody a direct payment by themselves.

## What the direct payment defends against

- **Sender double-spend:** the sender sends a rotate to `h = sha256(recipient_secret)`. The sender never learns `recipient_secret`.
- **Forged amount, mint or output:** they are inside a signed Nostr event. The payer refuses any tag/body mismatch.
- **Fake success receipt:** the driver checks its secret directly against the mint and uses the mint's authoritative `maxWithdrawable`.
- **Replay:** the payer's input is burned atomically. The demo requires a hardened mint that records burns permanently and never reissues a burned output id; the current LUD-25 draft does not yet say that clearly enough.
- **Ambiguous HTTP outcome:** the payer reports “receiver must probe”, never “failed”. Mutation retries are unsafe on mints that do not replay identical requests idempotently.

## What the referee-backed bond defends against

- **A party cancelling and keeping its bond:** the referee already controls the bond output.
- **A party blaming the other:** automatic cancellation is a signed self-cancellation. A body field saying “the other person did it” has no authority.
- **One party failing to commit:** the ride does not become bonded until both outputs are independently visible at the mint.
- **A party denying it funded:** the output exists under the referee's secret and may carry the mint's signature over its hash and amount.

## What it does not defend against

- **A malicious referee:** it can spend both bonds. This is custody, not escrow by magic.
- **A malicious mint:** the mint holds the backing sats and can refuse redemption or disappear. A signature proves issuance, not solvency.
- **A compromised site:** JavaScript running at this origin can read browser-held secrets. Use tiny disposable notes. Production wallets must own the secrets outside DonkeyRide.
- **No-show truth:** GPS is spoofable, phones go flat and relays fail. A disputed no-show requires an agreed arbiter or a protocol-defined oracle.
- **Provider price fraud:** the customer must see and approve the final signed amount. The payment rail cannot decide whether a fare, delivery fee or job total was fair.
- **Traffic analysis:** the mint sees note timing and linkage. NIP-59 hides request contents from relays, not from the mint handling the notes.
- **Shared-link metadata:** a URL fragment is not sent to the static web server, but it is visible to the recipient, the channel carrying the link, browser history, extensions and screenshots. It contains contract metadata, not a spend secret.
- **Remote outcome impersonation:** the current one-browser outcome inspector is not evidence of remote participant enrolment. A public bond pilot must bind rider and driver keys during setup and import their signed outcome events from separate devices.
- **Host supply-chain attack:** a static host does not receive URL fragments, but it serves code that can read the page. A compromised deployment could exfiltrate a pasted `k1`. Publish source and asset hashes, keep the hard value cap, and move spending approval into a wallet before using meaningful value.
- **Valid signature, wrong person:** a Nostr signature proves control of its key, not that the key belongs to the intended counterparty. Compare the signer fingerprint over an authenticated channel and bind participant keys into the contract.
- **Receiver-selected mint:** a signed request can honestly name a hostile mint. The public demo must allowlist mints and pin keys; displaying the hostname is not enough for ordinary users.

## Operational rules

- Maximum 500 sats per demo transfer.
- Exact-value notes only; no hidden overpayment or change calculation.
- Persist every receiver secret before disclosing its hash.
- Never log, report or put a note URL into analytics.
- Never call a mutation failure merely because its response was lost.
- Never settle a cancellation against silence alone.

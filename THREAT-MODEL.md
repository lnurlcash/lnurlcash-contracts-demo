# Threat model

## Assets and authorities

- Every LNURLcash `k1` in browser storage or pasted into the page. Whoever learns it owns that note.
- Recipient and arbiter receiver secrets generated before their hashes are published. Losing one after funding can destroy access.
- Four private payout secrets per contract, two in each participant browser. Losing one can strand its corresponding settlement leg.
- Party A, Party B and arbiter Nostr keys. They attribute protocol messages but do not make a real-world identity true.
- The canonical offer, two acceptances, two bond requests and their exact bond-set hash.

## Direct payment defences

- **Sender reclaim:** the sender rotates into `sha256(recipient_secret)` and never learns the secret.
- **Changed amount, mint or output:** the signed body and exact tag list must agree.
- **Hidden overpayment:** the live note must equal the signed value exactly.
- **Fake payer receipt:** the recipient probes its secret directly at the mint.
- **Ambiguous mutation:** the page says the recipient must probe and does not retry or call it failed.
- **Callback substitution:** the callback must stay on the pinned mint host before any bearer secret is sent.

## Bilateral commitment defences

- **Arbiter invents parties:** each party key arrives in a signed enrolment and independently countersigns the complete offer.
- **Display-label authority:** settlement uses `party_a`, `party_b` and `arbiter`; rider, courier or client are signed display labels only.
- **Arbiter substitutes terms:** both acceptances bind the exact offer event id.
- **Arbiter substitutes payout:** each acceptance binds two private per-source output hashes. All four contract targets must differ.
- **Anonymous donation activates a party:** activation also requires a funding acknowledgement from the exact named payer key.
- **Payer claims funding without value:** the arbiter must independently find the exact output at the mint.
- **Party frames the other as canceller:** self-cancellation must come from the self-cancelling key.
- **One party claims completion:** completion and mutual cancellation need matching statements from both keys.
- **Cross-contract replay:** every post-offer message binds the offer id and exact pair of bond request ids.
- **Contradictory self-cancellation:** conflicting admissions become a dispute rather than a terminal state, so a decision or a bilateral agreement can still resolve them.
- **Silence treated as guilt:** setup and contract timeout refund without assigning fault. A dispute requires attributable judgement.
- **Instant arbiter judgement:** decisions carry a reason and evidence hash and wait through the signed challenge period.
- **Permanently frozen value:** every reachable state has an exit. An unresolved dispute refunds both sides one challenge period after settlement expiry, because no further signed authority can exist by then.
- **Partial setup grief:** every funded but unactivated side can be refunded after setup expiry, even if an anonymous donor funded both hashes.
- **Two outputs collide:** every beneficiary/source pair has a unique output hash.
- **Ambiguous first settlement leg:** the journal pins its original target. A beneficiary who privately finds it can sign an acknowledgement so the remaining leg resumes.
- **Tab race:** cross-context Web Locks and durable journals serialise money movement.
- **Storage field substitution:** requests, packets, authority, held notes and settlement journals are revalidated before use.

## Not defended

- **Malicious arbiter:** it knows both held secrets and can steal before settlement. This is custody.
- **Malicious mint:** it holds the backing sats and can steal, censor, link users, lie about liabilities or disappear.
- **Compromised site or extension:** delivered JavaScript can read any note or key available to the page.
- **Wrong human behind a valid key:** participants must compare fingerprints over an authenticated channel.
- **Objective no-show truth:** GPS is spoofable and silence is indistinguishable from outage or device failure.
- **Dishonest evidence or bribed decision:** evidence hashes make a decision attributable, not correct.
- **Provider price or service-quality fraud:** the payment rail cannot decide whether signed commercial terms were fair or performed well.
- **Traffic analysis:** the mint sees note linkage and timing. A relay or messenger sees its own metadata.
- **Endpoint metadata:** fragments are absent from HTTP requests but visible to the receiving endpoint, browser history, extensions and screenshots.
- **Key loss:** this static lab has no encrypted backup or social recovery.
- **Mint non-idempotence after non-receipt:** the lab will not automatically retry an ambiguous mutation when the beneficiary finds nothing.

## Operational rules

- Maximum 500 sats per transfer.
- Exact-value disposable notes only.
- Persist receiver and payout secrets before publishing their hashes.
- Never put `k1` or a payout secret into a contract message, URL or log.
- Never treat a funding acknowledgement as proof of mint value.
- Never treat a mint output as proof that the named party funded it.
- Never settle against silence alone.
- Never replace an ambiguous settlement target.
- Refuse money movement without cross-context Web Locks.
- Keep the arbiter-custody label visible until custody actually changes.

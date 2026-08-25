# Remote coordination

The protocol is transport-agnostic. The static site has no account system, matching server, coordinator API or WebSocket dependency.

## Demonstrated across three clean profiles

1. Party A creates only its Party A key and signed enrolment.
2. Party B creates only its Party B key and signed enrolment.
3. The arbiter creates only its arbiter key, imports both enrolments and signs one canonical offer.
4. Each party opens that offer independently, verifies its terms and countersigns it with two private per-source payout hashes.
5. The arbiter imports both acceptances, generates its two held-output secrets and shares a full packet containing every signed component.
6. Each participant revalidates the packet and can fund only the request naming its key.
7. Funding acknowledgements return to the arbiter, which independently probes both outputs before activation.
8. Participants sign portable completion, mutual-cancel, self-cancel or dispute statements on their own devices.
9. The arbiter imports rather than synthesises those statements. A disputed decision is signed separately and challenge-delayed.
10. Settlement notices return to beneficiaries. Each beneficiary probes a secret that never left its browser and signs a payout acknowledgement.

The automated browser ceremony asserts that the Party A profile contains only its Party A identity, Party B contains only Party B, and the arbiter contains only the arbiter identity. It also asserts that the four payout targets are distinct, the arbiter store contains no beneficiary payout secrets, a locally corrupted payout secret blocks packet import, and an imported dispute freezes an otherwise executable pair of completion statements.

The real-sat funding and settlement lifecycle still needs disposable-note acceptance across those same profiles. Protocol ceremony evidence is not settlement evidence.

## Fragment transport

The site can copy an offer, acceptance, packet or outcome into a URL fragment. Browsers do not include that fragment in the HTTP request, and the acceptance test records outgoing requests to prove the packet stayed client-side.

The fragment remains visible to:

- the person receiving the link;
- the channel carrying it;
- browser history and synchronisation;
- extensions and screenshots.

Contract messages contain public keys, amounts, labels, mint identity, hashes and signatures. They must never contain a bearer note, `k1`, participant private key or payout secret.

Large full packets may exceed limits in some messengers. Copying the raw `cashpacket1` value or carrying it inside NIP-59 avoids depending on URL length, but the NIP-59 transport path is not implemented or field-tested in this repo yet.

## Authentication boundary

A valid enrolment proves control of a Nostr key, not the real-world person controlling it. Before accepting, compare the key fingerprint through an existing authenticated relationship. DonkeyRide could bind those keys to its existing rider/driver conversation; a marketplace could bind them to accounts; a contractor may compare them over an established Signal thread.

That application authentication is deliberately outside the generic payment rail. The signed contract preserves the resulting key choice so it cannot be changed later without new acceptances.

All three people should compare the same offer fingerprint and bond-packet fingerprint in one authenticated shared conversation. Signatures prove who created each fork; they do not magically tell an isolated browser that another device was shown a different valid fork. The client refuses equivocation when both versions reach it, while a production coordinator should add an append-only transcript or gossip path so split views are discoverable.

## Host boundary

The host receives no fragments and keeps no contract database, but every browser trusts the JavaScript it downloads. A compromised origin could read pasted notes, locally stored keys and payout secrets.

The public lab therefore uses:

- a 500-sat hard cap;
- no third-party JavaScript, analytics or remote assets;
- a mint-specific CSP and strict security headers;
- pinned mint endpoint and signing key;
- fingerprinted immutable assets and uncached HTML;
- published deployment hashes;
- a separate v2 store that preserves earlier v1 recovery data.

The next trust reduction is wallet-mediated spending/signing so the page never receives arbitrary bearer notes or long-lived keys. The next custody reduction is mint-enforced conditional outputs or threshold arbitration. Static hosting alone achieves neither.

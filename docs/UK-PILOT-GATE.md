# UK commercial ride-bond gate

Status: **blocked**.

This repository does not authorise a commercial real-money ride-bond pilot in the United Kingdom. The public site may demonstrate direct recipient-owned payments and signed evidence. It must not let Moneyer, DonkeyRide or a reference operator hold both parties' value, decide a forfeiture or execute a payout.

The block remains until all of these are complete:

1. A written opinion from a UK financial-services lawyer identifies the regulatory perimeter for the exact asset, custody, operator, fee and customer journey. It must cover at least the Money Laundering Regulations, the current and announced FSMA cryptoasset regime, the Payment Services Regulations, financial promotions, safeguarding, AML and travel-rule duties, insolvency treatment and tax.
2. UK consumer counsel reviews the complete cancellation schedule, disclosures, safety and force-majeure exceptions, evidence process, accessibility, complaints and ADR route under the Consumer Rights Act 2015 and the common-law penalty doctrine.
3. The implementation removes unilateral operator control. A reference operator must not possess a secret or credential capable of moving either participant's bond.
4. The mint or an authorised third party enforces the accepted conditions, threshold and automatic refund timelock. Client-side promises and signed Nostr events are not enough.
5. An independent security assessment covers malicious but valid signatures, split views, lost responses, key compromise, replay, recovery, mint failure and customer data.
6. The approved product, customer terms and technical build match. A tiny cap, a beta label or calling the operator an “arbiter” does not replace this gate.

Current official perimeter sources:

- [FCA: who needs to register for cryptoasset services](https://www.fca.org.uk/firms/cryptoassets/who-needs-register)
- [FCA: new regime for cryptoasset regulation](https://www.fca.org.uk/firms/new-regime-cryptoasset-regulation)
- [FCA PERG 15.5: escrow and payment services](https://handbook.fca.org.uk/handbook/PERG/15/5.html)
- [Consumer Rights Act 2015](https://www.legislation.gov.uk/ukpga/2015/15/contents)
- [CMA: writing fair contracts for customers](https://www.gov.uk/guidance/writing-a-fair-contract-for-customers)

This is an engineering release gate, not legal advice. Any material change to the asset, control model, operator, jurisdiction, price or customer type requires the opinion to be refreshed.

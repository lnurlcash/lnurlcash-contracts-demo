# Protocol publisher and implementer boundary

Status: **protocol research and developer demonstration**.

Moneyer publishes source code and hosts a static demonstration. It does not
operate a ride service or escrow service through this lab. It does not open
participant accounts, receive fees, hold participant keys or funds, contract as
either party, decide real disputes or execute bilateral bond forfeitures.

The live direct-payment example sends value to an output controlled by the
recipient's browser. Moneyer never receives the spend secret and is not in the
payment path. The bilateral example publishes signed-message mechanics and
stops before bond funding or settlement.

That publisher role is different from an implementer operating the protocol as
a customer service. A deployment-specific assessment becomes relevant when an
implementer chooses, for example, to:

- match riders and drivers or contract with customers as a business;
- hold keys, deposits or bearer instruments for participants;
- execute, redirect or retain participant funds;
- decide disputes or impose contractual cancellation charges;
- charge fees for payment, custody or escrow activity; or
- describe itself as safeguarding customer value.

Those choices belong to the implementer, not to the protocol. The implementer
is responsible for its jurisdiction, business model, customer terms, consumer
protections, security controls and any authorisation or registration it needs.
Publishing or running this developer demo does not make Moneyer the implementer's
operator, escrow provider or legal adviser.

## Why the public demo remains non-custodial

The earlier `bilateral-arbiter-v2` experiment gives one arbiter both bearer
secrets. Signed messages make the arbiter's actions attributable but cannot stop
it stealing the inputs. The public demo therefore keeps that code as auditable
research while excluding it from the active value path. This is a protocol and
security boundary, not a claim that publishing custodial research is unlawful.

## UK sources behind the distinction

The UK Payment Services Regulations exclude technical service providers that
support payment services without ever possessing the funds, subject to the
scope and exceptions in the Regulations. FCA perimeter guidance likewise
distinguishes technical processing and infrastructure from a business that
holds funds in escrow pending specified conditions.

- [Payment Services Regulations 2017, Schedule 1 Part 2 paragraph (j)](https://www.legislation.gov.uk/uksi/2017/752/pdfs/uksi_20170752_en.pdf)
- [FCA PERG 15.3: acquiring and technical services](https://handbook.fca.org.uk/handbook/perg15/perg15s3?timeline=true)
- [FCA PERG 15.5: technical providers and escrow](https://handbook.fca.org.uk/handbook/perg15/perg15s5?timeline=true)
- [Consumer Rights Act 2015](https://www.legislation.gov.uk/ukpga/2015/15/contents)

This document records the architecture and intended publisher role. It is not
legal advice and does not decide the position of a future deployment.

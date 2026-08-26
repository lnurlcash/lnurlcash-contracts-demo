# Deploying `labs.moneyer.dev`

## Current external state

- `labs.moneyer.dev` has an A record for `2.29.14.244`.
- `https://labs.moneyer.dev` is live; plain HTTP redirects to HTTPS.
- Release commit: `57dfa3e18759`.
- Static release: `/opt/moneyer-labs/releases/20260826T075341Z-57dfa3e18759`.
- Live symlink: `/opt/moneyer-labs/current`.
- Caddy configuration unchanged at this release; the live `labs.moneyer.dev` vhost is byte-identical to `deploy/labs.moneyer.dev.Caddyfile`, so no reload was performed.
- Immediate static rollback: `/opt/moneyer-labs/releases/20260825T183513Z-da725a46c12c`.

The public files verified byte-for-byte after deployment:

```text
9e87843e29b142501c911384ae7221feccb24602bd17918d62d39b0a682bfbbc  index.html
2c16fbbcace9e2853d4aa125e24443d77ed8c92fb010e2fb4ea9035ac9ef2dcb  favicon.svg
6f3517ee9ac05103bdd2bb5b0223acf4a2baac0d573e5ed617c6f5f40a833c4d  assets/index-BUoIhlzZ.css
5f1ef8b8d189d42d33d9b1ed99d8fa0b5e8ed89e6d9eacf7b3ed93f1bcc6a829  assets/index-CBHWtSp6.js
```

This release carries `bilateral-arbiter-v2`. It passed a clean Node 24 `npm ci`, 76 tests, the production build and dependency audit with no advisories. The application bundle is intentionally byte-identical to the prior release because this change adds reproducible acceptance rather than new client behaviour. After the atomic switch, all four asset hashes were confirmed byte-for-byte through public DNS and directly against the origin, and the certificate and security headers were re-checked.

The repository-owned browser gate then passed both locally and against the public HTTPS origin. Its separate-profile ceremony used live pinned mint discovery and added duplicate-delivery idempotence, a missing-prerequisite refusal, reordered decision recovery and a portable arbiter decision to the earlier packet, continuity, dispute, tamper and secret-isolation checks. The hostile-mint matrix refused callback and signing-key substitution, spent-note replay, malformed and oversized bodies and a provably unsendable callback; it recovered an applied mutation with a lost response and made zero automatic mutation retries. Finally, a stateful mock lifecycle carried two exact simulated bonds through acknowledgements, arbiter probes, bilateral completion, an ambiguous first settlement leg, beneficiary acknowledgement, reconciliation and the resumed second leg across three profiles. Every browser run reported zero console errors.

A separate guarded acceptance then completed the normal path with real value against `https://labs.moneyer.dev`. A 25-sat Lightning invoice minted 23 sats into an isolated encrypted Notecase wallet. Two persistent participant profiles committed 10 sats each; the arbiter profile independently verified both held outputs; both participants signed completion; both settlement legs confirmed; both beneficiaries probed and acknowledged their private outputs; and the runner recovered the full 20 sats. An independent wallet check then found 21 live sats and verified all three live notes at the mint. The 4-sat difference from the Lightning payment was the 2-sat minting fee plus two 1-sat exact-value split fees.

This is real-sat evidence for one normal-completion lifecycle, not for the whole policy matrix. Both self-cancellations, mutual cancellation, setup timeout, contract timeout, dispute decision and ambiguous first/second-leg recovery still require separate real disposable-note runs. The hostile and stateful mock gates continue to prove those client behaviours only with simulated liabilities.

## Static release layout

```text
/opt/moneyer-labs/
  current -> releases/<UTC timestamp>/
  releases/
    <UTC timestamp>/
      index.html
      favicon.svg
      assets/
```

Caddy serves only the built `dist/` directory. The exact vhost is versioned at [`deploy/labs.moneyer.dev.Caddyfile`](deploy/labs.moneyer.dev.Caddyfile). It points only at the atomic `current` symlink, applies the mint-specific CSP and disables caching for HTML while allowing immutable caching for Vite's fingerprinted assets.

HTML should revalidate. Fingerprinted assets may be cached immutably. Do not add analytics, remote scripts, request logging that includes fragments or a service worker with automatic retry behaviour.

## Release gate

1. `npm ci` and `npm run check` on Node 24.
2. Record SHA-256 for `dist/index.html`, CSS, JavaScript and favicon.
3. Copy to a new staging directory on the host; never build with production credentials present.
4. Validate Caddy configuration before reload.
5. Atomically switch the static root. Reload Caddy only when its validated configuration changed.
6. Confirm the certificate, headers, asset hashes and desktop/mobile rendering from outside the server.
7. Run `DEMO_ORIGIN=https://labs.moneyer.dev LIVE_MINT=1 npm run acceptance:browser` against the public origin.
8. Keep any further real-sat outcome experiment tiny, isolated and disposable; preserve funded profiles after interruption and reconcile the existing contract rather than retrying with different notes.

Keep a timestamped copy of the previous static directory for rollback. The deployment must not share write permissions with the mint process or expose any mint database, environment or Lightning credentials.

# Deploying `labs.moneyer.dev`

## Current external state

- `labs.moneyer.dev` has an A record for `2.29.14.244`.
- `https://labs.moneyer.dev` is live; plain HTTP redirects to HTTPS.
- Release commit: `da725a46c12c`.
- Static release: `/opt/moneyer-labs/releases/20260825T183513Z-da725a46c12c`.
- Live symlink: `/opt/moneyer-labs/current`.
- Caddy configuration unchanged at this release; the live `labs.moneyer.dev` vhost is byte-identical to `deploy/labs.moneyer.dev.Caddyfile`, so no reload was performed.
- Immediate static rollback: `/opt/moneyer-labs/releases/20260824T095834Z-586b16adb377`.

The public files verified byte-for-byte after deployment:

```text
9e87843e29b142501c911384ae7221feccb24602bd17918d62d39b0a682bfbbc  index.html
2c16fbbcace9e2853d4aa125e24443d77ed8c92fb010e2fb4ea9035ac9ef2dcb  favicon.svg
6f3517ee9ac05103bdd2bb5b0223acf4a2baac0d573e5ed617c6f5f40a833c4d  assets/index-BUoIhlzZ.css
5f1ef8b8d189d42d33d9b1ed99d8fa0b5e8ed89e6d9eacf7b3ed93f1bcc6a829  assets/index-CBHWtSp6.js
```

This release carries `bilateral-arbiter-v2`. It passed a clean Node 24 `npm ci`, 75 tests, the production build and dependency audit with no advisories. After the atomic switch, all four asset hashes were confirmed byte-for-byte through public DNS and directly against the origin, the superseded bundle returned 404, and the certificate and security headers were re-checked.

The repository-owned hostile browser ceremony then passed against the public HTTPS origin and live pinned mint discovery: three isolated profiles, neutral delivery labels, two enrolments, two independent acceptances, four unique payout targets, full packet revalidation, no fragment leakage, local payout-secret continuity refusal, three portable outcome signatures, dispute precedence, activation refusing to move without money, no beneficiary secrets in arbiter storage, tamper refusal and zero console errors. The ceremony moved no sats. The disposable-note funding and settlement matrix remains an explicit gate in `ADVERSARIAL-REVIEW.md`.

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
8. Move no real sats until the remaining lifecycle gates in `ADVERSARIAL-REVIEW.md` are satisfied, and keep every pre-production experiment tiny and disposable.

Keep a timestamped copy of the previous static directory for rollback. The deployment must not share write permissions with the mint process or expose any mint database, environment or Lightning credentials.

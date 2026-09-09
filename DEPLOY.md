# Deploying `labs.moneyer.dev`

## Current external state

- `labs.moneyer.dev` has an A record for `2.29.14.244`.
- `https://labs.moneyer.dev` is live; plain HTTP redirects to HTTPS.
- Release commit: `64c8542009cb`.
- Static release: `/opt/moneyer-labs/releases/20260909T190045Z-64c8542009cb`.
- Live symlink: `/opt/moneyer-labs/current`.
- Caddy configuration DID change at this release and was reloaded, not
  restarted. The `connect-src` in the `labs.moneyer.dev` vhost moved from
  `https://mint.forgesworn.dev` to `https://moneyer.dev` and now matches
  `deploy/labs.moneyer.dev.Caddyfile` again. Validate with
  `/usr/local/bin/caddy-ratelimit`, never `/usr/bin/caddy`: the plugin build
  is what a systemd drop-in actually runs, and the packaged binary rejects a
  valid Caddyfile because it lacks the rate-limit module. The previous
  Caddyfile is kept on the host as `/etc/caddy/Caddyfile.bak-20260909T190045Z`.
- Immediate static rollback: `/opt/moneyer-labs/releases/20260831T135202Z-747841d1b112`.

Why this release exists: `mint.forgesworn.dev` sunset on 2026-08-27 and
refuses to mint, so the lab's only allowlisted mint could no longer issue the
exact-value note its flow needs. The lab now allowlists `moneyer.dev`.

The public files verified byte-for-byte after deployment:

```text
2bc00e5f409402b142c385ff77c8e5597c3daa1803a45f2bfe7a5510c0369f9e  index.html
2c16fbbcace9e2853d4aa125e24443d77ed8c92fb010e2fb4ea9035ac9ef2dcb  favicon.svg
605e92b0a23b293e2c542964f0103614542c0c0c67bb61919ea07a593d3867c4  assets/index-CRR9bfEb.css
3f42af7670e867c791060d71ef1ca14383ac8ac8c110635bdc5028ae6e3c89cf  assets/index-DLinxvlF.js
```

This release keeps the public `bilateral-arbiter-v2` custody and settlement path retired and corrects the publisher/service framing. It passed 94 tests and the Node 24 production build. The public bundle accepts only signed enrolment, offer and acceptance evidence; it contains no bond-funding, outcome-decision or settlement controls. Historical packet import is refused. The page identifies Moneyer as the publisher of protocol research and static demo source, not the operator of a ride, payment or escrow service, and assigns deployment-specific terms and legal assessment to whoever operates an implementation.

The repository-owned browser gate passed locally and against the public HTTPS origin with live pinned mint discovery. Three isolated profiles produced two enrolments and two independent acceptances; the publisher/implementer boundary was visible and the retired blanket UK block was absent; the page exposed zero bond-funding and zero settlement controls; a historical custodial packet was visibly refused; the cancellation calculator rendered both the evidenced-loss cap and a zero safety outcome; and a direct recipient-owned request remained available. The hostile-mint matrix refused callback and signing-key substitution, spent-note replay, malformed and oversized bodies and a provably unsendable callback; it recovered an applied mutation with a lost response and made zero automatic mutation retries. Both public browser runs reported zero console errors and `realSatsMoved: false`.

The earlier 25-sat funded run remains useful historical protocol evidence: 23 sats were minted, two 10-sat bonds completed and settled, and 20 sats returned. Its runner has been removed from the public release. That run does not establish non-custodial operation, a cancellation entitlement, physical-world truth or the legal position of any future operator.

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
8. Do not run another real bond-funding experiment from the public site. Any direct recipient-owned payment test must remain tiny, isolated and disposable.

Keep a timestamped copy of the previous static directory for rollback. The deployment must not share write permissions with the mint process or expose any mint database, environment or Lightning credentials.

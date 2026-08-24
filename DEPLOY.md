# Deploying `labs.moneyer.dev`

## Current external state

- `labs.moneyer.dev` has an A record for `2.29.14.244`.
- `https://labs.moneyer.dev` is live; plain HTTP redirects to HTTPS.
- Release commit: `586b16adb377`.
- Static release: `/opt/moneyer-labs/releases/20260824T095834Z-586b16adb377`.
- Live symlink: `/opt/moneyer-labs/current`.
- Caddy configuration unchanged at this release; the live `labs.moneyer.dev` vhost is byte-identical to `deploy/labs.moneyer.dev.Caddyfile`, so no reload was performed.
- Immediate static rollback: `/opt/moneyer-labs/releases/20260823T101650Z-383968ff110e`.

The public files verified byte-for-byte after deployment:

```text
2f7faebccfcfe686fe76c72516b62c47f8aabe01c0eb232779fa1eedd2aa5faf  index.html
2c16fbbcace9e2853d4aa125e24443d77ed8c92fb010e2fb4ea9035ac9ef2dcb  favicon.svg
6f3517ee9ac05103bdd2bb5b0223acf4a2baac0d573e5ed617c6f5f40a833c4d  assets/index-BUoIhlzZ.css
ca547df131ee4d93a2eff02d3b527299eca4beff8d6cca7496a3f28d41798285  assets/index-D_FHp-bw.js
```

This release carries `bilateral-arbiter-v2`. It passed `npm ci` with no advisories, 56 tests, the production build, and a five-round independent security review whose findings are recorded in the commits between `3fe6925` and `586b16a`. After the switch, all four asset hashes were confirmed byte-for-byte from outside the origin, the superseded bundle returned 404, the certificate and every security header were re-checked, and the page rendered with no console errors and no request to any host other than `labs.moneyer.dev`.

The three-profile remote ceremony and the disposable-note funding and settlement matrix have **not** been re-run against this release. They remain explicit acceptance gates in `ADVERSARIAL-REVIEW.md`, and this release changed settlement authority, so move no sats through it until they are satisfied.

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
7. Run the separate-browser hand-off smoke against the public origin.
8. Move no real sats until the remaining lifecycle gates in `ADVERSARIAL-REVIEW.md` are satisfied, and keep every pre-production experiment tiny and disposable.

Keep a timestamped copy of the previous static directory for rollback. The deployment must not share write permissions with the mint process or expose any mint database, environment or Lightning credentials.

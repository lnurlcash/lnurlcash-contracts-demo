# Deploying `labs.moneyer.dev`

## Current external state

- `labs.moneyer.dev` has an A record for `2.29.14.244`.
- `https://labs.moneyer.dev` is live; plain HTTP redirects to HTTPS.
- Release commit: `383968ff110e`.
- Static release: `/opt/moneyer-labs/releases/20260823T101650Z-383968ff110e`.
- Live symlink: `/opt/moneyer-labs/current`.
- Pre-deployment Caddy backup: `/etc/caddy/Caddyfile.bak-labs-20260823T090338Z-7fcfa3069746`.
- Immediate static rollback: `/opt/moneyer-labs/releases/20260823T090338Z-7fcfa3069746`.

The public files verified byte-for-byte after deployment:

```text
b6b22ba07f0541282b8ad9aca53117fb39d9c9702b25907cf74550e7d9435837  index.html
2c16fbbcace9e2853d4aa125e24443d77ed8c92fb010e2fb4ea9035ac9ef2dcb  favicon.svg
6f3517ee9ac05103bdd2bb5b0223acf4a2baac0d573e5ed617c6f5f40a833c4d  assets/index-BUoIhlzZ.css
9b80b8c94d4da060e52461a3abc946894938c41648611b58feef4b3a3d8f308a  assets/index-D-S_i_Gq.js
```

The v2 release passed 46 tests, the production build, dependency audit, public-DNS and direct-origin HTTPS checks, and the three-profile remote ceremony against the live mint discovery endpoint. That ceremony moved no sats; the disposable-note funding and settlement matrix remains an explicit acceptance gate in `ADVERSARIAL-REVIEW.md`.

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

# Deploying `labs.moneyer.dev`

## Current external state

- `labs.moneyer.dev` has an A record for `2.29.14.244`.
- `https://labs.moneyer.dev` is live; plain HTTP redirects to HTTPS.
- Release commit: `7fcfa3069746`.
- Static release: `/opt/moneyer-labs/releases/20260823T090338Z-7fcfa3069746`.
- Live symlink: `/opt/moneyer-labs/current`.
- Pre-deployment Caddy backup: `/etc/caddy/Caddyfile.bak-labs-20260823T090338Z-7fcfa3069746`.

The public files verified byte-for-byte after deployment:

```text
29d3665d07bfd6ca519b5b85c989b707d91c56078e3b213e32382819eb69c904  index.html
2c16fbbcace9e2853d4aa125e24443d77ed8c92fb010e2fb4ea9035ac9ef2dcb  favicon.svg
7b77b68435db38ecf1f902d862864d0fda3bbe9cdf2874c27f596051aafb5116  assets/index-CzzKfjsL.css
eeb819d3613fa2878e63f46f679182d41a0ddf8cf18f77a8265c5b45eee8b85d  assets/index-DNN3R7Ju.js
```

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
5. Atomically switch the static root and reload Caddy.
6. Confirm the certificate, headers, asset hashes and desktop/mobile rendering from outside the server.
7. Run the separate-browser hand-off smoke against the public origin.
8. Move no real sats until the remote-identity gates in `ADVERSARIAL-REVIEW.md` are satisfied or the site is labelled as the single-browser inspector it currently is.

Keep a timestamped copy of the previous static directory for rollback. The deployment must not share write permissions with the mint process or expose any mint database, environment or Lightning credentials.

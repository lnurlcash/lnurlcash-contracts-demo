# Deploying `labs.moneyer.dev`

## Current external state

- `labs.moneyer.dev` has an A record for `2.29.14.244`.
- Plain HTTP reaches Caddy and redirects to HTTPS.
- HTTPS currently fails during the TLS handshake because the host has not yet been added as a served site.
- No application files or Caddy configuration have been changed by this project yet.

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

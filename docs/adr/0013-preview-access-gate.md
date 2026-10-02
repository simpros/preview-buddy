# Preview access gate (`preview.auth`)

**Status:** accepted, implemented.

Previews are open by design, so sharing one preview means gating one
preview: `preview.auth` (`none` default, `basic`, `link`) attaches a
per-preview Traefik middleware to the app router only. Companion
services are never double-gated, and reset/reseed/teardown bypass the
gate because they act through the gateway and the forge, not the gated
host.

The gate is gateway-native. An external forward-auth service was tried
and abandoned for two structural reasons: there is no Cloudflare-free
path from the preview edge to that service, and every Cloudflare path
rewrites `X-Forwarded-Host`, so the service rebuilt its URL from the
header, took its self-request shortcut, and authorised everything. The
`link` forwardAuth address is therefore the gateway's in-network name,
which the operator configures as `SPROUT_PREVIEW_AUTH_ADDRESS` next to
the token-signing root `SPROUT_PREVIEW_AUTH_SECRET` (partial sets fail
boot).

Two postures, two mechanisms. `basic` is a gateway-generated credential
enforced by Traefik's `basicAuth` middleware with the htpasswd entry
inline in the label — there is no volume shared with Traefik for a file,
so a file path would be fiction. `link` is a token (repository, PR id,
expiry, per-preview version, HMAC-signed) consumed at
`/__sprout/auth?t=` on the preview's own host: the forwardAuth handler
answers that path with a `302` plus a host-scoped cookie, and checks the
cookie or Basic credentials on every other request. Revocation rotates
the per-preview version, which invalidates outstanding links with no
redeploy; basic password rotation lands on the next deploy because the
hash is label-embedded.

Wire contract: by default the app receives no identity header at all —
the gate either keeps traffic out or passes it through unmodified. This
adds no app env and changes no injection names, so the preview wire
grammar is unchanged.

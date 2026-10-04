# Operator helpers for a single Let's Encrypt wildcard on the preview domain.
# See docs/operator-deploy.md § "Wildcard preview certificate (DNS-01)".
#
# Files:
#   certificates-resolver.dns.yml   — dnsChallenge body (default: convert in
#                                     place under existing resolver name;
#                                     coexistence: copy under a new key with
#                                     distinct storage)
#   wildcard-bootstrap.compose.yml  — temporary router to order the wildcard once
#                                     (required env via `${VAR:?…}`).
#                                     Prefer SPROUT_TRAEFIK_WILDCARD_TLS=true instead:
#                                     preview routers then declare the same
#                                     wildcard-main + apex-SAN domain set per
#                                     suffix, so the resolver orders and renews
#                                     one wildcard per preview suffix with zero
#                                     hand-bootstrapped certificates to keep in sync.
#                                     See docs/operator-deploy.md § "Wildcard preview
#                                     certificate (DNS-01)" (opt-in wildcard mode).
#
# All values are placeholders. Fill DNS provider credentials and Traefik paths
# from your environment — never commit secrets.

/** Resolve gateway base URL from CLI env (spec: `PBUDDY_URL`). */
export function resolveGatewayUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.PBUDDY_URL?.trim();
  return url && url.length > 0 ? url : "http://127.0.0.1:7331";
}

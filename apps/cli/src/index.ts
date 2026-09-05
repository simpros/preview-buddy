#!/usr/bin/env bun
import { createApiClient } from "@preview-buddy/api-client";
import { resolveGatewayUrl } from "./gateway-url.ts";

const baseUrl = resolveGatewayUrl();
const [command = "health"] = process.argv.slice(2);

const client = createApiClient(baseUrl);

if (command === "health") {
  const response = await client.healthz.get();
  if (response.error) {
    console.error(response.error);
    process.exit(1);
  }
  console.log(JSON.stringify(response.data));
  process.exit(0);
}

console.error(`unknown command: ${command}`);
process.exit(1);

import { configSummary, loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const config = loadConfig();
console.log("preview-buddy starting", configSummary(config));
startServer({ config });

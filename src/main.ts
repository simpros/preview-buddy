import { configSummary, loadConfig } from "./config.ts";
import { connectState, initSchema } from "./db.ts";
import { startServer } from "./server.ts";

const config = loadConfig();
console.log("preview-buddy starting", configSummary(config));

const stateDb = connectState();
await initSchema(stateDb);
startServer({ config, state: stateDb });

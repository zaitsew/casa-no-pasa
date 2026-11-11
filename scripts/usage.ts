/** Counters for `./check.sh usage` and `teyla products`: key=value lines from the product's own store. */
import { existsSync } from "node:fs";
import { dbPath, openStore } from "../src/engine/store";

if (existsSync(".env")) process.loadEnvFile(".env");
const path = dbPath();
if (path !== ":memory:" && !existsSync(path)) {
  // No database yet is a finding, not an error; do not create one just to count it.
  for (const k of ["users", "listings", "cards", "copied", "sent", "viewings"]) console.log(`${k}=0`);
  console.log("median_seconds_to_card=not_enough_data");
  console.log("db=missing");
} else {
  const store = openStore(path);
  for (const [k, v] of Object.entries(store.usage())) console.log(`${k}=${v}`);
  store.close();
}

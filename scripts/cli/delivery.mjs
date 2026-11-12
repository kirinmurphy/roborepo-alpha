import fs from "node:fs";
import { fetchTrackingRefs, updatePullRequest } from "../../modules/delivery/operations.mjs";

export async function deliveryCommand(argv) {
  const [operation, value, ...extra] = argv;
  try {
    const valid = extra.length === 0 && (
      (operation === "fetch" && typeof value === "string")
      || (operation === "pr-body" && typeof value === "string")
      || (operation === "pr-ready" && value === undefined)
      || (operation === "retry-ci" && /^[1-9][0-9]*$/.test(value || "") && Number.isSafeInteger(Number(value)))
    );
    if (!valid) throw new Error("Usage: roborepo delivery fetch <remote> | pr-body <body-file> | pr-ready | retry-ci <run-id>");
    const body = operation === "pr-body" ? fs.readFileSync(value, "utf8") : value;
    const message = operation === "fetch"
      ? await fetchTrackingRefs(process.cwd(), value)
      : await updatePullRequest(process.cwd(), operation, body);
    console.log(message);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// Node release health for doctor: is the running Node on a release line that still receives
// security fixes, and is it on that line's latest security release?
//
// roborepo does not bundle Node; it runs whatever `node` is first on PATH. bin/roborepo refuses
// majors below the engines floor, but a supported major can still sit on an unpatched build
// indefinitely, and a line can reach end of life after the floor was set. Both are the user's to
// upgrade, not a broken install, so doctor reports them as warnings and stays green.
//
// Data comes from nodejs.org's release index (which releases are security releases) and the
// Node.js Release working group's schedule (when each line ends). Either fetch failing skips only
// the half of the check that needs it.

import { isMainModule } from "./roots.mjs";

export const NODE_RELEASES_URL = "https://nodejs.org/dist/index.json";
export const NODE_SCHEDULE_URL = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
// Doctor waits on this, and it runs offline too: an unreachable host must cost seconds, not a hang.
const FETCH_TIMEOUT_MS = 4000;

export function parseNodeVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || "").trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareNodeVersions(left, right) {
  const a = parseNodeVersion(left);
  const b = parseNodeVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function newestFirst(releases) {
  return releases
    .filter((release) => parseNodeVersion(release?.version))
    .sort((left, right) => compareNodeVersions(right.version, left.version));
}

// Pure assessment. `releases` is nodejs.org/dist/index.json, `schedule` is the Release WG
// schedule.json; either may be null when its fetch failed. Returns warning strings, empty when the
// running version is on a supported line and current with its security releases.
export function assessNodeRelease({ version, releases = null, schedule = null, now = new Date() }) {
  const current = parseNodeVersion(version);
  if (!current) return [`could not parse the running Node version "${version}"`];
  const major = current[0];
  const sorted = releases ? newestFirst(releases) : [];
  const warnings = [];

  const line = schedule?.[`v${major}`];
  if (line?.end && Date.parse(line.end) <= now.getTime()) {
    const latestLts = sorted.find((release) => {
      const end = schedule?.[`v${parseNodeVersion(release.version)[0]}`]?.end;
      return release.lts && !(end && Date.parse(end) <= now.getTime());
    });
    const target = latestLts ? ` — upgrade to a supported LTS line such as ${latestLts.version}` : " — upgrade to a supported LTS line";
    warnings.push(`Node ${version} is on the v${major} line, which reached end of life on ${line.end} and no longer receives security fixes${target}`);
  }

  const inLine = sorted.filter((release) => parseNodeVersion(release.version)[0] === major);
  const latestSecurity = inLine.find((release) => release.security);
  if (latestSecurity && compareNodeVersions(version, latestSecurity.version) < 0) {
    warnings.push(`Node ${version} is behind ${latestSecurity.version}, the latest security release on the v${major} line (${latestSecurity.date}) — upgrade to ${inLine[0].version} or newer`);
  }

  return warnings;
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// --check is doctor's contract: exit 0 with a one-line summary when current, 1 with one warning per
// line when outdated or end-of-life, 3 with the reason when nodejs.org could not be reached at all.
// doctor treats 1 as advisory, so a warning never turns doctor red.
async function checkMode() {
  const version = process.version;
  const [releases, schedule] = await Promise.all([fetchJson(NODE_RELEASES_URL), fetchJson(NODE_SCHEDULE_URL)]);
  if (!releases && !schedule) {
    console.log(`node ${version} release check skipped (could not reach nodejs.org)`);
    return 3;
  }
  const warnings = assessNodeRelease({ version, releases, schedule });
  if (warnings.length) {
    for (const warning of warnings) console.log(warning);
    return 1;
  }
  const partial = !releases ? " (release index unavailable; checked end of life only)"
    : !schedule ? " (release schedule unavailable; checked security releases only)" : "";
  console.log(`node ${version} is on a supported release line and current with its security releases${partial}`);
  return 0;
}

// Direct-invocation entry so scripts/doctor.sh can run `node node-release-health.mjs --check`
// without going through the CLI dispatcher — matching portal-pid-reaper.mjs.
if (isMainModule(import.meta.url)) {
  if (!process.argv.includes("--check")) {
    console.error("usage: node node-release-health.mjs --check");
    process.exit(2);
  }
  process.exit(await checkMode());
}

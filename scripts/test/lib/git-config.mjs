import fs from "node:fs";
import path from "node:path";

// Command-line config a runner injects through the environment (`git -c` equivalents). An agent
// session sets core.hooksPath this way, which would run the protected-branch push guard against a
// fixture's throwaway remote.
function injectedConfigKeys() {
  const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"];
  const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
  for (let index = 0; index < count; index += 1) keys.push(`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`);
  return keys;
}

// Fixture repositories must choose their own attributes, drivers, and hooks. Runner-wide Git LFS,
// user filters, or injected hook paths otherwise change which safety refusals these tests exercise.
export function isolateGitConfig(root) {
  const injected = injectedConfigKeys();
  const previous = Object.fromEntries(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", ...injected].map((key) => [key, process.env[key]]));
  const config = path.join(root, "global.gitconfig");
  fs.writeFileSync(config, "");
  for (const key of injected) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" });
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

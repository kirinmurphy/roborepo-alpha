import fs from "node:fs";
import path from "node:path";

// Fixture repositories must choose their own attributes and drivers. Runner-wide Git LFS or user
// filters otherwise change which safety refusals these tests exercise.
export function isolateGitConfig(root) {
  const previous = Object.fromEntries(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].map((key) => [key, process.env[key]]));
  const config = path.join(root, "global.gitconfig");
  fs.writeFileSync(config, "");
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" });
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

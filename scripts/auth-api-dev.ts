import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { developmentAuthEnvFile, developmentKeysFile, developmentProjectRoot } from "./development-secrets";

const projectRoot = developmentProjectRoot;
const pathPrefix = join(projectRoot, "node_modules", ".bin");
const dotenvx = join(pathPrefix, process.platform === "win32" ? "dotenvx.cmd" : "dotenvx");
const result = spawnSync(
  dotenvx,
  ["run", "-f", developmentAuthEnvFile(projectRoot), "-fk", developmentKeysFile(projectRoot), "--", "vite", "dev"],
  {
    cwd: join(projectRoot, "apps", "auth-api"),
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${pathPrefix}${delimiter}${process.env.PATH ?? ""}`,
    },
  },
);
process.exit(result.status ?? 1);

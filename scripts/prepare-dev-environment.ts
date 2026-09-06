import { execFileSync } from "node:child_process";
import {
  type DevelopmentSecretEncryptor,
  developmentProjectRoot,
  ensureDevelopmentSecrets,
  hasDevelopmentKeys,
} from "./development-secrets";

export { developmentProjectRoot };

export type DevelopmentCommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; stdio: "inherit" },
) => void;

export const supportedBunVersion = "1.4.0";

export function prepareDevelopmentEnvironment(
  input: {
    projectRoot?: string;
    executable?: string;
    bunVersion?: string;
    run?: DevelopmentCommandRunner;
    encrypt?: DevelopmentSecretEncryptor;
  } = {},
): void {
  const projectRoot = input.projectRoot ?? developmentProjectRoot;
  assertSupportedBunVersion(input.bunVersion ?? process.versions.bun ?? "unknown");

  const executable = input.executable ?? process.execPath;
  const run = input.run ?? execDevelopmentCommand;
  const options = { cwd: projectRoot, stdio: "inherit" as const };

  run(executable, ["install", "--frozen-lockfile"], options);
  ensureDevelopmentSecrets(projectRoot, { encrypt: input.encrypt });
  assertDevelopmentSecrets(projectRoot);
  run(executable, ["run", "api:migrate:local"], options);
}

export function assertSupportedBunVersion(version: string): void {
  if (version === supportedBunVersion) return;

  throw new Error(
    `Unsupported Bun ${version}. OpenBot development requires stable Bun ${supportedBunVersion}. Install the exact version with the command in https://github.com/NorbertBodziony/openbot#development, then retry.`,
  );
}

export function assertDevelopmentSecrets(projectRoot: string): void {
  if (hasDevelopmentKeys(projectRoot)) return;
  throw new Error(
    "Missing or empty .env.keys. Forked checkouts generate one on bun run dev; if this is a worktree, copy it through .worktreeinclude.",
  );
}

function execDevelopmentCommand(executable: string, args: string[], options: { cwd: string; stdio: "inherit" }): void {
  execFileSync(executable, args, options);
}

if (import.meta.main) {
  prepareDevelopmentEnvironment();
}

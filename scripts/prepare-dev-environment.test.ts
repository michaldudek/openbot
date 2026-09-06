import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasDevelopmentKeys } from "./development-secrets";
import {
  assertDevelopmentSecrets,
  assertSupportedBunVersion,
  type DevelopmentCommandRunner,
  prepareDevelopmentEnvironment,
} from "./prepare-dev-environment";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("development environment preparation", () => {
  it("accepts the supported stable Bun version", () => {
    expect(() => assertSupportedBunVersion("1.4.0")).not.toThrow();
  });

  it.each(["1.4.0-canary.1", "1.3.11"])("rejects unsupported Bun %s with upgrade instructions", (version) => {
    expect(() => assertSupportedBunVersion(version)).toThrow("OpenBot development requires stable Bun 1.4.0");
  });

  it("generates contributor secrets after install when worktree keys are missing", () => {
    const root = createTemporaryRoot();
    const calls: string[][] = [];
    const run: DevelopmentCommandRunner = (_executable, args) => calls.push(args);

    prepareDevelopmentEnvironment({
      projectRoot: root,
      executable: "bun",
      bunVersion: "1.4.0",
      run,
      encrypt: ({ keysFile }) => {
        writeFileSync(keysFile, "DOTENV_PRIVATE_KEY_DEV_LOCAL=generated\n");
      },
    });

    expect(hasDevelopmentKeys(root)).toBe(true);
    expect(readFileSync(join(root, "apps", "auth-api", ".env.dev.local"), "utf8")).toContain(
      "AUTH_EXPOSE_DEVELOPMENT_CODE",
    );
    expect(calls).toEqual([
      ["install", "--frozen-lockfile"],
      ["run", "api:migrate:local"],
    ]);
  });

  it("installs dependencies and migrates the local API in order", () => {
    const root = createTemporaryRoot();
    writeFileSync(join(root, ".env.keys"), "DOTENV_PRIVATE_KEY_TEST=value\n");
    const calls: string[][] = [];
    const run: DevelopmentCommandRunner = (_executable, args) => calls.push(args);

    prepareDevelopmentEnvironment({ projectRoot: root, executable: "bun", bunVersion: "1.4.0", run });

    expect(calls).toEqual([
      ["install", "--frozen-lockfile"],
      ["run", "api:migrate:local"],
    ]);
  });

  it("fails with an actionable error when secret generation did not create .env.keys", () => {
    const root = createTemporaryRoot();

    expect(() => assertDevelopmentSecrets(root)).toThrow("Missing or empty .env.keys");
  });
});

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openbot-dev-prepare-"));
  temporaryRoots.push(root);
  return root;
}

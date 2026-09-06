import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
export const developmentProjectRoot = dirname(scriptsRoot);

export const contributorAuthEnvFileName = ".env.dev.local";
export const developmentRemoteTicketKeyId = "openbot-remote-1";
export const developmentSmtpPasswordPlaceholder = "unused-local-development";

const unquotedEnvValue = /^[A-Za-z0-9._-]+$/u;

export type DevelopmentSecretEncryptor = (input: { envFile: string; keysFile: string; projectRoot: string }) => void;

export function developmentKeysFile(projectRoot: string): string {
  return join(projectRoot, ".env.keys");
}

export function developmentAuthEnvFile(projectRoot: string): string {
  const contributorFile = join(projectRoot, "apps", "auth-api", contributorAuthEnvFileName);
  if (isNonEmptyFile(contributorFile)) return contributorFile;
  return join(projectRoot, "apps", "auth-api", ".env.dev");
}

export function hasDevelopmentKeys(projectRoot: string): boolean {
  return isNonEmptyFile(developmentKeysFile(projectRoot));
}

export function ensureDevelopmentSecrets(
  projectRoot: string,
  options: { encrypt?: DevelopmentSecretEncryptor } = {},
): void {
  const envFile = join(projectRoot, "apps", "auth-api", contributorAuthEnvFileName);
  if (hasDevelopmentKeys(projectRoot) && !isNonEmptyFile(envFile)) return;
  if (hasDevelopmentKeys(projectRoot) && !contributorOverlayNeedsRepair(projectRoot, envFile)) return;

  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(envFile, serializeEnvFile(createContributorDevelopmentSecrets()));
  (options.encrypt ?? encryptContributorDevelopmentSecrets)({
    envFile,
    keysFile: developmentKeysFile(projectRoot),
    projectRoot,
  });

  if (!hasDevelopmentKeys(projectRoot)) {
    throw new Error("Failed to create .env.keys for local development.");
  }
}

export function createContributorDevelopmentSecrets(): Record<string, string> {
  const ticket = createDevelopmentRemoteTicketKeys();
  return {
    AUTH_EXPOSE_DEVELOPMENT_CODE: "true",
    EMAIL_SMTP_PASSWORD: developmentSmtpPasswordPlaceholder,
    SKILLS_ADMIN_TOKEN: randomBytes(32).toString("hex"),
    SITE_REPORT_HASH_SECRET: randomBytes(32).toString("hex"),
    REMOTE_TICKET_PRIVATE_JWK: ticket.privateJwk,
    REMOTE_TICKET_PUBLIC_JWKS: ticket.publicJwks,
    REMOTE_TICKET_KEY_ID: developmentRemoteTicketKeyId,
    REMOTE_AUTH_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  };
}

export function createDevelopmentRemoteTicketKeys(): { privateJwk: string; publicJwks: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateJwk = {
    ...privateKey.export({ format: "jwk" }),
    kid: developmentRemoteTicketKeyId,
    alg: "ES256",
  };
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: developmentRemoteTicketKeyId,
    use: "sig",
    alg: "ES256",
  };
  return {
    privateJwk: JSON.stringify(privateJwk),
    publicJwks: JSON.stringify({ keys: [publicJwk] }),
  };
}

export function serializeEnvFile(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([name, value]) => `${name}=${serializeEnvValue(value)}`);
  return `${lines.join("\n")}\n`;
}

export function contributorOverlayNeedsRepair(projectRoot: string, envFile: string): boolean {
  if (!isNonEmptyFile(envFile)) return false;
  const contents = readFileSync(envFile, "utf8");
  const values = parseDotenvAssignments(contents);
  const privateJwk = resolveOverlaySecret(
    projectRoot,
    envFile,
    "REMOTE_TICKET_PRIVATE_JWK",
    values.REMOTE_TICKET_PRIVATE_JWK,
  );
  const publicJwks = resolveOverlaySecret(
    projectRoot,
    envFile,
    "REMOTE_TICKET_PUBLIC_JWKS",
    values.REMOTE_TICKET_PUBLIC_JWKS,
  );
  return !isRemoteTicketJson(privateJwk, publicJwks);
}

function serializeEnvValue(value: string): string {
  if (unquotedEnvValue.test(value)) return value;
  if (value.includes("'") || value.includes("\n")) {
    throw new Error("Development secret values must not contain single quotes or newlines.");
  }
  return `'${value}'`;
}

function parseDotenvAssignments(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator);
    const raw = line.slice(separator + 1);
    if (raw.startsWith("'") && raw.endsWith("'")) {
      values[name] = raw.slice(1, -1);
      continue;
    }
    if (raw.startsWith('"') && raw.endsWith('"')) {
      values[name] = raw.slice(1, -1);
      continue;
    }
    values[name] = raw;
  }
  return values;
}

function resolveOverlaySecret(
  projectRoot: string,
  envFile: string,
  name: string,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw.startsWith("encrypted:")) return raw;
  const dotenvx = dotenvxExecutable(projectRoot);
  if (!dotenvx) return undefined;
  try {
    return execFileSync(dotenvx, ["get", name, "-f", envFile, "-fk", developmentKeysFile(projectRoot)], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

function isRemoteTicketJson(privateJwk: string | undefined, publicJwks: string | undefined): boolean {
  try {
    return isEcPrivateJwk(JSON.parse(privateJwk ?? "")) && isPublicJwks(JSON.parse(publicJwks ?? ""));
  } catch {
    return false;
  }
}

function isEcPrivateJwk(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("kty" in value) || !("d" in value)) return false;
  return value.kty === "EC" && typeof value.d === "string";
}

function isPublicJwks(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("keys" in value)) return false;
  return Array.isArray(value.keys);
}

function encryptContributorDevelopmentSecrets(input: { envFile: string; keysFile: string; projectRoot: string }): void {
  const dotenvx = dotenvxExecutable(input.projectRoot);
  if (dotenvx) {
    execFileSync(dotenvx, ["encrypt", "-f", input.envFile, "-fk", input.keysFile], {
      cwd: input.projectRoot,
      stdio: "inherit",
    });
  }
  if (!isNonEmptyFile(input.keysFile)) {
    writeFileSync(
      input.keysFile,
      `# Contributor-local dotenvx key. Do not commit.\nDOTENV_PRIVATE_KEY_DEV_LOCAL="${randomBytes(32).toString("hex")}"\n`,
    );
  }
}

function dotenvxExecutable(projectRoot: string): string | undefined {
  const path = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "dotenvx.cmd" : "dotenvx");
  return existsSync(path) ? path : undefined;
}

function isNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  ensureDevelopmentSecrets(developmentProjectRoot);
}

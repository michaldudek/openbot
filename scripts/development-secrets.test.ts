import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContributorDevelopmentSecrets,
  developmentAuthEnvFile,
  developmentRemoteTicketKeyId,
  ensureDevelopmentSecrets,
  hasDevelopmentKeys,
  serializeEnvFile,
} from "./development-secrets";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("contributor development secrets", () => {
  it("generates a local key file and Auth API overlay when none exist", () => {
    const root = createTemporaryRoot();

    ensureDevelopmentSecrets(root, {
      encrypt: ({ keysFile }) => {
        writeFileSync(keysFile, "DOTENV_PRIVATE_KEY_DEV_LOCAL=test-key\n");
      },
    });

    expect(hasDevelopmentKeys(root)).toBe(true);
    expect(developmentAuthEnvFile(root)).toBe(join(root, "apps", "auth-api", ".env.dev.local"));
    const values = parseEnvFile(readFileSync(join(root, "apps", "auth-api", ".env.dev.local"), "utf8"));
    expect(values.AUTH_EXPOSE_DEVELOPMENT_CODE).toBe("true");
    expect(values.EMAIL_SMTP_PASSWORD).toBe("unused-local-development");
    expect(values.REMOTE_TICKET_KEY_ID).toBe(developmentRemoteTicketKeyId);
    expect(values.SITE_REPORT_HASH_SECRET?.length).toBeGreaterThanOrEqual(32);
    expect(values.REMOTE_AUTH_WEBHOOK_SECRET?.length).toBeGreaterThanOrEqual(32);
    const privateJwk = JSON.parse(values.REMOTE_TICKET_PRIVATE_JWK ?? "");
    const publicJwks = JSON.parse(values.REMOTE_TICKET_PUBLIC_JWKS ?? "");
    expect(privateJwk).toMatchObject({ kty: "EC", crv: "P-256", kid: developmentRemoteTicketKeyId, alg: "ES256" });
    expect(privateJwk.d).toEqual(expect.any(String));
    expect(publicJwks.keys).toEqual([
      expect.objectContaining({ kty: "EC", crv: "P-256", kid: developmentRemoteTicketKeyId, use: "sig" }),
    ]);
  });

  it("leaves an existing .env.keys file alone", () => {
    const root = createTemporaryRoot();
    writeFileSync(join(root, ".env.keys"), "DOTENV_PRIVATE_KEY_DEV=existing\n");

    ensureDevelopmentSecrets(root, {
      encrypt: () => {
        throw new Error("must not encrypt when keys already exist");
      },
    });

    expect(readFileSync(join(root, ".env.keys"), "utf8")).toBe("DOTENV_PRIVATE_KEY_DEV=existing\n");
    expect(developmentAuthEnvFile(root)).toBe(join(root, "apps", "auth-api", ".env.dev"));
  });

  it("rewrites a contributor overlay whose ticket JWKS is not JSON", () => {
    const root = createTemporaryRoot();
    mkdirSync(join(root, "apps", "auth-api"), { recursive: true });
    writeFileSync(join(root, ".env.keys"), "DOTENV_PRIVATE_KEY_DEV_LOCAL=existing\n");
    writeFileSync(
      join(root, "apps", "auth-api", ".env.dev.local"),
      'REMOTE_TICKET_PUBLIC_JWKS=\'{\\"keys\\":[]}\'\nREMOTE_TICKET_PRIVATE_JWK=\'{\\"kty\\":\\"EC\\"}\'\n',
    );

    ensureDevelopmentSecrets(root, { encrypt: () => undefined });

    const values = parseEnvFile(readFileSync(join(root, "apps", "auth-api", ".env.dev.local"), "utf8"));
    expect(JSON.parse(values.REMOTE_TICKET_PUBLIC_JWKS ?? "").keys).toEqual([
      expect.objectContaining({ kty: "EC", kid: developmentRemoteTicketKeyId }),
    ]);
    expect(readFileSync(join(root, ".env.keys"), "utf8")).toBe("DOTENV_PRIVATE_KEY_DEV_LOCAL=existing\n");
  });

  it("prefers the contributor overlay over the tracked development file", () => {
    const root = createTemporaryRoot();
    mkdirSync(join(root, "apps", "auth-api"), { recursive: true });
    writeFileSync(join(root, "apps", "auth-api", ".env.dev"), "AUTH_EXPOSE_DEVELOPMENT_CODE=false\n");
    writeFileSync(join(root, "apps", "auth-api", ".env.dev.local"), "AUTH_EXPOSE_DEVELOPMENT_CODE=true\n");

    expect(developmentAuthEnvFile(root)).toBe(join(root, "apps", "auth-api", ".env.dev.local"));
  });

  it("serializes JSON secrets so dotenvx can decrypt them as JSON", () => {
    const values = createContributorDevelopmentSecrets();
    const serialized = serializeEnvFile({
      AUTH_EXPOSE_DEVELOPMENT_CODE: values.AUTH_EXPOSE_DEVELOPMENT_CODE,
      REMOTE_TICKET_PRIVATE_JWK: values.REMOTE_TICKET_PRIVATE_JWK,
      EMAIL_SMTP_PASSWORD: values.EMAIL_SMTP_PASSWORD,
    });

    expect(serialized).toContain("AUTH_EXPOSE_DEVELOPMENT_CODE=true\n");
    expect(serialized).toContain("REMOTE_TICKET_PRIVATE_JWK='{");
    expect(serialized).not.toContain("\\");
    const parsed = parseEnvFile(serialized);
    expect(JSON.parse(parsed.REMOTE_TICKET_PRIVATE_JWK ?? "")).toEqual(JSON.parse(values.REMOTE_TICKET_PRIVATE_JWK));
    expect(parsed.EMAIL_SMTP_PASSWORD).toBe("unused-local-development");
  });
});

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openbot-dev-secrets-"));
  temporaryRoots.push(root);
  return root;
}

function parseQuotedEnvValue(raw: string): string {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "string") throw new Error(`Expected a quoted string env value, received ${typeof parsed}.`);
  return parsed;
}

function parseEnvFile(contents: string): Record<string, string> {
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
    values[name] = raw.startsWith('"') ? parseQuotedEnvValue(raw) : raw;
  }
  return values;
}

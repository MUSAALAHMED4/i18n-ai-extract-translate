import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessTokenFromServiceAccount(keyFilePath) {
  const raw = await readFile(keyFilePath, "utf8");
  const key = JSON.parse(raw);

  if (!key.client_email || !key.private_key) {
    throw new Error(
      `${keyFilePath} does not look like a service account key (missing client_email/private_key).`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(key.private_key);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Failed to exchange service account key for an access token: ${JSON.stringify(data)}`,
    );
  }
  return data.access_token;
}

function getAccessTokenFromGcloud() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "gcloud",
      ["auth", "application-default", "print-access-token"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else
        reject(
          new Error(stderr.trim() || `gcloud exited with code ${code}`),
        );
    });
  });
}

/**
 * Resolves a short-lived OAuth2 access token for the Vertex AI REST API.
 * Tries, in order:
 *   1. VERTEX_ACCESS_TOKEN env var (a token you already minted yourself)
 *   2. GOOGLE_APPLICATION_CREDENTIALS env var (a service account key file)
 *   3. `gcloud auth application-default print-access-token` (local dev)
 */
export async function resolveVertexAccessToken() {
  if (process.env.VERTEX_ACCESS_TOKEN) {
    return process.env.VERTEX_ACCESS_TOKEN;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return getAccessTokenFromServiceAccount(
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
    );
  }

  try {
    return await getAccessTokenFromGcloud();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not obtain a Vertex AI access token (${reason}). Set VERTEX_ACCESS_TOKEN, ` +
        "or GOOGLE_APPLICATION_CREDENTIALS to a service account key file, or run " +
        "`gcloud auth application-default login`.",
    );
  }
}

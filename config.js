"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULTS = {
  PORT: 4040,
  APPS_ROOT: "/home/apps",
  ALLOWLIST_PATH: "/etc/deploy-receiver/allowlist.json",
  DEPLOY_TIMEOUT_MS: 180_000, // 3 minutes
  MAX_OUTPUT_CHARS: 4000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a single systemd credential file and return its trimmed content. */
function readCredential(name) {
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  if (!credDir) {
    throw new Error(
      `CREDENTIALS_DIRECTORY is not set — are you running under the systemd unit with LoadCredential?`
    );
  }
  const filePath = path.join(credDir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Credential file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8").trim();
}

// ---------------------------------------------------------------------------
// Load configuration
// ---------------------------------------------------------------------------
function loadConfig() {
  const port = parseInt(process.env.DEPLOY_RECEIVER_PORT, 10) || DEFAULTS.PORT;
  const appsRoot = process.env.DEPLOY_APPS_ROOT || DEFAULTS.APPS_ROOT;
  const allowlistPath =
    process.env.DEPLOY_ALLOWLIST_PATH || DEFAULTS.ALLOWLIST_PATH;
  const deployTimeoutMs =
    parseInt(process.env.DEPLOY_TIMEOUT_MS, 10) || DEFAULTS.DEPLOY_TIMEOUT_MS;
  const maxOutputChars =
    parseInt(process.env.DEPLOY_MAX_OUTPUT_CHARS, 10) ||
    DEFAULTS.MAX_OUTPUT_CHARS;

  // --- Secrets via systemd credentials ---
  const vaultwardenMasterPassword = readCredential(
    "vaultwarden-master-password"
  );
  const ghcrPat = readCredential("ghcr-pat");
  const deployReceiverToken = readCredential("deploy-receiver-token");

  // --- Allowlist (optional but recommended) ---
  let allowlist = null;
  if (fs.existsSync(allowlistPath)) {
    try {
      const raw = fs.readFileSync(allowlistPath, "utf-8");
      allowlist = JSON.parse(raw);
      if (!Array.isArray(allowlist)) {
        throw new Error("Allowlist must be a JSON array of repo slugs");
      }
      console.log(
        `[config] Loaded allowlist with ${allowlist.length} repo(s) from ${allowlistPath}`
      );
    } catch (err) {
      console.error(`[config] Failed to parse allowlist: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.warn(
      `[config] No allowlist found at ${allowlistPath} — ALL repo slugs will be accepted`
    );
  }

  return {
    port,
    appsRoot,
    allowlist,
    deployTimeoutMs,
    maxOutputChars,
    secrets: {
      vaultwardenMasterPassword,
      ghcrPat,
      deployReceiverToken,
    },
  };
}

module.exports = { loadConfig, DEFAULTS };

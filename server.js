"use strict";

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { loadConfig } = require("./config");

// ---------------------------------------------------------------------------
// Validation patterns
// ---------------------------------------------------------------------------
/** Repo slug: letters, digits, dot, underscore, dash.  1-128 chars. */
const REPO_SLUG_RE = /^[a-zA-Z0-9._-]{1,128}$/;

/** Image ref: must start with ghcr.io/ and contain only safe chars. */
const IMAGE_RE = /^ghcr\.io\/[a-z0-9._/-]{1,256}$/;

/** Tag: alphanumeric, dash, dot, underscore.  1-128 chars. */
const TAG_RE = /^[a-zA-Z0-9._-]{1,128}$/;

/** Allowed environment values. */
const ENVS = new Set(["prod", "dev", ""]);

// ---------------------------------------------------------------------------
// Per-repo deploy lock (in-memory)
// ---------------------------------------------------------------------------
const deployLocks = new Map();

function acquireLock(repo) {
  if (deployLocks.get(repo)) return false;
  deployLocks.set(repo, true);
  return true;
}

function releaseLock(repo) {
  deployLocks.delete(repo);
}

// ---------------------------------------------------------------------------
// Tail helper — keep last N characters of a string
// ---------------------------------------------------------------------------
function tail(str, maxChars) {
  if (!str) return "";
  return str.length > maxChars ? str.slice(-maxChars) : str;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "16kb" }));

// Simple request logger (no secrets)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// Deploy endpoint
// ---------------------------------------------------------------------------
app.post("/deploy", async (req, res) => {
  // --- Auth ---
  const token = req.headers["x-deploy-token"];
  if (
    !token ||
    !timingSafeEqual(token, config.secrets.deployReceiverToken)
  ) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // --- Parse body ---
  const { repo, image, tag, environment, deliveryId } = req.body || {};

  if (!repo || !image || !tag) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing required fields: repo, image, tag" });
  }

  // --- Validate repo slug ---
  if (!REPO_SLUG_RE.test(repo)) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid repo slug format" });
  }

  // --- Allowlist ---
  if (config.allowlist && !config.allowlist.includes(repo)) {
    return res
      .status(403)
      .json({ ok: false, error: "Repo not in allowlist" });
  }

  // --- Validate image ---
  if (!IMAGE_RE.test(image)) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid image format (must be ghcr.io/…)" });
  }

  // --- Validate tag ---
  if (!TAG_RE.test(tag)) {
    return res.status(400).json({ ok: false, error: "Invalid tag format" });
  }

  // --- Validate environment ---
  const env = environment || "";
  if (!ENVS.has(env)) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid environment value" });
  }

  // --- Resolve paths ---
  const repoDir = path.join(config.appsRoot, repo);
  const deployScript = path.join(repoDir, "deploy.sh");

  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    return res
      .status(404)
      .json({ ok: false, error: `Repo directory not found: ${repoDir}` });
  }

  if (!fs.existsSync(deployScript)) {
    return res
      .status(404)
      .json({ ok: false, error: `deploy.sh not found in ${repoDir}` });
  }

  try {
    fs.accessSync(deployScript, fs.constants.X_OK);
  } catch {
    return res
      .status(500)
      .json({ ok: false, error: `deploy.sh is not executable` });
  }

  // --- Per-repo lock ---
  if (!acquireLock(repo)) {
    return res
      .status(409)
      .json({ ok: false, error: `Deploy already in progress for ${repo}` });
  }

  const reqId = deliveryId || crypto.randomUUID();
  console.log(
    `[deploy] ${reqId} | repo=${repo} image=${image} tag=${tag} env=${env}`
  );

  // --- Execute deploy.sh ---
  try {
    const result = await runDeploy({
      deployScript,
      repoDir,
      repo,
      image,
      tag,
      env,
      reqId,
    });

    console.log(
      `[deploy] ${reqId} | finished exitCode=${result.exitCode}`
    );

    if (result.exitCode === 0) {
      return res.json({
        ok: true,
        repo,
        image,
        tag,
        output: tail(result.stdout, config.maxOutputChars),
      });
    } else {
      return res.status(500).json({
        ok: false,
        repo,
        image,
        tag,
        error: tail(result.stderr || result.stdout, config.maxOutputChars),
      });
    }
  } catch (err) {
    console.error(`[deploy] ${reqId} | error: ${err.message}`);
    return res
      .status(500)
      .json({ ok: false, repo, image, tag, error: err.message });
  } finally {
    releaseLock(repo);
  }
});

// ---------------------------------------------------------------------------
// Execute deploy.sh as a child process
// ---------------------------------------------------------------------------
function runDeploy({ deployScript, repoDir, repo, image, tag, env, reqId }) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("/bin/bash", [deployScript], {
      cwd: repoDir,
      env: {
        // Minimal safe PATH
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: repoDir,

        // Deploy metadata
        DEPLOY_REPO: repo,
        DEPLOY_IMAGE: image,
        DEPLOY_TAG: tag,
        DEPLOY_ENV: env,

        // Secrets (named to match existing deploy.sh conventions)
        VAULTWARDEN_MASTER_PASSWORD:
          config.secrets.vaultwardenMasterPassword,
        GHCR_PAT: config.secrets.ghcrPat,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: config.deployTimeoutMs,
    });

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    // Manual timeout kill in case spawn timeout doesn't work on all platforms
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 5000);
    }, config.deployTimeoutMs);

    child.on("close", () => clearTimeout(timer));
  });
}

// ---------------------------------------------------------------------------
// Timing-safe string comparison
// ---------------------------------------------------------------------------
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(config.port, config.ipAddress, () => {
  console.log(`[deploy-receiver] Listening on ${config.ipAddress}:${config.port}`);
});

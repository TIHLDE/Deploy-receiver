# Deploy Receiver

A minimal **Node.js + Express** service that runs on the server (bare-metal, **not** in Docker).  
It listens for POST requests from GitHub Actions and triggers the correct repo's `deploy.sh`.

> **Part of the TIHLDE CI/CD pipeline.** GitHub Actions builds and pushes Docker images using
> the reusable workflows in [TIHLDE/tihlde-workflows](https://github.com/TIHLDE/tihlde-workflows), then
> notifies this receiver to pull the new image and restart the container.

---

## How it works

```
GitHub Actions                          Server
┌──────────────────┐             ┌──────────────────────┐
│ _ci_ghcr.yml     │             │                      │
│  Build & push    │             │  Deploy Receiver     │
│  Docker image    │             │  (systemd service)   │
└────────┬─────────┘             │                      │
         │                       │  POST /deploy        │
         ▼                       │  ├─ Validate token   │
┌──────────────────┐             │  ├─ Check allowlist  │
│ _notify_deploy   │──HTTP POST──▶  └─ Run deploy.sh   │
│  .yml            │             │                      │
└──────────────────┘             └──────────────────────┘
```

1. CI builds and pushes a Docker image to GHCR.
2. CI calls the reusable `_notify_deploy.yml` workflow (from [TIHLDE/tihlde-workflows](https://github.com/TIHLDE/tihlde-workflows)), which POSTs to the receiver.
3. The receiver validates the token, checks the allowlist, and runs `/home/apps/<repo>/deploy.sh`.
4. `deploy.sh` pulls the new image and restarts the container.

---

## Server folder structure

```
/opt/deploy-receiver/              # Receiver code
  server.js
  config.js
  package.json
  node_modules/

/etc/deploy-receiver/              # Configuration
  allowlist.json                   # ["sporty", "sporty", ...]
  credentials/                     # Secrets (root-only)
    vaultwarden-master-password    # chmod 600, root:root
    ghcr-pat                       # chmod 600, root:root
    deploy-receiver-token          # chmod 600, root:root

/home/apps/<repo-slug>/            # One folder per deployed project
  deploy.sh                        # chmod +x, project-specific deploy script
```

---

## Server install

### Prerequisites

- **Node.js ≥ 18** (`node --version`)
- **npm** (comes with Node)
- **Docker** (used by `deploy.sh` scripts)
- **jq**, **bw** (Bitwarden CLI) — if your deploy scripts need them
- **systemd** (for running the receiver as a service)

### 1. Clone the repo on the server

```bash
ssh root@your-server

git clone https://github.com/TIHLDE/Deploy-receiver.git /opt/deploy-receiver
cd /opt/deploy-receiver
npm install --production
```

Or copy manually:

```bash
# From your local machine:
scp -r ./ root@your-server:/opt/deploy-receiver/
ssh root@your-server "cd /opt/deploy-receiver && npm install --production"
```

### 2. Create credential files

```bash
sudo mkdir -p /etc/deploy-receiver/credentials
sudo chmod 700 /etc/deploy-receiver/credentials

# Vaultwarden master password
echo -n 'YOUR_VAULTWARDEN_PASSWORD' | sudo tee /etc/deploy-receiver/credentials/vaultwarden-master-password > /dev/null
sudo chmod 600 /etc/deploy-receiver/credentials/vaultwarden-master-password
sudo chown root:root /etc/deploy-receiver/credentials/vaultwarden-master-password

# GHCR personal access token
echo -n 'YOUR_GHCR_PAT' | sudo tee /etc/deploy-receiver/credentials/ghcr-pat > /dev/null
sudo chmod 600 /etc/deploy-receiver/credentials/ghcr-pat
sudo chown root:root /etc/deploy-receiver/credentials/ghcr-pat

# Deploy receiver shared token (used for request authentication)
echo -n 'YOUR_RANDOM_TOKEN' | sudo tee /etc/deploy-receiver/credentials/deploy-receiver-token > /dev/null
sudo chmod 600 /etc/deploy-receiver/credentials/deploy-receiver-token
sudo chown root:root /etc/deploy-receiver/credentials/deploy-receiver-token
```

> **Generate a strong random token:**
> ```bash
> openssl rand -hex 32
> ```

### 3. Create the allowlist

```bash
sudo mkdir -p /etc/deploy-receiver
cat <<'EOF' | sudo tee /etc/deploy-receiver/allowlist.json
["sporty"]
EOF
sudo chmod 644 /etc/deploy-receiver/allowlist.json
```

Add repo slugs (lowercase) for every project that should be deployable.

### 4. Install and run as a systemd service

```bash
sudo cp /opt/deploy-receiver/deploy-receiver.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable deploy-receiver
sudo systemctl start deploy-receiver
```

The systemd unit uses `LoadCredential=` directives to securely pass secrets to the process.
Systemd reads the credential files and exposes them via the `CREDENTIALS_DIRECTORY` environment variable — the secrets never appear in the process environment or `/proc`.

Check status:

```bash
sudo systemctl status deploy-receiver
sudo journalctl -u deploy-receiver -f
```

### 5. Create app directories for each project

For each repo you want to deploy, create a directory with a `deploy.sh`:

```bash
mkdir -p /home/apps/my-repo

# Copy and customize the example script
cp /opt/deploy-receiver/example-deploy.sh /home/apps/my-repo/deploy.sh

# Edit it to set your project-specific values
nano /home/apps/my-repo/deploy.sh

# Make it executable
chmod +x /home/apps/my-repo/deploy.sh
```

> **See [example-deploy.sh](example-deploy.sh)** for a fully-commented reference implementation showing how to use Vaultwarden secrets and restart containers.

The receiver runs `deploy.sh` in the repo folder (`/home/apps/<repo-slug>/`) and passes deploy metadata via environment variables (see [Environment variables passed to deploy.sh](#environment-variables-passed-to-deploysh)).

---

## Configuration

All non-secret configuration is via environment variables set in the systemd unit:

| Variable                | Default                             | Description                        |
|-------------------------|-------------------------------------|------------------------------------|
| `DEPLOY_RECEIVER_PORT`  | `4040`                              | Port to listen on (localhost only) |
| `DEPLOY_APPS_ROOT`      | `/home/apps`                        | Root directory for app folders     |
| `DEPLOY_ALLOWLIST_PATH` | `/etc/deploy-receiver/allowlist.json` | Path to JSON allowlist           |
| `DEPLOY_TIMEOUT_MS`     | `180000`                            | Script execution timeout (ms)      |
| `DEPLOY_MAX_OUTPUT_CHARS` | `4000`                            | Max chars returned in response     |

---

## Secrets

Three secrets are managed via **systemd credentials** (`LoadCredential=`):

| Credential file            | Exposed to deploy.sh as          | Purpose                                    |
|----------------------------|----------------------------------|--------------------------------------------|
| `vaultwarden-master-password` | `VAULTWARDEN_MASTER_PASSWORD` | Unlock Vaultwarden to fetch env vars       |
| `ghcr-pat`                 | `GHCR_PAT`                      | Authenticate with GHCR to pull images      |
| `deploy-receiver-token`    | *(internal, not passed to script)* | Authenticate incoming deploy requests    |

`DEPLOY_RECEIVER_TOKEN` is a **separate, third secret**. It is NOT reused from the other two because:
- It serves a fundamentally different purpose (authenticating HTTP requests vs. accessing external services).
- Reusing `GHCR_PAT` would mean GitHub Actions tokens could pull images AND trigger deploys — violating least-privilege.
- A compromised `GHCR_PAT` would also compromise deploy access if reused.

**None of these secrets are printed in logs.**

---

## GitHub Actions integration

The **notify** side of this pipeline is handled by reusable workflows in [TIHLDE/tihlde-workflows](https://github.com/TIHLDE/tihlde-workflows).
After pushing a Docker image, the `_notify_deploy.yml` workflow sends a POST request to this receiver.

### 1. Add repository secrets

In your GitHub repo → **Settings → Secrets and variables → Actions**, add:

| Secret name              | Value                                 |
|--------------------------|---------------------------------------|
| `DEPLOY_RECEIVER_TOKEN`  | Same token as in the credential file  |

### 2. Call the reusable workflows

See the [TIHLDE/tihlde-workflows README](https://github.com/TIHLDE/tihlde-workflows#quick-start) for full copy-paste examples.

A minimal production example:

```yaml
jobs:
  build:
    permissions:
      contents: read
      packages: write
    uses: TIHLDE/tihlde-workflows/.github/workflows/_ci_ghcr.yml@v1
    with:
      push: ${{ github.event_name != 'pull_request' }}

  deploy:
    needs: build
    if: github.event_name != 'pull_request'
    uses: TIHLDE/tihlde-workflows/.github/workflows/_notify_deploy.yml@v1
    with:
      image: ghcr.io/${{ github.repository }}
      tag: latest
      environment: prod
    secrets:
      DEPLOY_RECEIVER_TOKEN: ${{ secrets.DEPLOY_RECEIVER_TOKEN }}
```

---

## API

### `POST /deploy`

**Headers:**
```
Content-Type: application/json
X-Deploy-Token: <your-token>
```

**Body:**
```json
{
  "repo": "sporty",
  "image": "ghcr.io/tihlde/sporty",
  "tag": "latest",
  "environment": "prod",
  "deliveryId": "optional-unique-id"
}
```

**Success (200):**
```json
{
  "ok": true,
  "repo": "sporty",
  "image": "ghcr.io/tihlde/sporty",
  "tag": "latest",
  "output": "... last 4000 chars of stdout ..."
}
```

**Error (4xx/5xx):**
```json
{
  "ok": false,
  "repo": "sporty",
  "image": "ghcr.io/tihlde/sporty",
  "tag": "latest",
  "error": "... error message or stderr ..."
}
```

### `GET /health`

Returns `{ "ok": true, "uptime": 12345.6 }`.

---

## Testing with curl

```bash
curl -X POST http://localhost:4040/deploy \
  -H "Content-Type: application/json" \
  -H "X-Deploy-Token: YOUR_TOKEN_HERE" \
  -d '{
    "repo": "sporty",
    "image": "ghcr.io/tihlde/sporty",
    "tag": "latest",
    "environment": "prod"
  }'
```

---

## Security checklist

Before exposing this service, verify every item:

- [ ] **Allowlist repos** — `allowlist.json` contains only the repo slugs you want to deploy. Without it, any valid slug is accepted.
- [ ] **Strict repo slug validation** — slugs are matched against `^[a-zA-Z0-9._-]{1,128}$`. No slashes, no `..`, no path traversal.
- [ ] **Token auth** — every request must include a valid `X-Deploy-Token` header. Comparison uses `crypto.timingSafeEqual`.
- [ ] **Image validation** — image references must match `^ghcr\.io\/[a-z0-9._/-]{1,256}$`.
- [ ] **Localhost binding** — the receiver binds to `127.0.0.1:4040` by default. Use a reverse proxy (nginx/Caddy) with TLS for external access.
- [ ] **Per-repo lock** — only one deploy per repo can run at a time. Concurrent requests return HTTP 409.
- [ ] **Execution timeout** — `deploy.sh` is killed after 180 s (configurable via `DEPLOY_TIMEOUT_MS`).
- [ ] **No secrets in logs** — credentials are never logged; only metadata (repo, image, tag) appears.
- [ ] **systemd credentials** — secrets are loaded via `LoadCredential=`, not environment variables, and are not visible in `/proc`.
- [ ] **Credential file permissions** — all files in `/etc/deploy-receiver/credentials/` are `chmod 600, root:root`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 Unauthorized` | Missing or wrong `X-Deploy-Token` header | Verify the token matches between server credential file and GitHub secret |
| `403 Repo not in allowlist` | Repo slug not in `allowlist.json` | Add the repo slug to the allowlist and restart (or the receiver reads it on each request) |
| `400 Invalid repo slug format` | Repo name contains invalid characters | Use only `a-z`, `0-9`, `.`, `_`, `-` |
| `400 Invalid image format` | Image doesn't start with `ghcr.io/` | Ensure image follows `ghcr.io/<owner>/<repo>` pattern |
| `404 Repo directory not found` | No `/home/apps/<repo>/` on server | Create the directory: `mkdir -p /home/apps/<repo>` |
| `404 deploy.sh not found` | Script missing in repo directory | Create `deploy.sh` in `/home/apps/<repo>/` |
| `500 deploy.sh is not executable` | Missing execute permission | `chmod +x /home/apps/<repo>/deploy.sh` |
| `409 Deploy already in progress` | Concurrent deploy for same repo | Wait for current deploy to finish |
| `500` with timeout error | deploy.sh takes too long | Increase `DEPLOY_TIMEOUT_MS` or optimize the script |
| Service won't start | Credential files missing or wrong permissions | Check all 3 files exist in `/etc/deploy-receiver/credentials/` with `chmod 600` |
| `CREDENTIALS_DIRECTORY is not set` | Not running under systemd | Start via `systemctl start deploy-receiver`, not `node server.js` directly |

### Viewing logs

```bash
# Follow live logs
sudo journalctl -u deploy-receiver -f

# Last 100 lines
sudo journalctl -u deploy-receiver -n 100

# Since last boot
sudo journalctl -u deploy-receiver -b
```

---

## Environment variables passed to deploy.sh

When the receiver executes `deploy.sh`, it sets these environment variables:

| Variable                      | Value                                    |
|-------------------------------|------------------------------------------|
| `DEPLOY_REPO`                 | Repo slug (e.g. `sporty`)              |
| `DEPLOY_IMAGE`                | Full image reference                     |
| `DEPLOY_TAG`                  | Image tag                                |
| `DEPLOY_ENV`                  | `prod`, `dev`, or empty                  |
| `VAULTWARDEN_MASTER_PASSWORD` | From systemd credential                  |
| `GHCR_PAT`                    | From systemd credential                  |

The script's working directory is set to `/home/apps/<repo>/`.

---

## License

[MIT](LICENSE)

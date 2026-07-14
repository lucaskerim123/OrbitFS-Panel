# OrbitFS Cloud Deploy

This folder groups the cloud deployment material for the current OrbitFS
layout.

Use one container, one persistent volume, and three local Node processes:

- `orbitfs-mcp`
- `orbitfs-panel`
- `orbitfs-panel/plugins/OrbitFS Sorter`

Do not split these into separate hosted services unless you redesign storage.
The panel proxies to the sorter over `localhost`, and the sorter and MCP server
both expect direct access to the same OrbitFS filesystem.

## Included here

- `README.md` - deployment guide for Render and Railway
- `render.yaml.example` - example Render Blueprint
- `railway.json.example` - example Railway config

Operational files stay outside this folder:

- `orbitfs-panel/Dockerfile.cloud`
- `orbitfs-panel/scripts/start-cloud.sh`

Those stay where the build and runtime expect them.

## What this supports

- Render
- Railway

## What this does not target

- Vercel

Vercel is the wrong fit for this code because the app expects a normal
long-running Node process plus persistent mounted storage, not serverless
functions and object/database storage.

## Files used for cloud deploy

- `orbitfs-panel/Dockerfile.cloud`
- `orbitfs-panel/scripts/start-cloud.sh`

Build with the repo root as the Docker context:

```bash
docker build -f orbitfs-panel/Dockerfile.cloud .
```

The Dockerfile lives in `orbitfs-panel`, but it copies both `orbitfs-panel`
and `orbitfs-mcp`, so the build context must stay at the repo root.

## Required environment variables

Set these in Render or Railway:

```env
NODE_ENV=production
ORBITFS_CLOUD=1

PANEL_PORT=4000
PORT=3939
SORTER_PORT=4055

HIVE_URL=http://127.0.0.1:3939
SORTER_URL=http://127.0.0.1:4055

HIVE_SERVER_DIR=/app/orbitfs-mcp
HIVE_LOG_DIR=/app/orbitfs-mcp/logs
SORTER_DIR=/app/orbitfs-panel/plugins/OrbitFS Sorter

HIVE_ROOT=/data/orbitfs
PUBLIC_BASE_URL=https://replace-me-with-your-public-url

HIVE_API_KEY=replace-with-random-secret
SESSION_SECRET=replace-with-random-secret
```

## Persistent volume

Mount one persistent volume at:

```text
/data
```

The current default OrbitFS root inside the container is:

```text
/data/orbitfs
```

That keeps all live content on the mounted disk instead of the ephemeral
container filesystem.

## Render setup

Use a Docker web service.

Settings:

1. Root directory: leave blank so the repo root remains the Docker context.
2. Dockerfile path: `orbitfs-panel/Dockerfile.cloud`
3. Exposed HTTP port: `4000`
4. Persistent disk mount path: `/data`
5. Add the environment variables listed above.

Notes:

- The panel is the only public-facing process.
- `orbitfs-mcp` stays internal on `127.0.0.1:3939`.
- The sorter stays internal on `127.0.0.1:4055`.
- Set `PUBLIC_BASE_URL` to your Render service URL or your custom domain.

## Railway setup

Use one Docker service.

Settings:

1. Keep the repo root as the build context.
2. Point Railway at `orbitfs-panel/Dockerfile.cloud`.
3. Expose port `4000`.
4. Attach one volume mounted at `/data`.
5. Add the environment variables listed above.

Notes:

- Set `PUBLIC_BASE_URL` to your Railway public URL or custom domain.
- Keep the app as one service. Splitting panel, MCP, and sorter across
  multiple Railway services does not match the current filesystem design.

## Cloud-mode behavior

Set `ORBITFS_CLOUD=1`.

In cloud mode:

- the panel System tab reports cloud-safe status
- Windows service controls are disabled
- hard-stop actions are disabled

This avoids PowerShell and Windows-service assumptions breaking the UI in
Render or Railway.

## Current limitations you should expect

- The System tab is still oriented around the old Windows/VPS deployment.
  In cloud mode it becomes informational, not a real machine-control panel.
- First-run setup flows are still more Windows-centric than cloud-centric.
- The sorter remains a local sidecar process, not a separate scalable service.

## Recommended deployment shape

Use this exact shape:

1. One hosted container
2. One persistent volume
3. One public port: panel on `4000`
4. Internal loopback only:
   - MCP on `3939`
   - sorter on `4055`

## Local smoke test before deploying

From the repo root:

```bash
docker build -f orbitfs-panel/Dockerfile.cloud -t orbitfs-cloud .
docker run --rm -p 4000:4000 \
  -e PUBLIC_BASE_URL=http://localhost:4000 \
  -e HIVE_API_KEY=test-key \
  -e SESSION_SECRET=test-secret \
  -v orbitfs_data:/data \
  orbitfs-cloud
```

Then open:

```text
http://localhost:4000
```

## Why Vercel is still the wrong fit

- Vercel Functions have request-duration limits rather than acting like a
  normal always-on server process.
- Vercel storage is Blob/Edge Config/marketplace databases, not a mounted
  shared filesystem the current sorter and OrbitFS code can treat like local disk.

Official references:

- Render persistent disks: https://render.com/docs/disks
- Railway volumes: https://docs.railway.com/volumes/reference
- Vercel Functions limits: https://vercel.com/docs/functions/limitations
- Vercel storage overview: https://vercel.com/docs/storage

# openclaw-scaffold-plugin

An [OpenClaw](https://openclaw.dev) plugin that scaffolds new coding projects by invoking **Claude Code** as the builder. Trigger a build from chat (webchat, Telegram, or any connected channel) and receive progress updates as features complete.

```
You (chat) → OpenClaw → scaffold_project tool
                              ↓
                         Claude Code (builds the project)
                              ↓
                         scaffold_notify → back to your chat
```

## What it does

- Registers two tools in OpenClaw: `scaffold_project` and `scaffold_notify`
- `scaffold_project` creates a project directory, copies your harness template (if one exists), then spawns Claude Code to build the project non-interactively
- Claude Code commits after each feature and calls `scaffold_notify` to report progress back to your session
- Optional integrations (configured per-user, not in this repo):
  - **Vercel** — auto-deploys React projects and notifies you with the live URL
  - **Supabase** — provisions a database for backend project types, writes credentials to `.env.local` (gitignored), and injects them into Vercel env vars if deploying

## Prerequisites

- [OpenClaw](https://openclaw.dev) installed and running (`openclaw gateway start`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude auth login`)
- Node.js 18+

## Installation

```bash
git clone https://github.com/<you>/openclaw-scaffold-plugin
cd openclaw-scaffold-plugin
npm install
npm run plugin:build
```

Then register the plugin directory in your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/openclaw-scaffold-plugin"]
    }
  }
}
```

Also allow the tools in your gateway config so they are HTTP-accessible to the Claude Code subprocess:

```json
{
  "gateway": {
    "tools": {
      "allow": ["scaffold_notify"]
    }
  },
  "tools": {
    "alsoAllow": ["scaffold_project", "scaffold_notify"]
  }
}
```

Restart the gateway: `openclaw gateway restart`

## Configuration (optional)

All config values are stored in your local `openclaw.json` — never in this repo.

Set them via the OpenClaw CLI after the plugin is loaded:

```bash
# Vercel auto-deployment for React projects
openclaw config set plugins.entries.scaffold-project.config.vercelToken <your-vercel-token>

# Supabase DB provisioning for backend project types (fastapi, django, nextjs, express)
openclaw config set plugins.entries.scaffold-project.config.supabaseToken <your-supabase-pat>
openclaw config set plugins.entries.scaffold-project.config.supabaseOrgId <your-org-id>
openclaw config set plugins.entries.scaffold-project.config.supabaseRegion us-east-1
```

All fields are optional. If omitted, those steps are skipped — the project still builds.

| Key | Where to get it |
|---|---|
| `vercelToken` | vercel.com → Settings → Tokens |
| `supabaseToken` | app.supabase.com → Account → Access Tokens |
| `supabaseOrgId` | `curl https://api.supabase.com/v1/organizations -H "Authorization: Bearer <token>"` |
| `supabaseRegion` | Supabase region slug, e.g. `us-east-1`, `eu-west-2` |

## Harness templates

The plugin looks for templates at `~/openclaw-templates/{type}/` (e.g. `~/openclaw-templates/fastapi/`). If a matching directory exists, its files are copied into the new project directory before Claude Code is invoked, with `{{PROJECT_NAME}}` replaced throughout.

If no template exists for a project type, Claude Code is instructed to create the harness files from scratch.

### Template directory structure

```
~/openclaw-templates/
└── fastapi/
    ├── CLAUDE.md            ← instructions for Claude Code (setup, commands, rules)
    ├── init.sh              ← install + verify script (must exit 0 when healthy)
    ├── feature_list.json    ← feature list with id/name/status/verification
    └── claude-progress.md   ← session log stub
```

### `CLAUDE.md`

Tells Claude Code how to work in this project type: runtime version, install/run/test/lint commands, and any hard rules (e.g. "never hardcode credentials", "all routes must have type annotations").

### `init.sh`

```bash
#!/bin/bash
set -e
pip install -r requirements.txt
pytest --tb=short
echo "=== Environment ready ==="
```

Claude Code runs this to verify the project is healthy. It must exit 0.

### `feature_list.json`

```json
{
  "project": "{{PROJECT_NAME}}",
  "features": [
    { "id": "F001", "name": "Project scaffold", "status": "done", "verification": "init.sh passes" },
    { "id": "F002", "name": "Health check endpoint", "status": "pending", "verification": "GET /health returns 200" }
  ]
}
```

Claude Code reads this, builds features one at a time, marks each `done`, and commits after each one.

### `claude-progress.md`

A session log stub. Claude Code appends to it as work progresses so a future session can pick up where it left off.

### Adding a new project type

Create a directory under `~/openclaw-templates/<type>/` with the four files above. The `type` string must match what you say in chat (e.g. "scaffold a **django** project" → looks for `~/openclaw-templates/django/`).

## Development

```bash
npm run build          # compile TypeScript
npm run plugin:build   # compile + package for OpenClaw
npm run plugin:validate
npm test
```

## License

MIT

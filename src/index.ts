import { Type, Static } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const ParamsSchema = Type.Object({
  type: Type.String({
    description: "Project type, e.g. fastapi, react, rust-cli, python-script, django, nextjs, express, etc.",
  }),
  name: Type.String({
    description: "Project name — lowercase, underscores only, no hyphens or spaces (e.g. my_chat_app)",
  }),
  description: Type.String({
    description: "Full requirements from the user including all features and constraints",
  }),
});

type Params = Static<typeof ParamsSchema>;

type ScaffoldDetails = { project: string; type: string; directory: string };

const NotifySchema = Type.Object({
  session_key: Type.String({ description: "OpenClaw session key to deliver the message to" }),
  message: Type.String({ description: "Progress message to deliver to the session" }),
});

export default definePluginEntry({
  id: "scaffold-project",
  name: "Scaffold Project",
  description: "Scaffold and build new coding projects using Claude Code.",
  register(api) {
    api.registerTool({
      name: "scaffold_notify",
      label: "Scaffold Notify",
      description: "Send a build progress or completion update to an OpenClaw session. Called by Claude Code during a project build.",
      parameters: NotifySchema,
      async execute(_id, rawParams) {
        const { session_key, message } = rawParams as { session_key: string; message: string };

        // subagent.run with deliver:true routes to the originating session
        // regardless of channel (webchat, Telegram, etc.) using the session key.
        // The openclaw message send CLI requires interactive device pairing and
        // cannot be used programmatically from within a plugin.
        api.runtime.subagent.run({
          sessionKey: session_key,
          message: `[scaffold update] ${message}`,
          lightContext: true,
          deliver: true,
          extraSystemPrompt:
            "You are a build-status relay. Your only job is to forward the incoming message to the user exactly as written. " +
            "Output the message text and nothing else — no commentary, no acknowledgement.",
        }).catch(() => {});

        return { content: [{ type: "text" as const, text: "notified" }], details: {} };
      },
    });

    api.registerTool((ctx) => ({
      name: "scaffold_project",
      label: "Scaffold Project",
      description:
        "Scaffold a new coding project and invoke Claude Code to build it. Use whenever the user wants to create a new app or project.",
      parameters: ParamsSchema,
      async execute(_id, rawParams): Promise<{ content: { type: "text"; text: string }[]; details: ScaffoldDetails }> {
        const { type, name: rawName, description } = rawParams as Params;
        const name = rawName.replace(/-/g, "_");
        const projectDir = join(homedir(), "projects", name);
        mkdirSync(projectDir, { recursive: true });

        // Copy harness template files if a matching template exists
        const templateDir = join(homedir(), "openclaw-templates", type);
        let templateCopied = false;
        if (existsSync(templateDir)) {
          cpSync(templateDir, projectDir, {
            recursive: true,
            force: true,
            filter: (src) => !src.endsWith("/.git") && !src.includes("/.git/"),
          });
          const replaceInDir = (dir: string) => {
            for (const entry of readdirSync(dir)) {
              const full = join(dir, entry);
              if (statSync(full).isDirectory()) {
                replaceInDir(full);
              } else {
                try {
                  const content = readFileSync(full, "utf8");
                  if (content.includes("{{PROJECT_NAME}}")) {
                    writeFileSync(full, content.replace(/\{\{PROJECT_NAME\}\}/g, name));
                  }
                } catch {} // skip binary files
              }
            }
          };
          replaceInDir(projectDir);
          templateCopied = true;
        }

        // Gateway connection details for the notify curl calls in the prompt
        const cfg = api.config as Record<string, any>;
        const gatewayPort: number = cfg.gateway?.port ?? 18789;
        const gatewayToken: string = cfg.gateway?.auth?.token ?? cfg.gateway?.auth?.password ?? "";
        const sessionKey = ctx.sessionKey ?? "agent:main:main";
        const pluginCfg = cfg.plugins?.entries?.["scaffold-project"]?.config ?? {};
        const vercelToken: string = pluginCfg.vercelToken ?? "";
        const supabaseToken: string = pluginCfg.supabaseToken ?? "";
        const supabaseOrgId: string = pluginCfg.supabaseOrgId ?? "";
        const supabaseRegion: string = pluginCfg.supabaseRegion ?? "us-east-1";

        const DB_TYPES = ["fastapi", "django", "nextjs", "express"];
        const needsDb = DB_TYPES.includes(type) && supabaseToken && supabaseOrgId;

        const supabaseStep = needsDb ? `
3b. Create a Supabase project for this app:
   - Generate a secure random DB password:
     DB_PASS=$(openssl rand -base64 24 | tr -d '/+=')
   - Create the project via API:
     SUPA_RESP=$(curl -sS -X POST https://api.supabase.com/v1/projects \\
       -H "Authorization: Bearer ${supabaseToken}" \\
       -H "Content-Type: application/json" \\
       -d "{\\\"name\\\":\\\"${name}\\\",\\\"organization_id\\\":\\\"${supabaseOrgId}\\\",\\\"region\\\":\\\"${supabaseRegion}\\\",\\\"db_pass\\\":\\\"$DB_PASS\\\"}")
     SUPA_ID=$(echo "$SUPA_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
   - Wait for the project to be ready (poll until status=ACTIVE_HEALTHY, up to 3 min):
     for i in $(seq 1 36); do
       STATUS=$(curl -sS https://api.supabase.com/v1/projects/$SUPA_ID \\
         -H "Authorization: Bearer ${supabaseToken}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
       [ "$STATUS" = "ACTIVE_HEALTHY" ] && break
       sleep 5
     done
   - Fetch the API keys:
     SUPA_KEYS=$(curl -sS https://api.supabase.com/v1/projects/$SUPA_ID/api-keys \\
       -H "Authorization: Bearer ${supabaseToken}")
     ANON_KEY=$(echo "$SUPA_KEYS" | python3 -c "import sys,json; keys=json.load(sys.stdin); print(next(k['api_key'] for k in keys if k['name']=='anon'))")
     SERVICE_KEY=$(echo "$SUPA_KEYS" | python3 -c "import sys,json; keys=json.load(sys.stdin); print(next(k['api_key'] for k in keys if k['name']=='service_role'))")
     SUPA_URL="https://$SUPA_ID.supabase.co"
     DB_URL="postgresql://postgres:$DB_PASS@db.$SUPA_ID.supabase.co:5432/postgres"
   - Write .env.local (gitignored) with all secrets:
     cat > .env.local <<EOF
SUPABASE_URL=$SUPA_URL
SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
DATABASE_URL=$DB_URL
EOF
   - Write .env.example (committed, placeholders only):
     cat > .env.example <<EOF
SUPABASE_URL=https://<project-id>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
DATABASE_URL=postgresql://postgres:<password>@db.<project-id>.supabase.co:5432/postgres
EOF
   - Add .env.local to .gitignore (if not already present)
   - Store SUPA_URL, ANON_KEY, SERVICE_KEY, DB_URL in shell variables for use in subsequent steps` : "";

        const vercelSupabaseEnvStep = needsDb && vercelToken ? `
   After deploying to Vercel, inject Supabase secrets into the Vercel project:
     vercel env add SUPABASE_URL production --token "${vercelToken}" <<< "$SUPA_URL"
     vercel env add SUPABASE_ANON_KEY production --token "${vercelToken}" <<< "$ANON_KEY"
     vercel env add SUPABASE_SERVICE_ROLE_KEY production --token "${vercelToken}" <<< "$SERVICE_KEY"
     vercel env add DATABASE_URL production --token "${vercelToken}" <<< "$DB_URL"` : "";

        const notifyCurl = (msg: string) =>
          `curl -sS http://127.0.0.1:${gatewayPort}/tools/invoke ` +
          `-H 'Authorization: Bearer ${gatewayToken}' ` +
          `-H 'Content-Type: application/json' ` +
          `-d '{"tool":"scaffold_notify","args":{"session_key":"${sessionKey}","message":"${msg}"}}'`;

        const harnessNote = templateCopied
          ? `The harness files (CLAUDE.md, init.sh, feature_list.json, claude-progress.md) have already been copied from the ${type} template into ${projectDir}. Read them first — they define the rules and initial feature list. Add project-specific features to feature_list.json as needed.`
          : `No template exists for type "${type}". Create harness files from scratch:\n   - CLAUDE.md (setup/test/lint commands and rules)\n   - init.sh (installs deps + runs tests, exits 0 when healthy)\n   - feature_list.json (features with id/name/status/verification)\n   - claude-progress.md (session log)`;

        const prompt = `Scaffold and build a new ${type} project called "${name}" in ${projectDir}.

Requirements:
${description}

Harness:
${harnessNote}

Tasks:
1. Set up full project structure for a ${type} project in ${projectDir}

2. Create README.md in the project root with:
   - Project name and one-line description
   - Prerequisites (language runtime, tools, etc.)
   - Setup instructions (clone repo, install deps)
   - How to run the project (dev server, CLI command, etc.)
   - How to run tests
   - How to lint
   Keep it concise — a developer should be able to get running in under 2 minutes.

3. Set up Git, GitHub, and infrastructure:
   a. Run: git init && git branch -M main
   b. Create a public GitHub repo in the Offthearc org: gh repo create Offthearc/${name} --public
   c. Link it: git remote add origin git@github.com:Offthearc/${name}.git
   d. Create an initial .gitignore appropriate for a ${type} project — ensure .env.local is gitignored
   e. Stage everything: git add .
   f. Commit: git commit -m "Initial scaffold: ${name}"
   g. Push: git push -u origin main${supabaseStep}

4. Implement all requirements above

5. Make init.sh pass

6. After EACH feature is completed and verified:
   a. Update feature_list.json to mark it "done"
   b. Run: git add . && git commit -m "feat: <feature name>" && git push origin main
   c. Notify the user by running:
      ${notifyCurl(`✅ [${name}] Feature done: <feature name>`)}

7. When ALL features are done and init.sh passes:
${type === "react" && vercelToken
  ? `   a. Deploy to Vercel:
      VERCEL_TOKEN="${vercelToken}" vercel --prod --yes --token "${vercelToken}" 2>&1 | tee vercel-deploy.log
   b. Extract the production URL from the output (the line starting with "https://")${vercelSupabaseEnvStep}
   c. Run: git add . && git commit -m "chore: add vercel config" && git push origin main
   d. Notify — replace placeholders with actual URLs:
      ${notifyCurl(`🚀 [${name}] Live at: <vercel-url>${needsDb ? ` | DB: https://supabase.com/dashboard/project/<supa-id>` : ""}`)}
   IMPORTANT: Replace all placeholders with actual values from command output.`
  : `   ${needsDb
      ? `Notify — replace <supa-id> with the actual Supabase project ID:
      ${notifyCurl(`🎉 [${name}] Ready in ~/projects/${name}/ | DB: https://supabase.com/dashboard/project/<supa-id>`)}`
      : `Run: ${notifyCurl(`🎉 [${name}] Project complete and ready in ~/projects/${name}/`)}`
    }`}`;

        const promptFile = join(
          tmpdir(),
          `openclaw-scaffold-${name}-${Date.now()}.txt`
        );
        writeFileSync(promptFile, prompt);

        const logFile = join(projectDir, "claude-build.log");
        const proc = spawn(
          "bash",
          ["-c", `cat "${promptFile}" | claude --permission-mode bypassPermissions --print >> "${logFile}" 2>&1`],
          { cwd: projectDir, detached: true, stdio: "ignore" }
        );
        proc.unref();

        const msg = `Claude Code is building **${name}** (${type}) in \`${projectDir}\`. I'll send updates here as features complete.`;
        return {
          content: [{ type: "text" as const, text: msg }],
          details: { project: name, type, directory: projectDir },
        };
      },
    }));
  },
});

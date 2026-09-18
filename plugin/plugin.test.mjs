/**
 * Conformance checks for the OpenViking Agent Plugins 1.0 package.
 *
 * Zero-dependency, runs with `node --test agent-plugins/plugin.test.mjs`.
 * Validates the manifests against the Agent Plugins 1.0 spec
 * (https://agent-plugins.org/specification), skill frontmatter against the
 * Agent Skills spec, and that every referenced/vendored .mjs file exists and
 * parses.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));

const SPEC_VERSION = "1.0.0";
const PLUGIN_SCHEMA_URL = `https://agent-plugins.org/schemas/${SPEC_VERSION}/plugin.schema.json`;
const MCP_SCHEMA_URL = `https://agent-plugins.org/schemas/${SPEC_VERSION}/mcp.schema.json`;

// plugin.json root is closed: only fields documented by the 1.0 spec.
const PLUGIN_ALLOWED_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const AUTHOR_ALLOWED_KEYS = new Set(["name", "email", "url"]);

// name: 1-64 chars, lowercase alphanumeric plus hyphens and periods, no
// consecutive hyphens or periods, starts and ends alphanumeric.
const NAME_RE = /^[a-z0-9](?:[a-z0-9]|[-.](?=[a-z0-9])){0,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function loadJson(relPath) {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, relPath), "utf-8"));
}

// Canonical hook command: a `node -e` bootstrap that locates hook-runner.mjs
// at runtime — env PLUGIN_ROOT first, then cwd, then the documented CLI install
// path — so no host has to expand ${PLUGIN_ROOT} (PowerShell reads it as an
// empty PS variable) or inject the env var. The inline code deliberately
// contains no `$`, backtick, or `"` outside the wrapper quotes: PowerShell,
// bash, and cmd all pass it to node verbatim.
const BOOTSTRAP_JS = "var n=process.argv[1];var c=require('child_process');var fs=require('fs');var p=require('path');var r=['PLUGIN_ROOT','COPILOT_PLUGIN_ROOT','CLAUDE_PLUGIN_ROOT'].map(function(k){return process.env[k]}).filter(Boolean);r.push(process.cwd());r.push(p.join(require('os').homedir(),'.copilot','installed-plugins','openviking-team','openviking-copilot'));for(var i=0;i<r.length;i++){var s=p.resolve(r[i],'scripts','hook-runner.mjs');if(fs.existsSync(s)){process.exit(c.spawnSync(process.execPath,[s,n],{stdio:'inherit'}).status||0)}}process.exit(0)";

function expectedBootstrapCommand(subcommand) {
  return `node -e "${BOOTSTRAP_JS}" ${subcommand}`;
}

function schemaSpecVersion(schemaUrl) {
  const m = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\//.exec(String(schemaUrl));
  return m ? m[1] : null;
}

function listMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listMjsFiles(full));
    else if (entry.endsWith(".mjs")) out.push(full);
  }
  return out;
}

test("plugin.json conforms to Agent Plugins 1.0", () => {
  const manifest = loadJson("plugin.json");

  assert.equal(manifest.$schema, PLUGIN_SCHEMA_URL);

  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.name.length >= 1 && manifest.name.length <= 64, "name must be 1-64 chars");
  assert.match(manifest.name, NAME_RE, "name must be lowercase alphanumeric/hyphens/periods without consecutive separators");
  assert.ok(!/--|\.\./.test(manifest.name), "name must not contain consecutive hyphens or periods");

  for (const key of Object.keys(manifest)) {
    assert.ok(PLUGIN_ALLOWED_KEYS.has(key), `plugin.json root field not in the 1.0 spec: ${key}`);
  }

  if (manifest.version !== undefined) {
    assert.match(manifest.version, SEMVER_RE, "version must be semver");
  }
  if (manifest.author !== undefined) {
    assert.equal(typeof manifest.author, "object");
    for (const key of Object.keys(manifest.author)) {
      assert.ok(AUTHOR_ALLOWED_KEYS.has(key), `author field not in the 1.0 spec: ${key}`);
    }
    assert.equal(typeof manifest.author.name, "string");
  }
  if (manifest.keywords !== undefined) {
    assert.ok(Array.isArray(manifest.keywords));
    for (const kw of manifest.keywords) assert.equal(typeof kw, "string");
  }
  assert.equal(typeof manifest.description, "string");
  assert.equal(typeof manifest.license, "string");
});

test("mcp.json conforms and its spec version matches plugin.json", () => {
  const manifest = loadJson("plugin.json");
  const mcp = loadJson("mcp.json");

  assert.equal(mcp.$schema, MCP_SCHEMA_URL);
  assert.equal(
    schemaSpecVersion(mcp.$schema),
    schemaSpecVersion(manifest.$schema),
    "mcp.json $schema spec version must match plugin.json's",
  );

  for (const key of Object.keys(mcp)) {
    assert.ok(key === "$schema" || key === "mcpServers", `mcp.json root field not in the 1.0 spec: ${key}`);
  }
  assert.equal(typeof mcp.mcpServers, "object");
  assert.ok(Object.keys(mcp.mcpServers).length > 0, "at least one MCP server expected");
});

test("mcp.json server entries are valid and reference files inside the plugin", () => {
  const mcp = loadJson("mcp.json");

  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    if (server.type === "streamable-http") {
      assert.equal(typeof server.url, "string");
      for (const header of Object.keys(server.headers || {})) {
        assert.ok(
          !/authorization|api[-_]?key|token|secret|cookie/i.test(header),
          `server ${name}: headers must not carry credentials (${header})`,
        );
      }
      continue;
    }

    assert.equal(server.type, "stdio", `server ${name}: type must be stdio or streamable-http`);
    assert.equal(typeof server.command, "string");
    // command is a single executable token: no shell strings, and placeholders
    // like ${PLUGIN_ROOT} are only expanded in args/env/cwd, never in command.
    assert.ok(!/\s/.test(server.command), `server ${name}: command must be a single token`);
    assert.ok(!server.command.includes("${"), `server ${name}: placeholders are not expanded in command`);
    if (server.command.startsWith("./")) {
      assert.ok(existsSync(join(PLUGIN_ROOT, server.command)), `server ${name}: plugin-relative command missing`);
    }

    for (const arg of server.args || []) {
      if (!String(arg).includes("${PLUGIN_ROOT}")) continue;
      const expanded = resolve(String(arg).replaceAll("${PLUGIN_ROOT}", PLUGIN_ROOT));
      assert.ok(
        expanded === PLUGIN_ROOT || expanded.startsWith(PLUGIN_ROOT + sep),
        `server ${name}: arg escapes the plugin root: ${arg}`,
      );
      assert.ok(existsSync(expanded), `server ${name}: referenced file missing: ${arg}`);
    }
  }
});

test("every skills/* child ships a SKILL.md with name + description frontmatter", () => {
  const skillsDir = join(PLUGIN_ROOT, "skills");
  const children = readdirSync(skillsDir).filter((entry) =>
    statSync(join(skillsDir, entry)).isDirectory(),
  );
  assert.ok(children.length > 0, "at least one skill expected");

  for (const child of children) {
    const skillPath = join(skillsDir, child, "SKILL.md");
    assert.ok(existsSync(skillPath), `missing ${skillPath}`);
    const raw = readFileSync(skillPath, "utf-8");

    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
    assert.ok(fm, `${child}/SKILL.md must start with YAML frontmatter`);

    const fields = {};
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (kv) fields[kv[1]] = kv[2].trim();
    }
    assert.ok(fields.name, `${child}/SKILL.md frontmatter missing name`);
    assert.ok(fields.description, `${child}/SKILL.md frontmatter missing description`);
    assert.equal(fields.name, child, `${child}/SKILL.md name should match its directory`);
    assert.match(fields.name, NAME_RE);
  }
});

test("relative markdown links inside skills resolve to real files", () => {
  const skillsDir = join(PLUGIN_ROOT, "skills");
  const children = readdirSync(skillsDir).filter((entry) =>
    statSync(join(skillsDir, entry)).isDirectory(),
  );
  for (const child of children) {
    const skillPath = join(skillsDir, child, "SKILL.md");
    const raw = readFileSync(skillPath, "utf-8");
    const links = [...raw.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1]);
    for (const rel of links) {
      assert.ok(
        existsSync(join(skillsDir, child, rel)),
        `${child}/SKILL.md links to missing file: ${rel}`,
      );
    }
  }
});

test("all .mjs files in the plugin pass node --check", () => {
  const files = listMjsFiles(PLUGIN_ROOT);
  assert.ok(files.length > 0, "expected vendored .mjs files");
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf-8" });
    assert.equal(result.status, 0, `node --check failed for ${file}: ${result.stderr}`);
  }
});

test("vendored proxy chain resolves: mcp-proxy.mjs imports exist", () => {
  const proxy = readFileSync(join(PLUGIN_ROOT, "servers", "mcp-proxy.mjs"), "utf-8");
  const imports = [...proxy.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const rel of imports) {
    assert.ok(
      existsSync(join(PLUGIN_ROOT, "servers", rel)),
      `mcp-proxy.mjs import missing: ${rel}`,
    );
  }
});

test("local-tools entry chain resolves: mcp-entry.mjs and skill-tools.mjs imports exist", () => {
  const entry = readFileSync(join(PLUGIN_ROOT, "local-tools", "mcp-entry.mjs"), "utf-8");
  const tools = readFileSync(join(PLUGIN_ROOT, "local-tools", "skill-tools.mjs"), "utf-8");
  for (const [file, rel] of [["mcp-entry.mjs", entry], ["skill-tools.mjs", tools]]) {
    const imports = [...rel.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
    assert.ok(imports.length > 0, `${file} expected relative imports`);
    for (const imp of imports) {
      assert.ok(
        existsSync(resolve(join(PLUGIN_ROOT, "local-tools"), imp)),
        `${file} import missing: ${imp}`,
      );
    }
  }
  // The entry must stay in sync with servers/mcp-proxy.mjs's credential wiring.
  for (const module of ["credentials.mjs", "mcp-proxy-config.mjs", "mcp-proxy-core.mjs"]) {
    assert.ok(entry.includes(module), `mcp-entry.mjs must import shared/${module}`);
  }
});

test("mcp.json points at the local-tools entry so skill tools are exposed", () => {
  const mcp = loadJson("mcp.json");
  const server = mcp.mcpServers.openviking;
  const arg = (server.args || []).find((a) => String(a).includes("${PLUGIN_ROOT}"));
  assert.ok(arg, "openviking server must declare a ${PLUGIN_ROOT} arg");
  const expanded = resolve(arg.replaceAll("${PLUGIN_ROOT}", PLUGIN_ROOT));
  assert.ok(existsSync(expanded), `mcp.json references missing entry: ${arg}`);
  assert.equal(expanded, join(PLUGIN_ROOT, "local-tools", "mcp-entry.mjs"));
});

test("skill tool provider lists add/update/validate/task_status with flat schemas", async () => {
  const { createSkillToolProvider } = await import(join(PLUGIN_ROOT, "local-tools", "skill-tools.mjs"));
  const provider = createSkillToolProvider({ fetchImpl: async () => { throw new Error("must not fetch"); } });
  const tools = provider.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["add_skill", "update_skill", "validate_skill", "task_status"]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name}: schema must be a flat object`);
    assert.equal(typeof tool.inputSchema.properties, "object", `${tool.name}: properties expected`);
    for (const value of Object.values(tool.inputSchema.properties)) {
      assert.equal(typeof value.type, "string", `${tool.name}: property schemas must be flat (single type string)`);
    }
    // required (when present) must only name declared properties
    for (const req of tool.inputSchema.required || []) {
      assert.ok(tool.inputSchema.properties[req], `${tool.name}: required field ${req} not declared`);
    }
  }
  // Unknown tools are not handled locally (proxy forwards them upstream).
  assert.equal(await provider.callTool({ name: "find", arguments: {} }, { config: {} }), null);
});

test("skill tool provider: add_skill posts to the REST endpoint with auth headers", async () => {
  const calls = [];
  const { createSkillToolProvider } = await import(join(PLUGIN_ROOT, "local-tools", "skill-tools.mjs"));
  const provider = createSkillToolProvider({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        status: "ok",
        result: { status: "success", uri: "viking://user/alice/skills/my-skill", task_id: "t-1" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const config = {
    restBaseUrl: "http://ov.test",
    apiKey: "key-1",
    account: "acct",
    user: "alice",
    sendIdentityHeaders: true,
    peerId: "github.com-org-repo",
    userAgent: "openviking-memory-agent-plugins/0.4.0",
    timeoutMs: 5000,
  };
  const result = await provider.callTool(
    { name: "add_skill", arguments: { data: "---\nname: my-skill\ndescription: test\n---\n\n# my-skill\n" } },
    { config },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ov.test/api/v1/skills");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer key-1");
  assert.equal(calls[0].init.headers["X-OpenViking-Account"], "acct");
  assert.equal(calls[0].init.headers["X-OpenViking-Actor-Peer"], "github.com-org-repo");
  assert.deepEqual(JSON.parse(calls[0].init.body), { data: "---\nname: my-skill\ndescription: test\n---\n\n# my-skill\n" });
  assert.equal(result.isError, undefined);
  assert.ok(JSON.stringify(result).includes("viking://user/alice/skills/my-skill"));
});

test("skill tool provider: update_skill PUTs to /skills/{name} and surfaces errors as isError", async () => {
  const calls = [];
  const { createSkillToolProvider } = await import(join(PLUGIN_ROOT, "local-tools", "skill-tools.mjs"));
  const provider = createSkillToolProvider({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        status: "error",
        error: { code: "INVALID_ARGUMENT", message: "Skill parse error: invalid skill metadata" },
      }), { status: 400, headers: { "content-type": "application/json" } });
    },
  });
  const result = await provider.callTool(
    { name: "update_skill", arguments: { skill_name: "my skill/2", data: "x" } },
    { config: { restBaseUrl: "http://ov.test", apiKey: "k", timeoutMs: 5000 } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ov.test/api/v1/skills/my%20skill%2F2");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].init.body), { data: "x" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 400/);
  assert.match(result.content[0].text, /invalid skill metadata/);
});

test("skill tool provider: missing required args and from_source guard return isError", async () => {
  const { createSkillToolProvider } = await import(join(PLUGIN_ROOT, "local-tools", "skill-tools.mjs"));
  const provider = createSkillToolProvider({
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  const config = { restBaseUrl: "http://ov.test", apiKey: "k", timeoutMs: 5000 };

  const noData = await provider.callTool({ name: "add_skill", arguments: {} }, { config });
  assert.equal(noData.isError, true);
  assert.match(noData.content[0].text, /add_skill requires/);

  const noName = await provider.callTool({ name: "update_skill", arguments: { data: "x" } }, { config });
  assert.equal(noName.isError, true);
  assert.match(noName.content[0].text, /skill_name/);

  const noPayload = await provider.callTool({ name: "update_skill", arguments: { skill_name: "s" } }, { config });
  assert.equal(noPayload.isError, true);
  assert.match(noPayload.content[0].text, /data.*from_source|from_source.*data/);

  const noBase = await provider.callTool(
    { name: "add_skill", arguments: { data: "x" } },
    { config: { restBaseUrl: "", timeoutMs: 5000 } },
  );
  assert.equal(noBase.isError, true);
  assert.match(noBase.content[0].text, /REST base URL/);
});

test("skill tool provider: task_status GETs the Task API endpoint", async () => {
  const calls = [];
  const { createSkillToolProvider } = await import(join(PLUGIN_ROOT, "local-tools", "skill-tools.mjs"));
  const provider = createSkillToolProvider({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        status: "ok",
        result: { task_id: "t-1", task_type: "session_commit", status: "completed" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const okRun = await provider.callTool(
    { name: "task_status", arguments: { task_id: "t/1 2", include_events: true } },
    { config: { restBaseUrl: "http://ov.test", apiKey: "k", timeoutMs: 5000 } },
  );
  assert.equal(calls[0].url, "http://ov.test/api/v1/tasks/t%2F1%202?include_events=true");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(okRun.isError, undefined);
  assert.ok(JSON.stringify(okRun).includes("completed"));

  const noId = await provider.callTool({ name: "task_status", arguments: {} }, { config: { restBaseUrl: "http://ov.test", timeoutMs: 5000 } });
  assert.equal(noId.isError, true);
  assert.match(noId.content[0].text, /task_id/);
});

test("skill tool provider: add_skill `path` uploads the local file via temp_upload", async () => {
  const tmpSkill = join(PLUGIN_ROOT, "..", "..", ".tmp-skill-test-SKILL.md");
  writeFileSync(tmpSkill, "---\nname: path-skill\ndescription: uploaded via path\n---\n\n# path-skill\n");
  try {
    const calls = [];
    const { createSkillToolProvider } = await import(join(PLUGIN_ROOT, "local-tools", "skill-tools.mjs"));
    const provider = createSkillToolProvider({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/api/v1/resources/temp_upload")) {
          assert.ok(init.body instanceof FormData, "temp_upload must receive multipart FormData");
          assert.equal(init.headers["Content-Type"], undefined, "fetch must own the multipart boundary");
          assert.equal(init.headers.Authorization, "Bearer k");
          return new Response(JSON.stringify({
            status: "ok",
            result: { temp_file_id: "tmp-9" },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          status: "ok",
          result: { status: "success", uri: "viking://user/alice/skills/path-skill", task_id: "t-2" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const result = await provider.callTool(
      { name: "add_skill", arguments: { path: tmpSkill } },
      { config: { restBaseUrl: "http://ov.test", apiKey: "k", timeoutMs: 5000 } },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "http://ov.test/api/v1/skills");
    assert.deepEqual(JSON.parse(calls[1].init.body), { temp_file_id: "tmp-9" });
    assert.equal(result.isError, undefined);

    const both = await provider.callTool(
      { name: "add_skill", arguments: { path: tmpSkill, data: "x" } },
      { config: { restBaseUrl: "http://ov.test", apiKey: "k", timeoutMs: 5000 } },
    );
    assert.equal(both.isError, true);
    assert.match(both.content[0].text, /exactly one/);

    const missing = await provider.callTool(
      { name: "add_skill", arguments: { path: "/nonexistent/SKILL.md" } },
      { config: { restBaseUrl: "http://ov.test", apiKey: "k", timeoutMs: 5000 } },
    );
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /not found/);
  } finally {
    rmSync(tmpSkill, { force: true });
  }
});

test("uri-guard: denies file tools with viking:// paths, hints on terminal, passes MCP tools", async () => {
  const { decideUriGuard } = await import(join(PLUGIN_ROOT, "scripts", "uri-guard.mjs"));

  // File tool with a viking:// path -> deny with MCP redirection.
  const denied = decideUriGuard({ tool_name: "read_file", tool_input: { filePath: "viking://user/alice/memories/pr.md" } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /openviking MCP tools/);

  // snake_case path keys and other path-like keys are covered too.
  assert.equal(
    decideUriGuard({ tool_name: "create_file", tool_input: { file_path: "viking://user/alice/skills/x/SKILL.md" } })?.hookSpecificOutput?.permissionDecision,
    "deny",
  );

  // openviking MCP tools take viking:// URIs by design -> untouched.
  assert.equal(decideUriGuard({ tool_name: "openviking_read", tool_input: { uri: "viking://user/alice/memories/x.md" } }), null);

  // Search pattern text is never a path -> untouched.
  assert.equal(decideUriGuard({ tool_name: "grep_search", tool_input: { pattern: "viking://usage in docs" } }), null);

  // Terminal command embedding a viking:// string -> allowed with a hint.
  const hinted = decideUriGuard({ tool_name: "runTerminalCommand", tool_input: { command: "curl http://ov/api/v1/content/read?uri=viking://user/a/x.md" } });
  assert.equal(hinted.hookSpecificOutput, undefined);
  assert.match(hinted.systemMessage, /not local files/);

  // No viking:// anywhere -> untouched.
  assert.equal(decideUriGuard({ tool_name: "read_file", tool_input: { filePath: "/home/user/repo/src/main.ts" } }), null);
  assert.equal(decideUriGuard({}), null);
});

test("hooks.json wires the full five-event hook face", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "com.github.copilot", "hooks", "hooks.json"), "utf8")).hooks;
  const events = Object.keys(hooks);
  assert.deepEqual(events.sort(), ["PreCompact", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  const expected = {
    SessionStart: "session-start",
    UserPromptSubmit: "auto-recall",
    PreToolUse: "uri-guard",
    PreCompact: "capture",
    Stop: "capture",
  };
  for (const [event, entries] of Object.entries(hooks)) {
    assert.ok(entries.length > 0, `${event} must declare a hook`);
    for (const hook of entries) {
      assert.equal(hook.type, "command", `${event}: type must be command`);
      assert.equal(hook.command, expectedBootstrapCommand(expected[event]), `${event}: command must be the self-locating bootstrap`);
      assert.ok(typeof hook.timeoutSec === "number" && hook.timeoutSec > 0, `${event}: timeoutSec must be a positive number`);
      assert.ok(existsSync(join(PLUGIN_ROOT, "scripts", "hook-runner.mjs")), `${event}: hook runner missing`);
    }
  }
});

test("hooks.json carries all four command dialects per event", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "com.github.copilot", "hooks", "hooks.json"), "utf8")).hooks;
  const subcommands = { SessionStart: "session-start", UserPromptSubmit: "auto-recall", PreToolUse: "uri-guard", PreCompact: "capture", Stop: "capture" };
  for (const [event, entries] of Object.entries(hooks)) {
    for (const hook of entries) {
      for (const dialect of ["command", "bash", "windows", "powershell"]) {
        const cmd = hook[dialect];
        assert.equal(typeof cmd, "string", `${event}: ${dialect} command required`);
        // All dialects are the same shell-agnostic bootstrap: hosts pick the
        // key they know, and every key resolves the runner at runtime instead
        // of trusting the host to expand ${PLUGIN_ROOT} or inject the env var.
        assert.equal(cmd, hook.command, `${event}: ${dialect} must equal the command bootstrap`);
        assert.ok(cmd.endsWith(` ${subcommands[event]}`), `${event}: ${dialect} must pass the ${subcommands[event]} subcommand`);
        // PowerShell interpolates ${PLUGIN_ROOT} as a PS variable (empty on
        // Windows) and would also expand $env: references; bash interpolates
        // both ${...} and $name. The bootstrap must carry none of these.
        assert.ok(!cmd.includes("$"), `${event}: ${dialect} must not contain shell variable syntax`);
        assert.ok(!cmd.includes("`"), `${event}: ${dialect} must not contain backticks`);
        assert.equal(cmd.split('"').length, 3, `${event}: ${dialect} must quote the -e script exactly once`);
        assert.match(cmd, /^node -e /, `${event}: ${dialect} must be a plain node invocation (no shell wrapper needed)`);
        assert.ok(cmd.includes("scripts','hook-runner.mjs"), `${event}: ${dialect} must target hook-runner.mjs`);
        assert.ok(cmd.includes("installed-plugins"), `${event}: ${dialect} must fall back to the CLI install path`);
      }
    }
  }
});

test("hook runner locates scripts without inherited PLUGIN_ROOT", () => {
  const result = spawnSync(process.execPath, ["./scripts/hook-runner.mjs", "session-start"], {
    cwd: PLUGIN_ROOT,
    input: "{}",
    encoding: "utf-8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "PLUGIN_ROOT")),
  });
  assert.equal(result.status, 0, result.stderr);
});

test("hook command bootstrap resolves hook-runner via env, cwd, then install-path fallback", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "com.github.copilot", "hooks", "hooks.json"), "utf8")).hooks;
  const cmd = hooks.SessionStart[0].command;
  const baseDir = join(os.tmpdir(), `ov-bootstrap-${process.pid}-${Date.now()}`);
  const mark = join(baseDir, "mark");
  const hookStub = `
import { writeFileSync } from "node:fs";
let d = ""; process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  writeFileSync(process.env.MARK, process.argv[1] + "|" + process.argv[2] + "|" + d.trim());
  process.exit(42);
});`;
  const stubAt = (root) => {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "hook-runner.mjs"), hookStub);
    return join(root, "scripts", "hook-runner.mjs");
  };
  const envRoot = join(baseDir, "env-root");
  const cwdRoot = join(baseDir, "cwd-root");
  const fakeHome = join(baseDir, "home");
  const emptyCwd = join(baseDir, "empty");
  stubAt(envRoot);
  stubAt(cwdRoot);
  stubAt(join(fakeHome, ".copilot", "installed-plugins", "openviking-team", "openviking-copilot"));
  mkdirSync(emptyCwd, { recursive: true });
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "PLUGIN_ROOT"));

  const runIn = ({ cwd, env }) =>
    spawnSync("bash", ["-c", cmd], { cwd, env, input: '{"event":"SessionStart"}', encoding: "utf8" });

  // 1. env PLUGIN_ROOT wins even from a foreign cwd with a fallback present.
  rmSync(mark, { force: true });
  let r = runIn({ cwd: emptyCwd, env: { ...baseEnv, HOME: fakeHome, MARK: mark, PLUGIN_ROOT: envRoot } });
  assert.equal(r.status, 42, `env candidate failed: ${r.stderr}`);
  assert.equal(readFileSync(mark, "utf8"), `${join(envRoot, "scripts", "hook-runner.mjs")}|session-start|{"event":"SessionStart"}`);

  // 2. no env: the CLI runs plugin hooks with cwd = plugin dir.
  rmSync(mark, { force: true });
  r = runIn({ cwd: cwdRoot, env: { ...baseEnv, HOME: fakeHome, MARK: mark } });
  assert.equal(r.status, 42, `cwd candidate failed: ${r.stderr}`);
  assert.ok(readFileSync(mark, "utf8").startsWith(join(cwdRoot, "scripts", "hook-runner.mjs")));

  // 3. no env, foreign cwd: the documented CLI install path is the last resort
  //    (~/.copilot/installed-plugins/MARKETPLACE/PLUGIN per the CLI plugin
  //    reference; os.homedir() follows HOME on POSIX and USERPROFILE on Windows).
  rmSync(mark, { force: true });
  r = runIn({ cwd: emptyCwd, env: { ...baseEnv, HOME: fakeHome, MARK: mark } });
  assert.equal(r.status, 42, `install-path fallback failed: ${r.stderr}`);
  assert.ok(readFileSync(mark, "utf8").startsWith(join(fakeHome, ".copilot", "installed-plugins", "openviking-team", "openviking-copilot", "scripts", "hook-runner.mjs")));

  // 4. nothing anywhere: silent no-op (hooks degrade, they never crash a session).
  r = runIn({ cwd: emptyCwd, env: { ...baseEnv, HOME: join(baseDir, "nohome"), MARK: mark } });
  assert.equal(r.status, 0, `no-match case must exit 0: ${r.stderr}`);

  rmSync(baseDir, { recursive: true, force: true });
});

test("capture.mjs queues Stop and PreCompact events without PowerShell", async () => {
  const { queueCaptureEvent } = await import(join(PLUGIN_ROOT, "scripts", "capture.mjs"));
  const baseDir = join(os.tmpdir(), `ov-capture-${process.pid}-${Date.now()}`);
  const event = {
    hook_event_name: "Stop",
    session_id: "s-utf8",
    transcript_path: join(os.tmpdir(), "events.jsonl"),
    cwd: os.tmpdir(),
    timestamp: "2026-09-18T00:00:00Z",
  };
  try {
    const queued = queueCaptureEvent(event, { baseDir, rawInput: JSON.stringify(event) });
    assert.equal(queued, true);
    const queue = readFileSync(join(baseDir, "queue.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(queue, [{
      session_id: "s-utf8",
      transcript_path: event.transcript_path,
      cwd: event.cwd,
      timestamp: event.timestamp,
    }]);
    assert.match(readFileSync(join(baseDir, "events-mirror.jsonl"), "utf8"), /"hook_event_name":"Stop"/);
    assert.equal(queueCaptureEvent({ hook_event_name: "UserPromptSubmit", session_id: "s-utf8" }, { baseDir }), false);
    assert.equal(queueCaptureEvent({ hook_event_name: "PreCompact" }, { baseDir }), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("uploader path resolution accepts VS Code transcript files and CLI session dirs", async () => {
  const { transcriptDirFromQueueEntry } = await import(join(PLUGIN_ROOT, "scripts", "uploader.mjs"));
  // VS Code hands hooks a transcript FILE: transcripts/<session-id>.jsonl.
  // 0.4.6 regression: only events.jsonl counted as a file, so this path gained
  // an appended \events.jsonl and the uploader reported transcript missing.
  const vscodeFile = join("C:", "x", "GitHub.copilot-chat", "transcripts", "a880544b.jsonl");
  assert.deepEqual(transcriptDirFromQueueEntry({ transcript_path: vscodeFile }), { dir: dirname(vscodeFile), file: vscodeFile });
  // CLI session-state layout: the events.jsonl file itself.
  const cliFile = join("C:", "x", ".copilot", "session-state", "s1", "events.jsonl");
  assert.deepEqual(transcriptDirFromQueueEntry({ transcript_path: cliFile }), { dir: dirname(cliFile), file: cliFile });
  // CLI layout, session dir form: still resolves to its events.jsonl.
  const cliDir = join("C:", "x", ".copilot", "session-state", "s1");
  assert.deepEqual(transcriptDirFromQueueEntry({ transcript_path: cliDir }), { dir: cliDir, file: join(cliDir, "events.jsonl") });
  // No transcript_path: falls back to the session-state dir.
  const fallback = transcriptDirFromQueueEntry({ session_id: "s2" });
  assert.equal(fallback.dir, join(os.homedir(), ".copilot", "session-state", "s2"));
});

test("uploader dry-run reads VS Code transcript files end to end (queue + --transcript-dir)", async () => {
  const baseDir = join(os.tmpdir(), `ov-uploader-${process.pid}-${Date.now()}`);
  const transcriptsDir = join(baseDir, "transcripts");
  const sessionId = "vs-e2e-1";
  const transcriptFile = join(transcriptsDir, `${sessionId}.jsonl`);
  mkdirSync(transcriptsDir, { recursive: true });
  writeFileSync(transcriptFile, [
    JSON.stringify({ id: "e1", timestamp: "2026-09-18T00:00:00Z", type: "user.message", data: { content: "帮我看看上传问题" } }),
    JSON.stringify({ id: "e2", timestamp: "2026-09-18T00:00:01Z", type: "assistant.message", data: { turnId: "t1", phase: "final_answer", chunkIndex: 0, content: "已修复" } }),
    "",
  ].join("\n"));
  // Queue-driven run: the capture hook queues the VS Code transcript FILE path.
  const fakeHome = join(baseDir, "home");
  mkdirSync(join(fakeHome, ".openviking", "copilot-capture"), { recursive: true });
  writeFileSync(join(fakeHome, ".openviking", "copilot-capture", "queue.jsonl"),
    `${JSON.stringify({ session_id: sessionId, transcript_path: transcriptFile, cwd: baseDir, timestamp: "2026-09-18T00:00:02Z" })}\n`);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "PLUGIN_ROOT" && k !== "OPENVIKING_URL" && k !== "OPENVIKING_API_KEY" && k !== "OPENVIKING_CLI_CONFIG_FILE")),
    HOME: fakeHome,
    OPENVIKING_URL: "http://127.0.0.1:9", // never contacted: --dry-run returns before any fetch
    OPENVIKING_API_KEY: "k",
  };
  try {
    // Queue path (what the Stop hook actually drives): parses both turns.
    let r = spawnSync(process.execPath, [join(PLUGIN_ROOT, "scripts", "uploader.mjs"), "--dry-run"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`\\[dry-run\\] session ${sessionId}: 2 events -> 2 turns`));
    // Single-session path (--transcript-dir accepting a file): same transcript.
    r = spawnSync(process.execPath, [join(PLUGIN_ROOT, "scripts", "uploader.mjs"), "--session", sessionId, "--transcript-dir", transcriptFile, "--cwd", baseDir, "--dry-run"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`\\[dry-run\\] session ${sessionId}: 2 events -> 2 turns`));
    // Single-session path with a CLI-style session DIR still works.
    const cliDir = join(baseDir, "s-cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, "events.jsonl"), `${JSON.stringify({ type: "user.message", data: { content: "cli turn" } })}\n`);
    r = spawnSync(process.execPath, [join(PLUGIN_ROOT, "scripts", "uploader.mjs"), "--session", "s-cli", "--transcript-dir", cliDir, "--dry-run"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /session s-cli: 1 events -> 1 turns/);
    // Importing the module must not execute main() (guard) — safe to import.
    const mod = await import(join(PLUGIN_ROOT, "scripts", "uploader.mjs"));
    assert.equal(typeof mod.transcriptDirFromQueueEntry, "function");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("auto-recall forwards session_id and injects recall hits (mock server)", async () => {
  const { runRecall } = await import(join(PLUGIN_ROOT, "scripts", "auto-recall.mjs"));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      requests.push({ url: req.url, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        status: "ok",
        result: { entries: [{ uri: "viking://user/alice/memories/deploy.md", score: 0.9, text: "deploy via gh actions" }] },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const prevUrl = process.env.OPENVIKING_URL;
  const prevKey = process.env.OPENVIKING_API_KEY;
  process.env.OPENVIKING_URL = `http://127.0.0.1:${port}`;
  process.env.OPENVIKING_API_KEY = "k";
  try {
    const out = await runRecall({ prompt: "how did we configure the deploy pipeline", cwd: os.tmpdir(), session_id: "s-123" });
    const sent = JSON.parse(requests.find((r) => r.url.includes("/api/v1/search/search")).body);
    assert.equal(sent.session_id, "import__copilot__s-123");
    assert.equal(sent.mode, "context");
    // Conservative auto-recall defaults: no expansion/rewrite (slow stage on
    // the team server), query capped at 400 chars.
    assert.equal(sent.query_expansion, "off");
    assert.equal(sent.rewrite, "off");
    assert.ok(sent.query.length <= 400);
    const longPrompt = "explain the deploy pipeline config ".repeat(60); // ~2100 chars
    await runRecall({ prompt: longPrompt, cwd: os.tmpdir(), session_id: "s-x" });
    const sentLong = JSON.parse(requests.filter((r) => r.url.includes("/api/v1/search/search")).pop().body);
    assert.equal(sentLong.query.length, 400);
    assert.match(out.hookSpecificOutput.additionalContext, /deploy via gh actions/);
    assert.match(out.hookSpecificOutput.additionalContext, /source="auto-recall"/);
    // Trivial prompts never hit the server.
    assert.deepEqual(await runRecall({ prompt: "hi", cwd: os.tmpdir() }), {});
  } finally {
    if (prevUrl === undefined) delete process.env.OPENVIKING_URL; else process.env.OPENVIKING_URL = prevUrl;
    if (prevKey === undefined) delete process.env.OPENVIKING_API_KEY; else process.env.OPENVIKING_API_KEY = prevKey;
    server.close();
  }
});

test("session-start injects profile and memory listings (mock server)", async () => {
  const { runSessionStart } = await import(join(PLUGIN_ROOT, "scripts", "session-start.mjs"));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/system/status") {
      return res.end(JSON.stringify({ status: "ok", result: { user: "alice" } }));
    }
    if (url.pathname === "/api/v1/content/read") {
      return res.end(JSON.stringify({ status: "ok", result: "# profile\n- Alice, backend engineer, prefers terse answers" }));
    }
    if (url.pathname === "/api/v1/fs/ls") {
      const uri = url.searchParams.get("uri") || "";
      if (uri === "viking://user") {
        return res.end(JSON.stringify({ status: "ok", result: [{ isDir: true, name: "alice" }] }));
      }
      return res.end(JSON.stringify({
        status: "ok",
        result: [{ isDir: false, rel_path: "alice/pr_workflow.md", abstract: "team PR review workflow" }],
      }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const prevUrl = process.env.OPENVIKING_URL;
  const prevKey = process.env.OPENVIKING_API_KEY;
  process.env.OPENVIKING_URL = `http://127.0.0.1:${port}`;
  process.env.OPENVIKING_API_KEY = "k";
  try {
    const out = await runSessionStart({ cwd: os.tmpdir(), session_id: "s-1" });
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /source="session-start"/);
    assert.match(ctx, /Alice, backend engineer/);
    assert.match(ctx, /pr_workflow\.md/);
    assert.match(ctx, /team PR review workflow/);
  } finally {
    if (prevUrl === undefined) delete process.env.OPENVIKING_URL; else process.env.OPENVIKING_URL = prevUrl;
    if (prevKey === undefined) delete process.env.OPENVIKING_API_KEY; else process.env.OPENVIKING_API_KEY = prevKey;
    server.close();
  }
});

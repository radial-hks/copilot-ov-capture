#!/usr/bin/env node

/**
 * Local MCP tools for capabilities the server-side MCP surface does not
 * expose.
 *
 * Skill write path: MCP `write` cannot touch `skills/` (writable domain is
 * resources/user/agent, with the user root's `skills/ peers/ privacy/
 * sessions/` read-only), and the documented entries for adding skills are
 * REST / `ov add-skill` / openclaw `add_skill`. add_skill / update_skill /
 * validate_skill here call the same REST API; `path` supports a local
 * SKILL.md file the same way `ov add-skill ./SKILL.md` does (via
 * temp_upload). Task tracking: add_skill / add_resource / session commits
 * are asynchronous — task_status polls the Task API (`ov task status`).
 *
 * It plugs into the vendored proxy core via its `localToolProvider` extension
 * point: `listTools()` entries are appended to the server's `tools/list`
 * (an upstream tool with the same name would be shadowed), and matching
 * `tools/call` requests are executed here instead of being forwarded.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { buildOvHeaders } from "../servers/shared/ov-http.mjs";

const SKILLS_PATH = "/api/v1/skills";
const TEMP_UPLOAD_PATH = "/api/v1/resources/temp_upload";
const DEFAULT_TIMEOUT_MS = 15000;
// `wait=true` blocks on server-side queue processing, which routinely
// exceeds a normal tool-call budget; give it a wider client-side window.
const WAIT_TIMEOUT_MS = 60000;
// Server-side integrity limit for a single skill file.
const MAX_FILE_BYTES = 16 * 1024 * 1024;

const ADD_SKILL = {
  name: "add_skill",
  description:
    "Add a skill to the OpenViking knowledge base. The MCP `write` tool cannot create skills — this is the supported entry. "
    + "Pass exactly one of `data` (a complete SKILL.md document: YAML frontmatter with `name` (kebab-case, <=64 chars of [a-z0-9_-]) and `description`, then the full markdown body; a Git repository / GitHub tree URL is also accepted) "
    + "or `path` (absolute path of a local SKILL.md file, uploaded like `ov add-skill ./SKILL.md`). "
    + "Targets your private skills root (`viking://~/skills`) by default; pass `target_uri` (e.g. `viking://agent/skills` for the account-shared root) to override. "
    + "Returns the skill URI and a background processing `task_id` — check it with task_status.",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "Complete SKILL.md content (frontmatter + markdown), or a Git repository / GitHub tree URL. A structured {name, description, content} object is also accepted.",
      },
      path: {
        type: "string",
        description: "Absolute path of a local SKILL.md file to upload (directories/zip packages are not supported — point at the SKILL.md itself).",
      },
      target_uri: {
        type: "string",
        description: "Skills root to add into. Omit for your private root (viking://~/skills); use viking://agent/skills for the account-shared root (requires permission).",
      },
      wait: {
        type: "boolean",
        description: "Wait for background processing (embedding/vectorization) to finish. Default false: returns the task_id immediately.",
      },
    },
  },
};
const UPDATE_SKILL = {
  name: "update_skill",
  description:
    "Replace an existing skill package in OpenViking. This is a full replacement, not a partial patch: the new content must be a complete SKILL.md "
    + "whose frontmatter `name` matches `skill_name`, and it must include every auxiliary-file-relevant part that should remain. "
    + "The server backs up and validates before replacing. Pass `path` to replace from a local SKILL.md file, or `from_source: true` (alone) to refresh from the recorded Git source.",
  inputSchema: {
    type: "object",
    properties: {
      skill_name: {
        type: "string",
        description: "Name of the existing skill to replace (its frontmatter name, e.g. my-skill).",
      },
      data: {
        type: "string",
        description: "Complete replacement SKILL.md content (frontmatter `name` must equal skill_name). A structured {name, description, content} object is also accepted.",
      },
      path: {
        type: "string",
        description: "Absolute path of a local SKILL.md file to upload as the replacement (directories/zip packages are not supported).",
      },
      from_source: {
        type: "boolean",
        description: "Refresh the skill from its recorded Git source instead of passing new content. Cannot be combined with `data` or `path`.",
      },
      target_uri: {
        type: "string",
        description: "Skills root to resolve the skill in first (private root, then shared root, are the fallbacks).",
      },
      wait: {
        type: "boolean",
        description: "Wait for background processing to finish. Default false.",
      },
    },
    required: ["skill_name"],
  },
};

const VALIDATE_SKILL = {
  name: "validate_skill",
  description:
    "Validate skill data without installing it. Checks frontmatter name/description, YAML syntax, and (with `strict`) name-length/character rules. "
    + "Use before add_skill/update_skill to catch errors cheaply. Returns {valid, errors, warnings}.",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "Complete SKILL.md content to validate. A structured {name, description, content} object is also accepted.",
      },
      strict: {
        type: "boolean",
        description: "Treat warnings (name length/characters, description >1024 chars) as errors. Default false.",
      },
    },
    required: ["data"],
  },
};

const TASK_STATUS = {
  name: "task_status",
  description:
    "Query an OpenViking background task: add_skill / add_resource imports and session commits return a task_id and process asynchronously. "
    + "Statuses: pending / running / cancelling (not terminal) and completed / failed / cancelled (terminal — only `completed` means success). "
    + "Equivalent of `ov task status`.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "Task ID returned by add_skill, add_resource, or a session commit.",
      },
      include_events: {
        type: "boolean",
        description: "Also include persisted execution events (stage transitions, recorded errors). Default false.",
      },
    },
    required: ["task_id"],
  },
};

function textResult(text, isError = false) {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

function okResult(json) {
  // Server envelope is {status: "ok", result: {...}}; surface the payload.
  const payload = json && typeof json === "object" && !Array.isArray(json) && "result" in json
    ? json.result
    : json;
  return textResult(JSON.stringify(payload, null, 2));
}

function errorResult(tool, status, json) {
  const detail = json?.error?.message
    || (json && typeof json === "object" ? JSON.stringify(json) : String(json ?? "").slice(0, 500));
  return textResult(`${tool} failed (HTTP ${status}): ${detail}`, true);
}

function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

export function createSkillToolProvider({ fetchImpl = globalThis.fetch } = {}) {
  const tools = [ADD_SKILL, UPDATE_SKILL, VALIDATE_SKILL, TASK_STATUS];

  async function request(config, path, { method = "POST", body, form, timeoutMs }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    try {
      const headers = buildOvHeaders(config, {
        actorPeerId: config.peerId,
        extraHeaders: config.extraHeaders,
      });
      if (form) delete headers["Content-Type"]; // fetch sets the multipart boundary
      const res = await fetchImpl(`${config.restBaseUrl}${path}`, {
        method,
        headers,
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch { /* non-JSON error body: keep null */ }
      return { status: res.status, ok: res.ok && json?.status !== "error", json };
    } finally {
      clearTimeout(timer);
    }
  }

  function budget(config, args) {
    if (args?.wait === true) return Math.max(Number(config.timeoutMs) || 0, WAIT_TIMEOUT_MS);
    return config.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  // Upload a local SKILL.md via temp_upload, mirroring `ov add-skill ./SKILL.md`.
  async function uploadTempFile(config, path) {
    let st;
    try {
      st = statSync(path);
    } catch {
      return { error: textResult(`Local file not found: ${path}. Directories/zip packages are not supported — point \`path\` at the SKILL.md file itself.`, true) };
    }
    if (st.isDirectory()) {
      return { error: textResult(`\`path\` is a directory (${path}). Directories are not supported — point \`path\` at the SKILL.md file itself.`, true) };
    }
    if (st.size > MAX_FILE_BYTES) {
      return { error: textResult(`File exceeds the 16 MiB limit: ${path} (${st.size} bytes).`, true) };
    }
    const form = new FormData();
    form.append("file", new Blob([readFileSync(path)]), basename(path));
    const uploaded = await request(config, TEMP_UPLOAD_PATH, { form });
    if (!uploaded.ok) return { error: errorResult("temp_upload", uploaded.status, uploaded.json) };
    const tempFileId = uploaded.json?.result?.temp_file_id;
    if (!tempFileId) {
      return { error: textResult(`temp_upload returned no temp_file_id: ${JSON.stringify(uploaded.json).slice(0, 300)}`, true) };
    }
    return { tempFileId };
  }

  // Resolve data|path|from_source into the POST/PUT body; returns {body} or {error}.
  async function resolvePayload(config, args, keys) {
    const body = pickDefined(args, keys);
    if (args.path !== undefined && args.path !== null) {
      if (body.data !== undefined) {
        return { error: textResult("Pass exactly one of `data` or `path`, not both.", true) };
      }
      if (body.from_source === true) {
        return { error: textResult("`from_source` cannot be combined with `path`.", true) };
      }
      const uploaded = await uploadTempFile(config, args.path);
      if (uploaded.error) return uploaded;
      body.temp_file_id = uploaded.tempFileId;
    }
    return { body };
  }

  async function addSkill(args, config) {
    if (args?.data === undefined && (args?.path === undefined || args?.path === null)) {
      return textResult("add_skill requires `data` (SKILL.md content or a Git URL) or `path` (local SKILL.md file).", true);
    }
    const resolved = await resolvePayload(config, args, ["data", "target_uri", "wait"]);
    if (resolved.error) return resolved.error;
    return finish("add_skill", await request(config, SKILLS_PATH, { body: resolved.body, timeoutMs: budget(config, resolved.body) }));
  }

  async function updateSkill(args, config) {
    const name = args?.skill_name;
    if (!name) return textResult("update_skill requires `skill_name`.", true);
    const resolved = await resolvePayload(config, args, ["data", "from_source", "target_uri", "wait"]);
    if (resolved.error) return resolved.error;
    if (resolved.body.data === undefined && resolved.body.temp_file_id === undefined && resolved.body.from_source !== true) {
      return textResult("update_skill requires `data`, `path`, or `from_source: true`.", true);
    }
    return finish(
      "update_skill",
      await request(config, `${SKILLS_PATH}/${encodeURIComponent(name)}`, { method: "PUT", body: resolved.body, timeoutMs: budget(config, resolved.body) }),
    );
  }

  async function validateSkill(args, config) {
    const body = pickDefined(args, ["data", "strict"]);
    if (body.data === undefined) return textResult("validate_skill requires `data`.", true);
    return finish("validate_skill", await request(config, `${SKILLS_PATH}/validate`, { body }));
  }

  async function taskStatus(args, config) {
    const id = args?.task_id;
    if (!id || typeof id !== "string") return textResult("task_status requires `task_id`.", true);
    const qs = args.include_events === true ? "?include_events=true" : "";
    return finish("task_status", await request(config, `/api/v1/tasks/${encodeURIComponent(id)}${qs}`, { method: "GET" }));
  }

  function finish(tool, { status, ok, json }) {
    return ok ? okResult(json) : errorResult(tool, status, json);
  }

  const handlers = {
    [ADD_SKILL.name]: addSkill,
    [UPDATE_SKILL.name]: updateSkill,
    [VALIDATE_SKILL.name]: validateSkill,
    [TASK_STATUS.name]: taskStatus,
  };

  return {
    listTools() {
      return tools;
    },
    async callTool(params, { config } = {}) {
      const name = params?.name;
      const handler = handlers[name];
      if (!handler) return null;
      if (!config?.restBaseUrl) {
        return textResult(`${name} is unavailable: no OpenViking REST base URL resolved. Check ~/.openviking/ovcli.conf.`, true);
      }
      try {
        return await handler(params.arguments ?? {}, config);
      } catch (err) {
        if (err?.name === "AbortError") {
          return textResult(
            `${name} timed out after ${budget(config, params.arguments)}ms. The server may still be processing — retry, or use wait=false and check the task separately.`,
            true,
          );
        }
        throw err;
      }
    },
  };
}
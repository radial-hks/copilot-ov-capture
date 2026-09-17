#!/usr/bin/env node

/**
 * stdio MCP entry for the OpenViking Copilot plugin: the vendored proxy core
 * plus local skill tools.
 *
 * servers/ is overwritten wholesale on upstream sync, so this entry lives in
 * local-tools/. It resolves the connection exactly like servers/mcp-proxy.mjs
 * (same shared credential chain; keep the two readProxyConfig bodies in sync
 * when upstream changes) and hands the proxy core a localToolProvider so the
 * REST-backed skill tools are appended to the server's MCP tool list.
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProxyConnection } from "../servers/shared/credentials.mjs";
import { createLogger } from "../servers/shared/debug-log.mjs";
import { buildMcpProxyConfig, resolveMcpActorPeerId, trimSlash } from "../servers/shared/mcp-proxy-config.mjs";
import { createOpenVikingMcpProxy } from "../servers/shared/mcp-proxy-core.mjs";
import { createSkillToolProvider } from "./skill-tools.mjs";

function readProxyConfig() {
  const cfg = buildProxyConnection("agent-plugins", {
    manifestUrl: new URL("../plugin.json", import.meta.url),
  });
  const shaped = buildMcpProxyConfig({
    baseUrl: cfg.baseUrl,
    mcpUrl: cfg.mcpUrl,
    apiKey: cfg.apiKey,
    account: cfg.account,
    user: cfg.user,
    sendIdentityHeaders: cfg.sendIdentityHeaders,
    peerId: resolveMcpActorPeerId(cfg),
    userAgent: cfg.userAgent,
    timeoutMs: cfg.timeoutMs,
    debug: cfg.debug,
    debugLogPath: cfg.debugLogPath,
    credentialSource: cfg.credentialSource,
    credentialPath: cfg.credentialPath,
    watchedPaths: cfg.watchedPaths,
  });
  // The shaped config only carries mcpUrl; the local REST tools need the API base.
  shaped.restBaseUrl = trimSlash(cfg.baseUrl);
  return shaped;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  createOpenVikingMcpProxy({
    readConfig: readProxyConfig,
    loggerFactory: createLogger,
    localToolProvider: createSkillToolProvider(),
  }).start();
}
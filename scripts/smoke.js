#!/usr/bin/env node
/**
 * Smoke test: boots the server over stdio, lists tools and prompts, and calls
 * openfoot_health (the only tool that works without an API key).
 * Run with: npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../src/index.js");

const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const t of tools) console.log(`  - ${t.name}`);
assert.equal(tools.length, 15, "Expected exactly 15 tools registered");

const { prompts } = await client.listPrompts();
console.log(`prompts (${prompts.length}): ${prompts.map((p) => p.name).join(", ")}`);
assert.equal(prompts.length, 1, "Expected exactly 1 prompt registered");
assert.equal(prompts[0].name, "scout_team_form");

const health = await client.callTool({ name: "openfoot_health", arguments: {} });
console.log("health ->", health.content?.[0]?.text?.slice(0, 300));
assert.equal(health.isError, undefined, "Health check should not be an error");
const healthData = JSON.parse(health.content[0].text);
assert.equal(healthData.data?.status, "operational", "Health status must be operational");

const gated = await client.callTool({ name: "openfoot_competitions", arguments: {} });
console.log("competitions ->", gated.content?.[0]?.text?.slice(0, 300));
assert.equal(gated.isError, true, "Gated call without key must return isError: true");
const gatedData = JSON.parse(gated.content[0].text);
assert.equal(gatedData.error, "missing_api_key");

await client.close();
console.log("\n✅ Smoke test passed all strict assertions.");

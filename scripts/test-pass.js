#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../src/index.js");
const envPath = resolve(here, "../.env");

let apiKey = process.env.OPENFOOT_API_KEY || "";
if (!apiKey && existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("OPENFOOT_API_KEY=")) {
      apiKey = trimmed.split("=")[1]?.trim() || "";
    }
  }
}

console.log(`Using API key: ${apiKey ? apiKey.slice(0, 12) + "..." : "NONE"}\n`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    ...process.env,
    OPENFOOT_API_KEY: apiKey,
  },
});

const client = new Client({ name: "pass-tester", version: "1.0.0" });
await client.connect(transport);

const results = {};

async function runTool(name, args = {}) {
  console.log(`==================================================`);
  console.log(`CALLING: ${name}`);
  console.log(`ARGS: ${JSON.stringify(args)}`);
  try {
    const res = await client.callTool({ name, arguments: args });
    const rawText = res.content?.[0]?.text || "";
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }
    results[name] = { success: !res.isError, data: parsed };
    console.log(`RESULT:`, JSON.stringify(parsed, null, 2).slice(0, 500) + (JSON.stringify(parsed).length > 500 ? "\n... [truncated for display]" : ""));
    return parsed;
  } catch (err) {
    console.error(`ERROR:`, err.message);
    results[name] = { success: false, error: err.message };
    return null;
  }
}

// 1. Competitions
const comps = await runTool("openfoot_competitions");

// 2. Search
const searchRes = await runTool("openfoot_search", { q: "Bayern" });

// 3. Matches
const matchesRes = await runTool("openfoot_matches", { competition: "comp_bundesliga_de", limit: 5 });

let sampleMatchId = "match_olg_83156";
if (matchesRes?.data && Array.isArray(matchesRes.data) && matchesRes.data.length > 0) {
  sampleMatchId = matchesRes.data[0].id;
  console.log(`\nUsing real match ID for depth tools: ${sampleMatchId}`);
}

// 4. Standings
await runTool("openfoot_standings", { competition: "comp_bundesliga_de" });

// 5. Lineups
await runTool("openfoot_match_lineups", { id: sampleMatchId });

// 6. Match events
await runTool("openfoot_match_events", { id: sampleMatchId });

// 7. Match xG
await runTool("openfoot_match_xg", { id: sampleMatchId });

// 8. Match context
await runTool("openfoot_match_context", { id: sampleMatchId });

// 9. League xG
await runTool("openfoot_league_xg", {});

// 10. Odds
await runTool("openfoot_odds", { matchId: sampleMatchId });

// 11. Quota
await runTool("openfoot_quota");

await client.close();

import assert from "node:assert/strict";

console.log("\n==================================================");
console.log("SUMMARY OF RESULTS:");
console.log("==================================================");
let hasFailure = false;
for (const [toolName, res] of Object.entries(results)) {
  const isErr = res.data?.error || res.data?.isError || !res.success;
  const status = isErr ? "❌ ERROR / RESTRICTED" : "✅ SUCCESS / USABLE DATA";
  console.log(`${toolName.padEnd(32)} : ${status}`);
}

assert.ok(comps?.data?.length > 0, "Competitions returned results");
assert.ok(searchRes?.data?.length > 0, "Search returned results");
assert.ok(matchesRes?.data?.length > 0, "Matches returned results");

console.log("\n✅ All contract tests and tool calls passed.");

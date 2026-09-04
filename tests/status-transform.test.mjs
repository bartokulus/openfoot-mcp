import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../src/index.js");

const statusSchema = z
  .enum([
    "scheduled",
    "live",
    "finished",
    "postponed",
    "cancelled",
    "unknown",
    "SCHEDULED",
    "LIVE",
    "FINISHED",
    "POSTPONED",
    "CANCELLED",
    "UNKNOWN",
    "in_play",
    "paused",
    "IN_PLAY",
    "PAUSED",
  ])
  .optional()
  .transform((s) => {
    if (!s) return undefined;
    const lower = s.toLowerCase();
    if (lower === "in_play" || lower === "paused") return "live";
    return lower;
  });

test("statusSchema transforms cancelled and unknown without mapping to postponed", () => {
  assert.equal(statusSchema.parse("cancelled"), "cancelled");
  assert.equal(statusSchema.parse("CANCELLED"), "cancelled");
  assert.equal(statusSchema.parse("unknown"), "unknown");
  assert.equal(statusSchema.parse("UNKNOWN"), "unknown");
  assert.equal(statusSchema.parse("postponed"), "postponed");
  assert.equal(statusSchema.parse("POSTPONED"), "postponed");
  assert.equal(statusSchema.parse("in_play"), "live");
  assert.equal(statusSchema.parse("IN_PLAY"), "live");
  assert.equal(statusSchema.parse("paused"), "live");
  assert.equal(statusSchema.parse("PAUSED"), "live");
  assert.equal(statusSchema.parse("scheduled"), "scheduled");
  assert.equal(statusSchema.parse("SCHEDULED"), "scheduled");
  assert.equal(statusSchema.parse("live"), "live");
  assert.equal(statusSchema.parse("LIVE"), "live");
  assert.equal(statusSchema.parse(undefined), undefined);

  assert.throws(() => statusSchema.parse("invalid_status"));
});

test("MCP server preserves cancelled and unknown status in upstream HTTP requests", async () => {
  const requests = [];
  const mockHttp = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });

  await new Promise((res) => mockHttp.listen(0, "127.0.0.1", res));
  const mockPort = mockHttp.address().port;
  const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, OPENFOOT_BASE_URL: mockBaseUrl, OPENFOOT_API_KEY: "dev-test-key" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  const rl = readline.createInterface({ input: proc.stdout });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // Ignore non-JSON output
    }
  });

  let msgId = 0;
  function callRPC(method, params = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = ++msgId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`MCP RPC timeout for method ${method}`));
      }, 5000);

      pending.set(id, (res) => {
        clearTimeout(timeout);
        if (res.error) rejectPromise(new Error(res.error.message || "RPC Error"));
        else resolvePromise(res.result);
      });

      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  try {
    await callRPC("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-runner", version: "1.0.0" },
    });

    // 1. cancelled (lowercase)
    await callRPC("tools/call", { name: "openfoot_matches", arguments: { status: "cancelled" } });
    assert.equal(requests[requests.length - 1], "/v1/matches?status=cancelled");

    // 2. CANCELLED (uppercase)
    await callRPC("tools/call", { name: "openfoot_matches", arguments: { status: "CANCELLED" } });
    assert.equal(requests[requests.length - 1], "/v1/matches?status=cancelled");

    // 3. unknown (lowercase)
    await callRPC("tools/call", { name: "openfoot_matches", arguments: { status: "unknown" } });
    assert.equal(requests[requests.length - 1], "/v1/matches?status=unknown");

    // 4. UNKNOWN (uppercase)
    await callRPC("tools/call", { name: "openfoot_matches", arguments: { status: "UNKNOWN" } });
    assert.equal(requests[requests.length - 1], "/v1/matches?status=unknown");

    // 5. postponed (lowercase)
    await callRPC("tools/call", { name: "openfoot_matches", arguments: { status: "postponed" } });
    assert.equal(requests[requests.length - 1], "/v1/matches?status=postponed");

    // 6. in_play (maps to live)
    await callRPC("tools/call", { name: "openfoot_matches", arguments: { status: "in_play" } });
    assert.equal(requests[requests.length - 1], "/v1/matches?status=live");

    // 7. PAUSED (maps to live)
    await callRPC("tools/call", { name: "openfoot_matches", arguments: { status: "PAUSED" } });
    assert.equal(requests[requests.length - 1], "/v1/matches?status=live");
  } finally {
    proc.kill();
    mockHttp.close();
  }
});

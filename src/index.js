#!/usr/bin/env node
/**
 * OpenFootAPI MCP server.
 *
 * Exposes the OpenFootAPI football intelligence API (fixtures, standings, lineups,
 * live events, shot-level xG, fair odds) as MCP tools so an LLM client can
 * query real football data instead of hallucinating.
 *
 * Auth: set OPENFOOT_API_KEY (keys use the of_live_ prefix).
 * Free tier: 5,000 requests/month.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.OPENFOOT_BASE_URL ?? "https://openfootapi.com";
const API_KEY = process.env.OPENFOOT_API_KEY ?? "";
const VERSION = "0.1.1";

/** Endpoints that never need a key, so the server is useful before signup. */
const PUBLIC_PATHS = new Set(["/v1/health"]);

async function call(path, query = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  if (!API_KEY && !PUBLIC_PATHS.has(path)) {
    return {
      error: "missing_api_key",
      message:
        "OPENFOOT_API_KEY is not set. Create a free key (5,000 requests/month) at https://openfootapi.com/pricing and put it in the server's env.",
    };
  }

  const headers = { Accept: "application/json", "User-Agent": `openfoot-mcp/${VERSION}` };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    return { error: "network_error", message: String(err?.message ?? err), url: url.toString() };
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 2000) };
  }

  if (res.status === 401) {
    return { error: "unauthorized", status: 401, message: "API key missing, invalid or revoked.", body };
  }
  if (res.status === 403) {
    // Not the same failure as a 401. A 403 here means the key is valid and the plan simply does
    // not include this endpoint — lineups, events, xG, league xG and odds are Developer-tier.
    // Calling that "invalid or revoked" sends the agent, and the user, off to regenerate a key
    // that was never the problem. Pass the upstream sentence through; it names the feature.
    return {
      error: "plan_upgrade_required",
      status: 403,
      message:
        body?.error?.message ??
        "Your plan does not include this endpoint. See https://openfootapi.com/pricing.",
      body,
    };
  }
  if (res.status === 429) {
    return {
      error: "quota_or_rate_limit",
      status: 429,
      message:
        "Rate limit or monthly quota hit. There is no overage billing — the quota resets on the 1st of the month UTC. Check remaining quota with openfoot_quota.",
      body,
    };
  }
  if (!res.ok) return { error: "http_error", status: res.status, body };

  return body;
}

function jsonResult(data) {
  const isErr = Boolean(data && typeof data === "object" && (data.error || data.status >= 400));
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isErr ? { isError: true } : {}),
  };
}

/** Wrap a handler so a thrown error becomes a readable tool result, not a crash. */
function tool(fn) {
  return async (args) => {
    try {
      return jsonResult(await fn(args ?? {}));
    } catch (err) {
      return { content: [{ type: "text", text: `Tool failed: ${String(err?.message ?? err)}` }], isError: true };
    }
  };
}

const server = new McpServer({ name: "openfoot", version: VERSION });

/* ---------------------------------------------------------------- discovery */

server.registerTool(
  "openfoot_competitions",
  {
    title: "List competitions",
    description:
      "List the competitions OpenFootAPI supports, with IDs, country codes, tiers and provider coverage. Use this first when you need a valid competition ID.",
    inputSchema: {},
  },
  tool(() => call("/v1/competitions")),
);

server.registerTool(
  "openfoot_search",
  {
    title: "Search teams and competitions",
    description: "Search for teams or competitions by fuzzy name to find their canonical OpenFootAPI IDs.",
    inputSchema: {
      q: z.string().min(1).describe("Search query, e.g. 'Arsenal', 'Real Madrid', 'Bundesliga'"),
      type: z.enum(["team", "competition"]).optional().describe("Optional filter by entity type"),
    },
  },
  tool(({ q, type }) => call("/v1/search", { q, type })),
);

/* ------------------------------------------------------------------ matches */

server.registerTool(
  "openfoot_matches",
  {
    title: "List matches",
    description:
      "List fixtures and results with scores, kickoff times, status and teams. Filter by competition, team, status, date or season.",
    inputSchema: {
      competition: z.string().optional().describe("Competition ID, e.g. 'comp_premier_league_eng', 'comp_bundesliga_de'"),
      team: z.string().optional().describe("Team ID or fuzzy name"),
      status: z.enum(["SCHEDULED", "LIVE", "IN_PLAY", "PAUSED", "FINISHED", "POSTPONED", "CANCELLED"]).optional(),
      from: z.string().optional().describe("Start date in YYYY-MM-DD format"),
      to: z.string().optional().describe("End date in YYYY-MM-DD format"),
      season: z.string().optional().describe("Season in YYYY/YY format (e.g. '2025/26')"),
      limit: z.number().int().min(1).max(100).optional().describe("Max matches to return (default 50, max 100)"),
    },
  },
  tool(({ competition, team, status, from, to, season, limit }) =>
    call("/v1/matches", { competition, team, status, from, to, season, limit }),
  ),
);

server.registerTool(
  "openfoot_standings",
  {
    title: "Get standings",
    description: "Get the league table for a competition — rank, points, played, won, drawn, lost, goals for/against, goal difference and recent form.",
    inputSchema: {
      competition: z.string().describe("Competition ID, e.g. 'comp_premier_league_eng', 'comp_bundesliga_de'"),
      season: z.string().optional().describe("Season in YYYY/YY format (e.g. '2025/26')"),
    },
  },
  tool(({ competition, season }) => call("/v1/standings", { competition, season })),
);

server.registerTool(
  "openfoot_scorers",
  {
    title: "Get league leaders & top scorers",
    description: "Get top scorers, assists and player card statistics for a competition.",
    inputSchema: {
      competition: z.string().describe("Competition ID, e.g. comp_premier_league_eng, comp_la_liga_es"),
      season: z.string().optional().describe("Season in YYYY/YY format (e.g. 2026/27) or YYYY (e.g. 2026)"),
    },
  },
  tool(({ competition, season }) => call("/v1/scorers", { competition, season })),
);


/* ----------------------------------------------------------- match deep dives */

server.registerTool(
  "openfoot_match_lineups",
  {
    title: "Get match lineups",
    description: "Confirmed starting XI, benches and formations for a match.",
    inputSchema: {
      matchId: z.string().describe("Match ID returned by openfoot_matches"),
    },
  },
  tool(({ matchId }) => call(`/v1/matches/${encodeURIComponent(matchId)}/lineups`)),
);

server.registerTool(
  "openfoot_match_events",
  {
    title: "Get match events",
    description: "Timeline of events in a match: goals, assists, yellow/red cards, substitutions, VAR checks, plus live minute-by-minute text commentary.",
    inputSchema: {
      matchId: z.string().describe("Match ID returned by openfoot_matches"),
    },
  },
  tool(({ matchId }) => call(`/v1/matches/${encodeURIComponent(matchId)}/events`)),
);

server.registerTool(
  "openfoot_match_xg",
  {
    title: "Get match shot map & xG",
    description: "Shot-level Expected Goals data with coordinates on the pitch, shot type, situation (open play, penalty, corner), outcome and cumulative xG.",
    inputSchema: {
      matchId: z.string().describe("Match ID returned by openfoot_matches"),
    },
  },
  tool(({ matchId }) => call(`/v1/matches/${encodeURIComponent(matchId)}/xg`)),
);

server.registerTool(
  "openfoot_match_context",
  {
    title: "Get match context dossier",
    description:
      "A complete pre-match or post-match dossier assembled for analysis: recent form, Elo delta, rest days, head-to-head record and model-derived fair match probabilities.",
    inputSchema: {
      matchId: z.string().describe("Match ID returned by openfoot_matches"),
    },
  },
  tool(({ matchId }) => call(`/v1/matches/${encodeURIComponent(matchId)}/context`)),
);


/* ----------------------------------------------------------------- teams */

server.registerTool(
  "openfoot_team_squad",
  {
    title: "Get team squad roster",
    description: "Full player roster for a team including shirt numbers, positions, ages and coach.",
    inputSchema: {
      teamId: z.string().describe("Canonical team ID, e.g. team_manchester_united_eng or FotMob numeric ID"),
    },
  },
  tool(({ teamId }) => call(`/v1/teams/${encodeURIComponent(teamId)}/squad`)),
);

server.registerTool(
  "openfoot_team_h2h",
  {
    title: "Get head-to-head match history",
    description: "Head-to-head historical meetings between two teams with match outcomes, goal metrics and win/draw rates.",
    inputSchema: {
      teamId: z.string().describe("Canonical team ID of the primary team, e.g. team_arsenal_eng"),
      opponent: z.string().describe("Canonical team ID or name of the opponent team, e.g. team_chelsea_eng"),
      limit: z.number().int().min(1).max(50).optional().describe("Max previous meetings to return (default 10)"),
    },
  },
  tool(({ teamId, opponent, limit }) => call(`/v1/teams/${encodeURIComponent(teamId)}/h2h`, { opponent, limit })),
);

/* ---------------------------------------------------------------- analytics */

server.registerTool(
  "openfoot_league_xg",
  {
    title: "Get league xG analytics",
    description:
      "Season-level Expected Goals analytics for a league — teams ranked by xG generated, xG conceded, over/underperformance vs real goals, and shot efficiency.",
    inputSchema: {
      league: z.string().describe("League code, e.g. 'epl', 'la-liga', 'bundesliga', 'serie-a', 'ligue-1'"),
      season: z.string().optional().describe("Season year (e.g. '2025' for 2025/26)"),
    },
  },
  tool(({ league, season }) => call("/v1/analytics/xg", { league, season })),
);

server.registerTool(
  "openfoot_odds",
  {
    title: "Get match odds",
    description: "Fair 1X2 and over/under 2.5 probabilities derived from underlying team form, Elo delta and xG performance.",
    inputSchema: {
      matchId: z.string().optional().describe("Specific match ID"),
      competition: z.string().optional().describe("Competition ID to list odds for"),
      date: z.string().optional().describe("Date in YYYY-MM-DD format"),
    },
  },
  tool(({ matchId, competition, date }) => call("/v1/odds", { matchId, competition, date })),
);

/* ----------------------------------------------------------------- account */

server.registerTool(
  "openfoot_quota",
  {
    title: "Check API quota",
    description: "Check your API key's tier, monthly request allowance, requests used this month and reset date.",
    inputSchema: {},
  },
  tool(() => call("/v1/account/quota")),
);

server.registerTool(
  "openfoot_health",
  {
    title: "Check upstream health",
    description: "Check the operational status of OpenFootAPI without authentication.",
    inputSchema: {},
  },
  tool(() => call("/v1/health")),
);

/* ------------------------------------------------------------------ prompt */

server.registerPrompt(
  "scout_team_form",
  {
    title: "Scout a team's recent form",
    description: "Build a dossier on a team: recent results, xG trend, upcoming fixtures and key strengths.",
    arguments: [
      {
        name: "team",
        description: "Team name, e.g. 'Arsenal' or 'Bayern Munich'",
        required: true,
      },
    ],
  },
  (args) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please scout ${args.team}. First use openfoot_search to find their team ID, then fetch their last 5 matches using openfoot_matches (with status=FINISHED) and their next fixture (with status=SCHEDULED). If xG is available, summarize their attacking efficiency and defensive stability.`,
        },
      },
    ],
  }),
);

/* ----------------------------------------------------------------- startup */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[openfoot-mcp v${VERSION}] connected to stdio`);
}

main().catch((err) => {
  console.error("Fatal error in openfoot-mcp:", err);
  process.exit(1);
});

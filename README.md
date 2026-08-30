# openfoot-mcp

MCP server for the [OpenFootAPI](https://openfootapi.com/) football intelligence API. Gives an LLM client real football data — fixtures, standings, lineups, live events, **shot-level xG with pitch coordinates**, and model-derived fair odds — instead of a hallucinated scoreline.

12 tools, 1 prompt. Node ≥ 20, no build step.

## Install

```bash
npx openfoot-mcp
```

Set your API key in the environment. Free tier: 5,000 requests/month. Get a key at [openfootapi.com/pricing](https://openfootapi.com/pricing).

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "openfoot": {
      "command": "npx",
      "args": ["-y", "openfoot-mcp"],
      "env": { "OPENFOOT_API_KEY": "of_live_..." }
    }
  }
}
```

### Cursor / Windsurf / any stdio MCP client

Same block, in that client's MCP config file.

## Tools

| Tool | What it returns |
|---|---|
| `openfoot_competitions` | Supported competitions, season metadata, data source and licence per competition |
| `openfoot_search` | Free-text team/competition name → stable IDs |
| `openfoot_matches` | Fixtures and results, filtered by date / competition / team / status / season / round, cursor-paginated |
| `openfoot_standings` | Standings table for a competition and season |
| `openfoot_match_lineups` | Starting XI, bench, formation |
| `openfoot_match_events` | Goals, cards, substitutions, commentary timeline |
| `openfoot_match_xg` | One entry per shot: pitch coordinates + xG value |
| `openfoot_match_context` | Derived context — form, head-to-head, pre-computed signals |
| `openfoot_league_xg` | League xG table: xG for, xG against, over/under-performance vs actual goals |
| `openfoot_odds` | Bookmaker benchmark + implied fair probabilities. Informational, not betting advice |
| `openfoot_quota` | Remaining monthly quota — this call does not consume quota |
| `openfoot_health` | Reachability check. Works without an API key |

Prompt: `scout_team_form` — resolve a team, pull its last 5 matches, read the xG behind the results.

**Start with `openfoot_search`** to resolve IDs. Guessing IDs wastes quota: 404s and empty results are metered like any other request.

## Coverage, stated honestly

The catalogue lists 75 competitions. **Depth is not uniform, and the catalogue is wider than the deep coverage.**

- **Deepest:** Bundesliga, 2. Bundesliga, DFB Pokal, Superliga României
- **Expanded European:** Eredivisie, Primeira Liga, Süper Lig, Pro League, Scottish Premiership
- **Historical / analytics only:** Premier League, La Liga, Serie A, Ligue 1 (xG is Understat-derived)

Call `openfoot_competitions` and check your league before you build on it.

## Quota behaviour

- Free: 5,000 requests/month, 15 req/min. Developer $14/month: 250,000 requests/month, 100 req/min, includes xG, shot maps, lineups, live events and fair odds. Pro $39/month: 2,000,000/month, 250 req/min.
- **No overage billing.** When the quota is spent the API returns 429; this server surfaces that as a `quota_or_rate_limit` error rather than an empty result.
- Quota resets on the 1st of the month, UTC.
- Every request is metered, including 404s and empty results.

## When this is the wrong tool

- **High-frequency live polling across many competitions.** A monthly quota is the wrong shape for it — a per-day or per-second plan elsewhere will cost you less.
- **Leagues outside the deep-coverage list above.**
- **You need a contractual SLA, uptime credits or a named support contact.** Not offered at these prices.

## Development

```bash
npm install
npm run smoke   # boots the server over stdio, lists tools, calls health
```

`npm run smoke` works without an API key: `openfoot_health` returns live status, and a key-gated tool returns a readable `missing_api_key` error so you can tell "not configured" from "broken".

MIT.

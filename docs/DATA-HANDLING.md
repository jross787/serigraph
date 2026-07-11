# Data handling

Meeting transcripts and operating maps are among the most sensitive documents
a business produces — names, rates, compensation-adjacent numbers, legal
exposure. This page states exactly what leaves your machine, when, and how to
run with nothing leaving at all.

## The default posture: nothing leaves

Everything except the ✨ Import feature is pure local computation. Maps,
economics, exports, search, presentation mode — all of it runs offline
forever, with no account, no telemetry, and no network calls. If no LLM
provider is configured, the Import button explains itself and the app is
otherwise fully functional.

## The server binds to localhost only

`npm start` listens on `127.0.0.1`: nothing else on your network can reach
the app, and requests whose `Host` header isn't local are refused (this
blocks DNS-rebinding attacks from web pages you happen to visit). API writes
additionally require `Content-Type: application/json`, so a hostile web page
in the same browser can't forge them as CORS "simple requests."

To *deliberately* share on your LAN (a workshop, a second machine), start
with `node server/main.js --lan` — the console will say so, and you own the
trade-off.

## What the importer sends, and to whom

When you click **Derive the map**, the transcript you pasted is sent from the
**server process** (never the browser) to the *first available* provider:

| Provider | What leaves the machine | Where it goes |
|---|---|---|
| `OPSMAP_MOCK_LLM` (a fixture file) | nothing | nowhere — offline testing |
| `OPSMAP_LLM_CMD` (any local model) | nothing | your own command's stdin |
| `ANTHROPIC_API_KEY` | the transcript + extraction instructions | `api.anthropic.com` |
| logged-in `claude` CLI | the transcript + extraction instructions | Anthropic, via your CLI session |

The transcript is sent once per import (plus at most one corrective retry),
is not stored server-side, and no other feature transmits it. What Anthropic
retains is governed by their [commercial terms](https://www.anthropic.com/legal/commercial-terms);
if that matters for a client engagement, use `OPSMAP_LLM_CMD` with a local
model — **the fully-local path is a first-class provider, not a fallback**,
and an air-gapped machine can run the entire product including import.

## Keys stay server-side

API keys and CLI sessions live in the server process environment. No key is
ever sent to the browser, written into a map, or embedded in an export —
this is a stated design rule (see [DESIGN.md](DESIGN.md) §9) with tests
around the provider chain.

## What your files contain (worth knowing before you share them)

- A map file carries everything you put in it — including `cost:` blocks
  with loaded hourly rates, which are compensation-adjacent. Rates also
  persist in git history once committed.
- A standalone HTML export embeds the **entire map source**, cost data
  included, in one forwardable file. Treat an export like the document it
  is: anyone holding the file sees everything in the map.
- Provenance comments (`# inferred:`) travel with the file too — that is
  their job — so an export shows a client which items were machine-inferred.

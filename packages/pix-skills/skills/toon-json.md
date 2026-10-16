---
name: toon-json
description: Shrinks information-dense JSON for context with jq + TOON. Use when fetching or reading large, repetitive JSON such as LLM schemas, OpenAPI specs, API responses, datasets, and config dumps. Query and reshape with jq, compress to TOON for context, and decode back only when a strict JSON contract requires it.
disable-model-invocation: true
---

# TOON + jq

Carry only the JSON slice you need, in the cheapest encoding: query with `jq`, compress with `toon`, and decode back to JSON only when a contract needs strict JSON. If `toon` is missing, use `jq` alone and ask before you install `@toon-format/cli`.

TOON (Token-Oriented Object Notation, <https://github.com/toon-format/spec>) is a
line-oriented encoding of the JSON data model. Uniform arrays of objects declare
their keys once and stream bare rows, so token cost drops sharply on tabular and
dense data.

## The pipeline

```bash
# Fetch → reshape → compress (most common)
curl -s https://api.example.com/models | jq '.data' | toon

# Local file, show token savings
jq '.paths' openapi.json | toon --stats

# Just compress, no query
toon data.json

# Convert TOON back to JSON (strict contract / downstream parser)
echo "$TOON_BLOB" | toon -d
toon --decode data.toon
```

`toon` auto-detects direction from input. Force it with `-e` (encode JSON→TOON)
or `-d` (decode TOON→JSON).

### Useful flags

- `--stats` — print token/byte statistics for the conversion
- `--delimiter=<d>` — array delimiter: `,` (default), `\t`, or `|`. Tab or pipe can tokenize better.
- `--keyFolding=safe` — collapse single-key nesting chains
- `--no-strict` — lenient decode

## Decide before you compress

TOON is not always smaller. Pick based on shape:

| Shape | Action | Why |
|---|---|---|
| Uniform array of objects (same keys, primitive values) | **TOON** | Sweet spot — keys declared once, rows streamed; savings scale with rows × fields |
| Flat object / primitive array | **TOON** | Drops quotes and braces |
| Shallow nesting | **TOON** | Indentation cheaper than braces at low depth |
| Deeply nested / non-uniform | **JSON** | Indentation cost grows; compact JSON can win |
| Array of arrays | **JSON** | TOON's one structurally-worse case (explicit list markers + inner headers) |
| API contract / payload to send or store | **JSON** | Must stay valid JSON for the consumer |

Rule: **TOON for reading dense data into context. JSON for contracts.** Skip TOON for tiny payloads too. In every JSON case, still slice with `jq`; just drop `| toon`.

## Worked examples

LLM model list (uniform array → great TOON candidate):

```bash
curl -s https://api.example.com/v1/models | jq '.data | map({id, owned_by, context})' | toon
```

```
[3]{id,owned_by,context}:
  gpt-x,acme,128000
  gpt-y,acme,200000
  gpt-z,acme,1000000
```

OpenAPI paths summary (reshape first, then compress):

```bash
jq '[.paths | to_entries[] | {path: .key, methods: (.value | keys)}]' openapi.json | toon --stats
```

Round-trip back to JSON for an API call (confirm with the user before any POST):

```bash
toon -d payload.toon | curl -s -X POST https://api.example.com/ingest -H 'Content-Type: application/json' --data-binary @-
```

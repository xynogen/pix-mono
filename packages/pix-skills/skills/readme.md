---
name: readme
description: Creates or updates a project README in a fixed, deployment-focused style with required sections, env-var tables, and an enforced tone. Use when asked to write, rewrite, or update a README or project docs for setup and deployment.
disable-model-invocation: true
---
# README

Audience: a deployment engineer or new developer who must run the project in five minutes and know which settings are safe to change in production.

## 1. Gather inputs

- **Existing README** → read it first; it is the source of truth for name, purpose, and endpoints. Keep its facts. Show the diff and get confirmation before you overwrite a non-trivial one.
- **Scan** `.env.example`, route files, `docker-compose.yml`, task runner files (`justfile`, `Makefile`, `mise.toml`, `Taskfile.yml`, `package.json`), and the main entrypoint.
- **Never invent** env var names, endpoints, defaults, ports, or commands. If a required input is still unknown, ask before you write.

Following inputs MUST be identified before drafting:

| # | Input | Notes |
|---|---|---|
| 1 | Service/library name, language, one-line purpose | What it accepts, what it produces |
| 2 | Key operational characteristics | Latency, concurrency, multi-tenancy — 1-2 sentences max |
| 3 | Runtime requirements | Language version, native deps, CLI tools |
| 4 | Entrypoint command + local run | Task runner recipes if present (`just`, `make`, `mise`, `npm`) |
| 5 | Environment variables | Split into three buckets (see Phase 2) |
| 6 | Container workflow | Whether `docker-compose.yml` or `Dockerfile` exists |
| 7 | Authentication scheme | Exact login endpoint, header format, fallbacks (query param, cookie) |
| 8 | HTTP/API surface | Grouped by feature area; common request envelope or response shape |
| 9 | Interactive docs URL | Swagger/OpenAPI/Storybook if served |
| 10 | Development task-runner recipes | `test`, `codegen`, `tidy`, `lint` |
| 11 | License | Exact license name |

## 2. Environment variable buckets

Split every env var into exactly one of these three buckets. Bucket empty for project → OMIT its table, don't pad with empty rows.

| Bucket | Table Columns | Purpose |
|---|---|---|
| Required application secrets | `Variable` (left-aligned `\|:---\|`), `Description` | No defaults — must be set before running |
| Infra-tunable runtime values | `Variable` (left-aligned `\|:---\|`), `Default` (right-aligned `\|---:\|`), `Description` | Sensible defaults, safe to override per environment |
| Optional feature toggles / external integrations | `Variable` (left-aligned `\|:---\|`), `Default` (right-aligned `\|---:\|`), `Description` | Feature flags, third-party API keys |

## 3. Sections, in order

1. `# <Full Name> (<Acronym>)` — acronym only if one exists.
2. Opening paragraph (2-3 sentences): what service is, what it ingests, what it emits.
3. Separate short paragraph: key operational characteristics.
4. `## Table of Contents` — bulleted list of section headings below.
5. `## Requirements` — bullet list of runtime prerequisites.
6. `## Quick Start` — copy `.env.example` → `.env`, set minimum required vars, then run command(s). Show a secret-generation command that fits the secret type. End with the default listen address.
7. `## Environment Configuration` — one orienting sentence, then three env tables in bucket order. Close with one-paragraph note about keeping `.env` out of git and injecting via platform secrets in deployments.
8. `## Docker Compose` — ONLY if compose file exists. One sentence describing what it does, the `docker compose up --build` command, note that deployment platforms can supply same vars directly.
9. `## Authentication` — login endpoint as `text` code block, then both auth methods (bearer header preferred, query param fallback) in separate code blocks.
10. `## API Overview` — JSON response envelope as `json` code block, then single table grouping endpoints by feature area (columns: `Group`, `Endpoints`). Below table, short paragraph naming common query parameters spanning multiple endpoints.
11. `## Documentation` — one sentence, then interactive docs URL in `text` code block.
12. `## Development` — `bash` code block listing most-used task-runner recipes (`test`, `codegen`, `tidy`), then one-line note about where annotations or generated artifacts live.
13. `## License` — one line.

## 4. Style

- **PROSE**: Plain factual. No marketing words ("blazing fast", "powerful", "easy", "simple"). No emojis. No badges. No screenshots.
- **ORIENTING SENTENCE**: Each section opens with one sentence before code, lists, or tables, unless section 3 says it opens with a code block.
- **TABLES OVER BULLETS**: Use tables for structured data (env vars, endpoints). Never use bullet lists for things with columns.
- **CODE FENCES**: Always carry explicit language tag, but stick to widely-supported ones (`bash`, `text`, `json`, `yaml`, `sql`). Avoid obscure tags like `http`, `dotenv`, `ini` — renderers (GitLab, some Markdown viewers) flag them unsupported, display block in red. Use `text` for raw HTTP request lines / headers or env files, `bash` for `curl` examples.
- **CONCRETE DEFAULTS**: Show actual values inline (`8080`, `30`, `10485760`). Never write "configurable" without actual default.
- **ENV FORMAT**: Value belongs in `.env` → show as real assignment, not prose.
- **ENDPOINTS**: In tables use backticks. HTTP methods uppercase, inside backticks: `` `GET /api/streams` ``.
- **OMIT**: No "Contributing", "Acknowledgments", "What is X?", or "About" sections unless explicitly requested.

## 5. Omit when

- An env bucket is empty → omit its table.
- No compose file → omit `## Docker Compose`.
- No auth → omit `## Authentication`.
- No served interactive docs → omit `## Documentation`.
- Library with no HTTP API → omit `## Authentication` and `## API Overview`; add `## Usage` with a minimal code example.
- Multi-language monorepo → ask which component the README targets.

## Report

After writing, output final file path and one-line summary of which optional sections omitted (and why).

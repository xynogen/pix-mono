---
name: pix-web
description: How to use the `web` tool well — search, then fetch only the pages that matter, with small character budgets. Use before web research, reading docs or changelogs, or checking a library's current API.
disable-model-invocation: true
---
# web — search and fetch

One tool, two actions:

| Action | Fields | Returns |
|---|---|---|
| `search` | `query`, `search_type?` (`web`\|`news`), `max_results?` (1-10, default 5) | numbered title, URL, snippet |
| `fetch` | `url`, `format?` (`markdown`\|`text`\|`html`), `max_characters?` (default 1000, `0` = all, hard cap 20000) | page as plain text |

Providers and models are user settings (`/pix web`). Never pick one per call.

## Pattern

1. `search` with the exact terms you would type into a search engine: product name, version, error text in quotes.
2. Read the snippets. Pick one to three URLs; prefer official docs, release notes, and the source repository.
3. `fetch` each with a small `max_characters` (1000-3000). Raise it only for the one page you must read in full.
4. Cite the URL you used in the answer.

In history, 1,456 fetch and 1,175 search calls had almost no errors. Waste came from fetching many pages with large budgets, not from failures.

## Do

- Batch independent fetches in one `codemode` call with `Promise.allSettled`, and keep only the lines you need.
- Use `search_type: "news"` for recent events and releases.
- Fetch a GitHub file through its raw URL (`raw.githubusercontent.com/...`) to skip page chrome.

## Do not

- Fetch without a reason to read the page; the snippet often answers.
- Set `max_characters: 0` on large pages. Raise the budget step by step.
- Use `web` for local files (`read`) or for a git repository you need to explore (clone it, with permission).
- Retry a failed provider by hand. The runner already falls back to the next configured provider.

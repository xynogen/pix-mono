---
name: tldr
description: Maximum-density technical summary of workflows and purposes. Use when user asks "tldr", "summarize this", "give me the short version", "what's the gist", or needs the essence fast with zero filler.
disable-model-invocation: true
---
# TLDR

Goal: the reader gets the full picture in the fewest tokens.

## Rules

- Read the source first. Never summarize from a name or title.
- Technical content only. No greeting, preamble, or closing line.
- Lead with the key point. Name each key workflow and its purpose in one line.
- Include the config, data, and assumptions that matter.
- One fact per bullet. Never state a fact twice.
- Mark each uncertain claim with a confidence level.

## Format

```
**[Subject]**
- [Core fact]
- [Config/data] — `value`
- ⚠️ [Uncertain point] (confidence: X%)
```

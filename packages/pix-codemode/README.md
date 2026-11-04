<p align="center">
  <img src="https://raw.githubusercontent.com/xynogen/pix-mono/main/.github/assets/pix-logo.svg" alt="Pix" width="152" height="80">
</p>

# pix-codemode

Standalone renderers for Pi’s built-in `codemode` and `tool_search` tools. Scripts use JavaScript syntax highlight. Results show formatted JSON, nested calls, and Pix result frames. Nested-call rows fill the width and fade long arguments. Long previews fade out at the bottom and end with `… +N lines (ctrl+o to expand)`. Expand a card to see the complete script and result.

```sh
pi install npm:@xynogen/pix-codemode
```

Enable the tool with `"defaultTools": ["+codemode"]` in Pi settings. The package does not change activation or execution.

Pi can show a replacement warning for its built-in extension. Add `"-builtin:codemode"` to `settings.extensions` to disable that duplicate. This package registers the native tool through Pi’s public factory.

Requires a Pi host that exports `createCodemodeExtension`. Unsupported hosts receive one warning. The native output header and nested-call details are host-specific. Unknown output formats remain plain text.

# @xynogen/pix-codemode

Standalone renderers for Pi’s built-in `codemode` tool. Scripts use JavaScript syntax highlight. Results show formatted JSON, nested calls, clipped previews, and Pix result frames. Expand a card to see the complete script and result.

```sh
pi install npm:@xynogen/pix-codemode
```

Enable the tool with `"defaultTools": ["+codemode"]` in Pi settings. The package does not change activation or execution.

Pi can show a replacement warning for its built-in extension. Add `"-builtin:codemode"` to `settings.extensions` to disable that duplicate. This package registers the native tool through Pi’s public factory.

Requires a Pi host that exports `createCodemodeExtension`. Unsupported hosts receive one warning. The native output header and nested-call details are host-specific. Unknown output formats remain plain text.

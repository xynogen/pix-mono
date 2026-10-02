# pix-voice

Provider-neutral speech for Pi: push-to-talk dictation into the prompt
(`Ctrl+Alt+Z`), plus the `transcribe` and `speak` tools.

## Tools

The model calls the tools with these fields:

```ts
transcribe({ file: string, output_file?: string, language?: string });
speak({ input: string, output_file?: string });
```

The user picks the provider, the model, and playback in `/voice`. The model
gives only the input. Every result names the provider and model that ran. There
is no silent fallback to another provider.

For most TTS providers, a model is `model/voice`, for example
`gpt-4o-mini-tts/nova`. Some providers return `wav` or `mp3` for every request.
The tool names the saved file by the real format and reports a mismatch.

## Providers

The set follows the direct adapters in 9Router.

| Provider | STT | TTS | Environment |
|---|---|---|---|
| `9router` | yes | yes | `NINEROUTER_URL`, `NINEROUTER_KEY` |
| `openai` | yes | yes | `OPENAI_API_KEY` |
| `groq` | yes | | `GROQ_API_KEY` |
| `deepgram` | yes | | `DEEPGRAM_API_KEY` |
| `assemblyai` | yes | | `ASSEMBLYAI_API_KEY` |
| `gemini` | yes | yes | `GEMINI_API_KEY` |
| `huggingface` | yes | | `HF_TOKEN` |
| `nvidia` | yes | yes | `NVIDIA_API_KEY` |
| `elevenlabs` | | yes | `ELEVENLABS_API_KEY` |
| `minimax`, `minimax-cn` | | yes | `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY` |
| `fish-audio` | | yes | `FISH_AUDIO_API_KEY` |
| `cartesia` | | yes | `CARTESIA_API_KEY` |
| `inworld` | | yes | `INWORLD_API_KEY` |
| `openrouter` | | yes | `OPENROUTER_API_KEY` |
| `xiaomi-mimo` | | yes | `XIAOMI_API_KEY` |
| `selfhosted` | yes | yes | `SELFHOSTED_STT_URL`, `SELFHOSTED_TTS_URL`, `SELFHOSTED_API_KEY` (optional) |

`auto` uses the first configured provider in the table order. The `9router`
provider also reaches the providers that are not direct adapters here, for
example `edge-tts`, `google-tts`, and `aws-polly`.

## Settings

Run `/voice`. The modal stays open until you press esc, and each change saves at
once. Rows with a list open it in the modal: type to filter, then press enter.

| Row | Value |
|---|---|
| provider | STT or TTS provider, or `auto` |
| 9router model | The model 9Router runs. Other providers use their default model. |
| microphone | An input by name, or `System default` |
| test microphone | A live level meter. Nothing is recorded. |
| language | A code such as `en`, `id`, or `pt-br`, or `auto` |
| cleanup model | `off`, `current`, or `provider/model`. See [Cleanup](#cleanup-optional). |
| dictation key | Any Pi key id. Needs a Pi restart. |
| play after generation | Play `speak` output. ffmpeg plays it on Linux and macOS. Windows uses the built-in PowerShell `MediaPlayer` |

Settings live in `~/.pi/agent/pix.json` under `voice`. This example shows the section value:

```json
{
  "sttProvider": "9router",
  "ttsProvider": "9router",
  "sttNineRouterModel": "dg/nova-3",
  "ttsNineRouterModel": "edge-tts/en-US-AriaNeural",
  "ttsPlay": true,
  "sttDevice": "default",
  "sttLanguage": "auto",
  "sttShortcut": "ctrl+alt+z",
  "sttCleanup": "off"
}
```

Startup imports `voice.json` into unified config and preserves existing `pix.json.voice` values.
After a successful save, the old file becomes `voice.json.migrated-v1`.

## Dictation

Hold `Ctrl+Alt+Z`, talk, and let go. The transcript goes into the prompt at the
cursor, and nothing is sent. Esc while it records or transcribes cancels the
dictation, and nothing goes into the prompt. After the text is in, Ctrl+- (the
editor undo) removes it. A tap (under 0.3 s) starts a
recording that stays on until the next press, for long dictation. A recording
stops at 5 minutes and is then transcribed. A transcript over 1,000 characters
shows as a `[paste #1 … chars]` marker, the same as a large paste.

Hold-to-talk needs a terminal with the Kitty keyboard protocol, for example
Kitty, Ghostty, WezTerm, foot, or iTerm2 3.5+. Other terminals, and tmux, do not
report a key release. There, each press toggles the recording. `/stt` also
toggles it.

A widget above the editor shows the microphone and its level while it records.
The recording is deleted after transcription. A set `language` is often faster
and more accurate than `auto` for short speech.

Requirements: `ffmpeg` lists and records microphones on Linux, macOS and
Windows. Without `ffmpeg`, only `System default` shows.
On Linux and Windows, a missing `ffmpeg` downloads the BtbN LGPL
build (~120 MB, checksum-verified) on the first recording, into `~/.pi/agent/bin`, with a visible
status. Try again once it finishes. Tools are found through
`~/.pi/agent/binary.json` → `~/.pi/agent/bin` → `PATH`.

Requirements (Windows): `ffmpeg` records a DirectShow input and lists the
inputs by name. `System default` means the first listed input. A missing
`ffmpeg` downloads the same way, or run `winget install Gyan.FFmpeg`.

### Cleanup (optional)

`cleanup model` runs one small LLM pass over each transcript before it goes into
the prompt. It removes the slips of live speech and keeps the words and language:

| Said | Prompt gets |
|---|---|
| i want 3 of it, no i meant 2 | I want 2 of it. |
| um so can you uh open the the config file, sorry, the package json | Can you open the package json? |
| saya mau 3, eh bukan, maksudnya 2 | saya mau 2 |

It is `off` by default, because each dictation then costs one model call. The
prompt is about 250 tokens plus the transcript. A router can add more: the
9Router `cc/` route used about 2.4k per call. Pick a fast model, because
dictation waits for the reply. Pick `current` for the session model, or any
`provider/model`.
The message after each dictation names the cleanup model and its token count.
If the pass fails, or gives a much longer text (an answer, not a cleanup), the
raw transcript stays in the prompt.

A quick word check runs first. When the transcript has no filler, correction
word, or repeated word, the model call is skipped, and the message says so. The
list covers English, Indonesian, Malay, and some European fillers. A slip in
another language is not found, so that dictation gets no cleanup.

## Custom providers

```ts
import { registerProvider } from "@xynogen/pix-voice/providers";

registerProvider("stt", {
  id: "example",
  defaultModel: "example-1",
  env: ["EXAMPLE_API_KEY"],
  isConfigured: () => Boolean(process.env.EXAMPLE_API_KEY),
  transcribe: async ({ file, model, language, signal }) => "transcript",
});
```

## Attribution

The push-to-talk dictation design comes from
[earendil-works/pi-voice](https://github.com/earendil-works/pi-voice) (MIT): a
shortcut starts and stops the recording, and the transcript goes into the
prompt. That package runs a local model. `pix-voice` sends the audio to the
provider you pick in `/voice`. No code is copied. Thanks to the pi-voice
authors.

## Install

```bash
pi install npm:@xynogen/pix-voice
```

> Standalone and opt-in. [`@xynogen/pix-core`](https://www.npmjs.com/package/@xynogen/pix-core) does not bundle it. Each provider needs its own API key.

## Full distro

This package is part of [Pix](https://github.com/xynogen/pix-mono). The installer sets up Pi and the full distro. See [Install](https://github.com/xynogen/pix-mono#install) for the notes for each OS.

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.ps1 | iex
```

## License

MIT. See [LICENSE](LICENSE).

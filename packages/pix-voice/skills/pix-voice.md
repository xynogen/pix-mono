---
name: pix-voice
description: How to use `speak` and `transcribe` through the user's configured voice provider — short spoken output, audio files to text with the right language, and long transcripts written to a file. Use for speech playback or turning a recording into text.
disable-model-invocation: true
---
# speak / transcribe — voice provider tools

The provider, model, and playback are the user's choice in the `/pix` Voice tab. The model supplies only the input. Every result names the provider and model that ran; there is no silent fallback, so an unconfigured provider is an error to report, not a reason to switch.

## speak

`{ "input": "text", "output_file": "path.mp3" }` — speaks the text aloud, or saves the audio when `output_file` is set (default: a temp file). Keep the text short: this is for a sentence or two, not a document.

## transcribe

`{ "file": "path.wav", "output_file": "path.txt", "language": "en" }` — turns an audio file into text.

- Inline text is capped at 50,000 characters. For a longer recording, pass `output_file`: the full text goes there and only a summary comes back.
- `language` is an ISO 639-1 code (`en`, `id`). Set it when the audio is not English; auto-detect is less reliable on short clips.
- Provider coverage differs: some support STT only, some TTS only. `auto` uses the first provider that is configured, in the documented order.

## Do not

- Speak long text to "read it out". Quote the part that matters.
- Retry a failing provider call unchanged, or route around it. Report the provider and the error. Missing credential (`OPENAI_API_KEY`, `GEMINI_API_KEY`, …) is the usual cause.
- Transcribe a huge recording inline and expect the whole transcript back. Use `output_file`.

# mc image — one image on the Codex plan

`mc image --prompt "<text>" --out <file>` makes one image with OpenAI's image
generation through Codex and prints the copied file's absolute path. Martin
asked for it at the desk on 2026-11-24, with one condition: it runs on his
Codex plan subscription, the way the other headless mc Codex calls do, and
never on an API key.

The verb is [`src/mc/commands/image.js`](../../src/mc/commands/image.js); its
tests are `tests/mc/commands/image.test.js`.

## The forms

```
mc image --prompt "<text>" --out <file> [--input <image>]… [--transparent]
         [--model <codex-model>] [--image-model <name>] [--force]
```

- `--input` is a reference image, repeatable. Each must be a file; it is
  given to the session as an absolute path for the tool's
  `referenced_image_paths`.
- `--transparent` asks for `transparent_background`.
- `--model` is the Codex text model that drives the call, not the image
  model: `luna`, `sol` or `terra` resolve to the newest slug of that family in
  Codex's own catalog (`$CODEX_HOME/models_cache.json`, else
  `codex debug models`), or a catalog slug is named whole. `luna` is the
  default and the effort is `low`: the model only has to call one tool.
- `--force` replaces an existing file at `--out`; without it the call is
  refused before anything starts.

## What runs

One headless `codex exec`, launched as the other headless calls launch Codex
(`headlessArgs`, the adapter's `danger-full-access` sandbox), with the session
identity and every provider API key taken out of its environment and
`MC_HEADLESS=1`. Its working directory is an empty scratch directory,
`~/mc/runner/images/<id>/`, removed afterwards. The prompt is a short fixed
instruction — call the built-in `image_gen` tool once; no shell, script,
skill, CLI fallback, API call or file edit; answer `done` — followed by the
user's prompt verbatim. The limit is five minutes.

Codex writes the image under `$CODEX_HOME/generated_images/<session id>/`.
mc takes the newest file there (the session id is the thread id Codex
reports), or, when that directory has none, the newest file under any
`generated_images/*` written since the launch, and copies it to `--out`,
making its parent directories. The model is never relied on to copy the file
itself. The run is one `kind: image` row in the desk run log.

## Plan only

The call is refused (exit 1) before any session when the Codex billing route
(`billingRouteNow`) is anything but `plan`, or when Codex's `auth.json` says
it is not logged in with ChatGPT. There is no API or credits fallback for an
image: an image never silently costs API money. The same reason keeps the
session off the `$imagegen` skill's CLI fallback (`scripts/image_gen.py`),
which needs `OPENAI_API_KEY`.

## The image model cannot be chosen

The built-in tool's schema is `image_gen({ prompt, referenced_image_paths?,
transparent_background?, num_last_images_to_include? })`: it has no model
field, and the image model is chosen on OpenAI's side. `--image-model <name>`
is therefore only an instruction in the session's prompt, and mc says so on
stderr every time it is given: the choice is passed on and cannot be
confirmed.

## Exit codes

0 with an image (its path alone on stdout); 1 refused (not on the plan, not
logged in with ChatGPT, `--out` exists) or no image (a timeout, a failed
exit, no file); 2 a bad argument.

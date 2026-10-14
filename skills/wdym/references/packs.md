# Packs: teach wdym your team's words

The core reads English prompts. A pack adds your own words on top: another language, your
team's shorthand, the phrases you already know you misread. A pack only adds; it never
deletes a core rule.

## Point wdym at a pack

`~/.jtl/wdym/config.json` (or any file you pass with `--config` or `WDYM_CONFIG`):

```json
{
  "pack": "./my-pack",
  "ledger": "./reads.jsonl",
  "state_dir": "./state"
}
```

Relative paths resolve from the config file's folder. `node scripts/wire.mjs apply --config <file>`
writes the hook with that config, so every prompt reads through your pack.

## Files in a pack folder

All optional. A file that exists but will not parse is an error, never a silent fallback.

### `pack.json`

| Key | Shape | What it does |
|---|---|---|
| `tells` | `[{ "id", "w", "re", "cls" }]` | Vague phrasing. `w` adds to the score, `re` is a case-insensitive regex, `cls` is the kind of miss it predicts. |
| `anchors` | `[{ "id", "w", "re" }]` | Things that make a prompt concrete (a URL, a file name). `w` is negative. |
| `cost` | `[{ "id", "re" }]` | What makes a wrong guess expensive. Ids in `ask_costs` raise a card to a full ASK. |
| `ask_costs` | `["outward", ...]` | Cost ids that always ask when the prompt is vague. |
| `delegate` | regex | "Up to you" phrasing: no card, pick the cheapest path and say it. |
| `type` | `{ "explain", "wondering", "deciding", "building": regex }` | Extra words for each prompt type. Wondering prompts never get a card. |
| `verdict` | `{ "miss", "broken", "yes": regex }` | How the next prompt says "you misread me", "it is broken", or "yes". |
| `classes` | `{ "<class>": regex }` | Extra kinds of miss (scope, audience, channel). |
| `readings` | `[{ "re", "cls", "reading" }]` | A phrase you always mean one way. The hook prints the reading instead of asking. |
| `coach` | `{ "<tell id>": "clearer way to say it" }` | One line the weekly coach shows for that tell. |
| `card` | `{ "question", "yes", "edit" }` | The card's words in your language. |
| `because` | string | An extra line for the rewrite (for example, which team goal it serves). |
| `bot` | regex | Prompts written by your own automations. They never get a card. |
| `headless_env` | `["MY_RUNNER"]` | Env vars your unattended runner sets. When one is `1`, nobody is asked. |
| `recent_dirs` | `["~/Downloads"]` | Extra folders for the "which one?" list. |
| `targets` | `{ "<name>": "template" }` | Extra prompt shapes for `wdym target`. The template fills `{{goal}}`, `{{context}}`, `{{in_scope}}` and the other brief fields (see `targets.md`). |
| `thresholds`, `budget` | same as `tells.json` | Start points; `wdym tune` still moves them inside the core bounds. |

### `terms.json`

```json
{
  "version": 1,
  "stop": ["words", "that", "carry", "no", "meaning", "in", "your", "language"],
  "says": { "parallax": ["the background moves slower when I scroll"] }
}
```

`says` adds your phrases to the design terms in `design-terms.json`, by term id. `stop` lists
filler words so they never decide a match.

### `verdict.generated.json`

Same keys as `verdict` plus `bot`, for patterns a script writes from your own history. Keep
hand-written rules in `pack.json` and generated ones here, so a regenerate never erases your edits.

## Test a pack before you trust it

```bash
node scripts/wdym.mjs triage "make it pop like last time" --config my-pack/config.json --json
node scripts/wdym.mjs eval my-golden.json --config my-pack/config.json --split test
```

A golden file is rows of `{ "prompt", "label": "misread" | "none", "split": "dev" | "test" }`,
plus optional `next` (the prompts that followed) and `fired_at` (which of them corrected the
read) to score the judge too. `test/golden.public.json` is a full example.
Tune your tells on `dev` only and report `test`. A rule tuned on the rows it is scored on
always looks better than it is.

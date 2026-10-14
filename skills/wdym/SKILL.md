---
name: wdym
description: "Read what the user means before the work runs. When a prompt is vague (no target, a dangling 'that one', 'make it better', 'you know what I mean', a look described without its name), ask one quick card with a rewritten brief before any tool; clear prompts run with no questions. Learns over time which phrasings it misreads for this user. Also: tells what a design, layout, animation or scroll effect is called when the user can only describe it (named terms with previews), lists the 'which one?' candidates, reshapes a brief into a prompt for ChatGPT, Claude, Codex, Gemini, image or video tools, and coaches the user's vague habits weekly. Use when lines starting 'wdym:' appear in context, or the user says '/wdym', 'refine my prompt', 'is this prompt clear', 'what is this design called', 'write this as a prompt for chatgpt/codex/midjourney'."
license: MIT
---

# wdym: read what they mean before the work runs

Misreading a prompt costs a whole build. One tap costs a second. wdym asks only when the
prompt is vague, never when it is clear, and keeps a private record of which of the user's
phrasings it gets wrong so the next read is better.

`SKILL_DIR` below is the folder this file is in. Run the CLI as `node SKILL_DIR/scripts/wdym.mjs <command>`.

## Step 0: setup check (first use only)

Run `node SKILL_DIR/scripts/wire.mjs doctor`. If it is not green and the user wants wdym
to run on every prompt, run `node SKILL_DIR/scripts/wire.mjs apply` (links the skill into
Claude Code, Codex and Hermes, adds the prompt hook to Claude Code and Codex, idempotent;
`remove` takes it out). Codex runs a new hook only after the user approves it once when Codex
starts; doctor shows that row until they do. Without the hook, wdym still works when invoked
with `/wdym`.

## Step 1: is "wdym" aimed at you?

If the user typed "wdym?", "what do you mean" or "wym" about something YOU said, they are
asking you to explain. Explain your last message plainly. Do not run anything else here.

## Step 2: follow the hook line

With the hook on, each prompt may arrive with one context line starting `wdym:`. Obey it:

| Line | What you do |
|---|---|
| nothing | The prompt is clear. Work. No questions. |
| `wdym: delegated` | They left it to you. Pick the cheapest path that meets the ask, say it in one line, work. |
| `wdym: CHECK (...)` | One card before any tool (spec below), then work on their answer. |
| `wdym: ASK (...)` | One batch of up to 4 questions before any tool: the rewrite card first, then each open decision. |
| `wdym: vague ... but no card` | Nobody to ask, or the card budget is used. Write three lines first: **You want:** / **Because:** / **I'd add:**, then work on that reading. |
| `wdym: noted rd-... as a misread` | Their prompt corrects your last reading. Re-read it as the correction, say what you now understand in one line, then redo. |

The hook also prints "Past misses here" (what this user meant the last times you misread
this kind of prompt) and "Known reading" lines. Use them before you write the rewrite.

Without the hook (invoked as `/wdym <text>`): run `node SKILL_DIR/scripts/wdym.mjs triage "<text>"`
and follow the same table.

## The card (CHECK)

One `AskUserQuestion` call, one question:

- **question:** "Is this it?" (a pack may localize it)
- **option 1:** label "Yes, go (Recommended)"; description = the goal in one line; **preview** = the rewrite:
  ```
  Goal:        <the outcome, one line>
  Done when:   <how both of you will know it is finished>
  In:          <what changes>
  Out:         <what must not change>
  Constraints: <only the real ones>
  ```
- **option 2:** "Edit": they will say which line is off. Ask "Which line?" as one more single-select card with the lines as options.
- **option 3 (only when one exists):** the second most likely reading, written as concretely as option 1.
- "Other" is added by the tool. Never add a blank "something else" option.

**In Codex** (no card tool) the hook line says "ask in chat": write the question, the rewrite
as the same five lines, and the two answers ("Yes, go" or "Edit") as one short message, then stop.
Their next message is the answer.

Rules for the rewrite: concrete nouns (the file, the page, the section), a done-when line that
can be checked, and an Out line that protects what they did not mention. Never ask about facts you
can look up: read the file, the repo, the history first. Questions are for decisions only.

## The batch (ASK)

Up to 4 questions in one `AskUserQuestion` call. Question 1 is the card above. Each other
question is one open decision (which audience, which of two scopes, publish now or draft),
with 2 to 4 concrete options, your recommendation first and labeled "(Recommended)". Use
`preview` for anything visual (a layout sketch, a sample line of copy).

## Design words they cannot name

When the class is `design` or they describe a look ("the background moves slower when I
scroll", "the card kind of floats"):

1. `node SKILL_DIR/scripts/wdym.mjs terms "<their words>" --json` returns the 3 closest named terms.
2. Offer them as card options: label = the term, description = its one line, preview = a small text sketch.
   For real pictures add `--html <file>` and open the sheet for them.
3. After they pick, put the term in the brief and save their phrase:
   `node SKILL_DIR/scripts/wdym.mjs learn-term "<their words>" <term-id>`. Next time it resolves without a card.

## "Which one?"

For an unanchored reference ("that one", "like last time", "you know what I mean" with no
link), run `node SKILL_DIR/scripts/wdym.mjs recent --json` and offer the likely files or
artifacts as options instead of asking an open question.

## A prompt for another AI

When they want the brief for another tool: build the brief as JSON
(`goal, context, done_when, in_scope, out_scope, constraints, audience, format, references`)
and run `node SKILL_DIR/scripts/wdym.mjs target <chatgpt|claude|codex|gemini|image|video> --brief '<json>'`.
Hand back the result as one copy-ready block.

## Plan mode

Same card, asked before you explore. The confirmed brief becomes the first section of the
plan. Keep file paths out of the brief; they belong in the plan body.

## Learning (no work for you)

The hook judges each reading from the user's next prompt: "I meant...", "not that one" is a
miss; a short "yes", "go", "exactly" is a hit; picking option 1 on a card confirms the
reading; silence is never counted as a hit. You can also mark one by hand:
`node SKILL_DIR/scripts/wdym.mjs mark <rd-id> miss "<what they meant>"`.

- `wdym.mjs score`: hit rate, card share, how often a card only confirmed the first reading.
- `wdym.mjs tune --apply`: moves the card threshold one step when cards are too frequent or misses slip through. It never lowers asking on money, publishing, deleting or taste.
- `wdym.mjs coach`: their top 3 vague phrases this week and a clearer way to say each.
- `wdym.mjs off` / `on`: stop or resume the hook.

Everything stays on their machine in `~/.jtl/wdym/` (created on first run).

## Never

- Ask on a question that only wants an answer ("why is the build failing?").
- Ask twice in a row, or ask what you can read for yourself.
- Ship an open, blank question. Every question has concrete options and a recommendation.
- Count a non-answer as agreement.

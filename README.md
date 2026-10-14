# wdym

**Your coding agent asks "is this it?" before it builds the wrong thing.**

[![ci](https://github.com/jtlgrowth/wdym/actions/workflows/ci.yml/badge.svg)](https://github.com/jtlgrowth/wdym/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/jtlgrowth/wdym?label=release&color=111111)](https://github.com/jtlgrowth/wdym/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-111111)](LICENSE)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-111111)](package.json)
[![node 18+](https://img.shields.io/badge/node-18%2B-111111)](https://nodejs.org)
[![works in Claude Code and Codex](https://img.shields.io/badge/works%20in-Claude%20Code%20%2B%20Codex-111111)](#install)

<p align="center">
  <img src="assets/wdym-demo.gif" width="800" alt="A vague prompt gets one card with a rewritten brief. One tap, then the build runs on the right reading.">
</p>

"Make it pop." "Fix that one." "You know what I mean." A vague prompt costs a whole wrong
build; a quick check costs one tap. wdym reads every prompt before your agent runs a tool.
Clear prompts pass straight through, no questions. A vague one gets **one card** with a
rewritten brief (Goal, Done when, In, Out). You tap "Yes, go" and the work starts on the
right reading.

It works in Claude Code and Codex, learns which of your phrasings it misreads, and keeps
everything on your machine. Zero dependencies, no network, MIT.

[Watch the full demo with sound (28 s)](assets/wdym-demo.mp4)

---

## Install

You need [Node.js](https://nodejs.org) 18 or newer and Claude Code or Codex.

```bash
git clone https://github.com/jtlgrowth/wdym
cd wdym
node skills/wdym/scripts/wire.mjs plan     # shows every change it would make, makes none
node skills/wdym/scripts/wire.mjs apply    # links the skill, adds the prompt hook
node skills/wdym/scripts/wire.mjs doctor   # every row ok = live
```

Keep the folder where you cloned it: the skill is linked, not copied. `apply` is safe to run
twice. Tested on macOS; CI runs Linux, macOS and Windows on every push (badge above).
A green `apply` ends with links to star the repo and follow JTL Growth; it never stars or
follows anything for you.

**Codex:** Codex runs a new hook only after you approve it once. Start Codex, approve the
hook running `wdym.mjs hook`, and `doctor` turns green.

**Just the skill, no hook:** inside Claude Code,

```
/plugin marketplace add jtlgrowth/wdym
/plugin install wdym@wdym
```

then check a prompt by hand with `/wdym:wdym <your prompt>`.

**Uninstall:** `node skills/wdym/scripts/wire.mjs remove`, then delete `~/.jtl/wdym/` if you
want your history gone too.

---

## How it decides

1. **Score the prompt.** Vague tells add (no target, a dangling "that one", "make it
   better", a look described without its name). Anchors subtract (a file name, a URL, a
   number).
2. **Read the type.** A question ("why is the build failing?") only wants an answer, so it
   never gets a card.
3. **Pick a tier.**
   - **GO:** clear. Nothing is shown.
   - **CHECK:** vague. One card with the rewrite.
   - **ASK:** vague and a wrong guess is expensive (publishing, money, deleting). Up to four
     questions in one batch.
4. **Respect a budget.** At most one card per three prompts, never two in a row, never in an
   unattended run.

The hook takes about 50 ms. On any error it steps aside and your prompt runs as if wdym were
not there.

## It learns your words

- **Your next prompt grades the last reading.** "No, I meant..." is a miss. "Yes", "go",
  "exactly" is a hit. Silence is never counted as a hit.
- **Misses are remembered by kind** (scope, design, reference, audience). The next vague
  prompt of that kind shows your agent what you meant last time, before it writes the brief.
- `wdym score` shows hit rate and card share. `wdym tune --apply` moves the threshold one
  step when cards come too often or misses slip through; it never lowers asking on money,
  publishing or deleting. `wdym coach` shows your three vaguest habits this week, with a
  clearer way to say each.

Everything lives in `~/.jtl/wdym/`, written with owner-only permissions.

## Also in the box

- **Name that design.** `wdym terms "the background moves slower when I scroll"` returns
  the three closest named terms (Parallax first) from 73, each with a small preview.
  `--html sheet.html` draws them as a contact sheet. Your pick is saved, so the same words
  resolve without asking next time.
- **"Which one?"** `wdym recent` lists recently changed files, so "that one" becomes a
  choice instead of an open question.
- **A prompt for another AI.** `wdym target chatgpt|claude|codex|gemini|image|video` reshapes
  the brief for that tool.
- **Packs.** Add your language or your team's shorthand on top of the English core:
  [references/packs.md](skills/wdym/references/packs.md).

Run any of them as `node skills/wdym/scripts/wdym.mjs <command>`.

---

## Benchmark

We report two sets, because the easy one alone would flatter us.

| Set | Misreads caught before work | Clear prompts given a card | Clear prompts given a full ASK |
|---|---|---|---|
| Public synthetic set: 30 misreads, 60 clear prompts, written by us | 96.7% | 1.7% | 0% |
| One real user's held-out prompts: 11 misreads, 230 clear (private) | 36% | 9.6% | 0.4% |

The synthetic set is written to exercise the rules, so it is easy. The real set is the honest
number: on real prompts, wdym catches about a third of the misreads before they cost a build
(45% counting readings from that user's own language pack) and leaves 9 in 10 clear
prompts alone.
The real prompts stay private because they are someone's actual work. The public set and
the scorer are here, so you can rerun it and add your own cases:

```bash
npm test        # unit tests
npm run eval    # the public benchmark
```

## Privacy and security

No network calls, no telemetry, no install script, no dependencies. What it reads, writes and
changes is listed in [SECURITY.md](SECURITY.md).

## License

MIT. Made by [JTL Growth](https://github.com/jtlgrowth). Also listed in the
[JTL toolkit](https://github.com/jtlgrowth/jtl).

If wdym saves you a wrong build, star this repo and follow JTL Growth on
[Instagram](https://www.instagram.com/jtlgrowth) and [Facebook](https://www.facebook.com/jtlgrowth)
for the next free tools.

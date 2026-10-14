# Prompt targets

Each section below describes one AI tool that a clarified brief can be reshaped for. The CLI reads this file: a `## <id>` header starts a target, the "Use for:" line says when to pick it, the bullets are the rules the tool does best with, and the single `text` block is the template. Placeholders in double braces are filled from the clarified brief. If a placeholder has no value, the CLI drops its line instead of leaving it blank.

## chatgpt

Use for: writing, analysis, brainstorming, planning and general questions in ChatGPT.

- State the goal first, then give the background it cannot guess.
- Name the audience and the tone so it does not default to a generic voice.
- Ask for the exact output format (list, table, short paragraphs, word count).
- Give a role only when it changes the answer, and keep it to one line.
- Put hard limits in a separate section so they are not buried.
- Invite it to ask one question if something essential is missing.

```text
Goal: {{goal}}

Background:
{{context}}

Who this is for: {{audience}}

Cover: {{in_scope}}
Leave out: {{out_scope}}

Rules to follow:
{{constraints}}

Examples or sources to lean on:
{{references}}

Give me the answer as: {{format}}

It is done when: {{done_when}}

If something essential is missing, ask me one short question before you start.
```

## claude

Use for: long documents, careful reasoning, editing, code explanations and multi-step work in Claude.

- Be direct and explicit about the task, as you would brief a smart new colleague.
- Say why the task matters, since the reason helps it make better calls.
- Wrap pasted material in tags so instructions and content never blur together.
- Describe the finished result concretely, including length and structure.
- Say what to do rather than only what to avoid.
- Allow it to say "I am not sure" instead of guessing.

```text
<task>
{{goal}}
</task>

<why_it_matters>
{{context}}
</why_it_matters>

<audience>
{{audience}}
</audience>

<material>
{{references}}
</material>

<scope>
Include: {{in_scope}}
Exclude: {{out_scope}}
</scope>

<constraints>
{{constraints}}
</constraints>

<output>
Format: {{format}}
Finished when: {{done_when}}
</output>

If any part of this is unclear or you are unsure, say so and ask before guessing.
```

## codex

Use for: coding tasks in a real repository, run by a coding agent such as Codex.

- Say what to change and why in a sentence or two, then list the concrete files or areas involved.
- Give repo context: stack, how to run the app, how to run the tests.
- Write acceptance checks as commands or behaviors the agent can run itself.
- List files and folders it must not touch.
- Ask for small, reviewable diffs and a short summary of what changed.
- Tell it to stop and ask rather than invent an API, secret or dependency.

```text
Task: {{goal}}

Repo context:
{{context}}

Change only:
{{in_scope}}

Do not touch:
{{out_scope}}

Constraints:
{{constraints}}

Reference material (existing code, docs, tickets):
{{references}}

Acceptance:
- {{done_when}}
- Existing tests still pass and the build is clean.

When you finish, reply with: {{format}}
Keep the diff small. If you need a key, a package or a decision I have not given you, stop and ask.
```

## gemini

Use for: research over large inputs, long documents, images and video, and tasks that mix several sources.

- Put the files or long context first and the question last.
- Say exactly which source to use for which part of the answer.
- Ask for the structure you want, such as headings, a table or numbered steps.
- Keep instructions short and clear; avoid piling on rules.
- Ask it to cite where in the material each claim comes from.
- State the audience and the level of detail to aim for.

```text
Material:
{{references}}

Background:
{{context}}

Using the material above, {{goal}}

Audience and level of detail: {{audience}}

Focus on: {{in_scope}}
Ignore: {{out_scope}}

Rules:
{{constraints}}

Format the answer as: {{format}}
Cite which part of the material supports each key point.
Good enough when: {{done_when}}
```

## image

Use for: text-to-image tools such as Midjourney, DALL-E, Imagen, Flux and similar.

- Lead with the subject in plain words: who or what, doing what, where.
- Describe composition: shot type, angle, framing and where things sit.
- Name the style and medium (photo, 3D render, ink drawing) and one or two reference moods.
- Describe the light and color: time of day, direction, palette.
- Give the aspect ratio and the intended use.
- Add negative cues for what must not appear, such as extra fingers, text or watermarks.

```text
Subject: {{goal}}

Scene and setting: {{context}}

Composition: {{in_scope}}

Style and medium: {{references}}

Lighting and color: {{constraints}}

Mood and audience: {{audience}}

Aspect ratio and size: {{format}}

Avoid: {{out_scope}}, blurry details, distorted hands, stray text, watermarks

Looks right when: {{done_when}}
```

## video

Use for: text-to-video and image-to-video tools such as Veo, Sora, Runway, Kling and similar.

- Describe one clear action per shot; short shots work better than long ones.
- Write a shot list with the camera move (pan, dolly, orbit, handheld) and a duration for each.
- Anchor the look with subject, setting, lighting and style in every shot so it stays consistent.
- State the aspect ratio, total length and frame rate if it matters.
- Describe sound, voiceover or music separately if the tool supports it.
- Add negative cues for what should not appear, like jump cuts, text overlays or warped faces.

```text
Concept: {{goal}}

Look and setting: {{context}}

Audience and platform: {{audience}}

Shot list (one action per shot, each with camera motion and duration):
Shot 1: {{in_scope}}
Shot 2: continue the same subject and lighting, change the camera angle
Shot 3: end on a clear final frame that satisfies: {{done_when}}

Style references: {{references}}

Technical: {{format}}
Rules: {{constraints}}
Avoid: {{out_scope}}, warped faces, flicker, text overlays, abrupt jump cuts
```

# ST-BaiBai-Image (BaiBai Image) design draft

> Status: discussion draft. It records the product direction and recommended implementation agreed so far. It does not mean the features are finished.

## 1. Plugin goals

After SillyTavern generates new AI text, BaiBai Image sends a separate AI request, independent of text generation, to do the following:

1. Judge whether the latest AI floor contains scenes worth illustrating.
2. Choose the most valuable scenes, within the user's maximum images per floor.
3. Write a prompt for each scene, suited to the target image backend.
4. Insert editable image tags at the matching positions in the text.
5. Call a backend such as ComfyUI, NAI or WebUI to generate the images.
6. Show each image where its tag sits, and let the user edit the tag and regenerate.

The ComfyUI path comes first. Other backends join gradually on top of a shared task model.

## 2. Core design principles

### 2.1 Text tags separate from image results

Hybrid storage:

- Image tags are written into `message.mes`. They are the source of truth for prompts and a stable position anchor.
- Image URLs, seeds, backend info, workflow info and generation state are stored in the message's extension data.
- At render time, image results are linked by the order tags appear in the current swipe and by prompt hash, and each image is placed where its tag sits.

This satisfies all of the following:

- Users can edit prompts directly in ST's message editor.
- When users edit or move text, tags and image positions move with it.
- Image data never pollutes the text as Markdown URLs, Base64 and the like.
- One tag can keep several generation results, supporting regeneration and switching images.

### 2.2 First placement uses paragraph-end position IDs

After cleaning the target text, the plugin appends a short position ID (such as `⟦P1⟧`) to the end of each non-empty physical line it keeps. The AI returns only position IDs and prompts. The plugin uses a local mapping to insert each tag after the matching original physical line. The model never copies the original text or returns the full text.

Position IDs serve only the first insertion and are never written into the text. Once a real tag is written, the tag moves with the text. Later image rendering no longer depends on old position IDs.

### 2.3 No silent context truncation

The plugin offers no "maximum context characters" or "maximum context tokens" limit.

- It keeps a "number of recent AI floors to include" setting, suggested default 2. The target floor counts towards the number, and user floors in between are included too.
- Selected floors are cleaned with BaiBai Book's rule and sent without character or token truncation. History floors keep `<bbi_image>`.
- The BaiBai Book state snapshot is sent in full.
- If the model provider rejects the request because of its own context window, the error is reported to the user. Content is never trimmed silently in the background.

## 3. Automatic task flow

A full task is suggested to run in these stages:

```text
ST finishes new AI text
  -> lock chatId / floor / swipeId / sourceHash
  -> read and clean the last N AI story floors and the user floors between them
  -> read BaiBai Book's current effective state and its D1/D2 semantics
  -> call the separate AI to judge whether images are needed
  -> validate the AI's JSON, target position IDs and positive prompts
  -> safely insert pending tags into the text
  -> reread the actual prompts from the saved tags
  -> call the target image backend
  -> check again that chat, floor, swipe and tag still match
  -> save the image results and refresh that floor's display
```

Writing tags first and then starting image generation has several benefits:

- Users can see the task is queued, rather than getting no feedback for a long time.
- The image stage uses content from the real tags, not a temporary object the AI returned but that was never saved.
- If a tag is edited or deleted during generation, the prompt hash reveals the conflict.

## 4. Context composition

### 4.1 Recent text

By default the last two AI story floors and the user floors between them are included. Users can change the number. There is no separate character limit.

The latest AI floor is always marked on its own, because the model must judge around it whether images are needed this time, rather than adding images for history.

The text structure given to the separate AI should include:

- Role (user / assistant / system).
- Speaker name.
- History text cleaned with BaiBai Book's `cleanBody` rule, keeping history `<bbi_image>`.
- A clear mark of which floor is this run's target floor.
- Target text with the same noise and time tags removed, and `⟦P<number>⟧` appended only to the end of each non-empty physical line kept.

### 4.2 BaiBai Book state snapshot

Where BaiBai Book injects its state is dynamic:

- When the latest AI floor already has a valid summary, the state already includes the latest floor. This is D1.
- When the latest AI floor has no valid summary yet, the state does not include the latest floor. This is D2.

BaiBai Image should not always read `before latest`. Instead it should:

1. Get the latest floor info through BaiBai Book's public API.
2. Use `memory.valid` to judge whether the current state has D1 or D2 semantics.
3. Get BaiBai Book's current effective snapshot.
4. Tell the separate AI the snapshot's time relation explicitly:
   - `after_latest`: the snapshot already includes the target floor.
   - `before_latest`: the snapshot is the state before the target floor happened, and the target text changes things from there.

Even with D1, the latest text must still be sent. The state snapshot provides stable character, scene and item info. The original text provides the specific scenes and insertion positions. They play different roles.

When reading floor info and the snapshot, check BaiBai Book's `revision`. If BaiBai Book finishes a summary and changes the revision during the read, read again once, so a D1/D2 mark is never combined with a snapshot from a different moment.

### 4.3 When BaiBai Book is unavailable

BaiBai Book is an enhanced memory source. It should not be a hard dependency of automatic image generation.

- If the API is missing, the version is incompatible or the read fails, fall back to the text of the last N AI story floors and the user floors between them.
- Record in the log or task details that BaiBai Book state was not used this time.
- A missing memory source should never block manual image generation.

## 5. Separate AI request

### 5.1 Request responsibilities

The separate AI is only responsible for:

- Judging whether images are worth generating.
- Choosing scenes.
- Returning paragraph-end position IDs from the target text, saying which original physical line each scene goes after.
- Writing positive content prompts only, without quality tags.

It is not responsible for:

- Rewriting whole passages of text.
- Producing the final message text directly.
- Writing quality tags or negative prompts.
- Choosing actual workflow nodes or sending requests to ComfyUI.

### 5.2 Suggested output structure

```json
{
  "images": [
    {
      "position": "P2",
      "tag": "1girl, opening_a_door, moonlit_abandoned_hall, cinematic_lighting",
      "nl": "A girl opens a door into an abandoned hall lit by cold moonlight."
    }
  ]
}
```

Constraints:

- `position` must be a `P<number>` provided at a paragraph end of the target text. It must not reference history context or be invented.
- The plugin maps the position ID back to the original physical line before cleaning, and inserts the tag after that line.
- `tag` is short danbooru tags and is required. It holds only positive scene content: no quality tags, negative words or `<bbi_image>`/`<tag>`/`<nl>` tags.
- `nl` is the natural-language part. It is required only when "the default backend is ComfyUI and Generate Natural Language is on". It describes the same scene as `tag`, complementing it without repetition. When off, the key does not appear in the protocol.
- The number of images returned must not exceed the user's maximum per floor.
- The plugin must still truncate the array locally. It cannot rely on prompt constraints alone.
- When no image is needed, return `{"images":[]}`.

If a position ID does not exist, is badly formatted, or `tag` is empty, the whole response fails validation and nothing is written into the text. A missing `nl` degrades leniently to tags only.

### 5.3 Customisable prompts

Split into at least these settings:

- System duty prompt: defines judgement criteria, output format and safety boundaries.
- Image prompt rules: define the target style, tag language, character consistency requirements and so on.
- Core Prompt / extra prompt: filled in by the user, and can be turned off.
- Output format constraints: usually maintained by the plugin. Users are advised not to delete them entirely.

User custom content and the plugin's structured output constraints should be assembled in layers, so changing style requirements can't accidentally break the JSON protocol.

## 6. Image tags

### 6.1 Recommended form

Use paired tags owned by the plugin, rather than reusing ST macros or workflow placeholders. The tag part stays as bare text, and the natural-language part is wrapped in an `<nl>` sub-tag:

```text
<bbi_image>1girl, opening_a_door, moonlit_abandoned_hall</bbi_image>
<bbi_image>1girl, opening_a_door<nl>A girl opens a door into an abandoned hall.</nl></bbi_image>
```

Parsing is one lenient rule (`parseImageTagContent` in src/st/imageTagRegex.ts): the `<nl>` sub-tag content is the natural-language part; explicit `<tag>` sub-tag content, or the bare text left after removing sub-tags, is the tag part; when bare text and `<tag>` both exist they are merged without losing content. Whatever internal format is used, it should:

- Contain no ID or other attributes.
- Hold only positive content prompts the user can edit directly.
- Leave quality and negative words to the user, written directly in the ComfyUI workflow (such as `quality tags, %prompt%`), not assembled by a plugin panel.
- Support ordinary commas, line breaks and common symbols in prompts.
- Be fully recognisable and deletable as a whole block.
- Never mix with ST's macro substitution syntax or ComfyUI workflow placeholders.

ComfyUI workflows keep using the `%prompt%`, `%negative_prompt%`, `%seed%` and `%nl%` placeholders. Text tags are a protocol at another level. `%nl%` is written only into workflows that declare it explicitly, and is never joined into `%prompt%` automatically.

### 6.2 ST managed hiding regex

On startup the plugin idempotently registers a regex with a fixed ID in `extension_settings.regex`:

```text
/<bbi_image>[\s\S]+?<\/bbi_image>/gi
```

It deletes `<bbi_image>...</bbi_image>` and the prompt inside as a whole block, so neither the chat display nor the backend prompt sent to the main model contains image content. `[\s\S]+?` handles multi-line prompts, and the non-greedy quantifier makes several tags match separately. The rule also sets:

- `markdownOnly: true`: ticks "Alter chat display only".
- `promptOnly: true`: ticks "Alter outgoing prompt only".
- `runOnEdit: true`: also applies in edit previews.
- placement covers MD display, user input and AI output, compatible with both old and new ST regex rules.

Both "only" switches can be on together, and ST runs the rule separately on the display path and the backend prompt path. The rule is updated by fixed ID, never added twice, and never touches the user's other regexes.

### 6.3 Tag lifecycle

Each tag has at least these logical states:

- `pending`: inserted into the text, waiting for image generation.
- `generating`: the backend is running.
- `ready`: an image matching the current prompt exists.
- `stale`: the tag was edited, and the existing image comes from the old prompt.
- `error`: parsing, the request or backend execution failed.
- `cancelled`: the user cancelled, or the state of the owning message changed.

Not every state needs to be in the text. The text stores only the prompt. Transient state and results are stored in extension data.

### 6.4 Editing behaviour

- Editing a prompt: compute the new hash. If it differs from `promptHash` in the results, mark `stale`.
- Moving a whole tag: only the image position changes, with no regeneration.
- Deleting a tag: stop showing that tag's results, and cancel any running task where possible.
- Copying a tag: treated as another tag by its new order of appearance. Prompts with identical text are told apart by order of appearance.
- Broken tag format: show the parse error in place and submit nothing to the backend.
- Regenerating after an edit: by default the user clicks the single tag's "Regenerate" button, so an ordinary edit never incurs cost automatically.
- Automatic regeneration: can be an explicit optional setting, off by default.

### 6.5 Edits during generation

When image generation starts, record:

- chatId
- floor
- swipeId
- the tag's order of appearance in the current swipe
- promptHash

When the image returns, reread the tag in the text:

- Tag deleted: do not attach the result.
- Tag content changed: never mark an image from the old prompt as the current result. It may be saved as history or discarded.
- Chat or swipe switched: the task may only write back to its original target. If it can't write back reliably, cancel it. It must never attach to the current message by mistake.

## 7. Safe text writes

Text writes follow the transactional approach of ST-BaiBai-Pen:

1. Save the original text and chatId when the task starts.
2. Before writing, prefer reading the content of any open ST editor.
3. Stop writing when the current text differs from the expected text.
4. Update `message.mes` and the current `message.swipes[swipe_id]` together.
5. Roll back both if saving fails.
6. Sync the current editor or refresh the floor.
7. Fire the correct message edit/update events.

Never compute string positions on the old text and write back directly. Otherwise the user's edits during the separate AI request may be overwritten.

When inserting several tags for the first time, validate every position ID first and build the new text in one go. This avoids intermediate states from consecutive saves and repeated triggering of other plugins.

## 8. Image result storage and rendering

Results are suggested to be stored per current swipe, with a structure like:

```ts
interface BaiBaiImageMessageData {
  version: 1;
  results: Array<{
    promptHash: string;
    images: Array<{
      url: string;
      seed?: number;
      backend: 'comfyui' | 'nai' | 'webui';
      createdAt: number;
    }>;
    selectedIndex: number;
    error?: string;
  }>;
}
```

When actually saving, confirm how the current ST version syncs `message.extra` and `swipe_info[swipe_id].extra`, so images never cross over after switching swipes.

### 8.1 Display position

The renderer scans the current raw message for valid tags and turns them into interactive image blocks:

- Prompts can be collapsed for viewing or editing.
- Waiting, generating, failed or stale states are shown.
- The current image is shown, with switching between history images.
- Regenerate, cancel, delete result and similar actions are offered.

With ST's native `message.extra.media`, images can only appear together in the floor's media area. Placing several tags after different paragraphs needs a custom tag rendering layer. Native media can be used for file persistence or a floor-bottom mode, but cannot solve paragraph-level placement on its own.

### 8.2 No image data in the text

The text keeps only editable tags, never writing:

- Base64 images.
- Temporary Blob URLs.
- Full ComfyUI workflows.
- Large blocks of generation metadata.

Images should first be saved as persistently accessible files, then linked by current swipe, tag order of appearance and prompt hash. Availability after page refresh, chat reload and device switching needs separate verification.

## 9. Compatibility with BaiBai Book

Tags inside the text fire message edit events and may also enter summaries, vector recall and state analysis, so a formal cross-plugin agreement is needed.

### 9.1 Content cleanup

BaiBai Book should treat `<bbi_image>...</bbi_image>` as a non-story block and strip it whole at these entry points:

- Automatic summary input.
- The return value of `cleanBody()`.
- Vector indexing and recall text.
- Cleaned text returned by the public API.

BaiBai Image should not silently change the user's "custom cleanup tags" setting. More robust options are:

- BaiBai Book ignores BaiBai Image tags built in; or
- BaiBai Book offers a public API letting other plugins register block tags to ignore.

### 9.2 Summary invalidation

Editing only image tags should not invalidate story summaries.

When BaiBai Book handles `MESSAGE_EDITED`, the ideal rule is to compare the cleaned story text:

- Same cleaned text: only decorative tags changed, so keep the summary.
- Different cleaned text: the user really changed the story, so clear the invalidation chain and recompute as usual.

If the user edits both text and tags, it should still be handled as a story text change.

Until this compatibility is in place, editing tags in the text may cause BaiBai Book summaries to be recomputed. Before implementing BaiBai Image's automatic path, this must be solved or at least made known to the user.

## 10. ComfyUI adaptation

ComfyUI uses the full workflow JSON exported with `Save (API Format)`. The plugin doesn't make users maintain node mappings by hand. Users only place dynamic placeholders in the workflow:

- `%prompt%` (the tag part)
- `%negative_prompt%`
- `%seed%`
- `%nl%` (the natural-language part; if the workflow lacks this placeholder, natural language takes no part in generation and is never joined into `%prompt%`)

Before submitting:

1. Parse the workflow JSON.
2. Check it is an API-format node object.
3. Check `%prompt%` exists.
4. Replace the supported placeholders.
5. Reject unknown placeholders, so users don't assume they work.
6. Submit the full rendered workflow to ComfyUI.

Node mapping only matters if the plugin must automatically recognise and modify arbitrary workflows without placeholders. With workflow template placeholders in use, no extra node mapping UI is needed.

## 11. Suggested settings

### Automatic analysis

- Master switch.
- Automatically process new AI floors.
- Number of recent AI floors to include, default 2. The target floor counts, user floors in between are included, with no character limit.
- Whether to use BaiBai Book state.
- Maximum images per floor.

### AI prompts

- System duty prompt.
- Image tag writing rules.
- Core Prompt / extra prompt.
- The separate API channel to use.

### Tags and regeneration

- Show tags by default / collapse tags / hide tags but keep an edit entry.
- Regenerate automatically after a tag edit, off by default.
- Whether to keep old image history.
- Whether to delete the image file when deleting a tag.

### Image backends

- Default backend.
- ComfyUI address and request method.
- ComfyUI API workflow JSON.
- Separate settings for NAI / WebUI later.

## 12. Concurrency, idempotency and error handling

### 12.1 Task identity

Each task is uniquely identified by at least:

```text
chatId + floor + swipeId + tag order of appearance + promptHash
```

Tasks with the same identity must not be submitted twice. On regeneration, promptHash, the task sequence number or an explicit generationId must change.

### 12.2 Errors that must be prevented

- The user has switched chats when the separate request returns.
- The user edited the target text during analysis.
- The user switched swipes during image generation.
- A tag was deleted, copied or edited.
- The same message render event triggers automatic analysis twice.
- After a page reload, an old pending state is submitted again.
- The image generated successfully but saving the chat failed.
- Several images finishing in a different order bind results to the wrong tags.

### 12.3 Recommended strategy

- Manage cancellable network tasks with AbortController.
- Re-verify task identity at every stage.
- Keep persistent state separate from transient runtime state.
- Automatic triggers deduplicate by sourceHash after cleaning the text. BaiBai Image's own tags are excluded from the computation, so inserting tags never triggers another whole-floor analysis.
- Failures keep a readable error and a "Retry" entry. Paid requests are never retried automatically without limit.

## 13. Recommended implementation order

### Phase one: separate AI inserts tags automatically (first version done)

- Listen for the new AI text finished event.
- Assemble the cleaned last N AI story floors, the user floors between them, and the D1/D2 BaiBai Book snapshot.
- Send the target text with paragraph-end position IDs and ask the model to return position ID JSON.
- Validate position IDs, prompts and the maximum count, then write back to the text safely.

### Phase two: single-tag image loop

- Parse `<bbi_image>prompt</bbi_image>`.
- Call the finished ComfyUI adaptation from the tag.
- Save the result and show it at the tag position.
- Support manual regeneration after editing a tag.

### Phase three: tag editing and task state

- Finish handling of deleted, moved, copied and broken tags.
- Finish stale images, cancel, retry and history images.

### Phase four: BaiBai Book compatibility

- Read the current state snapshot with D1/D2 semantics (first version done).
- Finish BaiBai Book's cleanup of `<bbi_image>` blocks.
- Prevent tag-only edits from invalidating story summaries.

### Phase five: experience and other backends

- Task queue, cancel, retry and history images.
- NAI / WebUI adaptation.
- Rebuild the final UI.

## 14. Design items still to be decided

These still need a final decision before coding:

1. Whether tags show their prompts expanded by default.
2. Whether old images are kept as history, replaced immediately, or left to the user's choice.
3. Whether deleting a tag deletes the image file on the server.
4. Whether one tag should be allowed to generate a batch of several images at once.
5. Whether BaiBai Book compatibility uses built-in tags, a registered cleaner API, or both.
6. Whether an automatic task is cancelled after the user switches swipes, or allowed to write back to the original swipe.

None of these affects the overall direction: "text tags are the source of truth for prompts and positions, and image results are stored in extension data".

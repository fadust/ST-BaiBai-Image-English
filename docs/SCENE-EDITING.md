# Scene selection and editing

These additions adapt selected features from [155210/ST-BaiBai-Image](https://github.com/155210/ST-BaiBai-Image), reviewed at commit `ffb97b074c4c5785b2cfbeb9184422d28fd6e783`. The new interface, help text, appearance-review instructions, and AI editing prompts are written for English use. Character names, field keys, saved records, and legacy import labels retain their original meaning and identity.

## Choose scenes and add illustrations

Open an assistant message's actions and choose **Illustrate selected passages**. If it already contains image prompts, the action is **Add illustrations from selected passages**.

Select the passages for one image. Add another image group to illustrate another moment. Each nonempty group produces one image; all groups share one planning request. Additional instructions can refine framing, lighting, or emphasis. The usual backend and planning rules still apply.

New illustrations are inserted after the selected passages. Existing prompts and generated-image histories are retained. Prompt-only revision histories move with their original images when new illustrations change slot numbers. If another image in the message is already generating, new slots are appended to avoid moving an active job's storage location.

Selections are saved in this browser, separately for each chat, message, and swipe. Failed requests keep the selection available. Closing the dialog before generating also keeps the draft; **Clear selection** removes it.

## Prompt history

Open an image card's actions → **Prompt history**. Earlier prompts include their available generated images and a short comparison with the current prompt. **Restore version** makes that prompt current again; its existing image results become visible on the card. The prompt you leave behind is retained as well.

Image-backed revisions reuse existing image records. Up to ten revisions that have no generated image are retained per slot in message metadata. Restoring a prompt does not regenerate or recreate a deleted image file.

## Character Search

Open **Character Search**. Separate names with commas or newlines; spaces inside names are preserved. Searches ignore case and match mentions in story text. Thinking sections, HTML comments, image prompts, and configured cleanup sections are excluded.

Search each character separately or show only messages containing every name. User messages can be included. Click a message number to jump to it, or **Illustrate…** to select scenes from an assistant reply. This is a text search, not an identity/alias inference system.

## Character editing

In **Characters**, open a profile and choose **Copy appearance**. The copied text contains labeled fields and instructions for reviewing the profile against an image with an image-capable AI. This button does not make an AI request itself.

Use **Paste appearance** to bring the revised profile into the editor. Omitted fields stay unchanged; `None` clears a field. The pasted name never renames the character. Review the draft and choose **Done** to save it.

**Bust** is an optional separate field. Existing size tags in Build move into Bust when profiles are normalized, preserving the generated tag content. Unspecified details remain blank.

## Edit a prompt without story context

Open an image's **Edit prompt** dialog, describe the requested changes, and choose **Edit prompt only**. This sends the current draft and your instructions through the configured planning API. The extension does not add story text, character cards, or planning presets to that request.

The AI is instructed to preserve unrelated details, exact character names, and the input's tag/prose style, including MOSS natural-language descriptions. Its result fills the draft rather than saving immediately. Review it, then choose **Apply** or **Apply and regenerate**. Cancelling prevents a late reply from replacing the draft; the host's main-API transport may still finish its underlying request.

These features work with the normal Image/Book setup and do not require NPC Codex.

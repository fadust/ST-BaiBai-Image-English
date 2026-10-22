# BaiBai Image — English

Illustrate story moments with ComfyUI or NovelAI. Keep permanent character appearances consistent, manage artist tags and reference images, edit prompts, and browse generated images and request history.

An English adaptation of [baibai-git/ST-BaiBai-Image](https://github.com/baibai-git/ST-BaiBai-Image). Original authors and public interfaces remain credited and compatible.

When NPC Codex exposes `imageActors`, chat-image planning reads accepted appearance for the matching chat/message boundary. It overlays unlocked automatic profiles for that request only, preserves manual/global overrides, and rejects a changed appearance before saving a plan. Book and the existing render library remain the fallback for unavailable or ambiguous identities/history. No dossiers or stored image profiles are rewritten. For semantic models, enable the workflow's Natural language option and connect `%nl%` to its positive encoder; `%nl%`-only workflows are supported. NPC Codex portraits supply that same input. Seeds remain scene-specific and do not establish character identity.

## Install

In SillyTavern, open **Extensions → Install extension** and enter:

```text
https://github.com/fadust/ST-BaiBai-Image-English
```

Reload SillyTavern. Keep one copy of this extension enabled: the English fork uses the same settings and chat-data keys as upstream. Back up settings and chats before replacing an existing installation. A ZIP installation should be extracted into one folder under `public/scripts/extensions/third-party/`; built runtime files are already included.

## First use

Open the wand menu → BaiBai Image. Configure your image backend under Backend, then configure the text model under Settings. NanoGPT can plan prompts through its OpenAI-compatible text endpoint; actual images still use ComfyUI or NovelAI. Turn off automatic image generation to review planned prompts first.

Generated descriptions, summaries, explanations, and actions are requested in English. Proper names, quoted evidence, JSON keys, macros, IDs, and saved structures stay unchanged. Existing custom prompts remain yours; exact built-in prompts are migrated only where a matching legacy value can be identified safely.

## Development and verification

```sh
npm ci
npm test
npm run typecheck
npm run build
```

See [the full feature guide](GUIDE.md), [localization notes](LOCALIZATION.md), and [original Chinese documentation](README.zh-CN.md).

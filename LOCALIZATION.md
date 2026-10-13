# English adaptation notes

Upstream: https://github.com/baibai-git/ST-BaiBai-Image

Pinned upstream commit: `1187528c5b796a686c57659556dfaecdd2ddfbf9`.

## Merge boundaries

- `localization/en.json` records the initial translation inventory; curated source text is authoritative. It is review material, not a runtime replacement script.
- English wrapping rules are isolated in `src/styles/english.css`.
- Functional compatibility changes have focused checks: English output rules, saved-data and macro preservation, and English word/prose handling. Original wire markers can contain Chinese by design; they are parser contracts.
- `README.zh-CN.md` preserves upstream documentation. `GUIDE.md` provides the translated feature reference.
- The release bundle contains a patch against the pinned revision and SHA-256 manifests for runtime assets. Apply patches only to that exact upstream commit; review conflicts after upstream updates.

## Behavior

Proper names and existing user data are never translated in place. Custom prompts and archives remain editable, and legacy imports remain accepted. Updater URLs follow the English fork; automatic host updates are disabled in the manifest.

## Validation

Tested on SillyTavern 1.19.0 with populated synthetic English chats and long names. NanoGPT text calls used a local, temporary relay; no API key, settings export, or private chat is included in this repository. Live image rendering requires a configured ComfyUI or NovelAI backend and is separate from NanoGPT text planning.

# English SillyTavern Extensions

The ZIPs are downloaded from the exact tested commits of these forks:

- [BaiBai Image](https://github.com/fadust/ST-BaiBai-Image-English)
- [Story Oracle](https://github.com/fadust/story-oracle-English)
- [Choice](https://github.com/fadust/choice-English)
- [BaiBai Inkwell — prompt repair 0.4.3](https://github.com/fadust/ST-BaiBai-Inkwell)

Install a fork URL through **Extensions → Install extension**, or extract its ZIP into one extension folder under `public/scripts/extensions/third-party/`. Keep only one copy of each extension enabled because its saved-data keys are shared with upstream. Each ZIP already includes its runtime assets.

For NanoGPT text generation, use `https://nano-gpt.com/api/v1`, your own key, and an available model. Validation used `deepseek/deepseek-v4.1-flash`. No credentials or private chats are included here.

In BaiBai Image → Backend → ComfyUI, use `http://127.0.0.1:8188`, choose **Custom workflow**, and paste `Comfy_Anima_debug-extension.json`. Use portrait size **1024×1536** and landscape size **1536×1024**. This adapted copy preserves the supplied checkpoint, text encoder, VAE, LoRAs, strengths, and sampler settings. Prompt, negative prompt, seed, width, and height use the extension's placeholders. Saving reads the VAE image directly because `PreviewImage` has no image output. The supplied original file was not modified.

Validation completed:

- 784 BaiBai Image tests passed; 3 existing tests skipped. Type check and build passed.
- 114 Choice tests passed. Host-aware type check, build, and the strict i18n check passed with 866 keys and no missing or orphan keys.
- Story Oracle contract checks passed for English archive round trips, legacy imports, ordinary prose, parser markers, output-language rules, character section gating, and quoted evidence.
- 90 Inkwell tests passed, with type checking and build passing. Its missing rewrite rules, editorial review, context labels, connection test and all ten default quick phrases are now natural English. Exact default migrations preserve custom edits, IDs and favorites. Disabled BaiBai-Book no longer blocks standalone channels.
- Live NanoGPT calls produced English action options, a populated scene summary, and an image plan.
- Inkwell's live NanoGPT rewrite changed only the annotated paragraph, preserving the other lines, name punctuation, quoted dialogue and the active swipe after saving and reloading.
- Its deletion check used `openai/gpt-4.1-mini` through NanoGPT. Only the reviewed deletion was saved; a discarded related suggestion was excluded. Two malformed DeepSeek replies were rejected without modifying the chat. See `inkwell-live-verification.json`.
- The supplied Anima workflow generated and saved an image through the extension in an isolated SillyTavern 1.19.0 installation.
- Populated desktop and narrow layouts were checked; labels, configuration actions, and entry rows wrap for English.
- `verification.json` records commit IDs and SHA-256 hashes. Fork ZIP assets and installed test assets match exactly.
- The patches were generated from published commits and pass `git apply --check` against the pinned upstream revisions; see `patch-verification.json`.

NovelAI was covered by automated tests but was not tested against a live account. Full coverage of every optional third-party integration is outside these checks. Your personal SillyTavern chats and settings were not changed.

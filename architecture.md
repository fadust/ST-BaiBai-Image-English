# ST-BaiBai-Image (BaiBai Image) architecture notes

> For an AI in a new chat to find its way around the code quickly. Read this first, then use the "Task lookup index" to find files. For design trade-offs in depth see
> `DESIGN.md` (overall design draft), `GALLERY-STORAGE-DESIGN.md` (gallery/artist string preview storage) and
> `NAI-PRESET-DESIGN.md` (NAI preset plan, not final).
> The interface document for third-party plugin authors is `PUBLIC_API.md` (**the external contract: any interface change must update it in the same batch**).

## 1. What this is

BaiBai Image is a third-party image generation extension for SillyTavern (ST):

- After new AI text lands, it sends a **separate** LLM request to judge which scenes are worth drawing and produce danbooru tags,
  inserting the tags into the text as `<bbi_image>...</bbi_image>` (users can edit them by hand);
- at each tag position in a floor it renders an "image card"; clicking generate calls the image backend (ComfyUI / NovelAI),
  saves the result image to ST's file system and stores metadata in the message's extra, with history paging/regeneration/stale hints;
- it has its own full-screen settings window (channels, character management, settings), and the whole UI lives in a **shadow DOM**, isolated from ST's styles;
- it exposes `globalThis.STBaiBaiImage` (read the character library / generate images), letting other plugins decide where images show (see §9).

Tech stack: Vite + Vue 3 (script setup) + TypeScript, with Vitest unit tests. Outputs are `dist/index.js` + `dist/index.css`.
The version in manifest.json is synced automatically by `scripts/sync-version.mjs` before build (package.json → manifest).

## 2. Directory overview

```
src/
├── index.ts           # Entry: mounts the shadow root, injects CSS, waits for ST then binds each subsystem in turn
├── App.vue            # Main window (mask/window/navigation/pages), Teleport host for dialogs, mobile drawer gestures
├── st/                # ★ The only contact surface with the ST host (every other directory uses ST indirectly via getContext)
│   ├── context.ts     # Typed getContext() wrapper; dynamic access to checkWorldInfo and ST-Prompt-Template
│   ├── imageTagRegex.ts  # Manages two regexes: <bbi_image> display side → empty anchor div, prompt side → empty string
│   ├── messageEdit.ts # Writes back message text (applyMessageText): identity CAS + text computed at save time, race protection
│   ├── keyboard.ts    # Arrow keys in edit controls inside the shadow don't bubble to ST's global shortcuts
│   ├── clipboard.ts   # Single entry for copying to the clipboard (toast on failure; shared by cards/lightbox/history page)
│   ├── images.ts      # /api/images/* upload/delete/list wrappers (grouped into user/images subfolders; artist string previews, gallery)
│   │                  # + probeUserImage: HEAD probe for existence and size (three states: present/absent/unclear)
│   ├── imageFile.ts   # Image reading and canvas scaling (File→dataURL, makeJpegThumbnail; kept apart from the network layer)
│   └── iconFallback.ts# Font icon fallback for injected buttons (guards against beautify themes wiping icons)
├── state/             # Global state and persistence
│   ├── settings.ts    # ★ Settings model + hydrate/persist/migration + cross-plugin shared channel storage
│   ├── ui.ts          # Window open/closed/theme/navigation/floating orb; activePage stored in localStorage
│   │                  # (pure browsing state always uses localStorage; channel tab memory likewise, in backend/index.vue)
│   ├── history.ts     # Request history (LLM reasoning + image generation) module-level in-memory store, deliberately not persisted
│   ├── charTags.ts    # Character fixed-appearance library: this chat's baseline (chatMetadata) + AI floor deltas (message extra),
│   │                  # global library merged in via setGlobalCharTagSource; locked names block AI changes
│   └── globalCharTags.ts # Global character library (extensionSettings, across chats/devices): frozen templates maintained by hand only,
│                      # never writable by AI; two migration paths: promote to global / copy back to this chat
├── api/
│   └── client.ts      # LLM requests: secondary API via ST's server proxy / following the main API via generateRaw
├── autoTag/           # ★ Path A: automatic tags (separate LLM request → protocol validation → injected into text)
│   ├── runner.ts      # Event listening, deduplication, retries, orchestration (entry point)
│   ├── generationGate.ts # Generation gate: pairs auto-tagging with real generations (GENERATION_STARTED arms → final RENDERED consumes)
│   ├── prompt.ts      # Assembles messages: Core Prompt/character/persona/lorebook/specification/protocol/thought chain
│   ├── protocol.ts    # Paragraph-end position IDs, strict JSON parsing and validation, tag injection format
│   ├── clean.ts       # History/target text cleanup (shared exclusion tags; history keeps bbi_image)
│   ├── context.ts     # Lorebook activation (per-entry rendering: macros + EJS), character card, user persona
│   ├── bookMemory.ts  # Reads the global "BaiBai Book" API and parses it into a character reference block
│   ├── charAnchors.ts # Character library: library text injection → fallback replacement of leftover @placeholders (AI copies field values, no placeholders)
│   ├── rebase.ts      # Insertion relocation: text at request time → text at save time (text LCS skeleton + carry-forward)
│   └── slotPlan.ts    # Single-slot rewrite note (rewrite only image N + current prompt anchor + list of other scenes)
├── backends/          # Image backends (the generating end of path B) + shared size tools
│   ├── comfyui.ts     # ComfyUI: workflow template %placeholder% rendering, direct browser connection with automatic fallback to ST forwarding
│   ├── comfyTemplates.ts # Simple mode: template families (checkpoint/flux/anima) + parameters assembled into API JSON (no placeholders)
│   ├── comfyObjectInfo.ts # Fetches model/LoRA/sampler lists (direct /object_info, falling back to four ST forwarding endpoints)
│   ├── comfyWorkflowAssistant.ts # AI locates workflow nodes automatically (fragment ID protocol, no copying of the original)
│   ├── nai.ts         # NovelAI: parameter building, vibe encoding/layering, artist string prefix assembly, .naiv4vibe import/export;
│   │                  # built-in read-only artist string library BUILTIN_NAI_ARTISTS (bi_* prefix, not in settings)
│   ├── naiArtistLib.ts# Pure logic for artist string library management state (search matching/deletion replacement planning, shared by the manager and panel single deletion)
│   ├── naiRateLimit.ts# ★ NAI rate-limit self-healing: error classification + backoff retries + global cooldown/minimum interval (shared by the gate and backend)
│   ├── chatu8Vibe.ts  # Read-only import of vibes / prompt presets from Chiehime (st-chatu8)
│   │                  # (the collect/detect/import pure-function trio; never writes back to Chiehime)
│   ├── vibeGroups.ts  # Pure logic for vibe groups (boxed keys/gathering/search/enabled-set checks)
│   └── size.ts        # Frame orientation normalisation / size parsing / per-orientation config / frame lock (effectiveOrientation)
│                      # (deliberately doesn't import settings)
├── generate.ts        # ★ Shared middle of one image generation: NAI gate → dispatch by backend → get the image.
│                      # The **only** generation path for floor cards and the public API (no saving/display/instrumentation)
├── public/            # ★ Interface open to third-party plugins (globalThis.STBaiBaiImage, see §9)
│   ├── types.ts       # Third-party contract DTOs + apiVersion (separate from pluginVersion; only added to, never changed or removed)
│   ├── api.ts         # Implementation layer: deep-copies outputs, normalises errors into plain Errors with a code, converts images to data URLs
│   └── register.ts    # Hangs on globalThis + ready/changed events + subscribe (frozen API object)
├── floor/             # ★ Path B: floor image cards
│   ├── hydrate.ts     # Render event → anchor × tag pairing → attachShadow per anchor → Vue card mount (idempotent)
│   ├── Card.vue       # The card itself (**pure display layer**; runtime state is in genState.ts) + history paging
│   ├── genState.ts    # ★ Generation runtime store (module-level, survives card rebuilds); read it first when changing card state
│   ├── genQueue.ts    # NAI concurrency gate + pacing waits (ComfyUI relies on the server queue and doesn't pass through here)
│   ├── tagPlanState.ts # Runtime store for "AI rewrite prompt" requests (module-level, separate from genState;
│   │                  # stores {ticket, promise}: closing the dialog doesn't interrupt the rewrite, reopening awaits the same one)
│   ├── collapseState.ts # Module-level store for card collapse state (claimed by slot key; manual collapse overrides the default setting)
│   ├── missingImages.ts # ★ Register of "file no longer exists" paths (module-level reactive): broken pointers left by gallery file deletion,
│   │                  # recorded only when a card's <img> @error → HEAD confirms 404 (never recorded when unclear)
│   ├── Lightbox.vue   # Image zoom layer (including three constraints for long-press saving; read the header comment before changing)
│   ├── lightbox.ts    # Opens the lightbox imperatively (hung on the plugin shadow root, not the card shadow)
│   ├── PromptEditor.vue # Prompt editing dialog (structured fields, not the display string; its own Esc capture); editing by hand and
│   │                  # "AI rewrite prompt" share one window
│   ├── promptEditor.ts# Opens the edit dialog imperatively + writes back to the text (applyMessageText → re-hydration);
│   │                  # also manages hosting/rejoining AI rewrites and refilling after saving (rawTag must refresh too)
│   ├── download.ts    # Save image as (shared by the card's top-right ⋯ menu and the lightbox; same-origin files go through <a download>)
│   ├── storage.ts     # Result storage: extra metadata (swipeId→promptHash→history) + file naming + sidecar json (gallery prompts)
│   ├── upload.ts      # Wrappers for ST /api/files/upload|delete (not the unpublished uploadFileAttachment)
│   ├── autoGenerate.ts# Mark handshake for "generate images automatically after writing tags" (runner ↔ Card onMounted)
│   ├── actionButton.ts# Injects the floor's "Generate image tags" button (shares the #chat observer, idempotent reconciliation)
│   ├── chatObserver.ts# ★ The **only** MutationObserver on `#chat` (multiple subscribers + rAF throttling)
│   ├── slotHealth.ts  # ★ Card health-check criteria (pure functions): detached / hidden-by-host, order can't be swapped
│   ├── registry.ts    # Slot mount record table (chatId|mesid|swipeId|seq → shadow root/vnode)
│   ├── cardStyles.ts  # Builds the shared CSSStyleSheet (theme.css selectors rewritten to :host + card.css)
│   └── card.css       # Card styles (using --bbi-* tokens, the same design language as the settings window)
├── pages/             # Pages of the main window (registry in pages/registry.ts)
│   ├── backend/index.vue      # "Channels" page: tabs (webui hidden) + each backend panel
│   │   └── panels/            # ComfyUIPanel / NaiPanel / WebUIPanel (hidden, code kept) / NaiArtistManager
│   ├── characters/index.vue   # "Character management" page: card-style appearance library CRUD in global/this-chat sections + history rollback
│   ├── gallery/index.vue      # "Gallery" page: browse user/images/柏宝绘_<character name>/ grouped by character name (zoom + view prompts + save as; multi-select deletion **only deletes files, never touches chat history**; group size measured by one HEAD per image but ⚠ disabled for now)
│   ├── history/index.vue      # "Request history" page: debugging aid (LLM prompts/responses/image metadata)
│   └── settings/index.vue     # "Settings" page: channel management/auto tags/prompt editing/interface preferences (the largest page)
├── components/       # Shared components: BbiSelect/BbiCombo/BbiTextarea/Collapsible/ConfirmDialog/FloatingOrb/Icon/ModalMask/NavBar
│                     # (BbiCombo = typeable, filterable dropdown, same interaction as the secondary API model box, menu Teleported to avoid clipping)
├── styles/           # base.css (global base styles), theme.css (theme variables, switched by data-theme)
├── bytes.ts          # Byte count → human-readable size (base 1024, units written KB/MB to match file managers; non-finite values return an empty string)
├── pool.ts           # Concurrency-limited map (mapLimit, output order = input order); used for gallery size measuring/bulk image deletion
├── generationMeta.ts # ★ Schema of generation metadata saved with images (artist string/vibes/sampling parameters) + read-only display formatting; leaf module with zero imports, avoiding a settings↔nai cycle
├── menu.ts           # Wand menu entry injection (polling and similar lazy loading)
├── topbar.ts         # Quick-open button on ST's top bar (controlled by the ui.showTopBar toggle)
└── version.ts        # Version number (__BBI_VERSION__) + asset URLs carrying ver
└── update.ts         # Update check: remote manifest version comparison + automatic update via /api/extensions/update
```

## 3. Startup and mounting (read index.ts)

1. `mount()`: creates `#bbi-app-host` in body (light DOM, `display:contents`), pins inheritable typography properties with
   inline `!important` via `INHERITED_RESET`, cutting off ST style inheritance; the whole Vue app mounts into its **shadow root**;
   `dist/index.css` is injected into the shadow root as a `<link>`, so styles are isolated both ways.
2. `$(() => ...)`: mounts the app, injects the wand menu entry, syncs the top bar button per its toggle.
3. `hydrateWhenReady()`: polls `window.SillyTavern.getContext` (up to ~20s); once ready, in order:
   `hydrateSettings()` → `initGlobalCharTags()` → `bindCharTagSync()` →
   `ensureImageTagRegexRegistered()` → `bindAutoTagging()` → `bindFloorHydration()` →
   `bindTagActionButtons()` → `registerPublicInterface()` → `checkForUpdate()`
   (checks the remote version only once per session, without blocking the rest of initialisation).
   Every bind function is **idempotent** (an internal `bound` flag) and safe to call repeatedly.
   **Two places in the order must not move**: `initGlobalCharTags()` must come before `bindCharTagSync()`
   (the first recomputation must merge global entries into the derived library); `registerPublicInterface()` must come after
   `hydrateSettings()`: before settings are loaded, `getBackendStatus()` reads defaults
   and would report a properly configured user as "not configured", and third parties usually ask right away in the ready event.

Adding a "binding to do at startup" → add a line in `hydrateWhenReady` and make the binding function idempotent.

## 4. Contact surface with the ST host (st/ directory)

**Principle: apart from the `st/` directory, no module may touch ST internals directly.** Specific contact points:

| Contact point | Location | Notes |
|---|---|---|
| `SillyTavern.getContext()` | st/context.ts | The only context entry; returns null when ST isn't ready, and callers poll/degrade |
| `extensionSettings['baibai_image']` | state/settings.ts | This plugin's settings (global, synced across devices) |
| `extensionSettings['baibai_api_channels']` | state/settings.ts | Secondary API channels shared across the "BaiBai" plugins (synced via revision + broadcast events) |
| `extensionSettings.regex` | st/imageTagRegex.ts | Manages two regexes (fixed ids, idempotent registration/overwrite) |
| `chatMetadata['baibai_image_char_tags']` | state/charTags.ts | The character library's **manual baseline for this chat**; automatic AI changes are stored in each message's extra `bbiCharChanges` |
| `extensionSettings['baibai_image_char_global']` | state/globalCharTags.ts | **Global character library** (across chats, revision + broadcast events); maintained by hand only; AI changes discarded for locked names |
| ST events | at each bind | `CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / MESSAGE_UPDATED / MESSAGE_SWIPED / MESSAGE_DELETED / CHAT_CHANGED` |
| `generateRaw` | api/client.ts | One-off completion following the main API (stable ST API) |
| `getWorldInfoPrompt` / dynamic import of `checkWorldInfo` | autoTag/context.ts | Lorebook activation (the latter gets entry objects for per-entry rendering; falls back to the former automatically if unavailable) |
| `globalThis.EjsTemplate` (ST-Prompt-Template) | autoTag/context.ts | EJS execution for lorebook entries (degrades if not installed) |
| `globalThis.STBaiBaiBook` | autoTag/bookMemory.ts | BaiBai Book character state (apiVersion 1; returns null and degrades when unavailable) |
| `globalThis.STBaiBaiImage` + window events | public/register.ts | The public interface **we hang out ourselves** (§9); `st-baibai-image:ready` / `:changed` dispatched on window |
| HTTP proxy | api/client.ts, backends/comfyui.ts, floor/upload.ts, st/images.ts | `/api/backends/chat-completions/generate`, `/api/backends/chat-completions/status`, `/api/sd/comfy/*`, `/api/files/upload|delete`, `/api/images/upload|delete|folders|list` |
| Extension update API | src/update.ts | `GET /api/extensions/discover` (checks the type) + `POST /api/extensions/update` (automatic update); the remote version is read from the GitHub raw manifest.json (8s timeout, silent on failure) |
| Injected DOM | menu.ts, topbar.ts, floor/actionButton.ts | Wand menu / top bar button / floor buttons (not in a shadow) |

Note: the three UI areas have different isolation levels, and different style conventions:
- Settings window: the whole Vue app is mounted in one large shadow root (`#bbi-app-host`), with styles from dist/index.css;
- floor cards: each anchor attaches its own shadow (see §6), with styles from the shared CSSStyleSheet in cardStyles.ts;
- injected buttons (wand/top bar/floor buttons): plain DOM, no shadow, taking ST's styles directly.

## 5. Path A: automatic tags (autoTag/)

Trigger: paired with ST's real generations, without trusting render-type strings. On `GENERATION_STARTED`, `beginGeneration`
(filters out dryRun/quiet/impersonate, records chatId+type); on the final `CHARACTER_MESSAGE_RENDERED`,
`consumeGeneration` consumes only for the same run in the same chat and schedules `runForFloor` (setTimeout 0 waits for ST's internal sync to finish;
a chat switch in the meantime voids it).
**Pitfall: GENERATION_ENDED must not clear the gate**. ST fires ENDED before the final `CHARACTER_MESSAGE_RENDERED`,
so clearing the gate there would mean auto-tagging never fires (fixed in 0.1.15); only `GENERATION_STOPPED` (user interrupt) /
`CHAT_CHANGED` clear it. Every skip path inside the runner has a `[BBI][AutoTagDebug]` diagnostic log, so when debugging
trigger problems the console shows which step blocked it; **on the manual path (floor button) every skip must also show a toast**:
a manual click is explicit intent, and a silent return looks to the user like "clicked the button, nothing happened" (fixed in 0.1.26).

**"Which floors can get images" has a single criterion**: `isStoryMessage` /
`isAiStoryMessage` in `st/context.ts`, shared by floor button visibility, the runner's target gate and the prompt's history selection. The criterion only looks at
`is_system && typeof extra.type === 'string'` (ST only stamps narrator/comment/sys with this),
so **normal floors hidden with `/hide` count as story floors, still get buttons and can still be regenerated**; ST sees them the same way
(messageFormatting forces isSystem back to false for hidden floors, which is why our anchor regex works on hidden floors).
The old actionButton had its own copy that read the DOM's `is_system` attribute directly, so hidden floors never had buttons, and attribute changes
weren't in the observer's watch list either, so in the same chat "floors rendered before hiding kept their buttons, floors re-rendered afterwards
had none" (fixed in 0.1.26). Likewise, detecting "whether the text has tags" converged on
`imageTagRegex.hasImageTagTrace`: the button layer once recognised only open tags while the runner layer recognised both, so a floor whose text had only
a lone `</bbi_image>` left got stuck at "clicked, never anything happens".

```
runForFloor(floor, opts)
  1. Filter: AI story floors only; skip if <bbi_image> already exists and it isn't a manual replace
  2. Identity dedup: chatId\0floor\0swipeId\0textHash → processed Set; manual bypasses it
  3. One AbortController per floor: a new task on the same floor aborts the old one; CHAT_CHANGED cancels everything
  4. Assemble context:
     - bookMemory.readBookMemory  → BaiBai Book character reference block (may be null)
     - charAnchors.resolveCharAnchors → library text (purely local rendering, no request; an empty library returns text=null)
     - prompt.buildAutoTagMessages → message array (see below)
  5. Request: if getTagGenChannel() has an assigned channel → requestCompletion (server proxy);
     otherwise requestViaMainApi (generateRaw). **Only this one request per floor**: profile creation and scene selection are one
     inference: first establish new characters' appearance in changes, then in the same output's tags @reference them and build
     the other tags around them. (The old version had another "CJK appearance → fields" conversion request, now deleted: BaiBai Book's CJK desc
     already goes to the main request with the character reference block, and the main request also has the lorebook/character card/text as evidence, so its judgement is better.
     When the channel sets a reasoning effort, the request body switches to the custom source; see §7 secondary API channels.)
  6. Retry loop: retryCount times (request exceptions / parse throws are both retried; abort uses none; "no scenes" isn't a failure)
  7. protocol.parseImagePlan strict validation (JSON structure/target position IDs/no sub-tags allowed/size degrades leniently to portrait);
     changes are lenient throughout: a bad item only drops itself and never affects images; missing one character profile only means that character isn't anchored this round,
     while voiding the whole output for it would lose the images too. The image count follows the `minImages～maxImages` range: above the maximum it is hard-truncated locally,
     below the minimum (when >0) it throws for the retry loop; the minimum is the user's explicit requirement, so retrying beats handing over an incomplete result.
     Each image may carry `characters` (NAI 4.5/V5 native multi-character prompts, ≤32 entries, name/tag/nl, lenient parsing where a bad entry only drops itself),
     serialised into a `<characters>…</characters>` sub-tag on injection; under 4.5/V5 profile creation (new) must carry nl, otherwise the runner throws and retries
  8. changes are converted together with BaiBai Book profile creation into floor delta ops (bbiCharChanges in extra), not saved to the library early
  9. @placeholder fallback replacement: applyPositionedCharRefs replaces leftover @character names in tag/nl with the library tag after "baseline + this floor's
     ops replayed". **Profile creation (new) applies to the whole floor**: a new character's fixed appearance is a fact holding throughout the floor;
     **only permanent changes (set) are gated by position**, so images before a hair dye use the old profile. Unknown placeholders are stripped with a toast warning.
     (The main path was withdrawn from v0.1.2: the AI now copies library field values directly, see the character library part of §7; expanding multiple characters
     multiple times duplicated appearances, causing overlapping torsos, and the tag budget couldn't be enforced; the applyCharRefs family is kept as a fallback)
 10. rebase.rebaseImagePositions shifts insertion positions from "the text at the start of the request" to "the text at the moment of saving"
     (cleaned narrative lines get a skeleton by text LCS, gaps are paired by sequence ratio, and whole sentences that vanished carry forward to the previous anchor),
     then protocol.injectImageTags inserts after the new physical line
     <bbi_image>tag<nl>…</nl><negative>…</negative><size>…</size></bbi_image>
 11. If autoGenerate is on: first markForAutoGenerate each new slot (see the path B handshake)
 12. messageEdit.applyMessageText writes back (text + extra delta together). Identity CAS: if chat/message/swipe
     changed at all, give up; **text content takes no part in the comparison**: edits other plugins made to the text during analysis (translation, polishing,
     appended status bars, rewritten stock phrases) are all kept, and tags are relocated and injected as usual. It only gives up when the cleaned current text has
     no narrative line left, or bbi_image is found to exist already before writing back (build-failed).
     Only on success recomputeCharTags; on failure the marks are revoked; changes without images still go through write-back.
```

Message order (fixed in prompt.ts): Core Prompt system → character card system → persona system → lorebook system →
backend specification system (the built-in ComfyUI/NAI spec, with the `{{nl}}` macro and `{{#nl}}`/`{{^nl}}` conditional sections expanded per the "Generate Natural Language" toggle) → fixed protocol
(identity definition + output contract: one `<thinking>` block and one JSON object, the JSON containing images + changes) → thought chain system → user (character reference + character library + the cleaned last N AI story floors and the user floors between them + the target text with paragraph-end position IDs).

**The protocol shape is computed only once (`autoTagProfile()` in prompt.ts)**: `{naiCharPrompts, nl, lockedSize}` is computed from the default backend
and its toggles, and protocol writing (prompt.ts) and acceptance/finishing (runner.ts, which snapshots one per run) share the same one; if each side computed its own
they would drift sooner or later: the protocol says tags only, while acceptance still demands nl.
- `nl`: ComfyUI takes the current workflow's "Generate Natural Language", NAI takes `settings.nai.naturalLanguage` (only meaningful for 4.5/V5).
  Both toggles follow the same rule and **only control whether the AI writes it**: when off, the runner discards nl the model wrote anyway (kept, it would be sent as usual, as if the toggle weren't off),
  and skips the "4.5/V5 profile creation must carry nl" check; **nl already written into tags is sent as usual** (the raw tag text is the source of truth and isn't edited after the fact).
- Conditional sections (`expandNlSections`): `{{#nl}}…{{/nl}}` kept when on, `{{^nl}}…{{/nl}}` kept when off; both backends'
  specifications and thought chains are expanded (including user-customised ones), so one text is self-consistent on either side of the toggle, without maintaining two copies that drift.
  Nesting isn't supported; unmatched markers stay as-is (a mistake is visible in request history, easier to find than if silently swallowed).
- `lockedSize` (`activeOrientationLock()`, see the frame lock in §6): when locked, the protocol's size rule becomes "fill the locked value for every image",
  and the example JSON fills it too, so the AI **composes for the locked frame** rather than writing for portrait and then being forced to landscape by the image side;
  unlocked, it stays "fill portrait when unsure". At finishing, the runner rewrites size to the locked value, so the orientation recorded in the tag matches the actual frame.

All editable prompts (Core Prompt/specification/thought chain) have built-in default constants in `state/settings.ts`
(`DEFAULT_*_PROMPT`/`DEFAULT_*_SPEC`), and blank falls back to the default; to change default prompt content, look here first.

⚠ **The settings page exposes only two specification/thought chain pairs: ComfyUI and NAI**. The latter is stored in `naiV5Spec` / `naiV5Thinking`
(the V5 in the key names is historical; the content applies to 4.5 too, and the panel labels were changed to the generation-neutral "NAI Specification/Thought Chain").
There are also `naiSpec` / `naiThinking`, the single tag string versions for below 4.5, which with the retirement of old models (see `NAI_MODELS` in §6)
**no longer have a UI entry**: only 4.5/V5 can be chosen → `naiCharPromptsOn` is always true → those two are never reached.
Keys and constants are deliberately kept (existing settings untouched, protocol branches and regression locks for old model ids untouched),
but **to change the NAI specification/thought chain, always change the `DEFAULT_NAI_V5_*` pair**, not the one whose name looks more correct.
## 6. Path B: floor cards and image generation (floor/ + backends/)

**How display works (st/imageTagRegex.ts)**: the managed regex `bbi-image-tag-slot` (markdownOnly) replaces
`<bbi_image>…</bbi_image>` on the display path with an empty anchor `<div data-bbi-slot=""></div>`;
`bbi-image-tag-hide` (promptOnly) replaces it with an empty string on the prompt path, so tags never enter the DOM and never enter the prompt.

**placement must include 3 (SLASH_COMMAND)**: the display-side placement is dispatched by message type by `getRegexPlacement` in `script.js`:
user floors 1, AI floors 2, and **narrator floors with `extra.type==='narrator'` are 3**.
Floors made by `/narrator` and `/sys` are `is_system:false` + `extra.type:'narrator'`, so
`isAiStoryMessage` **counts them as story floors** and auto-tagging writes tags into them; with only `[1,2]` the anchor regex never matches at all,
the raw tag text has its wrapper stripped by DOMPurify and shows as body text (users see a raw string of danbooru tags), and no anchor = no card,
so "tags never enter the DOM" is broken on this kind of floor. On the prompt side ST only uses 1/2, so 3 on the hide rule is a no-op,
but keeping both rules' placement identical is easier to reason about (replaceString is an empty string, so covering one more placement has no side effect).

**Hydration (hydrate.ts)**: render events (CHARACTER/USER_MESSAGE_RENDERED, MESSAGE_UPDATED, MESSAGE_SWIPED) →
locate `.mes[mesid] .mes_text` → `parseImageTags(message.mes)` **paired in order** with DOM anchors →
each anchor gets `attachShadow`, then `render(h(Card,...), shadowRoot)`, recorded in `SlotRegistry` (key = chatId|mesid|swipeId|seq).
Before re-hydration, `render(null, container)` unmounts explicitly; the whole thing is idempotent. MESSAGE_DELETED / CHAT_CHANGED rebuild everything.
Hydration after events goes through `scheduleHydration`: setTimeout 0 hydrates once, then checks again after ~100ms, since other ST listeners
may replace `.mes_text` after the event (in the late pass, unchanged anchors only get a props patch, zero rebuilds); a chat switch voids it.

**Self-healing layer (healSlots in hydrate.ts + floor/chatObserver.ts): the half that event-driven hydration can't cover**:
anchors live **inside** `.mes_text`, and ST itself has several paths that rewrite `.mes_text` **without firing any event**:
`.mes_text.html(...)` in `updateMessageBlock` (script.js:1988), `.empty()` in `messageEditCancel/Done`,
and `.mes_text.html('...')` when swiping right to generate; third parties (prompt template plugins) also call
`container.html(newContent)` in their own render hooks. These paths delete anchors along with their shadow roots, and purely event-driven hydration never notices,
while genState is module-level, so in-flight generations still run to completion. The user report **"the image is generating, but the floor shows no UI"** was exactly this.
The neighbouring BaiBai Book doesn't have this problem not because it's sturdier, but because its host hangs **outside** `.mes_text` as a sibling node,
and `.html()`/`.empty()` only clear innerHTML; this plugin's cards must sit at the tag's inline position (multi-tag floors render an image per
position) and can't move out; the same constraint once ruled out the official `extra.media` approach (see §6). So self-healing is
the only answer under the position constraint. The criteria are extracted into `floor/slotHealth.ts` (pure functions; the repo has no jsdom, so duck-typed fake nodes are used in unit tests):
- `detached` (anchor detached from the document) → re-hydrate only **the affected floor** (deduplicated per floor);
- `hidden-by-host` (anchor present, but the ancestor `.mes_text` carries `inline_media` = ST's `display:none`)
  → **only console.warn, never forced**. That hiding is intentional on ST's part (the meaning of `extra.inline_image===false`
  is "this floor shows only the image, not the text"); forcing it off would bring back text someone deliberately hid; and once an inline style is pinned it
  can't be undone (ST later recomputes classes from extra but can't reach the style we wrote), exactly the kind of hidden trap that "can't be changed and keeps applying".
- The order can't be swapped: on an element detached from the document, `closest()` still walks up the **disconnected subtree** and may really find
  the `.mes_text` carrying `inline_media`; checking hidden first would misdiagnose "a deleted floor" as "only hidden",
  so instead of remounting it would just edit a node not in the document, and the card would never come back (slotHealth.test.ts locks this).

**There is only one `#chat` observer (floor/chatObserver.ts)**: floor button reconciliation and card self-healing watch the same tree
with the same `childList+subtree`, so they are merged into one observer with multiple subscribers. **This also answers "will self-healing cause constant lag?"**:
no. The cost is on the browser's side of collecting MutationRecords, and that cost has been paid since the day floor buttons shipped;
the marginal cost of a new subscriber is just one more function in the callback. Constraint: subscriber callbacks must be **cheap reconciliation**
(healSlots is O(mounted cards), each doing only an `isConnected` property read + one `closest()`,
touching the DOM only when it really finds a problem); **never run `hydrateVisible` in a callback**: that runs
`parseImageTags`+`readStore`+`promptHash` for every message, which is real lag. **Subscribe only to childList, not attributes**:
otherwise self-healing/theme attribute writes would wake the observer itself, a self-exciting loop.

**Why cards are in the shadow DOM**: floors live in ST's light DOM, where ST's global styles and users' beautify themes
would change cards directly. Each anchor gets its own `attachShadow` → styles isolated both ways (same structure as the main window in index.ts,
just going from "one big host" to "one small host per slot"). Two notes:
- **Inheritable properties** (font/color/line-height…) still cross the shadow boundary → `CARD_INHERITED_RESET` pins them on the host;
- **custom properties** cross too → so `theme.css`'s `data-theme='st'` can still read the host's `--SmartTheme*`.
  Styles are shared through `adoptedStyleSheets` as **one single** CSSStyleSheet object (cardStyles.ts), so N cards have zero duplication.
  Since 0.1.9 the settings page dropped the "floor card theme" option (cards became borderless and always follow ST's theme), but
  the `settings.ui.cardTheme` field and hydrate's reading of it are kept: values old users set keep applying, so don't delete it as dead code.

**Card state machine (Card.vue + genState.ts)**:
- **Runtime state** (a module-level reactive Map in genState.ts, same key as above): `queued / generating / error`
  **must live outside the component**. Under diff hydration a same-anchor card gets a props patch, not a remount, but once ST re-renders and
  rebuilds the anchor, the component is rebuilt wholesale anyway; this is also why reconcileGen moved from onMounted to `watch(hash, immediate)`
  (under the old remounting hydration onMounted always ran; under diffing it may not). If runtime state lived in a component ref, it would reset on every rebuild →
  sibling cards' "Generating…" would vanish together and fall back to pending (the mark was already consumed, so no rerun). This was the root cause of a historical bug.
- **The ticket (token) can't be dropped**: the key only identifies the slot, not "which task". The same slot can run several tasks one after another
  (cancel then redraw, retry after reconcile), and an old task's late callback must be claimed by token;
  otherwise A failing with a non-AbortError after being aborted (HTTP 500/429 colliding with the abort) would mark **the running B**
  as error. `failGen/clearGen/setGenPhase/setQueueAhead` all require the token;
  before saving, `isCurrentGen` self-checks too, so an old task's image never goes into extra.
- **Vanished slots must be pruned**: `reconcileGen` can only be triggered by a mounted card, but when the user deletes a tag / swipes to
  a version with fewer tags, the slot vanishes entirely, and its record would stay forever and be claimed by a later new card with the same key.
  `hydrateMessage` calls `pruneGenSlots(…, tags.length)`, deleting only out-of-range slots with `seq >= tag count`;
  **in-flight siblings must not be cleared with them**, which would bring back the bug this refactor fixed in another form (locked by unit tests).
- **Derived state** (computed from props): `ready` (has history for this prompt) / `stale` (only old-prompt results) / `pending`.
- Image display **deliberately ignores runtime state**: during failure/redraw the previous image keeps showing, avoiding "clicked redraw, it failed → the image vanished".
- onMounted: first `reconcileGen` (void the old task if the hash changed), then consume the autoGenerate mark and start automatically;
  **the mark is always consumed before checking whether to run**: if kept, when the same slot reappears later (e.g. the user deletes the old image) a new card would
  claim it by mistake and start a generation the user never clicked. The check is extracted into the `shouldAutoGenerate`
  pure function in `autoGenerate.ts` (Card.vue has no unit tests: the repo has no jsdom, vitest runs in node, and it couldn't be locked down inside the component).
  `'auto'` lets through `pending` and **`stale`**: stale means exactly "the tag changed and the current prompt has no image yet",
  precisely when an image should be generated; the old version let only pending through, so a floor's "regenerate tags" silently did nothing on floors that already had images
  (new tags were written, but the card stayed on the old image), and multi-tag floors were stranger: slots with old images were blocked while brand-new ones ran.
  `'force'` (the user clicked "Apply and regenerate") runs unconditionally, since changing back to an old prompt may find history already in that bucket.
- generate(): inputs are read on the spot into `job` (while in flight the component may well be destroyed, and reading props is unreliable) → fix the seed →
  call `generateImage` in `generate.ts` (the gate and backend dispatch are inside) → `saveImageResult` saves →
  clear runtime state → `hydrateMessage`.
  **Lightbox callbacks likewise**: the lightbox hangs on the plugin shadow root and outlives the card, so floor coordinates must be snapshotted and passed as arguments
  (`removeEntry(target, at)`), never read from props in the callback.

**The image generation middle is extracted into `src/generate.ts` (shared by cards and the public API)**: one image generation is split into three parts:
before (register runtime state/validate parameters), **middle (gate → backend dispatch → get the image)**, after (save/display/instrumentation).
What the public API wants is exactly the middle without the ends: third parties decide where images show.
- **The gate can't be bypassed; that is the first reason for extracting it**: calling `generateNaiImage` directly would run outside the genQueue gate and
  naiRateLimit's global pacing, and 0.2.0's whole rate-limit self-healing would fail on the spot; concurrent calls from third parties are the norm,
  and the symptom of bypassing is the user's NAI account eating a burst of dense 429s, while the user just thinks BaiBai Image is broken. So both paths share this function,
  with `release` wrapped in `finally` (`generate.test.ts` locks "return the slot even on throw").
- `backendStatus()` is the **single criterion** for "can an image be generated": the card button's `configured` and the public API's
  `not_configured` share a source, avoiding "the card is clickable, and only generation reports an error".
- **Instrumentation is deliberately left to callers**: each caller judges a history record's "success" differently; floor cards only count it a success once saving succeeds,
  and must record "image obtained but discarded because the task was superseded" as cancelled; this module only knows whether the request itself succeeded,
  and deciding for callers would falsely report those two cases as success. So `decideSeed` is exported separately, and callers fix the seed first and pass it in.

**Frame lock (`OrientationLock` = `'auto' | 'portrait' | 'landscape'`)**: the old way to get "landscape only / portrait only" was filling the landscape and portrait
size cells with the same values; it worked, but the AI still composed for portrait/landscape separately when writing tags, and the image side then forced it into the same size.
- **Placed next to each channel's sizes**: one at the NAI channel level (`settings.nai.orientationLock`), and for ComfyUI **one per workflow**
  (`ComfyWorkflowPreset.orientationLock`, a base-model property like the landscape/portrait sizes, so switching workflow switches the lock).
  The criterion lives only in `activeOrientationLock()` (taking the one for the current backend; other backends `'auto'`),
  shared by four places: the protocol (§5 `autoTagProfile`), image generation (generate.ts), cards and the edit dialog.
- **Applies only at the moment of generation**: `effectiveOrientation(lock, input.size)` in `generateImage` decides which size cell this run uses;
  cards and the public API both go through here (when locked, the size the public API passes doesn't count), and `GenerateOutput.size` reports the actual orientation;
  the card's history record/no-image placeholder ratio and the public API's gallery sidecar both record it, describing the image truthfully.
  **The raw tag text isn't changed**: promptHash consumes the raw text, and rewriting it would turn old images stale for no reason; when the channel goes back to "Auto", the orientation recorded in old tags applies as-is.
  New tags are recorded with the locked value directly by the runner (§5); old tags aren't rewritten after the fact.
- Default `'auto'` (= pre-upgrade behaviour): old configs missing the field and dirty values all fall to `'auto'`, with no migration.

**Concurrency is a backend property, not a global setting**:
- **ComfyUI sends everything at once**: `POST /prompt` puts it in the **server** queue as soon as it gets a `prompt_id`, polling checks each
  `history/{id}` separately, and ComfyUI executes in order itself. Another client-side queue would be redundant. While polling it checks `/queue` to report
  queue position (`onQueue`), and the card shows "Queued (N ahead)" rather than always "Generating".
- **NAI needs a gate** (genQueue.ts, `settings.nai.concurrency`, default 1): `generate-image` is a blocking
  POST with no server queue, and pushing concurrent requests gets 429s.
- **Cancelling must branch** (`cancelPrompt` in comfyui.ts): task queued → `POST /queue {delete:[id]}`;
  running → `POST /interrupt` (with prompt_id). **A blind /interrupt interrupts another task that is running**;
  the old implementation did that, and it always happened under concurrency. Unit tests lock both paths.

**NAI rate-limit self-healing (backends/naiRateLimit.ts)**: the gate only controls "how many at once", not "how fast each one".
After release, `pump()` runs immediately and the next task goes out in the same tick; and errors are **isolated per slot**, so when
rate-limited it produces a dense burst of failures (429 → release → again right away → 429), exactly the shape that most looks like abuse.
The policy layer is gathered in one place, with every timestamp injectable (so it can be unit tested without fake clocks):
- **Error classification** (`shouldRetryNai`): only 408/429/5xx (except 501) and fetch's `TypeError` are retried;
  configuration errors like 400/401/402, and our own validation/parse errors, throw immediately. **Without classification, a mistyped key
  would be amplified by backoff retries into four times the requests**. Cancels (AbortError) are never retried.
- **Backoff retries** (`runNaiWithRetry`, 4 attempts in total): exponential backoff + 50%–100% jitter (so several cards don't wake
  at once and collide again), `Retry-After` as the **floor**, and a single wait clamped to 60s. Only "send the request + unpack" is wrapped;
  assembling parameters and reading vibe data are one-off work, and rerunning them would waste effort and repeat the vibe warning.
- **Global cooldown**: besides backing off the current request, a 429 puts **the whole gate** on cooldown (`noteNaiRateLimited`,
  default 15s or per `Retry-After`, **only extending, never shortening**). After taking a slot, `acquireNaiSlot` loops until
  `naiPacingDelayMs()` has elapsed before returning; it loops because other slots may push the cooldown back during the wait.
- **Minimum interval** 1500ms: a safeguard for cases where generation time doesn't create a gap on its own (small images/few steps/fast failure resends).
- Two disciplines: pacing waits **hold the slot** (otherwise N tasks within the limit would wait out the same period and then all send together, making throttling
  useless); a cancel during the wait **must return the slot** (missing one permanently loses a concurrency slot; miss enough and no request can ever be sent again).
- Cards must show the backoff (`GenRecord.retry` → "Request limited, retry N/M shortly…"). Otherwise "Generating…" sits
  motionless for tens of seconds, users assume it froze and click again, needlessly adding another request.
- `encodeVibeImage` retries too, and NaiPanel takes a gate slot for it (`encodeVibeGated`): it is also a
  real NAI request, otherwise "generating and encoding at once" would be two concurrent requests on the account. `testNaiConnection`
  **deliberately skips the gate**: the diagnostic button is most often clicked while rate-limited, and blocking it would only make troubleshooting impossible.

**Editing prompts by hand (PromptEditor.vue + promptEditor.ts)**: the prompt's **only source of truth is the raw tag text in the message**
(not in extra, not in a store), so "editing a prompt" is essentially a text write-back: serialise the new tag →
`replaceImageTagAt` replaces tag number seq in place → `applyMessageText` → re-hydration. The new tag gets a new promptHash,
and old images fall into the stale bucket automatically (the card already has an "old prompt" badge and hint line), so "Apply" needs no extra saving logic.
Key points:
- **Serialisation exists only once** (`serializeImageTag` in `st/imageTagRegex.ts`, also called by `injectImageTags`).
  If the two drifted, "parsed fields" and "raw text saved into the message" wouldn't match, and since promptHash consumes the raw text,
  it would look like "nothing changed, yet everything turned stale". Likewise "change detection" compares **field values**, not serialised output:
  parsing is lenient and serialisation is canonical, so opening a non-canonical hand-written tag and saving it as-is would change the raw text.
- **Sub-tag literals must be blocked** (`containsTagMarkup`, sharing `FORBIDDEN_SUBTAG` with the AI side): the find regex is
  non-greedy, and a `</bbi_image>` mixed into the content would cut the tag off early, **leaking the second half into the DOM and prompt**.
- **Card.vue's `promptText` must not be edited**: it is a display string with "Role: " / "Negative: " prefixes,
  and can't be parsed back reliably. Edit the five structured fields, and carry back unedited ones as-is, otherwise characters would be silently eaten.
- The dialog hangs on the **plugin** shadow root (like the lightbox) and outlives the card → all floor coordinates are snapshotted when it opens;
  identity CAS can't catch "the tag count changed", so before writing back it checks itself by `rawTag` that seq still points at the same tag.
- ⚠ The stale state shows only **one** image (`latestStaleEntry` returns a single entry, and `pageable` requires
  `history.length > 1`, so the pager doesn't appear at all). Changing the prompt when the old prompt has N images → only the newest stays visible
  (neither files nor pointers are deleted; changing it back recovers them all). The dialog gives a clear hint about this.
- When the channel locks the frame orientation (`activeOrientationLock()`), the orientation buttons show the locked value, disabled, with a one-line note: generation always
  follows the lock, and letting people choose would only be a toggle that does nothing. **The size in the draft is untouched**: the orientation recorded in the text stays as-is
  (so promptHash doesn't change for no reason), and when the channel goes back to "Auto", each image is generated in its own orientation again.

**"AI rewrite prompt" (entry in the edit dialog; `requestSlotTag` in runner.ts + slotPlan.ts)**: the difference from "Redraw":
redraw generates another image with **the same prompt**, while this has the AI reread the floor's text and **rewrite this one tag's content**.
It still depicts the original moment, just with a more accurate, fuller prompt. This discipline is enforced on the write-back side,
which replaces in place by seq; **the position the model returns takes no part in write-back at all**, so "whether the scene changes" is decided only by
the wording of `buildSlotTaskNote`; the old line "choose another moment clearly different from them" was exactly the root cause of the button
(saying "Rewrite prompt") not matching the instruction the model received (which was really "change the scene").
Analysis and write-back both revolve around a single slot, without touching other tags and images on the floor:
- The analysis base is `stripImageTags(whole floor)` (the AI shouldn't take tags for story text), and `buildSlotTaskNote` **feeds that slot's
  current prompt back verbatim as the anchor** (not truncated: without the full text the model can only guess from the story which moment this image depicts,
  and a wrong guess becomes a scene change again); summaries of the other slots are still included, but for "don't take their scenes", not "don't select them";
- `min=max=1` is forced (both build's rule wording and `parseImagePlan` validation must cover it; changing only one would contradict itself);
- the library text takes `charTagsBeforeFloor(floor + 1)` (including this floor's recorded deltas), otherwise the AI would rewrite characters profiled in the first round
  as newcomers; **this run's AI changes are always discarded** (the first full analysis already created profiles for the whole floor, and reapplying would only pollute history);
- write-back is `replaceImageTagAt` replacing tag number seq in place (like PromptEditor), checking by `rawTag` before writing that seq
  still points at the same tag; on success `markForAutoGenerate(..., 'force')` makes the slot generate with the new prompt automatically,
  the old image falls into the slot's stale bucket, and other slots go through diff hydration with zero image rebuilds;
- **the entry is in the prompt editor dialog, not a separate button**: editing by hand and by AI are two means to the same end, and only together can users
  "have the AI write a version → keep editing by hand if it doesn't feel right". Three constraints (explicit user requirements) and where they land:
  - **the dialog doesn't close automatically**: vanishing after one click looks like a crash. When done it only refills the input box + shows a one-line note;
  - **still saved directly**: saving and generation are done by the runner, unrelated to the dialog, and happen whether or not it is closed;
  - **closing doesn't interrupt, and reopening rejoins**: the request is hosted by `runTagPlan` in `floor/tagPlanState.ts`,
    its lifetime belonging to the store, not the dialog; on reopening, `awaitTagPlan(key)` gets back **the same in-flight promise** to keep waiting on
    (that is exactly why it stores {ticket, promise} rather than a boolean). After finishing it rereads tag number seq from **the current text**,
    refreshing both `content` (refilling the draft) and `rawTag` (otherwise the user's next "Apply" would hit "this tag has been
    changed", and what changed it was us).
  - ⚠ **Never render again after unmounting** (the `closed` gate, a real regression hit during 0.3.0 development): the rewrite outlives the dialog,
    its completion callback necessarily arrives after the dialog closes, and `paint()` calls `render(...)` unconditionally. The key is that
    **`remove()`-ing the container doesn't make it invisible**: `ModalMask` `<Teleport>`s the content to `modalHost`,
    so rendering once into a detached container brings the dialog back to life, stuck on screen; and what comes back is a **brand-new instance** (the `closing` watch
    has no `immediate`, so mounting with `closing=true` doesn't hide itself), while `requestClose` / `onApply`
    both return early on `closing` → close, cancel and apply **all stop responding, and the window can never be closed**.
    So the first line of `paint()` is `if (closed) return;`, and `closed = true` must come **before** `render(null)`
    (a late paint slipping in between would mean the unmount removes only the new instance it just mounted, closing for nothing).
- The card still shows the "AI rewriting prompt…" overlay with a cancel button: closing the dialog doesn't stop the rewrite, and without this way out
  there would only be an image quietly changing with no way to stop it. Display state reads `isTagPlanning`; cancelling goes through `cancelFloorTags`
  (sharing the "one per floor" in-flight lock with full analysis).
  ※ To **change the scene** (rather than rewrite the prompt of the same scene), use a different entry: the palette button in ST's ⋯ menu
  (`floor/actionButton.ts` → `requestFloorTags({replace})`), which re-analyses the whole floor.

**Card collapse (collapseState.ts + Card.vue)**: collapse state is "temporary concealment" UI state, not data:
it is stored in a module-level store and **not written to message.extra** (calling saveChat on every collapse would be wrong in both cost and meaning); after a refresh it
falls back to the setting `settings.ui.autoCollapseImages` ("Collapse floor images by default"). Like genState it must live
outside the component: swipes/edits/ST re-renders all remount cards, and in a component ref, images the user collapsed would pop open by themselves; the key has the same
structure as genState (chatId|messageId|swipeId|seq), claimed by key after rebuilds. Slots manually collapsed/expanded
override the default (`isCollapsed` takes `Map ?? default`); there is no active cleanup (a slot holds only one boolean, leftovers from old chats
are negligible, and still being there when switching back is the desired behaviour). When collapsed the card shrinks to a thin bar, showing generating/error state directly on the bar,
and clicking the whole bar expands it.

**Card layout (card.css)**: cards are elements **embedded in the chat**, not standalone panels; every extra pixel pushes the text apart.
So the header and footer are fixed at "the height of one row": header `4px padding + 26px button = 34px`, footer collapse entry
one row of `5/6px padding + 22px`. **All buttons share one baseline**: `.bbi-btn` is 26 tall, and `.bbi-btn--icon`
must be `width == height == 26` with icons uniformly 15px; writing width without height made icon buttons
a notch shorter than text buttons, visibly uneven in the same row (a historical bug). Icons themselves need optical alignment too:
the ink extent of `trash/copy/download` must be similar, otherwise they look different sizes at the same pixel size.
Division of actions: **the header holds only actions "on the current image"** (download/delete/redraw); prompt actions (copy)
go with the prompt into the expanded area; the copy button in the expanded area is **absolutely positioned**, since a side-by-side flex would make it float to the middle with long text.

**Floor image display size (`settings.ui.imageDisplaySize`, "Floor image display size" on the settings page)**: only controls **how large it shows in the chat**,
never touching the generation resolution or the image file. Small/medium/large = display height capped at 400/600/800px (default "Medium"), "Fill" = the old behaviour of
filling the floor width. Card.vue sets `data-capped='1'` + `--bbi-figure-max-h` per `imageDisplayMaxHeight()`:
- **Cap height, not width**: what feels too big on PC is portrait images taller than one screen after filling the floor width; capping by width would leave portrait images just as tall and shrink landscape ones instead.
- The stage shrinks to the image's own width with `width: fit-content`: the ⋯ button, pager and badges are all absolutely positioned on the stage, and if the stage didn't narrow
  they would float in the blank space beside the image. Width keeps `max-width: 100%`, so narrow screens still scale by width.
- The no-image placeholder has no content to give it width (fit-content would collapse to 0), so its width is derived from the frame ratio to make "the height exactly reach the cap".
- Defaulting to "Medium" rather than "Fill" is deliberate: old configs missing this field fall to "Medium" with no migration; the old behaviour is exactly the problem being fixed,
  and anyone wanting it back picks "Fill" in the dropdown.

**⋯ menu laid out horizontally on all platforms (`.bbi-figure__actions` in card.css)**: the menu spreads horizontally to the left of ⋯, wrapping when it doesn't fit
(`max-width` never crosses the stage's left edge, and `row-reverse` + `align-items: flex-start` keep ⋯ pinned to the top-right when expanded/wrapped).
Touch screens once expanded it vertically below ⋯: landscape images on phones are only around two hundred pixels tall, so six or seven buttons stacked vertically ran past the stage's bottom edge, got clipped
by `overflow:hidden`, and the last few couldn't be pressed. The interaction split of hover to reveal on desktop and tap ⋯ to expand on touch is unchanged.

**Image zoom and long-press saving (Lightbox.vue)**: ST's native lightbox is out of reach: the entry `.mes_img` is only a class,
`expandMessageMedia` reads `chat[mesid].extra.media[data-index]` and is module-private, not exported; going through the official
`extra.media` would hang images on `.mes_media_wrapper` (a sibling of `.mes_text`), away from the tag's inline position. So it is built in-house.
**Long-press saving relies on three constraints** (always read Lightbox.vue's header comment before changing): listen only to `click`, never intercept touch;
don't add `user-select:none`/`-webkit-touch-callout:none`; set `touch-action:auto` explicitly to cancel ST's
`body{touch-action:none}` (css/mobile-styles.css:251). The lightbox hangs on the **plugin** shadow root and Teleports
to `modalHost` (it needs the `--bbi-*` variables); it can't hang on the card's own shadow, where `.mes_text`'s stacking context would clip it.

**Storage (floor/storage.ts)**, in three layers:
- New image binaries → ST file system `user/images/柏宝绘_<character name>/bbi_<character name hash>_<swipeId>_<promptHash>-<genId>.<ext>`
  (the character name prefers the message speaker, then the current chat's character name, falling back to "未命名角色" when empty;
  on upload via `st/images.ts` the server sanitises the folder name, and the file name keeps the stable promptHash);
- metadata → `message.extra.bbiImage = { [swipeId]: { [promptHash]: BbiImageEntry[] } }`
  (history in chronological order, for card paging; `slotSeq` isolates multiple tags on one floor; `meta` stores generation metadata, so the gallery's current chat needn't fetch sidecars).
- Sidecar → `user/files/<same name as the image>.json`, storing the raw tag text + seed + `meta` (generation metadata),
  **only serving the gallery**:
  the gallery lists images by folder across all chats, while prompts are only in one chat's extra, and reverse-looking-up by scanning every JSONL is infeasible
  (one character's chats folder can reach GB size, and `/api/chats/get` returns the whole file with no pagination).
  The file name is derived from the image name by the pure function `sidecarFileName`, with no index maintained (`/api/files/upload` saves as-is, validating without sanitising).
  json can't go into `user/images` (the upload endpoint's format must be a media extension), so it goes to `user/files`.
  **A failed write only warns, never throws**: the image is already saved, and one auxiliary json must not lose the image; old images having no sidecar is normal.
- **Generation metadata (GenerationMeta)** is saved with the image, holding provenance "not in the tag text": the artist string (name + text snapshot),
  the vibes actually layered (name/configured strength/actual strength after normalisation), model, frame pixels, the positive/negative words actually sent, and sampling parameters
  (plus ComfyUI simple mode's template/base model/VAE/CLIP/LoRA). **It must bubble up from the backend at the moment of generation**
  (NAI's `generateNaiImage` returns `usage`, assembled into `GenerateOutput.meta` by `generate.ts`), never read from settings at save time:
  first, under concurrency it would be attributed to the wrong image; second, only the backend knows "which vibes were actually not skipped". Custom workflow bodies are never stored.
  The sidecar's `v` went up to 2 to mark the added `meta`, and the read side degrades naturally for old `v:1` files and old entries without `meta`.
- Write-back uses a CAS loop (`mutateStore`, reference comparison + `saveChat`); save order: file first, then pointer / on deletion pointer first, then file.
- Old `user/files` images are neither migrated nor deleted and show from their original paths; deleting an old record only removes the pointer, and the file delete endpoint is only called for `user/images` images (together with their sidecars).
- **Gallery image deletion is a different path** (`deleteImageFileOnly`): there is no pointer to remove; the gallery lists images by **folder**, while pointers are scattered across
  each chat's extra, with no reverse index between them, and reverse-looking-up by scanning everything is infeasible (the measured data under the sidecar entry).
  So it **only deletes the file + sidecar and never touches any chat history**, inevitably leaving broken pointers, handled by runtime degradation on the card side (see below).

**Broken-pointer degradation (floor/missingImages.ts + Card.vue)**: a module-level `reactive(Set)` records "paths confirmed missing".
- **Must live outside the component**: card lifetimes are decided by hydration (any sibling slot finishing an image rebuilds the whole floor),
  so if the mark were in a component ref, broken images would come back after a rebuild. Same as `genState.ts` / `collapseState.ts`.
- **Must confirm before recording**: an `<img>` `error` can't tell "file gone" from "network down/500",
  so `confirmImageMissing` adds one HEAD (`probeUserImage` in `st/images.ts`),
  recording only on an explicit server 404; when unclear (returns `null`) it never records, and the broken-image placeholder stays to retry naturally on the next remount.
  Recording a dropped connection as a deletion would fill the screen with "File deleted" whenever the network blips, not recovering until a refresh.
- **Not written back to extra**: that would need `saveChat()`, and "file gone" is an objective disk state, not chat data,
  and the user may well restore the file. Remembering it within the session is enough.
- Cards always use `liveHistory`/`liveStale` (filtering out confirmed-missing ones) to compute phase, the pager and counts:
  without filtering the pager would have pageable yet empty cells and the collapse bar count would be inflated; with everything deleted it falls back to pending, offering a "Generate image"
  entry (rather than showing broken images while ready, where even regeneration can't be clicked), plus a line saying "image file deleted".
- Path normalisation (`normalizeImagePath`) is **the single rule for both reading and writing**: extra stores the unencoded CJK path returned as-is by the
  server, the gallery builds paths `encodeURIComponent`'d segment by segment, and leading slashes may or may not be present;
  if the two forms weren't reconciled, cards would still show broken images after the gallery deleted them. The delete entry (`deleteImageFileOnly`) likewise
  normalises first before sending; ST's `/api/images/delete` and `/api/files/delete` both `path.join` `body.path`
  straight onto the root **without URL decoding**, so an encoded path would only 404.

**Image backends (backends/)**:
- `comfyui.ts`: two mutually exclusive modes fork in `generateComfyImage`, meeting at "have a submittable JSON":
  - **custom**: API-format workflow template, supporting `%prompt% %negative_prompt% %seed% %nl% %width% %height%`
    placeholders (unsupported ones error);
  - **simple** (comfyTemplates.ts): pick models/LoRAs + fill in parameters, assembled into JSON per architecture template family, **no placeholders**.
    Template families are deliberately narrowed to the checkpoint family / Flux / Anima (the Qwen chain); a new architecture = one more template entry + one assembly branch;
    positive = fixed positive + (nl first || tag), negative = fixed negative + AI dynamic negative (Flux has no real negative input, always empty).
  The request channel is chosen automatically: **direct browser connection first, falling back to ST server forwarding only on network-level failures (CORS/connection refused)**;
  once queued with a prompt_id, polling failures never resend (avoiding duplicate images).
  The input type is the narrowed `ComfyRunConn` (url + a single preset's mode/workflow/simple + landscape/portrait sizes),
  **not the whole `ComfyUISettings`**: the backend layer should only know "what this generation uses", not how many sets the user stored.
- `comfyObjectInfo.ts`: candidate lists for simple mode. A direct `GET /object_info` gets everything at once (including LoRA/CLIP);
  the ST forwarding fallback only has `/api/sd/comfy/models|samplers|schedulers|vaes` (the server picks fields out of object_info,
  **with no loras/clips endpoint**), so under the forwarding channel those two groups degrade to manual entry. Session-level cache; "Refresh" forces a refetch.
- `nai.ts`: the protocol matches the official one (direct browser connection; the url may point at a third-party compatible site, with the `/ai` prefix added automatically); the v4 family uses
  the `v4_prompt` structure + vibe encoding cache; NAI3 sends the original reference image directly; quality/negative words get per-model defaults,
  visible and overridable on the channel page (stored empty string = follow the model's official words); positive assembly order is
  **artist string → image tags → quality tags** (the artist string comes from the library, see §7);
  `.naiv4vibe` import/export interoperates with the official one.
  **NAI 4.5/V5 take the "Base + native Character Prompts" branch**: the predicate is `naiSupportsCharacterPrompts`
  (= `isNai45 || isNai5`), and `char_captions` in the `v4_prompt` structure is filled with the protocol's characters
  (one per character, with library count tags degraded `1girl→girl`, tag + **English** nl joined into one caption, and an empty caption placeholder on the negative side).
  ⚠ The boundary is at **4.5**, not V5, and not the whole v4 family: the field holding `char_captions` is literally called `v4_prompt`;
  this structure is a V4-era protocol that V5 merely inherits, while natural language was **only introduced with 4.5** (the original NAI4 only takes tags).
  It was once gated on `isNai5`, so 4.5, which clearly supports it, couldn't send a single character prompt, and character looks all blurred into Base
  (`nai.test.ts` has a regression lock). nl is always written in **English**: image models read English natural language more reliably, and Chinese costs
  several times the tokens (4.5's base + all character prompts total about 512 T5 tokens). **Character names are the only exception**:
  characters[].name / changes[].name and character names appearing in tag/nl must keep the original text verbatim (Chinese names stay
  Chinese, neither transliterated nor translated); the plugin matches library entries by name verbatim for replacement, and if names don't match, profile/text anchoring breaks.
  **The "Generate Natural Language" toggle (`settings.nai.naturalLanguage`, default on = pre-upgrade behaviour)**: added for exactly this 512-token
  budget; on 4.5, nl competes with tags for the same budget, the excess is cut off, and the image starts to drift; 4.5 also reads natural language less well than V5.
  Same rule as ComfyUI's toggle of the same name (§5 `autoTagProfile`): when off, the protocol/specification/thought chain switch to the pure tag versions
  (`{{^nl}}` conditional sections), and the runner discards nl the model wrote anyway and skips the "profile creation must carry nl" check; **nl already written into tags is sent as usual**,
  and multi-character Character Prompts are still split as usual (each caption just holds tags only). The toggle is under the model choice in NaiPanel's "Default parameters",
  not hidden by model: only 4.5/V5 can be chosen (see below), so the toggle always applies.
  **There are only three real V5-only differences**: `params_version: 4`, a restricted sampler subset (the list is filtered by model, with the panel in sync),
  and varietyBoost having no effect (`skipCfgAboveSigma` returns null for V5; 4.5 uses magic 58).
  **Vibes work on V5 too**: `vibeModelKey` already includes the v5full/v5curated keys, and V5 takes the same encoding
  cache branch as the v4 family (`reference_image_multiple_cached` initialised unconditionally); only **non-NAI-family models** don't support them.
  With 4.5/V5 and nl, the positive string is joined as `tags. nl` (period-separated).
  **Only four models can be chosen, 4.5 and V5** (`NAI_MODELS`, also `normalizeNai`'s allowlist): below 4.5
  are retired, and old models in existing configs are **rewritten** to `naiDefaults().model` (5-full) with a
  `console.warn`; style, Anlas cost and the vibe encoding key all change with it, a deliberately accepted cost
  (`settings.naiModelRetire.test.ts` locks "listed ones untouched, retired ones must leave a trace").
  ⚠ The `NaiModel` type is wider than `NAI_MODELS`, and the protocol branches for `isNai3` / the original NAI4 are still there: kept so as
  not to touch the regression locks, and to leave room to roll back. **They are unreachable from the UI**, so don't infer product behaviour from "this branch is still alive".
- `chatu8Vibe.ts`: reads only Chiehime's extension_settings + IndexedDB, importing vibes one by one (content fingerprint dedup, read timeout, migration progress).
  There is also the prompt preset trio (collectChatu8ArtistRefs / detectChatu8Artists / importArtistsFromChatu8):
  it reads the `yushe` table + the current selection `yusheid_novelai`, and migrates each preset's three fields **by position**:
  leading fixed positive (fixedPrompt) → artist string (front of the positive), trailing fixed positive (fixedPrompt_end) → positive quality tags
  (end of the positive), fixed negative (negativePrompt) → negative prompt, and when the negative is non-empty **the current model's official baseline** is baked in
  front (Chiehime's rule = official UCP + user negative; when empty it stays empty and goes through the fallback chain, the baseline following the model). **Same name means the same recipe**:
  different content → overwrite and update (entries where the old migration stuffed the whole positive into the artist string are fixed by re-importing), identical → skip;
  whether the active preset mapped to its target id gets selected is up to the caller. The result carries plans per entry (state: import/overwrite/skip
  + target id + value to save), a pure function that saves nothing; the UI is in NaiPanel's "Migrate from Chiehime" fold: the entry is permanent,
  and opening the dialog computes one preview (badges: will import/will overwrite/already exists), then confirming does push/overwrite + an optional switch.
- `vibeStore.ts`: vibe original images/encoded bodies and thumbnails are stored in separate files in ST's `user/files`, falling back to local IndexedDB when file storage is unavailable.
  `extensionSettings['baibai_image']` only keeps small indexes like paths, model keys and fingerprints; Base64 must never be put there again.

## 7. State and persistence

- **settings (global, across devices)**: `state/settings.ts`. At import time a reactive is built from defaults;
  once ST is ready, `hydrateSettings()` loads from `extension_settings['baibai_image']`
  (**normalize tolerates faults field by field + migrates existing data**, e.g. resolution → two landscape/portrait cells, the webui hiding migration);
  the `ready` guard flag stops defaults from overwriting server settings; deep watch → debounced `saveSettingsDebounced()`.
  Subscribers use `onSettingsReady(cb)` to wait for hydrate to finish (e.g. ui.ts loading the theme).
- **ComfyUI workflow library**: `settings.comfyui.workflows` (`ComfyWorkflowPreset[]`) + `activeWorkflowId`.
  - One preset = name + `mode` (custom/simple, mutually exclusive) + workflow JSON + `simple` parameters + `naturalLanguage` + landscape/portrait sizes
    + `orientationLock` (frame lock, see §6; old presets missing the field fall to `'auto'`).
    These go with the workflow rather than staying at the channel level because they are **properties of the base model** (Illustrious wants short tags + 832×1216,
    Flux wants natural language + a 1024 square); at the channel level, every workflow switch would need two manual edits.
    `url`, conversely, stays at the channel level (one server runs every workflow).
    Both modes' fields are always kept (switching modes doesn't lose the other side's config); only one side applies at generation time;
    existing presets have no mode/simple fields, and normalize fills in `custom` + simple-mode defaults.
  - **Invariant: `workflows` is never empty**. `comfyDefaults()` is born with one empty preset (people using only one set never notice the "library"),
    and `normalizeComfyUI()` provides a final fallback; a dangling `activeWorkflowId` falls back to the first.
    Consumers always go through `activeComfyPreset()` / `effectiveComfyConn()` and never touch the array directly, so no null checks are needed everywhere.
  - **Migration of existing data**: old configs' flat `workflow` / `naturalLanguage` plus channel-level landscape/portrait sizes are folded as-is by `foldLegacyWorkflow()`
    into the first "Default workflow" (same rule as `foldLegacyNegative` / `migrateSize`: values the user deliberately set are never displaced by defaults);
    the entry is created even when `workflow` is an empty string. It judges by the presence of fields, with no schemaVersion.
  - Workflow JSON goes into `settings.json` along with the settings (a few KB to tens of KB per set). It is deliberately **not** moved to `user/files` like vibes:
    the sizes differ by two orders of magnitude. If saving settings gets slow later, this is the first suspect.
- **NAI endpoint library**: `settings.nai.endpoints` (`NaiEndpoint[]`) + `activeEndpointId`.
  One endpoint = name + API address + that site's API key, **just these three**. It started with "switching between community sites":
  the same set of image parameters must be switched between several exits, so model/sampler/size/vibes/artist string/concurrency all stay at the channel level;
  switching sites shouldn't force reconfiguring the parameters. The key goes with each entry rather than one shared at the channel level, because each site has its own key.
  - **Invariant: `endpoints` is never empty and always contains the built-in official entry** (`OFFICIAL_NAI_ENDPOINT_ID = 'nep_official'`,
    url always `NAI_OFFICIAL_URL`). A dangling `activeEndpointId` falls back to `[0]`. These three are **on the workflow library's side,
    opposite to the artist string library**: the address is essential (without one no image can be generated), and falling back only changes the exit, with errors reported immediately as a connection failure,
    unlike an artist string fallback silently changing how every image looks.
  - **The official entry is read-only**: the UI blocks renaming/changing the address/deleting, and `normalizeNaiEndpoint` always rebuilds `nep_official` with the built-in values
    (hand-editing settings.json can't override it); only the key is kept, since what's built in is the address and name, not anyone's key.
    To use an official mirror, click "Duplicate" to get a normal entry, which can be changed freely.
  - **Migration of existing data** (`migrateNaiEndpoints`, judged by the presence of fields, no schemaVersion): old configs' flat
    `url`/`key` become the first entry. If url is empty or is the official address (the vast majority) → the key folds straight into the official entry, with no duplicate row;
    if it is a third-party site → create a "My endpoint" entry placed **first** and kept selected, with the official entry **appended after** (putting the official one first would push
    the exit the user is using to the second row, looking as if it had been replaced). The old fields `nai.url`/`nai.key` are **kept as-is only for rollback**,
    and the generation path never reads them. `settings.naiEndpointMigration.test.ts` locks all of the above.
  - Consumers always go through `activeNaiEndpoint()` / `effectiveNai()` (= all channel-level parameters + the current endpoint's url/key),
    never touching the array directly. The three entries of `backends/nai.ts` (`testNaiConnection` / `generateNaiImage` /
    `encodeVibeImage`) keep their signatures and take exactly this narrowed result; same reason as `effectiveComfyConn()`.
    ⚠ Missing one place has a subtle symptom: that place would use the stored `nai.url`/`nai.key`, still working for old users,
    and only people who switch to a second endpoint would find some feature still sending to the old address.
  - ⚠ `backendStatus().reason` **deliberately leaves out the endpoint name**: it is passed to third parties as-is via `getBackendStatus()`,
    and the name is typed by the user; some use the site's domain as the name, so including it would leak the address into a public return value
    (exactly what the allowlist in `public/api.ts` guards against). The panel's own toast titles aren't bound by this; that is local UI.
- **NAI artist string library**: `settings.nai.artistPresets` (`NaiArtistPreset[]`) + `activeArtistId`.
  One recipe = name + artist string (prompt, joined at the **very front** of the positive prompt) + optionally bound positive quality tags (quality)
  + an optionally bound negative prompt (negative); a blank bound value = follow the channel level → the model's official words (a three-level fallback, see
  `naiQualityTags` / `naiUndesiredContent` in `backends/nai.ts`). Assembly order: artist string → image tags →
  quality tags (the artist string goes first because it sets the tone of the whole image, and NAI weights earlier tags more heavily; switching the artist string
  applies all three fields together, so one recipe is one complete style combination).
  - **Not split per model** (unlike quality/negative words): the official quality tags are **a property of the model** and must change with it;
    the artist string is **the user's own recipe**, and reusing it across models is the norm, so it is an add/remove library rather than a `Record<model, …>`.
  - **Three places deliberately opposite to the workflow library**: ① `artistPresets` **may be empty** (workflows never are);
    ② `naiDefaults()` **seeds no entry** (workflows are born with one); ③ a dangling `activeArtistId` is
    **cleared to an empty string** by `normalizeNai` rather than falling back to `[0]`. The root cause is the difference between essential and optional: without a workflow
    no image can be generated, without an artist string only the style isn't added; falling back to `[0]` would, after the user deletes the current entry, **silently apply a style
    they never chose**, and the dropdown would show exactly that entry (looking like their own choice), nearly impossible to trace.
    Unit tests lock this contrast (`settings.naiArtistMigration.test.ts`).
  - An empty string is the "None" sentinel. Preset ids always have the `art_*` shape (normalize guarantees non-empty), so an empty string can't
    collide with any id, and needs no boxing like `vibeGroups`'s `g:` (there group names are user input and can collide).
    Clearing to an empty string also makes `activeArtistId ∈ {'', ids in the library}` an invariant, so the panel needn't check for dangling ids.
  - Consumers have two paths: the panel uses `activeNaiArtist()` (reads global settings, returns `NaiArtistPreset | null`,
    deliberately read-only, being called inside computed); assembly uses `naiArtistPrompt(nai)` in `backends/nai.ts`
    (a pure function taking NaiSettings, unit-testable). **Deliberately not shared**: settings.ts already imports nai.ts's
    `naiDefaultUndesired`, and a reverse value dependency would create a runtime cycle.
  - ⚠ `fullPositivePrompt` is **called once each** in `buildNaiParameters` (the source of v4_prompt) and at `generateNaiImage`'s
    top-level `input`, and the two must share one source. Keep every assembly change inside the function: adding extras at one call site
    would give NAI3 (reads input) and NAI4/4.5 (read v4_prompt) different prompts, exposed only on NAI3
    (existing tests all use 4.5 models, so not one would go red). A same-source assertion locks this.
  - **Built-in read-only library**: `BUILTIN_NAI_ARTISTS` (backends/nai.ts, ids always with the `bi_*` prefix, never colliding with user
    `art_*`) updates with the plugin version and is **not in settings** (otherwise the defaults would freeze in users' settings and not follow upgrades).
    New installs have the first one selected by default (see naiDefaults); old users' activeArtistId is stored in settings and unaffected.
    Read-only: the panel/manager allow no renaming or deleting; customising only works by "Duplicate" into a user entry and editing that; this is the only
    customisation path for built-ins. To retire a built-in entry, keep it for at least one version: users who have it selected go through "dangling id → cleared to None",
    and their style changes silently, so be careful.
  - **Preview images**: `NaiArtistPreset.previewPath` is optional (old data lacks the key; empty = the manager shows a placeholder).
    On upload the manager compresses it to a jpeg with a 512 longest edge, saved to `user/images/柏宝绘_画师串/<entry id>.jpg`
    (`/api/images/*` in st/images.ts; the path is recorded on the entry, with no extra index). Changing the image overwrites the same name, so no orphans pile up;
    deleting an entry deletes the file along with it, best-effort (failure doesn't block deleting the entry); **duplicating an entry doesn't take previewPath**:
    with two entries pointing at one file, deleting one would break the other's image.
  - **Manager dialog** (NaiArtistManager.vue): the panel dropdown only handles frequent switching; infrequent management (search/preview images/
    bulk deletion by ticking/per-entry edit, duplicate, delete) is in the manager. The pure logic is in naiArtistLib.ts: `matchArtist` searches by
    name + artist string content (bound positive/negative words take no part; the wider the match surface, the more false hits),
    and `planArtistRemoval` plans deletion and activeId replacement (same rule as single deletion in the panel: when the current entry is deleted, the entry at its
    original position takes over, emptied goes back to `''`, **not** falling back to [0]). Interaction: clicking the card body = enable, clicking the current one again = disable;
    checkboxes only serve bulk deletion; built-in entries have no checkbox and are read-only. "Duplicate" is the only customisation entry for built-ins.
  - **Migration of existing data**: purely additive, no old fields to fold. Old configs get an empty library + empty id after hydrate, and positive prompt output
    is byte for byte the same as before release.
- **Large vibe files**:
  - `extensionSettings['baibai_image'].nai.vibes`: stores only the small `NaiVibe` index, never original images, thumbnail data URLs or encoded bodies;
  - `user/files/bbi-vibe-*.json`: original images and per-model encoded bodies;
  - `user/files/bbi-vibe-thumb-*`: list thumbnails;
  - IndexedDB `baibai_image_vibes`: local fallback when writing ST files fails, not synced across devices.
- **Automatic repair of old vibes**: before normalize, `hydrateSettings()` scans old entries directly and saves them one by one in order;
  each one is replaced in place right after it succeeds, freeing its Base64, without waiting for the whole library. Once all succeed, lightweight settings are saved only once.
  The first upgrade may need to wait for the move, and it is back to normal after a refresh; if both the file and IndexedDB writes fail for an entry, the original entry is kept with an error,
  successful entries never revert to large objects, and the next refresh retries.
- **Chiehime migration**: `chatu8Vibe.ts` reads in order and immediately calls `vibeStore.ts` to save, never accumulating large whole-library objects in memory or settings;
  imported items are disabled by default, so generation never reads every vibe body at once.
- **The single rule for vibe strength**: always via `clampVibeStrength` in `vibeStore.ts` (clamped to 0–1, unrecognised numbers fall back to
  the default 0.6). There were once four separate implementations, three of which wrote `Number(v)`; `Number(null)`/
  `Number('')` are both 0, so "field missing" was silently judged as "strength 0", and a vibe was attached with no effect, very hard to trace.
  It only accepts real numbers and parseable strings; the panel's number box has step="any" for free entry, and after clamping writes back to input
  (preventing the misleading display of "typed 5, clamped to 1, yet the box still shows 5").
- **Vibe groups**: `NaiVibe.group` is a flat string (empty = ungrouped), with no separate groups array; a group is just
  a label for "enable together/collapse together", with no properties of its own, and renaming/deleting a group is bulk assignment to the members' group field,
  producing no dangling references. Pure logic in `backends/vibeGroups.ts`: group names are always boxed with a `g:` prefix (preventing collisions with the
  "ungrouped/new" sentinels), `groupVibes` gathers + searches, and `isGroupActive` checks the enabled set
  (active only when it equals all members of the group, judged on full membership even while searching). Generation only looks at each entry's enabled,
  and a group's bulk actions are essentially bulk assignment to the members' enabled, introducing no second source of truth.
  During Chiehime migration, if an old name carries a "group name · original name" prefix (`planPrefixGroups`), it is restored into a group and the prefix removed.
- **Secondary API channels (shared across plugins)**: the real data is stored in `extensionSettings['baibai_api_channels']` (with a revision),
  and this plugin's settings hold only a mirror; after writing, `st-baibai-api-channels:changed` is broadcast, and other ends listen and reread.
  Shared with BaiBai Book; additions, deletions and edits on either end sync in real time.
  - **Reasoning effort** (`ApiChannel.reasoningEffort`, empty string = auto = no parameter sent, old channels unchanged): ST's
    proxy gates `reasoning_effort` for the openai source on a **model-name allowlist** (OPENAI_REASONING_EFFORT_MODELS),
    and if the model name doesn't match it silently drops it while still returning 200, so users set it without being able to tell. So when non-empty the whole request switches to
    the custom source (`buildRequestBody` in api/client.ts, a pure function with unit tests): `custom_include_body` is merged by
    the server directly into the upstream request body, bypassing the allowlist. Two pitfalls are avoided: the custom source **doesn't read proxy_password**,
    so the key is injected as Authorization via `custom_include_headers`; `custom_include_*` are YAML strings and
    parse failures are silently ignored, so they are always generated with JSON.stringify (keys containing `:` `#` and the like would break YAML). Values aren't
    allowlist-checked and pass through as-is (vendors' vocabularies differ). ⚠ Cross-plugin: BaiBai Book's normalizeChannel up to the current version
    "rebuilds the object field by field", so adding/editing/testing a channel in Book writes back to the shared storage and **wipes this field** (Image-only),
    a risk that disappears once Book adds a field of the same name.
- **Exclusion settings (shared across plugins)**: the real data is stored in `extensionSettings['baibai_exclude_settings']` (with a revision),
  mirrored in `settings.excludes` (four lists: excludedChars / excludedWorldNames /
  excludedWorldInfoPatterns / customStripTags); the protocol has the same structure as channels (fingerprint to prevent loops + revision takes max),
  with the event `st-baibai-exclude-settings:changed`. It shares the same lists and the same matching rule with BaiBai Book:
  excluded characters → the whole auto-tag flow is disabled (floor buttons are removed at the next reconciliation too); whole-book/entry-name exclusion → secondary API lorebook filtering
  (autoTag/excludes.ts); cleanup tags → whole blocks deleted during scanning/text cleanup (autoTag/clean.ts).
  When the shared storage is created, the default entry-name rule `\[mvu[\s\S]*?\]` is seeded (only once; deleted, it isn't added back).
- **ui (local + synced)**: window open/closed and the current page (activePage stored in localStorage) are purely local state;
  theme/navigation/floating orb/collapse floor images by default (autoCollapseImages)/floor image display size (imageDisplaySize, §6)
  are real settings, written into `settings.ui` and synced across devices.
  Gallery groups are collapsed by default, and only the names of manually expanded folders are stored locally in `bbi.ui.galleryExpanded.v1`;
  the old `galleryCollapsed.v1` isn't used to infer the expanded state, and unrecorded new folders are collapsed by default. `v-if` + Transition
  mount images only when expanded and unmount them after the collapse animation, keeping native `loading="lazy"`.
  Each group shows 24 images at first, then appends at most 24 each time; the appended count is kept only within this page visit and resets on refresh,
  while collapsing and re-expanding within the same page keeps the progress. Folder/file names are still read in full, unaffected for character search and total counts.
  **Multi-select deletion**: a separate "Select" toggle (no long-press entry: browsing is the main use, and click image = enlarge must be the default),
  and a group header's checkbox selects **the whole group**, not the batch currently rendered (lazy loading is only a rendering strategy). Deletion is fault-tolerant per image
  (one failure doesn't stop the rest; failures stay in the list still ticked), and afterwards `markImagesMissing` makes open
  floor cards degrade immediately, removing items from the list **in place** rather than calling `load()` again (which would reset the expanded state and loaded batches).
  **Group size (⚠ disabled for now)**: the original approach read `Content-Length` with one HEAD per image; `/api/images/list`
  only returns file names (the server's `util.js getImages` only maps out `dirent.name`), with neither size nor mtime,
  so it could only ask one by one (static route `res.sendFile`, measured at 1~2ms with no body, far cheaper than the gallery loading original images directly as thumbnails).
  **The author is unhappy with this approach (request count grows linearly with gallery size), so the `measureSizes` call in `load()` in `index.vue`
  is commented out**; the computations/template/CSS/tests are kept as-is, and restoring is just uncommenting; `probeUserImage`
  is still used by `missingImages.ts` for 404 confirmation. Original design: limited background concurrency (`mapLimit` in `src/pool.ts`,
  6 lanes; ST is single-process, and pushing too hard would stall the user's own chat) without blocking the first screen; unmeasurable images are **not counted** rather than added
  as 0, and incomplete totals carry "≥"; the return has three states (`exists:true` / `exists:false` / `null` = unclear),
  so `null` keeps network blips from being taken as deletions.
- **charTags (three layers of truth: global library + this chat's manual baseline + AI floor deltas)**:
  - **Global library**: stored in `extensionSettings['baibai_image_char_global']` (globalCharTags.ts,
    same protocol as shared channels: revision + fingerprint + broadcast events), across chats/devices. It is positioned as **frozen templates**:
    written only by the user's manual add/delete/edit or "Promote to global", with no history; AI changes for locked names
    (characters unique to global with no same-name entry in this chat) are always discarded, blocked on both sides: replay (applyCharTagOps) and
    @replacement (applyPositionedCharRefs), and the runner filters once more before writing floor deltas;
    locked entries carry a [locked] marker in the library text, and the prompt declares them immutable. A same-name entry made by hand in this chat
    overrides global and unlocks it (the "Copy to this chat" button takes exactly this path); "Promote to global" snapshots the current effective value
    into global, then deletes this chat's copy and clears same-name floor ops, letting global take over.
  - **This chat's manual baseline**: stored in `chatMetadata['baibai_image_char_tags']`; manual edits/rollbacks/old-version snapshots land here,
    and it doesn't go away when floors are deleted.
  - **AI floor deltas**: automatic profile creation and changes are written into the target message's `extra['bbiCharChanges']`
    (CharTagFloorDelta: v/swipe/ops; ops come in two kinds, new/set), saved only when the same CAS write-back as the text succeeds,
    and naturally voided when floors/swipes are deleted (deltas carry a swipe match).
  - `charTagLib` is only a reactive derived cache: the merged seed (this chat first, global filling same-name gaps,
    mergeCharTagSeed) + deltas replayed in physical floor order (deriveCharTags, with locked-name filtering);
    `charTagsBeforeFloor(floor)` takes a snapshot at a floor's moment; it recomputes after MESSAGE_DELETED/MESSAGE_SWIPED.
  - Manual edit/delete = the user takes over: detachFromExistingFloors clears that character's same-name operations on old floors
    (pressed into the manual baseline), after which new floors can still be changed by the AI.
  - Profile creation and later maintenance both belong to the main request (changes with field="new"/field updates), part of the same inference as scene selection;
    appearance is recorded by field (fandom/sex/hair/eyes/skin/body/extra/outfit), and the join order is the final tag,
    with fandom (the fan-work identity tag, character name (copyright name)) joined first; old whole strings are supported as raw.
    Profile creation must carry hair and eyes (the identity anchors of anime characters); missing either, the entry is discarded.
    The fan-work identity tag must be written into the profile: for characters judged to be from a fan work, profile creation with field:"new" writes fields.fandom;
    already profiled characters missing fandom get a changes entry with field:"fandom" to fill it; when drawing, it is copied from the profile into first place.
    Original characters don't write fandom. The ComfyUI side doesn't copy fandom (its bracket-escaping rule differs; the identity tag is still judged
    and escaped on the spot per the comfy specification).
    BaiBai Book's CJK appearance goes to the main request with the character reference block as evidence; the character management page also has a "Generate from BaiBai Book's latest
    appearance" button (generateCharTags), a one-off conversion the user clicks, not part of the automatic flow.
  - AI references are **copied directly** (since v0.1.2): the prompt asks for library field values to be written into tag/nl unchanged (if the library says
    long black hair, write long black hair), without @character name placeholders. Why it was withdrawn: when the same character was referenced
    several times it expanded each time, so one image had several full appearances + several 1boy, and the model drew overlapping torsos from that; and
    the "40 tags or fewer" budget couldn't be enforced (the AI counts @小雪 as 1, but it expands to 6); dirty library data would also be
    amplified unconditionally. The library text is already in the same context, and copying visible text is more reliable than restating from memory.
    The applyCharRefs family is kept as a fallback: when the model occasionally writes @name it is still replaced, so the literal never
    reaches image generation. Each character's fixed appearance is written only once per image; later mentions use a short reference.
    Name consistency is written into the prompt: on first profile creation name = the original name in the character card/lorebook/BaiBai Book/text (Chinese names written in
    Chinese); references to profiled characters (including names in nl) = the profile name, identical verbatim, with no transliteration/variants;
    every anchor and replacement in the plugin matches names exactly, and inconsistent names break the chain. **The scope is limited to characters with a profile (or being
    profiled this time)**: the whole purpose of these rules is protecting verbatim matching, and one-off characters take part in no matching, so they aren't bound by them.
    The page offers history viewing and per-entry rollback (rolling back a profile creation record = deleting the entry).
  - **Eligibility for a profile ≠ eligibility for the image (0.2.3, 4.5/V5 path only)**: the two hang on **mutually orthogonal** predicates:
    entering the library depends on "named + has a setting/takes part continuously" (rule unchanged); taking a `characters[]` slot depends on **being visible within this
    image's frame**, independent of profiles. So one-off unnamed characters can be in the image as usual, getting a Character
    Prompt **valid only for this image** (name = the text's original reference word, appearance completed once), with no profile, no changes entry, and nothing in the library.
    Why: in a real run the model read "one-off unnamed passers-by get no profile" as "the unnamed can't be in the image", and kept giving up every moment where
    the other party of the core interaction was an unnamed opponent, picking instead shot sizes that cropped him out. The root cause wasn't "the specification lacks a state",
    but that **the predicate building the list was wrong**: the thought chain's layer one B only counted "the named", so that person never made the list, and downstream
    rules couldn't see him at all. The fix unifies the predicate (count "who is present") + marks each person with one of three identities
    (【existing profile】/【profile created this time】/【one-time】); the third state follows naturally from three orthogonal definitions, not granted as an exception.
    The supporting changes must land in the same batch; miss one and that person gets sentenced to death at some step: layer one B's list and identity marks, layer two's slot blocks
    (block names may use the text's references, and **the fixed-appearance slot leaves a valid way to fill in for 【one-time】**; the old rule made "copy the library/just-created
    profile fields" the only source, leaving the unnamed no way through this slot), layer three's self-check "choose one of two → choose one of three",
    and C's clothing timeline excluding 【one-time】 (otherwise it would keep a cross-image clothing ledger for a one-off opponent, in turn inducing a profile).
    **Scene selection and description are separate**: the task protocol asks to prioritise the player protagonist's and main characters' expressions, states, actions and relationships;
    main characters aren't all profiled characters, and the player isn't required in every image. NAI's E first settles the subject and core interaction,
    then frames; when no scene content is lost, unrelated people present are preferably excluded, while necessary unnamed interaction partners or crowds are kept as usual,
    with no candidate scored up or down for having a name/profile. B's count list isn't the in-image list; slots and the self-check are written for what is visible in this image,
    and people outside the shot must not be added into Base.
    **Countability only matters for placement once in the image**: those the text treats as individuals (opponents, shopkeepers) get character blocks, those treated as a mass (crowds,
    soldiers) stay in Base, and when unsure treat them as a mass. This rule only governs people already chosen for the shot; it doesn't encourage adding passers-by or crowds.
    **Never invent names for one-off characters**: although `name` isn't sent to NAI (see characterCaption in §6), it is serialised into the text with
    `<characters>`, and cleanHistoryText keeps bbi_image → the next floor reads it back as-is;
    in the fed-back text a fake name is indistinguishable from a real profile, and the next floor would misjudge it as a formal character and create a profile.
    Fixed in the same batch was the **headcount rule**: the Base headcount = people visible within the frame (not people present in the scene), and participants of the core interaction must not
    be cropped out for lacking a profile, though unrelated people present may be excluded. The old rule only said "must match the text", so the model invented
    "it's reasonable for them to exist off-camera" side notes to convince itself. The specification example was changed too: the old example's Base wrote `2girls` yet gave only
    one Character Prompt, demonstrating exactly the bad behaviour of "the other person has no placement".
    ⚠ This is a pure prompt change; `prompt.test.ts` locks the **wording**, not the behaviour, and whether it really fixes things can only be verified by real runs.

## 8. Conventions across the whole project

- **Degrade first**: when any host capability is unavailable (BaiBai Book/EJS/checkWorldInfo/channel) → return null/an empty string, never blocking the main flow;
- **idempotent**: every bind*/inject*/ensure* can be called repeatedly; hydration/button injection rely on internal flags or DOM checks;
- **CAS write-back**: changing text (messageEdit) and changing extra (storage) both compare against a baseline before saving, giving up on failure;
  the text baseline holds only **identity** (chat/message/swipe), and content differences are relocated by autoTag/rebase.ts rather than given up on,
  the key to coexisting with other plugins that edit text;
- **abort all the way through**: the AbortController is passed from the runner down to fetch/polling (comfyui's abortableDelay);
- **pure functions are testable**: parsing/protocol/parameter building are all pure functions, with `*.test.ts` (vitest, in the same directory as the file under test).
  Run `pnpm test` as a safeguard when changing the protocol/backend parameters;
- **one of two channels**: if `getTagGenChannel()` has an assignment → secondary API (server proxy); otherwise follow the main API (generateRaw).
- **Random segments always use `randomUuid()`** (src/randomUuid.ts): ST often runs in a non-secure context (http),
  where `crypto.randomUUID` throws outright; random segments for vibe cache keys/file names are only for collision avoidance and need no cryptographic strength.
- **Text to base64 always uses `utf8ToBase64()`** (src/base64.ts): `btoa`'s input is a latin1 binary string,
  and code points > 255 throw InvalidCharacterError outright; prompts and character names are often CJK, so calling btoa directly would blow up on the spot.
  It must first encode to bytes with `TextEncoder`, then convert byte by byte (with chunked concatenation to prevent stack overflow).

## 9. Public interface: open to third-party plugins (public/)

`globalThis.STBaiBaiImage` (since 0.2.5, `apiVersion: 1`). The external document is **`PUBLIC_API.md`** in the repo root;
it is written for third-party authors, and **any interface change must update it in the same batch**, otherwise code third parties write from the old document will silently break.
Its shape copies the neighbouring BaiBai Book (`globalThis.STBaiBaiBook`, of which this plugin is itself a consumer), so third parties only need to learn one set of conventions.

It offers three things: `getCharacters()` reads the character library, `getBackendStatus()` asks whether the backend is ready, `generate()` generates an image,
plus `subscribe()` and two window events, `st-baibai-image:ready` / `:changed`.
**Generated images go into no chat history**: they take no floor and write no extra; third parties decide where they show
(that is the motivation: BaiBai Image draws its own images in the floor text, and some plugins want to draw them in a sidebar/their own dialog).

Layers: `types.ts` holds only contract DTOs, `api.ts` is the implementation layer (all the dirty cross-boundary work is here), `register.ts` handles mounting and events.

**Five disciplines, each matching a kind of problem that really bites**:
- **Deep-copy everything that goes out** (`clonePublic`). `charTagLib.entries` is a Vue reactive array,
  and handing it out as-is = handing over write access to the character library too: at best silently wiped by the next `recomputeCharTags()`
  (users see "what I changed is gone again"), at worst a reactive proxy entering the other side's reactivity system, each triggering the other.
  `capabilities` is a getter returning a new copy every time; notifications also give **each subscriber its own copy**
  (otherwise the first subscriber breaking detail would ruin it for everyone after; locked by unit tests).
- **Backend status goes out by allowlist**, not "hand out the whole status, then delete sensitive fields"; the latter would silently leak
  when fields are added to the internal structure later. `settings.nai.key` and every backend url **never appear in any public return value**
  (`api.test.ts` dumps the JSON directly and asserts it contains no key/domain/port). `history` is deliberately withheld likewise:
  once handed out it can't be removed (removing a field requires bumping apiVersion).
- **Errors are normalised into plain Errors with a `code`** (`toPublicError`). instanceof for `NaiError`/`ComfyUIError`/`DOMException`
  always fails across bundles (two copies of the constructors), so third parties could only match message text. So they are uniformly tagged
  `aborted / not_configured / invalid_args / rate_limited / backend_error`.
  Cancellation is judged by `name === 'AbortError'` rather than instanceof: an abort is most often triggered by the third party's **own**
  AbortController, and that DOMException comes from its realm.
  `rate_limited` and `backend_error` are separate because the handling differs (the former should wait; the latter fails the same way on retry).
- **Images are always converted to data URLs**. ComfyUI's direct connection returns blob: URLs that need a matching `revokeObjectURL`: if a third party forgets, it leaks;
  if we revoke for it, its `<img>` goes blank. The original blob is revoked in `finally`.
- **No degrading, no guessing**: ComfyUI doesn't support `characters` (the whole chain never reads the field), so it reports `charactersApplied: false`
  and does **not** join the characters into the prompt; that was exactly the overlapping-torso problem fixed in 0.2.3. A third party's `onProgress`
  throwing is only logged to the console and never breaks generation.

**`apiVersion` is separate from `pluginVersion`**: the former is the version of the public data structures (fixed at 1); the latter rises constantly.
Structures are **only added to, never changed or removed**: adding optional fields is safe; changing meaning or removing fields always bumps apiVersion.

**Saving (`save`, default `true`)**: external images go into the gallery as usual, via `saveExternalImage` in `storage.ts`
→ `user/images/柏宝绘_<character name>/` + a same-name sidecar json (the same folder and file name rules as floor images,
which the gallery uses to group and read prompts). The sidecar stores the **raw tag text** (`serializeImageTag`, including the `<bbi_image>` wrapper)
rather than display text, otherwise the gallery would parse out one clump of bare tags. **A failed save only warns, never throws**: the image is already in
`dataUrl`, and denying the third party the image because it couldn't go into the gallery would put the cart before the horse (`path` returns null so it can tell).
⚠ The file name must pass `sidecarPathFor`'s regex, otherwise the gallery never requests the sidecar; the symptom is **the image is there, the prompt is blank,
and there is no error at all** (`storage.test.ts` feeds the real upload file name back into `sidecarPathFor` to lock this).
The size in the sidecar records **the orientation actually generated** (`GenerateOutput.size`): when the user locks the frame (§6) it differs from the requested size,
and the gallery's tag must describe this image truthfully. The return structure is unchanged (no fields added; apiVersion stays 1).

**Change notifications**: `register.ts` only does `watch(() => charTagLib.entries, …, {deep:true})`; the character library is
**a reactive derived result**, so always watch it directly, never subscribing one by one to the events that **cause** it to change (chat switch/floor deletion/swipe/
manual profile edits/AI profile creation); missing one subscription means a whole class of silent non-notifications. Changes in the same batch are coalesced into one with `queueMicrotask`
(otherwise one recomputation could fire a dozen identical notifications, each of which might make a third party do a full refresh).

**Registration timing**: must come after `hydrateSettings()` (see §3). `registerPublicInterface()` is idempotent,
and the API object is `Object.freeze`d, so one plugin can't change what the next plugin gets.

## 10. Task lookup index (check here first when changing requirements)

| What to change | Which file |
|---|---|
| Startup flow / mounting a new subsystem | src/index.ts |
| Opening/changing the third-party interface | src/public/ (types contract + api implementation + register mounting) + **PUBLIC_API.md must change in the same batch**; structures are only added to, never changed or removed; changing meaning requires bumping apiVersion |
| Middle of the image path (gate / backend dispatch / readiness criterion) | src/generate.ts (shared by cards and the public API; **bypassing it bypasses the NAI gate**) |
| Settings (new fields/defaults/migration) | src/state/settings.ts (three places: types + defaults + normalize) |
| Settings window UI | src/pages/settings/index.vue |
| Built-in prompt defaults (Core Prompt/specification/thought chain) | `DEFAULT_*` constants in src/state/settings.ts (the NAI pair is `DEFAULT_NAI_V5_*`) |
| Auto-tag trigger conditions / dedup / retries | src/autoTag/runner.ts + generationGate.ts (generation gate pairing) |
| Assembling messages sent to the LLM (order/content) | src/autoTag/prompt.ts (NAI always uses DEFAULT_NAI_V5_SPEC: Base + Character dual prompts) |
| LLM output protocol (JSON shape/position IDs/tag format) | src/autoTag/protocol.ts |
| Lorebook/character card/persona assembly | src/autoTag/context.ts |
| Reading BaiBai Book state | src/autoTag/bookMemory.ts |
| Character library v3 (baseline + floor deltas/changes ops/@placeholder fallback/history rollback) | src/autoTag/charAnchors.ts + src/state/charTags.ts + src/autoTag/runner.ts |
| Vibe groups / search / enabled-set checks | src/backends/vibeGroups.ts (pure logic) + NaiPanel.vue (interaction) |
| Secondary API requests (proxy/SSE/timeout/test) | src/api/client.ts |
| Reasoning effort (channel dialog + custom source request body) | `ApiChannel.reasoningEffort` in src/state/settings.ts + `buildRequestBody` in api/client.ts (UI in settings/index.vue) |
| Following the main API | requestViaMainApi in src/api/client.ts |
| ComfyUI workflow / generation / channel fallback | src/backends/comfyui.ts |
| ComfyUI simple mode (template assembly/validation) | src/backends/comfyTemplates.ts (UI in ComfyUIPanel.vue) |
| Fetching ComfyUI model/LoRA lists | src/backends/comfyObjectInfo.ts |
| ComfyUI workflow library (saving/switching several sets) | `ComfyWorkflowPreset` + `activeComfyPreset` / `effectiveComfyConn` in src/state/settings.ts (UI in ComfyUIPanel.vue) |
| AI workflow auto-configuration (node location) | src/backends/comfyWorkflowAssistant.ts (+ panel button in ComfyUIPanel.vue) |
| NAI parameters / vibes / .naiv4vibe / Chiehime prompt preset import | src/backends/nai.ts + vibeStore.ts + chatu8Vibe.ts (UI provided by NaiPanel) |
| NAI endpoint library (switching multi-site address + key) | `NaiEndpoint` + `activeNaiEndpoint` / `effectiveNai` in src/state/settings.ts (built-in official entry `nep_official` is read-only; UI in NaiPanel.vue's "Configuration" area) |
| NAI artist string library (saving/switching several sets/joined at the front) | `NaiArtistPreset` + `activeNaiArtist` in src/state/settings.ts (assembled in `naiArtistPrompt` / `fullPositivePrompt` in backends/nai.ts; UI in NaiPanel.vue) |
| Artist string library manager (search/preview images/bulk deletion) | src/pages/backend/panels/NaiArtistManager.vue (pure logic in backends/naiArtistLib.ts; built-in read-only library is `BUILTIN_NAI_ARTISTS` in backends/nai.ts) |
| Artist string preview images (user/images upload/delete) | src/st/images.ts + imageFile.ts (folder constant `ARTIST_PREVIEW_FOLDER`) |
| Gallery page (images grouped by character name) | src/pages/gallery/index.vue (folder/file listing in `listUserImageFolders` / `listUserImages` in st/images.ts) |
| Gallery multi-select deletion / group size (size **disabled for now**, code kept for restoring) | src/pages/gallery/index.vue + `deleteImageFileOnly` in src/floor/storage.ts (only deletes files, never touches chat history) + `probeUserImage` in st/images.ts (HEAD with three-state return; now used for 404 confirmation, originally also for measuring size) + src/pool.ts / src/bytes.ts |
| Cards not showing broken images after images are deleted | src/floor/missingImages.ts (module-level reactive register, recorded only after HEAD confirms 404) + `liveHistory` / `liveStale` / `@error` in Card.vue |
| Viewing prompts by clicking images in the gallery | `sidecarFileName` / `sidecarPathFor` in src/floor/storage.ts (sidecar written when saving images) + gallery/index.vue (the current chat reads extra, others fetch sidecars; display rule `formatPromptText`) |
| Frame orientation / size parsing | src/backends/size.ts (deliberately independent of settings) |
| Frame lock (fixed landscape/portrait, next to each channel's sizes) | `activeOrientationLock` in src/state/settings.ts (NAI `nai.orientationLock` / ComfyUI `orientationLock` per preset) + `effectiveOrientation` in size.ts; applied at generation in generate.ts, protocol wording in `sizeRule` in prompt.ts (UI in NaiPanel / ComfyUIPanel) |
| "Generate Natural Language" toggle (per ComfyUI preset / NAI channel level) | `autoTagProfile` in src/autoTag/prompt.ts (shared by protocol and runner) + `expandNlSections` (`{{#nl}}`/`{{^nl}}` conditional sections); NAI field `settings.nai.naturalLanguage` |
| Floor image display size (how large it shows in the chat, not the generation resolution) | `IMAGE_DISPLAY_SIZES` / `imageDisplayMaxHeight` in src/state/settings.ts + Card.vue (`data-capped`) + the "display size cap" section of card.css (UI in settings/index.vue) |
| Floor card display / hydration / state machine | src/floor/hydrate.ts + Card.vue |
| Editing image prompts by hand (card ⋯ pencil) | src/floor/PromptEditor.vue + promptEditor.ts (serialisation in st/imageTagRegex.ts) |
| "AI rewrite prompt" (rewrites only one slot's prompt, still depicting the original moment) | `requestSlotTag` in src/autoTag/runner.ts + src/autoTag/slotPlan.ts; entry in the edit dialog (PromptEditor.vue + promptEditor.ts); runtime state and "closing doesn't interrupt/reopening rejoins" in src/floor/tagPlanState.ts |
| Handshake / check for auto-generating images after writing tags | `shouldAutoGenerate` in src/floor/autoGenerate.ts (pure function; Card has no unit tests) |
| Card collapse (default collapse / manual collapse state) | src/floor/collapseState.ts + Card.vue (default = settings.ui.autoCollapseImages) |
| Card "Generating" state / cancel / concurrency | src/floor/genState.ts (runtime state) + genQueue.ts (NAI gate and pacing waits) |
| NAI 429 / retries / backoff / global cooldown | src/backends/naiRateLimit.ts (the single rule for policy and pacing state; genQueue waits after taking a slot, nai.ts wraps the request) |
| Image zoom / long-press saving / save and delete buttons | src/floor/Lightbox.vue + lightbox.ts (save as goes through download.ts) |
| Card layout / button size baseline / card theme | src/floor/card.css + cardStyles.ts (tokens from styles/theme.css) |
| Result storage / file naming / CAS | src/floor/storage.ts + src/st/images.ts (external images are saved via `saveExternalImage` in the same file, sharing folder/file name/sidecar rules with floor images) |
| Regexes for the display/prompt sides | src/st/imageTagRegex.ts (the full prompt display rule `formatPromptText`, shared by cards and the gallery) |
| Floor buttons / top bar button / wand entry | src/floor/actionButton.ts / src/topbar.ts / src/menu.ts |
| Text write-back (including races) | src/st/messageEdit.ts |
| Request history (LLM/image generation, in memory, not persisted) | src/state/history.ts (store) + src/pages/history/index.vue (page) + instrumentation in src/api/client.ts |
| Copy to clipboard | copyText in src/st/clipboard.ts |
| Main window UI (mask/navigation/animation/drawer) | src/App.vue + state/ui.ts + components/ |
| Themes | src/styles/theme.css + THEMES in state/ui.ts |
| Icons | src/components/Icon.vue (new icons + PATHS) |
| Adding a page | src/pages/<id>/index.vue + registration in pages/registry.ts + an icon in Icon.vue |
| Version number | package.json (build syncs it to manifest.json automatically; the update comparison source = the version in the remote GitHub manifest.json) |
| Update check / automatic update | src/update.ts (red dot/button in NavBar.vue + settings/index.vue; only `isNewer` has unit tests) |

## 11. Tests and build

```bash
pnpm test        # vitest unit tests (*.test.ts next to the source)
pnpm typecheck   # vue-tsc
pnpm build       # outputs dist/ (syncs the manifest version automatically before build)
```

Unit tests mainly cover: autoTag protocol parsing/prompt assembly (snapshots), backends parameter building and workflow rendering,
floor storage structure/auto-generate marks/runtime state and the gate (genState/genQueue token claiming, pruning, concurrency),
size normalisation, and the public interface (`public/*.test.ts` + `generate.test.ts`: deep copies don't leak,
key/url never appear in return values, error code normalisation, the gate returns the slot even on throw). The UI layer (Vue components) has no tests.

**vitest runs in a node environment, and the repo has no jsdom installed**: no `window`, no `document`. To test things that "only exist in the browser"
you must build stand-ins yourself, e.g. `register.test.ts` uses `vi.stubGlobal('window', new EventTarget())`
(and it must be set up **before importing the module under test**, otherwise the module still gets the non-existent window);
DOM criteria like slotHealth rely on duck-typed fake nodes. This is also why logic in components like Card.vue gets extracted into pure functions
(`shouldAutoGenerate`, `slotHealth`); left inside the component, it couldn't be locked down.

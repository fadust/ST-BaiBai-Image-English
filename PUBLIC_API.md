# BaiBai Image public interface (API v1)

This article is intended for SillyTavern plug-in, script and preset authors. BaiBai Image opens two things to external calls:

1. **Read the character library** - Get the characters recorded by Bai Baohui and the tag that can be directly drawn.
2. **Tiaosheng Diagram** - Ask Bobo to draw a picture, **it is up to you to decide where the picture is displayed**

There is only one JavaScript global object at the entrance: `globalThis.STBaiBaiImage`.

## What does this interface solve?

Bai Bao painted his own picture in the **floor text** (the card below the message). Some plug-ins don't want this kind of presentation - they want to draw it on the sidebar, draw it in their own pop-up window, and use it directly as a vertical drawing after drawing. This is what this interface provides: BaiBai Image is responsible for drawing (backend configuration, concurrency gate, current limit backoff, disk placement and archiving are all reused), and you are responsible for displaying.

**The generated picture will not enter any chat history. ** It does not appear in the floor text, does not occupy the floor card, and does not write `message.extra`. By default, it will only be saved to the Bobo drawing library (see `save`).

## Compatibility convention

- `apiVersion` is currently fixed to `1`. It is a version of **public data structure**, separate from the `pluginVersion` of the plugin itself - the latter increases every day, while the former does not. Please press `apiVersion` to determine compatibility, and do not parse the semantics of `pluginVersion`.
- The structure is only added but not modified or deleted: it is safe to add optional fields; changing the meaning of fields or deleting fields will always increase `apiVersion`.
- All return values are deep copies of **normal cloneable objects**: no functions, no Vue reactive proxies, no class instances. No matter how you change the return value, it will not affect BaiBai Image.
- Floor numbers uniformly use the zero base `mesid` of SillyTavern.
- **Please check the `error.code` branch for errors**, do not match the `message` copy (Chinese, will change with the version), and do not use `instanceof` (cross-plugin bundle boundaries will be invalid).

## Wait for the interface to be ready

The plug-in loading order is not fixed, both ways must be written:

```js
function useBaiBaiImage(callback) {
  if (globalThis.STBaiBaiImage) {
    callback(globalThis.STBaiBaiImage);
    return;
  }
  window.addEventListener(
    'st-baibai-image:ready',
    () => callback(globalThis.STBaiBaiImage),
    { once: true },
  );
}
```

Once ready, capabilities can be checked:

```js
const api = globalThis.STBaiBaiImage;

console.log(api.apiVersion);     // 1
console.log(api.pluginVersion); // BaiBai Image plug-in version
console.log(api.capabilities);
// { globalApi: true, characterLibrary: true, generate: true, saveToGallery: true, events: true }
```

## Read character library

```js
const list = globalThis.STBaiBaiImage.getCharacters();

for (const character of list.characters) {
  console.log(character.name, character.tag);
}
```

Return structure:

```js
{
  apiVersion: 1,
  pluginVersion: "0.2.5",
  revision: 7, // Every time the character library changes +1, use it to invalidate the cache
  floor: null, // The floor corresponding to the snapshot; null = current
  characters: [
    {
      name: "Adele",
      // The complete tag string that can be used directly for drawing - it is recommended to use this directly
      tag: "1girl, short silver hair, blue eyes, pale skin, slender, scar on left eyebrow, black coat",
      //Field-by-field version (required only if you want to choose and use it yourself)
      fields: {
        fandom: "", // fan identity
        sex: "1girl",
        hair: "short silver hair",
        eyes: "blue eyes",
        skin: "pale skin",
        body: "slender",
        extra: "scar on left eyebrow", // Logo features
        outfit: "black coat",
      },
      nl: "a girl with short silver hair", // Natural language appearance (optional)
      source: "ai", // 'manual' user handwriting | 'ai' AI file created in the plot | 'book' synchronized from BaiBai Book
      scope: "chat", // 'chat' this chat file | 'global' global character library (cross-chat)
      desc: "Silver short hair", // The sentence "Why does it look like this" when creating the file (mostly empty string)
    },
  ],
}
```

`tag` is put together in a fixed order (identity → gender → hair → eyes → skin color → body shape → iconic features → clothing), which is exactly the same as the string used by Bai Baohui for his own drawings. It is not recommended to spell it from `fields` - the old entry may only have the entire original text, and the fallback logic has been processed in `tag`.

### Read the character files of a certain historical floor

The character profile will evolve with the plot (AI changed the hair color of the character in a certain building). If you want to draw a picture for a certain historical floor, you have to use the archives of that floor at that time, otherwise the subsequent changes will also be drawn:

```js
//The character library snapshot before the 42 building** (excluding this building)
const atFloor = globalThis.STBaiBaiImage.getCharacters({ floor: 42 });
```

## Ask the backend before publishing the picture

```js
const status = globalThis.STBaiBaiImage.getBackendStatus();

if (!status.configured) {
  toastr.warning(status.reason); // reason is human language and can be displayed directly to the user
  return;
}
```

Return structure:

```js
{
  apiVersion: 1,
  pluginVersion: "0.2.5",
  backend: "nai",              // 'nai' | 'comfyui'
  configured: true,
  model: "nai-diffusion-4-5-full", // NAI is the model name; ComfyUI is the current workflow default name
  supportsCharacters: true, // The current front-end support does not support multi-role prompts
  reason: "", // The reason when configured=false; ready is an empty string
}
```

> **Does not include service address and API Key. ** These two will never appear in any public return value.

`supportsCharacters` only looks at the model, and has nothing to do with whether it is equipped or not - you can know whether to prepare `characters` before the user fills in Key. **ComfyUI is always `false`**.

## Tiaosheng Diagram

```js
const api = globalThis.STBaiBaiImage;

const result = await api.generate({
  prompt: '1girl, silver hair, moonlight, night sky',
  nl: 'a girl standing under the moonlight',
  size: 'portrait',
});

myPanel.querySelector('img').src = result.dataUrl; // Display it wherever you want.
```

### Request parameters

| Field | Type | Description |
| --- | --- | --- |
| `prompt` | `string` | **Required**, forward danbooru short tag. Empty string throw `invalid_args` |
| `nl` | `string?` | Natural language description |
| `negative` | `string?` | This screen is dynamically negative. **Only valid for ComfyUI**; NAI’s negative user channel configuration |
| `characters` | `PublicCharacterPrompt[]?` | Multi-character tips, see below |
| `size` | `'portrait' \| 'landscape'?` | Frame direction, default `'portrait'`. The specific pixel is the size configured by the user on the channel page. **When the user locks the frame direction in the channel, the picture will be output in the locked direction**, nothing uploaded here will count (from 0.3.1) |
| `seed` | `number?` | Specifies the seed (positive integer). Omitted = determined by user settings |
| `save` | `boolean?` | Place the disk into the Baiba drawing library, **default is `true`** |
| `character` | `string?` | Which character's name the placement belongs to (gallery group name). Omitted = current chat character name |

### Return value

```js
{
  apiVersion: 1,
  pluginVersion: "0.2.5",
  dataUrl: "data:image/png;base64,...", // can directly <img src>
  format: "png",
  path: "/user/images/Babao painted _ Adele/bbi_....png", // The placement path; save=false or the placement failure is null
  seed: 3847562910, // The actual seed used this time; if you want to reproduce it, fill it back in seed
  backend: "nai",
  charactersApplied: true,
}
```

The picture is **data URL** instead of blob URL: blob needs to be paired with `revokeObjectURL`. If you forget it, it will leak. We will replace your revoke and your `<img>` will suddenly become blank. The price is that the string is relatively large and should not remain in memory for a long time after use.

### About `save`

- `true` (default): Save the picture into `user/images/柏宝绘_<character>/`, and write a profile of the same name json. Write down the prompt words and seeds. So the user can see it grouped by role on the **Babao Drawing Library Page**, together with the prompt words. The profile records the **actual direction of drawing** (which is different from the `size` you passed when the user locked the frame).
- `false`: only returns `dataUrl`, without touching the disk. Suitable for "preview and throw away".

There will be no error if the placement **fails** - the picture is already in `dataUrl`. You cannot get the picture just because it cannot be saved in the gallery. In this case `path` is `null`.

### Multiple roles (NAI 4.5 / V5)

```js
const status = api.getBackendStatus();
const library = api.getCharacters().characters;

const result = await api.generate({
  prompt: '2girls, cafe, afternoon light',
  characters: status.supportsCharacters
    ? library.slice(0, 2).map(c => ({ name: c.name, tag: c.tag, nl: c.nl }))
    : [],
});

if (!result.charactersApplied) {
  console.log('The current backend does not support multiple roles, this time only prompt was used');
}
```

`charactersApplied` clearly stated whether it was used this time. Bai Baowei **deliberately not downgraded** the character into `prompt` - that will draw multiple overlapping torsos. To draw multiple characters, please look at `supportsCharacters` first.

### Progress and Cancellation

```js
const controller = new AbortController();

const result = await api.generate(
  { prompt: '1girl' },
  {
    signal: controller.signal,
    onProgress: p => {
      // 'queued' is queued in BaiBai Image's NAI concurrent gate
      // 'generating' request has been sent and the backend is drawing
      // 'queued-remote' is in the ComfyUI server queue (p.ahead is the first one)
      // 'retrying' has been limited and is backing off and trying again (p.attempt / p.max)
      // 'saving' picture has been obtained and is being placed.
      console.log(p.phase, p.ahead, p.attempt, p.max);
    },
  },
);

// Cancel: generate will throw code='aborted'
controller.abort();
```

`onProgress` throw error will only be recorded as console and will not affect the generation.

### Error handling

```js
try {
  await api.generate({ prompt: '1girl' });
} catch (error) {
  switch (error.code) {
    case 'aborted': break; // You canceled it yourself
    case 'not_configured': toastr.warning(error.message); break; // The user has not configured the backend properly
    case 'invalid_args': console.error(error.message); break; // You sent the wrong message
    case 'rate_limited': toastr.warning('The current is limited, try again later'); break;
    case 'backend_error':  toastr.error(error.message);   break;
  }
}
```

`rate_limited` and `backend_error` are separated because of different handling methods: the former should wait for a while (BaiBai Image's automatic backoff retries have been exhausted), the latter is a configuration/network problem, and it will be the same error if you try again immediately.

### Do not bypass this interface

All NAI requests within BaiBai Image go through the same **concurrency gate + global rhythm** (429 cooling, minimum interval between adjacent requests, exponential backoff retry). This interface wraps the gate inside. If you bypass it and type NAI's `generate-image` directly, the user's account will be flooded with 429 - and the user will only think that Bai Baohui is broken.

## Subscribe to character library changes

```js
const unsubscribe = globalThis.STBaiBaiImage.subscribe(notice => {
  console.log(notice.type);      // 'ready' | 'changed'
  console.log(notice.revision); // Same origin as getCharacters().revision
  console.log(notice.chatId);
  refreshMyCharacterPicker();
});

// Remember to unsubscribe when you don’t need it
unsubscribe();
```

Switch chat, delete buildings, swipe, users manually change files, AI creates files in the story - all changes to the character library will be notified. Changes in the same batch will be collected into one line and the screen will not be refreshed.

You can also directly listen to the DOM event (the content is the same as the callback parameter of `subscribe`):

```js
window.addEventListener('st-baibai-image:ready', e => console.log(e.detail));
window.addEventListener('st-baibai-image:changed', e => console.log(e.detail));
```

## Complete example

```js
function useBaiBaiImage(callback) {
  if (globalThis.STBaiBaiImage) return callback(globalThis.STBaiBaiImage);
  window.addEventListener('st-baibai-image:ready',
    () => callback(globalThis.STBaiBaiImage), { once: true });
}

useBaiBaiImage(async api => {
  if (api.apiVersion !== 1) {
    console.warn('BaiBai Image interface version does not match', api.apiVersion);
    return;
  }

  const status = api.getBackendStatus();
  if (!status.configured) {
    toastr.warning(`柏宝绘未就绪：${status.reason}`);
    return;
  }

  const heroine = api.getCharacters().characters.find(c => c.name === 'Adele');
  if (!heroine) return;

  try {
    const result = await api.generate({
      prompt: `${heroine.tag}, cafe, afternoon light`,
      nl: heroine.nl,
      size: 'landscape',
      character: heroine.name, //Place it in the directory of "Babao Painting _ Adele"
    });
    document.querySelector('#my-portrait').src = result.dataUrl;
  } catch (error) {
    if (error.code !== 'aborted') toastr.error(error.message, 'Picture failed');
  }
});
```

## Interface List

```ts
interface STBaiBaiImageApi {
  readonly apiVersion: 1;
  readonly pluginVersion: string;
  readonly capabilities: PublicCapabilities;
  getCharacters(options?: { floor?: number }): PublicCharacterList;
  getBackendStatus(): PublicBackendStatus;
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResult>;
  subscribe(listener: (notice: PublicChangeNotice) => void): () => void;
}
```

For the complete type definition, see the plug-in source code `src/public/types.ts`.

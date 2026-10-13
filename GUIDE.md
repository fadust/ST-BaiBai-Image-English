# BaiBai Image · SillyTavern Story Illustration Assistant

> Let every exciting plot of AI have pictures. While chatting with you, BaiBai Image will silently judge "whether this scene is worth painting", automatically select the most worthy moments, write prompts for drawing, and then send it to the drawing channel to generate pictures and embed them directly on the floor. The whole process is automatic, and can also be taken over manually at any time.

Stories with only words always feel like something is missing - what the characters look like, how exciting the battle scenes are, and the light at the moment of confession can only be filled in by the brain. Baibaohua was born to turn "imagination" into "seeing with your own eyes": it does not interrupt your chat, but only delivers a picture at the right time.

---

## What it can do

### 🖼️ Automatically match pictures, don’t miss the wonderful moments
- **Automatic analysis of the plot**: After each reply from AI, Bai Baohui will read through the plot and determine whether there are any moments worth drawing - if there are any moments, he will draw them; if not, he will skip them quietly and never swipe the screen.
- **Automatically write prompt words**: English positive tag, picture description, frame direction, and negative words are all automatically written, so you almost don’t have to touch the prompt words.
- **Multiple Pictures at One Time**: You can have as many pictures as you want. You can plan up to multiple pictures at a time and generate them sequentially according to the rhythm of the plot.
- **Manual takeover**: Want to specify a certain building to take over? Just click the "Generate tag" button on the floor; the written tag will also be displayed directly on the picture card, which can be viewed and modified at any time.

### 🎭 Character fixed appearance library: appearance never drifts
- **Automatic profile creation for first appearance**: When a named official character appears for the first time, Bai Baohui will automatically record his fixed appearance such as hair color, eye color, body shape, etc., and he will look the same in every picture thereafter.
- **Only report the name, do not copy the appearance**: AI Just write "@character name" in the prompt word, and the plug-in will automatically replace it with the latest and most accurate appearance in the file - completely eliminating the drift problem of "blond hair on one floor, black hair on the next floor".
- **Automatic update of permanent changes**: The character dyes, cuts, scars, grows up... These permanent changes will be automatically recorded in the file, and **take effect according to the plot position**: the picture before the change uses the old appearance, and the picture after the change uses the new appearance, so the timeline is not messy.
- **Temporary status is not confused**: Temporary status such as wig, wet body, and bandage will not pollute the file, but will continue to remain in the same scene until the plot is resolved.
- **Manual Editing and Rollback**: Files can be manually modified and deleted at any time; every automatic change of AI is recorded and can be rolled back with one click.
- **Global Character Library**: Player characters and other characters that "use the same face in every chat" can be "promoted to global" with one click on the character management page - after that, all chats will automatically take effect, without the need to repeatedly create files. The global role is a frozen file: AI will never modify it and is completely maintained manually by you. If you want a certain chat to be different, just copy it back to the original chat to overwrite it.

### 🎨 Picture publishing channel: ComfyUI and NovelAI
- **ComfyUI**: There are two configuration methods to choose from - **Simple Parameters** mode directly selects basic parameters such as model/LoRA, number of steps, etc. to output the picture (built-in Checkpoint series/Flux/Anima template, the model list is pulled from ComfyUI with one click); **Customized workflow** mode loads your own API workflow template, and the placeholders are automatically filled in tag, description and size, don't worry about how to connect the nodes - **AI will automatically locate** which node to fill in, which fragments to keep, and you can preview the changes before applying.
- **Multiple sets of workflows can be switched at any time**: You can save a set of commonly used workflows and give them names, and you can change them by just pulling down. Natural language switches and horizontal and vertical dimensions all follow the workflow - switching back and forth between the 2D base mold and Flux, there is no need to change settings one by one.
- **Fixed horizontal image/vertical image**: Next to the size of each channel, there is "frame orientation": automatic/portrait/landscape. After locking, each picture will be produced in this direction. AI will also compose the picture according to this frame when writing prompt words. There is no need to fill in the horizontal and vertical dimensions to make it up (ComfyUI has its own settings for each set of workflows).
- **NovelAI**: Official v3 / v4 / v5 series models; supports vibe reference pictures (character style, painting style reference); `.naiv4vibe` files are interoperable with the official, and can be imported or exported.
- **NAI multiple access points can be switched at any time**: The official site and each third-party site can each save one, name each, and remember their own Key, and just pull down and switch. Changing stations only changes the outlet - the parameters such as model, sampler, size, vibe, and artist string are all the same as before, and there is no need to reconfigure them again. The official one is built-in, so there is no need to fill in the address.
- **NAI natural language can be turned on or off**: NAI 4.5's prompt words have a maximum length (the screen shares about 512 token with all characters). The natural language description takes up the most space. The excess part will be cut off and the screen will be distorted. If you think 4.5 draws strangely, you can turn off "Generate Natural Language" in the NAI channel and let AI only write tag.
- **Channel flexibility**: You can assign a dedicated secondary API channel to run the chart without occupying the main conversation; it will follow the main API without configuration.
- **Artist strings can be switched at any time**: You can save a set of commonly used painting styles/artist combinations and give them names. You can change them by dragging them down, or you can choose "not to use". The selected artist string will be spelled at the beginning of the prompt word, and the style and tone of the entire painting will be set at once.
- **Intelligent default of negative words and quality words**: Each model has officially recommended quality words and negative words. Click on it to see the actual effective content; change it if you want. After the change is completed, it will be marked "Customized", and you can restore the default at any time with one click.

### 📁 Picture management, chat and save anytime
- **Embedded floor cards**: The generated pictures are directly embedded under the corresponding floors, corresponding to the plot one-to-one.
- **Adjustable display size**: Do you think the pictures on the floor are too big on the wide screen of your computer? The "floor image display size" on the settings page has four levels: small/medium/large/full. Only the size displayed in the chat is changed, the image resolution is not affected, and the image file remains unchanged.
- **Click to enlarge, long press to save**: View the large picture in the lightbox, long press the picture to save it locally.
- **Picture information can be traced back**: Each picture is recorded with the complete prompt words, artist string, vibe (including intensity), model and sampling parameters; click on it in the light box or gallery to see how it was drawn at that time - you will never forget which formula was used for your favorite picture.
- **Regenerate and Cancel**: If you are not satisfied with a certain picture, click to redraw it (reproduce a picture with the same prompt word); if you feel that the prompt word is not written properly, open the pencil (edit prompt word) pop-up window, where you can change it yourself, or click "AI Rewrite Prompt Word" to have it reread the plot, rewrite the prompt word of this picture and then publish the picture - only touch this one, other pictures in the same building will not be affected. During rewriting, you can safely close the pop-up window, the generation will not be interrupted, and you can continue to watch it when you open it again; if you want to reselect the entire screen, use the color palette button in the Messages ⋯ menu. You can cancel it at any time while it is being generated, so you don’t waste your credit.
- **Smart Queue**: Multiple pictures are queued to generate, and the number of concurrency is adjustable, so the channel will not be crowded.
- **Optional JPG transfer**: When smaller file size is required, PNG can be automatically transferred to JPG.

### 🤝 Seamless collaboration with BaiBai Book
- Bai Baohui reads the character status and plot memory of BaiBai Book to make the illustrations closely match the "plot at the moment".
- Don't want to be disturbed by a certain content? **The exclusion list is shared with BaiBai Book** - Exclude by character, by the entire World Info or by entry name, both ends are synchronized, and one setting takes effect on both sides.

### ⚙️ You can adjust it as finely as you want.
- **All prompt words are editable**: limit breaking, drawing specifications, thinking chain... Each set has built-in defaults, and can also be customized. In the specification and thinking chain, you can also use `{{#nl}}…{{/nl}}` / `{{^nl}}…{{/nl}}` to write paragraphs that only take effect when "Generate Natural Language" is turned on/off. A prompt word can be used in both modes.
- **Multiple Theme Interface**: Automatically follows SillyTavern color matching, suitable for mobile phones, tablets, and computers.
- **Automatic update**: When a new version is available, a small red dot will light up in the navigation bar, and the settings page will be updated with one click and automatically refreshed.

---

## Installation

Just fill in the warehouse address in SillyTavern's "Extension → Install Extension":

```
https://github.com/baibai-git/ST-BaiBai-Image
```

After installation, enter the "Settings" page: first go to the "Channel" page to configure the image publishing channel (local ComfyUI or NovelAI account), and then confirm that the "Automatically generate tag" switch is turned on, and then you can start automatic image matching. The settings will be saved on the server with SillyTavern and automatically synchronized across devices.

---

## Tips

- **Out-of-the-box**: Under the default settings, as long as the picture output channel is configured, AI will automatically add pictures to each chat section; if you do not want to automatically produce pictures and just want to write tag first, just turn off the "Automatically generate pictures" switch.
- **The character appearance database is automatically maintained**: You don't need to enter any characters in advance. The plug-in will automatically create a file when you appear for the first time. If you want to fine-tune it, go to the "Character Management" page to start. Fixed roles (such as players) can be "promoted to global status", and there is no need to re-create a profile when changing chats.
- **ComfyUI user**: If you don’t want to touch the workflow JSON, you can use the “Simple Parameter” mode to select a model to produce a picture; if you have your own workflow, use the AI automatic configuration function to run it once, and then reuse it. If there are multiple sets of commonly used configurations, you can save multiple sets and switch at any time.
- **NovelAI users**: The vibe reference picture is not necessary, but it can make the style/character more stable; `.naiv4vibe` files are interoperable with the official.
- **Picture data follows the chat**: Deleting the chat will delete the corresponding picture data, and your privacy is controllable.

---

## To the plugin author

BaiBai Image has opened a set of public interfaces (`globalThis.STBaiBaiImage`), and other plug-ins can:

- **Read character library**: Get the characters recorded by Bai Baohui and tag that can be directly drawn;
- **Tiao Baibao draws pictures**: backend configuration, concurrency gate, current limit and backoff, and gallery archiving are all reused, **it is up to you to decide where the picture is displayed**——
  You can draw it on the sidebar or in your own pop-up window. The generated picture will not enter any chat history.

See **[PUBLIC_API.md](./PUBLIC_API.md)** for details.

---

Author: Bai Bai · Feedback and suggestions are welcome.

# MOSS natural-language trial

Realistic and anime MOSS use the supplied Prompt Studio design adapted to BaiBai. Their bodies are identical; only the opening identifies photo realism or anime illustration. All scene content goes in `nl`. The required `tag` field is a short subject reference rather than a second tag list.

English is preferred, with explicit language requests respected. Character cards, persona, lorebook and saved profiles supply appearance; the passage supplies current outfit, injury and action. Saved descriptions are visible to the planner and incorporated once in `nl`, so the image card does not append the saved appearance again for MOSS prompts containing `nl`.

The trial requests a picture without lettering, speech/thought bubbles, captions, logos or signatures. Old strip/page settings remain stored but do not request panels or bubbles. Spatial layout is described in prose; native BBOX coordinates and layout conditioning are not enabled by this trial.

## Try it

1. Install this version, then reload SillyTavern.
2. Choose MOSS realistic or MOSS anime as the workflow's prompt dialect. Keep `%nl%` connected to the positive encoder in a custom workflow.
3. Leave the matching specification and checklist blank to use the new defaults. Exact previous built-in values migrate automatically; customized values are preserved and may need a manual reset.
4. Use **AI rewrite prompt** on one existing scene to plan a fresh description from the character sheet and story. Inspect the resulting `nl` before judging the generated image. Old stored prompts remain unchanged; re-plan them to include sheet appearance before re-rendering under the new MOSS rules.
5. **Edit prompt only** uses the draft and requested edit, without fetching the story or character sheet. It preserves the appearance already in that draft.

The manually edited workflow, model, LoRAs, sampler, steps and CFG are unchanged. Customized fixed positives and negatives remain yours. If unwanted lettering appears, the workflow's fixed negative can include `text, speech bubble, thought bubble, watermark, signature, logo`.

Validation covers prompt construction, shared mode body, legacy bubble suppression, appearance references and exact-default migration. Automated checks and browser preview do not establish visual quality; compare one real generation using your existing settings.

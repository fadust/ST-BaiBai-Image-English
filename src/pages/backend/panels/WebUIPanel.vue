<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { settings } from '@/state/settings';
import { ref } from 'vue';

// 占位状态,功能接入后移到 settings.webui
const hiresFix = ref(false);
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">Stable Diffusion WebUI (A1111 / Forge / reForge), use its /sdapi/v1 interface.</p>

    <div class="bbi-sections">
      <Collapsible title="Config" :open="false">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">Service address</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.url"
            placeholder="http://127.0.0.1:7860"
            spellcheck="false"
          />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">positive quality words</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.qualityTags"
            placeholder="masterpiece, best quality, ..."
            spellcheck="false"
          />
          <p class="bbi-field-hint">When generated, it is automatically spelled in front of the positive prompt word.</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">negative cue words</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.negativePrompt"
            placeholder="lowres, bad anatomy, ..."
            spellcheck="false"
          />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">resolution</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.resolution"
            placeholder="Such as 832×1216"
            spellcheck="false"
          />
        </div>

        <div class="conn-actions">
          <button class="bbi-btn" type="button" disabled title="Function under development">
            <Icon name="plug" />
            Test connection
          </button>
        </div>
      </Collapsible>

      <Collapsible title="Default parameters" :open="true">
        <div class="be-grid">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">Model(Checkpoint)</span>
            </div>
            <select class="bbi-input bbi-select" disabled>
              <option>(Automatically pulled after connection)</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">sampler</span>
            </div>
            <select class="bbi-input bbi-select" disabled>
              <option>(Automatically pulled after connection)</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">number of steps</span>
            </div>
            <input class="bbi-input" type="number" placeholder="28" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">CFG Scale</span>
            </div>
            <input class="bbi-input" type="number" placeholder="7" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">wide</span>
            </div>
            <input class="bbi-input" type="number" placeholder="832" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">high</span>
            </div>
            <input class="bbi-input" type="number" placeholder="1216" disabled />
          </div>
        </div>
        <label class="bbi-switch-row">
          <span class="bbi-field-label">Hires. fix (HD restoration)</span>
          <input v-model="hiresFix" type="checkbox" class="bbi-checkbox" disabled />
        </label>
        <p class="bbi-field-hint">The parameter function is under development and is currently only displayed.</p>
      </Collapsible>
    </div>
  </div>
</template>

<style scoped>
.be-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
}
@media (max-width: 640px) {
  .be-grid {
    grid-template-columns: 1fr;
  }
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
}
</style>

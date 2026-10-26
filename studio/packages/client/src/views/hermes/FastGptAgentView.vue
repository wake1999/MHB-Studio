<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import { FASTGPT_EMBED_BASE } from '@/api/studio/fastgpt-agents'

/**
 * 在 Studio 内打开一个 FastGPT 智能体。
 *
 * iframe 指向 FastGPT 宿主机上的去头反代（同域不同端口，登录态共享），
 * 因为 FastGPT 本体带 `X-Frame-Options: DENY`，直连会被浏览器拒绝。
 */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const appId = computed(() => String(route.query.appId ?? '').trim())
const agentName = computed(() => String(route.query.name ?? '').trim() || appId.value)
const sceneLabel = computed(() => String(route.query.scene ?? '').trim())
const frameKey = ref(0)
const failed = ref(false)

const embedUrl = computed(() => (appId.value ? `${FASTGPT_EMBED_BASE}/chat?appId=${encodeURIComponent(appId.value)}` : ''))
const externalUrl = computed(() => (appId.value ? `${FASTGPT_EMBED_BASE.replace(/:3010$/, ':3000')}/chat?appId=${encodeURIComponent(appId.value)}` : ''))

function back() {
  if (window.history.length > 1) router.back()
  else void router.push({ name: 'hermes.chat' })
}

function reload() {
  failed.value = false
  frameKey.value += 1
}

function openExternal() {
  if (externalUrl.value) window.open(externalUrl.value, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <div class="fastgpt-embed">
    <div class="fastgpt-embed-bar">
      <button type="button" class="fastgpt-embed-back" :aria-label="t('chat.agentsBack')" @click="back">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
      <div class="fastgpt-embed-title">
        <span class="fastgpt-embed-name">{{ agentName }}</span>
        <span v-if="sceneLabel" class="fastgpt-embed-scene">{{ sceneLabel }}</span>
      </div>
      <div class="fastgpt-embed-actions">
        <button type="button" class="fastgpt-embed-action" :title="t('chat.agentsReload')" @click="reload">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.4 6.2" />
            <path d="M20 5v6h-6" />
          </svg>
        </button>
        <NButton size="small" quaternary @click="openExternal">{{ t('chat.agentsOpenExternal') }}</NButton>
      </div>
    </div>

    <div class="fastgpt-embed-body">
      <iframe
        v-if="embedUrl && !failed"
        :key="frameKey"
        class="fastgpt-embed-frame"
        :src="embedUrl"
        :title="agentName"
        allow="microphone; camera; clipboard-read; clipboard-write; fullscreen"
        referrerpolicy="no-referrer"
        @error="failed = true"
      />
      <div v-else class="fastgpt-embed-fallback">
        <p>{{ t('chat.agentsEmbedFailed') }}</p>
        <NButton size="small" type="primary" @click="openExternal">{{ t('chat.agentsOpenExternal') }}</NButton>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.fastgpt-embed {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: $bg-primary;
}

.fastgpt-embed-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 48px;
  padding: 0 12px;
  border-bottom: 1px solid $border-light;
  background: $bg-main-surface;
}

.fastgpt-embed-back,
.fastgpt-embed-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover {
    background: rgba(var(--text-primary-rgb), 0.07);
    color: $text-primary;
  }

  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}

.fastgpt-embed-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.fastgpt-embed-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-primary;
  font-size: 13.5px;
  font-weight: 600;
}

.fastgpt-embed-scene {
  flex: none;
  padding: 1px 8px;
  border: 1px solid $border-light;
  border-radius: 999px;
  color: $text-secondary;
  font-size: 11px;
  line-height: 18px;
}

.fastgpt-embed-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-inline-start: auto;
}

.fastgpt-embed-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

.fastgpt-embed-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: $bg-primary;
}

.fastgpt-embed-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  padding: 24px;
  color: $text-secondary;
  font-size: 13px;
  text-align: center;
}
</style>

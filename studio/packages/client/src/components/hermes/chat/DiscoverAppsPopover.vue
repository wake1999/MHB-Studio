<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatApp } from '@/data/chat-apps'

/**
 * 「发现应用」：一个胶囊 + 一层列表，只列 chat app。
 *
 * FastGPT 的智能体不在这里选——它们属于应用内部的场景内容，挂在首页的场景卡片区。
 * 面板自己定位（不挂 naive-ui 的 popover），因为它的高度要跟着搜索过滤走；
 * 选中由父组件落地（写偏好、换首页外观），这里只负责挑，并把触发器换成可关闭的胶囊。
 */
const props = defineProps<{
  apps: readonly ChatApp[]
  activeId: string
  /** 最近点过的应用 id，最近一次在最前。 */
  recentIds: readonly string[]
  /** 面板贴着触发器的哪一侧展开；页头在右上角时用 right，免得把面板顶出视口。 */
  align?: 'left' | 'right'
}>()
const emit = defineEmits<{ select: [id: string | null] }>()
const { t } = useI18n()

const open = ref(false)
const query = ref('')
const root = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
/** 面板用 fixed 定位并跟随触发器摆放：页头/内容区都可能被滚动或裁切，absolute 会跑位。 */
const panelStyle = ref<Record<string, string>>({})

interface PanelItem {
  id: string
  name: string
  desc: string
  tint: string
  iconPaths?: readonly string[]
  /** 没有 svg 图标时，圆形封面上的那一个字。 */
  glyph: string
}

function glyphOf(name: string): string {
  const value = name.trim()
  if (!value) return '?'
  const first = Array.from(value)[0] ?? '?'
  return /[a-zA-Z]/.test(first) ? first.toUpperCase() : first
}

const items = computed<PanelItem[]>(() => props.apps.map(app => ({
  id: app.id,
  name: app.name,
  desc: app.desc,
  tint: app.tint,
  iconPaths: app.iconPaths,
  glyph: glyphOf(app.name),
})))

const activeItem = computed<PanelItem | null>(() => items.value.find(item => item.id === props.activeId) ?? null)

/** 最近使用：按点过的顺序去重，最多 6 个。 */
const recentItems = computed<PanelItem[]>(() => {
  const seen = new Set<string>()
  const picked: PanelItem[] = []
  for (const id of props.recentIds ?? []) {
    if (seen.has(id) || picked.length >= 6) continue
    seen.add(id)
    const app = items.value.find(item => item.id === id)
    if (app) picked.push(app)
  }
  return picked
})

const keyword = computed(() => query.value.trim().toLowerCase())
function matches(item: PanelItem) {
  if (!keyword.value) return true
  return `${item.name} ${item.desc}`.toLowerCase().includes(keyword.value)
}

const recentResults = computed(() => recentItems.value.filter(matches))
const restResults = computed(() => {
  const recentKeys = new Set(recentItems.value.map(item => item.id))
  return items.value.filter(item => !recentKeys.has(item.id) && matches(item))
})
const hasResults = computed(() => recentResults.value.length > 0 || restResults.value.length > 0)

function placePanel() {
  if (typeof window === 'undefined') return
  const rect = triggerRef.value?.getBoundingClientRect()
  if (!rect) return
  const width = Math.min(320, window.innerWidth - 24)
  const preferred = props.align === 'right' ? rect.right - width : rect.left
  const left = Math.max(12, Math.min(preferred, window.innerWidth - width - 12))
  panelStyle.value = {
    top: `${Math.round(rect.bottom + 8)}px`,
    left: `${Math.round(left)}px`,
    width: `${Math.round(width)}px`,
  }
}

function close() {
  open.value = false
  query.value = ''
}

function toggle() {
  if (open.value) close()
  else open.value = true
}

function pick(item: PanelItem) {
  emit('select', item.id)
  close()
}

/** 退出当前应用：回到默认首页，不丢任何内容。 */
function clearCurrent() {
  if (props.activeId) emit('select', null)
  close()
}

function handlePointerDown(event: PointerEvent) {
  if (!open.value) return
  const target = event.target as Node | null
  if (target && root.value?.contains(target)) return
  close()
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) close()
}

function detachViewportListeners() {
  if (typeof window === 'undefined') return
  window.removeEventListener('scroll', placePanel, true)
  window.removeEventListener('resize', placePanel)
}

watch(open, (value) => {
  if (typeof document === 'undefined') return
  if (value) {
    placePanel()
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeydown)
    // 页面里滚动的容器会改变触发器位置，面板跟着走（capture 才能收到内层滚动）。
    window.addEventListener('scroll', placePanel, true)
    window.addEventListener('resize', placePanel)
    void nextTick(() => searchRef.value?.focus())
    return
  }
  document.removeEventListener('pointerdown', handlePointerDown, true)
  document.removeEventListener('keydown', handleKeydown)
  detachViewportListeners()
})

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('pointerdown', handlePointerDown, true)
  document.removeEventListener('keydown', handleKeydown)
  detachViewportListeners()
})
</script>

<template>
  <div ref="root" class="discover-apps" :class="{ 'discover-apps--right': align === 'right' }">
    <button
      ref="triggerRef"
      type="button"
      class="discover-apps-trigger"
      :class="{
        'discover-apps-trigger-open': open,
        'discover-apps-trigger--active': activeItem,
      }"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
    >
      <template v-if="activeItem">
        <span class="discover-apps-trigger-icon" :style="{ background: activeItem.tint }" aria-hidden="true">
          <svg v-if="activeItem.iconPaths?.length" width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path v-for="(path, index) in activeItem.iconPaths" :key="index" :d="path" />
          </svg>
          <template v-else>{{ activeItem.glyph }}</template>
        </span>
        <span class="discover-apps-trigger-name">{{ activeItem.name }}</span>
        <span class="discover-apps-trigger-divider" aria-hidden="true"></span>
        <span
          class="discover-apps-trigger-clear"
          role="button"
          tabindex="-1"
          :aria-label="t('chat.discoverAppsClear')"
          :title="t('chat.discoverAppsClear')"
          @click.stop="clearCurrent"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="8.6" />
            <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
          </svg>
        </span>
      </template>
      <template v-else>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8.6" />
          <path d="M15.6 8.4l-2.2 5-5 2.2 2.2-5z" />
        </svg>
        <span>{{ t('chat.discoverApps') }}</span>
        <svg class="discover-apps-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </template>
    </button>

    <div v-if="open" class="discover-apps-panel" role="menu" :style="panelStyle" @click.stop>
      <input
        ref="searchRef"
        v-model="query"
        class="discover-apps-search"
        type="search"
        :placeholder="t('chat.discoverAppsSearch')"
        :aria-label="t('chat.discoverAppsSearch')"
      />
      <div class="discover-apps-list">
        <template v-if="recentResults.length > 0">
          <p class="discover-apps-group">{{ t('chat.discoverAppsRecent') }}</p>
          <div class="discover-apps-recent">
            <button
              v-for="item in recentResults"
              :key="item.id"
              type="button"
              role="menuitem"
              class="discover-apps-recent-item"
              :title="item.name"
              @click="pick(item)"
            >
              <span class="discover-apps-recent-icon" :style="{ background: item.tint }" aria-hidden="true">
                <svg v-if="item.iconPaths?.length" width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path v-for="(path, index) in item.iconPaths" :key="index" :d="path" />
                </svg>
                <template v-else>{{ item.glyph }}</template>
              </span>
              <span class="discover-apps-recent-name">{{ item.name }}</span>
            </button>
          </div>
        </template>

        <template v-if="restResults.length > 0">
          <p class="discover-apps-group">{{ t('chat.discoverAppsRecommended') }}</p>
          <button
            v-for="item in restResults"
            :key="item.id"
            type="button"
            role="menuitem"
            class="discover-apps-row"
            :class="{ 'discover-apps-row-active': activeItem?.id === item.id }"
            :aria-current="activeItem?.id === item.id || undefined"
            @click="pick(item)"
          >
            <span class="discover-apps-icon" :style="{ background: item.tint }" aria-hidden="true">
              <svg v-if="item.iconPaths?.length" width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path v-for="(path, index) in item.iconPaths" :key="index" :d="path" />
              </svg>
              <template v-else>{{ item.glyph }}</template>
            </span>
            <span class="discover-apps-text">
              <span class="discover-apps-name">{{ item.name }}</span>
              <span class="discover-apps-desc">{{ item.desc }}</span>
            </span>
            <svg v-if="activeItem?.id === item.id" class="discover-apps-check" width="14" height="14"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
              stroke-linejoin="round" aria-hidden="true">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </button>
        </template>
        <p v-if="!hasResults" class="discover-apps-empty">{{ t('chat.discoverAppsEmpty') }}</p>
      </div>
      <button v-if="activeItem" type="button" class="discover-apps-clear" @click="clearCurrent">
        {{ t('chat.discoverAppsClear') }}
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.discover-apps {
  position: relative;
  display: inline-flex;
  max-width: 100%;
}

.discover-apps-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  max-width: 100%;
  padding: 0 10px;
  border: 1px solid rgba(128, 128, 128, 0.24);
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: color $transition-fast, border-color $transition-fast, background $transition-fast;

  &:hover,
  &-open {
    color: $text-primary;
    border-color: rgba(var(--text-primary-rgb), 0.28);
    background: rgba(var(--text-primary-rgb), 0.04);
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 2px;
  }
}

/* 选中后：触发器变成「图标 + 名称 + ⊗」的胶囊，⊗ 直接退出。 */
.discover-apps-trigger--active {
  gap: 8px;
  height: 32px;
  padding: 0 4px;
  border-color: transparent;
  background: rgba(var(--text-primary-rgb), 0.06);
  color: $text-primary;

  &:hover {
    background: rgba(var(--text-primary-rgb), 0.1);
  }
}

.discover-apps-trigger-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

.discover-apps-trigger-name {
  min-width: 0;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-primary;
  font-size: 12.5px;
}

.discover-apps-trigger-divider {
  flex: none;
  width: 1px;
  height: 14px;
  background: rgba(var(--text-primary-rgb), 0.16);
}

.discover-apps-trigger-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: $text-secondary;
  transition: background $transition-fast, color $transition-fast;

  &:hover {
    background: rgba(var(--text-primary-rgb), 0.12);
    color: $text-primary;
  }
}

.discover-apps-chevron {
  transition: transform $transition-fast;
}

.discover-apps-trigger-open .discover-apps-chevron {
  transform: rotate(180deg);
}

/* 定位交给组件里的 placePanel（fixed + 触发器实测坐标），这里只管外观。 */
.discover-apps-panel {
  position: fixed;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: min(60vh, 460px);
  padding: 8px;
  border: 1px solid $border-color;
  border-radius: 14px;
  background: $bg-card;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.16);
}

.discover-apps-search {
  flex: none;
  height: 34px;
  padding: 0 10px;
  border: 1px solid $border-color;
  border-radius: 9px;
  background: $bg-input;
  color: $text-primary;
  font: inherit;
  font-size: 13px;

  &::placeholder { color: $text-muted; }
  &:focus { outline: none; border-color: $accent-primary; }
}

.discover-apps-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}

.discover-apps-group {
  margin: 8px 8px 2px;
  color: $text-muted;
  font-size: 11.5px;
  line-height: 1.4;
}

.discover-apps-recent {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  padding: 0 2px;
}

.discover-apps-recent-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 6px 4px 8px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: background $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.06); }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}

.discover-apps-recent-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #ffffff;
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
}

.discover-apps-recent-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-width: 100%;
  color: $text-secondary;
  font-size: 11.5px;
  line-height: 1.3;
  text-align: center;
  word-break: break-all;
}

.discover-apps-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: $text-primary;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.06); }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}

/* 当前应用：用 accent 的淡色而不是 $accent-muted（那是 #888 实色，暗色下会压成灰块）。 */
.discover-apps-row-active {
  background: rgba(var(--accent-primary-rgb), 0.1);

  &:hover { background: rgba(var(--accent-primary-rgb), 0.16); }
}

.discover-apps-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

.discover-apps-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.discover-apps-name {
  font-size: 13px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.discover-apps-desc {
  color: $text-secondary;
  font-size: 11.5px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.discover-apps-check {
  flex: none;
  margin-left: auto;
  color: $accent-primary;
}

.discover-apps-empty {
  margin: 10px 8px;
  color: $text-muted;
  font-size: 12.5px;
  text-align: center;
}

.discover-apps-clear {
  flex: none;
  height: 30px;
  border: 0;
  border-top: 1px solid $border-light;
  border-radius: 0 0 10px 10px;
  background: transparent;
  color: $text-secondary;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: color $transition-fast, background $transition-fast;

  &:hover { color: $text-primary; background: rgba(var(--text-primary-rgb), 0.05); }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}
</style>

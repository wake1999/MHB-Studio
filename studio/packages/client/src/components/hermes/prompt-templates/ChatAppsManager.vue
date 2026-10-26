<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NButton,
  NEmpty,
  NInput,
  NInputNumber,
  NModal,
  NSpin,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui'
import {
  createChatApp,
  fetchChatAppsForAdmin,
  removeChatApp,
  saveChatApp,
  type ChatAppDto,
  type ChatAppTextDto,
} from '@/api/studio/chat-apps'

/**
 * 「发现应用」的应用目录管理。
 *
 * 挂在提示词模板页的第二个页签：左边是应用清单，编辑用弹窗。一个应用 = 首页的一次
 * 换装（大标题 / 副标题 / 场景 chips / 输入框占位符）+ 每个场景的快捷提示词。
 *
 * 文案分中文与 English 两组：English 整组留空时前端回退中文，所以只服务中文用户时
 * 可以只填左边。应用标识创建后不可改（前端偏好按 id 记，改 id 等于换了一个应用）。
 */

const DEFAULT_ICON = ['M9.5 3h5', 'M10.5 3v13.2a2.6 2.6 0 0 0 5.2 0V3', 'M10.5 10.4h5.2']
const DEFAULT_TINT = 'linear-gradient(135deg, #4aa3f0, #2f6fe0)'
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

interface PromptDraft {
  label: string
  text: string
}

interface SceneDraft {
  id: string
  zhLabel: string
  zhPlaceholder: string
  enLabel: string
  enPlaceholder: string
  prompts: PromptDraft[]
}

interface AppDraft {
  id: string
  sort: number
  enabled: boolean
  zh: ChatAppTextDto
  en: ChatAppTextDto
  scenes: SceneDraft[]
}

function emptyText(): ChatAppTextDto {
  return { name: '', desc: '', heroTitle: '', heroSubtitle: '', placeholder: '' }
}

function emptyScene(index: number): SceneDraft {
  return { id: `scene-${index + 1}`, zhLabel: '', zhPlaceholder: '', enLabel: '', enPlaceholder: '', prompts: [] }
}

const apps = ref<ChatAppDto[]>([])
const loading = ref(false)
const saving = ref(false)
const enabledSaving = ref('')
const showEditor = ref(false)
const editingId = ref<string | null>(null)
const draft = ref<AppDraft>({ id: '', sort: 0, enabled: true, zh: emptyText(), en: emptyText(), scenes: [] })
/** 图标与底色不在表单里编辑：新建用默认，编辑保留原值。 */
const iconPaths = ref<string[]>([...DEFAULT_ICON])
const tint = ref(DEFAULT_TINT)

const editorTitle = computed(() => (
  editingId.value === null ? t('promptTemplates.appsNew') : t('promptTemplates.edit')
))

async function load() {
  loading.value = true
  try {
    apps.value = await fetchChatAppsForAdmin()
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('promptTemplates.appsLoadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(() => { void load() })

function openCreate() {
  editingId.value = null
  iconPaths.value = [...DEFAULT_ICON]
  tint.value = DEFAULT_TINT
  const nextSort = apps.value.reduce((max, app) => Math.max(max, Number(app.sort ?? 0)), -1) + 1
  draft.value = { id: '', sort: nextSort, enabled: true, zh: emptyText(), en: emptyText(), scenes: [emptyScene(0)] }
  showEditor.value = true
}

function openEdit(app: ChatAppDto) {
  editingId.value = app.id
  iconPaths.value = app.iconPaths?.length ? [...app.iconPaths] : [...DEFAULT_ICON]
  tint.value = app.tint || DEFAULT_TINT
  const zh = app.text?.zh ?? emptyText()
  const en = app.text?.en ?? emptyText()
  draft.value = {
    id: app.id,
    sort: Number(app.sort ?? 0),
    enabled: app.enabled !== false,
    zh: { ...emptyText(), ...zh },
    en: { ...emptyText(), ...en },
    scenes: (app.scenes ?? []).map(scene => ({
      id: scene.id,
      zhLabel: scene.text?.zh?.label ?? '',
      zhPlaceholder: scene.text?.zh?.placeholder ?? '',
      enLabel: scene.text?.en?.label ?? '',
      enPlaceholder: scene.text?.en?.placeholder ?? '',
      prompts: (scene.quickPrompts ?? []).map(prompt => ({ label: prompt.label, text: prompt.text })),
    })),
  }
  showEditor.value = true
}

function addScene() {
  draft.value.scenes.push(emptyScene(draft.value.scenes.length))
}

function removeScene(index: number) {
  draft.value.scenes.splice(index, 1)
}

function moveScene(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= draft.value.scenes.length) return
  const scenes = draft.value.scenes
  const [scene] = scenes.splice(index, 1)
  scenes.splice(target, 0, scene)
}

function addPrompt(scene: SceneDraft) {
  scene.prompts.push({ label: '', text: '' })
}

function removePrompt(scene: SceneDraft, index: number) {
  scene.prompts.splice(index, 1)
}

function buildPayload() {
  const zh = draft.value.zh
  const en = draft.value.en
  const text: Record<string, ChatAppTextDto> = { zh: { ...zh } }
  const enHasContent = [en.name, en.desc, en.heroTitle, en.heroSubtitle, en.placeholder]
    .some(value => value.trim() !== '')
  if (enHasContent) text.en = { ...en }

  const scenes = draft.value.scenes
    .filter(scene => scene.zhLabel.trim() !== '' || scene.enLabel.trim() !== '')
    .map((scene, index) => {
      const sceneText: Record<string, { label: string; placeholder: string }> = {
        zh: { label: scene.zhLabel.trim(), placeholder: scene.zhPlaceholder.trim() },
      }
      if (scene.enLabel.trim() !== '' || scene.enPlaceholder.trim() !== '') {
        sceneText.en = { label: scene.enLabel.trim(), placeholder: scene.enPlaceholder.trim() }
      }
      return {
        id: scene.id.trim() || `scene-${index + 1}`,
        text: sceneText,
        quickPrompts: scene.prompts
          .filter(prompt => prompt.label.trim() !== '' && prompt.text.trim() !== '')
          .map(prompt => ({ label: prompt.label.trim(), text: prompt.text.trim() })),
      }
    })

  return { iconPaths: iconPaths.value, tint: tint.value, text, scenes }
}

async function save() {
  const id = draft.value.id.trim()
  if (editingId.value === null && !ID_PATTERN.test(id)) {
    message.warning(t('promptTemplates.appsIdHint'))
    return
  }
  if (draft.value.zh.name.trim() === '') {
    message.warning(t('promptTemplates.appsRequired'))
    return
  }

  saving.value = true
  try {
    const payload = buildPayload()
    if (editingId.value === null) {
      await createChatApp(id, { payload, enabled: draft.value.enabled, sort: draft.value.sort })
    } else {
      await saveChatApp(editingId.value, { payload, enabled: draft.value.enabled, sort: draft.value.sort })
    }
    showEditor.value = false
    message.success(t('promptTemplates.appsSaved'))
    await load()
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('promptTemplates.appsSaveFailed'))
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(app: ChatAppDto, enabled: boolean) {
  if (enabledSaving.value) return
  enabledSaving.value = app.id
  try {
    await saveChatApp(app.id, {
      payload: { iconPaths: app.iconPaths, tint: app.tint, text: app.text, scenes: app.scenes },
      enabled,
    })
    app.enabled = enabled
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('promptTemplates.appsEnabledFailed'))
  } finally {
    enabledSaving.value = ''
  }
}

function confirmRemove(app: ChatAppDto) {
  dialog.warning({
    title: t('promptTemplates.appsDeleteTitle'),
    content: t('promptTemplates.appsDeleteConfirm', { name: app.text?.zh?.name || app.id }),
    positiveText: t('promptTemplates.delete'),
    negativeText: t('promptTemplates.cancel'),
    onPositiveClick: async () => {
      try {
        await removeChatApp(app.id)
        message.success(t('promptTemplates.appsDeleted'))
        await load()
      } catch (error) {
        message.error(error instanceof Error ? error.message : t('promptTemplates.appsDeleteFailed'))
      }
    },
  })
}

function appName(app: ChatAppDto): string {
  return app.text?.zh?.name || app.id
}
</script>

<template>
  <div class="chat-apps">
    <div class="chat-apps-toolbar">
      <span class="chat-apps-count">{{ t('promptTemplates.appsCount', { count: apps.length }) }}</span>
      <NButton size="small" type="primary" @click="openCreate">{{ t('promptTemplates.appsNew') }}</NButton>
    </div>

    <NSpin :show="loading && apps.length === 0">
      <div v-if="apps.length === 0" class="chat-apps-empty">
        <NEmpty :description="t('promptTemplates.appsEmpty')" />
      </div>
      <ul v-else class="chat-apps-list">
        <li v-for="app in apps" :key="app.id" class="chat-apps-item">
          <span class="chat-apps-icon" :style="{ background: app.tint || DEFAULT_TINT }" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
              stroke-linecap="round" stroke-linejoin="round">
              <path v-for="(path, index) in (app.iconPaths?.length ? app.iconPaths : DEFAULT_ICON)" :key="index" :d="path" />
            </svg>
          </span>
          <div class="chat-apps-main">
            <div class="chat-apps-head">
              <span class="chat-apps-name">{{ appName(app) }}</span>
              <NTag size="small" :bordered="false">
                {{ t('promptTemplates.appsScenes', { count: app.scenes?.length ?? 0 }) }}
              </NTag>
              <NTag v-if="app.enabled === false" size="small" :bordered="false" type="warning">
                {{ t('promptTemplates.disabled') }}
              </NTag>
            </div>
            <div class="chat-apps-desc">{{ app.text?.zh?.desc || app.id }}</div>
          </div>
          <div class="chat-apps-actions">
            <NSwitch
              size="small"
              :value="app.enabled !== false"
              :loading="enabledSaving === app.id"
              @update:value="(value: boolean) => toggleEnabled(app, value)"
            />
            <NButton size="tiny" quaternary @click="openEdit(app)">{{ t('promptTemplates.edit') }}</NButton>
            <NButton size="tiny" quaternary type="error" @click="confirmRemove(app)">
              {{ t('promptTemplates.delete') }}
            </NButton>
          </div>
        </li>
      </ul>
    </NSpin>

    <NModal
      v-model:show="showEditor"
      preset="card"
      :title="editorTitle"
      :mask-closable="false"
      style="width: min(760px, calc(100vw - 32px))"
    >
      <div class="chat-apps-form">
        <div class="chat-apps-row">
          <label class="chat-apps-field">
            <span class="chat-apps-label">{{ t('promptTemplates.appsId') }}</span>
            <NInput v-model:value="draft.id" size="small" :disabled="editingId !== null"
              :placeholder="t('promptTemplates.appsIdHint')" />
          </label>
          <label class="chat-apps-field chat-apps-field-narrow">
            <span class="chat-apps-label">{{ t('promptTemplates.appsSort') }}</span>
            <NInputNumber v-model:value="draft.sort" size="small" :min="0" />
          </label>
          <div class="chat-apps-field chat-apps-field-narrow">
            <span class="chat-apps-label">{{ t('promptTemplates.enabled') }}</span>
            <NSwitch v-model:value="draft.enabled" size="small" />
          </div>
        </div>

        <p class="chat-apps-section">{{ t('promptTemplates.appsZh') }}</p>
        <label class="chat-apps-field">
          <span class="chat-apps-label">{{ t('promptTemplates.appsName') }}</span>
          <NInput v-model:value="draft.zh.name" size="small" :maxlength="40" />
        </label>
        <label class="chat-apps-field">
          <span class="chat-apps-label">{{ t('promptTemplates.appsDesc') }}</span>
          <NInput v-model:value="draft.zh.desc" size="small" :maxlength="80" />
        </label>
        <div class="chat-apps-row">
          <label class="chat-apps-field">
            <span class="chat-apps-label">{{ t('promptTemplates.appsHeroTitle') }}</span>
            <NInput v-model:value="draft.zh.heroTitle" size="small" :maxlength="60" />
          </label>
          <label class="chat-apps-field">
            <span class="chat-apps-label">{{ t('promptTemplates.appsHeroSubtitle') }}</span>
            <NInput v-model:value="draft.zh.heroSubtitle" size="small" :maxlength="120" />
          </label>
        </div>
        <label class="chat-apps-field">
          <span class="chat-apps-label">{{ t('promptTemplates.appsPlaceholder') }}</span>
          <NInput v-model:value="draft.zh.placeholder" size="small" :maxlength="120" />
        </label>

        <p class="chat-apps-section">
          {{ t('promptTemplates.appsEn') }}
          <span class="chat-apps-hint">{{ t('promptTemplates.appsEnHint') }}</span>
        </p>
        <div class="chat-apps-row">
          <label class="chat-apps-field">
            <span class="chat-apps-label">{{ t('promptTemplates.appsName') }}</span>
            <NInput v-model:value="draft.en.name" size="small" :maxlength="40" />
          </label>
          <label class="chat-apps-field">
            <span class="chat-apps-label">{{ t('promptTemplates.appsDesc') }}</span>
            <NInput v-model:value="draft.en.desc" size="small" :maxlength="80" />
          </label>
        </div>
        <div class="chat-apps-row">
          <label class="chat-apps-field">
            <span class="chat-apps-label">{{ t('promptTemplates.appsHeroTitle') }}</span>
            <NInput v-model:value="draft.en.heroTitle" size="small" :maxlength="60" />
          </label>
          <label class="chat-apps-field">
            <span class="chat-apps-label">{{ t('promptTemplates.appsHeroSubtitle') }}</span>
            <NInput v-model:value="draft.en.heroSubtitle" size="small" :maxlength="120" />
          </label>
        </div>
        <label class="chat-apps-field">
          <span class="chat-apps-label">{{ t('promptTemplates.appsPlaceholder') }}</span>
          <NInput v-model:value="draft.en.placeholder" size="small" :maxlength="120" />
        </label>

        <div class="chat-apps-scenes-head">
          <p class="chat-apps-section">{{ t('promptTemplates.appsScenesTitle') }}</p>
          <NButton size="tiny" @click="addScene">{{ t('promptTemplates.appsSceneAdd') }}</NButton>
        </div>
        <p v-if="draft.scenes.length === 0" class="chat-apps-hint">
          {{ t('promptTemplates.appsScenesEmpty') }}
        </p>

        <div v-for="(scene, index) in draft.scenes" :key="index" class="chat-apps-scene">
          <div class="chat-apps-scene-head">
            <span class="chat-apps-scene-index">#{{ index + 1 }}</span>
            <NInput v-model:value="scene.id" size="tiny" class="chat-apps-scene-id"
              :placeholder="t('promptTemplates.appsSceneId')" />
            <NButton size="tiny" quaternary :disabled="index === 0" @click="moveScene(index, -1)">↑</NButton>
            <NButton size="tiny" quaternary :disabled="index === draft.scenes.length - 1"
              @click="moveScene(index, 1)">↓</NButton>
            <NButton size="tiny" quaternary type="error" @click="removeScene(index)">
              {{ t('promptTemplates.delete') }}
            </NButton>
          </div>

          <div class="chat-apps-row">
            <label class="chat-apps-field">
              <span class="chat-apps-label">{{ t('promptTemplates.appsSceneLabel') }} · 中文</span>
              <NInput v-model:value="scene.zhLabel" size="small" :maxlength="20" />
            </label>
            <label class="chat-apps-field">
              <span class="chat-apps-label">{{ t('promptTemplates.appsSceneLabel') }} · English</span>
              <NInput v-model:value="scene.enLabel" size="small" :maxlength="20" />
            </label>
          </div>
          <div class="chat-apps-row">
            <label class="chat-apps-field">
              <span class="chat-apps-label">{{ t('promptTemplates.appsScenePlaceholder') }} · 中文</span>
              <NInput v-model:value="scene.zhPlaceholder" size="small" :maxlength="120" />
            </label>
            <label class="chat-apps-field">
              <span class="chat-apps-label">{{ t('promptTemplates.appsScenePlaceholder') }} · English</span>
              <NInput v-model:value="scene.enPlaceholder" size="small" :maxlength="120" />
            </label>
          </div>

          <div class="chat-apps-prompts">
            <div class="chat-apps-prompts-head">
              <span class="chat-apps-label">{{ t('promptTemplates.appsPrompts') }}</span>
              <NButton size="tiny" quaternary @click="addPrompt(scene)">
                {{ t('promptTemplates.appsPromptAdd') }}
              </NButton>
            </div>
            <div v-for="(prompt, promptIndex) in scene.prompts" :key="promptIndex" class="chat-apps-prompt">
              <div class="chat-apps-prompt-head">
                <NInput v-model:value="prompt.label" size="small" class="chat-apps-prompt-label"
                  :placeholder="t('promptTemplates.appsPromptLabel')" :maxlength="20" />
                <NButton size="tiny" quaternary type="error" @click="removePrompt(scene, promptIndex)">×</NButton>
              </div>
              <NInput v-model:value="prompt.text" type="textarea" size="small"
                :autosize="{ minRows: 2, maxRows: 6 }" :placeholder="t('promptTemplates.appsPromptText')" />
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="chat-apps-footer">
          <NButton @click="showEditor = false">{{ t('promptTemplates.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="save">{{ t('promptTemplates.save') }}</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.chat-apps { display: flex; flex-direction: column; gap: 12px; }
.chat-apps-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.chat-apps-count { color: $text-secondary; font-size: 12.5px; }
.chat-apps-empty { padding: 40px 0; }

.chat-apps-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.chat-apps-item {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px; border: 1px solid $border-color; border-radius: $radius-md; background: $bg-card;
}
.chat-apps-icon {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 32px; height: 32px; border-radius: 9px; color: #fff;
}
.chat-apps-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.chat-apps-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chat-apps-name { color: $text-primary; font-size: 13.5px; font-weight: 550; }
.chat-apps-desc {
  color: $text-secondary; font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat-apps-actions { display: flex; align-items: center; gap: 6px; flex: none; }

.chat-apps-form { display: flex; flex-direction: column; gap: 10px; max-height: 62vh; overflow-y: auto; padding-right: 4px; }
.chat-apps-row { display: flex; gap: 12px; }
.chat-apps-row > .chat-apps-field { flex: 1; min-width: 0; }
.chat-apps-field { display: flex; flex-direction: column; gap: 4px; }
.chat-apps-field-narrow { flex: 0 0 120px; }
.chat-apps-label { color: $text-secondary; font-size: 12px; }
.chat-apps-hint { color: $text-muted; font-size: 11.5px; }
.chat-apps-section { margin: 6px 0 0; color: $text-primary; font-size: 13px; font-weight: 600; }

.chat-apps-scenes-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 6px; }
.chat-apps-scenes-head .chat-apps-section { margin: 0; }
.chat-apps-scene {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px; border: 1px solid $border-light; border-radius: $radius-md; background: rgba(var(--text-primary-rgb), 0.02);
}
.chat-apps-scene-head { display: flex; align-items: center; gap: 8px; }
.chat-apps-scene-index { color: $text-muted; font-size: 12px; }
.chat-apps-scene-id { width: 160px; }

.chat-apps-prompts { display: flex; flex-direction: column; gap: 6px; }
.chat-apps-prompts-head { display: flex; align-items: center; justify-content: space-between; }
.chat-apps-prompt { display: flex; flex-direction: column; gap: 4px; }
.chat-apps-prompt-head { display: flex; align-items: center; gap: 6px; }
.chat-apps-prompt-label { width: 220px; }

.chat-apps-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>

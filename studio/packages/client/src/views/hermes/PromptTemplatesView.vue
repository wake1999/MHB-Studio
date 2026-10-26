<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import ChatAppsManager from '@/components/hermes/prompt-templates/ChatAppsManager.vue'
import { computed, onMounted, ref } from 'vue'
import {
  NButton,
  NDropdown,
  NEmpty,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
  type DropdownOption,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { usePromptTemplatesStore } from '@/stores/hermes/prompt-templates'
import type { PromptTemplate, PromptTemplateDomain, PromptTemplateKind } from '@/api/studio/prompt-templates'
import { promptTemplateDomainFor, type PromptTemplateDomainId } from '@/utils/hermes/prompt-templates'

/**
 * Two levels, mirroring the composer: the first screen lists the categories as
 * cards (a category is a scene, e.g. 代码评审), and opening one shows the prompts
 * it holds — that is where they get renamed, reordered, switched off or deleted.
 */

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const store = usePromptTemplatesStore()

const search = ref('')
/** 两个页签：提示词模板（原有）与「发现应用」的应用目录。 */
const activeTab = ref<'prompts' | 'apps'>('prompts')
const showEditor = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
/** null = the category card grid; a string = that category's prompts ('' is uncategorised). */
const activeCategory = ref<string | null>(null)
const form = ref<{
  name: string
  category: string | null
  description: string
  kind: PromptTemplateKind
  content: string
  enabled: boolean
}>({
  name: '',
  category: '',
  description: '',
  kind: 'insert',
  content: '',
  enabled: true,
})

interface CategoryCard {
  category: string
  total: number
  enabled: number
  insert: number
  instruction: number
  preview: string[]
  /** Explicit surface of the category's rows ('' = automatic). */
  domain: PromptTemplateDomain
  /** Where automatic rows land, from the category-name words. */
  inferred: PromptTemplateDomainId | null
}

const categoryOptions = computed(() =>
  store.categories
    .filter(category => category !== '')
    .map(category => ({ label: category, value: category })),
)

const kindOptions = computed(() => [
  { label: t('promptTemplates.kindInsert'), value: 'insert' },
  { label: t('promptTemplates.kindInstruction'), value: 'instruction' },
])

function matchesQuery(template: PromptTemplate, query: string): boolean {
  return template.name.toLowerCase().includes(query)
    || template.description.toLowerCase().includes(query)
    || template.content.toLowerCase().includes(query)
}

/** One card per category, in shelf order; a search narrows the cards too. */
const categoryCards = computed<CategoryCard[]>(() => {
  const query = search.value.trim().toLowerCase()
  const byCategory = new Map<string, PromptTemplate[]>()
  for (const template of store.templates) {
    const list = byCategory.get(template.category)
    if (list) list.push(template)
    else byCategory.set(template.category, [template])
  }

  const cards: CategoryCard[] = []
  for (const [category, templates] of byCategory) {
    if (query && !category.toLowerCase().includes(query) && !templates.some(item => matchesQuery(item, query))) continue
    const explicit = Array.from(new Set(templates.map(template => template.domain || '')))
    cards.push({
      category,
      total: templates.length,
      enabled: templates.filter(template => template.enabled).length,
      insert: templates.filter(template => template.kind === 'insert').length,
      instruction: templates.filter(template => template.kind === 'instruction').length,
      preview: templates.slice(0, 3).map(template => template.name),
      // Mixed rows inside one category read as automatic until they agree again.
      domain: explicit.length === 1 ? explicit[0] : '',
      inferred: promptTemplateDomainFor(category),
    })
  }
  return cards
})

/** Prompts of the opened category, narrowed by the search box. */
const categoryTemplates = computed(() => {
  if (activeCategory.value === null) return []
  const query = search.value.trim().toLowerCase()
  return store.templates.filter(template =>
    template.category === activeCategory.value
    && (!query || matchesQuery(template, query)),
  )
})

const activeCategoryCard = computed(() =>
  categoryCards.value.find(card => card.category === activeCategory.value)
  ?? {
    category: activeCategory.value ?? '',
    total: store.templates.filter(template => template.category === activeCategory.value).length,
    enabled: store.templates.filter(template => template.category === activeCategory.value && template.enabled).length,
    insert: 0,
    instruction: 0,
    preview: [],
  },
)

/** 显示位置：自动（按分类名判断）/ 对话 / 创造 —— 决定胶囊出现在哪一侧。 */
const domainSaving = ref('')

const domainOptions = computed<DropdownOption[]>(() => [
  { label: t('promptTemplates.domainAutoHint'), key: '__auto__' },
  { label: t('promptTemplates.domainChat'), key: 'chat' },
  { label: t('promptTemplates.domainCreate'), key: 'create' },
])

function cardDomainLabel(card: CategoryCard): string {
  if (card.domain === 'chat') return t('promptTemplates.domainChat')
  if (card.domain === 'create') return t('promptTemplates.domainCreate')
  if (card.inferred === 'chat') return `${t('promptTemplates.domainAuto')} · ${t('promptTemplates.domainChat')}`
  if (card.inferred === 'create') return `${t('promptTemplates.domainAuto')} · ${t('promptTemplates.domainCreate')}`
  return t('promptTemplates.domainAuto')
}

/** The choice belongs to the whole category, so every row in it is updated. */
async function setCardDomain(card: CategoryCard, key: string) {
  const domain: PromptTemplateDomain = key === 'chat' || key === 'create' ? key : ''
  if (domain === card.domain || domainSaving.value) return
  domainSaving.value = card.category
  try {
    for (const template of store.templates.filter(item => item.category === card.category)) {
      if ((template.domain || '') === domain) continue
      await store.update(template.id, { domain })
    }
    message.success(t('promptTemplates.domainSaved'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('promptTemplates.saveFailed'))
  } finally {
    domainSaving.value = ''
  }
}

const insertCount = computed(() => store.templates.filter(template => template.kind === 'insert').length)
const instructionCount = computed(() => store.templates.filter(template => template.kind === 'instruction').length)

onMounted(() => {
  void loadTemplates()
})

async function loadTemplates() {
  try {
    await store.load(true)
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('promptTemplates.loadFailed'))
  }
}

function openCategory(category: string) {
  search.value = ''
  activeCategory.value = category
}

/** Creating from inside a category presets it, so the new prompt lands there. */
function openCreate(category: string | null = null) {
  editingId.value = null
  form.value = { name: '', category: category ?? '', description: '', kind: 'insert', content: '', enabled: true }
  showEditor.value = true
}

function openEdit(template: PromptTemplate) {
  editingId.value = template.id
  form.value = {
    name: template.name,
    category: template.category,
    description: template.description,
    kind: template.kind,
    content: template.content,
    enabled: template.enabled,
  }
  showEditor.value = true
}

async function save() {
  const name = form.value.name.trim()
  const content = form.value.content.trim()
  if (!name) {
    message.warning(t('promptTemplates.nameRequired'))
    return
  }
  if (!content) {
    message.warning(t('promptTemplates.contentRequired'))
    return
  }
  saving.value = true
  try {
    const payload = {
      name,
      category: (form.value.category || '').trim(),
      description: form.value.description.trim(),
      kind: form.value.kind,
      content,
      enabled: form.value.enabled,
    }
    if (editingId.value === null) await store.create(payload)
    else await store.update(editingId.value, payload)
    showEditor.value = false
    message.success(t('promptTemplates.saved'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('promptTemplates.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(template: PromptTemplate, enabled: boolean) {
  try {
    await store.setEnabled(template.id, enabled)
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('promptTemplates.enableFailed'))
  }
}

function confirmRemove(template: PromptTemplate) {
  dialog.warning({
    title: t('promptTemplates.delete'),
    content: t('promptTemplates.deleteConfirm', { name: template.name }),
    positiveText: t('promptTemplates.delete'),
    negativeText: t('promptTemplates.cancel'),
    onPositiveClick: async () => {
      try {
        await store.remove(template.id)
        message.success(t('promptTemplates.deleted'))
      } catch (error) {
        message.error(error instanceof Error ? error.message : t('promptTemplates.deleteFailed'))
      }
    },
  })
}

/** Reorder inside the category, so the composer cards follow the author's intent. */
async function moveTemplate(template: PromptTemplate, direction: 'up' | 'down') {
  try {
    await store.move(template.id, direction)
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('promptTemplates.moveFailed'))
  }
}

/** A prompt can only move within its own category shelf. */
function canMove(template: PromptTemplate, direction: 'up' | 'down'): boolean {
  const siblings = store.templates.filter(item => item.category === template.category)
  const index = siblings.findIndex(item => item.id === template.id)
  if (index === -1 || siblings.length < 2) return false
  return direction === 'up' ? index > 0 : index < siblings.length - 1
}

function preview(template: PromptTemplate): string {
  const flat = template.content.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}
</script>

<template>
  <div class="prompt-templates-view">
  <PageHeader>
    <header class="page-header">
      <div class="prompt-templates-heading">
        <h2 class="header-title">{{ t('promptTemplates.title') }}</h2>
        <span class="prompt-templates-counts">
          {{ t('promptTemplates.counts', { insert: insertCount, instruction: instructionCount }) }}
        </span>
      </div>
      <div class="header-actions">
        <NInput
          v-if="activeTab === 'prompts'"
          v-model:value="search"
          :placeholder="t('promptTemplates.searchPlaceholder')"
          size="small"
          clearable
          style="width: 160px"
        />
        <NButton
          v-if="activeTab === 'prompts'"
          class="header-action-btn"
          size="small"
          type="primary"
          @click="openCreate(activeCategory)"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </template>
          <span class="header-action-label">{{ t('promptTemplates.newTemplate') }}</span>
        </NButton>
      </div>
    </header>
  </PageHeader>

  <div class="prompt-templates-tabs" role="tablist">
    <button
      type="button"
      role="tab"
      class="prompt-templates-tab"
      :class="{ 'prompt-templates-tab-active': activeTab === 'prompts' }"
      :aria-selected="activeTab === 'prompts'"
      @click="activeTab = 'prompts'"
    >
      {{ t('promptTemplates.tabPrompts') }}
    </button>
    <button
      type="button"
      role="tab"
      class="prompt-templates-tab"
      :class="{ 'prompt-templates-tab-active': activeTab === 'apps' }"
      :aria-selected="activeTab === 'apps'"
      @click="activeTab = 'apps'"
    >
      {{ t('promptTemplates.tabApps') }}
    </button>
  </div>

  <div v-if="activeTab === 'prompts'" class="prompt-templates-content">
    <NSpin :show="store.loading && store.templates.length === 0">
      <!-- Level 1: the categories, one card each. -->
      <template v-if="activeCategory === null">
        <div v-if="categoryCards.length === 0" class="prompt-templates-empty">
          <NEmpty :description="store.templates.length === 0 ? t('promptTemplates.emptyHint') : t('promptTemplates.noMatch')" />
        </div>
        <div v-else class="prompt-templates-cards">
          <!-- A card opens the category; the surface picker sits inside it, so the
               card is a div with a button role rather than a <button>. -->
          <div
            v-for="card in categoryCards"
            :key="card.category || '__uncategorized__'"
            class="prompt-templates-card"
            role="button"
            tabindex="0"
            @click="openCategory(card.category)"
            @keydown.enter="openCategory(card.category)"
            @keydown.space.prevent="openCategory(card.category)"
          >
            <div class="prompt-templates-card-head">
              <span class="prompt-templates-card-name">{{ card.category || t('promptTemplates.uncategorized') }}</span>
              <NTag v-if="card.insert" size="small" :bordered="false">{{ t('promptTemplates.kindInsert') }}</NTag>
              <NTag v-if="card.instruction" size="small" :bordered="false" type="info">
                {{ t('promptTemplates.kindInstruction') }}
              </NTag>
              <NDropdown
                trigger="click"
                placement="bottom-end"
                :options="domainOptions"
                @select="(key: string) => setCardDomain(card, key)"
              >
                <span
                  class="prompt-templates-card-domain"
                  :class="{ 'prompt-templates-card-domain-set': card.domain !== '' }"
                  :title="t('promptTemplates.domainLabel')"
                  @click.stop
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="5" width="8" height="14" rx="1.6" />
                    <rect x="14" y="5" width="7" height="14" rx="1.6" opacity="0.45" />
                  </svg>
                  {{ cardDomainLabel(card) }}
                </span>
              </NDropdown>
            </div>
            <div class="prompt-templates-card-counts">
              {{ t('promptTemplates.categoryCounts', { total: card.total, enabled: card.enabled }) }}
            </div>
            <div class="prompt-templates-card-preview">{{ card.preview.join(' · ') }}</div>
          </div>
        </div>
      </template>

      <!-- Level 2: the prompts of the opened category. -->
      <template v-else>
        <div class="prompt-templates-crumb">
          <NButton size="tiny" quaternary @click="activeCategory = null">
            ← {{ t('promptTemplates.allCategories') }}
          </NButton>
          <span class="prompt-templates-crumb-name">
            {{ activeCategory || t('promptTemplates.uncategorized') }}
          </span>
          <span class="prompt-templates-counts">
            {{ t('promptTemplates.categoryCounts', { total: activeCategoryCard.total, enabled: activeCategoryCard.enabled }) }}
          </span>
          <NButton class="prompt-templates-crumb-action" size="small" type="primary" @click="openCreate(activeCategory)">
            {{ t('promptTemplates.newTemplate') }}
          </NButton>
        </div>

        <div v-if="categoryTemplates.length === 0" class="prompt-templates-empty">
          <NEmpty :description="t('promptTemplates.noMatch')" />
        </div>
        <ul v-else class="prompt-templates-list">
          <li v-for="template in categoryTemplates" :key="template.id" class="prompt-templates-item">
            <div class="prompt-templates-item-main">
              <div class="prompt-templates-item-head">
                <span class="prompt-templates-item-name">{{ template.name }}</span>
                <NTag size="small" :bordered="false" :type="template.kind === 'instruction' ? 'info' : 'default'">
                  {{ template.kind === 'instruction' ? t('promptTemplates.kindInstruction') : t('promptTemplates.kindInsert') }}
                </NTag>
                <NTag v-if="!template.enabled" size="small" :bordered="false" type="warning">
                  {{ t('promptTemplates.disabled') }}
                </NTag>
              </div>
              <div v-if="template.description" class="prompt-templates-item-desc">{{ template.description }}</div>
              <div class="prompt-templates-item-preview">{{ preview(template) }}</div>
            </div>
            <div class="prompt-templates-item-actions">
              <NButton
                size="tiny"
                quaternary
                :disabled="!canMove(template, 'up')"
                :title="t('promptTemplates.moveUp')"
                :aria-label="t('promptTemplates.moveUp')"
                @click="moveTemplate(template, 'up')"
              >
                ↑
              </NButton>
              <NButton
                size="tiny"
                quaternary
                :disabled="!canMove(template, 'down')"
                :title="t('promptTemplates.moveDown')"
                :aria-label="t('promptTemplates.moveDown')"
                @click="moveTemplate(template, 'down')"
              >
                ↓
              </NButton>
              <NSwitch
                size="small"
                :value="template.enabled"
                @update:value="(value: boolean) => toggleEnabled(template, value)"
              />
              <NButton size="tiny" quaternary @click="openEdit(template)">
                {{ t('promptTemplates.edit') }}
              </NButton>
              <NButton size="tiny" quaternary type="error" @click="confirmRemove(template)">
                {{ t('promptTemplates.delete') }}
              </NButton>
            </div>
          </li>
        </ul>
      </template>
    </NSpin>
  </div>
  <ChatAppsManager v-else class="prompt-templates-apps" />

  <NModal
    v-model:show="showEditor"
    preset="card"
    :title="editingId === null ? t('promptTemplates.newTemplate') : t('promptTemplates.editTemplate')"
    :mask-closable="false"
    style="width: min(640px, calc(100vw - 32px))"
  >
    <div class="prompt-templates-form">
      <label class="prompt-templates-field">
        <span class="prompt-templates-label">{{ t('promptTemplates.name') }}</span>
        <NInput
          v-model:value="form.name"
          :placeholder="t('promptTemplates.namePlaceholder')"
          :maxlength="60"
          show-count
        />
      </label>
      <label class="prompt-templates-field">
        <span class="prompt-templates-label">{{ t('promptTemplates.category') }}</span>
        <NSelect
          v-model:value="form.category"
          :options="categoryOptions"
          :placeholder="t('promptTemplates.categoryPlaceholder')"
          filterable
          tag
          clearable
        />
      </label>
      <label class="prompt-templates-field">
        <span class="prompt-templates-label">{{ t('promptTemplates.description') }}</span>
        <NInput
          v-model:value="form.description"
          :placeholder="t('promptTemplates.descriptionPlaceholder')"
          :maxlength="200"
        />
      </label>
      <label class="prompt-templates-field">
        <span class="prompt-templates-label">{{ t('promptTemplates.kind') }}</span>
        <NSelect v-model:value="form.kind" :options="kindOptions" />
        <span class="prompt-templates-hint">
          {{ form.kind === 'instruction' ? t('promptTemplates.kindInstructionHint') : t('promptTemplates.kindInsertHint') }}
        </span>
      </label>
      <label class="prompt-templates-field">
        <span class="prompt-templates-label">{{ t('promptTemplates.content') }}</span>
        <NInput
          v-model:value="form.content"
          type="textarea"
          :placeholder="t('promptTemplates.contentPlaceholder')"
          :autosize="{ minRows: 8, maxRows: 20 }"
        />
      </label>
      <div class="prompt-templates-field prompt-templates-field-row">
        <span class="prompt-templates-label">{{ t('promptTemplates.enabled') }}</span>
        <NSwitch v-model:value="form.enabled" />
        <span class="prompt-templates-hint">{{ t('promptTemplates.enabledHint') }}</span>
      </div>
    </div>
    <template #footer>
      <div class="prompt-templates-footer">
        <NButton @click="showEditor = false">{{ t('promptTemplates.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="save">{{ t('promptTemplates.save') }}</NButton>
      </div>
    </template>
  </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.prompt-templates-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 页签：提示词模板 / 应用。和页头、内容区一起构成这页的三段。 */
.prompt-templates-tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 16px 0;
  border-bottom: 1px solid $border-color;
}

.prompt-templates-tab {
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: $text-secondary;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: color $transition-fast, border-color $transition-fast;

  &:hover { color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}

.prompt-templates-tab-active,
.prompt-templates-tab-active:hover {
  color: $text-primary;
  border-bottom-color: $accent-primary;
  font-weight: 550;
}

.prompt-templates-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.prompt-templates-counts {
  font-size: 12px;
  opacity: 0.6;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prompt-templates-content {
  flex: 1 1 auto;
  padding: 16px;
  min-height: 0;
  overflow: auto;
}

/* 「应用」页签的内容是子组件根元素，这里只负责占满剩余高度并自行滚动。 */
.prompt-templates-apps {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.prompt-templates-empty {
  padding: 48px 0;
}

/* Level 1 — one card per category. */
.prompt-templates-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}

.prompt-templates-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 14px;
  border: 1px solid rgba(128, 128, 128, 0.22);
  border-radius: 10px;
  background: transparent;
  color: inherit;
  text-align: start;
  cursor: pointer;
  transition: border-color $transition-fast, background $transition-fast;

  &:hover {
    border-color: $accent-primary;
  }
}

.prompt-templates-card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

/* 显示位置: which composer surface this category's pills show on. */
.prompt-templates-card-domain {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-inline-start: auto;
  padding: 2px 8px;
  border: 1px solid rgba(128, 128, 128, 0.28);
  border-radius: 999px;
  color: $text-secondary;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;

  &:hover {
    border-color: $accent-primary;
    color: $text-primary;
  }
}

.prompt-templates-card-domain-set {
  border-color: rgba(88, 148, 255, 0.55);
  color: $accent-primary;
}

.prompt-templates-card-name {
  font-weight: 600;
}

.prompt-templates-card-counts {
  font-size: 12px;
  opacity: 0.6;
}

.prompt-templates-card-preview {
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.75;
  word-break: break-word;
}

/* Level 2 — the prompts inside the opened category. */
.prompt-templates-crumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}

.prompt-templates-crumb-name {
  font-weight: 600;
}

.prompt-templates-crumb-action {
  margin-inline-start: auto;
}

.prompt-templates-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prompt-templates-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid rgba(128, 128, 128, 0.22);
  border-radius: 10px;
}

.prompt-templates-item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.prompt-templates-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.prompt-templates-item-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prompt-templates-item-desc {
  font-size: 12px;
  opacity: 0.75;
}

.prompt-templates-item-preview {
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.6;
  word-break: break-word;
}

.prompt-templates-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.prompt-templates-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.prompt-templates-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.prompt-templates-field-row {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}

.prompt-templates-label {
  font-size: 13px;
  font-weight: 500;
}

.prompt-templates-hint {
  font-size: 12px;
  opacity: 0.6;
}

.prompt-templates-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: $breakpoint-mobile) {
  .header-action-label,
  .prompt-templates-counts {
    display: none;
  }

  .prompt-templates-item {
    flex-direction: column;
  }
}
</style>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/hermes/chat'
import { usePromptTemplatesStore } from '@/stores/hermes/prompt-templates'
import { INSERT_PROMPT_TEMPLATE_EVENT } from '@/utils/hermes/prompt-templates'
import type { PromptTemplate } from '@/api/studio/prompt-templates'

/**
 * The prompt template library as a tab of the chat tool panel (right column).
 * Same shelf order as the composer strip: kind → category → author order.
 * `insert` templates fill the composer, `instruction` templates are switched on
 * for the current session.
 */

const { t } = useI18n()
const router = useRouter()
const chatStore = useChatStore()
const store = usePromptTemplatesStore()

const search = ref('')

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return store.enabledTemplates
  return store.enabledTemplates.filter(template =>
    template.name.toLowerCase().includes(query)
    || template.category.toLowerCase().includes(query)
    || template.description.toLowerCase().includes(query)
    || template.content.toLowerCase().includes(query),
  )
})

const insertGroups = computed(() => groupTemplates(filtered.value.filter(template => template.kind === 'insert')))
const instructionGroups = computed(() => groupTemplates(filtered.value.filter(template => template.kind === 'instruction')))
const hasTemplates = computed(() => store.templates.length > 0)

/** Author order, grouped by category. */
function groupTemplates(list: PromptTemplate[]) {
  const groups: { category: string; templates: PromptTemplate[] }[] = []
  for (const template of list) {
    const last = groups[groups.length - 1]
    if (last && last.category === template.category) last.templates.push(template)
    else groups.push({ category: template.category, templates: [template] })
  }
  return groups
}

onMounted(() => {
  void store.ensureLoaded()
})

async function reload() {
  try {
    await store.load(true)
  } catch {
    /* The error state below stays visible. */
  }
}

function insertTemplate(template: PromptTemplate) {
  // The id lets the composer treat a second click as "unpick" instead of pasting twice.
  window.dispatchEvent(new CustomEvent(INSERT_PROMPT_TEMPLATE_EVENT, {
    detail: { id: template.id, content: template.content },
  }))
}

function toggleTemplate(template: PromptTemplate) {
  store.toggleInstruction(chatStore.activeSessionId, template.id)
}

function isInstructionActive(template: PromptTemplate): boolean {
  return store.isInstructionActive(chatStore.activeSessionId, template.id)
}

function openManager() {
  void router.push({ name: 'hermes.promptTemplates' })
}
</script>

<template>
  <div class="prompt-templates-panel">
    <div class="prompt-templates-panel__head">
      <input
        v-model="search"
        class="prompt-templates-panel__search"
        type="search"
        :placeholder="t('promptTemplates.searchPlaceholder')"
      >
    </div>

    <div class="prompt-templates-panel__body">
      <NSpin :show="store.loading && !hasTemplates">
        <div v-if="store.loadError && !hasTemplates" class="prompt-templates-panel__error">
          <span>{{ t('promptTemplates.loadFailed') }}</span>
          <NButton size="tiny" quaternary @click="reload">{{ t('promptTemplates.retry') }}</NButton>
        </div>
        <div v-else-if="!hasTemplates" class="prompt-templates-panel__empty">
          {{ t('promptTemplates.emptyHint') }}
        </div>
        <template v-else>
          <div v-if="store.loadError" class="prompt-templates-panel__error">
            <span>{{ t('promptTemplates.loadFailed') }}</span>
            <NButton size="tiny" quaternary @click="reload">{{ t('promptTemplates.retry') }}</NButton>
          </div>
          <div v-if="filtered.length === 0" class="prompt-templates-panel__empty">
            {{ t('promptTemplates.noMatch') }}
          </div>

          <section v-if="insertGroups.length > 0" class="prompt-templates-panel__section">
            <div class="prompt-templates-panel__kind">{{ t('promptTemplates.kindInsert') }}</div>
            <template v-for="group in insertGroups" :key="`insert-${group.category}`">
              <div
                v-if="insertGroups.length > 1 || group.category"
                class="prompt-templates-panel__section-title"
              >
                {{ group.category || t('promptTemplates.uncategorized') }}
              </div>
              <button
                v-for="template in group.templates"
                :key="template.id"
                type="button"
                class="prompt-templates-panel__item"
                @click="insertTemplate(template)"
              >
                <span class="prompt-templates-panel__name">{{ template.name }}</span>
                <span v-if="template.description" class="prompt-templates-panel__desc">{{ template.description }}</span>
              </button>
            </template>
          </section>

          <section v-if="instructionGroups.length > 0" class="prompt-templates-panel__section">
            <div class="prompt-templates-panel__kind">{{ t('promptTemplates.kindInstruction') }}</div>
            <template v-for="group in instructionGroups" :key="`instruction-${group.category}`">
              <div
                v-if="instructionGroups.length > 1 || group.category"
                class="prompt-templates-panel__section-title"
              >
                {{ group.category || t('promptTemplates.uncategorized') }}
              </div>
              <button
                v-for="template in group.templates"
                :key="template.id"
                type="button"
                class="prompt-templates-panel__item"
                :class="{ active: isInstructionActive(template) }"
                @click="toggleTemplate(template)"
              >
                <span class="prompt-templates-panel__name">{{ template.name }}</span>
                <span v-if="template.description" class="prompt-templates-panel__desc">{{ template.description }}</span>
                <span class="prompt-templates-panel__state">
                  {{ isInstructionActive(template) ? t('promptTemplates.instructionOn') : t('promptTemplates.instructionOff') }}
                </span>
              </button>
            </template>
          </section>
        </template>
      </NSpin>
    </div>

    <div class="prompt-templates-panel__foot">
      <NButton size="tiny" quaternary @click="openManager">
        {{ t('promptTemplates.manage') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.prompt-templates-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.prompt-templates-panel__head {
  padding: 10px 12px 6px;
}

.prompt-templates-panel__search {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  outline: none;

  &:focus { border-color: $accent-primary; }
}

.prompt-templates-panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 12px 12px;
}

.prompt-templates-panel__section + .prompt-templates-panel__section { margin-top: 10px; }

.prompt-templates-panel__kind {
  margin: 8px 0 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: $text-secondary;
}

.prompt-templates-panel__section-title {
  margin: 6px 0;
  font-size: 11px;
  color: $text-muted;
}

.prompt-templates-panel__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  margin-bottom: 6px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: rgba(128, 128, 128, 0.08);
  color: inherit;
  text-align: start;
  cursor: pointer;

  &:hover { border-color: $accent-primary; }
  &.active { border-color: $accent-primary; }
}

.prompt-templates-panel__name {
  font-size: 13px;
  line-height: 18px;
  color: $text-primary;
}

.prompt-templates-panel__desc {
  font-size: 11px;
  line-height: 15px;
  color: $text-secondary;
}

.prompt-templates-panel__state {
  font-size: 11px;
  line-height: 14px;
  color: $text-muted;
}

.prompt-templates-panel__empty {
  padding: 24px 8px;
  text-align: center;
  color: $text-muted;
  font-size: 12px;
  line-height: 18px;
}

.prompt-templates-panel__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.35);
  border-radius: 8px;
  color: $text-secondary;
  font-size: 12px;
}

.prompt-templates-panel__foot {
  display: flex;
  justify-content: center;
  padding: 6px 12px 10px;
  border-top: 1px solid rgba(128, 128, 128, 0.18);
}
</style>

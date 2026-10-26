<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NDrawer, NDrawerContent, NDropdown, NEmpty, NInput, NModal, NSelect, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'

import { toggleEkkoSkill } from '@/api/ekko/skills'
import SkillDetail from '@/components/hermes/skills/SkillDetail.vue'
import SkillImportModal from '@/components/hermes/skills/SkillImportModal.vue'
import {
  createSkillCategory,
  deleteSkillApi,
  deleteSkillCategory,
  fetchInstalledSkillTargets,
  fetchSkillCategories,
  fetchSkills,
  toggleSkill,
  toggleSkillsBatch,
  type SkillCategory,
  type SkillCategoryInfo,
  type SkillInfo,
  type SkillSource,
  type SkillTarget,
} from '@/api/hermes/skills'
import {
  installSkillsMarketEntry,
  searchSkillsMarket,
  translateSkillsMarket,
  type SkillsMarketEntry,
} from '@/api/hermes/skills-market'

/** One entry per installed skill; the owning category and agent are kept for the detail drawer. */
interface MarketSkill extends SkillInfo {
  category: string
  agent: SkillTarget
}

type MarketTab = 'discover' | 'favorites' | 'installed'

interface CategoryBucket {
  id: string
  count: number
}

const FAVORITES_KEY = 'skill-market-favorites-v2'
const SEARCH_DEBOUNCE_MS = 400
const PAGE_STEP = 24

const { t, te } = useI18n()
const message = useMessage()
const dialog = useDialog()

const loading = ref(true)
const error = ref('')
const query = ref('')
const source = ref('')
const category = ref('')
const activeTab = ref<MarketTab>('discover')
const showImport = ref(false)
const detail = ref<MarketSkill | null>(null)
const toggling = ref<Set<string>>(new Set())
const removing = ref<Set<string>>(new Set())
const favorites = ref<SkillsMarketEntry[]>(readFavorites())

const marketSkills = ref<SkillsMarketEntry[]>([])
const marketPage = ref(1)
const marketTotal = ref(0)
const marketHasNext = ref(false)
const marketLoading = ref(true)
const marketLoadingMore = ref(false)
const marketError = ref('')
const marketCategory = ref('')
const visibleCount = ref(PAGE_STEP)
const installing = ref<Set<string>>(new Set())
const translating = ref(false)

/** Category folders under the skills root; the installer writes `<category>/<name>`. */
const categoryDirs = ref<SkillCategoryInfo[]>([])
const installTarget = ref<SkillsMarketEntry | null>(null)
const showInstallPicker = ref(false)
/** Empty string means the global skills root. */
const installCategory = ref<string>('')
/** Skill tree that receives the package; the MedHealthBuddy Agent is the default. */
const installAgent = ref<SkillTarget>('ekko')
const showCategoryDialog = ref(false)
const newCategoryName = ref('')
const creatingCategory = ref(false)

const SOURCES: SkillSource[] = ['builtin', 'hub', 'local', 'external']
/** Product agent first; other agents join once the availability snapshot says they are installed. */
const agentTargets = ref<SkillTarget[]>(['ekko', 'hermes'])
const agentCategories = ref<Partial<Record<SkillTarget, SkillCategory[]>>>({})
const loadedAgents = ref<SkillTarget[]>([])
/** Agent section shown in the installed tab; the product agent is the default view. */
const installedAgent = ref<SkillTarget>('ekko')
let searchDebounce: ReturnType<typeof setTimeout> | undefined

function readFavorites(): SkillsMarketEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item: any) => item && typeof item.name === 'string') : []
  } catch {
    return []
  }
}

function persistFavorites() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites.value))
  } catch {
    // Private windows may refuse storage; favorites then live for this session only.
  }
}

const allSkills = computed<MarketSkill[]>(() => {
  // Agent homes overlap heavily (shared skill dirs), so each name is listed once,
  // under the first agent in AGENT_TARGETS order that owns it.
  const seen = new Set<string>()
  const merged: MarketSkill[] = []
  for (const agent of loadedAgents.value) {
    for (const cat of agentCategories.value[agent] || []) {
      for (const skill of cat.skills || []) {
        if (seen.has(skill.name)) continue
        seen.add(skill.name)
        merged.push({ ...skill, category: cat.name, agent })
      }
    }
  }
  return merged
})

const installedNames = computed(() => new Set(allSkills.value.map(skill => skill.name)))

/** Skills of one agent, deduped inside that agent only — the sections must stay separate. */
function skillsForAgent(agent: SkillTarget): MarketSkill[] {
  const seen = new Set<string>()
  const list: MarketSkill[] = []
  for (const cat of agentCategories.value[agent] || []) {
    for (const skill of cat.skills || []) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      list.push({ ...skill, category: cat.name, agent })
    }
  }
  return list
}

/** One entry per agent that actually owns skills, product agent first. */
const agentSections = computed(() => agentTargets.value
  .map(agent => ({ agent, skills: skillsForAgent(agent) }))
  .filter(section => section.skills.length > 0))

/** The installed tab manages one agent at a time; 发现/收藏 keep the global name set. */
const agentSkills = computed(
  () => agentSections.value.find(section => section.agent === installedAgent.value)?.skills || [],
)
const agentEnabledCount = computed(() => agentSkills.value.filter(skill => skill.enabled !== false).length)

/** Installs are keyed by slug, so match either the local directory name or the slug. */
function installedKey(entry: SkillsMarketEntry) {
  return entry.slug || entry.name
}

/** Skills installed during this session, kept because the local name may differ from the slug. */
const installedSlugs = ref<Set<string>>(new Set())

function isInstalled(entry: SkillsMarketEntry) {
  if (installedNames.value.has(entry.name)) return true
  if (entry.slug && installedNames.value.has(entry.slug)) return true
  return installedSlugs.value.has(installedKey(entry))
}

const CUSTOM_SOURCE_PREFIX = 'custom:'

/** Folders the user created from this page; the server marks them in its category list. */
const customCategoryNames = computed(
  () => new Set(categoryDirs.value.filter(item => item.custom).map(item => item.name)),
)

const isCustomDir = (dir: string) => customCategoryNames.value.has(dir || 'misc')

/**
 * 「全部来源」 lists the provenance buckets that actually hold skills plus every
 * self-made category — empty buckets (技能仓库 / 外部目录) would be dead options.
 */
const sourceOptions = computed(() => {
  const present = new Set(agentSkills.value.map(skill => (isCustomDir(skill.category) ? '' : skill.source || 'local')))
  return [
    { label: t('skillMarket.allSources'), value: '' },
    ...SOURCES.filter(item => present.has(item)).map(item => ({ label: t(`skillMarket.source.${item}`), value: item })),
    ...categoryDirs.value
      .filter(item => item.custom)
      .map(item => ({ label: item.name, value: `${CUSTOM_SOURCE_PREFIX}${item.name}` })),
  ]
})

/**
 * A self-made category narrows by directory. A provenance bucket excludes those
 * folders too: their skills belong to that category's own group, not to 全局.
 */
function matchesSource(skill: MarketSkill) {
  const filter = source.value
  if (!filter) return true
  if (filter.startsWith(CUSTOM_SOURCE_PREFIX)) {
    return (skill.category || 'misc') === filter.slice(CUSTOM_SOURCE_PREFIX.length)
  }
  if (isCustomDir(skill.category)) return false
  return (skill.source || 'local') === filter
}

function agentLabel(agent: SkillTarget) {
  return t(`skillMarket.agents.${agent}`)
}

const categoryOptions = computed(() => {
  const names = new Set(agentSkills.value.map(skill => skill.category).filter(Boolean))
  return [
    { label: t('skillMarket.allCategories'), value: '' },
    ...[...names]
      .map(name => ({ label: categoryLabelForList(name), value: name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]
})

function matchesKeyword(
  entry: { name?: string; author?: string; description?: string; category?: string; scenes?: string[] },
  keyword: string,
) {
  if (!keyword) return true
  return [entry.name, entry.author, entry.description, entry.category, ...(entry.scenes || [])]
    .some(field => (field || '').toLowerCase().includes(keyword))
}

const filteredLocal = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return agentSkills.value.filter(skill => {
    if (!matchesSource(skill)) return false
    if (category.value && skill.category !== category.value) return false
    return matchesKeyword(skill, keyword)
  })
})

interface InstalledGroup {
  /** A provenance bucket (`builtin` …) or `custom:<dir>` for a self-made category. */
  key: string
  label: string
  custom: boolean
  skills: MarketSkill[]
}

/**
 * Directory names under a skills home are English slugs; built-in dirs use the
 * catalog labels, install-time auto folders reuse the market category names,
 * and self-made folders (`测试`, `ops-test`) keep their own name.
 * `misc` is the bucket the scanner builds for skills sitting at the root.
 */
function categoryLabelForList(name: string) {
  if (!name || name === 'misc') return t('skillMarket.uncategorized')
  for (const key of [`skillMarket.catLabels.${name}`, `skillMarket.cats.${name}`]) {
    if (te(key)) return t(key)
  }
  return name
}

/** Groups start collapsed so the installed tab reads as a one-screen index. */
const expandedGroups = ref<Set<string>>(new Set())

/** A keyword or directory filter opens every group — collapsed rows would hide the hits. */
const groupsForcedOpen = computed(() => query.value.trim() !== '' || category.value !== '')

function groupOpen(key: string) {
  return groupsForcedOpen.value || expandedGroups.value.has(key)
}

function toggleGroup(key: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedGroups.value = next
}

/**
 * Installed skills are grouped by big category: the four provenance buckets plus
 * one group per self-made category folder, which shows up even while still empty.
 */
const groupedLocal = computed<InstalledGroup[]>(() => {
  const customNames = customCategoryNames.value
  const byKey = new Map<string, MarketSkill[]>()
  for (const skill of filteredLocal.value) {
    const dir = skill.category || 'misc'
    const key = customNames.has(dir) ? `custom:${dir}` : (skill.source || 'local')
    const list = byKey.get(key)
    if (list) list.push(skill)
    else byKey.set(key, [skill])
  }

  const byDirThenName = (skills: MarketSkill[]) =>
    [...skills].sort((a, b) =>
      (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))

  const groups: InstalledGroup[] = []
  for (const sourceKey of SOURCES) {
    const skills = byKey.get(sourceKey)
    if (skills?.length) {
      groups.push({
        key: sourceKey,
        label: t(`skillMarket.source.${sourceKey}`),
        custom: false,
        skills: byDirThenName(skills),
      })
    }
  }

  // An empty folder is worth listing while browsing, and always when it is the
  // folder currently picked in the source filter — otherwise the view looks broken.
  const filtering = query.value.trim() !== '' || category.value !== '' || source.value !== ''
  const pickedCategory = source.value.startsWith(CUSTOM_SOURCE_PREFIX)
    ? source.value.slice(CUSTOM_SOURCE_PREFIX.length)
    : ''
  for (const name of [...customNames].sort((a, b) => a.localeCompare(b))) {
    const skills = byDirThenName(byKey.get(`custom:${name}`) || [])
    if (skills.length || !filtering || name === pickedCategory) {
      groups.push({ key: `custom:${name}`, label: name, custom: true, skills })
    }
  }
  return groups
})

const filteredFavorites = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return favorites.value.filter(entry => matchesKeyword(entry, keyword))
})

/** The list behind the grid: market entries while discovering, stored entries in favorites. */
const marketBase = computed(() => (activeTab.value === 'favorites' ? filteredFavorites.value : marketSkills.value))

const marketList = computed(() => {
  if (!marketCategory.value) return marketBase.value
  return marketBase.value.filter(entry => (entry.category || 'other') === marketCategory.value)
})

const visibleMarket = computed(() => marketList.value.slice(0, visibleCount.value))

/** Chips describe the whole result set, so they must ignore the active category filter. */
const categoryBuckets = computed<CategoryBucket[]>(() => {
  const counts = new Map<string, number>()
  for (const entry of marketBase.value) {
    const key = entry.category || 'other'
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count)
})

const totalForChips = computed(() => marketBase.value.length)

const canLoadMore = computed(() => {
  if (activeTab.value === 'favorites') return false
  if (marketHasNext.value) return true
  return marketList.value.length > visibleMarket.value.length
})

const tabs = computed(() => [
  { key: 'discover' as MarketTab, label: t('skillMarket.tabs.discover'), count: 0 },
  { key: 'favorites' as MarketTab, label: t('skillMarket.tabs.favorites'), count: favorites.value.length },
  { key: 'installed' as MarketTab, label: t('skillMarket.tabs.installed'), count: allSkills.value.length },
])

const showDetail = computed({
  get: () => detail.value !== null,
  set: (value: boolean) => { if (!value) detail.value = null },
})

function categoryLabel(id: string) {
  return t(`skillMarket.cats.${id || 'other'}`)
}

function sourceTagType(skill: MarketSkill) {
  switch (skill.source) {
    case 'builtin': return 'default'
    case 'hub': return 'info'
    case 'external': return 'warning'
    default: return 'success'
  }
}

function formatCount(value: number) {
  if (!value) return ''
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`
  return String(value)
}

function formatDate(value: number) {
  if (!value) return ''
  // The upstream feed mixes second and millisecond timestamps.
  const date = new Date(value > 1e12 ? value : value * 1000)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

function isFavorite(entry: SkillsMarketEntry) {
  return favorites.value.some(item => installedKey(item) === installedKey(entry))
}

function toggleFavorite(entry: SkillsMarketEntry) {
  const key = installedKey(entry)
  favorites.value = isFavorite(entry)
    ? favorites.value.filter(item => installedKey(item) !== key)
    : [...favorites.value, entry]
  persistFavorites()
}

function pickCategory(id: string) {
  marketCategory.value = marketCategory.value === id ? '' : id
  visibleCount.value = PAGE_STEP
}

/** A refresh can drop the selected agent (uninstalled or emptied); fall back to the first section. */
watch(agentSections, sections => {
  if (sections.some(section => section.agent === installedAgent.value)) return
  if (sections.length) installedAgent.value = sections[0].agent
})

/** Switching agents invalidates the source/category filters, which belong to one tree. */
function selectInstalledAgent(agent: SkillTarget) {
  if (installedAgent.value === agent) return
  installedAgent.value = agent
  source.value = ''
  category.value = ''
}

function switchTab(tab: MarketTab) {
  if (activeTab.value === tab) return
  activeTab.value = tab
  marketCategory.value = ''
  visibleCount.value = PAGE_STEP
  if (tab === 'discover' && marketSkills.value.length === 0) void loadMarket(true, false)
}

function handleKeywordInput() {
  // Favorites and installed skills filter locally; only Discover hits the index.
  if (activeTab.value !== 'discover') return
  if (searchDebounce !== undefined) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => { void loadMarket(true, false) }, SEARCH_DEBOUNCE_MS)
}

/** Fill in Chinese descriptions for whatever the grid currently shows. */
async function ensureTranslations() {
  if (activeTab.value === 'installed') return
  const pending = visibleMarket.value
    .filter(entry => !entry.descriptionZh && entry.description && entry.contentLanguage !== 'zh')
    .slice(0, 30)
  if (pending.length === 0) return
  translating.value = true
  try {
    const translations = await translateSkillsMarket(pending.map(entry => entry.description))
    pending.forEach((entry, index) => {
      const zh = translations[index]
      if (zh) entry.descriptionZh = zh
    })
  } catch {
    // Keep the English copy when translation is unavailable.
  } finally {
    translating.value = false
  }
}

async function loadMarket(reset: boolean, refresh: boolean) {
  if (reset) {
    marketLoading.value = true
    marketError.value = ''
    visibleCount.value = PAGE_STEP
  } else marketLoadingMore.value = true
  try {
    const page = reset ? 1 : marketPage.value + 1
    const data = await searchSkillsMarket({
      q: query.value.trim(),
      page,
      limit: PAGE_STEP,
      refresh,
    })
    marketSkills.value = reset ? data.skills : [...marketSkills.value, ...data.skills]
    marketPage.value = data.page
    marketTotal.value = data.total
    marketHasNext.value = data.hasNext
  } catch (err: any) {
    marketError.value = err?.message || t('skillMarket.loadFailed')
  } finally {
    marketLoading.value = false
    marketLoadingMore.value = false
    void ensureTranslations()
  }
}

async function loadMore() {
  if (activeTab.value === 'favorites') return
  const before = marketSkills.value.length
  if (marketHasNext.value) {
    await loadMarket(false, false)
    // A failed or duplicate-only page leaves nothing new to reveal.
    if (marketSkills.value.length === before) return
  }
  visibleCount.value += PAGE_STEP
  await ensureTranslations()
}

async function loadLocal(refresh = false) {
  if (refresh) error.value = ''
  loading.value = allSkills.value.length === 0
  try {
    const results = await Promise.all(agentTargets.value.map(async agent => {
      try {
        const data = await fetchSkills(undefined, agent)
        return { agent, categories: data.categories || [] }
      } catch (err) {
        // A missing agent home is normal, but a broken request must not look like "no skills".
        console.warn('[skill-market] skill list failed for', agent, err)
        return { agent, categories: [] as SkillCategory[] }
      }
    }))
    const map: Partial<Record<SkillTarget, SkillCategory[]>> = {}
    for (const item of results) map[item.agent] = item.categories
    agentCategories.value = map
    loadedAgents.value = results
      .filter(item => item.categories.some(cat => (cat.skills || []).length > 0))
      .map(item => item.agent)
  } catch (err: any) {
    error.value = err?.message || t('skillMarket.loadFailed')
  } finally {
    loading.value = false
  }
}

async function loadCategories() {
  try {
    categoryDirs.value = await fetchSkillCategories()
  } catch {
    // The picker still accepts a new name when listing is unavailable.
  }
}

/**
 * "Global" (the skills root) plus the folders the user made — the product's own
 * catalog dirs (productivity, creative, …) would mix market skills into the
 * built-in set.
 */
const installCategoryOptions = computed(() => [
  { label: t('skillMarket.installTargetGlobal'), value: '' },
  ...categoryDirs.value
    .filter(item => item.custom)
    .map(item => ({ label: item.count ? `${item.name} (${item.count})` : item.name, value: item.name })),
])

const installAgentOptions = computed(() => [
  ...agentTargets.value.map(agent => ({ label: agentLabel(agent), value: agent })),
])

/** Installing asks for the agent and target category folder; an empty pick means the skills root. */
function openInstallPicker(entry: SkillsMarketEntry) {
  if (isInstalled(entry) || installing.value.has(installedKey(entry))) return
  installTarget.value = entry
  installCategory.value = ''
  showInstallPicker.value = true
  void loadCategories()
}

function confirmInstall() {
  const entry = installTarget.value
  showInstallPicker.value = false
  installTarget.value = null
  if (entry) void install(entry, installCategory.value.trim() || undefined, installAgent.value)
}

/* ---------------------------------------------------------------- group actions */

const groupBusy = ref<Set<string>>(new Set())

/** Rows expose a switch for the two agents whose enable state we own. */
function canToggleSkill(skill: MarketSkill) {
  return !skill.readonly && (skill.agent === 'hermes' || skill.agent === 'ekko')
}

function toggleableSkills(group: InstalledGroup) {
  return group.skills.filter(canToggleSkill)
}

function groupAllEnabled(group: InstalledGroup) {
  const list = toggleableSkills(group)
  return list.length > 0 && list.every(skill => skill.enabled !== false)
}

async function setGroupEnabled(group: InstalledGroup, enabled: boolean) {
  const list = toggleableSkills(group)
  if (list.length === 0 || groupBusy.value.has(group.key)) return
  const pending = new Set(groupBusy.value)
  pending.add(group.key)
  groupBusy.value = pending
  try {
    if (list[0].agent === 'ekko') {
      // Ekko exposes a single-skill endpoint only.
      await Promise.all(list.map(skill => toggleEkkoSkill(skill.name, enabled)))
    } else {
      await toggleSkillsBatch(list.map(skill => skill.name), enabled)
    }
    for (const skill of list) skill.enabled = enabled
    if (detail.value && list.some(skill => skill.name === detail.value?.name)) detail.value.enabled = enabled
  } catch (err: any) {
    message.error(`${t('skillMarket.toggleFailed')}: ${err?.message || ''}`)
  } finally {
    const settled = new Set(groupBusy.value)
    settled.delete(group.key)
    groupBusy.value = settled
  }
}

function confirmDeleteCategory(group: InstalledGroup) {
  const dir = group.key.startsWith('custom:') ? group.key.slice('custom:'.length) : group.label
  dialog.warning({
    title: t('skillMarket.deleteCategoryTitle', { name: group.label }),
    content: group.skills.length
      ? t('skillMarket.deleteCategoryWithSkills', { count: group.skills.length })
      : t('skillMarket.deleteCategoryEmpty'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => { void removeCategory(dir, group.label) },
  })
}

async function removeCategory(dir: string, label: string) {
  try {
    await deleteSkillCategory(dir)
    message.success(t('skillMarket.categoryDeleted', { name: label }))
    if (detail.value?.category === dir) detail.value = null
    await Promise.all([loadCategories(), loadLocal(true)])
  } catch (err: any) {
    message.error(`${t('skillMarket.categoryDeleteFailed')}: ${err?.message || ''}`)
  }
}

async function submitCategory() {
  const name = newCategoryName.value.trim()
  if (!name || creatingCategory.value) return
  creatingCategory.value = true
  try {
    await createSkillCategory(name)
    message.success(t('skillMarket.categoryCreated', { name }))
    newCategoryName.value = ''
    showCategoryDialog.value = false
    await Promise.all([loadCategories(), loadLocal(true)])
  } catch (err: any) {
    message.error(`${t('skillMarket.categoryCreateFailed')}: ${err?.message || ''}`)
  } finally {
    creatingCategory.value = false
  }
}

/**
 * A global install still lands in a folder named after the market category, so
 * the row shows a real tag (设计与媒体 …) instead of 未分类. Unknown/other
 * categories stay at the root.
 */
function autoCategoryFor(entry: SkillsMarketEntry) {
  const slug = (entry.category || '').trim()
  return slug && slug !== 'other' ? slug : undefined
}

async function install(entry: SkillsMarketEntry, category?: string, target: SkillTarget = installAgent.value) {
  const key = installedKey(entry)
  if (isInstalled(entry) || installing.value.has(key)) return
  const pending = new Set(installing.value)
  pending.add(key)
  installing.value = pending
  try {
    await installSkillsMarketEntry({
      ...(entry.slug
        ? { name: key, slug: entry.slug }
        : { name: key, githubUrl: entry.githubUrl }),
      category: category || autoCategoryFor(entry),
      target,
    })
    message.success(t('skillMarket.installDone', { name: entry.name }))
    const done = new Set(installedSlugs.value)
    done.add(key)
    installedSlugs.value = done
    await Promise.all([loadLocal(true), loadCategories()])
  } catch (err: any) {
    message.error(`${t('skillMarket.installFailed')}: ${err?.message || ''}`)
  } finally {
    const settled = new Set(installing.value)
    settled.delete(key)
    installing.value = settled
  }
}

async function handleToggle(skill: MarketSkill, enabled: boolean) {
  if (toggling.value.has(skill.name)) return
  const pending = new Set(toggling.value)
  pending.add(skill.name)
  toggling.value = pending
  try {
    if (skill.agent === 'ekko') await toggleEkkoSkill(skill.name, enabled)
    else await toggleSkill(skill.name, enabled)
    const found = (agentCategories.value[skill.agent] || [])
      .find(cat => cat.name === skill.category)
      ?.skills.find(item => item.name === skill.name)
    if (found) found.enabled = enabled
    if (detail.value?.name === skill.name) detail.value.enabled = enabled
  } catch (err: any) {
    message.error(`${t('skillMarket.toggleFailed')}: ${err?.message || ''}`)
  } finally {
    const settled = new Set(toggling.value)
    settled.delete(skill.name)
    toggling.value = settled
  }
}

/** The server only deletes from the product agent, Hermes, or the coding-agent homes below. */
const DELETABLE_AGENTS: SkillTarget[] = ['ekko', 'hermes', 'dsh', 'cursor', 'antigravity']

function canUninstall(skill: MarketSkill) {
  if (skill.readonly) return false
  if (!DELETABLE_AGENTS.includes(skill.agent)) return false
  if (skill.agent !== 'hermes') return true
  return (skill.source || 'local') === 'local'
}

function uninstallHint(skill: MarketSkill) {
  if (!DELETABLE_AGENTS.includes(skill.agent)) {
    return t('skillMarket.uninstallAgentUnsupported', { agent: agentLabel(skill.agent) })
  }
  if (skill.readonly) return t('skillMarket.uninstallReadonly')
  switch (skill.source || 'local') {
    case 'builtin': return t('skillMarket.uninstallBuiltin')
    case 'hub': return t('skillMarket.uninstallHub')
    case 'external': return t('skillMarket.uninstallExternal')
    default: return ''
  }
}

async function uninstall(skill: MarketSkill) {
  if (!canUninstall(skill) || removing.value.has(skill.name)) return
  const pending = new Set(removing.value)
  pending.add(skill.name)
  removing.value = pending
  try {
    await deleteSkillApi(skill.category, skill.name, skill.agent)
    message.success(t('skillMarket.uninstallDone', { name: skill.name }))
    const done = new Set(installedSlugs.value)
    done.delete(skill.name)
    installedSlugs.value = done
    if (detail.value?.name === skill.name) detail.value = null
    await loadLocal(true)
  } catch (err: any) {
    message.error(`${t('skillMarket.uninstallFailed')}: ${err?.message || ''}`)
  } finally {
    const settled = new Set(removing.value)
    settled.delete(skill.name)
    removing.value = settled
  }
}

/** Row overflow menu: details plus uninstall, greyed out with the reason when blocked. */
function rowActions(skill: MarketSkill) {
  const reason = uninstallHint(skill)
  return [
    { key: 'detail', label: t('skillMarket.detail') },
    {
      key: 'uninstall',
      label: reason ? `${t('skillMarket.uninstall')} · ${reason}` : t('skillMarket.uninstall'),
      disabled: !canUninstall(skill),
    },
  ]
}

function onRowAction(skill: MarketSkill, key: string) {
  if (key === 'detail') {
    detail.value = skill
    return
  }
  if (key === 'uninstall') confirmUninstall(skill)
}

function confirmUninstall(skill: MarketSkill) {
  dialog.warning({
    title: t('skillMarket.uninstall'),
    content: t('skillMarket.uninstallConfirm', { name: skill.name }),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => { void uninstall(skill) },
  })
}

async function refreshAll() {
  await Promise.all([loadLocal(true), activeTab.value === 'discover' ? loadMarket(true, true) : Promise.resolve()])
}

function handleImported() {
  showImport.value = false
  void loadLocal(true)
}

onMounted(async () => {
  // Resolution must finish before loadLocal, which iterates the target list.
  agentTargets.value = await fetchInstalledSkillTargets()
  await Promise.all([loadLocal(), loadMarket(true, false), loadCategories()])
})

onUnmounted(() => {
  if (searchDebounce !== undefined) clearTimeout(searchDebounce)
})
</script>

<template>
  <PageLoading :show="loading" class="skill-market-view">
    <PageHeader>
      <header class="page-header">
        <h2 class="header-title">{{ t('skillMarket.title') }}</h2>
        <div class="header-actions">
          <NButton size="small" quaternary :loading="loading || marketLoading" @click="refreshAll">
            {{ t('skillMarket.refresh') }}
          </NButton>
          <NButton size="small" type="primary" @click="showImport = true">
            <template #icon>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </template>
            {{ t('skillMarket.install') }}
          </NButton>
        </div>
      </header>
    </PageHeader>

    <div class="skill-market-body">
      <nav class="market-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          class="market-tab"
          :class="{ 'market-tab--active': activeTab === tab.key }"
          :aria-selected="activeTab === tab.key"
          @click="switchTab(tab.key)"
        >
          {{ tab.label }}
          <span v-if="tab.count > 0" class="market-tab__count">{{ tab.count }}</span>
        </button>
      </nav>

      <div class="skill-market-content">
        <NAlert type="info" :bordered="false" class="skill-market-notice">
          {{ t('skillMarket.notice') }}
        </NAlert>
        <NAlert v-if="activeTab === 'discover' && marketError" type="error" :bordered="false" class="skill-market-notice">
          {{ marketError }}
        </NAlert>
        <NAlert v-if="activeTab === 'installed' && error" type="error" :bordered="false" class="skill-market-notice">
          {{ error }}
        </NAlert>

        <div class="filter-row" :class="{ 'filter-row--single': activeTab !== 'installed' }">
          <NInput
            v-model:value="query"
            clearable
            :placeholder="t('skillMarket.searchPlaceholder')"
            :input-props="{ 'aria-label': t('skillMarket.searchPlaceholder') }"
            @update:value="handleKeywordInput"
          />
          <template v-if="activeTab === 'installed'">
            <NSelect v-model:value="source" :options="sourceOptions" />
            <NSelect
              v-model:value="category"
              :options="categoryOptions"
              filterable
              :menu-props="{ style: 'max-height: 60vh' }"
            />
            <NButton size="small" secondary class="new-category-btn" @click="showCategoryDialog = true">
              {{ t('skillMarket.newCategory') }}
            </NButton>
          </template>
        </div>

        <div v-if="activeTab !== 'installed'" class="category-chips">
          <button
            type="button"
            class="category-chip"
            :class="{ 'category-chip--active': marketCategory === '' }"
            @click="pickCategory('')"
          >
            {{ t('skillMarket.cats.all') }}
            <span class="category-chip__count">{{ totalForChips }}</span>
          </button>
          <button
            v-for="bucket in categoryBuckets"
            :key="bucket.id"
            type="button"
            class="category-chip"
            :class="{ 'category-chip--active': marketCategory === bucket.id }"
            @click="pickCategory(bucket.id)"
          >
            {{ categoryLabel(bucket.id) }}
            <span class="category-chip__count">{{ bucket.count }}</span>
          </button>
        </div>

        <div v-if="activeTab === 'installed' && agentSections.length" class="category-chips agent-chips">
          <button
            v-for="section in agentSections"
            :key="section.agent"
            type="button"
            class="category-chip"
            :class="{ 'category-chip--active': installedAgent === section.agent }"
            @click="selectInstalledAgent(section.agent)"
          >
            {{ agentLabel(section.agent) }}
            <span class="category-chip__count">{{ section.skills.length }}</span>
          </button>
        </div>

        <div class="skill-market-summary">
          <span v-if="activeTab === 'installed'">{{ t('skillMarket.summary', { total: agentSkills.length, enabled: agentEnabledCount }) }}</span>
          <span v-else-if="activeTab === 'favorites'">{{ t('skillMarket.favoriteSummary', { total: favorites.length }) }}</span>
          <span v-else>{{ t('skillMarket.marketSummary', { total: formatCount(marketTotal || marketSkills.length) }) }}</span>
          <span class="muted">
            <template v-if="translating">{{ t('skillMarket.translating') }}</template>
            <template v-else>
              {{ t('skillMarket.showing', {
                shown: activeTab === 'installed' ? filteredLocal.length : visibleMarket.length,
              }) }}
            </template>
          </span>
        </div>

        <template v-if="activeTab === 'installed'">
          <div v-if="groupedLocal.length" class="installed-panel">
            <template v-for="group in groupedLocal" :key="group.key">
              <section class="installed-section">
                <div
                  class="installed-section__head"
                  :class="{ 'installed-section__head--open': groupOpen(group.key) }"
                >
                  <button
                    type="button"
                    class="installed-section__toggle"
                    :aria-expanded="groupOpen(group.key)"
                    @click="toggleGroup(group.key)"
                  >
                    <span class="installed-section__chevron" aria-hidden="true"></span>
                    <span class="installed-section__title">{{ group.label }}</span>
                    <span class="installed-section__count">{{ group.skills.length }}</span>
                    <span v-if="group.custom && !group.skills.length" class="installed-section__hint">
                      {{ t('skillMarket.emptyCategoryHint') }}
                    </span>
                  </button>
                  <div class="installed-section__actions">
                    <span
                      v-if="toggleableSkills(group).length"
                      :title="groupAllEnabled(group) ? t('skillMarket.disableAll') : t('skillMarket.enableAll')"
                    >
                      <NSwitch
                        size="small"
                        :value="groupAllEnabled(group)"
                        :loading="groupBusy.has(group.key)"
                        @update:value="setGroupEnabled(group, $event)"
                      />
                    </span>
                    <NButton
                      v-if="group.custom"
                      text
                      size="small"
                      class="installed-section__delete"
                      :title="t('skillMarket.deleteCategory')"
                      @click="confirmDeleteCategory(group)"
                    >
                      <template #icon>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                      </template>
                    </NButton>
                  </div>
                </div>
                <div
                  v-for="skill in groupOpen(group.key) ? group.skills : []"
                  :key="`${skill.agent}/${skill.category}/${skill.name}`"
                  class="installed-row"
                >
                  <div class="installed-row__main" :title="[skill.name, skill.description].filter(Boolean).join('\n')">
                    <span class="installed-row__name">{{ skill.name }}</span>
                    <NTag v-if="!group.custom" size="tiny" round :type="sourceTagType(skill)">
                      {{ categoryLabelForList(skill.category) }}
                    </NTag>
                  </div>
                  <div class="installed-row__actions">
                    <NSwitch
                      v-if="canToggleSkill(skill)"
                      size="small"
                      :value="skill.enabled !== false"
                      :loading="toggling.has(skill.name)"
                      @update:value="handleToggle(skill, $event)"
                    />
                    <NDropdown :options="rowActions(skill)" @select="onRowAction(skill, $event)">
                      <NButton
                        text
                        size="small"
                        class="installed-row__more"
                        :title="t('skillMarket.moreActions')"
                      >
                        ⋮
                      </NButton>
                    </NDropdown>
                  </div>
                </div>
              </section>
            </template>
          </div>
          <NEmpty v-else :description="t('skillMarket.empty')" />
        </template>

        <template v-else>
          <div v-if="visibleMarket.length" class="skill-grid">
            <article
              v-for="entry in visibleMarket"
              :key="entry.id || entry.name"
              class="skill-card"
              data-testid="market-card"
            >
              <div class="skill-card__head">
                <div class="skill-card__title">
                  <strong :title="entry.name">{{ entry.name }}</strong>
                  <span class="muted" :title="entry.author">{{ entry.author }}</span>
                </div>
                <div class="skill-card__head-actions">
                  <NTag v-if="isInstalled(entry)" size="small" round type="success">
                    {{ t('skillMarket.installed') }}
                  </NTag>
                  <button
                    type="button"
                    class="favorite-btn"
                    :class="{ 'favorite-btn--on': isFavorite(entry) }"
                    :title="isFavorite(entry) ? t('skillMarket.unfavorite') : t('skillMarket.favorite')"
                    :aria-pressed="isFavorite(entry)"
                    @click="toggleFavorite(entry)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" :fill="isFavorite(entry) ? 'currentColor' : 'none'"
                      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.9z" />
                    </svg>
                  </button>
                </div>
              </div>
              <p
                v-if="entry.description || entry.descriptionZh"
                class="skill-card__description"
                :title="entry.descriptionZh || entry.description"
              >
                {{ entry.descriptionZh || entry.description }}
              </p>
              <div v-if="entry.scenes && entry.scenes.length" class="skill-card__scenes">
                <span v-for="scene in entry.scenes.slice(0, 3)" :key="scene" class="scene-tag">{{ scene }}</span>
              </div>
              <div class="skill-card__meta">
                <span>{{ categoryLabel(entry.category) }}</span>
                <span v-if="entry.stars" :title="t('skillMarket.stars')">★ {{ formatCount(entry.stars) }}</span>
                <span v-if="entry.downloads" :title="t('skillMarket.downloads')">↓ {{ formatCount(entry.downloads) }}</span>
                <span v-if="entry.updatedAt">{{ formatDate(entry.updatedAt) }}</span>
              </div>
              <div class="skill-card__actions">
                <NButton
                  size="small"
                  type="primary"
                  :loading="installing.has(installedKey(entry))"
                  :disabled="isInstalled(entry)"
                  @click="openInstallPicker(entry)"
                >
                  {{ isInstalled(entry) ? t('skillMarket.installed') : t('skillMarket.installAction') }}
                </NButton>
                <a v-if="entry.skillUrl" class="skill-card__link" :href="entry.skillUrl" target="_blank" rel="noreferrer noopener">
                  {{ t('skillMarket.openSource') }}
                </a>
              </div>
            </article>
          </div>
          <NEmpty
            v-else
            :description="activeTab === 'favorites' ? t('skillMarket.favoritesEmpty') : t('skillMarket.discoverEmpty')"
          />

          <div v-if="canLoadMore" class="market-more">
            <NButton size="small" :loading="marketLoadingMore" @click="loadMore">
              {{ t('skillMarket.loadMore') }}
            </NButton>
          </div>
        </template>
      </div>
    </div>

    <SkillImportModal v-if="showImport" @close="showImport = false" @saved="handleImported" />

    <NDrawer v-model:show="showDetail" width="var(--studio-drawer-width)" placement="right">
      <NDrawerContent v-if="detail" :title="detail.name" closable>
        <SkillDetail
          :category="detail.category"
          :skill="detail.name"
          :skill-name="detail.name"
          :target="detail.agent"
          :patch-count="detail.patchCount"
          :use-count="detail.useCount"
          :view-count="detail.viewCount"
          :pinned="detail.pinned"
          :readonly="detail.readonly === true || (detail.source || 'local') !== 'local'"
          @saved="loadLocal(true)"
        />
      </NDrawerContent>
    </NDrawer>

    <NModal
      v-model:show="showInstallPicker"
      preset="card"
      class="market-dialog"
      style="width: 420px"
      :title="t('skillMarket.installTargetTitle')"
    >
      <div class="market-dialog__body">
        <p class="market-dialog__hint">
          {{ t('skillMarket.installTargetHint', { name: installTarget?.name || '' }) }}
        </p>
        <label class="market-dialog__label">{{ t('skillMarket.installAgentLabel') }}</label>
        <NSelect v-model:value="installAgent" :options="installAgentOptions" />
        <NSelect
          v-model:value="installCategory"
          :options="installCategoryOptions"
          filterable
          tag
          :placeholder="t('skillMarket.installTargetPlaceholder')"
        />
        <p class="market-dialog__note">{{ t('skillMarket.installTargetRootNote') }}</p>
      </div>
      <template #footer>
        <div class="market-dialog__footer">
          <NButton size="small" @click="showInstallPicker = false">{{ t('common.cancel') }}</NButton>
          <NButton size="small" type="primary" @click="confirmInstall">{{ t('skillMarket.installAction') }}</NButton>
        </div>
      </template>
    </NModal>

    <NModal
      v-model:show="showCategoryDialog"
      preset="card"
      class="market-dialog"
      style="width: 380px"
      :title="t('skillMarket.newCategoryTitle')"
    >
      <div class="market-dialog__body">
        <NInput
          v-model:value="newCategoryName"
          :placeholder="t('skillMarket.newCategoryPlaceholder')"
          @keyup.enter="submitCategory"
        />
        <p class="market-dialog__note">{{ t('skillMarket.newCategoryNote') }}</p>
      </div>
      <template #footer>
        <div class="market-dialog__footer">
          <NButton size="small" @click="showCategoryDialog = false">{{ t('common.cancel') }}</NButton>
          <NButton
            size="small"
            type="primary"
            :loading="creatingCategory"
            :disabled="!newCategoryName.trim()"
            @click="submitCategory"
          >
            {{ t('common.confirm') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.skill-market-view { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.skill-market-body { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0 20px 24px; }

.market-tabs {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
  border-bottom: 1px solid $border-light;
}
.market-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 9px;
  border: 0;
  background: transparent;
  color: $text-secondary;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  transition: color 0.15s;

  &:hover { color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; border-radius: 6px; }
}
.market-tab--active { color: $text-primary; font-weight: 600; }
.market-tab--active::after {
  position: absolute;
  inset: auto 8px -1px;
  height: 2px;
  border-radius: 2px;
  background: $accent-primary;
  content: '';
}
.market-tab__count { color: $text-muted; font-size: 12px; font-weight: 400; }

.skill-market-content { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; overflow-y: auto; }
.skill-market-notice { font-size: 12px; }
.skill-market-summary { display: flex; gap: 12px; justify-content: space-between; font-size: 12px; color: $text-secondary; }
.header-actions { display: flex; align-items: center; gap: 8px; }
.filter-row { display: grid; grid-template-columns: minmax(200px, 1fr) minmax(130px, 180px) minmax(130px, 180px) auto; gap: 12px; align-items: center; }
.filter-row--single { grid-template-columns: minmax(240px, 1fr); }

.category-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.category-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid $border-color;
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  font: inherit;
  font-size: 12.5px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background-color 0.15s;

  &:hover { color: $text-primary; border-color: $accent-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}
.category-chip--active {
  border-color: $accent-primary;
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: $accent-primary;
}
.category-chip__count { color: $text-muted; font-size: 11px; }
.category-chip--active .category-chip__count { color: inherit; }

.skill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.skill-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-card;
}
.skill-card__head { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.skill-card__title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.skill-card__title strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-card__head-actions { display: inline-flex; flex: none; align-items: center; gap: 6px; }
.skill-card__description {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.6;
  color: $text-secondary;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.skill-card__scenes { display: flex; flex-wrap: wrap; gap: 6px; }
.scene-tag {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.07);
  color: $text-secondary;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.skill-card__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 11px; color: $text-muted; }
.skill-card__actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: auto; }
.skill-card__link { font-size: 12px; color: $accent-primary; text-decoration: none; }
.skill-card__link:hover { text-decoration: underline; }

.favorite-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;

  &:hover { background: rgba(var(--text-primary-rgb), 0.06); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}
.favorite-btn--on { color: #e6a23c; }

.market-more { display: flex; justify-content: center; padding: 8px 0 4px; }

.installed-panel {
  /* `overflow: hidden` zeroes the flex min-size, so without `flex: none` the
     panel shrinks to the viewport and clips the list instead of scrolling. */
  flex: none;
  border: 1px solid $border-color;
  border-radius: 10px;
  background: $bg-card;
  overflow: hidden;
}
.installed-section + .installed-section { border-top: 1px solid $border-color; }
.installed-section__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid $border-light;
  background: rgba(var(--accent-primary-rgb), 0.045);
  color: $text-primary;

  &:hover .installed-section__actions { opacity: 1; }

  &::before {
    content: '';
    width: 3px;
    height: 11px;
    border-radius: 2px;
    background: rgba(var(--accent-primary-rgb), 0.55);
  }
}
.installed-section__chevron {
  flex: none;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid currentColor;
  opacity: 0.65;
  transition: transform 0.15s;
}
.installed-section__head--open .installed-section__chevron { transform: rotate(90deg); }
.installed-section__title { font-size: 13px; font-weight: 600; }
.installed-section__count { color: $text-muted; font-size: 11px; font-weight: 400; }
.installed-section__hint { color: $text-muted; font-size: 11px; font-weight: 400; }
.installed-section__toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;

  &:hover { color: $accent-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; border-radius: 6px; }
}
.installed-section__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0.55;
  transition: opacity 0.15s;
}
.installed-section__delete { color: $text-muted; }
.installed-section__delete:hover { color: #e5534b; }

.installed-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 0 8px 0 14px;
  transition: background .15s;

  & + & { border-top: 1px solid $border-light; }
  &:hover { background: rgba(var(--text-primary-rgb), 0.03); }
}
.installed-row__main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.installed-row__name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.installed-row__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: .55;
  transition: opacity .15s;
}
.installed-row:hover .installed-row__actions { opacity: 1; }
.installed-row__more { color: $text-muted; font-size: 15px; line-height: 1; }

.new-category-btn { justify-self: start; white-space: nowrap; font-size: 12.5px; }

.market-dialog__body { display: flex; flex-direction: column; gap: 10px; }
.market-dialog__hint { margin: 0; font-size: 13px; line-height: 1.6; color: $text-primary; }
.market-dialog__label { font-size: 12px; line-height: 1.4; color: $text-muted; }
.market-dialog__note { margin: 0; font-size: 12px; line-height: 1.6; color: $text-muted; }
.market-dialog__footer { display: flex; justify-content: flex-end; gap: 8px; }

.muted { color: $text-muted; }

@media (max-width: 900px) {
  .filter-row { grid-template-columns: 1fr; }
  .skill-grid { grid-template-columns: 1fr; }
}
</style>

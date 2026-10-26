<script setup lang="ts">
/**
 * 工作台页面外壳：上游 Mimir 面板是 dsh 的 React 插件，整块搬进来后由这里挂载。
 * 面板自己画整框（含遮罩），mimir-embed.css 把它改成填满内容区的普通页面，
 * 并把配色接到 webui 的纯墨 token 上。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createMimirWorkbench, type MimirWorkbench } from '@/features/mimir/bridge'
import '@/features/mimir/mimir-embed.css'

const host = ref<HTMLDivElement | null>(null)
const booted = ref(false)
let workbench: MimirWorkbench | null = null

onMounted(() => {
  if (!host.value) return
  workbench = createMimirWorkbench(host.value)
  booted.value = true
})

onBeforeUnmount(() => {
  workbench?.unmount()
  workbench = null
})
</script>

<template>
  <div class="mimir-host" data-mimir-embed>
    <div ref="host" class="mimir-mount" />
    <div v-if="!booted" class="mimir-boot">正在加载研究工作台…</div>
  </div>
</template>

<style scoped>
.mimir-host {
  position: relative;
  height: 100%;
  min-height: 0;
}

.mimir-mount {
  position: absolute;
  inset: 0;
}

/* React 面板挂载前的一行占位 */
.mimir-boot {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
}
</style>

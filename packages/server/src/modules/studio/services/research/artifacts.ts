/**
 * Project markdown artifacts (the experiment log the 实验 view renders).
 *
 * Upstream reads `<project>/EXPERIMENT_LOG.md` from the wiki workspace. ekko
 * keeps experiments in the research store, so a missing file is rendered from
 * those records instead of reporting "not found" — the view then shows real
 * data on a fresh project.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { readStore, researchRoot } from './store'

/** Only flat markdown names are readable; anything else is refused. */
const ARTIFACT_NAME = /^[A-Za-z0-9_.-]+\.md$/

export interface ArtifactView {
  readonly name: string
  readonly content: string
  readonly mtimeMs: number
}

function projectDir(profile: string | undefined, projectId: string): string {
  return path.join(researchRoot(profile), 'projects', projectId)
}

function renderExperimentLog(
  experiments: ReadonlyArray<{ name: string; status: string; config: string; conclusion: string; at: number; metrics: ReadonlyArray<{ name: string; value: string }> }>,
): string {
  const rows = experiments
    .slice()
    .sort((a, b) => a.at - b.at)
    .map(experiment => {
      const metrics = (experiment.metrics || []).map(metric => `${metric.name}=${metric.value}`).join(', ')
      const date = new Date(experiment.at).toISOString().slice(0, 10)
      const config = experiment.config || ''
      return `| ${experiment.name} | ${experiment.status} | ${config || '—'} | ${metrics || '—'} | ${experiment.conclusion || '—'} | ${date} |`
    })
  return [
    '# 实验日志',
    '',
    '> 由 ekko 研究库中的实验记录生成（项目内没有 EXPERIMENT_LOG.md 时的回退视图）。',
    '',
    '| 实验 | 状态 | 参数 | 指标 | 结论 | 日期 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...(rows.length > 0 ? rows : ['| _暂无实验_ | — | — | — | — | — |']),
    '',
  ].join('\n')
}

/** Read one project artifact; falls back to a generated experiment log. */
export async function readArtifactView(
  profile: string | undefined,
  projectId: string,
  name: string,
): Promise<ArtifactView> {
  const safeName = ARTIFACT_NAME.test(name) ? name : 'EXPERIMENT_LOG.md'
  const target = path.join(projectDir(profile, projectId), safeName)
  try {
    const stat = await fs.stat(target)
    const content = await fs.readFile(target, 'utf-8')
    return { name: safeName, content, mtimeMs: stat.mtimeMs }
  } catch {
    const store = await readStore(profile)
    if (safeName === 'EXPERIMENT_LOG.md') {
      const mine = store.experiments.filter(experiment => experiment.projectId === projectId)
      return { name: safeName, content: renderExperimentLog(mine), mtimeMs: 0 }
    }
    return { name: safeName, content: '', mtimeMs: 0 }
  }
}

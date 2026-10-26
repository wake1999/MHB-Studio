/**
 * Cross-process lock for the research document.
 *
 * The panel (server) and the agent (its own process) both write
 * `.research/state.json`; an in-process mutex alone would let one of them
 * overwrite the other. This is a tiny lock file with a stale-break, sized for
 * short read-modify-write windows (milliseconds), not for long jobs.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const LOCK_NAME = 'state.lock'
const STALE_MS = 20_000

export async function acquireLock(dir: string, timeoutMs = 8_000): Promise<string> {
  const lockPath = path.join(dir, LOCK_NAME)
  const started = Date.now()
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      await handle.writeFile(String(process.pid))
      await handle.close()
      return lockPath
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const stat = await fs.stat(lockPath)
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          await fs.rm(lockPath, { force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() - started > timeoutMs) {
        throw Object.assign(new Error('research_locked'), { code: 'research_locked' })
      }
      await new Promise(resolve => setTimeout(resolve, 40 + Math.random() * 60))
    }
  }
}

export async function releaseLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true }).catch(() => undefined)
}

export async function withFileLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(dir)
  try {
    return await task()
  } finally {
    await releaseLock(lock)
  }
}

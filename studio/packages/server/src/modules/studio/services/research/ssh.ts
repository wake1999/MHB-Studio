/**
 * Remote machines over the system `ssh` binary.
 *
 * Key auth only (`BatchMode=yes`): a prompt would hang a server request, so a
 * missing key surfaces as a clear failure instead of a silent wait. Jobs are
 * launched detached and observed afterwards, which is why the job record carries
 * a pid — `refreshJob` is what turns "running" into a terminal state.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CONNECT_TIMEOUT = 8
const COMMAND_TIMEOUT = 30_000

export interface SshTarget {
  host: string
  user: string
  port?: number
}

export interface SshProbeResult {
  ok: boolean
  status: 'online' | 'offline'
  detail: string
  raw: string
  at: number
}

export interface SshJobResult {
  ok: boolean
  pid: string
  detail: string
  logPath: string
}

export interface SshJobState {
  state: 'running' | 'succeeded' | 'failed' | 'unknown'
  detail: string
  logTail: string
  exitCode: number | null
}

function sshArgs(target: SshTarget): string[] {
  const port = target.port && Number(target.port) > 0 ? Number(target.port) : 22
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT}`,
    '-p', String(port),
    `${target.user || 'root'}@${target.host}`,
  ]
}

function describeError(error: any): string {
  const stderr = String(error?.stderr || '').trim()
  if (stderr) return stderr.split('\n').slice(-4).join(' | ')
  const message = String(error?.message || error || '')
  if (/permission denied/i.test(message)) return '需要免密登录（服务器上没有该主机的密钥）'
  if (/timed out|timeout/i.test(message)) return '连接超时'
  return message.split('\n').slice(-3).join(' | ')
}

async function exec(target: SshTarget, command: string, timeout = COMMAND_TIMEOUT) {
  return run('ssh', [...sshArgs(target), command], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  })
}

export async function probeServer(target: SshTarget): Promise<SshProbeResult> {
  if (!target.host) {
    return { ok: false, status: 'offline', detail: '未填写主机', raw: '', at: Date.now() }
  }
  const script = [
    'echo "== host =="; hostname',
    'echo "== uptime =="; uptime',
    'echo "== gpu =="; (nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader || echo "no nvidia-smi")',
    'echo "== disk =="; df -h / | tail -1',
    'echo "== mem =="; free -g | head -2',
  ].join('; ')
  try {
    const { stdout } = await exec(target, script)
    const raw = stdout.trim()
    return { ok: true, status: 'online', detail: raw.split('\n').slice(0, 8).join('\n'), raw, at: Date.now() }
  } catch (error: any) {
    return { ok: false, status: 'offline', detail: describeError(error), raw: '', at: Date.now() }
  }
}

/**
 * Launch a detached command and report its pid.
 *
 * The wrapper writes `<log>.code` with the real exit status, so a refresh can
 * report success/failure from the exit code instead of grepping the log. Files
 * land under `~/.ekko/jobs/` on the remote host.
 */
export async function submitJob(target: SshTarget, name: string, command: string): Promise<SshJobResult> {
  if (!target.host) return { ok: false, pid: '', detail: '未填写主机', logPath: '' }
  if (!command.trim()) return { ok: false, pid: '', detail: '缺少要执行的命令', logPath: '' }
  const slug = (name || 'job').replace(/[^\w.-]+/g, '-').slice(0, 40)
  const remoteDir = '~/.ekko/jobs'
  const stamp = Date.now()
  const runner = `${remoteDir}/${slug}-${stamp}.sh`
  const logPath = `${remoteDir}/${slug}-${stamp}.log`
  const encoded = Buffer.from(command, 'utf-8').toString('base64')
  const script = [
    `mkdir -p ${remoteDir}`,
    `echo ${encoded} | base64 -d > ${runner}`,
    `nohup bash -c 'bash ${runner} > ${logPath} 2>&1; echo $? > ${logPath}.code' > /dev/null 2>&1 & echo $!`,
  ].join(' && ')
  try {
    const { stdout } = await exec(target, script)
    const pid = stdout.trim().split('\n').pop() || ''
    return { ok: Boolean(pid), pid, detail: pid ? `pid ${pid}` : '未拿到 pid', logPath }
  } catch (error: any) {
    return { ok: false, pid: '', detail: describeError(error), logPath }
  }
}

export async function jobState(target: SshTarget, pid: string, logPath: string): Promise<SshJobState> {
  if (!pid) return { state: 'unknown', detail: '没有记录 pid', logTail: '', exitCode: null }
  const script = [
    `if kill -0 ${Number(pid)} 2>/dev/null; then echo RUNNING; else echo EXITED; echo CODE=$(cat ${logPath || '/dev/null'}.code 2>/dev/null || echo unknown); fi`,
    `tail -n 20 ${logPath || '/dev/null'} 2>/dev/null || true`,
  ].join('; ')
  try {
    const { stdout } = await exec(target, script)
    const lines = stdout.trim().split('\n')
    const header = lines.shift() || ''
    if (header === 'RUNNING') {
      return { state: 'running', detail: '进程仍在运行', logTail: lines.join('\n'), exitCode: null }
    }
    const codeLine = lines.shift() || ''
    const parsed = codeLine.match(/CODE=(\S+)/)
    const raw = parsed ? parsed[1] : 'unknown'
    const exitCode = Number.isFinite(Number(raw)) ? Number(raw) : null
    const logTail = lines.join('\n')
    if (exitCode === null) {
      const failed = /Traceback|Error:|error:|Killed|FAILED/i.test(logTail)
      return {
        state: failed ? 'failed' : 'succeeded',
        detail: `进程已退出；退出码不可读，按日志判定（${failed ? '有错误' : '无错误'}）`,
        logTail,
        exitCode: null,
      }
    }
    return {
      state: exitCode === 0 ? 'succeeded' : 'failed',
      detail: `进程已退出，退出码 ${exitCode}`,
      logTail,
      exitCode,
    }
  } catch (error: any) {
    return { state: 'unknown', detail: describeError(error), logTail: '', exitCode: null }
  }
}

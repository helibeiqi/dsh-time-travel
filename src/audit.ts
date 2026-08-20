/**
 * 审计规则引擎。
 *
 * 在工具执行结束后（tools/result）对每条记录求值：
 *  1. 匹配内置规则（危险 shell / 敏感路径写 / 不可补偿写 / 整目录删除）；
 *  2. 命中规则的记录追加为一行 JSON 到 audit-log.jsonl（原子追加，UTF-8）；
 *  3. 审计写入失败被静默包含——绝不影响工具执行管线。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  AuditHit,
  CompensationKind,
  Severity,
  Snapshot,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js'

export type { Severity }

/** 单条审计上下文：规则求值的全部输入。 */
export interface AuditContext {
  readonly exec: ToolExecutionLike
  readonly kind: CompensationKind
  readonly snapshot: Snapshot
  readonly result: ToolResultLike
}

/** 一条审计规则。 */
export interface AuditRule {
  readonly id: string
  readonly description: string
  readonly severity: Severity
  matches(ctx: AuditContext): boolean
}

/** 从工具参数中提取 bash 命令。 */
function bashCommandOf(exec: ToolExecutionLike): string | undefined {
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  const command = (exec.arguments as Record<string, unknown>)['command']
  return typeof command === 'string' ? command : undefined
}

/** 从工具参数中提取目标路径。 */
function pathOf(exec: ToolExecutionLike): string | undefined {
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  const record = exec.arguments as Record<string, unknown>
  const candidate = record['path'] ?? record['file'] ?? record['filePath']
  return typeof candidate === 'string' ? candidate : undefined
}

/** 命中高危 shell 模式（大小写不敏感、可跨行）。 */
const DANGEROUS_SHELL_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=.*of=\/dev\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\bchown\s+-R\b/i,
  /\b>\s*\/dev\/sd[a-z]/i,
  /\bmv\s+\/\s+/i,
  /\bcurl\b[^\n|]*\|\s*(sh|bash)\b/i,
  /:\s*\(\s*\)\s*\{/i,
]

/** 敏感路径片段（命中即告警）。 */
const SENSITIVE_PATH_SEGMENTS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.npmrc',
  '.git-credentials',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  'id_rsa',
  'id_ed25519',
  '.pem',
  '.key',
  'credentials',
  'secrets',
  '.env',
]

/** 匹配敏感路径（归一化反斜杠为斜杠、转小写后做子串匹配）。 */
function matchesSensitivePath(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').toLowerCase()
  return SENSITIVE_PATH_SEGMENTS.some((segment) => normalized.includes(segment.toLowerCase()))
}

/** 危险 shell：bash 命令命中高危模式。 */
const dangerousShellRule: AuditRule = {
  id: 'dangerous-shell',
  description: 'bash 命令命中高危模式（rm -rf / mkfs / dd 写盘 / shutdown / curl|sh 等）',
  severity: 'critical',
  matches(ctx) {
    if (ctx.kind !== 'bash') return false
    const command = bashCommandOf(ctx.exec)
    if (!command) return false
    return DANGEROUS_SHELL_PATTERNS.some((pattern) => pattern.test(command))
  },
}

/** 敏感路径写：write/edit/delete 目标落在敏感路径片段上。 */
const sensitivePathWriteRule: AuditRule = {
  id: 'sensitive-path-write',
  description: '写/删操作命中敏感路径（.ssh / .aws / /etc/passwd / *.pem / .env 等）',
  severity: 'warn',
  matches(ctx) {
    if (ctx.kind !== 'fs-write' && ctx.kind !== 'fs-delete') return false
    const target = pathOf(ctx.exec) ?? (ctx.snapshot?.kind === 'file' ? ctx.snapshot.path : undefined)
    if (!target) return false
    return matchesSensitivePath(target)
  },
}

/** 不可补偿写操作：bash / http 类别的调用（有真实副作用却无法自动回滚）。 */
const nonCompensableWriteRule: AuditRule = {
  id: 'non-compensable-write',
  description: '不可自动补偿的写类工具被调用（bash / http.request），如需回滚须人工处理',
  severity: 'warn',
  matches(ctx) {
    return ctx.kind === 'bash' || ctx.kind === 'http'
  },
}

/** 整目录删除：fs-delete 目标为目录（快照阶段已记录 existed+isDirectory 语义）。 */
const deleteWholeDirRule: AuditRule = {
  id: 'delete-whole-dir',
  description: '删除目标指向目录（非单文件），存在级联删除风险',
  severity: 'warn',
  matches(ctx) {
    if (ctx.kind !== 'fs-delete') return false
    const snapshot = ctx.snapshot
    if (!snapshot || snapshot.kind !== 'file') return false
    // FileSnapshot 中 existed=true 且 size 缺失 = 快照时是目录
    return snapshot.existed && snapshot.size === undefined && snapshot.content === undefined
  },
}

/** 内置规则全集（key 与 Config.audit.rules 对应）。 */
export const builtinRules: ReadonlyMap<string, AuditRule> = new Map(
  [dangerousShellRule, sensitivePathWriteRule, nonCompensableWriteRule, deleteWholeDirRule].map(
    (rule) => [rule.id, rule],
  ),
)

export type SeverityFilter = 'info' | 'warn' | 'critical'

/** 审计引擎：按启用开关求值规则。 */
export class AuditEngine {
  readonly #enabled: ReadonlyMap<string, boolean>

  constructor(enabled: Readonly<Record<string, boolean>> = {}) {
    this.#enabled = new Map(Object.entries(enabled))
  }

  /** 对一条工具调用求值，返回命中的审计结果（按规则注册顺序）。 */
  evaluate(ctx: AuditContext): AuditHit[] {
    const hits: AuditHit[] = []
    for (const rule of builtinRules.values()) {
      if (this.#enabled.get(rule.id) === false) continue
      if (rule.matches(ctx)) {
        hits.push({ ruleId: rule.id, severity: rule.severity, message: rule.description })
      }
    }
    return hits
  }
}

/** 审计日志行（append 到 JSONL 的载荷）。 */
export interface AuditLogEntry {
  at: string
  turnId: string
  sessionId: string
  callId: string
  toolName: string
  kind: CompensationKind
  isError: boolean
  hits: readonly AuditHit[]
  command?: string
  path?: string
}

/** 追加一条审计日志。失败静默（不得破坏工具管线）。 */
export async function appendAuditLine(logPath: string, entry: AuditLogEntry): Promise<void> {
  try {
    const dir = path.dirname(logPath)
    if (dir && dir !== '.') {
      await mkdir(dir, { recursive: true })
    }
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // 审计写失败被包含：不影响工具执行与补偿链路
  }
}

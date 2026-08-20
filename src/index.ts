/**
 * dsh-time-travel 插件入口。
 *
 * 契约（与 DSH 0.1.0-rc.6 的 cordis 插件约定一致，逆向自 dsh-beisen 与
 * cordis 4.0.1 源码）：
 *  - ESM（package.json "type": "module"）；
 *  - 四个具名导出 name / inject / Config / apply，无 default export；
 *  - 依赖经 inject 声明（本插件监听 tools 服务的事件，声明 ['tools']）；
 *  - 所有副作用经 ctx.on() 注册（监听器随 fiber 卸载自动撤销）；
 *  - Config 必须是 schemastery Schema 实例（普通对象会让 cordis loader
 *    调 Config.validate() 崩溃）。
 *
 * 管线：
 *   tools/pre-execute（waterfall）→ 前状态快照（失败不影响放行）
 *   tools/result（emit）        → 构建补偿动作 + 审计 + 记录入栈
 *   ctx.timeTravel.rewindTo()   → 按轮次倒序执行补偿
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AuditEngine, appendAuditLine } from './audit.js'
import { builtinCompensators, compensate, type Compensator } from './compensation.js'
import type {
  AuditHit,
  CompensationAction,
  CompensationKind,
  PreToolDecision,
  RewindReport,
  Snapshot,
  TimeTravelHostContext,
  TimeTravelServiceLike,
  ToolExecutionLike,
  ToolRecord,
  ToolResultLike,
} from './types.js'

export const name = 'dsh-time-travel'
export const inject = ['tools'] as const

/** 插件配置（schemastery Schema；loader 会先 Config.validate 再传入 apply）。 */
export const Config = Schema.object({
  /**
   * 同一会话内两次工具调用间隔超过该毫秒数则开启新轮次（turn）；
   * 0 = 每次工具调用独立成轮。
   */
  turnGapMs: Schema.number().default(5000).description('同会话内两次工具调用超过该间隔则开启新 turn；0 = 每次调用独立 turn'),
  audit: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用审计规则引擎'),
    logPath: Schema.string().default('audit-log.jsonl').description('审计日志 JSONL 输出路径（相对 cwd）'),
    rules: Schema.dict(Schema.boolean()).default({
      'dangerous-shell': true,
      'sensitive-path-write': true,
      'non-compensable-write': true,
      'delete-whole-dir': true,
    }).description('按规则 id 开关审计规则'),
  }),
  /**
   * 工具名 → 补偿器类别映射。默认覆盖 DSH 内置 write/edit/delete/bash，
   * 以及通用桥接工具名 fs.write / fs.delete / http.request。
   */
  watchTools: Schema.dict(
    Schema.union([
      Schema.const('fs-write'),
      Schema.const('fs-delete'),
      Schema.const('bash'),
      Schema.const('http'),
      Schema.const('none'),
    ]),
  ).default({
    write: 'fs-write',
    edit: 'fs-write',
    delete: 'fs-delete',
    bash: 'bash',
    pwsh: 'bash', // Windows 上 dsh 的 bash 工具实际注册名为 pwsh（PowerShell）
    'http.request': 'http',
  }),
  /** 内存中保留的最大记录数（超出丢弃最旧，审计日志不受影响）。 */
  maxRecords: Schema.number().default(10000).description('内存保留的最大工具记录数'),
  /** dryRun：rewind 只生成报告、不实际执行补偿。 */
  dryRun: Schema.boolean().default(false).description('rewind 时只报告不执行补偿'),
})

/** 校验后的完整配置类型。 */
export type TimeTravelConfig = Schemastery.TypeT<typeof Config>

/** 会话内一条 turn 的活跃状态。 */
interface ActiveTurn {
  sessionId: string
  turnId: string
  lastAt: number
}

/** 挂起中的执行前快照（keyed by callId，等 tools/result 消费）。 */
interface PendingSnapshot {
  exec: ToolExecutionLike
  snapshot: Snapshot
  kind: CompensationKind
}

/** 倒序执行补偿时的单条结果。 */
interface RewindDetailItem {
  seq: number
  turnId: string
  toolName: string
  action: CompensationAction['type']
  status: 'rewound' | 'skipped' | 'failed'
  message?: string
}

/**
 * 类型化事件监听封装。
 *
 * 入口 ctx 使用结构化接口 TimeTravelHostContext（自带 on/emit），绕开
 * cordis 的 `keyof Events` 约束——Events 接口在 pnpm 隔离安装下无法可靠
 * 做 declare module 合并（实测 TS 5.7/5.8/5.9 均不可用，见 types.ts 说明）。
 */
function onToolEvent(
  ctx: TimeTravelHostContext,
  name: string,
  listener: (...args: never[]) => unknown,
): () => boolean {
  return ctx.on(name, listener)
}

/** 类型化事件分发封装（同 onToolEvent 的原因）。 */
function emitEvent(ctx: TimeTravelHostContext, name: string, ...args: unknown[]): void {
  ctx.emit(name, ...args)
}

/** 可逆时间旅行服务：快照 → 记录 → rewindTo 补偿。 */
export class TimeTravelService extends Service<TimeTravelConfig> implements TimeTravelServiceLike {
  private readonly host: TimeTravelHostContext
  private readonly settings: TimeTravelConfig
  private readonly compensators: ReadonlyMap<string, Compensator>
  private readonly auditEngine: AuditEngine

  private recordList: ToolRecord[] = []
  private pendingSnapshots = new Map<string, PendingSnapshot>()
  private turnCounter = 0
  private activeTurn: ActiveTurn | null = null
  private seqCounter = 0

  constructor(ctx: TimeTravelHostContext, config: TimeTravelConfig) {
    // super 期望 cordis 的 Context 类型；结构化接口与 cordis Context 兼容，
    // 此处仅做一次类型投影（运行时不变）。
    super(ctx as unknown as Context, 'timeTravel')
    this.host = ctx
    this.settings = config

    // 工具名 → 补偿器：仅监听 watchTools 里配置且内置存在的类别
    const compensators = new Map<string, Compensator>()
    for (const [toolName, kind] of Object.entries(config.watchTools)) {
      const compensator = builtinCompensators.get(kind)
      if (compensator) compensators.set(toolName, compensator)
    }
    this.compensators = compensators
    this.auditEngine = new AuditEngine(config.audit.rules)

    // 全部副作用经 ctx.on 注册：监听器由 cordis fiber 拥有，插件卸载时自动撤销。
    onToolEvent(ctx, 'tools/pre-execute', (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) =>
      this.handlePreExecute(exec, next),
    )
    onToolEvent(ctx, 'tools/result', (exec: Readonly<ToolExecutionLike>, result: Readonly<ToolResultLike>) =>
      this.handleResult(exec, result),
    )
  }

  /** tools/pre-execute：执行前快照。快照失败或抛错都不影响工具放行。 */
  private async handlePreExecute(
    exec: ToolExecutionLike,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    const compensator = this.compensators.get(exec.name)
    if (compensator) {
      let snapshot: Snapshot = null
      try {
        snapshot = await compensator.snapshot(exec)
      } catch {
        snapshot = null // 快照失败：记录不可补偿，工具继续执行
      }
      this.pendingSnapshots.set(exec.callId, { exec, snapshot, kind: compensator.kind })
    }
    return next()
  }

  /** tools/result：构建补偿动作 + 审计 + 入栈 + 审计落盘。 */
  private handleResult(exec: Readonly<ToolExecutionLike>, result: Readonly<ToolResultLike>): void {
    const pending = this.pendingSnapshots.get(exec.callId)
    this.pendingSnapshots.delete(exec.callId)

    const compensator = this.compensators.get(exec.name) ?? builtinCompensators.get('none')!
    const kind = pending?.kind ?? compensator.kind
    const snapshot: Snapshot = pending?.snapshot ?? null

    // 只有成功的结果才可能留下可补偿的副作用
    let compensation: CompensationAction | null = null
    if (!result.isError) {
      try {
        compensation = compensator.buildAction(snapshot, exec, result)
      } catch {
        compensation = null
      }
    }

    const sessionId = exec.agent?.sessionId ?? 'global'
    const turnId = this.turnFor(sessionId)
    const seq = ++this.seqCounter
    const audited: AuditHit[] = this.auditEngine.evaluate({ exec, kind, snapshot, result })

    const record: ToolRecord = {
      turnId,
      seq,
      sessionId,
      callId: exec.callId,
      toolName: exec.name,
      kind,
      args: exec.arguments,
      snapshot,
      compensation,
      compensable: compensator.compensable,
      audited,
      isError: result.isError,
      at: new Date().toISOString(),
    }
    this.recordList.push(record)
    if (this.recordList.length > this.settings.maxRecords) {
      this.recordList.shift()
    }

    if (this.settings.audit.enabled && audited.length > 0) {
      void appendAuditLine(this.settings.audit.logPath, {
        at: record.at,
        turnId: record.turnId,
        sessionId: record.sessionId,
        callId: record.callId,
        toolName: record.toolName,
        kind: record.kind,
        isError: record.isError,
        hits: [...record.audited],
        command: record.snapshot?.kind === 'bash' ? record.snapshot.command : undefined,
        path: record.snapshot?.kind === 'file' ? record.snapshot.path : undefined,
      })
    }
  }

  /** 逻辑轮次：同会话、间隔 ≤ turnGapMs 的连续调用归入同一轮。 */
  private turnFor(sessionId: string): string {
    const now = Date.now()
    const gap = this.settings.turnGapMs
    if (
      !this.activeTurn ||
      this.activeTurn.sessionId !== sessionId ||
      (gap > 0 && now - this.activeTurn.lastAt > gap)
    ) {
      this.turnCounter += 1
      this.activeTurn = { sessionId, turnId: `T${this.turnCounter}`, lastAt: now }
    } else {
      this.activeTurn.lastAt = now
    }
    return this.activeTurn.turnId
  }

  /** 撤销指定轮次及之后所有调用（按轮次倒序：最新调用先补偿）。 */
  async rewindTo(turnId: string): Promise<RewindReport> {
    const turnRecords = this.recordList.filter((record) => record.turnId === turnId)
    if (turnRecords.length === 0) {
      return { requestedTurnId: turnId, rewound: 0, skipped: 0, failed: 0, details: [] }
    }
    const firstSeq = Math.min(...turnRecords.map((record) => record.seq))
    const target = this.recordList.filter((record) => record.seq >= firstSeq)
    return this.executeRewind(target, turnId)
  }

  /** 撤销全部记录（最新 → 最旧）。 */
  async rewindAll(): Promise<RewindReport> {
    return this.executeRewind([...this.recordList])
  }

  /** 读取记录（可按会话过滤）。 */
  records(sessionId?: string): readonly ToolRecord[] {
    if (sessionId === undefined) return this.recordList
    return this.recordList.filter((record) => record.sessionId === sessionId)
  }

  /** 清空内存记录（不执行补偿；审计日志不受影响）。 */
  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.recordList = []
      this.pendingSnapshots.clear()
      return
    }
    this.recordList = this.recordList.filter((record) => record.sessionId !== sessionId)
  }

  /** 倒序执行补偿：rewound/skipped 从记录移除，failed 保留以便重试。 */
  private async executeRewind(target: readonly ToolRecord[], requestedTurnId?: string): Promise<RewindReport> {
    const ordered = [...target].sort((a, b) => b.seq - a.seq)
    const details: RewindDetailItem[] = []
    const done = new Set<number>()
    let rewound = 0
    let skipped = 0
    let failed = 0

    for (const record of ordered) {
      const action = record.compensation
      if (!record.compensable || !action || action.type === 'none' || action.type === 'manual') {
        skipped += 1
        details.push({
          seq: record.seq,
          turnId: record.turnId,
          toolName: record.toolName,
          action: action?.type ?? 'none',
          status: 'skipped',
          message: action?.hint,
        })
        done.add(record.seq)
        continue
      }
      if (this.settings.dryRun) {
        rewound += 1
        details.push({
          seq: record.seq,
          turnId: record.turnId,
          toolName: record.toolName,
          action: action.type,
          status: 'rewound',
          message: 'dryRun：未实际执行',
        })
        done.add(record.seq)
        continue
      }
      try {
        await compensate(action)
        rewound += 1
        details.push({
          seq: record.seq,
          turnId: record.turnId,
          toolName: record.toolName,
          action: action.type,
          status: 'rewound',
        })
        done.add(record.seq)
      } catch (error) {
        failed += 1
        details.push({
          seq: record.seq,
          turnId: record.turnId,
          toolName: record.toolName,
          action: action.type,
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
        // failed 不入 done：保留在记录中以便再次重试
      }
    }

    if (done.size > 0) {
      this.recordList = this.recordList.filter((record) => !done.has(record.seq))
    }

    const report: RewindReport = {
      ...(requestedTurnId !== undefined ? { requestedTurnId } : {}),
      rewound,
      skipped,
      failed,
      details,
    }
    emitEvent(this.host, 'timeTravel/rewound', report)
    return report
  }
}

/** 插件入口：注册 timeTravel 服务并挂载工具事件监听。 */
export function apply(
  ctx: TimeTravelHostContext,
  config?: Schemastery.TypeS<typeof Config>,
): void {
  const resolved = Config(config ?? {}) // schemastery 校验 + 补默认值
  new TimeTravelService(ctx, resolved)
}

/**
 * dsh-time-travel 类型定义。
 *
 * 工具事件签名采用本地结构化类型（不硬依赖 @deepseek-ai/dsh-tools 包），
 * 运行时与 DSH 0.1.0-rc.6 的 ToolRuntime 管线兼容：
 *   tools/pre-execute（waterfall，可返回 allow/deny/ask）
 *   tools/result（emit，最终冻结结果观察点，监听器异常被包含）
 *
 * 重要：不要对 @deepseek-ai/cordis 做 declare module 增强（Context / Events
 * 均不可靠）。实测 TS 5.7/5.8/5.9 下，type-only import 与 value import 会
 * 解析出不同的模块身份，模块增强只对其中一种视图生效，导致 ctx.on /
 * ctx.timeTravel 在另一半场景报不存在（详见 index.ts 的说明与封装）。
 * 因此本插件的入口 ctx 采用结构化接口 TimeTravelHostContext，绕开该限制。
 */

/** 与 DSH Agent 的 sessionId 兼容的最小结构（exec.agent 的运行时投影）。 */
export interface ToolAgentInfo {
  readonly sessionId?: string
  readonly name?: string
}

/** 工具执行对象的最小结构（对应 ToolRuntime 的 ToolExecution）。 */
export interface ToolExecutionLike {
  readonly callId: string
  readonly name: string
  /** losslessly JSON 可序列化的已解析参数。 */
  readonly arguments: unknown
  readonly agent?: ToolAgentInfo
}

/** 工具执行最终结果的最小结构（对应 ToolExecutionResult）。 */
export interface ToolResultLike {
  readonly isError: boolean
  readonly error?: { message: string; info?: unknown }
  readonly content?: unknown[]
  readonly value?: unknown
}

/** tools/pre-execute 的决策结果（对应 PreToolDecision）。 */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/** tools/post-execute 的决策结果（对应 PostToolDecision）。 */
export type PostToolDecision =
  | { kind: 'accept'; content?: unknown[]; value?: unknown }
  | { kind: 'block'; feedback: unknown[] }

/** 内置补偿器类别。 */
export type CompensationKind = 'fs-write' | 'fs-delete' | 'bash' | 'http' | 'none'

/** 审计严重级别。 */
export type Severity = 'info' | 'warn' | 'critical'

/** 补偿动作的类型。 */
export type CompensationActionType =
  | 'restore-file'
  | 'delete-file'
  | 'manual'
  | 'none'

/** 一条补偿动作：rewind 时按序执行。 */
export interface CompensationAction {
  readonly type: CompensationActionType
  /** 目标文件路径（restore-file / delete-file）。 */
  readonly path?: string
  /** restore-file：写回的原内容（utf8 文本）。 */
  readonly content?: string
  /** manual：给人工处理的提示（bash 等不可自动补偿的工具）。 */
  readonly hint?: string
}

/** 执行前状态快照（补偿的依据）。 */
export interface FileSnapshot {
  readonly kind: 'file'
  readonly path: string
  /** 快照时文件是否存在。 */
  readonly existed: boolean
  /** 文件原内容：utf8 文本；二进制无法安全解码时为 undefined。 */
  readonly content?: string
  /** 原文件大小（字节），供审计展示。 */
  readonly size?: number
}

export interface BashSnapshot {
  readonly kind: 'bash'
  readonly command: string
}

export type Snapshot = FileSnapshot | BashSnapshot | null

/** 审计命中。 */
export interface AuditHit {
  readonly ruleId: string
  readonly severity: Severity
  readonly message: string
}

/** 一次工具调用的完整时间旅行记录。 */
export interface ToolRecord {
  /** 逻辑轮次号（如 T3），同一轮内的调用共享一个 turnId。 */
  readonly turnId: string
  /** 会话内单调递增序号，用于倒序回放。 */
  readonly seq: number
  readonly sessionId: string
  readonly callId: string
  readonly toolName: string
  readonly kind: CompensationKind
  readonly args: unknown
  readonly snapshot: Snapshot
  readonly compensation: CompensationAction | null
  /** 是否可自动补偿（bash/http 不可自动补偿）。 */
  readonly compensable: boolean
  readonly audited: readonly AuditHit[]
  readonly isError: boolean
  readonly at: string
}

/** rewindTo / rewindAll 的执行报告。 */
export interface RewindReport {
  readonly requestedTurnId?: string
  /** 实际执行补偿的条数。 */
  readonly rewound: number
  /** 跳过条数（不可补偿 / 补偿动作缺失）。 */
  readonly skipped: number
  /** 失败条数（补偿执行抛出异常）。 */
  readonly failed: number
  readonly details: readonly {
    readonly seq: number
    readonly turnId: string
    readonly toolName: string
    readonly action: CompensationActionType
    readonly status: 'rewound' | 'skipped' | 'failed'
    readonly message?: string
  }[]
}

/**
 * 插件入口所需的宿主 Context 最小结构（cordis Context 的结构化投影）。
 *
 * 不使用 cordis 的 Context 类型：TS 5.7+ 下 cordis 的模块增强（ctx.on /
 * ctx.emit 等方法经 declare module 合并）对不同 import 视图表现不一致，
 * 直接用结构化接口可保证 apply 在测试与真实 dsh 环境都能通过类型检查。
 */
export interface TimeTravelHostContext {
  on(name: string, listener: (...args: never[]) => unknown): () => boolean
  emit(name: string, ...args: unknown[]): void
}

/**
 * ctx.timeTravel 服务接口。
 *
 * 注意：故意不继承 cordis 的 Service 基类——Service 的 config 泛型（`T`）是
 * 协变且不可实例化的，interface extends Service<never> 会导致 implement 时
 * `[symbols.config]` 属性类型不兼容。运行时实现类仍 extends Service。
 */
export interface TimeTravelServiceLike {
  /** 撤销指定轮次及之后所有工具调用造成的变更（按轮次倒序）。 */
  rewindTo(turnId: string): Promise<RewindReport>
  /** 撤销全部记录（最新轮次 → 最旧轮次）。 */
  rewindAll(): Promise<RewindReport>
  /** 读取当前记录（可按会话过滤）。 */
  records(sessionId?: string): readonly ToolRecord[]
  /** 清空记录（不执行补偿）。 */
  clear(sessionId?: string): void
}

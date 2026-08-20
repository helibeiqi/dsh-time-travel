/**
 * 补偿协议与内置工具补偿器。
 *
 * 每个补偿器实现一个工具类别（fs-write / fs-delete / bash / http）的
 * 「前状态快照 → 补偿动作」转换：
 *  - snapshot(exec)：工具执行前调用，读取目标路径的前状态；
 *  - buildAction(snapshot, exec, result)：工具执行后调用，把快照转化为
 *    具体的补偿动作（restore-file / delete-file / manual / none）。
 *
 * fs-write / fs-delete 可自动补偿；bash / http 仅审计、标记 manual
 * （无法安全自动回滚，交由人工处理）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type {
  CompensationAction,
  CompensationKind,
  Snapshot,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js'

/** 一个补偿器：负责一种工具类别的快照与补偿动作推导。 */
export interface Compensator {
  readonly kind: CompensationKind
  /** 该类别是否可自动补偿。 */
  readonly compensable: boolean
  /** 执行前快照。失败时必须返回 null（不得抛给工具管线）。 */
  snapshot(exec: ToolExecutionLike): Promise<Snapshot>
  /** 执行后把快照转化为补偿动作。 */
  buildAction(
    snapshot: Snapshot,
    exec: ToolExecutionLike,
    result: ToolResultLike,
  ): CompensationAction | null
}

/** 从工具参数里提取文件路径（兼容 write/edit 的参数形态）。 */
function filePathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const candidate = record['path'] ?? record['file'] ?? record['filePath']
  return typeof candidate === 'string' ? candidate : undefined
}

/** 从工具参数里提取文件内容（兼容 write/edit 的参数形态）。 */
function fileContentOf(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  return record['content'] ?? record['text'] ?? record['data']
}

/** 把参数内容规范化为 utf8 文本；无法安全规范化时返回 undefined。 */
function toUtf8Text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 读取文件前状态：内容（utf8 可解码时）+ 是否存在 + 大小。 */
async function snapshotFile(target: string): Promise<Snapshot> {
  try {
    const stat = await fsp.stat(target)
    if (stat.isDirectory()) {
      return { kind: 'file', path: target, existed: true }
    }
    const raw = await fsp.readFile(target)
    let content: string | undefined
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      content = undefined // 二进制文件：不保存内容，仅记录元信息
    }
    return { kind: 'file', path: target, existed: true, content, size: stat.size }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { kind: 'file', path: target, existed: false }
    }
    return null // 权限等其它错误：快照失败，标记不可补偿
  }
}

/** fs-write / fs-edit：覆盖或新建文件。补偿 = 恢复原内容或删除新文件。 */
class FsWriteCompensator implements Compensator {
  readonly kind = 'fs-write' as const
  readonly compensable = true

  async snapshot(exec: ToolExecutionLike): Promise<Snapshot> {
    const target = filePathOf(exec.arguments)
    if (!target) return null
    return snapshotFile(target)
  }

  buildAction(
    snapshot: Snapshot,
    _exec: ToolExecutionLike,
    result: ToolResultLike,
  ): CompensationAction | null {
    if (result.isError) return null // 写操作失败：无副作用可补偿
    if (!snapshot || snapshot.kind !== 'file') return null
    if (!snapshot.existed) {
      // 原文件不存在：补偿 = 删除这次新建的文件
      return { type: 'delete-file', path: snapshot.path }
    }
    if (snapshot.content === undefined) {
      return { type: 'manual', hint: `文件已存在但为二进制，无法自动恢复：${snapshot.path}` }
    }
    return { type: 'restore-file', path: snapshot.path, content: snapshot.content }
  }
}

/** fs-delete：删除文件。补偿 = 写回原内容。 */
class FsDeleteCompensator implements Compensator {
  readonly kind = 'fs-delete' as const
  readonly compensable = true

  async snapshot(exec: ToolExecutionLike): Promise<Snapshot> {
    const target = filePathOf(exec.arguments)
    if (!target) return null
    return snapshotFile(target)
  }

  buildAction(
    snapshot: Snapshot,
    _exec: ToolExecutionLike,
    result: ToolResultLike,
  ): CompensationAction | null {
    if (result.isError) return null
    if (!snapshot || snapshot.kind !== 'file') return null
    if (!snapshot.existed) return { type: 'none' } // 删除不存在的文件：无需补偿
    if (snapshot.content === undefined) {
      return { type: 'manual', hint: `被删文件为二进制，无法自动恢复：${snapshot.path}` }
    }
    return { type: 'restore-file', path: snapshot.path, content: snapshot.content }
  }
}

/** bash：无法自动补偿，仅记录命令供审计与人工回滚。 */
class BashCompensator implements Compensator {
  readonly kind = 'bash' as const
  readonly compensable = false

  async snapshot(exec: ToolExecutionLike): Promise<Snapshot> {
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const command = typeof args['command'] === 'string' ? args['command'] : ''
    return { kind: 'bash', command }
  }

  buildAction(snapshot: Snapshot): CompensationAction | null {
    if (!snapshot || snapshot.kind !== 'bash') return null
    return {
      type: 'manual',
      hint: `bash 副作用无法自动回滚，请人工核查并回退命令：${snapshot.command.slice(0, 200)}`,
    }
  }
}

/** http：网络请求，视为不可补偿写操作（仅审计）。 */
class HttpCompensator implements Compensator {
  readonly kind = 'http' as const
  readonly compensable = false

  async snapshot(): Promise<Snapshot> {
    return null
  }

  buildAction(): CompensationAction | null {
    return { type: 'none' }
  }
}

/** 未匹配到补偿器时的兜底：不记录快照、不补偿。 */
class NoneCompensator implements Compensator {
  readonly kind = 'none' as const
  readonly compensable = false

  async snapshot(): Promise<Snapshot> {
    return null
  }

  buildAction(): CompensationAction | null {
    return null
  }
}

/** 内置补偿器注册表（按 CompensationKind 索引）。 */
export const builtinCompensators: ReadonlyMap<CompensationKind, Compensator> = new Map(
  [
    new FsWriteCompensator(),
    new FsDeleteCompensator(),
    new BashCompensator(),
    new HttpCompensator(),
    new NoneCompensator(),
  ].map((compensator) => [compensator.kind, compensator]),
)

/** 执行一条补偿动作。restore-file / delete-file 落盘；manual / none 无操作。 */
export async function compensate(action: CompensationAction): Promise<void> {
  switch (action.type) {
    case 'restore-file': {
      if (!action.path || action.content === undefined) {
        throw new Error(`restore-file 缺少 path 或 content：${JSON.stringify(action)}`)
      }
      const dir = path.dirname(action.path)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(action.path, action.content, 'utf8')
      return
    }
    case 'delete-file': {
      if (!action.path) throw new Error(`delete-file 缺少 path：${JSON.stringify(action)}`)
      await fsp.rm(action.path, { force: true })
      return
    }
    case 'manual':
    case 'none':
      return // 无操作
  }
}

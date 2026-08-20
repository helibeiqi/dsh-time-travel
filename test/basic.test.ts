/**
 * dsh-time-travel 基本测试（node:test + 真实 cordis Context）。
 *
 * 通过事件分发模拟一次工具调用管线：
 *   ctx.waterfall('tools/pre-execute', exec, next)  → 前状态快照
 *   实际执行副作用（直接操作文件系统）
 *   ctx.emit('tools/result', exec, result)          → 构建补偿 + 审计 + 入栈
 * 然后调用 ctx.timeTravel.rewindTo() 验证工作区被恢复。
 */
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'
import type { TimeTravelServiceLike, ToolExecutionLike, ToolResultLike } from '../src/types.js'

/**
 * 测试用 Context 断言：cordis 的 Events 接口在 pnpm 隔离安装下不可增强
 * （ctx.waterfall / ctx.emit 的 keyof Events 约束无法识别自定义事件名），
 * 此处一次性断言到内部实现，测试体内保持类型安全。
 */
interface TestContext {
  waterfall(name: string, ...args: unknown[]): Promise<unknown>
  emit(name: string, ...args: unknown[]): void
  timeTravel: TimeTravelServiceLike
}

function asTestContext(ctx: Context): TestContext {
  return ctx as unknown as TestContext
}

/** 轮询等待文件出现（audit 落盘是 fire-and-forget 异步）。 */
async function waitForFile(file: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      await access(file)
      return
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`等待文件超时：${file}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

interface RunOptions {
  ctx: TestContext
  dir: string
}

/** 建独立 Context + 临时目录，并 apply 插件（turnGapMs=0：每次调用独立 turn）。 */
async function setup(): Promise<{ ctx: TestContext; dir: string }> {
  const raw = new Context()
  const ctx = asTestContext(raw)
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-time-travel-'))
  apply(raw, {
    turnGapMs: 0,
    audit: { enabled: true, logPath: path.join(dir, 'audit-log.jsonl') },
    dryRun: false,
  })
  return { ctx, dir }
}

/** 模拟一次 write 工具调用（快照 → 真实写文件 → result）。 */
async function runWrite(
  opts: RunOptions,
  callId: string,
  file: string,
  content: string,
  agent: { sessionId: string },
): Promise<void> {
  const exec: ToolExecutionLike = {
    callId,
    name: 'write',
    arguments: { path: file, content },
    agent,
  }
  const next = async () => ({ kind: 'allow' } as const)
  await opts.ctx.waterfall('tools/pre-execute', exec, next)
  await writeFile(file, content, 'utf8')
  const result: ToolResultLike = { isError: false, content: [], value: {} }
  opts.ctx.emit('tools/result', exec, result)
}

/** 模拟一次 bash 调用（快照 → result，无真实执行）。 */
function runBash(
  opts: RunOptions,
  callId: string,
  command: string,
  agent: { sessionId: string },
): void {
  const exec: ToolExecutionLike = { callId, name: 'bash', arguments: { command }, agent }
  const result: ToolResultLike = { isError: false, content: [], value: {} }
  opts.ctx.emit('tools/result', exec, result)
}

test('rewindTo 恢复被覆盖的文件（前状态快照 → 覆盖 → 倒序补偿）', async () => {
  const opts = await setup()
  try {
    const file = path.join(opts.dir, 'a.txt')
    await writeFile(file, 'original', 'utf8')
    await runWrite(opts, 'c1', file, 'changed', { sessionId: 's1' })
    assert.equal(await readFile(file, 'utf8'), 'changed')

    const report = await opts.ctx.timeTravel.rewindTo('T1')
    assert.equal(report.rewound, 1)
    assert.equal(report.failed, 0)
    assert.equal(report.details[0]?.status, 'rewound')
    assert.equal(await readFile(file, 'utf8'), 'original')
    assert.equal(opts.ctx.timeTravel.records().length, 0) // 已撤销的记录被移除
  } finally {
    await rm(opts.dir, { recursive: true, force: true })
  }
})

test('rewindTo 删除新建文件（原文件不存在 → 补偿为删除）', async () => {
  const opts = await setup()
  try {
    const file = path.join(opts.dir, 'new.txt')
    await runWrite(opts, 'c1', file, 'created', { sessionId: 's1' })
    assert.equal(await readFile(file, 'utf8'), 'created')

    const report = await opts.ctx.timeTravel.rewindTo('T1')
    assert.equal(report.rewound, 1)
    assert.equal(report.details[0]?.action, 'delete-file')
    await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(opts.dir, { recursive: true, force: true })
  }
})

test('危险 shell 命中审计规则并落盘 audit-log.jsonl', async () => {
  const opts = await setup()
  try {
    runBash(opts, 'c1', 'rm -rf /tmp/doomed', { sessionId: 's1' })
    const logFile = path.join(opts.dir, 'audit-log.jsonl')
    await waitForFile(logFile)
    const lines = (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean)
    assert.ok(lines.length >= 1)
    const entry = JSON.parse(lines[0]!) as {
      toolName: string
      hits: { ruleId: string; severity: string }[]
    }
    assert.equal(entry.toolName, 'bash')
    const critical = entry.hits.find((hit) => hit.ruleId === 'dangerous-shell')
    assert.ok(critical, '应命中 dangerous-shell 规则')
    assert.equal(critical!.severity, 'critical')
  } finally {
    await rm(opts.dir, { recursive: true, force: true })
  }
})

# dsh-time-travel

给 DeepSeek Harness (DSH) 的 Cordis 插件：**可逆时间旅行与审计** —— 为工具副作用建立「前状态快照 → 执行 → 补偿操作」链路，提供 `rewindTo(turnId)` 按轮次倒序恢复工作区，并内置审计规则引擎把危险操作落盘 `audit-log.jsonl`。

兼容 DSH `0.1.0-rc.6`（cordis `4.x` / schemastery `3.x`）。**请勿裸装 `@latest`**，以本仓库版本为准。

## 功能定位

一句话：**把"模型用工具改坏了工作区"这件事变得可逆且可审计**。

- 监听 `tools/pre-execute` / `tools/result` 工具管线事件，对 `fs.write` / `fs.delete` / `bash` / `http.request` 四类工具建立快照与补偿；
- `ctx.timeTravel.rewindTo(turnId)`：按轮次**倒序**执行补偿，恢复工作区到指定轮次之前；
- 审计规则引擎：命中危险 shell、敏感路径写、不可补偿写操作后，追加一行 JSON 到 `audit-log.jsonl`；
- 全部副作用经 `ctx.on()` 注册，插件卸载时自动撤销，不污染 dsh 工具管线（快照/审计失败都会被包含，绝不影响工具执行）。

## 安装

```bash
# 在插件工程根目录执行（本目录绝对路径）
dsh plugin --profile web add /absolute/path/to/dsh-time-travel

# 或手动打包安装（绕过 pnpm forwarder 时的等价路径）
npm pack && cd ~/.dsh/profiles/web && npm install /absolute/path/to/dsh-time-travel-0.1.0.tgz --no-save --no-audit --no-fund
```

安装后重启 dsh web（端口 `3080`）生效。插件挂载后：

- `ctx.timeTravel` 可用（`rewindTo` / `rewindAll` / `records` / `clear`）；
- 当前目录生成 `audit-log.jsonl`（可用 `audit.logPath` 配置）。

## 配置

插件导出 schemastery `Config`，可在 dsh 的插件配置面板 / profile 中覆盖：

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `turnGapMs` | number | `5000` | 同一会话内两次工具调用超过该间隔（ms）则开启新轮次；`0` = 每次调用独立成轮 |
| `audit.enabled` | boolean | `true` | 是否启用审计规则引擎 |
| `audit.logPath` | string | `audit-log.jsonl` | 审计日志输出路径（JSON Lines，相对 cwd） |
| `audit.rules` | dict\<boolean\> | 全部 `true` | 按规则 id 开关：`dangerous-shell` / `sensitive-path-write` / `non-compensable-write` / `delete-whole-dir` |
| `watchTools` | dict\<kind\> | 见下表 | 工具名 → 补偿器类别映射 |
| `maxRecords` | number | `10000` | 内存保留的最大工具记录数（超出丢弃最旧；审计日志不受影响） |
| `dryRun` | boolean | `false` | `true` 时 rewind 只出报告、不实际执行补偿 |

`watchTools` 默认映射（按 DSH 0.1.0-rc.6 实际工具名 + 通用桥接名）：

| 工具名 | 补偿器类别 | 可自动补偿 |
| --- | --- | --- |
| `write` / `edit` | `fs-write` | ✅ 恢复原内容 / 删除新建 |
| `delete` | `fs-delete` | ✅ 写回原内容 |
| `bash` | `bash` | ❌ 仅审计 + manual 提示 |
| `pwsh` | `bash` | ❌ 仅审计（Windows 上 dsh 的 bash 工具实际注册名为 `pwsh`，PowerShell） |
| `http.request` | `http` | ❌ 仅审计 |

## 最小使用示例

```ts
import { Context } from '@deepseek-ai/cordis'
import { apply } from 'dsh-time-travel'

// 插件被 dsh 加载后，apply 已执行；以下仅为编程调用示例
const ctx: Context = /* dsh 注入的根 Context */

// 模型调用 write 覆盖了 a.txt 之后：
const report = await ctx.timeTravel.rewindTo('T3') // 撤销 T3 及之后所有工具副作用
// report: { requestedTurnId: 'T3', rewound: 2, skipped: 1, failed: 0, details: [...] }

// 查看当前记录（可按会话过滤）
const records = ctx.timeTravel.records('session-abc123')

// 全部回退
await ctx.timeTravel.rewindAll()
```

审计日志示例（`audit-log.jsonl`）：

```json
{"at":"2026-08-20T08:00:00.000Z","turnId":"T1","sessionId":"s1","callId":"c1","toolName":"bash","kind":"bash","isError":false,"hits":[{"ruleId":"dangerous-shell","severity":"critical","message":"bash 命令命中高危模式（rm -rf / mkfs / dd 写盘 / shutdown / curl|sh 等）"}],"command":"rm -rf /tmp/doomed"}
```

## 与 dsh-replay / dsh-turn-rewind 的差异

| | dsh-time-travel | dsh-replay | dsh-turn-rewind |
| --- | --- | --- | --- |
| 关注对象 | 工作区**文件系统副作用**的可逆补偿 | 会话事件日志的**重放**（时序复现） | 会话状态按轮次的**回退**（消息层） |
| 回滚手段 | 工具调用级**前状态快照 + 补偿操作**（restore/delete） | 按日志重新派发事件 | 截断 / 重建轮次内的消息 |
| 审计 | ✅ 内置规则引擎（危险 shell / 敏感路径 / 不可补偿写） | 通常依赖日志本身 | 视实现而定 |
| 对外 API | `ctx.timeTravel` Service（rewindTo / records） | 重放驱动 | 轮次回退 API |
| 不可补偿操作 | 显式标记 `manual` 并审计，交由人工处理 | 重放无法改变历史副作用 | 消息回退不触碰文件系统 |

一句话：`dsh-replay` / `dsh-turn-rewind` 处理的是"**对话/会话**怎么回到过去"，本插件处理的是"**工作区文件**怎么回到过去"，两者互补；对不可自动补偿的副作用（bash / http），本插件选择**审计留痕 + 人工回滚**而非冒险猜测。

## 开发

```bash
pnpm install
pnpm run check   # tsc --noEmit，严格模式零错误
pnpm run build   # tsc → lib/
pnpm test        # node --test（含 rewindTo 恢复文件的端到端事件测试）
```

## License

MIT

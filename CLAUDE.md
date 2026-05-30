# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目概述

Obsidian 插件，通过 Dropbox 自动同步笔记库。核心是**状态文件驱动的增量同步**，不依赖 WebSocket 或长连接。

---

## 开发命令

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（监听文件变化自动重编译）
npm run build        # 生产构建（tsc 检查 + esbuild 打包）
```

TypeScript 仅做类型检查（`tsc -noEmit`），实际编译由 esbuild 完成。产物为 `main.js`。

---

## 代码架构

### 核心模块

| 文件 | 职责 |
|---|---|
| `src/main.ts` | 插件入口、生命周期、命令、状态栏 |
| `src/dropbox-auth.ts` | OAuth 授权（PKCE）、Token 刷新 |
| `src/settings.ts` | 设置面板 UI、导入导出模态框 |
| `src/sync-engine.ts` | 同步引擎核心 — 状态管理、文件操作、冲突检测 |

### 同步原理

**状态文件驱动**：本地 `state.json` + 远程 `.sync_state.json` 各保存一份文件状态（版本号 + SHA-256 hash）。同步时对比两端状态，版本号更高者说明更新。

**版本号推进规则**：
- 文件内容改变或新增 → 本地版本号 +1
- 文件删除 → 版本号 +1，`exists: false`
- 两端 hash 相同 → 认为内容一致，无需传输

**同步流程**（`syncNow` → `runSync`）：
1. 确保远程目录存在
2. 加载本地状态
3. 扫描本地文件 + 计算 hash → 版本号推进
4. 下载远程状态（远程无状态文件时，枚举实际远程文件作为初始状态）
5. 对比两端状态 → 决议上传/下载/删除操作
6. **每执行一个操作后立即保存本地状态**（崩溃恢复点）
7. 保存本地状态（兜底）
8. 上传远程状态到 Dropbox

**关键行为**：
- Token 自动刷新：API 返回 401 时自动刷新 token 并重试一次
- 远程目录自动创建：API 返回 409（目录不存在）时，自动创建父目录后重试
- 保存时上传（`modify` / `create` 事件）：2000ms 防抖，调用 `uploadFile`（单文件，不走完整 syncNow 流程）
- 下载时遇 409 not_found → 标记 `exists: false`，继续同步，不中断

### 路径映射

- `relativePath(absolutePath)` — 去掉 `localPrefix` 得到相对路径
- `localToRemote(localPath)` — 相对路径 → 远程完整路径（`remoteBasePath` + 相对路径）
- `remoteToLocal(remotePath)` — 远程路径 → 本地相对路径（加上 `localPrefix` 前缀）
- `relativeRemotePath(remoteLower)` — 从远程路径中提取相对于 `remoteBasePath` 的部分

### 移动端兼容

- `getFs()` 惰性 `require("fs")`，移动端返回 null
- 状态文件回退：通过 `vault.adapter.read/write` 读写 `.obsidian/plugins/obsidian-dropbox-sync/state.json`
- 授权时 `require("electron")` 仅在桌面端执行，移动端走 `window.open`

### 文件结构

```
src/
├── main.ts           # 插件入口、命令、事件注册、状态栏
├── dropbox-auth.ts   # OAuth PKCE、Token 读写
├── settings.ts       # 设置面板 + 导入导出模态框
└── sync-engine.ts    # 同步引擎（状态文件驱动）
    ├── FileStateEntry { v, exists, h }
    ├── SyncState { files }
    └── REMOTE_STATE_FILENAME = ".sync_state.json"
```

---

## 行为准则

### Karpathy 准则

**权衡**：偏向谨慎而非速度。简单任务自行判断。

**1. 编码前先思考**
- 明确陈述假设。不确定就问。
- 存在多种解释时，列出它们——不要默默选择。
- 有更简单的方案就说。必要时敢于反驳。
- 有不清楚的地方就停下。说出哪里模糊。然后提问。

**2. 简单优先**
- 不添加需求之外的功能。
- 单次使用的代码不抽象。
- 不加入未请求的"灵活性"或"可配置性"。
- 不处理不可能的场景的错误。
- 如果能写 50 行就别写 200 行，该重写就重写。

**3. 精准修改**
- 只碰必须改的地方。
- 不"改进"相邻的代码、注释或格式。
- 不重构没坏的东西。
- 匹配现有风格，即使你自己会不同写法。
- 发现无关的死代码，提出来——不要删除。
- 删除你的修改导致的未使用导入/变量/函数。
- 验证标准：每一行修改都能追溯到用户的请求。

**4. 目标驱动执行**
- 将任务转化为可验证的目标。
- 多步骤任务中，先陈述简要计划。
- 强的成功标准让你能独立循环。弱标准需要不断确认。

**5. 中文思维与回答**
- 用中文思考问题、用中文编写代码注释、用中文输出结果。
- 代码中的标识符保持英文原名不变，仅注释和输出使用中文。

### Caveman 准则

**每条回复都保持**，无多次轮换后重置，无填充漂移。只有说 "stop caveman" 或 "normal mode" 才关闭。

默认强度：**full****。切换：`/caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra`。

**规则**：删除冠词、填充词、客套话、含糊词。碎片句 OK。技术术语精确。代码块不变。

句式：`[东西] [动作] [原因]。[下一步]。`

**强度等级**：

| 等级 | 变化 |
|---|---|
| **lite** | 去填充词/含糊词，保留冠词和完整句子。专业但精简 |
| **full** | 去冠词，碎片句 OK，短同义词。经典 caveman 风格 |
| **ultra** | 缩写散文词，去连词，因果用箭头（X → Y）。代码符号、函数名、API 名、错误字符串：永不缩写 |
| **wenyan-lite** | 半古典。去填充词/含糊词但保留语法结构，古典风格 |
| **wenyan-full** | 极致古典简洁。全文言文。80-90% 字数压缩。 |
| **wenyan-ultra** | 在保留古典感的同时极度缩写。最高压缩，极简 |

**自动清晰模式**：安全警告、不可逆操作确认、多步骤序列中易误解时，退出 caveman。明确部分完成后恢复。
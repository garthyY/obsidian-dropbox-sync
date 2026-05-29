# Obsidian Dropbox Sync

一款 Obsidian 插件，通过 Dropbox 自动同步你的笔记库。

## 功能

- **自动同步** — 文件保存后自动上传到 Dropbox
- **多种同步方向** — 仅上传 / 仅下载 / 双向同步
- **增量同步** — 只同步修改过的文件，减少 API 调用
- **冲突处理** — 双向模式下自动检测冲突，保留双方版本
- **中文本地化** — 全中文界面
- **状态栏指示** — 实时显示同步状态

## 安装

1. 下载 `main.js`、`manifest.json`、`styles.css` 三个文件
2. 复制到 vault 的 `.obsidian/plugins/obsidian-dropbox-sync/` 目录
3. 重启 Obsidian
4. 设置 → 第三方插件 → 启用 **Dropbox Sync**

> 如果目录不存在，手动创建即可。

## 配置

### 1. 创建 Dropbox App

前往 [Dropbox Developer Console](https://www.dropbox.com/developers/apps)：

1. **创建应用** → Choose an API: **Dropbox API**
2. **选择权限类型**: **Scoped Access**
3. **选择文件夹类型**: **App folder**（推荐）或 **Full Dropbox**
4. **命名应用**: 例如 `MyObsidianSync`

### 2. 配置权限

创建后在 **Permissions** 标签页勾选：

| 权限 | 用途 |
|---|---|
| `files.metadata.read` | 读取文件列表 |
| `files.content.read` | 下载文件 |
| `files.content.write` | 上传文件 |

点击 **Submit** 保存。

### 3. 配置 OAuth 重定向

在 **OAuth 2** 标签页添加重定向 URI：

```
http://127.0.0.1:54219/
```

> 必须完全一致，包括末尾的 `/`。

### 4. 复制 App Key

在 **Settings** 标签页复制 **App Key**（不是 App Secret）。

### 5. 插件中授权

1. 打开 Obsidian → 设置 → **Dropbox Sync**
2. 填入 **App Key**
3. 点击 **授权 Dropbox** → 浏览器中完成授权
4. 浏览器跳转后复制地址栏完整网址 → 回到 Obsidian 粘贴
5. 授权完成后即可使用

## 设置项

| 设置 | 默认值 | 说明 |
|---|---|---|
| App Key | — | Dropbox 应用 Key |
| 同步方向 | 上传 | 上传/下载/双向 |
| 远程路径 | `/Apps/ObsidianSync` | Dropbox 上的同步目录 |
| 本地路径前缀 | 留空 | 只同步 vault 的子目录 |
| 最大文件大小 | 50 MB | 超过此大小的文件跳过 |
| 保存时自动同步 | 开启 | 文件保存后自动上传 |

## 同步方向

| 方向 | 行为 |
|---|---|
| **上传** | vault → Dropbox，本地为主，安全 |
| **下载** | Dropbox → vault，远程覆盖本地 |
| **双向** | 两边合并，冲突时保留双方版本 |

### 冲突处理（双向模式）

当一个文件在本地和远程都在上次同步后被修改时，插件会：

- 本地版本 → 上传覆盖远程
- 远程旧版本 → 另存为 `.conflict.YYYY-MM-DD-HH-MM-SS.md`

不会丢失任何一方的修改。

## 开发

```bash
# 安装依赖
cd obsidian-dropbox-sync
npm install

# 开发模式（监听文件变化自动重编译）
npm run dev

# 生产构建
npm run build
```

### 项目结构

```
obsidian-dropbox-sync/
├── manifest.json           # 插件元信息
├── styles.css              # 样式
├── esbuild.config.mjs      # 构建配置
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts             # 插件入口、生命周期、命令
│   ├── settings.ts         # 设置面板 UI
│   ├── dropbox-auth.ts     # Dropbox OAuth 授权
│   └── sync-engine.ts      # 同步引擎核心
└── main.js                 # 编译产物
```

## 工作原理

```
┌─────────────────┐         ┌─────────────────┐
│   Obsidian vault │  ───→  │    Dropbox API   │
│   (插件监听保存)  │  ←───  │  /Apps/Obsidian/ │
└─────────────────┘         └─────────────────┘
         │                          │
         │    临时 HTTP 服务器        │
         │    (54319 端口)           │
         └──── OAuth 授权 ──────────┘
```

- 授权时启动本地临时服务器接收 Dropbox 回调
- 同步时对比文件修改时间，只传输变更部分
- 每 10 次增量同步后自动做一次全量扫描兜底

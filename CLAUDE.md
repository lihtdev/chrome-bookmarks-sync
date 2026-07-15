# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Chrome 书签同步助手 —— 一个 Manifest V3 浏览器扩展，通过 Gitee OpenAPI 将 Chrome 书签以 JSON 文件（`bookmarks.json`）形式存入 Gitee 仓库，实现多设备书签同步。面向无法使用 Chrome 官方同步服务的国内用户。

无构建步骤、无依赖管理、无测试框架。代码为原生 ES6+，直接由浏览器加载运行。

## 开发与调试

- **加载扩展**：Chrome → `chrome://extensions/` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择项目根目录。
- **应用改动**：修改代码后，在扩展管理页点击该扩展的「刷新/更新」按钮；改 `background.js`（service worker）后尤其需要手动刷新。
- **调试 service worker**：扩展卡片上的「service worker」链接打开 `background.js` 的 DevTools，`console.log` 输出在此查看。
- **调试弹窗**：在弹窗上右键 →「检查」打开 `popup.js` 的 DevTools。
- 没有 lint / build / test 命令。验证改动靠手动操作书签并观察 DevTools 日志与徽章变化。

## 架构

### 三个执行环境，各自独立的 `GiteeAPI`

扩展运行在三个互不共享 JS 上下文的环境中，每个环境都各自持有一份 `GiteeAPI` 类：

- **`js/background.js`** — service worker，长驻后台。监听 `chrome.bookmarks.*` 事件、定时同步（1 小时）、维护徽章。内含一份完整的 `GiteeAPI` 类定义（service worker 无法访问 `window`）。
- **`js/popup.js`** — 弹窗上下文。负责登录授权、手动同步、差异比较。通过 `js/gitee.js` 引入的 `window.GiteeAPI` 工作。
- **`js/bookmarks-view.js`** — 书签树查看页（`bookmarks-view.html`）。

⚠️ 修改 `GiteeAPI` 时要同步改两处：`js/gitee.js`（popup 用）和 `js/background.js`（service worker 内嵌副本）。两者当前存在差异，例如 `background.js` 的 `getBookmarks`/`getFileSha` 多了 `token_expired` 处理与空内容判断，而 `gitee.js` 版本没有。

### 状态全在 `chrome.storage.local`

同步逻辑的核心状态都持久化在 `chrome.storage.local`，键名约定如下：

| 键 | 含义 |
|---|---|
| `giteeAuth` | 登录态对象 `{ clientId, clientSecret, repo, token, userName, name, avatarUrl }` |
| `localBookmarks` / `localBookmarksHash` / `localBookmarksUpdatedTime` | 本地书签栏快照、哈希、更新时间 |
| `cloudBookmarks` / `cloudBookmarksHash` / `cloudBookmarksUpdatedTime` | 云端书签快照、哈希、更新时间 |
| `lastSyncTime` | 最近一次成功同步时间 |

**只同步书签栏**（id == `'1'`，由 `retrieveBookmarksBar` 提取），不包含「其他书签」。

### 智能双向同步决策（`syncBookmarksIfLoggedIn`）

`background.js` 中的核心算法，三种情况：

1. 本地空 / 云端有 → 拉取云端到本地（`mergeCloudBookmarksToLocal`，增量合并）。
2. 云端空 / 本地有 → 推送本地到云端。
3. 两边都有 → 比较哈希；哈希相同则只刷新时间戳；不同则比较**更新时间**决定方向（新的覆盖旧的）。

更新时间的判定是关键且微妙：通过「当前哈希 vs 存储中保存的哈希」是否变化来判断这一侧是否被改动过（`background.js:180-201`）。`updateBadge` 故意只更新 `cloudBookmarksHash` 而不更新 `cloudBookmarksUpdatedTime`，避免徽章刷新误把云端时间戳改成当前时间从而错误判定方向（见 `background.js:483-490` 注释）。改动同步逻辑前务必读这段注释。

### 哈希计算（`calculateBookmarksHash` / `sanitizeBookmarkNode`）

采用白名单方式：递归清理节点后只保留 `title` / `index` / `url` / `children`，再算 32 位哈希。目的是让浏览器未来新增的原生字段不破坏哈希稳定性。修改书签数据结构时不要轻易调整白名单字段。

### 增量合并（`mergeNodeChildren`）

按 `normalizeKey(title)`（小写去空白）匹配同父子节点，匹配后递归合并子节点并处理 `index` 排序变化；本地多余的同名节点删除，云端多出的节点创建。同名节点用数组处理，取首个匹配。

### Token 过期处理

Gitee access token 失效时 API 返回 401，`GiteeAPI` 各方法抛 `Error('token_expired')`。调用方捕获后调 `refreshAccessToken()`（重新走 `launchWebAuthFlow` 授权流程，**interactive**）换取新 token 并写回 `giteeAuth`，然后重试一次原请求。该模式在 `background.js` 和 `popup.js` 中均重复实现。

### popup ↔ background 通信

popup 通过 `chrome.runtime.sendMessage({ action: 'updateBadge' })` 请求后台刷新徽章；`background.js` 在 `onMessage` 监听器中处理。仅此一种消息类型。

## 代码约定

- 注释、日志、UI 文案均使用中文。
- 不引入任何 npm 依赖、不添加构建步骤；保持纯静态资源扩展形态。
- service worker 中无法用 `window.*`，新增的后台 API 需直接定义在 `background.js` 内，而非 `gitee.js`。

## 关键限制

- Manifest V3 service worker 会被浏览器按需休眠；`setInterval(AUTO_SYNC_INTERVAL)` 并不可靠，真正可靠的同步触发点是 `chrome.bookmarks.*` 事件监听与扩展重新启动时的 `initAutoSync()`。
- 书签栏以外的书签不参与同步。
- `bookmarks.json` 存在 Gitee 仓库根目录，文件覆盖式更新（依赖 `sha` 判定新建 POST / 更新 PUT）。

// Chrome书签同步助手 - 后台脚本

// 自动同步间隔（分钟），通过 chrome.alarms 调度
const AUTO_SYNC_INTERVAL_MINUTES = 60; // 1小时

// 同步并发锁：合并过程中 chrome.bookmarks.create/update/move/removeTree 会触发
// onCreated/onChanged/onMoved/onRemoved 事件，若不拦截会重入 syncBookmarksIfLoggedIn，
// 导致重入的 sync 误判方向、把含半成品/重复节点的本地树推到云端。
let isSyncing = false;
let pendingSync = false;

// 加载差异计数共享模块（countBookmarks/buildBookmarkMap/compareBookmarks），
// 与 popup 共用同一份，保证同步消息里的变更数量与 popup 数量区口径一致。
// importScripts 须在顶层调用；路径相对 service worker 所在目录(js/)，
// background.js 与 bookmark-diff.js 同在 js/ 目录，故直接写文件名。
importScripts('bookmark-diff.js');

// 监听书签变化
chrome.bookmarks.onCreated.addListener(() => {
    console.log('书签已创建，准备同步');
    syncBookmarksIfLoggedIn();
    updateBadge();
});

chrome.bookmarks.onRemoved.addListener(() => {
    console.log('书签已删除，准备同步');
    syncBookmarksIfLoggedIn();
    updateBadge();
});

chrome.bookmarks.onChanged.addListener(() => {
    console.log('书签已更改，准备同步');
    syncBookmarksIfLoggedIn();
    updateBadge();
});

chrome.bookmarks.onMoved.addListener(() => {
    console.log('书签已移动，准备同步');
    syncBookmarksIfLoggedIn();
    updateBadge();
});

// 初始化定时同步
function initAutoSync() {
    console.log('初始化自动同步');
    // 立即执行一次同步和徽章更新
    syncBookmarksIfLoggedIn();
    updateBadge();

    // 使用 chrome.alarms 调度定时同步（MV3 下 service worker 会被休眠，
    // setInterval 不可靠；chrome.alarms 可在 SW 唤醒时可靠触发）
    chrome.alarms.create('autoSync', { periodInMinutes: AUTO_SYNC_INTERVAL_MINUTES });
}

// 监听定时器触发
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'autoSync') {
        console.log('执行定时同步（alarm）');
        syncBookmarksIfLoggedIn();
    }
});

// 同步入口（带并发锁）：合并过程中 chrome.bookmarks 写操作会触发书签事件，
// 事件监听器会再次调用本函数。用 isSyncing 合并重入为一次 trailing 同步，
// 避免多个 sync 并发操作同一书签树、误判方向、推送半成品到云端。
async function syncBookmarksIfLoggedIn() {
    if (isSyncing) {
        // 已有同步在进行，标记需要在当前同步结束后再跑一次（合并期间累积的事件）
        pendingSync = true;
        return { success: true, message: '同步进行中，已排队' };
    }
    isSyncing = true;
    try {
        const result = await doSyncBookmarks();
        return result;
    } finally {
        isSyncing = false;
        if (pendingSync) {
            // 合并期间又有书签变化，异步再跑一次（脱离当前调用栈，避免递归栈累积）
            pendingSync = false;
            setTimeout(() => syncBookmarksIfLoggedIn(), 0);
        } else {
            // 无 pending 时刷新徽章（此时 isSyncing=false，不会被 updateBadge 守卫跳过）
            updateBadge();
        }
    }
}

// 如果已登录则同步书签（智能双向同步）—— 实际执行主体，返回 {success, message}
async function doSyncBookmarks() {
    // 默认 noop：覆盖"两边都空"等不匹配任何分支的情况
    let syncResult = { success: true, action: 'noop', message: '本地与云端均为空，无需同步' };
    try {
        // 获取登录信息
        const storageData = await chrome.storage.local.get([
            'giteeAuth',
            'localBookmarks',
            'localBookmarksHash',
            'localBookmarksUpdatedTime',
            'cloudBookmarks',
            'cloudBookmarksHash',
            'cloudBookmarksUpdatedTime'
        ]);

        if (!storageData.giteeAuth) {
            console.log('未登录，跳过同步');
            return { success: false, message: '未登录，请先登录' };
        }

        let giteeAuth = storageData.giteeAuth;

        // 创建 GiteeAPI 实例
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);

        // 获取当前本地书签
        const bookmarks = await chrome.bookmarks.getTree();
        let localBookmarksBar = retrieveBookmarksBar(bookmarks);
        const localIsEmpty = !localBookmarksBar || !localBookmarksBar.children || localBookmarksBar.children.length === 0;

        // 先获取云端最新书签（带 token 过期处理）
        let cloudBookmarks;
        try {
            try {
                cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
            } catch (error) {
                if (error.message === 'token_expired') {
                    console.log('Token 已过期，正在重新授权...');
                    const newToken = await giteeApi.refreshAccessToken();
                    giteeAuth.token = newToken;
                    await chrome.storage.local.set({ giteeAuth: giteeAuth });
                    cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
                    console.log('重新授权成功');
                } else {
                    throw error;
                }
            }
        } catch (error) {
            if (error.message === 'token_expired') {
                console.error('自动同步失败：Token 已过期，重新授权失败');
                return { success: false, action: 'failed', message: 'Token 已过期，重新授权失败，请重试' };
            }
            throw error;
        }

        const cloudIsEmpty = !cloudBookmarks || !cloudBookmarks.children || cloudBookmarks.children.length === 0;

        // ========== 智能同步决策 ==========

        // 情况 1：本地为空，云端有内容 → 从云端拉取到本地
        if (localIsEmpty && !cloudIsEmpty) {
            console.log('本地书签为空，云端有内容，正在从云端拉取到本地...');
            const diffPull1 = compareBookmarks(localBookmarksBar, cloudBookmarks);
            const pulledCount1 = diffPull1.cloudOnlyCount + diffPull1.modifiedCount;
            await mergeCloudBookmarksToLocal(cloudBookmarks);

            // 更新本地存储
            const newLocalBookmarks = await chrome.bookmarks.getTree();
            localBookmarksBar = retrieveBookmarksBar(newLocalBookmarks);
            const localBookmarksHash = calculateBookmarksHash(localBookmarksBar);
            await chrome.storage.local.set({
                'localBookmarks': localBookmarksBar,
                'localBookmarksHash': localBookmarksHash,
                'localBookmarksUpdatedTime': new Date().toISOString()
            });

            // 更新云端哈希（因为内容已经同步）
            const cloudBookmarksHash = calculateBookmarksHash(cloudBookmarks);
            await chrome.storage.local.set({
                'cloudBookmarks': cloudBookmarks,
                'cloudBookmarksHash': cloudBookmarksHash,
                'cloudBookmarksUpdatedTime': new Date().toISOString(),
                'lastSyncTime': new Date().toISOString()
            });

            console.log('已从云端拉取书签到本地');
            syncResult = pulledCount1 > 0
                ? { success: true, action: 'pulled', message: `已从云端拉取 ${pulledCount1} 项变更到本地` }
                : { success: true, action: 'pulled', message: '已从云端拉取书签到本地' };
        }
        // 情况 2：云端为空，本地有内容 → 推送本地到云端
        else if (cloudIsEmpty && !localIsEmpty) {
            console.log('云端书签为空，本地有内容，正在推送本地到云端...');
            const diffPush2 = compareBookmarks(localBookmarksBar, cloudBookmarks);
            const pushedCount2 = diffPush2.localOnlyCount + diffPush2.modifiedCount;
            // 推送到云端
            await giteeApi.syncBookmarks(giteeAuth.userName, giteeAuth.repo, localBookmarksBar);

            // 更新存储
            const localBookmarksHash = calculateBookmarksHash(localBookmarksBar);
            const now = new Date().toISOString();
            await chrome.storage.local.set({
                'localBookmarks': localBookmarksBar,
                'localBookmarksHash': localBookmarksHash,
                'localBookmarksUpdatedTime': now,
                'cloudBookmarks': localBookmarksBar,
                'cloudBookmarksHash': localBookmarksHash,
                'cloudBookmarksUpdatedTime': now,
                'lastSyncTime': now
            });

            console.log('已推送本地书签到云端');
            syncResult = pushedCount2 > 0
                ? { success: true, action: 'pushed', message: `已推送 ${pushedCount2} 项变更到云端` }
                : { success: true, action: 'pushed', message: '已推送本地书签到云端' };
        }
        // 情况 3：两边都有内容 → 比较更新时间，新的覆盖旧的
        else if (!localIsEmpty && !cloudIsEmpty) {
            const localBookmarksHash = calculateBookmarksHash(localBookmarksBar);
            const cloudBookmarksHash = calculateBookmarksHash(cloudBookmarks);

            // 内容已经相同，无需同步
            if (localBookmarksHash === cloudBookmarksHash) {
                console.log('本地和云端内容一致，无需同步');
                syncResult = { success: true, action: 'noop', message: '本地与云端一致，无需同步' };

                // 更新存储的哈希和时间戳（确保一致）
                const now = new Date().toISOString();
                await chrome.storage.local.set({
                    'localBookmarks': localBookmarksBar,
                    'localBookmarksHash': localBookmarksHash,
                    'localBookmarksUpdatedTime': now,
                    'cloudBookmarksHash': localBookmarksHash,
                    'cloudBookmarksUpdatedTime': now,
                    'lastSyncTime': now
                });
            } else {
                // 获取最新的存储数据
                const latestStorage = await chrome.storage.local.get([
                    'localBookmarksHash',
                    'localBookmarksUpdatedTime',
                    'cloudBookmarksHash',
                    'cloudBookmarksUpdatedTime'
                ]);

                // ========== 正确判断更新时间 ==========
                // 1. 如果本地当前哈希 != 存储中保存的本地哈希 → 本地已经修改过 → 本地更新时间 = 当前时间
                // 2. 如果云端当前哈希 != 存储中保存的云端哈希 → 云端已经被他人修改 → 云端更新时间 = 当前时间
                // 3. 否则 → 使用存储中保存的时间
                let localUpdatedTime;
                let cloudUpdatedTime;

                if (latestStorage.localBookmarksHash !== localBookmarksHash) {
                    // 本地哈希变化，说明本地已修改 → 当前时间
                    localUpdatedTime = new Date();
                } else {
                    // 本地没变化，使用存储中的时间
                    localUpdatedTime = new Date(latestStorage.localBookmarksUpdatedTime || 0);
                }

                if (latestStorage.cloudBookmarksHash !== cloudBookmarksHash) {
                    // 云端哈希变化，说明云端已被其他设备修改 → 当前时间
                    cloudUpdatedTime = new Date();
                } else {
                    // 云端没变化，使用存储中的时间
                    cloudUpdatedTime = new Date(latestStorage.cloudBookmarksUpdatedTime || 0);
                }

                // 云端比本地新 → 拉取云端到本地
                if (cloudUpdatedTime > localUpdatedTime) {
                    console.log('云端更新（另一台设备修改），正在拉取到本地...');
                    const diffPull3 = compareBookmarks(localBookmarksBar, cloudBookmarks);
                    const pulledCount3 = diffPull3.cloudOnlyCount + diffPull3.modifiedCount;
                    await mergeCloudBookmarksToLocal(cloudBookmarks);

                    // 更新本地存储
                    const newLocalBookmarks = await chrome.bookmarks.getTree();
                    const updatedLocalBar = retrieveBookmarksBar(newLocalBookmarks);
                    const updatedLocalHash = calculateBookmarksHash(updatedLocalBar);
                    const now = new Date().toISOString();
                    await chrome.storage.local.set({
                        'localBookmarks': updatedLocalBar,
                        'localBookmarksHash': updatedLocalHash,
                        'localBookmarksUpdatedTime': now,
                        'cloudBookmarks': cloudBookmarks,
                        'cloudBookmarksHash': cloudBookmarksHash,
                        'cloudBookmarksUpdatedTime': now,
                        'lastSyncTime': now
                    });
                    syncResult = pulledCount3 > 0
                        ? { success: true, action: 'pulled', message: `已从云端拉取 ${pulledCount3} 项变更到本地` }
                        : { success: true, action: 'pulled', message: '已从云端拉取书签到本地' };
                }
                // 本地比云端新 → 推送本地到云端
                else {
                    console.log('本地更新，正在推送到云端...');
                    const diffPush3 = compareBookmarks(localBookmarksBar, cloudBookmarks);
                    const pushedCount3 = diffPush3.localOnlyCount + diffPush3.modifiedCount;
                    await giteeApi.syncBookmarks(giteeAuth.userName, giteeAuth.repo, localBookmarksBar);

                    const now = new Date().toISOString();
                    await chrome.storage.local.set({
                        'localBookmarks': localBookmarksBar,
                        'localBookmarksHash': localBookmarksHash,
                        'localBookmarksUpdatedTime': now,
                        'cloudBookmarksHash': localBookmarksHash,
                        'cloudBookmarksUpdatedTime': now,
                        'lastSyncTime': now
                    });
                    syncResult = pushedCount3 > 0
                        ? { success: true, action: 'pushed', message: `已推送 ${pushedCount3} 项变更到云端` }
                        : { success: true, action: 'pushed', message: '已推送本地书签到云端' };
                }
            }
        }

        console.log('自动同步完成');
        // 徽章由 syncBookmarksIfLoggedIn 的 finally 统一刷新，此处不再调用
        return syncResult;
    } catch (error) {
        console.error('自动同步失败：', error);
        return { success: false, message: '同步失败：' + (error && error.message ? error.message : String(error)) };
    }
}

// 获取书签栏数据
function retrieveBookmarksBar(bookmarks) {
    let bookmarksBar;
    for (const obj of bookmarks[0].children) {
        if (obj.id == '1') {
            bookmarksBar = obj;
            break;
        }
    }
    return bookmarksBar;
}

// 将云端书签增量合并到本地（只修改变化的节点，不碰未变化的）
async function mergeCloudBookmarksToLocal(cloudBookmarks) {
    // 获取本地书签栏
    const bookmarks = await chrome.bookmarks.getTree();
    const localBookmarksBar = retrieveBookmarksBar(bookmarks);

    // 增量合并根节点（书签栏的直接子节点）
    if (cloudBookmarks.children && localBookmarksBar && localBookmarksBar.children) {
        await mergeNodeChildren('1', cloudBookmarks.children, localBookmarksBar.children);
    } else if (cloudBookmarks.children && (!localBookmarksBar || !localBookmarksBar.children)) {
        // 本地书签栏为空，直接创建所有
        for (const child of cloudBookmarks.children) {
            await createBookmarkNode('1', child);
        }
    }

    console.log('云端书签增量合并到本地完成');
}

// 增量合并一组子节点
async function mergeNodeChildren(parentId, cloudChildren, localChildren) {
    // 创建本地节点标题 → 节点列表 的映射（同一父节点下可能有同名节点，所以用数组）
    const localMap = new Map();
    for (const localNode of localChildren) {
        const key = normalizeKey(localNode.title);
        if (!localMap.has(key)) {
            localMap.set(key, []);
        }
        localMap.get(key).push(localNode);
    }

    // 处理云端每个节点
    for (const cloudNode of cloudChildren) {
        const key = normalizeKey(cloudNode.title);
        const matchingLocalNodes = localMap.get(key) || [];

        if (matchingLocalNodes.length > 0) {
            // 找到匹配节点，取第一个匹配
            const localNode = matchingLocalNodes[0];
            // 从映射中移除（剩下的就是需要删除的）
            matchingLocalNodes.shift();
            if (matchingLocalNodes.length === 0) {
                localMap.delete(key);
            }

            // 比较内容，如果有变化则更新，递归合并子节点
            const needsUpdate = nodeNeedsUpdate(localNode, cloudNode);
            if (needsUpdate) {
                await chrome.bookmarks.update(localNode.id, {
                    title: cloudNode.title,
                    url: cloudNode.url
                });
            }

            // 处理 index（排序位置）变化
            if (localNode.index !== cloudNode.index) {
                await chrome.bookmarks.move(localNode.id, {
                    index: cloudNode.index
                });
            }

            // 递归合并子节点
            if (cloudNode.children && localNode.children) {
                await mergeNodeChildren(localNode.id, cloudNode.children, localNode.children);
            } else if (cloudNode.children && (!localNode.children || localNode.children.length === 0)) {
                // 本地没有子节点，云端有，全部创建
                for (const child of cloudNode.children) {
                    await createBookmarkNode(localNode.id, child);
                }
            }
        } else {
            // 云端有，本地没有 → 创建新节点
            await createBookmarkNode(parentId, cloudNode);
        }
    }

    // 删除本地有但云端没有的节点
    for (const [key, remainingNodes] of localMap) {
        for (const remainingNode of remainingNodes) {
            await chrome.bookmarks.removeTree(remainingNode.id);
        }
    }
}

// 判断节点是否需要更新
function nodeNeedsUpdate(localNode, cloudNode) {
    // 标题不同
    if (localNode.title !== cloudNode.title) {
        return true;
    }
    // URL不同（书签节点）
    if (cloudNode.url && localNode.url !== cloudNode.url) {
        return true;
    }
    // 文件夹节点，子节点数量不同，需要处理子节点，但不需要更新自身
    return false;
}

// 归一化节点名称用于匹配（去除大小写空白差异，增加匹配成功率）
function normalizeKey(title) {
    return title.toLowerCase().replace(/\s+/g, '');
}

// 创建单个书签节点（递归创建子节点）
async function createBookmarkNode(parentId, node) {
    if (node.children) {
        // 文件夹
        const createdFolder = await chrome.bookmarks.create({
            parentId: parentId,
            title: node.title
        });
        // 递归创建子节点
        if (node.children) {
            for (const child of node.children) {
                await createBookmarkNode(createdFolder.id, child);
            }
        }
        return createdFolder;
    } else {
        // 书签
        return await chrome.bookmarks.create({
            parentId: parentId,
            title: node.title,
            url: node.url
        });
    }
}

// 计算书签哈希值
// 白名单方式：只保留我们真正关心的字段，排除其他所有字段
// 这样浏览器新增任何原生字段都不会影响哈希计算
function calculateBookmarksHash(bookmarks) {
    const sanitized = sanitizeBookmarkNode(bookmarks);
    const str = JSON.stringify(sanitized);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString();
}

// 递归清理书签节点，只保留需要的字段
function sanitizeBookmarkNode(node) {
    const cleaned = {};
    // 文件夹和书签都需要 title
    if (node.title !== undefined) {
        cleaned.title = node.title;
    }
    // index: 排序位置，调换顺序会改变，需要参与计算
    if (node.index !== undefined) {
        cleaned.index = node.index;
    }
    // 书签有 url
    if (node.url !== undefined) {
        cleaned.url = node.url;
    }
    // 文件夹有 children，递归清理
    if (node.children && node.children.length > 0) {
        cleaned.children = node.children.map(child => sanitizeBookmarkNode(child));
    }
    return cleaned;
}

// 更新徽章
async function updateBadge() {
    // 同步进行中跳过：避免在合并中途写 localBookmarksHash/cloudBookmarksHash
    // 等存储字段，污染 syncBookmarksIfLoggedIn 的时间戳方向判定。
    // 徽章由 syncBookmarksIfLoggedIn 的 finally 在同步结束后统一刷新。
    if (isSyncing) {
        console.log('同步进行中，跳过徽章更新');
        return;
    }
    try {
        // 读取登录信息与"上次同步基线"哈希/时间戳（只读，不写 storage）
        const storageData = await chrome.storage.local.get(['giteeAuth', 'localBookmarksHash', 'cloudBookmarksHash', 'localBookmarksUpdatedTime', 'cloudBookmarksUpdatedTime']);

        if (!storageData.giteeAuth) {
            // 未登录，清除徽章
            await chrome.action.setBadgeText({ text: '' });
            return;
        }

        // 当前本地书签哈希
        const bookmarks = await chrome.bookmarks.getTree();
        const bookmarksBar = retrieveBookmarksBar(bookmarks);
        const currentLocalHash = calculateBookmarksHash(bookmarksBar);
        const localIsEmpty = !bookmarksBar || !bookmarksBar.children || bookmarksBar.children.length === 0;

        // 取云端最新书签（带 token 过期处理）
        let giteeAuth = storageData.giteeAuth;
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);

        let cloudBookmarks = null;
        try {
            try {
                cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
            } catch (error) {
                if (error.message === 'token_expired') {
                    console.log('Token 已过期，正在重新授权...');
                    const newToken = await giteeApi.refreshAccessToken();
                    giteeAuth.token = newToken;
                    await chrome.storage.local.set({ giteeAuth: giteeAuth });
                    cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
                    console.log('重新授权成功');
                } else {
                    throw error;
                }
            }
        } catch (error) {
            // 云端获取失败（如 token 重新授权失败）：显示错误徽章，不再误清空（避免伪装"一致"）
            console.error('获取云端书签失败：', error);
            await chrome.action.setBadgeText({ text: '×' });
            await chrome.action.setBadgeBackgroundColor({ color: '#F44333' });
            return;
        }

        // 云端哈希（云端为空/文件缺失时为 null，不调用 calculateBookmarksHash(null)）
        const cloudIsEmpty = !cloudBookmarks || !cloudBookmarks.children || cloudBookmarks.children.length === 0;
        const cloudBookmarksHash = cloudIsEmpty ? null : calculateBookmarksHash(cloudBookmarks);

        // 只读判定：不写 storage。存储的 localBookmarksHash/cloudBookmarksHash 只由 doSyncBookmarks
        // 在真正同步时更新，保证 doSyncBookmarks 的"哪边变了"判定基于上次同步基线，不被徽章刷新污染。
        if (cloudBookmarksHash === null) {
            // 云端为空/文件缺失
            if (localIsEmpty) {
                await chrome.action.setBadgeText({ text: '' });
            } else {
                // 本地有内容，云端为空 → 待推送
                await chrome.action.setBadgeText({ text: '↑' });
                await chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
            }
        } else if (currentLocalHash === cloudBookmarksHash) {
            // 本地与云端一致
            await chrome.action.setBadgeText({ text: '' });
        } else {
            // 有差异，方向与 doSyncBookmarks 一致：看哪边相对"上次同步基线"变了
            const localChanged = currentLocalHash !== storageData.localBookmarksHash;
            const cloudChanged = cloudBookmarksHash !== storageData.cloudBookmarksHash;
            const localUpdatedTime = new Date(storageData.localBookmarksUpdatedTime || 0).getTime();
            const cloudUpdatedTime = new Date(storageData.cloudBookmarksUpdatedTime || 0).getTime();
            // cloudNewer：仅云端变 → true；仅本地变 → false；两边都变/都未变 → 时间戳兜底
            const cloudNewer = (cloudChanged && !localChanged)
                ? true
                : ((localChanged && !cloudChanged) ? false : cloudUpdatedTime > localUpdatedTime);
            if (cloudNewer) {
                // 云端比本地新，需要拉取到本地
                await chrome.action.setBadgeText({ text: '↓' });
                await chrome.action.setBadgeBackgroundColor({ color: '#2196F3' });
            } else {
                // 本地比云端新，需要推送到云端
                await chrome.action.setBadgeText({ text: '↑' });
                await chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
            }
        }

    } catch (error) {
        console.error('更新徽章失败：', error);
        // 同步失败，显示红色叉号
        await chrome.action.setBadgeText({ text: '×' });
        await chrome.action.setBadgeBackgroundColor({ color: '#F44333' });
    }
}

// Gitee API 封装
class GiteeAPI {
    constructor(clientId, clientSecret, repo) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.repo = repo;
        this.token = null;
        this.apiBaseUrl = 'https://gitee.com/api/v5';
    }

    // 设置访问令牌
    setToken(token) {
        this.token = token;
    }

    // 获取当前访问令牌
    getToken() {
        return this.token;
    }

    // 获取授权 URL
    getAuthUrl() {
        const redirectUri = chrome.identity.getRedirectURL();
        return `https://gitee.com/oauth/authorize?client_id=${this.clientId}&redirect_uri=${redirectUri}&response_type=code&scope=user_info%20projects`;
    }

    // 通过授权码获取访问令牌
    async getAccessToken(code) {
        const redirectUri = chrome.identity.getRedirectURL();
        const response = await fetch('https://gitee.com/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                client_id: this.clientId,
                client_secret: this.clientSecret,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri
            })
        });
        return await response.json();
    }

    // 刷新访问令牌（重新走授权流程）
    async refreshAccessToken() {
        const authUrl = this.getAuthUrl();
        const redirectUrl = await chrome.identity.launchWebAuthFlow({
            url: authUrl,
            interactive: true
        });

        // 解析授权码
        const urlParams = new URLSearchParams(new URL(redirectUrl).search);
        const code = urlParams.get('code');

        if (!code) {
            throw new Error('未获取到授权码');
        }

        // 获取新的访问令牌
        const tokenResponse = await this.getAccessToken(code);
        if (!tokenResponse.access_token) {
            throw new Error('获取访问令牌失败');
        }

        this.setToken(tokenResponse.access_token);
        return tokenResponse.access_token;
    }

    // 获取文件的 SHA 值（用于更新文件）
    async getFileSha(owner, repo, path) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/repos/${owner}/${repo}/contents/${path}`, {
                headers: {
                    'Authorization': `token ${this.token}`
                }
            });

            if (response.status === 401) {
                throw new Error('token_expired');
            }

            const fileInfo = await response.json();
            return fileInfo.sha;
        } catch (error) {
            if (error.message === 'token_expired') {
                throw error;
            }
            return null;
        }
    }

    // 创建或更新文件
    async createOrUpdateFile(owner, repo, path, content, message, sha = null) {
        const body = {
            access_token: this.token,
            content: btoa(unescape(encodeURIComponent(content))), // Base64 编码
            message: message
        };

        if (sha) {
            body.sha = sha;
        }

        const method = sha ? 'PUT' : 'POST';
        const response = await fetch(`${this.apiBaseUrl}/repos/${owner}/${repo}/contents/${path}`, {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (response.status === 401) {
            throw new Error('token_expired');
        }

        return await response.json();
    }

    // 同步书签到 Gitee
    async syncBookmarks(owner, repo, bookmarksData) {
        const path = 'bookmarks.json';
        const content = JSON.stringify(bookmarksData, null, 2);
        const message = `Sync bookmarks: ${new Date().toISOString()}`;
        
        // 检查文件是否存在
        const sha = await this.getFileSha(owner, repo, path);
        
        // 创建或更新文件
        return await this.createOrUpdateFile(owner, repo, path, content, message, sha);
    }
    
    // 从 Gitee 获取书签
    async getBookmarks(owner, repo) {
        const path = 'bookmarks.json';
        try {
            const response = await fetch(`${this.apiBaseUrl}/repos/${owner}/${repo}/contents/${path}`, {
                headers: {
                    'Authorization': `token ${this.token}`
                }
            });

            if (response.status === 401) {
                throw new Error('token_expired');
            }

            const fileInfo = await response.json();
            if (!fileInfo.content) {
                return null;
            }
            const content = decodeURIComponent(escape(atob(fileInfo.content)));
            return JSON.parse(content);
        } catch (error) {
            if (error.message === 'token_expired') {
                throw error;
            }
            return null;
        }
    }
}

// 监听来自popup的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'updateBadge') {
        console.log('收到更新徽章请求');
        updateBadge();
        sendResponse({ success: true });
        return false;
    }
    if (message.action === 'syncNow') {
        // popup 委托 background 执行同步（popup 不再自己合并，避免跨上下文并发）
        console.log('收到立即同步请求（来自 popup）');
        syncBookmarksIfLoggedIn().then((result) => {
            sendResponse(result || { success: false, message: '同步未执行' });
        });
        return true; // 异步 sendResponse，必须返回 true
    }
    return false;
});

// 启动扩展时初始化
console.log('Chrome书签同步助手后台脚本已启动');
initAutoSync();

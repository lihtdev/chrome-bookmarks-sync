document.addEventListener('DOMContentLoaded', function() {

    // 登录按钮
    document.getElementById('login-btn').addEventListener('click', login);

    // 退出登录按钮
    document.getElementById('logout-btn').addEventListener('click', logout);

    // 立即同步按钮
    document.getElementById('start-sync-btn').addEventListener('click', syncBookmarks);

    // 查看书签按钮
    document.getElementById('view-bookmarks-btn').addEventListener('click', openBookmarksView);

    // 初始化页面
    init();
});

// 初始化页面
async function init() {
    // 检查是否已登录
    const storageData = await chrome.storage.local.get(['giteeAuth', 'lastSyncTime']);
    const avatar = document.getElementById('user-avatar');
    
    if (storageData.giteeAuth) {
        // 已登录，切换到同步标签
        document.getElementById('login-tab').classList.remove('active-tab');
        document.getElementById('sync-tab').classList.add('active-tab');
        
        // 更新用户信息
        document.getElementById('user-name-span').textContent = storageData.giteeAuth.userName;
        document.getElementById('name-span').textContent = storageData.giteeAuth.name;
        document.getElementById('repo-name-span').textContent = storageData.giteeAuth.repo;
        
        // 更新用户头像
        if (storageData.giteeAuth.avatarUrl) {
            avatar.src = storageData.giteeAuth.avatarUrl;
            avatar.classList.add('show');
        }
        
        // 更新最后同步时间
        if (storageData.lastSyncTime) {
            document.getElementById('last-sync-time-span').textContent = formatDate(storageData.lastSyncTime);
        }
        
        // 更新书签数量
        await updateBookmarkCounts();
    } else {
        // 未登录，隐藏头像
        avatar.classList.remove('show');
    }
}

// 格式化日期
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// 登录功能
async function login() {
    const clientId = document.getElementById('client-id-input').value.trim();
    const clientSecret = document.getElementById('client-secret-input').value.trim();
    const repo = document.getElementById('repo-input').value.trim();
    
    // 验证输入
    if (!clientId || !clientSecret || !repo) {
        showStatus('login', '请填写完整的登录信息', 'error');
        return;
    }
    
    showStatus('login', '正在登录...', 'info');
    
    try {
        // 创建 GiteeAPI 实例
        const giteeApi = new GiteeAPI(clientId, clientSecret, repo);
        
        // 获取授权 URL
        const authUrl = giteeApi.getAuthUrl();
        
        // 发起授权请求
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
        
        // 获取访问令牌
        const tokenResponse = await giteeApi.getAccessToken(code);
        if (!tokenResponse.access_token) {
            throw new Error('获取访问令牌失败');
        }
        
        // 设置访问令牌
        giteeApi.setToken(tokenResponse.access_token);
        
        // 获取用户信息
        const userInfo = await giteeApi.getUserInfo();
        
        // 保存登录信息
        await chrome.storage.local.set({
            giteeAuth: {
                clientId: clientId,
                clientSecret: clientSecret,
                repo: repo,
                token: tokenResponse.access_token,
                userName: userInfo.login,
                avatarUrl: userInfo.avatar_url,
                name: userInfo.name
            }
        });
        
        // 切换到同步标签
        document.getElementById('login-tab').classList.remove('active-tab');
        document.getElementById('sync-tab').classList.add('active-tab');
        
        // 更新用户信息
        document.getElementById('user-name-span').textContent = userInfo.login;
        document.getElementById('name-span').textContent = userInfo.name;
        document.getElementById('repo-name-span').textContent = repo;
        
        // 更新用户头像
        const avatar = document.getElementById('user-avatar');
        avatar.src = userInfo.avatar_url;
        avatar.classList.add('show');
        
        // 更新徽章
        chrome.runtime.sendMessage({ action: 'updateBadge' });
        
        // 更新书签数量
        await updateBookmarkCounts();
        
        showStatus('login', '登录成功', 'success');
    } catch (error) {
        showStatus('login', '登录失败: ' + error.message, 'error');
        console.error('Login error:', error);
    }
}

// 登出功能
async function logout() {
    try {
        // 清除登录信息
        await chrome.storage.local.remove(['giteeAuth', 'lastSyncTime', 'localBookmarksHash', 'cloudBookmarksHash']);
        
        // 切换到登录标签
        document.getElementById('sync-tab').classList.remove('active-tab');
        document.getElementById('login-tab').classList.add('active-tab');
        
        // 清空输入框
        document.getElementById('client-id-input').value = '';
        document.getElementById('client-secret-input').value = '';
        document.getElementById('repo-input').value = '';
        
        // 隐藏用户头像
        const avatar = document.getElementById('user-avatar');
        avatar.classList.remove('show');
        
        // 清除徽章
        await chrome.action.setBadgeText({ text: '' });
        
        showStatus('sync', '已退出登录', 'success');
    } catch (error) {
        showStatus('sync', '退出登录失败: ' + error.message, 'error');
    }
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

// 智能双向同步
async function syncBookmarks() {
    showStatus('sync', '正在智能同步书签...', 'info');

    try {
        // 获取登录信息和存储数据
        const storageData = await chrome.storage.local.get([
            'giteeAuth',
            'localBookmarksUpdatedTime',
            'cloudBookmarksUpdatedTime'
        ]);
        if (!storageData.giteeAuth) {
            throw new Error('未登录，请先登录');
        }

        let giteeAuth = storageData.giteeAuth;

        // 创建 GiteeAPI 实例
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);

        // 获取当前本地书签
        const bookmarks = await chrome.bookmarks.getTree();
        let localBookmarksBar = retrieveBookmarksBar(bookmarks);
        const localIsEmpty = !localBookmarksBar || !localBookmarksBar.children || localBookmarksBar.children.length === 0;

        // 获取云端最新书签（带 token 过期处理）
        let cloudBookmarks;
        try {
            try {
                cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
            } catch (error) {
                if (error.message === 'token_expired') {
                    // Token 过期，使用已缓存的配置重新获取新 token
                    showStatus('sync', 'Token 已过期，正在重新授权...', 'info');
                    const newToken = await giteeApi.refreshAccessToken();
                    giteeAuth.token = newToken;
                    await chrome.storage.local.set({ giteeAuth: giteeAuth });
                    cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
                } else {
                    throw error;
                }
            }
        } catch (error) {
            if (error.message === 'token_expired') {
                throw error;
            }
            throw error;
        }

        const cloudIsEmpty = !cloudBookmarks || !cloudBookmarks.children || cloudBookmarks.children.length === 0;

        // ========== 智能同步决策 ==========
        let syncResultMessage = '';

        // 情况 1：本地为空，云端有内容 → 从云端拉取到本地
        if (localIsEmpty && !cloudIsEmpty) {
            showStatus('sync', '本地为空，正在从云端拉取...', 'info');
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

            // 更新云端存储
            const cloudBookmarksHash = calculateBookmarksHash(cloudBookmarks);
            await chrome.storage.local.set({
                'cloudBookmarks': cloudBookmarks,
                'cloudBookmarksHash': cloudBookmarksHash,
                'cloudBookmarksUpdatedTime': new Date().toISOString(),
                'lastSyncTime': new Date().toISOString()
            });

            syncResultMessage = '已从云端拉取书签到本地，同步完成！';
        }
        // 情况 2：云端为空，本地有内容 → 推送本地到云端
        else if (cloudIsEmpty && !localIsEmpty) {
            showStatus('sync', '云端为空，正在推送本地到云端...', 'info');

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

            syncResultMessage = '已推送本地书签到云端，同步完成！';
        }
        // 情况 3：两边都有内容 → 比较更新时间，新的覆盖旧的
        else if (!localIsEmpty && !cloudIsEmpty) {
            const localBookmarksHash = calculateBookmarksHash(localBookmarksBar);
            const cloudBookmarksHash = calculateBookmarksHash(cloudBookmarks);

            // 获取存储中的原始哈希，判断本地是否已经修改
            const originalStorage = await chrome.storage.local.get([
                'localBookmarksHash',
                'localBookmarksUpdatedTime',
                'cloudBookmarksUpdatedTime'
            ]);

            // 内容已经相同，无需同步
            if (localBookmarksHash === cloudBookmarksHash) {
                await chrome.storage.local.set({
                    'localBookmarks': localBookmarksBar,
                    'localBookmarksHash': localBookmarksHash,
                    'localBookmarksUpdatedTime': new Date().toISOString(),
                    'cloudBookmarksHash': localBookmarksHash,
                    'cloudBookmarksUpdatedTime': new Date().toISOString(),
                    'lastSyncTime': new Date().toISOString()
                });
                syncResultMessage = '本地和云端已经一致，无需同步！';
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
                    showStatus('sync', '云端更新，正在拉取到本地...', 'info');
                    await mergeCloudBookmarksToLocal(cloudBookmarks);

                    // 更新本地存储
                    const newLocalBookmarks = await chrome.bookmarks.getTree();
                    const updatedLocalBar = retrieveBookmarksBar(newLocalBookmarks);
                    const updatedLocalHash = calculateBookmarksHash(updatedLocalBar);
                    await chrome.storage.local.set({
                        'localBookmarks': updatedLocalBar,
                        'localBookmarksHash': updatedLocalHash,
                        'localBookmarksUpdatedTime': new Date().toISOString(),
                        'cloudBookmarks': cloudBookmarks,
                        'cloudBookmarksHash': cloudBookmarksHash,
                        'cloudBookmarksUpdatedTime': new Date().toISOString(),
                        'lastSyncTime': new Date().toISOString()
                    });

                    syncResultMessage = '已从云端拉取更新到本地，同步完成！';
                }
                // 本地比云端新 → 推送本地到云端
                else {
                    showStatus('sync', '本地更新，正在推送到云端...', 'info');
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

                    syncResultMessage = '已推送本地更新到云端，同步完成！';
                }
            }
        }

        // 更新最后同步时间
        const now = new Date().toISOString();
        document.getElementById('last-sync-time-span').textContent = formatDate(now);

        // 更新徽章
        chrome.runtime.sendMessage({ action: 'updateBadge' });

        // 更新书签数量
        await updateBookmarkCounts();

        showStatus('sync', syncResultMessage, 'success');
    } catch (error) {
        if (error.message === 'token_expired') {
            showStatus('sync', 'Token 已过期，重新授权失败，请重试', 'error');
        } else {
            showStatus('sync', '同步失败: ' + error.message, 'error');
        }
        console.error('Sync error:', error);
    }
}

// 从云端获取书签
async function getBookmarksFromCloud() {
    showStatus('sync', '正在从云端获取书签...', 'info');

    try {
        // 获取登录信息
        const storageData = await chrome.storage.local.get(['giteeAuth']);
        if (!storageData.giteeAuth) {
            throw new Error('未登录，请先登录');
        }

        let giteeAuth = storageData.giteeAuth;

        // 创建 GiteeAPI 实例
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);

        // 从 Gitee 获取书签，如果 token 过期则重新认证
        let cloudBookmarks;
        try {
            cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
        } catch (error) {
            if (error.message === 'token_expired') {
                // Token 过期，使用已缓存的配置重新获取新 token
                showStatus('sync', 'Token 已过期，正在重新授权...', 'info');
                const newToken = await giteeApi.refreshAccessToken();

                // 更新存储中的 token
                giteeAuth.token = newToken;
                await chrome.storage.local.set({ giteeAuth: giteeAuth });

                // 使用新 token 重试
                cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
            } else {
                throw error;
            }
        }
        
        if (!cloudBookmarks) {
            showStatus('sync', '云端没有书签数据', 'info');
            return;
        }
        
        // 计算云端书签哈希值
        const cloudBookmarksHash = calculateBookmarksHash(cloudBookmarks);
        
        // 保存到本地存储
        await chrome.storage.local.set({
            'cloudBookmarks': cloudBookmarks,
            'cloudBookmarksHash': cloudBookmarksHash,
            'cloudBookmarksUpdatedTime': new Date().toISOString()
        });
        
        // 更新徽章
        chrome.runtime.sendMessage({ action: 'updateBadge' });
        
        // 更新书签数量显示
        await updateBookmarkCounts();
        
        showStatus('sync', '从云端获取书签成功！', 'success');
        return cloudBookmarks;
    } catch (error) {
        if (error.message === 'token_expired') {
            showStatus('sync', 'Token 已过期，重新授权失败，请重试', 'error');
        } else {
            showStatus('sync', '从云端获取书签失败: ' + error.message, 'error');
        }
        console.error('Get bookmarks error:', error);
        return null;
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

// 计算书签数量
function countBookmarks(bookmarks) {
    let count = 0;
    
    function traverse(node) {
        if (node.children) {
            for (const child of node.children) {
                traverse(child);
            }
        } else {
            count++;
        }
    }
    
    traverse(bookmarks);
    return count;
}

// 比较两个书签树，返回差异信息
function compareBookmarks(localBookmarks, cloudBookmarks) {
    const result = {
        localOnlyCount: 0,  // 本地有而云端没有（未同步到云端）
        cloudOnlyCount: 0,  // 云端有而本地没有（未更新到本地）
        modifiedCount: 0    // 两边都有但内容不同（已修改）
    };

    if (!localBookmarks || !cloudBookmarks) {
        if (!localBookmarks && cloudBookmarks) {
            result.cloudOnlyCount = countBookmarks(cloudBookmarks);
        } else if (localBookmarks && !cloudBookmarks) {
            result.localOnlyCount = countBookmarks(localBookmarks);
        }
        return result;
    }

    // 构建本地书签的映射（用于查找）
    const localMap = new Map();
    buildBookmarkMap(localBookmarks, '', localMap);

    // 构建云端书签的映射
    const cloudMap = new Map();
    buildBookmarkMap(cloudBookmarks, '', cloudMap);

    // 计算本地有而云端没有的
    for (const [key, localNode] of localMap) {
        if (!cloudMap.has(key)) {
            result.localOnlyCount++;
        } else if (localNode.url && localNode.url !== cloudMap.get(key).url) {
            result.modifiedCount++;
        }
    }

    // 计算云端有而本地没有的
    for (const [key, cloudNode] of cloudMap) {
        if (!localMap.has(key)) {
            result.cloudOnlyCount++;
        }
    }

    return result;
}

// 构建书签映射（路径 + 标题 作为 key）
function buildBookmarkMap(node, parentPath, map) {
    const path = parentPath + '/' + node.title;
    
    if (node.url) {
        // 书签节点
        map.set(path, node);
    }
    
    // 递归处理子节点
    if (node.children) {
        for (const child of node.children) {
            buildBookmarkMap(child, path, map);
        }
    }
}

// 更新书签数量显示
async function updateBookmarkCounts() {
    try {
        // 获取登录信息
        const storageData = await chrome.storage.local.get(['giteeAuth', 'localBookmarksHash', 'cloudBookmarksHash', 'localBookmarksUpdatedTime', 'cloudBookmarksUpdatedTime']);
        if (!storageData.giteeAuth) {
            return;
        }

        let giteeAuth = storageData.giteeAuth;

        // 创建 GiteeAPI 实例
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);

        // 获取当前本地书签
        const bookmarks = await chrome.bookmarks.getTree();
        const localBookmarksBar = retrieveBookmarksBar(bookmarks);

        // 获取云端书签，如果 token 过期则重新认证
        let cloudBookmarks;
        try {
            cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
        } catch (error) {
            if (error.message === 'token_expired') {
                // Token 过期，使用已缓存的配置重新获取新 token
                const newToken = await giteeApi.refreshAccessToken();

                // 更新存储中的 token
                giteeAuth.token = newToken;
                await chrome.storage.local.set({ giteeAuth: giteeAuth });

                // 使用新 token 重试
                cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
            } else {
                throw error;
            }
        }

        // 计算差异数量
        let cloudChangesCount = 0;
        let localChangesCount = 0;

        if (cloudBookmarks) {
            // 计算本地和云端的哈希值
            const localHash = calculateBookmarksHash(localBookmarksBar);
            const cloudHash = calculateBookmarksHash(cloudBookmarks);

            // 如果哈希值不同，说明有差异
            if (localHash !== cloudHash) {
                // 获取存储中的哈希和时间戳
                const storedLocalHash = storageData.localBookmarksHash;
                const storedCloudHash = storageData.cloudBookmarksHash;
                const localUpdatedTime = new Date(storageData.localBookmarksUpdatedTime || 0).getTime();
                const cloudUpdatedTime = new Date(storageData.cloudBookmarksUpdatedTime || 0).getTime();

                // 计算书签差异
                const diffResult = compareBookmarks(localBookmarksBar, cloudBookmarks);

                // 根据更新方向确定显示
                if (storedLocalHash && localHash !== storedLocalHash) {
                    // 本地已修改，本地比云端新
                    localChangesCount = diffResult.localOnlyCount + diffResult.modifiedCount;
                    cloudChangesCount = 0;
                } else if (storedCloudHash && cloudHash !== storedCloudHash) {
                    // 云端已修改，云端比本地新
                    cloudChangesCount = diffResult.cloudOnlyCount + diffResult.modifiedCount;
                    localChangesCount = 0;
                } else {
                    // 哈希变化但无法确定方向，使用时间戳判断
                    if (cloudUpdatedTime > localUpdatedTime) {
                        cloudChangesCount = diffResult.cloudOnlyCount + diffResult.modifiedCount;
                        localChangesCount = 0;
                    } else {
                        localChangesCount = diffResult.localOnlyCount + diffResult.modifiedCount;
                        cloudChangesCount = 0;
                    }
                }
            }
        }

        // 更新页面显示
        document.getElementById('cloud-changes-count').textContent = cloudChangesCount;
        document.getElementById('local-changes-count').textContent = localChangesCount;
    } catch (error) {
        console.error('更新书签数量失败：', error);
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

// 显示状态信息
// type: login, sync
// level: info, success, error
function showStatus(type, message, level) {
    const levels = ['info', 'success', 'error'];
    const typeStatusBarIdMappings = {
        login: 'login-status',
        sync: 'sync-status'
    };
    const statusBar = document.getElementById(typeStatusBarIdMappings[type]);
    
    // 移除所有状态类
    levels.forEach(cls => {
        statusBar.classList.remove(cls);
    });
    
    // 添加当前状态类
    statusBar.classList.add(level);
    statusBar.textContent = message;

    
    if (level !== 'info') {
        setTimeout(() => {
            statusBar.textContent = '';
            statusBar.className = 'status';
        }, 3000);
    }
}

// 打开新窗口查看书签
function openBookmarksView() {
    // 获取当前URL的基础路径
    const url = chrome.runtime.getURL('bookmarks-view.html');
    // 创建新窗口
    chrome.windows.create({
        url: url,
        type: 'normal',
        width: 960,
        height: 700
    });
}

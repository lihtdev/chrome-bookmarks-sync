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

// 将云端书签增量合并到本地的逻辑已移至 background.js（service worker），
// popup 不再自行合并，避免与 background 并发操作同一书签树导致重复节点。
// 手动同步通过 sendMessage({action:'syncNow'}) 委托 background 执行。

// 智能双向同步
// 委托 background（service worker）执行，popup 不再自行合并书签树，
// 避免与后台自动同步并发操作同一书签树导致同层级重复同名文件夹。
async function syncBookmarks() {
    showStatus('sync', '正在同步书签...', 'info');

    try {
        const response = await chrome.runtime.sendMessage({ action: 'syncNow' });

        if (response && response.success) {
            // 更新最后同步时间
            const now = new Date().toISOString();
            document.getElementById('last-sync-time-span').textContent = formatDate(now);

            // 刷新书签数量与徽章
            await updateBookmarkCounts();
            chrome.runtime.sendMessage({ action: 'updateBadge' });

            showStatus('sync', response.message || '同步完成', 'success');
        } else {
            showStatus('sync', (response && response.message) || '同步失败', 'error');
        }
    } catch (error) {
        showStatus('sync', '同步失败: ' + error.message, 'error');
        console.error('Sync error:', error);
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

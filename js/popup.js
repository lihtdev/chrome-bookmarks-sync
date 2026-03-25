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

// 同步书签到云端
async function syncBookmarks() {
    showStatus('sync', '正在同步书签...', 'info');
    
    try {
        // 获取登录信息
        const storageData = await chrome.storage.local.get(['giteeAuth']);
        if (!storageData.giteeAuth) {
            throw new Error('未登录，请先登录');
        }
        
        const giteeAuth = storageData.giteeAuth;
        
        // 创建 GiteeAPI 实例
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);
        
        // 获取所有书签
        const bookmarks = await chrome.bookmarks.getTree();
        
        // 获取书签栏数据（只同步书签栏，不同步其他书签）
        const bookmarksBar = retrieveBookmarksBar(bookmarks);
        
        // 计算书签哈希值
        const localBookmarksHash = calculateBookmarksHash(bookmarksBar);
        
        // 保存到本地存储
        await chrome.storage.local.set({
            'localBookmarks': bookmarksBar,
            'localBookmarksHash': localBookmarksHash,
            'localBookmarksUpdatedTime': new Date().toISOString()
        });
        
        // 同步到 Gitee，如果 token 过期则重新认证
        try {
            await giteeApi.syncBookmarks(giteeAuth.userName, giteeAuth.repo, bookmarksBar);
        } catch (error) {
            if (error.message === 'token_expired') {
                // Token 过期，使用已缓存的配置重新获取新 token
                showStatus('sync', 'Token 已过期，正在重新授权...', 'info');
                const newToken = await giteeApi.refreshAccessToken();

                // 更新存储中的 token
                giteeAuth.token = newToken;
                await chrome.storage.local.set({ giteeAuth: giteeAuth });

                // 使用新 token 重试
                await giteeApi.syncBookmarks(giteeAuth.userName, giteeAuth.repo, bookmarksBar);
            } else {
                throw error;
            }
        }
        
        // 更新最后同步时间和云端书签哈希值
        const now = new Date().toISOString();
        await chrome.storage.local.set({
            'lastSyncTime': now,
            'cloudBookmarksHash': localBookmarksHash,
            'cloudBookmarksUpdatedTime': now
        });
        
        // 更新页面显示
        document.getElementById('last-sync-time-span').textContent = formatDate(now);
        
        // 更新徽章
        chrome.runtime.sendMessage({ action: 'updateBadge' });
        
        // 更新书签数量显示
        await updateBookmarkCounts();
        
        showStatus('sync', '同步成功！', 'success');
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
function calculateBookmarksHash(bookmarks) {
    // 移除动态生成的id和dateAdded等字段，只比较实际内容
    const sanitizedBookmarks = JSON.parse(JSON.stringify(bookmarks, (key, value) => {
        if (key === 'id' || key === 'dateAdded' || key === 'dateGroupModified') {
            return undefined;
        }
        return value;
    }));
    
    // 使用JSON字符串生成哈希值
    const str = JSON.stringify(sanitizedBookmarks);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString();
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

// 比较两个书签树，返回差异数量
function compareBookmarks(localBookmarks, cloudBookmarks) {
    // 简单实现：比较书签数量差异
    // 更复杂的实现可以比较每个书签的具体内容
    const localCount = countBookmarks(localBookmarks);
    const cloudCount = countBookmarks(cloudBookmarks);
    
    return Math.abs(localCount - cloudCount);
}

// 更新书签数量显示
async function updateBookmarkCounts() {
    try {
        // 获取登录信息
        const storageData = await chrome.storage.local.get(['giteeAuth']);
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
                // 计算差异数量
                const diffCount = compareBookmarks(localBookmarksBar, cloudBookmarks);
                
                // 更新显示
                cloudChangesCount = diffCount;
                localChangesCount = diffCount;
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

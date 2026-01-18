document.addEventListener('DOMContentLoaded', function() {

    // 登录按钮
    document.getElementById('login-btn').addEventListener('click', login);

    // 退出登录按钮
    document.getElementById('logout-btn').addEventListener('click', logout);
    
    // 立即同步按钮
    document.getElementById('start-sync-btn').addEventListener('click', syncBookmarks);
  
    // 初始化页面
    init();
});

// 初始化页面
async function init() {
    // 检查是否已登录
    const storageData = await chrome.storage.local.get(['giteeAuth', 'lastSyncTime']);
    if (storageData.giteeAuth) {
        // 已登录，切换到同步标签
        document.getElementById('login-tab').classList.remove('active-tab');
        document.getElementById('sync-tab').classList.add('active-tab');
        
        // 更新用户信息
        document.getElementById('user-name-span').textContent = storageData.giteeAuth.userName;
        document.getElementById('repo-name-span').textContent = storageData.giteeAuth.repo;
        
        // 更新最后同步时间
        if (storageData.lastSyncTime) {
            document.getElementById('last-sync-time-span').textContent = formatDate(storageData.lastSyncTime);
        }
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
                userName: userInfo.login
            }
        });
        
        // 切换到同步标签
        document.getElementById('login-tab').classList.remove('active-tab');
        document.getElementById('sync-tab').classList.add('active-tab');
        
        // 更新用户信息
        document.getElementById('user-name-span').textContent = userInfo.login;
        document.getElementById('repo-name-span').textContent = repo;
        
        // 更新徽章
        chrome.runtime.sendMessage({ action: 'updateBadge' });
        
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
        
        // 同步到 Gitee
        await giteeApi.syncBookmarks(giteeAuth.userName, giteeAuth.repo, bookmarksBar);
        
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
        
        showStatus('sync', '同步成功！', 'success');
    } catch (error) {
        showStatus('sync', '同步失败: ' + error.message, 'error');
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
        
        const giteeAuth = storageData.giteeAuth;
        
        // 创建 GiteeAPI 实例
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);
        
        // 从 Gitee 获取书签
        const cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
        
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
        
        showStatus('sync', '从云端获取书签成功！', 'success');
        return cloudBookmarks;
    } catch (error) {
        showStatus('sync', '从云端获取书签失败: ' + error.message, 'error');
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

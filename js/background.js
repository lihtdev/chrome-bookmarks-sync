// Chrome书签同步助手 - 后台脚本

// 自动同步间隔（毫秒）
const AUTO_SYNC_INTERVAL = 60 * 60 * 1000; // 1小时

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
    
    // 设置定时同步
    setInterval(() => {
        console.log('执行定时同步');
        syncBookmarksIfLoggedIn();
        updateBadge();
    }, AUTO_SYNC_INTERVAL);
}

// 如果已登录则同步书签
async function syncBookmarksIfLoggedIn() {
    try {
        // 获取登录信息
        const storageData = await chrome.storage.local.get(['giteeAuth']);
        if (!storageData.giteeAuth) {
            console.log('未登录，跳过同步');
            return;
        }

        let giteeAuth = storageData.giteeAuth;

        // 创建 GiteeAPI 实例
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);

        // 获取所有书签
        const bookmarks = await chrome.bookmarks.getTree();

        // 获取书签栏数据
        const bookmarksBar = retrieveBookmarksBar(bookmarks);

        // 计算并保存本地书签哈希值
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
                console.log('Token 已过期，正在重新授权...');
                const newToken = await giteeApi.refreshAccessToken();

                // 更新存储中的 token
                giteeAuth.token = newToken;
                await chrome.storage.local.set({ giteeAuth: giteeAuth });

                // 使用新 token 重试
                await giteeApi.syncBookmarks(giteeAuth.userName, giteeAuth.repo, bookmarksBar);
                console.log('重新授权成功');
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

        console.log('同步成功，最后同步时间：', now);

        // 更新徽章
        updateBadge();
    } catch (error) {
        if (error.message === 'token_expired') {
            console.error('自动同步失败：Token 已过期，重新授权失败');
        } else {
            console.error('自动同步失败：', error);
        }
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

// 更新徽章
async function updateBadge() {
    try {
        // 获取登录信息
        const storageData = await chrome.storage.local.get(['giteeAuth', 'localBookmarks', 'localBookmarksHash', 'cloudBookmarksHash', 'localBookmarksUpdatedTime', 'cloudBookmarksUpdatedTime']);

        if (!storageData.giteeAuth) {
            // 未登录，清除徽章
            await chrome.action.setBadgeText({ text: '' });
            return;
        }

        // 获取当前本地书签
        const bookmarks = await chrome.bookmarks.getTree();
        const bookmarksBar = retrieveBookmarksBar(bookmarks);
        const currentLocalHash = calculateBookmarksHash(bookmarksBar);

        // 更新本地书签哈希值
        if (currentLocalHash !== storageData.localBookmarksHash) {
            await chrome.storage.local.set({
                'localBookmarksHash': currentLocalHash,
                'localBookmarksUpdatedTime': new Date().toISOString()
            });
        }

        // 获取云端书签信息
        let giteeAuth = storageData.giteeAuth;
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);

        let cloudBookmarks = null;
        let cloudBookmarksHash = null;

        try {
            try {
                cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
            } catch (error) {
                if (error.message === 'token_expired') {
                    // Token 过期，使用已缓存的配置重新获取新 token
                    console.log('Token 已过期，正在重新授权...');
                    const newToken = await giteeApi.refreshAccessToken();

                    // 更新存储中的 token
                    giteeAuth.token = newToken;
                    await chrome.storage.local.set({ giteeAuth: giteeAuth });

                    // 使用新 token 重试
                    cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
                    console.log('重新授权成功');
                } else {
                    throw error;
                }
            }

            if (cloudBookmarks) {
                cloudBookmarksHash = calculateBookmarksHash(cloudBookmarks);

                // 更新云端书签哈希值
                if (cloudBookmarksHash !== storageData.cloudBookmarksHash) {
                    await chrome.storage.local.set({
                        'cloudBookmarksHash': cloudBookmarksHash,
                        'cloudBookmarksUpdatedTime': new Date().toISOString()
                    });
                }
            }
        } catch (error) {
            if (error.message === 'token_expired') {
                console.error('获取云端书签失败：Token 已过期，重新授权失败');
            } else {
                console.error('获取云端书签失败：', error);
            }
        }
        
        // 比较本地和云端书签状态
        const hasLocalChanges = currentLocalHash !== storageData.cloudBookmarksHash;
        const hasCloudChanges = cloudBookmarksHash && cloudBookmarksHash !== currentLocalHash;

        if (hasCloudChanges) {
            // 云端有未同步到本地的书签，显示蓝色向下箭头
            await chrome.action.setBadgeText({ text: '↓' });
            await chrome.action.setBadgeBackgroundColor({ color: '#2196F3' });
        } else if (hasLocalChanges) {
            // 本地有未同步到云端的书签，显示橙色向上箭头
            await chrome.action.setBadgeText({ text: '↑' });
            await chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
        } else {
            // 本地和云端书签一致，显示绿色对勾
            await chrome.action.setBadgeText({ text: '✓' });
            await chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
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
    }
});

// 启动扩展时初始化
console.log('Chrome书签同步助手后台脚本已启动');
initAutoSync();

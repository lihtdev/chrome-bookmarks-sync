// 获取授权用户的资料 https://gitee.com/api/v5/swagger#/getV5User 
// 获取仓库具体路径下的内容 https://gitee.com/api/v5/swagger#/getV5ReposOwnerRepoContents(Path)
// 新建文件 https://gitee.com/api/v5/swagger#/postV5ReposOwnerRepoContentsPath
// 更新文件 https://gitee.com/api/v5/swagger#/putV5ReposOwnerRepoContentsPath

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

    // 获取授权用户的资料
    async getUserInfo() {
        const response = await fetch(`${this.apiBaseUrl}/user`, {
            headers: {
                'Authorization': `token ${this.token}`
            }
        });

        if (response.status === 401) {
            throw new Error('token_expired');
        }

        return await response.json();
    }

    // 获取仓库具体路径下的内容
    async getRepoContent(owner, repo, path) {
        const response = await fetch(`${this.apiBaseUrl}/repos/${owner}/${repo}/contents/${path}`, {
            headers: {
                'Authorization': `token ${this.token}`
            }
        });

        if (response.status === 401) {
            throw new Error('token_expired');
        }

        return await response.json();
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
        return await response.json();
    }

    // 获取文件的 SHA 值（用于更新文件）
    async getFileSha(owner, repo, path) {
        try {
            const fileInfo = await this.getRepoContent(owner, repo, path);
            return fileInfo.sha;
        } catch (error) {
            return null;
        }
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
    // 文件不存在(404)或读取失败时返回 null,与 background 内嵌版语义保持一致,
    // 避免上层(popup 差异计数 / bookmarks-view 页)因 atob(undefined) 抛 TypeError。
    async getBookmarks(owner, repo) {
        const path = 'bookmarks.json';
        try {
            const fileInfo = await this.getRepoContent(owner, repo, path);
            if (!fileInfo || !fileInfo.content) {
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

// 导出 GiteeAPI 类
window.GiteeAPI = GiteeAPI;

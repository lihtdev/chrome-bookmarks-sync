document.addEventListener('DOMContentLoaded', function() {

    // 登录按钮
    document.getElementById('login-btn').addEventListener('click', login);

    // 退出登录按钮
    document.getElementById('logout-btn').addEventListener('click', logout);
    
    // 立即同步按钮
    document.getElementById('start-sync-btn').addEventListener('click', syncBookmarks);
  
});

function login() {
    document.getElementById('login-tab').classList.remove('active-tab');
    document.getElementById('sync-tab').classList.add('active-tab');
}

function logout() {
    document.getElementById('sync-tab').classList.remove('active-tab');
    document.getElementById('login-tab').classList.add('active-tab');
}

// 同步书签到云端
async function syncBookmarks() {
    showStatus('sync', '正在同步书签...', 'info');
    
    try {
        // 获取所有书签
        const bookmarks = await chrome.bookmarks.getTree();
        
        // 获取书签栏数据（只同步书签栏，不同步其他书签）
        const bookmarksBar = retrieveBookmarksBar(bookmarks);
        console.log(JSON.stringify(bookmarksBar));
        
        // 保存到本地存储
        await chrome.storage.local.set({
            'localBookmarks': bookmarksBar,
            'localLastSyncTime': new Date().toISOString()
        });
        
        // 同步到云端
        await syncToCloud(bookmarksBar);
        
        showStatus('sync', '同步成功！', 'success');
    } catch (error) {
        showStatus('sync', '同步失败: ' + error.message, 'error');
    }
}

// 获取书签栏数据
function retrieveBookmarksBar(bookmarks) {
    let bookmarksBar;
    for (const obj of bookmarks[0].children) {
        if (obj.id == '1' && obj.folderType == 'bookmarks-bar') {
            bookmarksBar = obj;
        }
    }
    return bookmarksBar;
}

// 云端同步函数（需要实现具体的云端API）
async function syncToCloud(bookmarksData) {
    // 这里实现同步到云端的逻辑
    // 例如使用 Google Drive API、Dropbox API 或你自己的服务器
    
    // 示例：保存到 Chrome 本地存储（实际使用时需要替换为真实的云端API）
    await chrome.storage.local.set({
        'cloudBookmarks': bookmarksData,
        'cloudLastSyncTime': new Date().toISOString()
    });
    
    // 实际实现可能类似于：
    // const response = await fetch('你的云端API地址', {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify(bookmarksData)
    // });
}

async function getFromCloud() {
    // 从云端获取书签数据
    // 示例：从本地存储获取（实际使用时需要替换为真实的云端API）
    const result = await chrome.storage.local.get(['cloudBookmarks']);
    return result.cloudBookmarks;
    
    // 实际实现可能类似于：
    // const response = await fetch('你的云端API地址');
    // return await response.json();
}

// 显示状态信息
// type: login, sync
// level: info, success, error
function showStatus(type, message, level) {
    let levels = ['info', 'success', 'error'];
    let typeStatusBarIdMappings = {
        login: 'login-status',
        sync: 'sync-status'
    };
    const statusBar = document.getElementById(typeStatusBarIdMappings[type]);
    for (let cls in levels) {
        if (level != cls) {
            statusBar.classList.remove(cls);
        }
    }
    statusBar.classList.add(level);
    statusBar.textContent = message;

    
    if (level !== 'info') {
        setTimeout(() => {
            statusBar.textContent = '';
            statusBar.className = 'status';
        }, 3000);
    }
}

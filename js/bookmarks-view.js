let originalBookmarks = null;
let searchKeyword = '';

document.addEventListener('DOMContentLoaded', function() {
    // 绑定搜索事件
    document.getElementById('search-input').addEventListener('input', handleSearch);

    // 绑定展开/折叠全部按钮
    document.getElementById('expand-all').addEventListener('click', expandAll);
    document.getElementById('collapse-all').addEventListener('click', collapseAll);

    // 加载书签
    loadAndRenderBookmarks();
});

// 加载并渲染书签
async function loadAndRenderBookmarks() {
    try {
        // 从chrome storage获取登录信息
        const storageData = await chrome.storage.local.get(['giteeAuth']);
        if (!storageData.giteeAuth) {
            showError('未找到登录信息，请先在插件中登录');
            return;
        }

        let giteeAuth = storageData.giteeAuth;

        // 创建 GiteeAPI 实例
        const giteeApi = new GiteeAPI(giteeAuth.clientId, giteeAuth.clientSecret, giteeAuth.repo);
        giteeApi.setToken(giteeAuth.token);

        // 从 Gitee 获取书签
        let cloudBookmarks;
        try {
            cloudBookmarks = await giteeApi.getBookmarks(giteeAuth.userName, giteeAuth.repo);
        } catch (error) {
            if (error.message === 'token_expired') {
                // Token 过期，使用已缓存的配置重新获取新 token
                document.getElementById('loading-text').textContent = 'Token 已过期，正在重新授权...';
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
            document.getElementById('loading').style.display = 'none';
            document.getElementById('bookmarks-tree').innerHTML =
                '<div class="bookmarks-empty">云端没有书签数据</div>';
            document.getElementById('total-count').textContent = '0 个书签';
            return;
        }

        // 保存原始书签数据用于搜索
        originalBookmarks = cloudBookmarks;

        // 统计书签数量
        const totalBookmarks = countBookmarks(cloudBookmarks);
        document.getElementById('total-count').textContent = `${totalBookmarks} 个书签`;

        // 渲染书签树
        document.getElementById('loading').style.display = 'none';
        const treeContainer = document.getElementById('bookmarks-tree');
        const treeRoot = renderTreeNode(cloudBookmarks);
        treeContainer.appendChild(treeRoot);
    } catch (error) {
        console.error('加载书签失败:', error);
        if (error.message === 'token_expired') {
            showError('Token 已过期，重新授权失败，请关闭页面重试');
        } else {
            showError('加载失败: ' + error.message);
        }
    }
}

// 显示错误
function showError(message) {
    document.getElementById('loading').style.display = 'none';
    const errorEl = document.getElementById('error');
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}

// 处理搜索
function handleSearch(e) {
    searchKeyword = e.target.value.trim().toLowerCase();
    renderFilteredBookmarks();
}

// 渲染过滤后的书签
function renderFilteredBookmarks() {
    const treeContainer = document.getElementById('bookmarks-tree');
    treeContainer.innerHTML = '';

    if (!originalBookmarks) {
        return;
    }

    if (!searchKeyword) {
        // 无关键词，渲染原始树
        const treeRoot = renderTreeNode(originalBookmarks);
        treeContainer.appendChild(treeRoot);
        return;
    }

    // 搜索过滤
    const filteredTree = filterBookmarks(originalBookmarks, searchKeyword);
    if (!filteredTree || !filteredTree.children || filteredTree.children.length === 0) {
        treeContainer.innerHTML = '<div class="bookmarks-empty">未找到匹配的书签</div>';
        return;
    }

    const treeRoot = renderTreeNode(filteredTree, searchKeyword);
    treeContainer.appendChild(treeRoot);
}

// 过滤书签（递归）
function filterBookmarks(node, keyword) {
    // 如果是书签，检查标题是否匹配
    if (!node.children) {
        if (node.title.toLowerCase().includes(keyword) ||
            (node.url && node.url.toLowerCase().includes(keyword))) {
            return { ...node };
        }
        return null;
    }

    // 如果是文件夹，递归过滤子节点
    const filteredChildren = [];
    if (node.children) {
        for (const child of node.children) {
            const filtered = filterBookmarks(child, keyword);
            if (filtered) {
                filteredChildren.push(filtered);
            }
        }
    }

    // 如果文件夹本身标题匹配，或者有匹配的子节点，保留这个文件夹
    if (node.title.toLowerCase().includes(keyword) || filteredChildren.length > 0) {
        return {
            ...node,
            children: filteredChildren
        };
    }

    return null;
}

// 渲染单个树节点
function renderTreeNode(node, highlightKeyword = '') {
    const isFolder = !!node.children;
    const hasChildren = isFolder && node.children.length > 0;

    const treeNode = document.createElement('div');
    treeNode.className = 'tree-node';

    const nodeContent = document.createElement('div');
    nodeContent.className = 'tree-node-content';

    // 名称
    const nameSpan = document.createElement('span');
    let displayTitle = node.title || '书签栏';

    // 先创建子容器（这样事件绑定时就能正确引用）
    let childrenContainer = null;
    let icon = null;

    if (hasChildren) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';

        // 如果是搜索结果，默认折叠
        if (highlightKeyword) {
            childrenContainer.classList.add('collapsed');
        }
    }

    // 图标（展开/折叠指示器）
    icon = document.createElement('span');
    icon.className = 'tree-icon';

    if (hasChildren) {
        icon.textContent = '▼';

        // 如果是搜索结果，默认折叠
        if (highlightKeyword) {
            icon.classList.add('collapsed');
        }

        icon.addEventListener('click', () => {
            icon.classList.toggle('collapsed');
            childrenContainer.classList.toggle('collapsed');
        });
    } else {
        icon.classList.add('hidden');
    }

    if (isFolder) {
        nameSpan.className = 'folder-name';
        if (highlightKeyword) {
            nameSpan.innerHTML = highlightMatch(displayTitle, highlightKeyword);
        } else {
            nameSpan.textContent = displayTitle;
        }
        if (hasChildren) {
            nameSpan.addEventListener('click', () => {
                icon.classList.toggle('collapsed');
                childrenContainer.classList.toggle('collapsed');
            });
        }
    } else {
        nameSpan.className = 'bookmark-name';
        const link = document.createElement('a');
        link.href = node.url;
        link.target = '_blank';
        if (highlightKeyword) {
            link.innerHTML = highlightMatch(displayTitle, highlightKeyword);
        } else {
            link.textContent = displayTitle;
        }
        nameSpan.appendChild(link);
    }

    // 日期显示
    const date = getNodeDate(node);
    const dateSpan = document.createElement('span');
    dateSpan.className = isFolder ? 'folder-date' : 'bookmark-date';
    dateSpan.textContent = date;

    // URL显示
    if (!isFolder && node.url) {
        const urlSpan = document.createElement('span');
        urlSpan.className = 'bookmark-url';
        let displayUrl = node.url;
        if (displayUrl.length > 60) {
            displayUrl = displayUrl.substring(0, 60) + '...';
        }
        if (highlightKeyword) {
            urlSpan.innerHTML = highlightMatch(displayUrl, highlightKeyword);
        } else {
            urlSpan.textContent = displayUrl;
        }
        nodeContent.appendChild(nameSpan);
        nodeContent.appendChild(urlSpan);
        nodeContent.appendChild(dateSpan);
    } else {
        nodeContent.appendChild(icon);
        nodeContent.appendChild(nameSpan);
        nodeContent.appendChild(dateSpan);
    }

    treeNode.appendChild(nodeContent);

    // 处理子节点
    if (hasChildren && childrenContainer) {
        node.children.forEach(child => {
            const childNode = renderTreeNode(child, highlightKeyword);
            childrenContainer.appendChild(childNode);
        });

        treeNode.appendChild(childrenContainer);
    }

    return treeNode;
}

// 高亮匹配的关键词
function highlightMatch(text, keyword) {
    if (!keyword) {
        return text;
    }
    const regex = new RegExp(`(${keyword})`, 'gi');
    return text.replace(regex, '<span class="highlight">$1</span>');
}

// 统计书签数量（排除文件夹）
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
        hash = hash & hash;
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

// 展开全部文件夹
function expandAll() {
    const allIcons = document.querySelectorAll('.tree-icon:not(.hidden)');
    const allChildren = document.querySelectorAll('.tree-children');

    allIcons.forEach(icon => icon.classList.remove('collapsed'));
    allChildren.forEach(children => children.classList.remove('collapsed'));
}

// 折叠全部文件夹
function collapseAll() {
    const allIcons = document.querySelectorAll('.tree-icon:not(.hidden)');
    const allChildren = document.querySelectorAll('.tree-children');

    allIcons.forEach(icon => icon.classList.add('collapsed'));
    allChildren.forEach(children => children.classList.add('collapsed'));
}

// 获取节点日期并格式化
function getNodeDate(node) {
    let timestamp = null;
    // 优先使用修改时间，如果没有则使用创建时间
    if (node.dateGroupModified) {
        timestamp = Number(node.dateGroupModified);
    } else if (node.dateAdded) {
        timestamp = Number(node.dateAdded);
    }
    // Chrome书签时间戳是微秒（16位数字），需要转换为毫秒（13位）
    // 如果数字位数大于13，说明是微秒，需要除以1000
    if (timestamp && timestamp.toString().length > 13) {
        timestamp = Math.floor(timestamp / 1000);
    }
    if (!timestamp || timestamp <= 0) {
        return '';
    }
    const date = new Date(timestamp);
    // 格式化为 年-月-日 时:分
    return `${date.getFullYear()}-${padZero(date.getMonth() + 1)}-${padZero(date.getDate())} ${padZero(date.getHours())}:${padZero(date.getMinutes())}`;
}

// 补零
function padZero(num) {
    return num < 10 ? '0' + num : num;
}

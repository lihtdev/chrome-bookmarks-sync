// 书签差异计数共享模块
// 供 popup（通过 <script> 标签加载）与 background service worker（通过 importScripts 加载）共用，
// 保证两侧对"本地独有 / 云端独有 / 已修改"的计数口径完全一致。
// 使用普通 function 声明作为全局函数，兼容两种加载方式。

// 统计书签树中的书签节点数量（不包含文件夹）
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

// 构建书签映射（路径 + 标题 作为 key），用于差异比较
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

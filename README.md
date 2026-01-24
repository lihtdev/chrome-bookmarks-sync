# Chrome 书签同步助手

## 项目简介

Chrome 书签同步助手是一个 Chrome 浏览器扩展，专为国内用户设计，解决无法访问 Chrome 官方书签同步服务的问题。该扩展通过调用 Gitee OpenAPI，将书签数据以 JSON 格式存储在 Gitee 仓库中，实现多设备间的书签同步。

## 功能特点

- ✅ **书签同步**：将 Chrome 书签同步到 Gitee 仓库
- ✅ **自动同步**：监听书签变化，自动同步到云端
- ✅ **手动同步**：支持用户手动触发同步
- ✅ **同步状态**：显示同步状态和最后同步时间
- ✅ **差异提示**：显示云端和本地书签的差异数量
- ✅ **徽章提示**：扩展图标显示同步状态
- ✅ **用户友好**：简洁直观的用户界面

## 技术栈

- Chrome Extension (Manifest V3)
- JavaScript (ES6+)
- Gitee OpenAPI
- CSS3
- HTML5

## 安装方法

### 方法一：从源码安装

1. 克隆或下载本项目到本地
2. 打开 Chrome 浏览器，进入扩展管理页面（chrome://extensions/）
3. 启用右上角的「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择项目根目录，完成安装

### 方法二：从 Chrome Web Store 安装

（未来计划发布到 Chrome Web Store）

## 使用说明

### 首次使用

1. 点击扩展图标，打开登录页面
2. 填写以下信息：
   - **Client ID**：从 Gitee 开发者设置获取
   - **Client Secret**：从 Gitee 开发者设置获取
   - **仓库名称**：用于存储书签的 Gitee 仓库名称
3. 点击「登录」按钮，跳转到 Gitee 授权页面
4. 授权成功后，自动返回扩展页面

### 同步书签

- **自动同步**：当书签发生变化时，扩展会自动同步到 Gitee
- **手动同步**：点击「立即同步」按钮，手动触发同步

### 查看同步状态

- 扩展图标会显示同步状态：
  - 红色向下箭头 (↓)：云端有未同步到本地的书签
  - 绿色向上箭头 (↑)：本地有未同步到云端的书签
  - 无图标：本地和云端书签一致

## 配置说明

### 获取 Gitee Client ID 和 Client Secret

1. 登录 [Gitee](https://gitee.com/)
2. 进入「设置」→「第三方应用」→「OAuth 应用」
3. 点击「创建应用」
4. 填写应用信息：
   - 应用名称：Chrome 书签同步助手
   - 应用描述：同步 Chrome 书签到 Gitee
   - 应用主页：https://gitee.com
   - 授权回调地址：`chrome-extension://{your-extension-id}/`（安装扩展后可在扩展管理页面查看）
5. 创建成功后，即可获取 Client ID 和 Client Secret

### 仓库设置

- 确保你有权限访问指定的 Gitee 仓库
- 扩展会在仓库中创建 `bookmarks.json` 文件存储书签数据

## 项目结构

```
chrome-bookmarks-sync/
├── css/
│   └── popup.css          # 弹出页面样式
├── images/
│   ├── bookmark.png       # 扩展图标（PNG）
│   ├── bookmark.svg       # 扩展图标（SVG）
│   └── gitee.svg          # Gitee 图标
├── js/
│   ├── background.js      # 后台脚本
│   ├── gitee.js           # Gitee API 封装
│   └── popup.js           # 弹出页面脚本
├── manifest.json          # 扩展配置文件
├── popup.html             # 弹出页面
└── README.md              # 项目说明文档
```

## 核心文件说明

- **manifest.json**：扩展的配置文件，包含权限声明、后台脚本等
- **background.js**：后台脚本，处理书签变化监听和自动同步
- **gitee.js**：Gitee API 封装，处理与 Gitee OpenAPI 的交互
- **popup.js**：弹出页面脚本，处理用户交互和同步操作
- **popup.html**：扩展的弹出页面，包含登录和同步界面
- **popup.css**：弹出页面的样式文件

## 开发说明

### 开发环境

- Chrome 浏览器
- 文本编辑器（如 VS Code）

### 开发流程

1. 克隆项目到本地
2. 在 Chrome 浏览器中加载扩展
3. 修改代码后，在扩展管理页面点击「更新」按钮
4. 测试修改效果

### 代码规范

- 使用 ES6+ 语法
- 保持代码简洁清晰
- 添加必要的注释
- 遵循 Chrome Extension 开发最佳实践

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE) 文件。

## 贡献

欢迎提交 Issue 和 Pull Request！

## 联系方式

如有问题或建议，欢迎通过以下方式联系：

- GitHub Issues：[提交 Issue](https://github.com/lihtdev/chrome-bookmarks-sync/issues)
- 邮件：lihaitao.me@qq.com

## 更新日志

### v1.0.0（2026-01-19）

- 首次发布
- 实现书签同步到 Gitee 仓库
- 支持自动同步和手动同步
- 显示同步状态和差异提示
- 用户友好的界面

## 致谢

感谢 Gitee 提供的 OpenAPI 服务，以及所有为 Chrome 扩展开发做出贡献的开发者！

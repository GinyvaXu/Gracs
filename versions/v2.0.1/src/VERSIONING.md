# 版本管理规范 — GinyScreen

> 本项目遵循 `project-git-mgmt` 通用 Git 版本管理规范。

## 分支模型

```
main   ──────●────────●────────●────→（稳定发布，只接受 develop 合并）
            /        /        /
develop ───●────●───●────●───●───●──→（日常开发）
```

- `main`：只接受来自 `develop` 的合并（`git merge --no-ff`），每个节点对应一个已发布版本
- `develop`：所有开发工作在此进行，不额外创建 feature 分支

## 版本号制度

采用**语义化版本 (Semantic Versioning)**：`v<MAJOR>.<MINOR>.<PATCH>`

| 变更类型 | 版本号变化 |
|----------|-----------|
| Bug 修复 | 递增修订号（1.4.0 → 1.4.1） |
| 新功能 / UI 改进 | 递增次版本号（1.4.x → 1.5.0） |
| 不兼容大改 | 递增主版本号（1.x → 2.0.0） |

规则：
- **单一来源**：版本号只写在 `VERSION` 文件；构建脚本 `scripts/sync-version.mjs` 自动同步到 package.json，禁止手写
- 预发布用 `-beta.N` / `-rc.N`

## 发布流程（新版本 vX.Y.Z）

1. **Preflight**：`git status --porcelain` 干净、`git fetch` 后与远端无冲突、无密钥/敏感文件
2. **改版本**：只改 `VERSION` 文件；**每次迭代先构建 Debug 版**：`npm run dist:debug`（供试用/报障）→ 功能验证通过后再 `npm run dist:portable` / `npm run dist:installer`（构建前自动同步版本号）
3. **归档**：`npm run archive` — 构建产物复制到 `versions/vX.Y.Z/dist|installer`，源码快照到 `versions/vX.Y.Z/src`
4. **两次提交**：
   ```bash
   git add server/ client/ desktop/ scripts/ assets/ docs/ source/ README.md package.json VERSION CHANGELOG.md AGENTS.md
   git commit -m "release: vX.Y.Z"
   git add versions/vX.Y.Z/src/
   git commit -m "build: vX.Y.Z 源码快照归档"
   ```
5. **合并与发布**：
   ```bash
   git checkout main
   git merge --no-ff develop
   git push origin main develop
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
6. **上传安装包**：`installer\*.exe` 上传到 GitHub Releases（`gh release create vX.Y.Z ...`）
7. **更新清单**：发布后更新根目录 `update.json` 的 version/url/notes（客户端自动更新据此工作）

## 产物清理

- 二进制（`installer/`、`versions/*/dist/`、`versions/*/installer/`）不入库，依赖 GitHub Releases 归档
- 上传 Releases 后，本地 `installer/`、`versions/*/dist/` 只保留最近 1~2 版
- 源码快照（`versions/*/src/`）只增不删，永久入库

## 版本历史

| 版本 | 说明 |
|------|------|
| v0.4.0 | 更名 GinyScreen；新增 Debug 版 exe 构建（dist:debug）与自动更新（update.json + updater.js）；顶部菜单/弹窗修复；产物全英文命名 |
| v0.3.0 | 顶部菜单栏统筹全部功能；完整设置/快捷键/关于面板 |
| v0.2.0 | 新增 Electron 桌面版：内嵌信令服务器、系统托盘、最小化到托盘、日志落盘；新增便携版 / 安装版 exe 构建；新增 assets 图标与 build/installer/versions 目录规范 |
| v0.1.0 | 首个可用版本：WebRTC mesh 语音 + 屏幕共享 + 文字聊天；Debug 版日志系统与自包含导出包 |

# Hierarchical Git Branches

一个轻量 VS Code 插件，用 `/` 分隔符把 Git 分支显示成树形结构。

## 功能

- 在 Source Control 侧边栏新增 `Branch Tree` 视图
- 按 `/` 自动分级展示本地和远程分支
- 点击叶子分支执行 checkout
- 点击远程分支会尝试创建对应的 tracking branch
- 右键任意分支，可以从当前分支创建新分支
- 标记当前分支
- 支持刷新、`fetch --all --prune --tags`、复制分支名

## 本地运行

1. 用 VS Code 打开 `vscode-branch-tree` 目录
2. 按 `F5`
3. 在弹出的 Extension Development Host 中打开你的 Git 仓库
4. 进入 Source Control 侧边栏，找到 `Branch Tree`

如果视图里显示 `There is no data provider registered that can provide view data.`，先停止调试再重新按 `F5`。

## 打包 VSIX

需要 Node.js。第一次打包前安装依赖：

```bash
npm install
```

生成安装包：

```bash
npm run package
```

输出文件：

```text
dist/hierarchical-git-branches.vsix
```

## GitHub Release

把这个目录作为独立 GitHub 仓库推送后，创建 tag 即可自动发布 VSIX：

```bash
git tag v0.0.1
git push origin v0.0.1
```

GitHub Actions 会创建 Release，并把 `dist/hierarchical-git-branches.vsix` 上传为附件。

如果要手动触发发布，也可以在 GitHub 仓库的 `Actions -> Release VSIX -> Run workflow` 里运行。

## Remote SSH 安装

在 VS Code 连接到某台服务器后：

1. 打开 Extensions 面板
2. 点右上角 `...`
3. 选择 `Install from VSIX...`
4. 选择 Release 下载的 `.vsix`

同一台服务器安装一次，该服务器上的所有项目都能使用。不同服务器需要分别安装。

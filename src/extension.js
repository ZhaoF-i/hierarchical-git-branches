const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

const SCM_VIEW_ID = 'hierarchicalGitBranches.scmView';
const ACTIVITY_VIEW_ID = 'hierarchicalGitBranches.activityView';
const FAVORITES_KEY = 'hierarchicalGitBranches.favorites';

class BranchNode {
  constructor(label, type, fullName = '', children = [], source = '', meta = {}) {
    this.label = label;
    this.type = type;
    this.fullName = fullName;
    this.children = children;
    this.source = source;
    this.meta = meta;
  }
}

class BranchTreeProvider {
  constructor(context) {
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._onDidRefresh = new vscode.EventEmitter();
    this.onDidRefresh = this._onDidRefresh.event;
    this.repoRoot = undefined;
    this.currentBranch = '';
    this.roots = [];
    this.filterText = '';
    this.favorites = new Set(context.workspaceState.get(FAVORITES_KEY, []));
    this.refresh();
  }

  refresh() {
    this.repoRoot = findRepositoryRoot();
    this.currentBranch = this.repoRoot ? getCurrentBranch(this.repoRoot) : '';
    this.roots = this.repoRoot
      ? buildTree(this.repoRoot, this.currentBranch, this.filterText, this.favorites)
      : [];
    this._onDidChangeTreeData.fire();
    this._onDidRefresh.fire();
  }

  async setFilter(filterText) {
    this.filterText = filterText.trim();
    this.refresh();
  }

  async clearFilter() {
    this.filterText = '';
    this.refresh();
  }

  async toggleFavorite(node) {
    if (!node?.fullName) {
      return;
    }

    const key = favoriteKey(node);
    if (this.favorites.has(key)) {
      this.favorites.delete(key);
    } else {
      this.favorites.add(key);
    }

    await this.context.workspaceState.update(FAVORITES_KEY, Array.from(this.favorites).sort());
    this.refresh();
  }

  findCurrentLocalNode() {
    if (!this.currentBranch || this.currentBranch.startsWith('HEAD detached at ')) {
      return undefined;
    }

    return findNode(this.roots, (node) => node.type === 'branch' && node.source === 'local' && node.fullName === this.currentBranch);
  }

  getTreeItem(node) {
    const hasChildren = node.children.length > 0;
    const item = new vscode.TreeItem(
      node.label,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    item.tooltip = node.fullName || node.label;

    if (node.type === 'current') {
      item.description = 'current branch';
      item.iconPath = new vscode.ThemeIcon('check');
      item.contextValue = 'current';
    } else if (node.type === 'filter') {
      item.description = this.filterText;
      item.iconPath = new vscode.ThemeIcon('filter');
      item.contextValue = 'filter';
    } else if (node.type === 'section') {
      item.iconPath = new vscode.ThemeIcon(sectionIcon(node.label));
      item.contextValue = 'section';
    } else if (node.type === 'group') {
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'group';
    } else if (node.type === 'message') {
      item.iconPath = new vscode.ThemeIcon('info');
      item.contextValue = 'message';
    } else {
      item.description = branchDescription(node, this.currentBranch, this.favorites);
      item.iconPath = new vscode.ThemeIcon(node.fullName === this.currentBranch ? 'check' : 'git-branch');
      item.contextValue = 'branch';
      item.command = {
        command: 'hierarchicalGitBranches.checkout',
        title: 'Checkout Branch',
        arguments: [node]
      };
    }

    return item;
  }

  getChildren(node) {
    if (!this.repoRoot) {
      return [new BranchNode('No Git repository found', 'message')];
    }

    return node ? node.children : this.roots;
  }
}

function activate(context) {
  const provider = new BranchTreeProvider(context);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'hierarchicalGitBranches.refresh';
  statusBarItem.tooltip = 'Current Git branch';
  context.subscriptions.push(statusBarItem);

  const scmTree = vscode.window.createTreeView(SCM_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  const activityTree = vscode.window.createTreeView(ACTIVITY_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  context.subscriptions.push(scmTree, activityTree);

  const updateStatusBar = () => {
    if (!provider.repoRoot) {
      statusBarItem.hide();
      return;
    }

    statusBarItem.text = `$(git-branch) ${provider.currentBranch || 'No branch'}`;
    statusBarItem.show();
  };

  const revealCurrent = () => {
    const currentNode = provider.findCurrentLocalNode();
    if (!currentNode) {
      return;
    }

    setTimeout(() => {
      scmTree.reveal(currentNode, { select: false, focus: false, expand: 3 }).then(undefined, () => {});
      activityTree.reveal(currentNode, { select: false, focus: false, expand: 3 }).then(undefined, () => {});
    }, 100);
  };

  updateStatusBar();
  revealCurrent();
  context.subscriptions.push(provider.onDidRefresh(() => {
    updateStatusBar();
    revealCurrent();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.refresh', () => provider.refresh()));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.filterBranches', async () => {
    const filterText = await vscode.window.showInputBox({
      title: 'Filter Branches',
      prompt: 'Show branches containing this text',
      value: provider.filterText,
      placeHolder: 'noiseAware'
    });

    if (filterText !== undefined) {
      await provider.setFilter(filterText);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.clearFilter', async () => {
    await provider.clearFilter();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.fetch', async () => {
    if (!provider.repoRoot) {
      vscode.window.showWarningMessage('No Git repository found.');
      return;
    }

    await runGitTask(provider.repoRoot, ['fetch', '--all', '--prune', '--tags'], 'Fetching branches and tags');
    provider.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.checkout', async (node) => {
    if (!provider.repoRoot || !node?.fullName || node.type !== 'branch') {
      return;
    }

    const branchName = node.fullName;
    const target = node.source === 'remote' && branchName.startsWith('origin/')
      ? branchName.slice('origin/'.length)
      : branchName;
    const args = node.source === 'remote' && branchName.startsWith('origin/')
      ? ['switch', '--track', '-c', target, branchName]
      : ['switch', branchName];

    try {
      await runGitTask(provider.repoRoot, args, `Checking out ${target}`);
    } catch (error) {
      if (node.source === 'remote' && branchName.startsWith('origin/')) {
        await runGitTask(provider.repoRoot, ['switch', target], `Checking out ${target}`);
      } else {
        throw error;
      }
    } finally {
      provider.refresh();
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.createBranchFromSelected', async (node) => {
    if (!provider.repoRoot || !node?.fullName) {
      return;
    }

    const baseBranch = node.fullName;
    const branchName = await vscode.window.showInputBox({
      title: 'Create Branch From Selected',
      prompt: `Base branch: ${baseBranch}`,
      placeHolder: 'feature/new-branch',
      validateInput: (value) => validateBranchName(value, provider.repoRoot)
    });

    if (!branchName) {
      return;
    }

    const trimmed = branchName.trim();
    await runGitTask(provider.repoRoot, ['switch', '-c', trimmed, baseBranch], `Creating ${trimmed} from ${baseBranch}`);
    provider.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.copyBranchName', async (node) => {
    if (node?.fullName) {
      await vscode.env.clipboard.writeText(node.fullName);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.copyCheckoutCommand', async (node) => {
    if (node?.fullName) {
      const command = node.source === 'remote'
        ? `git switch --track -c ${stripRemoteName(node.fullName)} ${node.fullName}`
        : `git switch ${node.fullName}`;
      await vscode.env.clipboard.writeText(command);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.toggleFavorite', async (node) => {
    await provider.toggleFavorite(node);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.pushCurrentBranch', async () => {
    if (!provider.repoRoot || !provider.currentBranch || provider.currentBranch.startsWith('HEAD detached at ')) {
      vscode.window.showWarningMessage('No current local branch to push.');
      return;
    }

    await runGitTask(provider.repoRoot, ['push', '-u', 'origin', provider.currentBranch], `Pushing ${provider.currentBranch}`);
    await runGitTask(provider.repoRoot, ['fetch', 'origin', provider.currentBranch], `Refreshing ${provider.currentBranch}`);
    provider.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.updateSelectedBranch', async (node) => {
    if (!provider.repoRoot || !node?.fullName) {
      return;
    }

    if (node.source === 'remote') {
      const remote = parseRemoteBranch(node.fullName);
      if (!remote) return;
      await runGitTask(provider.repoRoot, ['fetch', remote.remote, remote.branch], `Fetching ${node.fullName}`);
      provider.refresh();
      return;
    }

    const upstream = getUpstreamBranch(provider.repoRoot, node.fullName);
    if (!upstream) {
      await runGitTask(provider.repoRoot, ['fetch', '--all', '--prune'], 'Fetching remotes');
      provider.refresh();
      return;
    }

    if (node.fullName === provider.currentBranch) {
      await runGitTask(provider.repoRoot, ['pull', '--ff-only'], `Pulling ${node.fullName}`);
    } else {
      await runGitTask(provider.repoRoot, ['fetch', upstream.remote, `${upstream.branch}:${node.fullName}`], `Updating ${node.fullName}`);
    }
    provider.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.renameBranch', async (node) => {
    if (!provider.repoRoot || !node?.fullName) {
      return;
    }

    const oldName = node.source === 'remote' ? stripRemoteName(node.fullName) : node.fullName;
    const newName = await vscode.window.showInputBox({
      title: 'Rename Branch',
      prompt: `Rename ${node.fullName}`,
      value: oldName,
      validateInput: (value) => validateBranchName(value, provider.repoRoot)
    });

    if (!newName || newName.trim() === oldName) {
      return;
    }

    const trimmed = newName.trim();
    if (node.source === 'remote') {
      const remote = parseRemoteBranch(node.fullName);
      if (!remote) return;
      await runGitTask(provider.repoRoot, ['push', remote.remote, `refs/remotes/${remote.remote}/${remote.branch}:refs/heads/${trimmed}`], `Creating remote ${remote.remote}/${trimmed}`);
      await runGitTask(provider.repoRoot, ['push', remote.remote, '--delete', remote.branch], `Deleting remote ${node.fullName}`);
    } else {
      const upstream = getUpstreamBranch(provider.repoRoot, node.fullName);
      await runGitTask(provider.repoRoot, ['branch', '-m', node.fullName, trimmed], `Renaming ${node.fullName}`);
      if (upstream) {
        const deleteOld = await vscode.window.showWarningMessage(
          `Also rename remote ${upstream.remote}/${upstream.branch} to ${upstream.remote}/${trimmed}?`,
          { modal: true },
          'Rename Remote'
        );
        if (deleteOld === 'Rename Remote') {
          await runGitTask(provider.repoRoot, ['push', '-u', upstream.remote, trimmed], `Pushing ${trimmed}`);
          await runGitTask(provider.repoRoot, ['push', upstream.remote, '--delete', upstream.branch], `Deleting remote ${upstream.remote}/${upstream.branch}`);
        }
      }
    }

    await runGitTask(provider.repoRoot, ['fetch', '--all', '--prune'], 'Refreshing branches');
    provider.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hierarchicalGitBranches.deleteBranchEverywhere', async (node) => {
    if (!provider.repoRoot || !node?.fullName) {
      return;
    }

    provider.refresh();
    const targets = getDeleteTargets(provider.repoRoot, node);

    if (targets.localBranch && targets.localBranch === provider.currentBranch) {
      vscode.window.showWarningMessage(`Cannot delete current branch: ${targets.localBranch}. Switch to another branch first.`);
      return;
    }

    if (!targets.localExists && !targets.remoteExists) {
      vscode.window.showWarningMessage(`No local or remote branch found for ${node.fullName}.`);
      return;
    }

    const parts = [];
    if (targets.localExists) parts.push(`local: ${targets.localBranch}`);
    if (targets.remoteExists) parts.push(`remote: ${targets.remoteName}/${targets.remoteBranch}`);

    const confirmed = await vscode.window.showWarningMessage(
      `Delete branch ${node.fullName}? This will delete ${parts.join(' and ')}.`,
      { modal: true },
      'Delete'
    );

    if (confirmed !== 'Delete') {
      return;
    }

    if (targets.remoteExists) {
      const typed = await vscode.window.showInputBox({
        title: 'Confirm Remote Branch Deletion',
        prompt: `Type ${targets.remoteBranch} to delete the remote branch.`,
        validateInput: (value) => value === targets.remoteBranch ? undefined : 'Branch name does not match.'
      });
      if (typed !== targets.remoteBranch) {
        return;
      }
    }

    if (targets.localExists) {
      await runGitTask(provider.repoRoot, ['branch', '-d', targets.localBranch], `Deleting local ${targets.localBranch}`);
    }

    if (targets.remoteExists) {
      await runGitTask(provider.repoRoot, ['push', targets.remoteName, '--delete', targets.remoteBranch], `Deleting remote ${targets.remoteName}/${targets.remoteBranch}`);
    }

    provider.refresh();
  }));

  const config = () => vscode.workspace.getConfiguration('hierarchicalGitBranches');
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    if (config().get('autoRefresh')) provider.refresh();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (config().get('autoRefresh')) provider.refresh();
  }));
}

function deactivate() {}

function buildTree(repoRoot, currentBranch, filterText, favorites) {
  const includeRemoteBranches = vscode.workspace
    .getConfiguration('hierarchicalGitBranches')
    .get('includeRemoteBranches', true);
  const normalizedFilter = filterText.toLowerCase();

  const localBranches = listBranches(repoRoot, false).filter((branch) => branchMatches(branch, normalizedFilter));
  const remoteBranches = includeRemoteBranches
    ? listBranches(repoRoot, true)
      .filter((branch) => !branch.endsWith('/HEAD'))
      .map((branch) => branch.replace(/^remotes\//, ''))
      .filter((branch) => branchMatches(branch, normalizedFilter))
    : [];

  const localMeta = collectBranchMeta(repoRoot, localBranches, 'local');
  const remoteMeta = collectBranchMeta(repoRoot, remoteBranches, 'remote');
  const roots = [];

  if (currentBranch) {
    roots.push(new BranchNode(currentBranch, 'current', currentBranch, [], 'local'));
  }

  if (filterText) {
    roots.push(new BranchNode('Filter', 'filter', filterText));
  }

  const pinned = buildPinnedNodes(localBranches, remoteBranches, localMeta, remoteMeta, favorites);
  if (pinned.length > 0) {
    roots.push(new BranchNode('Pinned', 'section', '', pinned));
  }

  roots.push(new BranchNode('Local', 'section', '', toTree(localBranches, currentBranch, 'local', localMeta)));

  if (includeRemoteBranches) {
    roots.push(new BranchNode('Remotes', 'section', '', toTree(remoteBranches, currentBranch, 'remote', remoteMeta)));
  }

  if (filterText && localBranches.length === 0 && remoteBranches.length === 0) {
    roots.push(new BranchNode('No branches match the current filter', 'message'));
  }

  return roots;
}

function listBranches(repoRoot, remote) {
  const args = remote
    ? ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']
    : ['for-each-ref', '--format=%(refname:short)', 'refs/heads'];
  const output = git(args, repoRoot);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
}

function collectBranchMeta(repoRoot, branches, source) {
  const meta = new Map();
  for (const branch of branches) {
    const item = {
      lastCommit: getLastCommitTime(repoRoot, branch, source),
      upstream: undefined,
      ahead: 0,
      behind: 0,
      tracked: false
    };

    if (source === 'local') {
      const upstream = getUpstreamBranch(repoRoot, branch);
      item.upstream = upstream;
      item.tracked = Boolean(upstream);
      if (upstream) {
        const counts = getAheadBehind(repoRoot, branch, `${upstream.remote}/${upstream.branch}`);
        item.ahead = counts.ahead;
        item.behind = counts.behind;
      }
    }

    meta.set(branch, item);
  }
  return meta;
}

function toTree(branches, currentBranch, source, metaMap) {
  const root = new Map();

  for (const branch of branches) {
    const parts = branch.split('/');
    let cursor = root;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isLeaf = index === parts.length - 1;

      if (!cursor.has(part)) {
        cursor.set(part, {
          label: part,
          type: isLeaf ? 'branch' : 'group',
          fullName: isLeaf ? branch : '',
          children: new Map(),
          source: isLeaf ? source : '',
          meta: isLeaf ? metaMap.get(branch) || {} : {}
        });
      }

      const entry = cursor.get(part);
      if (isLeaf) {
        entry.type = 'branch';
        entry.fullName = branch;
        entry.source = source;
        entry.meta = metaMap.get(branch) || {};
      }
      cursor = entry.children;
    }
  }

  return Array.from(root.values())
    .sort((left, right) => sortNodes(left, right, currentBranch))
    .map((entry) => mapEntry(entry, currentBranch));
}

function mapEntry(entry, currentBranch) {
  const children = Array.from(entry.children.values())
    .sort((left, right) => sortNodes(left, right, currentBranch))
    .map((child) => mapEntry(child, currentBranch));
  return new BranchNode(entry.label, entry.type, entry.fullName, children, entry.source, entry.meta);
}

function buildPinnedNodes(localBranches, remoteBranches, localMeta, remoteMeta, favorites) {
  const nodes = [];
  for (const key of favorites) {
    const [source, ...nameParts] = key.split(':');
    const branch = nameParts.join(':');
    if (source === 'local' && localBranches.includes(branch)) {
      nodes.push(new BranchNode(branch, 'branch', branch, [], 'local', localMeta.get(branch) || {}));
    }
    if (source === 'remote' && remoteBranches.includes(branch)) {
      nodes.push(new BranchNode(branch, 'branch', branch, [], 'remote', remoteMeta.get(branch) || {}));
    }
  }
  return nodes.sort((left, right) => left.fullName.localeCompare(right.fullName));
}

function sortNodes(left, right, currentBranch) {
  if (left.fullName === currentBranch) return -1;
  if (right.fullName === currentBranch) return 1;
  if (left.type !== right.type) return left.type === 'group' ? -1 : 1;
  return left.label.localeCompare(right.label);
}

function findNode(nodes, predicate) {
  for (const node of nodes) {
    if (predicate(node)) {
      return node;
    }

    const child = findNode(node.children, predicate);
    if (child) {
      return child;
    }
  }
  return undefined;
}

function sectionIcon(label) {
  if (label === 'Local') return 'repo';
  if (label === 'Remotes') return 'cloud';
  if (label === 'Pinned') return 'pinned';
  return 'folder';
}

function branchDescription(node, currentBranch, favorites) {
  const parts = [];
  if (node.fullName === currentBranch) {
    parts.push('current');
  }
  if (favorites.has(favoriteKey(node))) {
    parts.push('pinned');
  }
  if (node.source === 'local') {
    if (node.meta?.tracked) {
      if (node.meta.ahead) parts.push(`ahead ${node.meta.ahead}`);
      if (node.meta.behind) parts.push(`behind ${node.meta.behind}`);
      if (!node.meta.ahead && !node.meta.behind) parts.push('tracked');
    } else {
      parts.push('local only');
    }
  }
  if (node.meta?.lastCommit) {
    parts.push(node.meta.lastCommit);
  }
  return parts.join(' | ');
}

function branchMatches(branch, normalizedFilter) {
  return !normalizedFilter || branch.toLowerCase().includes(normalizedFilter);
}

function favoriteKey(node) {
  return `${node.source}:${node.fullName}`;
}

function findRepositoryRoot() {
  const candidates = [];

  if (vscode.window.activeTextEditor) {
    candidates.push(path.dirname(vscode.window.activeTextEditor.document.uri.fsPath));
  }

  for (const folder of vscode.workspace.workspaceFolders || []) {
    candidates.push(folder.uri.fsPath);
  }

  for (const candidate of candidates) {
    try {
      return git(['rev-parse', '--show-toplevel'], candidate).trim();
    } catch (_) {
      // Try the next workspace folder.
    }
  }

  return undefined;
}

function git(args, cwd) {
  return cp.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function safeGit(args, cwd) {
  try {
    return git(args, cwd).trim();
  } catch (_) {
    return '';
  }
}

function getCurrentBranch(repoRoot) {
  const branchName = safeGit(['branch', '--show-current'], repoRoot);
  if (branchName) {
    return branchName;
  }

  const shortSha = safeGit(['rev-parse', '--short', 'HEAD'], repoRoot);
  return shortSha ? `HEAD detached at ${shortSha}` : '';
}

function getLastCommitTime(repoRoot, branchName, source) {
  const ref = source === 'remote' ? `refs/remotes/${branchName}` : `refs/heads/${branchName}`;
  return safeGit(['for-each-ref', '--format=%(committerdate:relative)', ref], repoRoot);
}

function getAheadBehind(repoRoot, branchName, upstreamName) {
  const output = safeGit(['rev-list', '--left-right', '--count', `${upstreamName}...${branchName}`], repoRoot);
  const [behindRaw, aheadRaw] = output.split(/\s+/);
  return {
    behind: Number.parseInt(behindRaw || '0', 10) || 0,
    ahead: Number.parseInt(aheadRaw || '0', 10) || 0
  };
}

function validateBranchName(value, repoRoot) {
  const branchName = value.trim();

  if (!branchName) {
    return 'Branch name is required.';
  }

  try {
    git(['check-ref-format', '--branch', branchName], repoRoot);
  } catch (_) {
    return 'Invalid Git branch name.';
  }

  try {
    git(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], repoRoot);
    return 'A local branch with this name already exists.';
  } catch (_) {
    return undefined;
  }
}

function getDeleteTargets(repoRoot, node) {
  if (node.source === 'remote') {
    const remote = parseRemoteBranch(node.fullName);
    const localBranch = remote ? remote.branch : node.fullName;
    return {
      localBranch,
      localExists: refExists(repoRoot, `refs/heads/${localBranch}`),
      remoteName: remote?.remote || 'origin',
      remoteBranch: remote?.branch || node.fullName,
      remoteExists: remote ? refExists(repoRoot, `refs/remotes/${remote.remote}/${remote.branch}`) : false
    };
  }

  const upstream = getUpstreamBranch(repoRoot, node.fullName) || getOriginBranch(repoRoot, node.fullName);
  return {
    localBranch: node.fullName,
    localExists: refExists(repoRoot, `refs/heads/${node.fullName}`),
    remoteName: upstream?.remote || 'origin',
    remoteBranch: upstream?.branch || node.fullName,
    remoteExists: upstream ? refExists(repoRoot, `refs/remotes/${upstream.remote}/${upstream.branch}`) : false
  };
}

function getUpstreamBranch(repoRoot, branchName) {
  const upstream = safeGit(['rev-parse', '--abbrev-ref', `${branchName}@{upstream}`], repoRoot);
  return upstream ? parseRemoteBranch(upstream) : undefined;
}

function getOriginBranch(repoRoot, branchName) {
  return refExists(repoRoot, `refs/remotes/origin/${branchName}`)
    ? { remote: 'origin', branch: branchName }
    : undefined;
}

function parseRemoteBranch(branchName) {
  const index = branchName.indexOf('/');
  if (index <= 0 || index === branchName.length - 1) {
    return undefined;
  }

  return {
    remote: branchName.slice(0, index),
    branch: branchName.slice(index + 1)
  };
}

function stripRemoteName(branchName) {
  const remote = parseRemoteBranch(branchName);
  return remote ? remote.branch : branchName;
}

function refExists(repoRoot, refName) {
  try {
    git(['show-ref', '--verify', '--quiet', refName], repoRoot);
    return true;
  } catch (_) {
    return false;
  }
}

function runGitTask(repoRoot, args, title) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    () => new Promise((resolve, reject) => {
      cp.execFile('git', args, { cwd: repoRoot }, (error, stdout, stderr) => {
        if (error) {
          vscode.window.showErrorMessage(stderr || error.message);
          reject(error);
          return;
        }

        if (stdout.trim()) {
          vscode.window.setStatusBarMessage(stdout.trim(), 3000);
        }
        resolve();
      });
    })
  );
}

module.exports = {
  activate,
  deactivate
};

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

const SCM_VIEW_ID = 'hierarchicalGitBranches.scmView';
const ACTIVITY_VIEW_ID = 'hierarchicalGitBranches.activityView';

class BranchNode {
  constructor(label, type, fullName = '', children = [], source = '') {
    this.label = label;
    this.type = type;
    this.fullName = fullName;
    this.children = children;
    this.source = source;
  }
}

class BranchTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._onDidRefresh = new vscode.EventEmitter();
    this.onDidRefresh = this._onDidRefresh.event;
    this.repoRoot = undefined;
    this.currentBranch = '';
    this.roots = [];
    this.refresh();
  }

  refresh() {
    this.repoRoot = findRepositoryRoot();
    this.currentBranch = this.repoRoot ? getCurrentBranch(this.repoRoot) : '';
    this.roots = this.repoRoot ? buildTree(this.repoRoot, this.currentBranch) : [];
    this._onDidChangeTreeData.fire();
    this._onDidRefresh.fire();
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
    } else if (node.type === 'section') {
      item.iconPath = new vscode.ThemeIcon(node.label === 'Local' ? 'repo' : 'cloud');
      item.contextValue = 'section';
    } else if (node.type === 'group') {
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'group';
    } else {
      item.description = node.fullName === this.currentBranch ? 'current' : '';
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
  const provider = new BranchTreeProvider();
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'hierarchicalGitBranches.refresh';
  statusBarItem.tooltip = 'Current Git branch';
  context.subscriptions.push(statusBarItem);

  const updateStatusBar = () => {
    if (!provider.repoRoot) {
      statusBarItem.hide();
      return;
    }

    statusBarItem.text = `$(git-branch) ${provider.currentBranch || 'No branch'}`;
    statusBarItem.show();
  };
  updateStatusBar();
  context.subscriptions.push(provider.onDidRefresh(updateStatusBar));

  context.subscriptions.push(
    vscode.window.createTreeView(SCM_VIEW_ID, {
      treeDataProvider: provider,
      showCollapseAll: true
    })
  );

  context.subscriptions.push(
    vscode.window.createTreeView(ACTIVITY_VIEW_ID, {
      treeDataProvider: provider,
      showCollapseAll: true
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hierarchicalGitBranches.refresh', () => provider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hierarchicalGitBranches.fetch', async () => {
      if (!provider.repoRoot) {
        vscode.window.showWarningMessage('No Git repository found.');
        return;
      }

      await runGitTask(provider.repoRoot, ['fetch', '--all', '--prune', '--tags'], 'Fetching branches and tags');
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hierarchicalGitBranches.checkout', async (node) => {
      if (!provider.repoRoot || !node?.fullName) {
        return;
      }

      const branchName = node.fullName;
      const target = branchName.startsWith('origin/') ? branchName.slice('origin/'.length) : branchName;
      const args = branchName.startsWith('origin/')
        ? ['switch', '--track', '-c', target, branchName]
        : ['switch', branchName];

      try {
        await runGitTask(provider.repoRoot, args, `Checking out ${target}`);
      } catch (error) {
        if (branchName.startsWith('origin/')) {
          await runGitTask(provider.repoRoot, ['switch', target], `Checking out ${target}`);
        } else {
          throw error;
        }
      } finally {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hierarchicalGitBranches.createBranchFromSelected', async (node) => {
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
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hierarchicalGitBranches.deleteBranchEverywhere', async (node) => {
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

      if (targets.localExists) {
        await runGitTask(provider.repoRoot, ['branch', '-d', targets.localBranch], `Deleting local ${targets.localBranch}`);
      }

      if (targets.remoteExists) {
        await runGitTask(provider.repoRoot, ['push', targets.remoteName, '--delete', targets.remoteBranch], `Deleting remote ${targets.remoteName}/${targets.remoteBranch}`);
      }

      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hierarchicalGitBranches.copyBranchName', async (node) => {
      if (node?.fullName) {
        await vscode.env.clipboard.writeText(node.fullName);
      }
    })
  );

  const config = () => vscode.workspace.getConfiguration('hierarchicalGitBranches');
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    if (config().get('autoRefresh')) provider.refresh();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (config().get('autoRefresh')) provider.refresh();
  }));
}

function deactivate() {}

function buildTree(repoRoot, currentBranch) {
  const includeRemoteBranches = vscode.workspace
    .getConfiguration('hierarchicalGitBranches')
    .get('includeRemoteBranches', true);

  const localBranches = listBranches(repoRoot, false);
  const roots = [];

  if (currentBranch) {
    roots.push(new BranchNode(currentBranch, 'current', currentBranch, [], 'local'));
  }

  roots.push(new BranchNode('Local', 'section', '', toTree(localBranches, currentBranch, 'local')));

  if (includeRemoteBranches) {
    const remoteBranches = listBranches(repoRoot, true)
      .filter((branch) => !branch.endsWith('/HEAD'))
      .map((branch) => branch.replace(/^remotes\//, ''));
    roots.push(new BranchNode('Remotes', 'section', '', toTree(remoteBranches, currentBranch, 'remote')));
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

function toTree(branches, currentBranch, source) {
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
          source: isLeaf ? source : ''
        });
      }

      const entry = cursor.get(part);
      if (isLeaf) {
        entry.type = 'branch';
        entry.fullName = branch;
        entry.source = source;
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
  return new BranchNode(entry.label, entry.type, entry.fullName, children, entry.source);
}

function sortNodes(left, right, currentBranch) {
  if (left.fullName === currentBranch) return -1;
  if (right.fullName === currentBranch) return 1;
  if (left.type !== right.type) return left.type === 'group' ? -1 : 1;
  return left.label.localeCompare(right.label);
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

function getCurrentBranch(repoRoot) {
  const branchName = git(['branch', '--show-current'], repoRoot).trim();
  if (branchName) {
    return branchName;
  }

  try {
    const shortSha = git(['rev-parse', '--short', 'HEAD'], repoRoot).trim();
    return shortSha ? `HEAD detached at ${shortSha}` : '';
  } catch (_) {
    return '';
  }
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
  try {
    return parseRemoteBranch(git(['rev-parse', '--abbrev-ref', `${branchName}@{upstream}`], repoRoot).trim());
  } catch (_) {
    return undefined;
  }
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

import { WORKBENCH_FEATURE_CHANNELS as channels } from '@pidesktop/shared/workbenchFeatures';
import { broadcastToRenderers, handleRendererInvoke } from './rendererIpc';
import { WorkspaceCommitService } from './workspaceCommit';
import { WorktreeDeliveryService } from './worktreeDelivery';
import { WorkspaceTerminalService } from './workspaceTerminal';
/** Agent checkpoint channels are registered by the normal authenticated agent RPC router. */
export function registerWorkbenchFeatureIpc(currentCwd: () => string, directory: string) {
  const commit = new WorkspaceCommitService(currentCwd), delivery = new WorktreeDeliveryService(currentCwd, directory), terminal = new WorkspaceTerminalService(currentCwd, event => broadcastToRenderers(channels.onWorkspaceTerminalEvent, event));
  const register = <Args extends unknown[]>(channel: string, method: (...args: Args) => unknown) => handleRendererInvoke(channel, (_event, ...args: Args) => method(...args));
  register(channels.getWorkspaceCommitPreview, commit.preview.bind(commit));
  register(channels.commitWorkspacePreview, commit.commit.bind(commit));
  register(channels.createTaskWorktree, delivery.createWorktree.bind(delivery));
  register(channels.listTaskWorktrees, delivery.listWorktrees.bind(delivery));
  register(channels.bindTaskWorktree, delivery.bindWorktree.bind(delivery));
  register(channels.getGitDeliveryPreview, delivery.deliveryPreview.bind(delivery));
  register(channels.pushWorkspaceBranch, delivery.push.bind(delivery));
  register(channels.createWorkspaceDraftPr, delivery.draftPr.bind(delivery));
  register(channels.openWorkspaceTerminal, terminal.open.bind(terminal));
  register(channels.getWorkspaceTerminal, terminal.get.bind(terminal));
  register(channels.writeWorkspaceTerminal, terminal.write.bind(terminal));
  register(channels.resizeWorkspaceTerminal, terminal.resize.bind(terminal));
  register(channels.acknowledgeWorkspaceTerminal, terminal.acknowledge.bind(terminal));
  register(channels.closeWorkspaceTerminal, terminal.close.bind(terminal));
  return { dispose: async () => { await terminal.dispose(); await commit.dispose(); } };
}

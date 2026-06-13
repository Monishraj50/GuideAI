import os from 'node:os';
import path from 'node:path';

export const GUIDEAI_HOME = process.env.GUIDEAI_HOME ?? path.join(os.homedir(), '.guideai');

export const paths = {
  home: GUIDEAI_HOME,
  db: path.join(GUIDEAI_HOME, 'db.sqlite'),
  workspaces: path.join(GUIDEAI_HOME, 'workspaces'),
  skills: path.join(GUIDEAI_HOME, 'skills'),
  agentsCustom: path.join(GUIDEAI_HOME, 'agents', 'custom'),
  policiesJson: path.join(GUIDEAI_HOME, 'policies.json'),

  workspaceDir(id: string) {
    return path.join(GUIDEAI_HOME, 'workspaces', id);
  },
  agentDir(workspaceId: string, agentId: string) {
    return path.join(GUIDEAI_HOME, 'workspaces', workspaceId, 'agents', agentId);
  },
  agentInbox(workspaceId: string, agentId: string) {
    return path.join(this.agentDir(workspaceId, agentId), 'inbox.jsonl');
  },
  agentTranscript(workspaceId: string, agentId: string) {
    return path.join(this.agentDir(workspaceId, agentId), 'transcript.jsonl');
  },
  agentCwd(workspaceId: string, agentId: string) {
    return path.join(this.agentDir(workspaceId, agentId), 'cwd');
  },
  workspaceEvents(workspaceId: string) {
    return path.join(this.workspaceDir(workspaceId), 'events.jsonl');
  },
};

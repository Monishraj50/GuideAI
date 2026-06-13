'use client';

import { useWorkspaceId } from '../../../components/WorkspaceProvider';
import { Replay } from './Replay';

export function ReplayClient({ briefId }: { briefId: string }) {
  const workspaceId = useWorkspaceId();
  return <Replay workspaceId={workspaceId} briefId={briefId} />;
}

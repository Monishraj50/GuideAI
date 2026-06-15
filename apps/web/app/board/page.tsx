import { BoardClient } from './BoardClient';

export default function BoardPage() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 glass">
        <div className="text-ink font-medium">Board</div>
        <div className="text-dim text-[11px] mt-0.5">work items across every project · drag to move</div>
      </header>
      <BoardClient />
    </div>
  );
}

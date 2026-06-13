import { Hash } from 'lucide-react';

export default function ChannelsPage() {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-6">
      <div className="text-center max-w-md">
        <div className="w-12 h-12 rounded-full bg-line/40 border border-line/70 flex items-center justify-center mx-auto mb-3">
          <Hash size={18} className="text-dim" />
        </div>
        <div className="text-ink text-sm font-medium mb-1">Channels — coming soon</div>
        <div className="text-dim text-xs">Per-team rooms land alongside dispatch-to-specialists.</div>
      </div>
    </div>
  );
}

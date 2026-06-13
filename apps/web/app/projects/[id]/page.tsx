import { ArrowLeft } from 'lucide-react';
import { ProjectPlan } from './ProjectPlan';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 flex items-center gap-4 glass">
        <a href="/projects" className="flex items-center gap-1 text-dim text-xs hover:text-ink transition-colors">
          <ArrowLeft size={12} /> all projects
        </a>
        <div>
          <div className="text-ink font-medium">Project plan</div>
          <div className="text-dim text-[11px] mt-0.5 font-mono">{id}</div>
        </div>
      </header>
      <ProjectPlan workspaceId={id} />
    </div>
  );
}

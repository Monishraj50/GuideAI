import { ProjectsIndex } from './ProjectsIndex';

export default function ProjectsPage() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-line/70 px-5 py-3 glass">
        <div className="text-ink font-medium">Projects</div>
        <div className="text-dim text-[11px] mt-0.5">every project · plan accordingly</div>
      </header>
      <ProjectsIndex />
    </div>
  );
}

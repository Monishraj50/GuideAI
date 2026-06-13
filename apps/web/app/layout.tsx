import './globals.css';
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Sidebar } from '../components/Sidebar';
import { TopBar } from '../components/TopBar';
import { ToastHost } from '../components/Toast';
import { CommandPalette } from '../components/CommandPalette';
import { WorkspaceProvider } from '../components/WorkspaceProvider';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'GuideAI — Mission Control',
  description: 'Multi-agent company platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="antialiased">
        <WorkspaceProvider>
          <div className="flex h-screen">
            <Sidebar />
            <div className="flex-1 min-w-0 flex flex-col">
              <TopBar />
              <main className="flex-1 min-h-0 flex flex-col">{children}</main>
            </div>
          </div>
          <ToastHost />
          <CommandPalette />
        </WorkspaceProvider>
      </body>
    </html>
  );
}

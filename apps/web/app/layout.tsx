import './globals.css';
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { ToastHost } from '../components/Toast';
import { CommandPalette } from '../components/CommandPalette';
import { WorkspaceProvider } from '../components/WorkspaceProvider';
import { AuthProvider } from '../components/AuthProvider';
import { AuthGate } from '../components/AuthGate';
import { AppShell } from '../components/AppShell';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Atrium.AI — Mission Control',
  description: 'Your AI workplace. Brief your team. Review their work. Ship faster.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="antialiased">
        <AuthProvider>
          <WorkspaceProvider>
            <AuthGate>
              <AppShell>{children}</AppShell>
            </AuthGate>
            <ToastHost />
            <CommandPalette />
          </WorkspaceProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

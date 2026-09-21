import type { Metadata } from 'next';
import './globals.css';
import { SiteHeader } from '@/components/site-header';
import { ViewAsBanner } from '@/components/view-as-banner';

export const metadata: Metadata = {
  title: 'BSCompStats',
  description: 'Beat Saber competitive stats, map pools and match management',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <SiteHeader />
        <ViewAsBanner />
        <main className="mx-auto w-full max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}

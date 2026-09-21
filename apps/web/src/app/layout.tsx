import type { Metadata } from 'next';
import './globals.css';
import { SiteHeader } from '@/components/site-header';
import { ViewAsBanner } from '@/components/view-as-banner';

export const metadata: Metadata = {
  title: 'BSCompStats',
  description: 'Beat Saber competitive stats, map pools and match management',
  // One logo, in public/: the SVG for browsers, the PNG where an SVG is not
  // accepted (iOS home screen).
  icons: {
    icon: [{ url: '/logo.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/logo-512.png', sizes: '512x512', type: 'image/png' }],
  },
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

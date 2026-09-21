import type { Metadata, Viewport } from 'next';
import { env } from '@/lib/env';
import './globals.css';
import { SiteHeader } from '@/components/site-header';
import { ViewAsBanner } from '@/components/view-as-banner';

const DESCRIPTION =
  'Beat Saber tournaments: map pools with live scores, team rosters, pick and ban, lineup advice and win predictions.';

export const metadata: Metadata = {
  // Makes the og:image URLs each page generates absolute, which crawlers need.
  metadataBase: new URL(env.APP_URL),
  title: { default: 'BSCompStats', template: '%s · BSCompStats' },
  description: DESCRIPTION,
  openGraph: { siteName: 'BSCompStats', type: 'website', title: 'BSCompStats', description: DESCRIPTION },
  // The large card, so the generated image is shown full width rather than as a thumbnail.
  twitter: { card: 'summary_large_image' },
  // One logo, in public/: rounded for the browser tab, the PNG where an SVG is
  // not accepted (iOS home screen).
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/logo-512.png', sizes: '512x512', type: 'image/png' }],
  },
};

/** The colour of the bar down the side of a Discord embed. */
export const viewport: Viewport = { themeColor: '#8b7bff' };

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

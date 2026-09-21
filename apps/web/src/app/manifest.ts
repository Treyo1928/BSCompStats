import type { MetadataRoute } from 'next';

/** Lets the site be added to a phone's home screen and open without browser chrome. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BSCompStats',
    short_name: 'BSCompStats',
    description: 'Beat Saber tournaments: live map pools, pick and ban, lineups and player stats.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0c13',
    theme_color: '#0a0c13',
    icons: [
      { src: '/logo-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/logo-1024.png', sizes: '1024x1024', type: 'image/png' },
    ],
  };
}

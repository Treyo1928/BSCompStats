import { redirect } from 'next/navigation';

/** The curve and pull settings moved onto the tournament's Settings tab. */
export default async function ScoringSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/t/${slug}/settings#curve`);
}

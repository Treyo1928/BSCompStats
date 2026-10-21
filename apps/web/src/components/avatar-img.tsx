'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The picture laid over an avatar's initial, or a map cover's icon. One that
 * will not load - a Discord or BeatLeader address left stale after someone
 * changed their picture - is dropped, so what is underneath shows instead of
 * a broken-image box.
 */
export function AvatarImg({ src }: { src: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  // An image that failed before the page hydrated never fires onError here.
  useEffect(() => {
    const img = ref.current;
    if (img?.complete && img.naturalWidth === 0) setFailed(true);
  }, [src]);
  useEffect(() => setFailed(false), [src]);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}

'use client';
import { useEffect, useState } from 'react';
import type { SiteImage } from '@/lib/data';

export function HeroSlider({ images }: { images: SiteImage[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (images.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % images.length), 6000);
    return () => clearInterval(t);
  }, [images.length]);

  if (images.length === 0) return <div className="a-hero-bg a-hero-empty" />;
  return (
    <div className="a-hero-bg">
      {images.map((img, n) => (
        <img key={n} src={img.url} alt={img.alt} className={n === i ? 'on' : ''} fetchPriority={n === 0 ? 'high' : 'low'} />
      ))}
      {images.length > 1 && (
        <div className="a-dots">
          {images.map((_, n) => (
            <button key={n} aria-label={`Photo ${n + 1}`} className={n === i ? 'on' : ''} onClick={() => setI(n)} />
          ))}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import poster from '../assets/mun/mun-painting-poster.webp';
import video from '../assets/mun/mun-painting.mp4';

function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Mun painting at the easel. Loops while `playing` (a generation is running);
 * otherwise shows the still frame so idle nodes don't animate on the canvas.
 */
export function MunLoader({
  label = 'Mun is painting…',
  playing = true,
  className = '',
}: {
  label?: string | null;
  playing?: boolean;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const animate = playing && !reduced;
  return (
    <div
      role={playing ? 'status' : undefined}
      aria-live={playing ? 'polite' : undefined}
      className={`flex flex-col items-center gap-2 ${className}`}
    >
      <div className="w-full overflow-hidden rounded-xl border-2 border-outline bg-app">
        {animate ? (
          <video
            className="block aspect-[52/30] w-full object-cover"
            src={video}
            poster={poster}
            autoPlay
            loop
            muted
            playsInline
            aria-hidden
          />
        ) : (
          <img src={poster} alt="" draggable={false} className="block aspect-[52/30] w-full object-cover" />
        )}
      </div>
      {label && <p className="text-[12px] font-medium text-ink-2">{label}</p>}
    </div>
  );
}

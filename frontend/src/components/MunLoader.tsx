import { useEffect, useState } from 'react';
import poster from '../assets/mun/mun-painting-poster.webp';
import video from '../assets/mun/mun-painting.mp4';
import erasePoster from '../assets/mun/mun-erasing-poster.webp';
import eraseVideo from '../assets/mun/mun-erasing.mp4';
import placingPoster from '../assets/mun/mun-placing-poster.webp';
import placingVideo from '../assets/mun/mun-placing.mp4';

const clips = {
  painting: { video, poster },
  erasing: { video: eraseVideo, poster: erasePoster },
  placing: { video: placingVideo, poster: placingPoster },
};

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
  variant = 'painting',
}: {
  label?: string | null;
  playing?: boolean;
  className?: string;
  variant?: keyof typeof clips;
}) {
  const reduced = usePrefersReducedMotion();
  const [failedVideo, setFailedVideo] = useState<string | null>(null);
  const clip = clips[variant];
  const animate = playing && !reduced && failedVideo !== clip.video;
  const mediaClass = `block ${variant === 'painting' ? 'aspect-[52/30]' : 'aspect-video'} w-full object-cover`;
  return (
    <div
      role={playing ? 'status' : undefined}
      aria-live={playing ? 'polite' : undefined}
      className={`flex flex-col items-center gap-2 ${className}`}
    >
      <div className="w-full overflow-hidden rounded-xl border-2 border-outline bg-app">
        {animate ? (
          <video
            className={mediaClass}
            src={clip.video}
            poster={clip.poster}
            preload="metadata"
            onError={() => setFailedVideo(clip.video)}
            autoPlay
            loop
            muted
            playsInline
            aria-hidden
          />
        ) : (
          <img src={clip.poster} alt="" draggable={false} className={mediaClass} />
        )}
      </div>
      {label && <p className="text-[12px] font-medium text-ink-2">{label}</p>}
    </div>
  );
}

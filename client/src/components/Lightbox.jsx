import { useCallback, useState } from 'react';

/**
 * Full-screen photo viewer. Returns [element, open]; call open(src, caption) to show a photo.
 * Clicking anywhere closes it.
 */
export function useLightbox() {
  const [photo, setPhoto] = useState(null);
  const open = useCallback((src, caption) => setPhoto({ src, caption }), []);
  const element = (
    <div id="lightbox" className={photo ? 'open' : ''} onClick={() => setPhoto(null)}>
      {photo && <img src={photo.src} alt={photo.caption} />}
      <p className="caption">{photo?.caption}</p>
    </div>
  );
  return [element, open];
}

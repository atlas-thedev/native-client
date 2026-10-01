import { useEffect, useState } from 'react';
import { getPatchNotes, subscribeBanners } from './patchNotes.js';

/**
 * Loads Mojang's version banners once and re-renders the caller when they
 * arrive, so getClusterArt() can swap a placeholder for the real picture.
 */
export default function useVersionBanners() {
  const [, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    const unsubscribe = subscribeBanners(() => alive && bump((n) => n + 1));
    getPatchNotes().then(() => alive && bump((n) => n + 1)).catch(() => {});
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
}

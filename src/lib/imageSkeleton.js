import './imageSkeleton.css';

/**
 * Adds a shimmer skeleton (class "img-skeleton") to every image that is still
 * loading, and removes it on load or error. Works for images added later too
 * (mod icons, avatars, news art), so no component needs to opt in.
 * Returns a cleanup function.
 */
export function installImageSkeletons(root = document) {
  if (typeof MutationObserver === 'undefined' || !root?.body) return () => {};

  const finish = (img) => {
    img.classList.remove('img-skeleton');
    delete img.dataset.skeleton;
  };

  const track = (img) => {
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.getAttribute('src') || img.src.startsWith('data:')) return;
    if (img.complete) { finish(img); return; }
    if (img.dataset.skeleton === img.src) return;
    img.dataset.skeleton = img.src;
    img.classList.add('img-skeleton');
    const done = () => finish(img);
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  };

  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'IMG') track(node);
    node.querySelectorAll?.('img').forEach(track);
  };

  scan(root.body);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') track(mutation.target);
      else mutation.addedNodes.forEach(scan);
    }
  });
  observer.observe(root.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  return () => observer.disconnect();
}

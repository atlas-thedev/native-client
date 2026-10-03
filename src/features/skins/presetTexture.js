/**
 * The preset's PNG as a data URL. Production builds inline these small PNGs as
 * data: URLs, and the app's Content-Security-Policy blocks fetch() of data: URLs
 * (connect-src), so use them as they are; only dev builds serve a file to fetch.
 */
export async function presetTextureDataUrl(cape, fetchImpl = (url) => fetch(url)) {
  const url = cape?.textureUrl;
  if (!url) throw new Error('That cape has no texture.');
  if (/^data:image\/png;base64,/i.test(url)) return url;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Could not load ${cape.name}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

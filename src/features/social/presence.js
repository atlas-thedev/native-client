/** Join only makes sense while the friend is really on a public server right now. */
export function canJoinServer(entity) {
  const address = String(entity?.serverAddress || '').trim().toLowerCase();
  if (!address || String(entity?.status || '').toLowerCase() !== 'in-game') return false;
  const bracketed = address.match(/^\[([^\]]+)\]/);
  const host = bracketed ? bracketed[1] : (address.split(':').length === 2 ? address.split(':')[0] : address);
  return !(host === 'localhost' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1' || host.endsWith('.local'));
}

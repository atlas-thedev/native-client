/** Merge a server refresh into a draft without losing fields edited locally. */
export function mergeAdminDraft(draft, previous, fresh) {
  if (JSON.stringify(previous) === JSON.stringify(fresh)) return draft;
  if (!draft || JSON.stringify(draft) === JSON.stringify(previous)) return fresh || null;
  const merged = { ...fresh };
  for (const field of Object.keys(draft)) {
    if (JSON.stringify(draft[field]) !== JSON.stringify(previous?.[field])
      && JSON.stringify(draft[field]) !== JSON.stringify(fresh?.[field])) merged[field] = draft[field];
  }
  return merged;
}

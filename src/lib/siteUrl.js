// Main Native website address, chosen on the backend (Admin → Domains → "Make main website").
// Links are built at click time, so a plain module value is enough — no re-render needed.
let current = 'https://playnative.fun';
try {
  window.native?.site?.info?.().then((r) => { if (r?.ok && /^https:\/\//.test(r.site || '')) current = r.site.replace(/\/$/, ''); }).catch(() => {});
} catch { /* not in the launcher */ }

export const siteUrl = () => current;

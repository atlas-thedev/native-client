import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NativeIcon from '../../components/ui/NativeIcon.jsx';
import { loaderAvailability, compareVersions } from '../../lib/mojang.js';
import { LOADER_BLURBS, LOADER_NAMES, compareLoaderVersions, normalizeLoader } from '../../lib/loaders.js';
import './LoaderTab.css';

const ORDER = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric'];
const PAGE = 12;

/** Version lists for every loader that can run this Minecraft version. */
function useLoaderLists(mcVersion, kinds) {
  const [lists, setLists] = useState({});
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (kind) => {
    const api = window.native?.loaders;
    if (!api?.versions || kind === 'vanilla') return;
    setLists((prev) => ({ ...prev, [kind]: { status: 'loading', data: prev[kind]?.data || null } }));
    try {
      const data = await api.versions(LOADER_NAMES[kind], mcVersion);
      if (alive.current) setLists((prev) => ({ ...prev, [kind]: { status: 'ok', data } }));
    } catch (error) {
      if (alive.current) setLists((prev) => ({ ...prev, [kind]: { status: 'error', error: error?.message || 'Could not load versions' } }));
    }
  }, [mcVersion]);

  const key = kinds.join(',');
  useEffect(() => {
    kinds.forEach((kind) => load(kind));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  return { lists, reload: load };
}

function Tag({ tone = 'muted', children }) {
  return <span className={`ld-tag is-${tone}`}>{children}</span>;
}

export default function LoaderTab({ cluster, running = false, query = '', onUpdateInstance, onNotify }) {
  const mcVersion = String(cluster.version || cluster.mc_version || '');
  const currentKind = normalizeLoader(cluster.loader || cluster.mc_loader);
  const currentPinned = String(cluster.loaderVersion || cluster.mc_loader_version || '');

  const kinds = useMemo(() => ORDER.filter((kind) => {
    if (kind === currentKind) return true;
    // Legacy Fabric only matters where Fabric itself cannot go.
    if (kind === 'legacyfabric') return compareVersions(mcVersion, '1.14') < 0;
    return true;
  }), [currentKind, mcVersion]);

  const availability = useMemo(() => Object.fromEntries(kinds.map((kind) => [
    kind,
    loaderAvailability(LOADER_NAMES[kind], mcVersion, null)
  ])), [kinds, mcVersion]);

  const fetchable = useMemo(() => kinds.filter((kind) => kind !== 'vanilla' && availability[kind]?.available !== false), [kinds, availability]);
  const { lists, reload } = useLoaderLists(mcVersion, fetchable);

  const [target, setTarget] = useState(currentKind);
  const [auto, setAuto] = useState(!currentPinned);
  const [picked, setPicked] = useState(currentPinned || null);
  const [showBetas, setShowBetas] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [check, setCheck] = useState(null);
  const [disableBroken, setDisableBroken] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  // Re-sync after the instance itself changed (a switch just finished).
  useEffect(() => {
    setTarget(currentKind);
    setAuto(!currentPinned);
    setPicked(currentPinned || null);
  }, [currentKind, currentPinned]);

  const choose = (kind) => {
    if (busy) return;
    setTarget(kind);
    setError('');
    setLimit(PAGE);
    if (kind === currentKind) {
      setAuto(!currentPinned);
      setPicked(currentPinned || null);
    } else {
      setAuto(true);
      setPicked(null);
    }
  };

  const list = lists[target];
  const data = list?.data;
  const recommended = data?.recommended || null;
  const effective = target === 'vanilla' ? null : auto ? recommended : picked || recommended;
  const currentEffective = currentKind === 'vanilla'
    ? null
    : currentPinned || (currentKind === target ? recommended : lists[currentKind]?.data?.recommended) || null;
  const switching = target !== currentKind;

  // Which installed mods stop loading under the new loader.
  useEffect(() => {
    setCheck(null);
    const api = window.native?.loaders;
    if (!switching || target === 'vanilla' || currentKind === 'vanilla' || !api?.check) return undefined;
    let cancelled = false;
    setCheck({ loading: true });
    api.check({ instanceId: cluster.id, loader: LOADER_NAMES[target], mcVersion })
      .then((result) => { if (!cancelled) setCheck(result); })
      .catch(() => { if (!cancelled) setCheck(null); });
    return () => { cancelled = true; };
  }, [switching, target, currentKind, cluster.id, mcVersion]);

  // Install progress from the main process.
  useEffect(() => {
    const api = window.native?.loaders;
    if (!api?.onProgress) return undefined;
    return api.onProgress((progress) => {
      if (progress?.instanceId !== cluster.id) return;
      setBusy((prev) => (prev ? {
        detail: progress.detail || prev.detail,
        fraction: typeof progress.fraction === 'number' ? progress.fraction : prev.fraction
      } : prev));
    });
  }, [cluster.id]);

  const q = query.trim().toLowerCase();
  const versions = (data?.versions || []).filter((entry) => (showBetas || entry.stable || entry.version === effective || entry.version === currentPinned)
    && (!q || entry.version.toLowerCase().includes(q)));
  // The chosen and the installed build stay visible even when they are old.
  const visibleVersions = versions.slice(0, limit);
  for (const keep of [effective, currentEffective]) {
    const entry = keep && !visibleVersions.some((item) => item.version === keep) && versions.find((item) => item.version === keep);
    if (entry) visibleVersions.push(entry);
  }
  const betaCount = (data?.versions || []).filter((entry) => !entry.stable).length;

  const updateAvailable = !switching && currentPinned && recommended && compareLoaderVersions(recommended, currentPinned) > 0;

  let action;
  if (switching) {
    action = target === 'vanilla'
      ? 'Switch to Vanilla'
      : currentKind === 'vanilla'
        ? `Install ${LOADER_NAMES[target]} ${effective || ''}`
        : `Switch to ${LOADER_NAMES[target]} ${effective || ''}`;
  } else if (target === 'vanilla') {
    action = null;
  } else if (effective && currentEffective && effective !== currentEffective) {
    action = compareLoaderVersions(effective, currentEffective) > 0 ? `Update to ${effective}` : `Downgrade to ${effective}`;
  } else if (auto !== !currentPinned) {
    action = auto ? 'Follow recommended builds' : `Pin ${effective}`;
  } else {
    action = `Reinstall ${effective || ''}`;
  }
  const reinstall = !switching && action?.startsWith('Reinstall');
  const blocked = running || !!busy || (target !== 'vanilla' && !effective) || (switching && check?.loading);

  const apply = async () => {
    if (blocked) return;
    const api = window.native?.loaders;
    setError('');
    const name = LOADER_NAMES[target];
    setBusy({ detail: target === 'vanilla' ? 'Switching…' : `Preparing ${name} ${effective}…`, fraction: null });
    try {
      let installed = { loader: 'Vanilla', version: null, complete: true };
      if (target !== 'vanilla') {
        if (!api?.install) throw new Error('Loader installs need the desktop app.');
        installed = await api.install({ instanceId: cluster.id, loader: name, mcVersion, version: effective });
      }
      let disabled = [];
      const broken = check?.incompatible || [];
      if (switching && disableBroken && broken.length && api?.disableMods) {
        disabled = await api.disableMods({ instanceId: cluster.id, files: broken.map((mod) => mod.file) });
      }
      const pinned = target === 'vanilla' || auto ? '' : installed.version || effective;
      onUpdateInstance?.(cluster.id, { loader: installed.loader, mc_loader: installed.loader, loaderVersion: pinned, mc_loader_version: pinned });
      const title = target === 'vanilla'
        ? 'Switched to Vanilla'
        : switching
          ? `Switched to ${name} ${installed.version}`
          : reinstall ? `${name} ${installed.version} verified` : `${name} ${installed.version} is ready`;
      const notes = [];
      if (disabled.length) notes.push(`${disabled.length} incompatible mod${disabled.length === 1 ? '' : 's'} disabled`);
      if (target !== 'vanilla' && !installed.complete) notes.push('the rest installs on first launch');
      onNotify?.(title, notes.length ? `${notes.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : undefined);
    } catch (err) {
      setError(err?.message || 'The loader could not be installed.');
    } finally {
      setBusy(null);
    }
  };

  const current = currentKind === 'vanilla'
    ? 'Vanilla'
    : `${LOADER_NAMES[currentKind]} ${currentPinned || currentEffective || ''}`.trim();

  return (
    <div className="ld">
      <div className="ld-scroll">
        {/* Where the instance stands now */}
        <div className="ld-now">
          <div className="ld-now-text">
            <span className="ld-label">Installed</span>
            <strong>{current}</strong>
            <span className="ld-now-meta">
              Minecraft {mcVersion}
              {currentKind !== 'vanilla' && (currentPinned ? ' · pinned build' : ' · follows recommended builds')}
            </span>
          </div>
          {updateAvailable && (
            <div className="ld-update" role="status">
              <span><NativeIcon name="sparkles" size={14} /> {recommended} is available</span>
              <button
                type="button"
                className="ld-btn is-accent"
                disabled={running || !!busy}
                onClick={() => { setPicked(recommended); setAuto(false); }}
              >
                Review update
              </button>
            </div>
          )}
        </div>

        {/* Loader choice */}
        <section className="ld-section" aria-labelledby="ld-loader-h">
          <h4 id="ld-loader-h" className="ld-label">Loader</h4>
          <div className="ld-kinds" role="radiogroup" aria-label="Mod loader">
            {kinds.map((kind) => {
              const rule = availability[kind];
              const listed = lists[kind];
              const none = listed?.status === 'ok' && !listed.data?.versions?.length && kind !== 'vanilla';
              const off = rule?.available === false || none;
              const reason = rule?.available === false ? rule.reason : none ? listed.data?.unavailable : null;
              return (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={target === kind}
                  className={`ld-kind${target === kind ? ' is-on' : ''}${off ? ' is-off' : ''}`}
                  disabled={off || !!busy}
                  title={reason || LOADER_BLURBS[kind]}
                  onClick={() => choose(kind)}
                >
                  <span className="ld-kind-name">{LOADER_NAMES[kind]}</span>
                  {kind === currentKind && <span className="ld-kind-dot" aria-label="current" />}
                </button>
              );
            })}
          </div>
          <p className="ld-hint">
            {availability[target]?.available === false ? availability[target].reason : LOADER_BLURBS[target]}
          </p>
        </section>

        {/* What a switch does to the installed mods */}
        {switching && currentKind !== 'vanilla' && (
          <section className="ld-section" aria-live="polite">
            <h4 className="ld-label">Your mods</h4>
            {target === 'vanilla' ? (
              <p className="ld-hint">Mods stay in the mods folder but Vanilla will not load them. Switch back any time.</p>
            ) : check?.loading ? (
              <p className="ld-hint">Checking installed mods…</p>
            ) : check && check.incompatible?.length ? (
              <div className="ld-compat">
                <p className="ld-compat-title">
                  <NativeIcon name="alert" size={14} />
                  {check.incompatible.length} of {check.incompatible.length + check.compatible} mods are not made for {LOADER_NAMES[target]} and will not load
                </p>
                <ul className="ld-compat-list">
                  {check.incompatible.slice(0, 8).map((mod) => (
                    <li key={mod.file}><span>{mod.name}</span><em>{mod.loader}</em></li>
                  ))}
                  {check.incompatible.length > 8 && <li className="is-more">and {check.incompatible.length - 8} more</li>}
                </ul>
                <label className="ld-check">
                  <input type="checkbox" checked={disableBroken} onChange={(event) => setDisableBroken(event.target.checked)} />
                  <span>Disable them (they stay in the folder and can be turned back on)</span>
                </label>
              </div>
            ) : check ? (
              <p className="ld-hint is-ok">
                <NativeIcon name="check-circle" size={14} />
                {check.compatible ? `All ${check.compatible} mods work on ${LOADER_NAMES[target]}.` : 'No mods installed yet.'}
                {check.unknown?.length ? ` ${check.unknown.length} could not be identified.` : ''}
              </p>
            ) : null}
          </section>
        )}
        {/* Versions */}
        {target !== 'vanilla' && (
          <section className="ld-section" aria-labelledby="ld-ver-h">
            <div className="ld-section-head">
              <h4 id="ld-ver-h" className="ld-label">{LOADER_NAMES[target]} version</h4>
              <div className="ld-switches">
                <label className="ld-check">
                  <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} disabled={!!busy} />
                  <span>Always use the recommended build</span>
                </label>
                {betaCount > 0 && (
                  <label className="ld-check">
                    <input type="checkbox" checked={showBetas} onChange={(event) => setShowBetas(event.target.checked)} />
                    <span>Show betas ({betaCount})</span>
                  </label>
                )}
              </div>
            </div>

            {(!list || list.status === 'loading') && !data && (
              <div className="ld-empty"><NativeIcon name="loader" size={14} className="ld-spin" /> Loading {LOADER_NAMES[target]} builds for {mcVersion}…</div>
            )}
            {list?.status === 'error' && (
              <div className="ld-empty is-error">
                <span>{list.error}</span>
                <button type="button" className="ld-btn" onClick={() => reload(target)}>
                  <NativeIcon name="refresh" size={13} /> Retry
                </button>
              </div>
            )}
            {data && !data.versions.length && (
              <div className="ld-empty">{data.unavailable || `${LOADER_NAMES[target]} has no builds for ${mcVersion}.`}</div>
            )}

            {data && data.versions.length > 0 && (
              <div className="ld-versions" role="radiogroup" aria-label={`${LOADER_NAMES[target]} version`}>
                {visibleVersions.map((entry) => {
                  const on = entry.version === effective;
                  const installed = !switching && entry.version === currentEffective;
                  return (
                    <button
                      key={entry.version}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`ld-ver${on ? ' is-on' : ''}`}
                      disabled={!!busy}
                      onClick={() => { setPicked(entry.version); setAuto(entry.version === recommended ? auto : false); }}
                    >
                      <span className="ld-ver-radio" aria-hidden="true" />
                      <span className="ld-ver-name">{entry.version}</span>
                      <span className="ld-ver-tags">
                        {installed && <Tag tone="ok">Installed</Tag>}
                        {entry.recommended && <Tag tone="accent">Recommended</Tag>}
                        {entry.latest && !entry.recommended && <Tag>Latest</Tag>}
                        {!entry.stable && <Tag tone="warn">Beta</Tag>}
                      </span>
                    </button>
                  );
                })}
                {versions.length > limit && (
                  <button type="button" className="ld-more" onClick={() => setLimit((value) => value + 60)}>
                    Show {Math.min(versions.length - limit, 60)} older builds
                  </button>
                )}
                {!versions.length && <div className="ld-empty">No build matches “{query}”.</div>}
              </div>
            )}
          </section>
        )}

      </div>

      {/* Action bar */}
      <footer className="ld-foot">
        <div className="ld-foot-status" role="status">
          {busy ? (
            <>
              <span className="ld-foot-detail">{busy.detail}</span>
              <span className="ld-bar"><span style={{ width: `${Math.round((busy.fraction ?? 0.08) * 100)}%` }} /></span>
            </>
          ) : error ? (
            <span className="ld-foot-error"><NativeIcon name="alert" size={14} /> {error}</span>
          ) : running ? (
            <span className="ld-foot-detail">Stop the game to change its loader.</span>
          ) : isForgeLikeKind(target) && action && !reinstall ? (
            <span className="ld-foot-detail">The installer downloads now; {LOADER_NAMES[target]} finishes setting up on first launch.</span>
          ) : null}
        </div>
        {action && (
          <div className="ld-foot-actions">
            {(switching || effective !== currentEffective || auto !== !currentPinned) && !busy && (
              <button type="button" className="ld-btn" onClick={() => choose(currentKind)}>Reset</button>
            )}
            <button type="button" className={`ld-btn ${reinstall ? '' : 'is-accent'}`} disabled={blocked} onClick={apply}>
              <NativeIcon name={busy ? 'loader' : reinstall ? 'refresh' : 'download'} size={14} className={busy ? 'ld-spin' : ''} />
              {action.trim()}
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}

function isForgeLikeKind(kind) {
  return kind === 'forge' || kind === 'neoforge';
}

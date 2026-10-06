import React, { useEffect, useRef, useState } from 'react';
import PlayerAvatar from './PlayerAvatar.jsx';
import { loadStripImage, startCapeAnimation } from '../../lib/animatedCape.js';
import { FALLBACK_SKIN, isLocalIdentity, isSlimArmTexture, loadSkinTexture, sanitizeSkinArms, SKIN_SERVICE, skinIdentifier } from '../../lib/skins.js';

const SKIN_PATH = '/skin/';
const CAPE_PATH = '/cape/';

export function skinTextureUrl(account) {
  if (account?.skinUrl) return account.skinUrl;
  // Local (Native or offline) accounts must never fall back to mc-heads by name,
  // as that queries a stranger's Mojang account with that username!
  if (isLocalIdentity(account)) {
    return SKIN_SERVICE + SKIN_PATH + FALLBACK_SKIN;
  }
  const id = skinIdentifier(account) || FALLBACK_SKIN;
  return SKIN_SERVICE + SKIN_PATH + encodeURIComponent(id);
}

export function capeTextureUrl(account) {
  if (!account || account?.capeUrl === null || account?.capeUrl === false || account?.hasCape === false) return null;
  if (account?.capeUrl) return account.capeUrl;
  return null;
}

export function prepareSkinSource(url, modelOption) {
  // Mojang hands out http:// texture URLs; over https the pixels can be read (CORS) to detect slim arms
  if (typeof url === 'string') url = url.replace(/^http:\/\/textures\.minecraft\.net\//, 'https://textures.minecraft.net/');
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || !url) {
      resolve({ source: url, model: modelOption });
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        if (img.naturalWidth === 64 && img.naturalHeight === 64) {
          const canvas = document.createElement('canvas');
          canvas.width = 64;
          canvas.height = 64;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const isSlim = isSlimArmTexture(ctx);
          sanitizeSkinArms(canvas);
          const resolvedModel = isSlim ? 'slim' : (modelOption === 'slim' ? 'slim' : 'default');
          resolve({ source: canvas, model: resolvedModel });
          return;
        }
      } catch {
        /* fallback to url */
      }
      resolve({ source: url, model: modelOption });
    };
    img.onerror = () => resolve({ source: url, model: modelOption });
    img.src = url;
  });
}

/**
 * Live 3D character built on skinview3d.
 *
 * The library is imported lazily so the launcher still runs (falling back to a
 * flat avatar) when node_modules have not been refreshed yet.
 */
export default function SkinViewer3D({
  account,
  width = 200,
  height = 300,
  animation = null,
  paused = false,
  autoRotate = false,
  className = '',
  onViewer = null,
  cosmetics = null,
  zoom = 0.82
}) {
  const canvasRef = useRef(null);
  const viewerRef = useRef(null);
  const libRef = useRef(null);

  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [selfHealed, setSelfHealed] = useState(null);

  // Self-heal local skins from wardrobe if account arrived without skinUrl
  useEffect(() => {
    if (account?.skinUrl || !isLocalIdentity(account) || !window.native?.wardrobe?.avatar) {
      setSelfHealed(null);
      return undefined;
    }
    let cancelled = false;
    window.native.wardrobe.avatar(account).then((res) => {
      if (!cancelled && res?.skinUrl) {
        setSelfHealed({ skinUrl: res.skinUrl, capeUrl: res.capeUrl, model: res.model });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [account?.id, account?.skinUrl]);

  // A wardrobe lookup is only a fallback for an undecorated account. Once the
  // parent supplies a newly selected skin, it must win immediately even if an
  // older self-heal result is still being cleared by React.
  const effectiveAccount = selfHealed && !account?.skinUrl ? { ...account, ...selfHealed } : account;
  const skinUrl = effectiveAccount?.skinUrl || skinTextureUrl(effectiveAccount);
  // A back item (wings, jetpack, backpack) replaces the cape, like in game.
  const backWorn = (cosmetics || []).some((c) => c && c.slot === 'back' && c.model && c.texture);
  const capeUrl = backWorn ? null : capeTextureUrl(effectiveAccount);
  // Animated cape: `capeUrl` stays the first frame; the strip repaints it over time.
  const capeAnim = capeUrl && effectiveAccount?.capeAnim?.stripUrl ? effectiveAccount.capeAnim : null;
  const animKey = capeAnim ? `${capeAnim.frames}@${capeAnim.fps}#${capeAnim.stripUrl.length}:${capeAnim.stripUrl.slice(-40)}` : '';
  const capeAnimRef = useRef(null);
  const capeAnimSource = useRef(null);
  capeAnimSource.current = capeAnim;
  const effectiveModel = effectiveAccount?.model;

  const loadedSkinRef = useRef(null);
  const loadedModelRef = useRef(null);
  const loadedCapeRef = useRef(null);
  const skinReqRef = useRef(0);
  const capeReqRef = useRef(0);

  // 3D cosmetics (hats, glasses, back items, shoes): [{ id, model, texture }] (NCM JSON + image URL)
  const cosmeticsRef = useRef([]);
  const walkRef = useRef(0);
  walkRef.current = animation === 'walk' || animation === 'run' ? 1 : 0;
  const cosmeticKey = (cosmetics || []).filter((c) => c && c.model && c.texture).map((c) => `${c.id}:${c.side || ''}:${String(c.texture).length}:${String(c.texture).slice(-24)}`).join('|');
  const cosmeticSource = useRef(cosmetics);
  cosmeticSource.current = cosmetics;

  const cosmeticsMove = () => cosmeticsRef.current.some((b) => b.model.flat.some((part) => part.anim.length));

  const onViewerRef = useRef(onViewer);
  onViewerRef.current = onViewer;

  /* ---- create the viewer once ---- */
  useEffect(() => {
    let disposed = false;

    import('skinview3d')
      .then((lib) => {
        if (disposed || !canvasRef.current) return;

        libRef.current = lib;
        const initialModel = effectiveModel === 'slim' ? 'slim' : effectiveModel === 'classic' ? 'default' : 'auto-detect';
        const viewer = new lib.SkinViewer({
          canvas: canvasRef.current,
          width,
          height,
          model: initialModel,
          preserveDrawingBuffer: false
        });

        viewer.fov = 42;
        viewer.zoom = zoom;
        viewer.autoRotate = autoRotate;
        viewer.autoRotateSpeed = 0.7;

        // Position cape at z = -2.5 so it rests cleanly behind the outer jacket layer (z = -2.25)
        // avoiding severe z-fighting and texture clipping on the character's back
        const applyCapeOffset = () => {
          if (viewer.playerObject?.cape) {
            viewer.playerObject.cape.position.z = -2.5;
          }
        };
        applyCapeOffset();

        if (viewer.playerObject?.resetJoints) {
          const origResetJoints = viewer.playerObject.resetJoints.bind(viewer.playerObject);
          viewer.playerObject.resetJoints = () => {
            origResetJoints();
            applyCapeOffset();
          };
        }

        if (viewer.controls) {
          viewer.controls.enableZoom = false;
          viewer.controls.enablePan = false;
          viewer.controls.addEventListener('change', () => {
            if (viewer.renderPaused) {
              viewer.render();
            }
          });
        }

        // cosmetics animate with the player (propellers, flapping wings, ...)
        const baseRender = viewer.render.bind(viewer);
        const started = performance.now();
        viewer.render = () => {
          const t = (performance.now() - started) / 1000;
          for (const built of cosmeticsRef.current) built.update(t, walkRef.current);
          baseRender();
        };

        viewerRef.current = viewer;
        onViewerRef.current?.(viewer);
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      cosmeticsRef.current.forEach((built) => { try { built.dispose(); } catch {} });
      cosmeticsRef.current = [];
      capeAnimRef.current?.stop();
      capeAnimRef.current = null;
      try {
        viewerRef.current?.dispose?.();
      } catch {
        /* nothing to clean up */
      }
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- swap the skin when the account changes ---- */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;

    // Arm width is explicit when the locker knows it, otherwise the library
    // infers it from the texture.
    const modelOption = effectiveModel === 'slim'
      ? 'slim'
      : effectiveModel === 'classic'
        ? 'default'
        : 'auto-detect';

    if (loadedSkinRef.current !== skinUrl || loadedModelRef.current !== modelOption) {
      loadedSkinRef.current = skinUrl;
      loadedModelRef.current = modelOption;
      const reqId = ++skinReqRef.current;
      prepareSkinSource(skinUrl, modelOption).then(({ source, model }) => {
        if (reqId !== skinReqRef.current) return;
        return loadSkinTexture(viewer, source, model).then(() => {
          if (reqId !== skinReqRef.current) return;
          if (viewer.renderPaused) viewer.render();
        });
      }).catch(() => {
        if (reqId !== skinReqRef.current) return;
        viewer.loadSkin(SKIN_SERVICE + SKIN_PATH + FALLBACK_SKIN).then(() => {
          if (viewer.renderPaused) viewer.render();
        }).catch(() => {});
      });
    }

    const capeKey = `${capeUrl || ''}|${animKey}`;
    if (loadedCapeRef.current !== capeKey) {
      loadedCapeRef.current = capeKey;
      const reqId = ++capeReqRef.current;
      capeAnimRef.current?.stop();
      capeAnimRef.current = null;
      if (capeUrl) {
        viewer.loadCape(capeUrl).then(() => {
          if (reqId !== capeReqRef.current) return;
          const anim = capeAnimSource.current;
          if (anim) {
            loadStripImage(anim.stripUrl).then((image) => {
              if (reqId !== capeReqRef.current) return;
              capeAnimRef.current = startCapeAnimation(viewer, image, { frames: anim.frames, fps: anim.fps });
            }).catch(() => { /* the still first frame stays */ });
          }
          if (viewer.playerObject?.cape) {
            viewer.playerObject.cape.position.z = -2.5;
            viewer.playerObject.cape.visible = true;
          }
          if (viewer.renderPaused) viewer.render();
        }).catch(() => {
          if (reqId !== capeReqRef.current) return;
          try {
            viewer.loadCape(null);
            if (viewer.playerObject?.cape) {
              viewer.playerObject.cape.visible = false;
            }
            if (viewer.renderPaused) viewer.render();
          } catch {
            /* no cape is fine */
          }
        });
      } else {
        try {
          viewer.loadCape(null);
          if (viewer.playerObject?.cape) {
            viewer.playerObject.cape.visible = false;
          }
          if (viewer.renderPaused) viewer.render();
        } catch {}
      }
    }
  }, [skinUrl, capeUrl, animKey, effectiveModel, ready]);

  /* ---- 3D cosmetics ---- */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return undefined;
    let cancelled = false;
    const clear = () => {
      cosmeticsRef.current.forEach((built) => { try { built.dispose(); } catch {} });
      cosmeticsRef.current = [];
    };
    clear();
    const list = (cosmeticSource.current || []).filter((c) => c && c.model && c.texture);
    if (!list.length) { if (viewer.renderPaused) viewer.render(); return undefined; }
    Promise.all([import('three'), import('../../lib/ncm.js')]).then(async ([THREE, ncm]) => {
      const built = [];
      for (const item of list) {
        try {
          const image = await ncm.loadImage(item.texture);
          if (cancelled) return;
          const one = ncm.attachToPlayer(ncm.buildCosmetic(THREE, item.model, image), viewer.playerObject.skin);
          one.setSide?.(item.side);
          built.push(one);
        } catch { /* a broken cosmetic is skipped, the rest still show */ }
      }
      if (cancelled) { built.forEach((b) => b.dispose()); return; }
      cosmeticsRef.current = built;
      // moving parts need frames even when the player stands still
      if (cosmeticsMove()) viewer.renderPaused = false;
      viewer.render();
    }).catch(() => {});
    return () => { cancelled = true; clear(); };
  }, [cosmeticKey, ready]);

  /* ---- live auto-rotate toggle ---- */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;
    viewer.autoRotate = autoRotate;
    if (autoRotate) viewer.render();
  }, [autoRotate, ready]);

  /* ---- animation selection ---- */
  useEffect(() => {
    const viewer = viewerRef.current;
    const lib = libRef.current;
    if (!viewer || !lib || !ready) return;

    if (!animation || animation === 'none') {
      viewer.animation = null;
      if (viewer.playerObject?.skin) {
        viewer.playerObject.skin.leftArm.rotation.set(0, 0, 0);
        viewer.playerObject.skin.rightArm.rotation.set(0, 0, 0);
        viewer.playerObject.skin.leftLeg.rotation.set(0, 0, 0);
        viewer.playerObject.skin.rightLeg.rotation.set(0, 0, 0);
        viewer.playerObject.skin.head.rotation.set(0, 0, 0);
      }
      if (!autoRotate && !cosmeticsMove()) {
        viewer.renderPaused = true;
      }
      viewer.render();
      return;
    }

    const build = () => {
      if (animation === 'run' && lib.RunningAnimation) return new lib.RunningAnimation();
      if (animation === 'fly' && lib.FlyingAnimation) return new lib.FlyingAnimation();
      if (animation === 'idle' && lib.IdleAnimation) return new lib.IdleAnimation();
      if (animation === 'walk' && lib.WalkingAnimation) return new lib.WalkingAnimation();
      return null;
    };

    const next = build();
    if (!next) {
      viewer.animation = null;
      if (!autoRotate && !cosmeticsMove()) viewer.renderPaused = true;
      viewer.render();
      return;
    }

    viewer.renderPaused = false;
    next.speed = animation === 'run' ? 1.15 : 0.85;
    if ('headBobbing' in next) next.headBobbing = true;

    viewer.animation = next;
    viewer.animation.paused = paused;
  }, [animation, paused, autoRotate, ready]);

  /* ---- keep the canvas in sync with the layout ---- */
  useEffect(() => {
    if (!viewerRef.current || !ready) return;
    viewerRef.current.setSize?.(width, height);
    if (viewerRef.current.renderPaused) {
      viewerRef.current.render();
    }
  }, [width, height, ready]);

  if (failed) {
    return (
      <div className={'skin3d-fallback ' + className} style={{ width, height }}>
        <PlayerAvatar kind="avatar" size={Math.min(112, Math.round(width * 0.6))} account={account} />
        <span className="skin3d-fallback-note">Run npm install to enable the 3D view</span>
      </div>
    );
  }

  return (
    <div className={'skin3d-stage ' + className} style={{ width, height }}>
      <canvas ref={canvasRef} className={'skin3d-canvas ' + (ready ? 'is-ready' : '')} />
      {!ready && <span className="skin3d-loading" />}
    </div>
  );
}

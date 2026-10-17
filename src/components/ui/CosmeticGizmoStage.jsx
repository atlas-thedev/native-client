import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Compass,
  Footprints,
  Maximize2,
  Move,
  RotateCcw,
  RotateCw,
  User
} from 'lucide-react';
import SkinViewer3D from './SkinViewer3D.jsx';
import { computeModelCenter } from '../../lib/ncmImport.js';
import steveSkin from '../../assets/steve.png';
import './CosmeticGizmoStage.css';

const DEFAULT_ACCOUNT = {
  id: 'admin-gizmo-preview',
  type: 'offline',
  name: 'Steve',
  skinUrl: steveSkin,
  model: 'default',
  hasCape: false,
  capeUrl: null
};

const round = (val, decimals = 2) => {
  const factor = 10 ** decimals;
  const v = Math.round(Number(val || 0) * factor) / factor;
  return Object.is(v, -0) ? 0 : v;
};

export default function CosmeticGizmoStage({
  cosmetic, // { id, slot, side, model, texture, mask, dye }
  transform = { ox: 0, oy: 0, oz: 0, rx: 0, ry: 0, rz: 0, scale: 1 },
  onChange,
  width = 300,
  height = 320,
  account = DEFAULT_ACCOUNT,
  className = ''
}) {
  const [mode, setMode] = useState('translate'); // 'translate' | 'rotate' | 'scale' | 'orbit'
  const [stance, setStance] = useState('still'); // 'still' | 'walk'
  const viewerRef = useRef(null);
  const gizmoRef = useRef(null);
  const helperRef = useRef(null);
  const isDraggingRef = useRef(false);
  const cosmeticBuiltRef = useRef(null);

  const modelCenter = useMemo(() => {
    if (!cosmetic?.model) return [0, 0, 0];
    return computeModelCenter(cosmetic.model, cosmetic.side);
  }, [cosmetic?.model, cosmetic?.side]);

  // Current live values in local state for smooth numeric typing
  const ox = round(transform?.ox ?? 0, 2);
  const oy = round(transform?.oy ?? 0, 2);
  const oz = round(transform?.oz ?? 0, 2);
  const rx = round(transform?.rx ?? 0, 1);
  const ry = round(transform?.ry ?? 0, 1);
  const rz = round(transform?.rz ?? 0, 1);
  const scale = round(transform?.scale ?? 1, 3);

  // Synchronize 3D cosmetic when transform changes externally or via numeric input
  const applyLiveTransform = useCallback(
    (nextT) => {
      const built = cosmeticBuiltRef.current;
      if (!built || !built.setTransform) return;
      built.setTransform({
        offset: [Number(nextT.ox) || 0, Number(nextT.oy) || 0, Number(nextT.oz) || 0],
        rotation: [Number(nextT.rx) || 0, Number(nextT.ry) || 0, Number(nextT.rz) || 0],
        scale: Number(nextT.scale) || 1,
        center: modelCenter,
        primarySide: cosmetic?.side || 'right'
      });
      if (viewerRef.current?.render) {
        viewerRef.current.render();
      }
    },
    [modelCenter, cosmetic?.side]
  );

  useEffect(() => {
    if (isDraggingRef.current) return;
    applyLiveTransform({ ox, oy, oz, rx, ry, rz, scale });
  }, [ox, oy, oz, rx, ry, rz, scale, applyLiveTransform]);

  // Attach TransformControls to primary cosmetic root
  const attachGizmo = useCallback(() => {
    const viewer = viewerRef.current;
    const gizmo = gizmoRef.current;
    const built = cosmeticBuiltRef.current;
    if (!viewer || !gizmo) return;

    if (mode === 'orbit' || !built) {
      gizmo.detach();
      if (viewer.render) viewer.render();
      return;
    }

    const primarySide = cosmetic?.side || 'right';
    const primaryRoot =
      built.roots?.find(
        (r) =>
          !r.side ||
          (primarySide === 'left' && r.side === 1) ||
          (primarySide === 'right' && r.side === 2)
      ) || built.roots?.[0];

    const target = primaryRoot?.transformGroup;
    if (target) {
      gizmo.attach(target);
      gizmo.setMode(mode);
      if (viewer.render) viewer.render();
    } else {
      gizmo.detach();
    }
  }, [mode, cosmetic?.side]);

  // Initialize TransformControls once viewer is ready
  const onViewer = useCallback(
    async (viewer) => {
      viewerRef.current = viewer;
      try {
        const { TransformControls } = await import('three/examples/jsm/controls/TransformControls.js');
        if (viewerRef.current !== viewer) return;

        const controls = new TransformControls(viewer.camera, viewer.renderer.domElement);
        controls.size = 0.65;
        controls.space = 'local';
        const helper = controls.getHelper ? controls.getHelper() : controls;
        viewer.scene.add(helper);

        controls.addEventListener('dragging-changed', (event) => {
          isDraggingRef.current = Boolean(event.value);
          if (viewer.controls) {
            viewer.controls.enabled = !event.value;
          }
        });

        controls.addEventListener('objectChange', () => {
          const built = cosmeticBuiltRef.current;
          if (!built || !primaryTargetRef.current) return;
          const tg = primaryTargetRef.current;
          const [cx, cy, cz] = modelCenterRef.current;

          const nOx = round(tg.position.x - cx, 2);
          const nOy = round(tg.position.y - cy, 2);
          const nOz = round(tg.position.z - cz, 2);

          const nRx = round((tg.rotation.x * 180) / Math.PI, 1);
          const nRy = round((tg.rotation.y * 180) / Math.PI, 1);
          const nRz = round((tg.rotation.z * 180) / Math.PI, 1);

          const nScale = round(tg.scale.x, 3);

          // Update other symmetric roots (e.g. left hand if primary is right hand)
          const primarySide = cosmeticSideRef.current;
          for (const r of built.roots || []) {
            if (r.transformGroup && r.transformGroup !== tg) {
              const partSide = r.side === 1 ? 'left' : r.side === 2 ? 'right' : null;
              const isOpposite = Boolean(primarySide && partSide && partSide !== primarySide);
              r.transformGroup.position.set(
                cx + (isOpposite ? -nOx : nOx),
                cy + nOy,
                cz + nOz
              );
              r.transformGroup.rotation.set(
                (nRx * Math.PI) / 180,
                ((isOpposite ? -nRy : nRy) * Math.PI) / 180,
                ((isOpposite ? -nRz : nRz) * Math.PI) / 180
              );
              r.transformGroup.scale.set(nScale, nScale, nScale);
            }
          }

          onChangeRef.current?.({
            ox: nOx,
            oy: nOy,
            oz: nOz,
            rx: nRx,
            ry: nRy,
            rz: nRz,
            scale: nScale
          });

          if (viewer.render) viewer.render();
        });

        gizmoRef.current = controls;
        helperRef.current = helper;
        attachGizmo();
      } catch (err) {
        console.warn('Could not initialize TransformControls', err);
      }
    },
    [attachGizmo]
  );

  // Refs for listeners to avoid re-binding
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const modelCenterRef = useRef(modelCenter);
  modelCenterRef.current = modelCenter;
  const cosmeticSideRef = useRef(cosmetic?.side);
  cosmeticSideRef.current = cosmetic?.side;
  const primaryTargetRef = useRef(null);

  const onCosmeticsLoaded = useCallback(
    (builtList) => {
      const built = builtList?.[0] || null;
      cosmeticBuiltRef.current = built;
      if (built) {
        const primarySide = cosmetic?.side || 'right';
        const primaryRoot =
          built.roots?.find(
            (r) =>
              !r.side ||
              (primarySide === 'left' && r.side === 1) ||
              (primarySide === 'right' && r.side === 2)
          ) || built.roots?.[0];
        primaryTargetRef.current = primaryRoot?.transformGroup || null;

        built.setTransform?.({
          offset: [ox, oy, oz],
          rotation: [rx, ry, rz],
          scale,
          center: modelCenter,
          primarySide
        });
      }
      attachGizmo();
    },
    [ox, oy, oz, rx, ry, rz, scale, modelCenter, cosmetic?.side, attachGizmo]
  );

  useEffect(() => {
    attachGizmo();
  }, [attachGizmo]);

  // Clean up TransformControls on unmount
  useEffect(() => {
    return () => {
      if (helperRef.current && viewerRef.current?.scene) {
        try {
          viewerRef.current.scene.remove(helperRef.current);
          helperRef.current.dispose?.();
        } catch {}
      }
      if (gizmoRef.current) {
        try {
          gizmoRef.current.dispose();
        } catch {}
      }
      gizmoRef.current = null;
      helperRef.current = null;
    };
  }, []);

  // Keyboard shortcuts (W: Move, E: Rotate, R: Scale, Q: Orbit)
  useEffect(() => {
    const onKey = (event) => {
      const tag = document.activeElement?.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'w') setMode('translate');
      else if (key === 'e') setMode('rotate');
      else if (key === 'r') setMode('scale');
      else if (key === 'q') setMode('orbit');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Quick Camera Presets
  const setCameraView = (view) => {
    const viewer = viewerRef.current;
    if (!viewer?.camera || !viewer.controls) return;
    const target = viewer.controls.target;
    const dist = viewer.camera.position.distanceTo(target) || 45;

    if (view === 'front') {
      viewer.camera.position.set(0, target.y + 1, dist);
    } else if (view === 'back') {
      viewer.camera.position.set(0, target.y + 1, -dist);
    } else if (view === 'side') {
      viewer.camera.position.set(dist, target.y + 1, 0);
    }
    viewer.controls.update();
    if (viewer.render) viewer.render();
  };

  const handleReset = () => {
    const resetValues = { ox: 0, oy: 0, oz: 0, rx: 0, ry: 0, rz: 0, scale: 1 };
    applyLiveTransform(resetValues);
    onChange?.(resetValues);
  };

  const updateNumeric = (key, value) => {
    const parsed = Number(value);
    const next = {
      ox,
      oy,
      oz,
      rx,
      ry,
      rz,
      scale,
      [key]: Number.isFinite(parsed) ? parsed : 0
    };
    applyLiveTransform(next);
    onChange?.(next);
  };

  const worn = useMemo(() => {
    if (!cosmetic?.model || !cosmetic?.texture) return [];
    return [
      {
        id: cosmetic.id || 'preview-cosmetic',
        slot: cosmetic.slot || 'hats',
        model: cosmetic.model,
        texture: cosmetic.texture,
        side: cosmetic.side || 'right',
        transform: {
          offset: [ox, oy, oz],
          rotation: [rx, ry, rz],
          scale,
          center: modelCenter,
          primarySide: cosmetic.side || 'right'
        }
      }
    ];
  }, [cosmetic, ox, oy, oz, rx, ry, rz, scale, modelCenter]);

  return (
    <div className={`cosmetic-gizmo-stage ${className}`} style={{ width, height }}>
      <header className="cos-gizmo-bar" role="toolbar" aria-label="3D Transform Tools">
        <div className="cos-gizmo-group">
          <button
            type="button"
            className={`cos-gizmo-btn ${mode === 'translate' ? 'is-active' : ''}`}
            onClick={() => setMode('translate')}
            title="Move (W)"
          >
            <Move size={13} />
            <span>Move</span>
          </button>
          <button
            type="button"
            className={`cos-gizmo-btn ${mode === 'rotate' ? 'is-active' : ''}`}
            onClick={() => setMode('rotate')}
            title="Rotate (E)"
          >
            <RotateCw size={13} />
            <span>Rotate</span>
          </button>
          <button
            type="button"
            className={`cos-gizmo-btn ${mode === 'scale' ? 'is-active' : ''}`}
            onClick={() => setMode('scale')}
            title="Scale (R)"
          >
            <Maximize2 size={13} />
            <span>Scale</span>
          </button>
          <button
            type="button"
            className={`cos-gizmo-btn ${mode === 'orbit' ? 'is-active' : ''}`}
            onClick={() => setMode('orbit')}
            title="Camera Orbit (Q)"
          >
            <Compass size={13} />
            <span>Orbit</span>
          </button>
        </div>

        <div className="cos-gizmo-group">
          <button
            type="button"
            className="cos-gizmo-btn"
            onClick={() => setCameraView('front')}
            title="Front View"
          >
            Front
          </button>
          <button
            type="button"
            className="cos-gizmo-btn"
            onClick={() => setCameraView('back')}
            title="Back View"
          >
            Back
          </button>
          <button
            type="button"
            className="cos-gizmo-btn"
            onClick={() => setCameraView('side')}
            title="Side View"
          >
            Side
          </button>
        </div>

        <div className="cos-gizmo-group">
          <button
            type="button"
            className={`cos-gizmo-btn ${stance === 'walk' ? 'is-active' : ''}`}
            onClick={() => setStance((s) => (s === 'still' ? 'walk' : 'still'))}
            title={stance === 'still' ? 'Switch to Walk' : 'Switch to Still'}
          >
            {stance === 'still' ? <User size={13} /> : <Footprints size={13} />}
            <span>{stance === 'still' ? 'Still' : 'Walk'}</span>
          </button>
          <button
            type="button"
            className="cos-gizmo-btn is-reset"
            onClick={handleReset}
            title="Reset Transform (0,0,0 / 1×)"
          >
            <RotateCcw size={13} />
            <span>Reset</span>
          </button>
        </div>
      </header>

      <div className="cos-gizmo-canvas">
        <SkinViewer3D
          account={account}
          cosmetics={worn}
          zoom={0.76}
          width={width}
          height={height - 76}
          animation={stance === 'walk' ? 'walk' : null}
          autoRotate={false}
          onViewer={onViewer}
          onCosmeticsLoaded={onCosmeticsLoaded}
        />
      </div>

      <footer className="cos-gizmo-inputs">
        <div className="cos-gizmo-field-group" title="Position Offset (X, Y, Z)">
          <span className="cos-gizmo-label">Pos</span>
          <label className="cos-gizmo-num">
            <span>X</span>
            <input
              type="number"
              step={0.25}
              value={ox}
              onChange={(e) => updateNumeric('ox', e.target.value)}
            />
          </label>
          <label className="cos-gizmo-num">
            <span>Y</span>
            <input
              type="number"
              step={0.25}
              value={oy}
              onChange={(e) => updateNumeric('oy', e.target.value)}
            />
          </label>
          <label className="cos-gizmo-num">
            <span>Z</span>
            <input
              type="number"
              step={0.25}
              value={oz}
              onChange={(e) => updateNumeric('oz', e.target.value)}
            />
          </label>
        </div>

        <div className="cos-gizmo-field-group" title="Rotation in degrees (X, Y, Z)">
          <span className="cos-gizmo-label">Rot</span>
          <label className="cos-gizmo-num">
            <span>X</span>
            <input
              type="number"
              step={5}
              value={rx}
              onChange={(e) => updateNumeric('rx', e.target.value)}
            />
          </label>
          <label className="cos-gizmo-num">
            <span>Y</span>
            <input
              type="number"
              step={5}
              value={ry}
              onChange={(e) => updateNumeric('ry', e.target.value)}
            />
          </label>
          <label className="cos-gizmo-num">
            <span>Z</span>
            <input
              type="number"
              step={5}
              value={rz}
              onChange={(e) => updateNumeric('rz', e.target.value)}
            />
          </label>
        </div>

        <div className="cos-gizmo-field-group" title="Uniform Model & Texture Scale">
          <span className="cos-gizmo-label">Scale</span>
          <label className="cos-gizmo-num is-scale">
            <input
              type="number"
              step={0.05}
              min={0.1}
              max={10}
              value={scale}
              onChange={(e) => updateNumeric('scale', e.target.value)}
            />
            <span className="cos-gizmo-suffix">×</span>
          </label>
        </div>
      </footer>
    </div>
  );
}

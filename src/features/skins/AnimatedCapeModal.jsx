import React, { useEffect, useMemo, useState } from 'react';
import { Check, Film, X } from 'lucide-react';
import SkinViewer3D from '../../components/ui/SkinViewer3D.jsx';
import { CAPE_FRAME_SIZES, MAX_FPS, MAX_FRAMES, firstFrameDataUrl, guessFrames, loadStripImage } from '../../lib/animatedCape.js';

const CUSTOM = 'custom';

/**
 * Upload an animated cape: a vertical strip of equally tall frames. Pick the size of ONE frame
 * (64x32 ... 2048x1024, or Custom for any ratio); the frame count follows from the image height.
 */
export default function AnimatedCapeModal({ account, skinUrl, model, file, onClose, onSave, saving }) {
  const [image, setImage] = useState(null);
  const [error, setError] = useState('');
  const [size, setSize] = useState(CUSTOM);
  const [custom, setCustom] = useState({ width: 512, height: 256 });
  const [fps, setFps] = useState(12);
  const [name, setName] = useState(file.name);

  useEffect(() => {
    let alive = true;
    loadStripImage(file.dataUrl).then((img) => {
      if (!alive) return;
      setImage(img);
      const guess = guessFrames(img.naturalWidth, img.naturalHeight);
      if (guess) {
        const standard = CAPE_FRAME_SIZES.find((entry) => entry.width === guess.frameWidth && entry.height === guess.frameHeight);
        setSize(standard ? standard.label : CUSTOM);
        setCustom({ width: guess.frameWidth, height: guess.frameHeight });
      } else {
        setCustom({ width: img.naturalWidth, height: Math.max(1, Math.round(img.naturalWidth / 2)) });
      }
    }).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [file.dataUrl]);

  const frame = size === CUSTOM ? custom : CAPE_FRAME_SIZES.find((entry) => entry.label === size) || custom;
  const problem = useMemo(() => {
    if (!image) return '';
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (!(frame.width > 0 && frame.height > 0)) return 'Enter the width and height of one frame.';
    if (frame.width !== w) return `This strip is ${w}px wide, but the frame size is ${frame.width}px wide.`;
    if (h % frame.height !== 0) return `The strip is ${h}px tall, which is not a whole number of ${frame.height}px frames.`;
    const frames = h / frame.height;
    if (frames < 2) return 'An animation needs at least 2 frames stacked top to bottom.';
    if (frames > MAX_FRAMES) return `That is ${frames} frames. The maximum is ${MAX_FRAMES}.`;
    return '';
  }, [image, frame.width, frame.height]);
  const frames = image && !problem ? image.naturalHeight / frame.height : 0;

  const preview = useMemo(() => {
    if (!image || problem) return null;
    return {
      ...(account || {}),
      model,
      skinUrl,
      capeUrl: firstFrameDataUrl(image, frames),
      hasCape: true,
      capeAnim: { frames, fps, stripUrl: file.dataUrl }
    };
  }, [image, problem, frames, fps, skinUrl, model, account, file.dataUrl]);

  const save = () => {
    if (!image || problem || saving) return;
    onSave({ name: name.trim() || 'Animated cape', anim: { frames, fps }, dataUrl: file.dataUrl, stillDataUrl: firstFrameDataUrl(image, frames) });
  };

  return (
    <div className="locker-modal-overlay" onClick={onClose}>
      <div className="locker-import-modal animcape-modal" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="import-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        <div className="import-modal-preview">
          {preview ? <SkinViewer3D account={preview} width={170} height={230} animation="idle" autoRotate /> : <span className="animcape-wait"><Film size={22} /></span>}
        </div>
        <div className="import-modal-form">
          <div className="import-modal-head"><h3>Animated cape</h3><p>A tall PNG with every frame stacked top to bottom. Players with the Noctra mod see it move; everyone else sees the first frame.</p></div>
          <label className="import-form-field"><span>Name</span><input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
          <label className="import-form-field">
            <span>Frame size</span>
            <select className="animcape-select" value={size} onChange={(event) => setSize(event.target.value)}>
              {CAPE_FRAME_SIZES.map((entry) => <option key={entry.label} value={entry.label}>{entry.label}</option>)}
              <option value={CUSTOM}>Custom Upload…</option>
            </select>
          </label>
          {size === CUSTOM && (
            <div className="animcape-custom">
              <label className="import-form-field"><span>Frame width</span><input type="number" min="1" max="4096" value={custom.width} onChange={(event) => setCustom({ ...custom, width: Math.floor(Number(event.target.value)) || 0 })} /></label>
              <label className="import-form-field"><span>Frame height</span><input type="number" min="1" max="4096" value={custom.height} onChange={(event) => setCustom({ ...custom, height: Math.floor(Number(event.target.value)) || 0 })} /></label>
            </div>
          )}
          <label className="import-form-field"><span>Speed · {fps} frames per second</span><input type="range" min="1" max={MAX_FPS} value={fps} onChange={(event) => setFps(Number(event.target.value))} /></label>
          <p className={`animcape-note${problem || error ? ' is-error' : ''}`} role={problem || error ? 'alert' : 'status'}>
            {error || problem || (image ? `${frames} frames · ${frame.width}×${frame.height} each · ${(frames / fps).toFixed(1)}s loop` : 'Reading your image…')}
          </p>
          <button type="button" className="import-save-btn" onClick={save} disabled={!image || Boolean(problem) || saving}><Check size={15} />{saving ? 'Saving…' : 'Save cape'}</button>
        </div>
      </div>
    </div>
  );
}

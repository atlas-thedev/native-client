import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, CircleHelp, CircleUser, Compass, Layers3, Lightbulb, Menu, MessageSquare, Play, Settings, Sparkles, User, Blocks, X } from 'lucide-react';
import './WelcomeTour.css';

/*
 * Written for someone who has never used a launcher (or Minecraft mods).
 * Every step says what the button is, why you would use it, and what to do
 * next. `term` explains one piece of jargon; `tip` is a concrete first action.
 * A step without a `target` (or whose target is missing) is shown centred.
 */
const TOUR_STEPS = [
  {
    target: null,
    icon: Sparkles,
    eyebrow: 'Welcome',
    title: 'Welcome to Noctra',
    body: 'Noctra is a launcher for Minecraft. It downloads the game for you, keeps different versions and mods neatly separated, and starts the game with one click.',
    steps: ['Create an instance (a game setup)', 'Optionally add mods or shaders', 'Press Play']
  },
  {
    target: '.noctra-rail',
    icon: Menu,
    eyebrow: 'Getting around',
    title: 'This is your menu',
    body: 'The bar on the left is how you move around Noctra. Click any icon to open that page. The page you are on is highlighted, and hovering an icon shows its name.',
    tip: 'You can come back to this tour any time from the “Quick tour” button at the top.'
  },
  {
    target: '[data-tour="instances"]',
    icon: Layers3,
    eyebrow: 'Step 1 · Set up',
    title: 'Instances: your game setups',
    body: 'An instance is one separate copy of Minecraft with its own version, mods and worlds. Make one for survival, another for a modpack, and they will never mix or break each other.',
    term: { name: 'Instance', meaning: 'A self-contained Minecraft setup. Deleting one never touches the others.' },
    tip: 'Open this page and press “New instance” to create your first one.'
  },
  {
    target: '[data-tour="versions"]',
    icon: Blocks,
    eyebrow: 'Step 1 · Set up',
    title: 'Versions: choose your Minecraft',
    body: 'Minecraft has many versions, and each has different features. Here you can browse them all and start a new instance from any one.',
    term: { name: 'Release vs snapshot', meaning: 'Releases are the stable versions. Snapshots are early previews and can be buggy.' },
    tip: 'New to this? Choose the newest release.'
  },
  {
    target: '[data-tour="discover"]',
    icon: Compass,
    eyebrow: 'Step 2 · Customize',
    title: 'Discover: mods, shaders and more',
    body: 'Search thousands of free add-ons for your game: mods that add new features, shaders that make it prettier, and resource packs that change the textures. Install them straight into an instance.',
    term: { name: 'Mod loader', meaning: 'A small helper (Fabric, Forge, NeoForge or Quilt) an instance needs before it can run mods. Pick one when you create the instance.' },
    tip: 'Add-ons are optional. You can play plain Minecraft without any.'
  },
  {
    target: '[data-tour="home"]',
    icon: Play,
    eyebrow: 'Step 3 · Play',
    title: 'Home: press Play',
    body: 'Home is where you start the game. Pick the instance you want, then press the big Play button. The first launch downloads what it needs, so it can take a minute.',
    tip: 'If you are not sure what to pick, use the instance you played most recently.'
  },
  {
    target: '[data-tour="skins"]',
    icon: User,
    eyebrow: 'Make it yours',
    title: 'Locker: skins and capes',
    body: 'Your skin is how your character looks. Upload a skin image, preview it in 3D, and equip it. Capes are decorations worn on the back.',
    tip: 'The Locker needs a free Noctra account so your look can sync between computers.'
  },
  {
    target: '[data-tour="relay"]',
    icon: MessageSquare,
    eyebrow: 'Play together',
    title: 'Relay: friends and chat',
    body: 'Add friends, see who is online, chat, and jump onto the same Minecraft server without leaving the launcher.',
    tip: 'A red number on this icon means you have new messages or friend requests.'
  },
  {
    target: '[data-tour="account"]',
    icon: CircleUser,
    eyebrow: 'Before you play',
    title: 'Your account',
    body: 'This is the player who launches the game. Sign in with a Microsoft account to play online on the official servers, or use a Noctra account for Noctra features and offline play. You can keep several and switch any time.',
    term: { name: 'Microsoft account', meaning: 'The account you bought Minecraft with. It is needed for official multiplayer servers.' }
  },
  {
    target: '[data-tour="settings"]',
    icon: Settings,
    eyebrow: 'Fine-tuning',
    title: 'Settings',
    body: 'Change how much memory Minecraft can use, choose fullscreen or a window size, manage disk space, and check for launcher updates.',
    tip: 'The default settings work for almost everyone. Only change them if something feels slow.'
  },
  {
    target: '[data-tour="tutorial"]',
    preferredSide: 'bottom',
    icon: CircleHelp,
    eyebrow: 'All done',
    title: 'You are ready to play',
    body: 'That is everything you need. Start by creating an instance, then press Play. If you ever get lost, this Quick tour button replays the guide.',
    final: true
  }
];

const CARD_WIDTH = 380;
const CARD_HEIGHT_FALLBACK = 320;
const EDGE_GAP = 14;
const TARGET_GAP = 14;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function positionCard(rect, viewport, preferredSide, CARD_HEIGHT = CARD_HEIGHT_FALLBACK) {
  const centeredTop = clamp(rect.top + rect.height / 2 - CARD_HEIGHT / 2, EDGE_GAP, viewport.height - CARD_HEIGHT - EDGE_GAP);
  const centeredLeft = clamp(rect.left + rect.width / 2 - CARD_WIDTH / 2, EDGE_GAP, viewport.width - CARD_WIDTH - EDGE_GAP);

  const canFitBottom = rect.bottom + TARGET_GAP + CARD_HEIGHT <= viewport.height - EDGE_GAP;
  const canFitRight = rect.right + TARGET_GAP + CARD_WIDTH <= viewport.width - EDGE_GAP;
  const canFitLeft = rect.left - TARGET_GAP - CARD_WIDTH >= EDGE_GAP;
  const canFitTop = rect.top - TARGET_GAP - CARD_HEIGHT >= EDGE_GAP;

  if (preferredSide === 'bottom' && canFitBottom) {
    return { left: centeredLeft, top: rect.bottom + TARGET_GAP, side: 'bottom' };
  }
  if (preferredSide === 'left' && canFitLeft) {
    return { left: rect.left - TARGET_GAP - CARD_WIDTH, top: centeredTop, side: 'left' };
  }
  if (preferredSide === 'right' && canFitRight) {
    return { left: rect.right + TARGET_GAP, top: centeredTop, side: 'right' };
  }
  if (preferredSide === 'top' && canFitTop) {
    return { left: centeredLeft, top: rect.top - TARGET_GAP - CARD_HEIGHT, side: 'top' };
  }

  if (canFitRight) {
    return { left: rect.right + TARGET_GAP, top: centeredTop, side: 'right' };
  }
  if (canFitBottom) {
    return { left: centeredLeft, top: rect.bottom + TARGET_GAP, side: 'bottom' };
  }
  if (canFitLeft) {
    return { left: rect.left - TARGET_GAP - CARD_WIDTH, top: centeredTop, side: 'left' };
  }
  return {
    left: centeredLeft,
    top: clamp(rect.top - TARGET_GAP - CARD_HEIGHT, EDGE_GAP, viewport.height - CARD_HEIGHT - EDGE_GAP),
    side: 'top'
  };
}

export default function WelcomeTour({ open, onClose }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [layout, setLayout] = useState(null);
  const nextRef = useRef(null);
  const cardRef = useRef(null);
  const cardHeightRef = useRef(CARD_HEIGHT_FALLBACK);
  const step = TOUR_STEPS[stepIndex];
  const isLast = stepIndex === TOUR_STEPS.length - 1;
  const isFirst = stepIndex === 0;

  const measure = useCallback(() => {
    if (!open || !step) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const target = step.target ? document.querySelector(step.target) : null;

    // No target (welcome step) or the target is not on screen: show the card centred.
    if (!target) {
      setLayout({
        target: null,
        card: {
          left: Math.max(EDGE_GAP, (viewport.width - CARD_WIDTH) / 2),
          top: Math.max(EDGE_GAP, (viewport.height - cardHeightRef.current) / 2),
          side: 'center'
        }
      });
      return;
    }

    const rect = target.getBoundingClientRect();

    const isSidebarRail =
      step.target === '.noctra-rail' || target.classList.contains('noctra-rail');

    if (isSidebarRail) {
      const pad = 4;
      const targetRect = {
        left: pad,
        top: pad,
        width: Math.round(rect.width) - pad * 2,
        height: window.innerHeight - pad * 2,
        right: Math.round(rect.width) - pad,
        bottom: window.innerHeight - pad,
        borderRadius: 14
      };
      const card = positionCard(targetRect, viewport, step.preferredSide || 'right', cardHeightRef.current);
      setLayout({ target: targetRect, card });
      return;
    }

    const computed = window.getComputedStyle(target);
    const rawRadius = parseFloat(computed.borderRadius) || 0;

    const isPill =
      step.target === '[data-tour="tutorial"]' ||
      target.classList.contains('quick-tutorial-btn') ||
      rawRadius >= Math.min(rect.width, rect.height) / 2 - 2 ||
      computed.borderRadius.includes('9999') ||
      computed.borderRadius.includes('100%');

    let padX = 5;
    let padY = 5;

    if (isPill) {
      padX = 6;
      padY = rect.top <= 8 ? Math.max(2.5, Math.min(3.5, rect.top - 2)) : 4;
    }

    const top = Math.max(2, Math.round((rect.top - padY) * 2) / 2);
    const verticalPad = rect.top - top;
    const height = Math.round((rect.height + verticalPad * 2) * 2) / 2;

    const left = Math.max(2, Math.round((rect.left - padX) * 2) / 2);
    const horizontalPad = rect.left - left;
    const width = Math.round((rect.width + horizontalPad * 2) * 2) / 2;

    const borderRadius = isPill
      ? 9999
      : Math.min(Math.round((rawRadius || 10) + 4), height / 2);

    const targetRect = {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      borderRadius
    };
    const card = positionCard(targetRect, viewport, step.preferredSide, cardHeightRef.current);
    setLayout({ target: targetRect, card });
  }, [open, step]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
    };
  }, [open, stepIndex, measure]);

  // Position the card with its real height once it has rendered.
  useLayoutEffect(() => {
    const height = cardRef.current?.offsetHeight;
    if (height && Math.abs(height - cardHeightRef.current) > 2) {
      cardHeightRef.current = height;
      measure();
    }
  });

  useEffect(() => {
    if (!open) return undefined;
    const focusFrame = requestAnimationFrame(() => nextRef.current?.focus());
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.('skip');
      if (event.key === 'ArrowLeft' && stepIndex > 0) setStepIndex((value) => value - 1);
      if ((event.key === 'ArrowRight' || event.key === 'Enter') && event.target?.tagName !== 'BUTTON') {
        if (isLast) onClose?.('complete');
        else setStepIndex((value) => value + 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isLast, onClose, open, stepIndex]);

  useEffect(() => {
    if (!open) setStepIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open || !step || !step.target) return undefined;
    const target = document.querySelector(step.target);
    if (!target) return undefined;
    target.setAttribute('data-tour-target-active', 'true');
    return () => {
      target.removeAttribute('data-tour-target-active');
    };
  }, [open, stepIndex, step]);

  if (!open || !layout) return null;

  const StepIcon = step.icon;
  const goNext = () => {
    if (isLast) onClose?.('complete');
    else setStepIndex((value) => value + 1);
  };

  return (
    <div className="welcome-tour" role="presentation">
      {layout.target ? (
        <div
          className="welcome-tour-spotlight"
          aria-hidden="true"
          style={{
            left: layout.target.left,
            top: layout.target.top,
            width: layout.target.width,
            height: layout.target.height,
            borderRadius: `${layout.target.borderRadius}px`
          }}
        />
      ) : (
        <div className="welcome-tour-dim" aria-hidden="true" />
      )}

      <section
        ref={cardRef}
        className={`welcome-tour-card is-${layout.card.side}${isFirst ? ' is-welcome' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-tour-title"
        style={{ left: layout.card.left, top: layout.card.top }}
      >
        <button type="button" className="welcome-tour-close" onClick={() => onClose?.('skip')} aria-label="Close tutorial">
          <X size={15} />
        </button>

        <header className="welcome-tour-head">
          <span className="welcome-tour-badge" aria-hidden="true">
            {StepIcon ? <StepIcon size={18} /> : null}
          </span>
          <div>
            <span className="welcome-tour-step">{step.eyebrow}</span>
            <h2 id="welcome-tour-title">{step.title}</h2>
          </div>
        </header>

        <p className="welcome-tour-body">{step.body}</p>

        {step.steps && (
          <ol className="welcome-tour-flow">
            {step.steps.map((label, index) => (
              <li key={label}>
                <b>{index + 1}</b>
                <span>{label}</span>
              </li>
            ))}
          </ol>
        )}

        {step.term && (
          <div className="welcome-tour-note is-term">
            <BookOpen size={14} aria-hidden="true" />
            <p><strong>{step.term.name}:</strong> {step.term.meaning}</p>
          </div>
        )}

        {step.tip && (
          <div className="welcome-tour-note is-tip">
            <Lightbulb size={14} aria-hidden="true" />
            <p>{step.tip}</p>
          </div>
        )}

        <footer className="welcome-tour-actions">
          <div className="welcome-tour-dots" role="group" aria-label={`Step ${stepIndex + 1} of ${TOUR_STEPS.length}`}>
            {TOUR_STEPS.map((item, index) => (
              <button
                key={item.title}
                type="button"
                className={index === stepIndex ? 'is-current' : index < stepIndex ? 'is-done' : ''}
                onClick={() => setStepIndex(index)}
                aria-label={`Go to step ${index + 1}: ${item.title}`}
                aria-current={index === stepIndex ? 'step' : undefined}
              />
            ))}
          </div>

          <div className="welcome-tour-buttons">
            {isFirst ? (
              <button type="button" className="welcome-tour-skip" onClick={() => onClose?.('skip')}>Skip</button>
            ) : (
              <button
                type="button"
                className="welcome-tour-back"
                onClick={() => setStepIndex((value) => Math.max(0, value - 1))}
                aria-label="Previous tutorial step"
              >
                <ArrowLeft size={14} />
              </button>
            )}
            <button ref={nextRef} type="button" className="welcome-tour-next" onClick={goNext}>
              <span>{isFirst ? 'Start the tour' : isLast ? 'Start playing' : 'Next'}</span>
              {isLast ? <Check size={15} /> : <ArrowRight size={15} />}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import Logo from '../../components/ui/Logo.jsx';
import './WelcomeTour.css';

/*
 * Short, plain copy for first-time users: what the page is, then what to do.
 * A step without a `target` (or whose target is missing) is shown centred.
 */
const TOUR_STEPS = [
  {
    target: null,
    title: 'Welcome to Noctra',
    body: 'Noctra downloads Minecraft, keeps your versions and mods organised, and launches the game. This short tour covers the essentials.'
  },
  {
    target: '.noctra-rail',
    title: 'Navigation',
    body: 'Use the sidebar to move between pages. Hover an icon to see its name.'
  },
  {
    target: '[data-tour="instances"]',
    title: 'Instances',
    body: 'An instance is a separate Minecraft install with its own version, mods and worlds. Create your first one here.'
  },
  {
    target: '[data-tour="versions"]',
    title: 'Versions',
    body: 'Browse every Minecraft release and snapshot. If you are unsure, choose the latest release.'
  },
  {
    target: '[data-tour="discover"]',
    title: 'Discover',
    body: 'Find mods, shaders, resource packs and modpacks, and add them to an instance. Mods need a loader such as Fabric or Forge, which you choose when you create the instance.'
  },
  {
    target: '[data-tour="home"]',
    title: 'Home',
    body: 'Pick an instance and press Play. The first launch downloads the game files, so it can take a minute.'
  },
  {
    target: '[data-tour="skins"]',
    title: 'Locker',
    body: 'Change your skin and cape and preview them in 3D. Requires a Noctra account.'
  },
  {
    target: '[data-tour="relay"]',
    title: 'Relay',
    body: 'Chat with friends, see who is online and join their server.'
  },
  {
    target: '[data-tour="account"]',
    title: 'Accounts',
    body: 'Sign in with a Microsoft account to play on official servers, or use a Noctra account for offline play and cloud features. You can switch at any time.'
  },
  {
    target: '[data-tour="settings"]',
    title: 'Settings',
    body: 'Adjust memory, window size, Java, storage and updates. The defaults work for most setups.'
  },
  {
    target: '[data-tour="tutorial"]',
    preferredSide: 'bottom',
    title: 'That is it',
    body: 'You can replay this tour any time from Quick tour in the title bar.'
  }
];

const CARD_WIDTH = 340;
const CARD_HEIGHT_FALLBACK = 170;
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

  const goNext = () => {
    if (isLast) onClose?.('complete');
    else setStepIndex((value) => value + 1);
  };
  const goBack = () => setStepIndex((value) => Math.max(0, value - 1));

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
        {isFirst ? (
          <div className="welcome-tour-brand" aria-hidden="true">
            <Logo height={30} variant="mark" />
          </div>
        ) : (
          <div className="welcome-tour-meta">
            <span className="welcome-tour-step">{stepIndex} of {TOUR_STEPS.length - 1}</span>
            <button type="button" className="welcome-tour-close" onClick={() => onClose?.('skip')} aria-label="Close tutorial">
              <X size={14} />
            </button>
          </div>
        )}

        <h2 id="welcome-tour-title">{step.title}</h2>
        <p className="welcome-tour-body">{step.body}</p>

        <footer className="welcome-tour-actions">
          {isFirst ? (
            <button type="button" className="welcome-tour-skip" onClick={() => onClose?.('skip')}>Skip</button>
          ) : (
            <button type="button" className="welcome-tour-back" onClick={goBack}>Back</button>
          )}
          <button ref={nextRef} type="button" className="welcome-tour-next" onClick={goNext}>
            {isFirst ? 'Take the tour' : isLast ? 'Done' : 'Next'}
          </button>
        </footer>
      </section>
    </div>
  );
}

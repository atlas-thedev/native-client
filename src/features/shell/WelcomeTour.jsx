import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import TourScene from './TourScenes.jsx';
import './WelcomeTour.css';

/*
 * Quick tour. Each step pairs a short explanation with a small motion
 * vignette (TourScenes.jsx) and a spotlight that glides to the part of the
 * launcher being described. A step whose target is missing is shown centred.
 */
export const TOUR_STEPS = [
  {
    target: null,
    scene: 'welcome',
    title: 'Welcome to Noctra',
    body: 'Noctra downloads Minecraft, keeps your versions and mods organised, and launches the game. This takes about a minute.'
  },
  {
    target: '.noctra-rail',
    scene: 'nav',
    title: 'Navigation',
    body: 'The sidebar takes you to every page. Hover an icon to see its name.'
  },
  {
    target: '[data-tour="instances"]',
    scene: 'instances',
    title: 'Instances',
    body: 'An instance is a separate Minecraft install with its own version, mods and worlds. Create your first one here.'
  },
  {
    target: '[data-tour="versions"]',
    scene: 'versions',
    title: 'Versions',
    body: 'Every release and snapshot, ready to install. If you are unsure, pick the latest release.'
  },
  {
    target: '[data-tour="discover"]',
    scene: 'discover',
    title: 'Discover',
    body: 'Find mods, shaders, resource packs and modpacks and install them in one click. Mods need a loader such as Fabric or NeoForge.'
  },
  {
    target: '[data-tour="home"]',
    scene: 'home',
    title: 'Home',
    body: 'Pick an instance and press Launch. The first launch downloads the game files, so it can take a minute.'
  },
  {
    target: '[data-tour="skins"]',
    scene: 'locker',
    title: 'Locker',
    body: 'Change your skin and cape and preview them in 3D. Requires a Noctra account.'
  },
  {
    target: '[data-tour="relay"]',
    scene: 'relay',
    title: 'Relay',
    body: 'Chat with friends, see what they are playing and join their server.'
  },
  {
    target: '[data-tour="account"]',
    scene: 'accounts',
    title: 'Accounts',
    body: 'Use a Microsoft account for official servers, or a Noctra account for offline play and cloud features. Switch at any time.'
  },
  {
    target: '[data-tour="settings"]',
    scene: 'settings',
    title: 'Settings',
    body: 'Memory, window size, Java, storage and updates. The defaults work for most setups.'
  },
  {
    target: '[data-tour="tutorial"]',
    scene: 'done',
    preferredSide: 'bottom',
    title: 'You are all set',
    body: 'Replay this tour any time from Quick tour in the title bar.'
  }
];

const CARD_WIDTH = 348;
const WELCOME_WIDTH = 420;
const CARD_HEIGHT_FALLBACK = 330;
const EDGE_GAP = 14;
const TARGET_GAP = 16;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function positionCard(rect, viewport, preferredSide, cardHeight, cardWidth) {
  const centeredTop = clamp(rect.top + rect.height / 2 - cardHeight / 2, EDGE_GAP, viewport.height - cardHeight - EDGE_GAP);
  const centeredLeft = clamp(rect.left + rect.width / 2 - cardWidth / 2, EDGE_GAP, viewport.width - cardWidth - EDGE_GAP);

  const fits = {
    bottom: rect.bottom + TARGET_GAP + cardHeight <= viewport.height - EDGE_GAP,
    right: rect.right + TARGET_GAP + cardWidth <= viewport.width - EDGE_GAP,
    left: rect.left - TARGET_GAP - cardWidth >= EDGE_GAP,
    top: rect.top - TARGET_GAP - cardHeight >= EDGE_GAP
  };
  const place = {
    bottom: () => ({ left: centeredLeft, top: rect.bottom + TARGET_GAP, side: 'bottom' }),
    right: () => ({ left: rect.right + TARGET_GAP, top: centeredTop, side: 'right' }),
    left: () => ({ left: rect.left - TARGET_GAP - cardWidth, top: centeredTop, side: 'left' }),
    top: () => ({ left: centeredLeft, top: rect.top - TARGET_GAP - cardHeight, side: 'top' })
  };

  if (preferredSide && fits[preferredSide]) return place[preferredSide]();
  for (const side of ['right', 'bottom', 'left', 'top']) {
    if (fits[side]) return place[side]();
  }
  // Nothing fits cleanly (tiny window): overlay the card, kept on screen.
  return {
    left: centeredLeft,
    top: clamp(rect.bottom + TARGET_GAP, EDGE_GAP, viewport.height - cardHeight - EDGE_GAP),
    side: 'center'
  };
}

function targetRectFor(step, target) {
  const rect = target.getBoundingClientRect();
  if (step.target === '.noctra-rail' || target.classList.contains('noctra-rail')) {
    const pad = 4;
    return {
      left: pad,
      top: pad,
      width: Math.round(rect.width) - pad * 2,
      height: window.innerHeight - pad * 2,
      right: Math.round(rect.width) - pad,
      bottom: window.innerHeight - pad,
      borderRadius: 14
    };
  }

  const computed = window.getComputedStyle(target);
  const rawRadius = parseFloat(computed.borderRadius) || 0;
  const isPill = step.target === '[data-tour="tutorial"]'
    || target.classList.contains('quick-tutorial-btn')
    || rawRadius >= Math.min(rect.width, rect.height) / 2 - 2
    || computed.borderRadius.includes('9999')
    || computed.borderRadius.includes('100%');

  const padX = isPill ? 6 : 5;
  const padY = isPill ? (rect.top <= 8 ? clamp(rect.top - 2, 2.5, 3.5) : 4) : 5;
  const top = Math.max(2, Math.round((rect.top - padY) * 2) / 2);
  const height = Math.round((rect.height + (rect.top - top) * 2) * 2) / 2;
  const left = Math.max(2, Math.round((rect.left - padX) * 2) / 2);
  const width = Math.round((rect.width + (rect.left - left) * 2) * 2) / 2;
  const borderRadius = isPill ? height / 2 : Math.min(Math.round((rawRadius || 10) + 4), height / 2);
  return { left, top, width, height, right: left + width, bottom: top + height, borderRadius };
}

function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0
    && rect.bottom > 0 && rect.right > 0
    && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

export default function WelcomeTour({ open, onClose }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [layout, setLayout] = useState(null);
  const nextRef = useRef(null);
  const cardRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const cardHeightRef = useRef(CARD_HEIGHT_FALLBACK);
  const step = TOUR_STEPS[stepIndex];
  const total = TOUR_STEPS.length;
  const isLast = stepIndex === total - 1;
  const isFirst = stepIndex === 0;
  const cardWidth = isFirst ? WELCOME_WIDTH : CARD_WIDTH;

  const measure = useCallback(() => {
    if (!open || !step) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const width = Math.min(cardWidth, viewport.width - EDGE_GAP * 2);
    const height = Math.min(cardHeightRef.current, viewport.height - EDGE_GAP * 2);
    const target = step.target ? document.querySelector(step.target) : null;

    if (!isVisible(target)) {
      setLayout({
        target: null,
        card: {
          left: Math.max(EDGE_GAP, (viewport.width - width) / 2),
          top: Math.max(EDGE_GAP, (viewport.height - height) / 2),
          side: 'center'
        }
      });
      return;
    }

    const targetRect = targetRectFor(step, target);
    const fallbackSide = step.target === '.noctra-rail' ? 'right' : undefined;
    const card = positionCard(targetRect, viewport, step.preferredSide || fallbackSide, height, width);
    setLayout({ target: targetRect, card });
  }, [open, step, cardWidth]);

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

  // Re-position once the card has rendered with its real height.
  useLayoutEffect(() => {
    const height = cardRef.current?.offsetHeight;
    if (height && Math.abs(height - cardHeightRef.current) > 2) {
      cardHeightRef.current = height;
      measure();
    }
  });

  const goTo = useCallback((index) => {
    setStepIndex((current) => {
      const next = clamp(index, 0, total - 1);
      setDirection(next >= current ? 1 : -1);
      return next;
    });
  }, [total]);

  const goNext = useCallback(() => {
    if (isLast) onClose?.('complete');
    else goTo(stepIndex + 1);
  }, [goTo, isLast, onClose, stepIndex]);

  const goBack = useCallback(() => goTo(stepIndex - 1), [goTo, stepIndex]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.('skip');
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
        return;
      }
      if (event.key === 'ArrowRight' || (event.key === 'Enter' && event.target?.tagName !== 'BUTTON')) {
        event.preventDefault();
        goNext();
        return;
      }
      // Keep keyboard focus inside the tour card.
      if (event.key === 'Tab' && cardRef.current) {
        const focusable = [...cardRef.current.querySelectorAll('button:not([disabled])')];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!cardRef.current.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [goBack, goNext, onClose, open]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => nextRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, stepIndex]);

  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement;
      return undefined;
    }
    setStepIndex(0);
    setDirection(1);
    setLayout(null);
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open || !step?.target) return undefined;
    const target = document.querySelector(step.target);
    if (!target) return undefined;
    target.setAttribute('data-tour-target-active', 'true');
    return () => target.removeAttribute('data-tour-target-active');
  }, [open, step]);

  if (!open || !layout) return null;

  const spotlightStyle = layout.target
    ? {
        transform: `translate3d(${layout.target.left}px, ${layout.target.top}px, 0)`,
        width: layout.target.width,
        height: layout.target.height,
        borderRadius: `${layout.target.borderRadius}px`
      }
    : null;

  return (
    <div className={`welcome-tour${layout.target ? ' has-target' : ''}`} role="presentation">
      <div className="welcome-tour-scrim" aria-hidden="true" />
      {spotlightStyle && (
        <div className="welcome-tour-spotlight" aria-hidden="true" style={spotlightStyle}>
          <span key={stepIndex} className="welcome-tour-pulse" />
        </div>
      )}

      <section
        ref={cardRef}
        className={`welcome-tour-card is-${layout.card.side}${isFirst ? ' is-welcome' : ''}${isLast ? ' is-last' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-tour-title"
        aria-describedby="welcome-tour-body"
        style={{ width: cardWidth, transform: `translate3d(${layout.card.left}px, ${layout.card.top}px, 0)` }}
      >
        <div className="welcome-tour-stage">
          <div key={step.scene} className={`welcome-tour-scene dir-${direction > 0 ? 'next' : 'back'}`}>
            <TourScene name={step.scene} />
          </div>
          <button type="button" className="welcome-tour-close" onClick={() => onClose?.('skip')} aria-label="Close quick tour">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div key={stepIndex} className={`welcome-tour-content dir-${direction > 0 ? 'next' : 'back'}`} aria-live="polite">
          <span className="welcome-tour-eyebrow">
            {isFirst ? 'Quick tour' : `Step ${stepIndex} of ${total - 1}`}
          </span>
          <h2 id="welcome-tour-title">{step.title}</h2>
          <p id="welcome-tour-body" className="welcome-tour-body">{step.body}</p>
        </div>

        <div className="welcome-tour-progress" role="presentation">
          {TOUR_STEPS.slice(1).map((item, index) => (
            <button
              key={item.title}
              type="button"
              tabIndex={-1}
              className={`welcome-tour-seg${index + 1 < stepIndex ? ' is-done' : ''}${index + 1 === stepIndex ? ' is-current' : ''}`}
              onClick={() => goTo(index + 1)}
              aria-label={`Go to ${item.title}`}
            >
              <i />
            </button>
          ))}
        </div>

        <footer className="welcome-tour-actions">
          {isFirst ? (
            <button type="button" className="welcome-tour-ghost" onClick={() => onClose?.('skip')}>Skip</button>
          ) : (
            <button type="button" className="welcome-tour-ghost" onClick={goBack}>
              <ArrowLeft size={13} strokeWidth={2} /> Back
            </button>
          )}
          <button ref={nextRef} type="button" className="welcome-tour-next" onClick={goNext}>
            <span>{isFirst ? 'Take the tour' : isLast ? 'Done' : 'Next'}</span>
            {!isLast && <ArrowRight size={13} strokeWidth={2.25} />}
          </button>
        </footer>
      </section>
    </div>
  );
}

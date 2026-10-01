import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, BookOpen, Boxes, Compass, LifeBuoy, PlayCircle, Rocket, Search, UsersRound, X
} from 'lucide-react';
import GuideVideo from './GuideVideo.jsx';
import { GUIDES, GUIDE_CATEGORIES, formatDuration, guideById, useGuideVideos } from './guides.js';
import './GuidesView.css';

const CATEGORY_ICON = { start: Rocket, play: Boxes, content: Compass, account: UsersRound, help: LifeBuoy };

export function matchGuide(guide, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const haystack = [guide.title, guide.summary, ...(guide.tags || []), ...(guide.steps || []).map((step) => `${step.title} ${step.body}`)]
    .join(' ')
    .toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

export default function GuidesView({ initialGuideId = null, onAction }) {
  const videos = useGuideVideos();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [openId, setOpenId] = useState(initialGuideId);
  const scrollRef = useRef(null);

  useEffect(() => { if (initialGuideId) setOpenId(initialGuideId); }, [initialGuideId]);
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: 0 }); }, [openId]);

  const featured = GUIDES.find((guide) => guide.featured);
  const visible = useMemo(
    () => GUIDES.filter((guide) => (category === 'all' || guide.category === category) && matchGuide(guide, query)),
    [category, query]
  );
  const open = openId ? guideById(openId) : null;

  return (
    <div className="guides-page" ref={scrollRef}>
      {open ? (
        <GuideDetail
          guide={open}
          video={open.video ? videos[open.video] : null}
          videos={videos}
          onBack={() => setOpenId(null)}
          onOpen={setOpenId}
          onAction={onAction}
        />
      ) : (
        <>
          <header className="guides-head">
            <div className="guides-head-text">
              <span className="guides-eyebrow"><BookOpen size={13} aria-hidden="true" /> How to</span>
              <h1>Learn Noctra in minutes</h1>
              <p>Short answers and screen-recorded videos for everything in the launcher.</p>
            </div>
            <label className="guides-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search questions, like “install mods”"
                aria-label="Search how-to guides"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button>
              )}
            </label>
          </header>

          {featured && !query && category === 'all' && (
            <section className="guides-hero" aria-label="Featured video">
              <GuideVideo video={videos[featured.video]} title={featured.title} />
              <div className="guides-hero-text">
                <span className="guides-pill"><PlayCircle size={12} aria-hidden="true" /> Full walkthrough</span>
                <h2>{featured.title}</h2>
                <p>{featured.summary}</p>
                <div className="guides-hero-actions">
                  <button type="button" className="guides-primary" onClick={() => setOpenId(featured.id)}>
                    Open guide <ArrowRight size={14} aria-hidden="true" />
                  </button>
                  {featured.action && (
                    <button type="button" className="guides-ghost" onClick={() => onAction?.(featured.action)}>
                      {featured.action.label}
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          <nav className="guides-cats" aria-label="Guide categories">
            <button type="button" className={category === 'all' ? 'is-active' : ''} onClick={() => setCategory('all')}>All</button>
            {GUIDE_CATEGORIES.map((item) => {
              const Icon = CATEGORY_ICON[item.id];
              return (
                <button key={item.id} type="button" className={category === item.id ? 'is-active' : ''} onClick={() => setCategory(item.id)}>
                  {Icon && <Icon size={13} aria-hidden="true" />} {item.label}
                </button>
              );
            })}
          </nav>

          {visible.length === 0 ? (
            <div className="guides-empty">
              <strong>No guide matches “{query}”.</strong>
              <span>Try fewer words, or ask in the Noctra Discord.</span>
            </div>
          ) : (
            <div className="guides-grid">
              {visible.map((guide, index) => (
                <GuideCard
                  key={guide.id}
                  guide={guide}
                  video={guide.video ? videos[guide.video] : null}
                  index={index}
                  onOpen={() => setOpenId(guide.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GuideCard({ guide, video, index, onOpen }) {
  const Icon = CATEGORY_ICON[guide.category] || BookOpen;
  const length = formatDuration(video?.duration);
  return (
    <button type="button" className="guide-card" style={{ '--i': index }} onClick={onOpen}>
      <span className="guide-card-top">
        <span className="guide-card-icon"><Icon size={15} aria-hidden="true" /></span>
        {video && (
          <span className="guide-card-video">
            <PlayCircle size={12} aria-hidden="true" /> {length || 'Video'}
          </span>
        )}
      </span>
      <strong>{guide.title}</strong>
      <span className="guide-card-summary">{guide.summary}</span>
      <span className="guide-card-go">Read guide <ArrowRight size={13} aria-hidden="true" /></span>
    </button>
  );
}

function GuideDetail({ guide, video, videos, onBack, onOpen, onAction }) {
  const related = GUIDES.filter((item) => item.category === guide.category && item.id !== guide.id).slice(0, 3);
  const category = GUIDE_CATEGORIES.find((item) => item.id === guide.category);
  return (
    <article className="guide-detail" aria-labelledby="guide-title">
      <button type="button" className="guide-back" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" /> All guides
      </button>
      <header className="guide-detail-head">
        {category && <span className="guides-eyebrow">{category.label}</span>}
        <h1 id="guide-title">{guide.title}</h1>
        <p>{guide.summary}</p>
      </header>

      <div className={`guide-detail-body${video ? ' has-video' : ''}`}>
        {video && <GuideVideo key={video.src} video={video} title={guide.title} />}

        <section className="guide-steps" aria-label="Steps">
          <ol>
            {guide.steps.map((step, index) => (
              <li key={step.title} style={{ '--i': index }}>
                <span className="guide-step-num">{index + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          {guide.action && (
            <button type="button" className="guides-primary guide-action" onClick={() => onAction?.(guide.action)}>
              {guide.action.label} <ArrowRight size={14} aria-hidden="true" />
            </button>
          )}
        </section>
      </div>

      {related.length > 0 && (
        <section className="guide-related" aria-label="Related guides">
          <h2>Related</h2>
          <div className="guides-grid is-related">
            {related.map((item, index) => (
              <GuideCard key={item.id} guide={item} video={item.video ? videos[item.video] : null} index={index} onOpen={() => onOpen(item.id)} />
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

import React from 'react';

export default function CategoryChips({ categories = [], selected = [], onToggle, onClear }) {
  if (categories.length === 0) return null;

  return (
    <div className="browse-chips-row" role="group" aria-label="Categories" data-testid="browse-category-chips">
      <button
        type="button"
        className={`browse-cat-chip ${selected.length === 0 ? 'is-selected' : ''}`}
        onClick={onClear}
      >
        All
      </button>
      {categories.map((name) => (
        <button
          key={name}
          type="button"
          className={`browse-cat-chip ${selected.includes(name) ? 'is-selected' : ''}`}
          onClick={() => onToggle(name)}
          aria-pressed={selected.includes(name)}
        >
          {name.replace(/-/g, ' ')}
        </button>
      ))}
    </div>
  );
}

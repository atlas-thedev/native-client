import React from 'react';
import { Check } from 'lucide-react';
import { ItemThumb } from './AdminStore.jsx';

/** Multi-select grid of Store items (cloaks and cosmetics) with their real previews. */
export default function AdminPicker({ items, value = [], onChange, max, strips = {}, empty = 'Nothing to pick yet.' }) {
  const toggle = (id) => {
    if (value.includes(id)) return onChange(value.filter((entry) => entry !== id));
    if (max && value.length >= max) return onChange([...value.slice(1), id]);
    return onChange([...value, id]);
  };
  if (!items?.length) return <p className="admin-note">{empty}</p>;
  return (
    <div className="admin-picker">
      {items.map((item) => {
        const on = value.includes(item.id);
        return (
          <button key={item.id} type="button" className={`admin-picker-tile${on ? ' is-on' : ''}${item.hidden ? ' is-hidden' : ''}`} aria-pressed={on} onClick={() => toggle(item.id)} title={item.name}>
            <span className="admin-picker-art"><ItemThumb item={item} strips={strips} width={30} height={48} /></span>
            <span className="admin-picker-name">{item.name}</span>
            {on && <i className="admin-picker-check"><Check size={11} strokeWidth={3} /></i>}
          </button>
        );
      })}
    </div>
  );
}

import { useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
export function ReorderHandle({ index, count, onMove }: { index: number; count: number; onMove: (from: number, to: number) => void }) {
  const target = useRef(index), [dragging, setDragging] = useState(false);
  return <button className={'icon-button reorder-handle' + (dragging ? ' dragging' : '')} aria-label={`调整第 ${index + 1} 首顺序`} title="拖动排序；也可用上下方向键" onClick={e => e.stopPropagation()}
    onKeyDown={e => { const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : index; if (to !== index && to >= 0 && to < count) { e.preventDefault(); onMove(index, to); } }}
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); target.current = index; e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }}
    onPointerMove={e => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const group = e.currentTarget.closest('[data-reorder-group]');
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-reorder-index]');
      if (row && row.closest('[data-reorder-group]') === group) target.current = Number(row.dataset.reorderIndex);
      const scroll = group?.closest('.queue-scroll, .page-content');
      if (scroll) { const rect = scroll.getBoundingClientRect(); if (e.clientY < rect.top + 45) scroll.scrollBy(0, -14); if (e.clientY > rect.bottom - 45) scroll.scrollBy(0, 14); }
    }}
    onPointerUp={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; e.currentTarget.releasePointerCapture(e.pointerId); setDragging(false); onMove(index, target.current); }}
    onPointerCancel={() => { target.current = index; setDragging(false); }}><GripVertical size={17} /></button>;
}

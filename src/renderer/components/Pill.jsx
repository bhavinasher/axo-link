import { useRef } from 'react';
import PillWaveform from './PillWaveform.jsx';

// How far a press has to travel before it is a drag rather than a click.
const DRAG_SLOP = 4;

const DOT = {
  running: 'bg-state-running',
  waiting: 'bg-state-waiting animate-pill-pulse',
  error: 'bg-state-error',
  idle: 'bg-state-idle',
};

export function Dot({ state }) {
  return <i className={`size-2 shrink-0 rounded-full transition-colors ${DOT[state] || DOT.idle}`} />;
}

/** The collapsed bar. Three moods: idle roster, listening, transcribing. */
export default function Pill({ sorted, waitingCount, notice, mic, onToggle, onAdd }) {
  const listening = mic.status === 'recording';
  const sending = mic.status === 'sending';
  // Past 8 the dots stop being readable, so collapse them into the count.
  const tooMany = sorted.length > 8;

  // The bar is both the toggle and the handle you move the pill by. It can't
  // be a -webkit-app-region: drag region -- the OS takes every press on one
  // for window dragging, so the click never reaches the page and the pill
  // could never be opened or closed. So: a press that barely moves is a
  // click; one that travels past DRAG_SLOP moves the window, via main.
  const press = useRef(null);
  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    press.current = { x: e.screenX, y: e.screenY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.screenX - p.x, e.screenY - p.y) > DRAG_SLOP) {
      p.moved = true;
      axo.dragStart();
    }
    if (p.moved) axo.dragMove();
  };
  const onPointerUp = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.moved) axo.dragEnd();
    else onToggle();
  };
  const onPointerCancel = () => {
    if (press.current?.moved) axo.dragEnd();
    press.current = null;
  };

  return (
    <div
      className="flex h-11 flex-none cursor-pointer items-center gap-2 px-3.5"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {listening ? (
        <>
          <div className="h-5 w-14 flex-none text-state-listening">
            <PillWaveform getLevel={mic.getLevel} active />
          </div>
          <span className="min-w-0 flex-1 truncate text-[11px] text-pill-dim">
            → {mic.targetLabel}
          </span>
        </>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {!tooMany && sorted.map((s) => <Dot key={s.id} state={s.state} />)}
          </div>

          <span className="truncate text-[11px] whitespace-nowrap text-pill-dim">
            {notice ? (
              <span className="text-state-error">{notice}</span>
            ) : sending ? (
              'transcribing…'
            ) : waitingCount ? (
              <b className="font-semibold text-state-waiting">{waitingCount} waiting</b>
            ) : tooMany ? (
              `${sorted.length} agents`
            ) : sorted.length ? (
              'all busy'
            ) : null}
          </span>
        </>
      )}

      <button
        className="no-drag size-5.5 flex-none cursor-pointer rounded-full border border-pill-border text-sm/none text-pill-dim transition-colors hover:border-pill-dim hover:text-pill-text"
        title="Start an agent in a folder"
        onClick={(e) => {
          e.stopPropagation();
          onAdd();
        }}
      >
        +
      </button>
    </div>
  );
}

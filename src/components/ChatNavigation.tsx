import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent, type KeyboardEvent } from 'react';
import type { ChatArtifact } from '../contracts';
import type { ChatTranscriptItem } from '../chat-transcript';
import { buildChatNavigationMarks, nextChatNavigationIndex, type ChatNavigationMark } from '../chat-navigation';

export default function ChatNavigation({
  items,
  artifacts,
  onNavigate,
}: {
  items: readonly ChatTranscriptItem[];
  artifacts: readonly ChatArtifact[];
  onNavigate: (messageId: string, followStream: boolean) => void;
}) {
  const marks = useMemo(() => buildChatNavigationMarks(items, artifacts), [items, artifacts]);
  const navigationRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLButtonElement | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [dismissedFocusMessageId, setDismissedFocusMessageId] = useState<string | null>(null);
  const activePreviewId = hoveredMessageId
    ?? (focusedMessageId !== dismissedFocusMessageId ? focusedMessageId : null);
  const previewMark = marks.find((mark) => mark.messageId === activePreviewId) ?? null;
  const previewMessageId = previewMark?.messageId;
  const hasMarks = marks.length > 0;

  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    const boundary = navigation?.closest<HTMLElement>('.view-area');
    const list = navigation?.querySelector('ol');
    if (!navigation || !boundary || !list) return undefined;
    const measure = () => {
      const bounds = boundary.getBoundingClientRect();
      navigation.style.setProperty('--chat-navigation-max-height', `${Math.max(0, boundary.clientHeight - 16)}px`);
      navigation.style.top = `${bounds.top + (bounds.height - list.getBoundingClientRect().height) / 2}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(boundary);
    observer.observe(list);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [hasMarks]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const button = previewMessageId ? buttonRefs.current.get(previewMessageId) : undefined;
    const boundary = button?.closest<HTMLElement>('.view-area');
    const list = button?.closest('ol');
    if (!preview || !button || !boundary || !list) return undefined;
    const reposition = () => {
      const anchor = button.getBoundingClientRect();
      const bounds = boundary.getBoundingClientRect();
      const rail = list.getBoundingClientRect();
      const center = anchor.top + anchor.height / 2;
      const left = anchor.right + 6;
      const width = Math.min(352, bounds.right - left - 8);
      preview.style.width = `${Math.max(0, width)}px`;
      const height = preview.getBoundingClientRect().height;
      const top = Math.max(bounds.top + 8, Math.min(center - height / 2, bounds.bottom - height - 8));
      preview.style.left = `${left}px`;
      preview.style.top = `${top}px`;
      preview.style.visibility = width > 0 && height + 16 <= bounds.height
        && center >= Math.max(rail.top, bounds.top) && center <= Math.min(rail.bottom, bounds.bottom) ? 'visible' : 'hidden';
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const observer = new ResizeObserver(reposition);
    observer.observe(boundary);
    observer.observe(list);
    observer.observe(preview);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      observer.disconnect();
    };
  }, [previewMessageId]);

  useEffect(() => {
    if (marks.length === 0) {
      setFocusedMessageId(null);
      return;
    }
    if (focusedMessageId && !marks.some((mark) => mark.messageId === focusedMessageId)) {
      setFocusedMessageId(null);
    }
  }, [marks.length, marks[marks.length - 1]?.messageId, focusedMessageId]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setHoveredMessageId(null);
      setDismissedFocusMessageId(focusedMessageId);
      return;
    }
    const nextIndex = nextChatNavigationIndex(index, event.key, marks.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const nextMark = marks[nextIndex];
    setDismissedFocusMessageId(null);
    const button = buttonRefs.current.get(nextMark.messageId);
    const list = button?.closest('ol');
    if (!button || !list) return;
    const mark = button.getBoundingClientRect();
    const rail = list.getBoundingClientRect();
    if (mark.top < rail.top) list.scrollTop += mark.top - rail.top;
    else if (mark.bottom > rail.bottom) list.scrollTop += mark.bottom - rail.bottom;
    button.focus({ preventScroll: true });
  }

  function handleBlur(event: FocusEvent<HTMLElement>): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setFocusedMessageId(null);
    setDismissedFocusMessageId(null);
  }

  function handlePointerLeave(event: PointerEvent<HTMLButtonElement>, messageId: string): void {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && previewRef.current?.contains(nextTarget)) return;
    setHoveredMessageId((current) => current === messageId ? null : current);
  }

  function navigate(mark: ChatNavigationMark): void {
    onNavigate(mark.messageId, mark.isLatest && (mark.status === 'Выполняется' || mark.status === 'В очереди'));
  }

  if (!hasMarks) return null;

  return (
    <nav className="chat-navigation" aria-label="Навигация по запросам" ref={navigationRef} onBlurCapture={handleBlur}>
      <ol className="chat-navigation-list">
        {marks.map((mark, index) => {
          const accessiblePreview = mark.preview.length > 240 ? `${mark.preview.slice(0, 237)}…` : mark.preview;
          const focused = focusedMessageId === mark.messageId;
          const hovered = hoveredMessageId === mark.messageId;
          const expanded = activePreviewId === mark.messageId;
          const previewId = `chat-navigation-preview-${mark.messageId}`;
          return (
            <li key={mark.messageId}>
              <button
                ref={(element) => {
                  if (element) buttonRefs.current.set(mark.messageId, element);
                  else buttonRefs.current.delete(mark.messageId);
                }}
                type="button"
                className={`chat-navigation-mark${mark.isLatest ? ' latest' : ''}${focused ? ' focused' : ''}${hovered ? ' hovered' : ''}${expanded ? ' expanded' : ''}`}
                data-navigation-message-id={mark.messageId}
                aria-label={`Перейти к запросу: ${accessiblePreview}. ${mark.status}${mark.time ? `. ${mark.time}` : ''}`}
                aria-current={mark.isLatest ? 'location' : undefined}
                aria-describedby={previewMark?.messageId === mark.messageId ? previewId : undefined}
                tabIndex={focusedMessageId === null ? (mark.isLatest ? 0 : -1) : (focused ? 0 : -1)}
                onFocus={() => {
                  setFocusedMessageId(mark.messageId);
                  setDismissedFocusMessageId(null);
                }}
                onPointerEnter={() => setHoveredMessageId(mark.messageId)}
                onPointerLeave={(event) => handlePointerLeave(event, mark.messageId)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onClick={() => navigate(mark)}
              >
                <span className="chat-navigation-mark-bar" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      {previewMark && <button
        className="chat-navigation-preview"
        type="button"
        tabIndex={-1}
        ref={previewRef}
        onMouseDown={(event) => event.preventDefault()}
        onPointerLeave={() => setHoveredMessageId(null)}
        onClick={() => {
          navigate(previewMark);
          setHoveredMessageId(null);
          setDismissedFocusMessageId(focusedMessageId);
        }}
      >
        <span className="chat-navigation-preview-request">{previewMark.preview}</span>
        <span className="chat-navigation-preview-answer" id={`chat-navigation-preview-${previewMark.messageId}`}>
          {previewMark.answer ?? previewMark.status}
        </span>
      </button>}
    </nav>
  );
}

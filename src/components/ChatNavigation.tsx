import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type KeyboardEvent } from 'react';
import type { ChatArtifact, ChatMessage, ChatTurnRecord } from '../contracts';
import { buildChatNavigationMarks, nextChatNavigationIndex } from '../chat-navigation';

export default function ChatNavigation({
  messages,
  turns,
  artifacts,
  onNavigate,
}: {
  messages: readonly ChatMessage[];
  turns: readonly ChatTurnRecord[];
  artifacts: readonly ChatArtifact[];
  onNavigate: (messageId: string, followStream: boolean) => void;
}) {
  const marks = useMemo(() => buildChatNavigationMarks(messages, turns, artifacts), [messages, turns, artifacts]);
  const navigationRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [dismissedFocusMessageId, setDismissedFocusMessageId] = useState<string | null>(null);
  const [previewStyle, setPreviewStyle] = useState<CSSProperties | null>(null);
  const activePreviewId = hoveredMessageId
    ?? (focusedMessageId !== dismissedFocusMessageId ? focusedMessageId : null);
  const previewMark = marks.find((mark) => mark.messageId === activePreviewId) ?? null;

  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    const boundary = navigation?.closest<HTMLElement>('.view-area');
    if (!navigation || !boundary) return undefined;
    const ownerLayout = navigation.closest<HTMLElement>('.chat-history-layout');
    const measure = (): void => {
      const boundaryRect = boundary.getBoundingClientRect();
      const navigationRect = navigation.getBoundingClientRect();
      const boundaryStyle = getComputedStyle(boundary);
      const navigationStyle = getComputedStyle(navigation);
      const paddingTop = Number.parseFloat(boundaryStyle.paddingTop) || 0;
      const stickyTop = navigationStyle.position === 'sticky' ? Number.parseFloat(navigationStyle.top) || 0 : 0;
      const stableTop = boundaryRect.top + paddingTop + stickyTop;
      const availableHeight = Math.max(0, boundaryRect.bottom - Math.max(navigationRect.top, stableTop) - 8);
      const nextHeight = `${availableHeight}px`;
      if (navigation.style.getPropertyValue('--chat-navigation-max-height') !== nextHeight) {
        navigation.style.setProperty('--chat-navigation-max-height', nextHeight);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(boundary);
    if (ownerLayout) observer.observe(ownerLayout);
    boundary.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      boundary.removeEventListener('scroll', measure);
    };
  }, [marks.length > 0]);

  function updatePreviewPosition(messageId: string): void {
    const button = buttonRefs.current.get(messageId);
    const boundary = button?.closest<HTMLElement>('.view-area');
    if (!button || !boundary) return;
    const buttonRect = button.getBoundingClientRect();
    const bounds = boundary.getBoundingClientRect();
    const width = Math.max(96, Math.min(280, bounds.width - 20));
    const previewHeight = Math.min(240, window.innerHeight - 24, bounds.height - 16);
    const rightCandidate = buttonRect.right + 9;
    const left = rightCandidate + width <= bounds.right - 8
      ? rightCandidate
      : Math.max(bounds.left + 8, buttonRect.left - width - 9);
    const top = Math.max(bounds.top + 8, Math.min(
      bounds.bottom - previewHeight - 8,
      buttonRect.top + buttonRect.height / 2 - previewHeight / 2,
    ));
    setPreviewStyle({ left, top, width, maxHeight: previewHeight });
  }

  useEffect(() => {
    if (!previewMark) {
      setPreviewStyle(null);
      return undefined;
    }
    const reposition = () => updatePreviewPosition(previewMark.messageId);
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const boundary = navigationRef.current?.closest<HTMLElement>('.view-area');
    const observer = new ResizeObserver(reposition);
    if (boundary) observer.observe(boundary);
    if (navigationRef.current) observer.observe(navigationRef.current);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      observer.disconnect();
    };
  }, [previewMark?.messageId]);

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
    buttonRefs.current.get(nextMark.messageId)?.focus();
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

  if (marks.length === 0) return null;
  const expandedMessageId = hoveredMessageId
    ?? (focusedMessageId !== dismissedFocusMessageId ? focusedMessageId : null);

  return (
    <nav className="chat-navigation" aria-label="Навигация по запросам" ref={navigationRef} onBlurCapture={handleBlur}>
      <ol className="chat-navigation-list">
        {marks.map((mark, index) => {
          const accessiblePreview = mark.preview.length > 240 ? `${mark.preview.slice(0, 237)}…` : mark.preview;
          const focused = focusedMessageId === mark.messageId;
          const hovered = hoveredMessageId === mark.messageId;
          const expanded = expandedMessageId === mark.messageId;
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
                  updatePreviewPosition(mark.messageId);
                }}
                onPointerEnter={() => {
                  setHoveredMessageId(mark.messageId);
                  updatePreviewPosition(mark.messageId);
                }}
                onPointerLeave={(event) => handlePointerLeave(event, mark.messageId)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onClick={() => onNavigate(mark.messageId, mark.isLatest && (mark.status === 'Выполняется' || mark.status === 'В очереди'))}
              >
                <span className="chat-navigation-mark-bar" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      {previewMark && previewStyle && <div
        className="chat-navigation-preview"
        id={`chat-navigation-preview-${previewMark.messageId}`}
        role="tooltip"
        style={previewStyle}
        ref={previewRef}
        onPointerLeave={() => setHoveredMessageId(null)}
      >
        <div className="chat-navigation-preview-meta">
          {previewMark.date && <span>{previewMark.date}</span>}
          {previewMark.time && <time>{previewMark.time}</time>}
        </div>
        <p>{previewMark.preview}</p>
        <small>{previewMark.status}</small>
      </div>}
    </nav>
  );
}

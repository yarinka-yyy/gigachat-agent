import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AudioLines,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cpu,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  Globe,
  Headphones,
  Image as ImageIcon,
  LockKeyhole,
  MessageSquare,
  Mic,
  Monitor,
  Moon,
  MoreHorizontal,
  Palette,
  PanelLeft,
  PanelRight,
  Pin,
  PlugZap,
  Plus,
  Puzzle,
  Settings2,
  Search,
  ShieldCheck,
  SquarePen,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  UserRound,
  Video,
  Volume2,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { completeComposerSuggestion, getComposerCompletion, isUnavailableCompactCommand, type ComposerSuggestion } from './commands';
import type {
  AppInfo,
  CloseAttemptResult,
  CloseFailure,
  ChatDetail,
  ChatSummary,
  ChatKind,
  ChatPatch,
  FolderOpener,
  HookEvent,
  HookRegistrySnapshot,
  InstructionSaveResult,
  LocalUsageStats,
  Project,
  ProjectPatch,
  RuntimeActivity,
  RuntimeTurnSnapshot,
  SkillRecord,
  SkillRegistrySnapshot,
  SkillScope,
  SkillSource,
  Settings,
  SettingsPatch,
  PermissionApprovalRequest,
  NotificationSettings,
  Theme,
  VoiceAvailability,
} from './contracts';
import type { PermissionProfile } from './permissions';
import { GIGACHAT_MODELS, type GigaChatModelId } from './models';
import gigaChatLogo from './assets/gigachat-logo.png';
import { createInstructionAutosave, type SaveStatus } from './instruction-autosave';
import { createChatForDraftSession, createNewChatDraftSession, createRendererOperationTracker, persistDraftSession, shouldOpenCreatedDraftChat, type NewChatDraftSession } from './renderer-operations';
import ConnectionSetup from './components/ConnectionSetup';
import VoiceCaptureControl, { getCaptureError } from './components/VoiceCaptureControl';
import ContextRing from './components/ContextRing';
import BrowserPanel from './components/BrowserPanel';
import { createPreviewExitTimer, maxSidebarWidth as computeMaxSidebarWidth } from './sidebar-behavior';
import { sidebarSections } from './sidebar-sections';

type Page = 'home' | 'chat' | 'settings' | 'onboarding' | 'images' | 'video' | 'podcasts' | 'archive' | 'profile';
type Route = { page: Page; id?: string };
type HomeDraftSession = NewChatDraftSession<PermissionProfile> & {
  creation: Promise<ChatSummary> | null;
  chatId: string | null;
  chat: ChatSummary | null;
  error: string;
};
type ChatLoadState = { chatId: string; status: 'loading' | 'ready' | 'error'; error?: string };
type Navigation = { history: Route[]; index: number };
type SettingsSection =
  | 'general'
  | 'appearance'
  | 'models'
  | 'permissions'
  | 'personalization'
  | 'integrations'
  | 'hooks'
  | 'browser'
  | 'voice'
  | 'notifications'
  | 'files'
  | 'terminal'
  | 'advanced'
  | 'archive';
type IconName =
  | 'panel' | 'panelRight' | 'back' | 'forward' | 'plus' | 'image' | 'video' | 'podcast' | 'folder'
  | 'chat' | 'settings' | 'archive' | 'send' | 'mic' | 'audio' | 'chevron' | 'sun'
  | 'moon' | 'system' | 'user' | 'sparkle' | 'x' | 'pin' | 'trash' | 'edit' | 'check'
  | 'external' | 'folderOpen' | 'shield' | 'gauge' | 'wrench' | 'puzzle' | 'globe'
  | 'volume' | 'bell' | 'terminal' | 'sliders' | 'palette' | 'book' | 'lock' | 'help' | 'plug'
  | 'cpu' | 'file';
type PageIcon = { id: SettingsSection; label: string; icon: IconName };

const ICONS: Record<IconName, LucideIcon> = {
  panel: PanelLeft,
  panelRight: PanelRight,
  back: ArrowLeft,
  forward: ArrowRight,
  plus: Plus,
  image: ImageIcon,
  video: Video,
  podcast: Headphones,
  folder: Folder,
  chat: MessageSquare,
  settings: Settings2,
  archive: Archive,
  send: ArrowUp,
  mic: Mic,
  audio: AudioLines,
  chevron: ChevronDown,
  sun: Sun,
  moon: Moon,
  system: Monitor,
  user: UserRound,
  sparkle: Sparkles,
  x: X,
  pin: Pin,
  trash: Trash2,
  edit: SquarePen,
  check: Check,
  external: ExternalLink,
  folderOpen: FolderOpen,
  shield: ShieldCheck,
  gauge: Gauge,
  wrench: Wrench,
  puzzle: Puzzle,
  globe: Globe,
  volume: Volume2,
  bell: Bell,
  terminal: Terminal,
  sliders: SlidersHorizontal,
  palette: Palette,
  book: BookOpen,
  lock: LockKeyhole,
  help: CircleHelp,
  plug: PlugZap,
  cpu: Cpu,
  file: FileText,
};

const SETTINGS_SECTIONS: PageIcon[] = [
  { id: 'general', label: 'Общие', icon: 'settings' },
  { id: 'appearance', label: 'Оформление', icon: 'palette' },
  { id: 'models', label: 'Модели и лимиты', icon: 'gauge' },
  { id: 'permissions', label: 'Разрешения', icon: 'shield' },
  { id: 'personalization', label: 'Персонализация', icon: 'book' },
  { id: 'integrations', label: 'Skills и интеграции', icon: 'puzzle' },
  { id: 'hooks', label: 'Hooks', icon: 'plug' },
  { id: 'browser', label: 'Подключение API', icon: 'globe' },
  { id: 'voice', label: 'Голос', icon: 'volume' },
  { id: 'notifications', label: 'Уведомления', icon: 'bell' },
  { id: 'files', label: 'Проекты и файлы', icon: 'folderOpen' },
  { id: 'terminal', label: 'Терминал и код', icon: 'terminal' },
  { id: 'advanced', label: 'Дополнительно', icon: 'sliders' },
  { id: 'archive', label: 'Архив', icon: 'archive' },
];

const DEFAULT_SETTINGS: Settings = {
  theme: 'emerald',
  sidebarTransparent: false,
  sidebarVisible: true,
  sidebarWidthPx: null,
  browserPaneOpen: false,
  browserWidthPx: null,
  browserTabs: [],
  browserActiveTabId: null,
  defaultProjectsFolder: null,
  preferredOpener: 'system',
  defaultPermissionProfile: 'ask',
  defaultModelId: null,
  onboardingCompleted: false,
  microphoneConsent: 'unasked',
  notifications: { taskStarted: false, taskCompleted: true, failures: true },
};

const AVAILABLE_PERMISSION_PROFILES = [
  {
    id: 'ask',
    name: 'Спросить',
    description: 'Действия в проекте разрешены; спорные действия требуют вашего подтверждения.',
  },
  {
    id: 'approve',
    name: 'Подтверждать за меня',
    description: 'Автопроверяющего пока нет: спорные действия подтверждаете вы.',
  },
  {
    id: 'full',
    name: 'Полный доступ',
    description: 'Разрешает доступные локальные действия. Сеть и доступ ко всей машине пока недоступны.',
  },
  {
    id: 'custom',
    name: 'Пользовательский',
    description: 'Правила allow, ask и deny из локального config.toml.',
  },
] as const;

const APPROVAL_ACTION_LABELS = {
  list: 'Список файлов', search: 'Поиск файлов', read: 'Чтение файла',
  write: 'Запись файла', open: 'Открытие файла', execute: 'Команда PowerShell', connect: 'Подключение',
} as const;

function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const Component = ICONS[name];
  return <Component className={className ? `icon ${className}` : 'icon'} aria-hidden="true" focusable="false" strokeWidth={1.8} />;
}

function ScrollingRowTitle({ value, pinned = false }: { value: string; pinned?: boolean }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    const measure = () => setOverflow(Math.max(0, Math.ceil(text.scrollWidth - viewport.clientWidth + (pinned ? 0 : 60))));
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    measure();
    return () => observer.disconnect();
  }, [value, pinned]);
  return <span ref={viewportRef} className="list-row-title-viewport" title={value}>
    <span ref={textRef} className="list-row-title" style={{ '--title-shift': `${overflow}px`, '--title-duration': `${Math.max(1.8, overflow / 40)}s` } as CSSProperties}>{value}</span>
  </span>;
}

function ActionMenu({ children, label, trigger, className = '', placement = 'side', initialFocus, onOpen, onVisibilityChange, disabled = false, popupRole, popupLabel, triggerHasPopup, onTriggerKeyDown }: {
  children: ReactNode; label: string; trigger?: ReactNode; className?: string;
  placement?: 'side' | 'below' | 'below-start'; initialFocus?: string; onOpen?: () => void;
  onVisibilityChange?: (id: string, open: boolean) => void; disabled?: boolean;
  popupRole?: 'listbox'; popupLabel?: string; triggerHasPopup?: 'listbox'; onTriggerKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const overlayId = useId();
  const overlayOpen = useRef(false);
  const visibilityCallback = useRef(onVisibilityChange);
  visibilityCallback.current = onVisibilityChange;

  useEffect(() => () => {
    if (!overlayOpen.current) return;
    overlayOpen.current = false;
    visibilityCallback.current?.(overlayId, false);
  }, [overlayId]);

  function positionPopup(): void {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    const anchor = trigger.getBoundingClientRect();
    const gap = 5;
    const edge = 8;
    const desiredLeft = placement === 'side'
      ? (anchor.right + gap + popup.offsetWidth + edge <= window.innerWidth ? anchor.right + gap : anchor.left - popup.offsetWidth - gap)
      : placement === 'below-start' ? anchor.left : anchor.right - popup.offsetWidth;
    const left = Math.max(edge, Math.min(desiredLeft, window.innerWidth - popup.offsetWidth - edge));
    const below = window.innerHeight - anchor.bottom;
    const above = anchor.top;
    const placeAbove = placement !== 'side' && below < popup.offsetHeight + gap + edge && above > below;
    const desiredTop = placement === 'side' ? anchor.top : placeAbove ? anchor.top - popup.offsetHeight - gap : anchor.bottom + gap;
    const top = Math.max(edge, Math.min(desiredTop, window.innerHeight - popup.offsetHeight - edge));
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  useEffect(() => {
    if (!open) return;
    const onResize = () => positionPopup();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return;
      popupRef.current?.hidePopover();
    };
    const observer = new ResizeObserver(positionPopup);
    if (popupRef.current) observer.observe(popupRef.current);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <div className={`action-menu ${className}`}>
      <button ref={triggerRef} type="button" aria-label={label} aria-haspopup={triggerHasPopup} aria-controls={popupRole ? overlayId : undefined} aria-expanded={open} title={label} disabled={disabled} onKeyDown={onTriggerKeyDown} onClick={() => {
        const popup = popupRef.current;
        if (!popup) return;
        if (popup.matches(':popover-open')) popup.hidePopover();
        else {
          document.querySelectorAll<HTMLDivElement>('.action-menu-content:popover-open').forEach((other) => other.hidePopover());
          onOpen?.();
          popup.showPopover();
          positionPopup();
          if (initialFocus) requestAnimationFrame(() => popup.querySelector<HTMLElement>(initialFocus)?.focus());
        }
      }}>{trigger ?? <MoreHorizontal className="icon" aria-hidden="true" />}</button>
      <div ref={popupRef} id={popupRole ? overlayId : undefined} role={popupRole} aria-label={popupLabel} popover="auto" className="action-menu-content" onToggle={() => {
        const isOpen = popupRef.current?.matches(':popover-open') ?? false;
        if (!isOpen) popupRef.current?.querySelectorAll<HTMLDivElement>('.submenu-content:popover-open').forEach((submenu) => submenu.hidePopover());
        if (!isOpen && popupRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
        if (overlayOpen.current !== isOpen) {
          overlayOpen.current = isOpen;
          visibilityCallback.current?.(overlayId, isOpen);
        }
        setOpen(isOpen);
      }} onClick={(event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (button && !button.classList.contains('submenu-trigger')) popupRef.current?.hidePopover();
      }}>{children}</div>
    </div>
  );
}

type ChoiceOption = { value: string; label: string; disabled?: boolean };

function ChoiceMenu({ label, value, options, onChange, onVisibilityChange }: {
  label: string; value: string; options: ChoiceOption[]; onChange: (value: string) => void;
  onVisibilityChange?: (id: string, open: boolean) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusedIndex = useRef(0);
  const pendingOpenIndex = useRef<number | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex] ?? { value: '', label: '' };

  function enabledFrom(start: number, direction = 1): number {
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + direction * offset + options.length * 2) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return -1;
  }

  function focusOption(index: number): void {
    if (index < 0) return;
    focusedIndex.current = index;
    const option = listRef.current?.querySelector<HTMLButtonElement>(`[data-choice-index="${index}"]`);
    option?.focus();
    option?.scrollIntoView({ block: 'nearest' });
  }

  function handleOpen(): void {
    focusedIndex.current = enabledFrom(pendingOpenIndex.current ?? selectedIndex);
    pendingOpenIndex.current = null;
  }

  function handleVisibilityChange(id: string, open: boolean): void {
    onVisibilityChange?.(id, open);
    if (open) requestAnimationFrame(() => {
      if (listRef.current?.closest('[popover]')?.matches(':popover-open')) focusOption(focusedIndex.current);
    });
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    const popup = event.currentTarget.closest('.action-menu')?.querySelector<HTMLDivElement>('.action-menu-content');
    const open = popup?.matches(':popover-open') ?? false;
    const current = open && focusedIndex.current >= 0 ? focusedIndex.current : selectedIndex;
    let next = -1;
    if (event.key === 'ArrowDown') next = enabledFrom(open ? current + 1 : current);
    else if (event.key === 'ArrowUp') next = enabledFrom(open ? current - 1 : current, -1);
    else if (event.key === 'Home') next = enabledFrom(0);
    else if (event.key === 'End') next = enabledFrom(options.length - 1, -1);
    else return;

    event.preventDefault();
    if (open) focusOption(next);
    else {
      pendingOpenIndex.current = next;
      event.currentTarget.click();
    }
  }

  function handleListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-choice-index]') : null;
    const current = target ? Number(target.dataset.choiceIndex) : focusedIndex.current;
    let next = -1;
    if (event.key === 'ArrowDown') next = enabledFrom(current + 1);
    else if (event.key === 'ArrowUp') next = enabledFrom(current - 1, -1);
    else if (event.key === 'Home') next = enabledFrom(0);
    else if (event.key === 'End') next = enabledFrom(options.length - 1, -1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      listRef.current?.closest<HTMLDivElement>('[popover]')?.hidePopover();
      return;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (target && !target.disabled) target.click();
      return;
    } else return;

    event.preventDefault();
    focusOption(next);
  }

  return <ActionMenu
    className="choice-menu"
    label={`${label}: ${selectedOption.label}`}
    placement="below-start"
    triggerHasPopup="listbox"
    popupRole="listbox"
    popupLabel={label}
    onOpen={handleOpen}
    onVisibilityChange={handleVisibilityChange}
    onTriggerKeyDown={handleTriggerKeyDown}
    trigger={<><span className="choice-menu-value">{selectedOption.label}</span><Icon name="chevron" className="choice-menu-chevron" /></>}
  >
    <div ref={listRef} className="choice-menu-content" role="presentation" onKeyDown={handleListKeyDown}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return <button
          key={`${option.value}:${index}`}
          type="button"
          role="option"
          data-choice-index={index}
          aria-selected={selected}
          disabled={option.disabled}
          onFocus={() => { focusedIndex.current = index; }}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
          {selected && <Icon name="check" />}
        </button>;
      })}
    </div>
  </ActionMenu>;
}

function ProjectSubmenu({ chat, projects, onSelect, onVisibilityChange }: {
  chat: ChatSummary; projects: Project[]; onSelect: (projectId: string) => void;
  onVisibilityChange?: (id: string, open: boolean) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const overlayOpen = useRef(false);
  const visibilityCallback = useRef(onVisibilityChange);
  visibilityCallback.current = onVisibilityChange;

  useEffect(() => () => {
    if (!overlayOpen.current) return;
    overlayOpen.current = false;
    visibilityCallback.current?.(`${popupId}-submenu`, false);
  }, [popupId]);

  function cancelOpen(): void {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
  }

  function cancelClose(): void {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function positionPopup(): void {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    const anchor = trigger.getBoundingClientRect();
    const gap = 6;
    const edge = 8;
    const rightSpace = window.innerWidth - anchor.right - gap - edge;
    const leftSpace = anchor.left - gap - edge;
    const desiredLeft = rightSpace < popup.offsetWidth && leftSpace > rightSpace
      ? anchor.left - popup.offsetWidth - gap : anchor.right + gap;
    popup.style.left = `${Math.max(edge, Math.min(desiredLeft, window.innerWidth - popup.offsetWidth - edge))}px`;
    popup.style.top = `${Math.max(edge, Math.min(anchor.top, window.innerHeight - popup.offsetHeight - edge))}px`;
  }

  function showPopup(focusFirst = false): void {
    cancelOpen();
    cancelClose();
    const popup = popupRef.current;
    if (!popup) return;
    if (!popup.matches(':popover-open')) popup.showPopover();
    positionPopup();
    if (focusFirst) popup.querySelector('button')?.focus();
  }

  function hidePopup(): void {
    cancelOpen();
    cancelClose();
    if (popupRef.current?.matches(':popover-open')) popupRef.current.hidePopover();
  }

  function scheduleClose(): void {
    cancelOpen();
    cancelClose();
    closeTimer.current = window.setTimeout(hidePopup, 180);
  }

  useEffect(() => {
    const parent = triggerRef.current?.closest('.action-menu-content');
    const onParentToggle = () => { if (!parent?.matches(':popover-open')) hidePopup(); };
    parent?.addEventListener('toggle', onParentToggle);
    return () => {
      cancelOpen();
      cancelClose();
      parent?.removeEventListener('toggle', onParentToggle);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', positionPopup);
    return () => window.removeEventListener('resize', positionPopup);
  }, [open]);

  return (
    <div className="submenu" onPointerEnter={cancelClose} onPointerLeave={scheduleClose}>
      <button ref={triggerRef} type="button" className="submenu-trigger" aria-expanded={open} aria-controls={popupId}
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch' || open) return;
          cancelOpen();
          openTimer.current = window.setTimeout(() => showPopup(), 500);
        }}
        onClick={(event) => showPopup(event.detail === 0)}
        onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); showPopup(true); } }}>
        <Icon name="folder" />Переместить в проект<ChevronRight className="icon submenu-chevron" aria-hidden="true" />
      </button>
      <div ref={popupRef} id={popupId} popover="auto" className="submenu-content" onToggle={() => {
        const isOpen = popupRef.current?.matches(':popover-open') ?? false;
        if (overlayOpen.current !== isOpen) {
          overlayOpen.current = isOpen;
          visibilityCallback.current?.(`${popupId}-submenu`, isOpen);
        }
        setOpen(isOpen);
      }}
        onPointerEnter={cancelClose} onPointerLeave={scheduleClose}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'ArrowLeft') {
            event.preventDefault();
            hidePopup();
            triggerRef.current?.focus();
          }
        }}>
        {chat.projectId && <button type="button" onClick={() => onSelect('')}>Без проекта</button>}
        {projects.length === 0
          ? <span className="submenu-empty">Нету проектов</span>
          : projects.map((project) => <button key={project.id} type="button" onClick={() => onSelect(project.id)}>{project.name}</button>)}
      </div>
    </div>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-copy"><strong>{title}</strong>{description && <p>{description}</p>}</div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

function EmptyState({ title, description, icon = 'help' }: { title: string; description: string; icon?: IconName }) {
  return (
    <div className="empty-panel">
      <span className="empty-panel-icon"><Icon name={icon} /></span>
      <div><strong>{title}</strong><p>{description}</p></div>
    </div>
  );
}

function ThemePreview({ theme, transparent }: { theme: 'emerald' | 'dark' | 'light' | 'warm'; transparent: boolean }) {
  return (
    <div className={`theme-preview preview-${theme}${transparent ? ' preview-transparent' : ''}`} aria-hidden="true">
      <div className="preview-titlebar"><i /><i /><i /></div>
      <div className="preview-sidebar"><i /><i /><i /><i /></div>
      <div className="preview-main">
        <i className="preview-heading" /><i className="preview-copy" />
        <div className="preview-card-row"><i /><i /></div>
        <i className="preview-composer" />
      </div>
    </div>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : 'Не удалось выполнить действие.';
}

function runtimeStatusLabel(status: RuntimeTurnSnapshot['status']): string {
  if (status === 'queued') return 'В очереди';
  if (status === 'running') return 'Выполняется';
  if (status === 'completed') return 'Завершено';
  if (status === 'cancelled') return 'Отменено';
  return 'Ошибка';
}

function runtimeActivityLabel(activity: RuntimeActivity): string {
  if (activity.kind === 'tool') {
    type ToolActivity = Extract<RuntimeActivity, { kind: 'tool' }>;
    const names: Record<ToolActivity['tool'], string> = {
      list: 'Список файлов', search: 'Поиск', read: 'Чтение файла', write: 'Запись файла', open: 'Открытие', powershell: 'PowerShell',
    };
    const phases: Record<ToolActivity['phase'], string> = {
      started: 'запущен', completed: 'завершён', failed: 'ошибка', cancelled: 'отменён',
    };
    return `${names[activity.tool]}: ${phases[activity.phase]}`;
  }
  if (activity.activity === 'connecting') return 'Подключение к GigaChat';
  if (activity.activity === 'receiving') return 'Получение ответа';
  if (activity.activity === 'waiting-for-tool') return 'Ожидание инструмента';
  return activity.activity === 'tool-started' ? 'Запуск инструмента' : 'Инструмент завершён';
}

function elapsedLabel(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  return `${Math.round(durationMs / 1000)} с`;
}

function hookEventLabel(event: HookEvent): string {
  const labels: Record<HookEvent, string> = {
    'session-start': 'Начало сессии', 'project-start': 'Открытие проекта',
    'user-prompt-submitted': 'Отправка запроса', 'before-tool': 'Перед инструментом',
    'after-tool': 'После инструмента', 'permission-request': 'Запрос разрешения',
    'before-compaction': 'Перед сжатием контекста', 'after-compaction': 'После сжатия контекста',
    interrupt: 'Прерывание', stop: 'Остановка', 'session-end': 'Завершение сессии', 'project-end': 'Завершение проекта',
  };
  return labels[event];
}

function sameRoute(left: Route | undefined, right: Route): boolean {
  return left?.page === right.page && left.id === right.id;
}

function themeLabel(theme: Theme): string {
  return theme === 'system' ? 'Как в Windows'
    : theme === 'emerald' ? 'Изумрудная'
      : theme === 'dark' ? 'Тёмная'
        : theme === 'light' ? 'Светлая' : 'Тёплая';
}

function saveStatusLabel(status: SaveStatus): string {
  return status === 'saved' ? 'Сохранено автоматически'
    : status === 'saving' ? 'Сохранение…'
      : status === 'error' ? 'Не сохранено — исправьте ошибку и продолжите ввод'
        : status === 'conflict' ? 'Обнаружено изменение файла — выберите версию'
          : 'Есть несохранённые изменения';
}

function isInstructionConflict(value: unknown): value is Extract<InstructionSaveResult, { kind: 'conflict' }> {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'conflict'
    && 'current' in value;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const [runtimeMode, setRuntimeMode] = useState<'api' | 'web'>('api');
  const [navigation, setNavigation] = useState<Navigation>({ history: [{ page: 'home' }], index: 0 });
  const [sidebarPreview, setSidebarPreview] = useState(false);
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => window.innerWidth <= 802);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showAllChats, setShowAllChats] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [nativeOverlayOpen, setNativeOverlayOpen] = useState(false);
  const nativeOverlayIds = useRef(new Set<string>());
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [composerCaret, setComposerCaret] = useState(0);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null);
  const [chatLoadState, setChatLoadState] = useState<ChatLoadState>({ chatId: '', status: 'ready' });
  const [chatLoadRetry, setChatLoadRetry] = useState(0);
  const [chatDraftSaveError, setChatDraftSaveError] = useState<{ chatId: string; message: string } | null>(null);
  const [homeDraftError, setHomeDraftError] = useState('');
  const [detachedDraftSessions, setDetachedDraftSessions] = useState<HomeDraftSession[]>([]);
  const [runtimeTurns, setRuntimeTurns] = useState<RuntimeTurnSnapshot[]>([]);
  const [pendingPermissionProfile, setPendingPermissionProfile] = useState<PermissionProfile | null>(null);
  const [sending, setSending] = useState(false);
  const [dialogRequest, setDialogRequest] = useState<{ kind: 'create-project' | 'project-settings' | 'rename-project' | 'delete-project' | 'rename-chat' | 'delete-chat'; project?: Project; chat?: ChatSummary; hasFiles?: boolean; assignChatId?: string; createdProjectId?: string } | null>(null);
  const [dialogValue, setDialogValue] = useState('');
  const [dialogFolder, setDialogFolder] = useState<string | null>(null);
  const [projectInstructionsBackup, setProjectInstructionsBackup] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [notice, setNoticeText] = useState('');
  const [noticeKind, setNoticeKind] = useState<'success' | 'error'>('error');
  const [noticeSequence, setNoticeSequence] = useState(0);
  const [loading, setLoading] = useState(true);
  const [autoStart, setAutoStart] = useState(false);
  const [openers, setOpeners] = useState<FolderOpener[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [localUsageStats, setLocalUsageStats] = useState<LocalUsageStats | null>(null);
  const [voiceAvailability, setVoiceAvailability] = useState<VoiceAvailability>({ available: false, reason: 'Проверяем локальный runtime диктовки…' });
  const [homeVoiceGeneration, setHomeVoiceGeneration] = useState(0);
  const [skillRegistry, setSkillRegistry] = useState<SkillRegistrySnapshot>({ skills: [], issues: [] });
  const [hookRegistry, setHookRegistry] = useState<HookRegistrySnapshot>({ hooks: [], issues: [] });
  const [skillProjectId, setSkillProjectId] = useState('');
  const [pendingSkillId, setPendingSkillId] = useState<string | null>(null);
  const [skillSource, setSkillSource] = useState<SkillSource | null>(null);
  const [skillSourceLoading, setSkillSourceLoading] = useState<string | null>(null);
  const [skillBusyId, setSkillBusyId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState('');
  const [configSaved, setConfigSaved] = useState('');
  const [configError, setConfigError] = useState('');
  const [configBusy, setConfigBusy] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const configEditRevision = useRef(0);
  const closeUiState = useRef({ configDraft, configSaved, configBusy, chatDraftSaveError });
  closeUiState.current = { configDraft, configSaved, configBusy: configBusy || configLoading, chatDraftSaveError };
  const [approvalRequest, setApprovalRequest] = useState<PermissionApprovalRequest | null>(null);
  const [closeFailure, setCloseFailure] = useState<CloseFailure | null>(null);
  const [closePending, setClosePending] = useState(false);
  const [closeRetrying, setCloseRetrying] = useState(false);
  const [globalInstructions, setGlobalInstructions] = useState('');
  const [globalInstructionsStatus, setGlobalInstructionsStatus] = useState<SaveStatus>('saved');
  const [globalInstructionsLoading, setGlobalInstructionsLoading] = useState(false);
  const [globalInstructionsReady, setGlobalInstructionsReady] = useState(false);
  const [globalInstructionsLoadError, setGlobalInstructionsLoadError] = useState('');
  const [globalInstructionRetry, setGlobalInstructionRetry] = useState(0);
  const [globalInstructionsConflict, setGlobalInstructionsConflict] = useState<Extract<InstructionSaveResult, { kind: 'conflict' }> | null>(null);
  const [globalPreservedInstruction, setGlobalPreservedInstruction] = useState<Extract<InstructionSaveResult, { kind: 'conflict' }>['preservedVersion']>(undefined);
  const [integrationTab, setIntegrationTab] = useState<'skills' | 'plugins' | 'tools'>('skills');
  const [projectInstructions, setProjectInstructions] = useState('');
  const [projectInstructionsStatus, setProjectInstructionsStatus] = useState<SaveStatus>('saved');
  const [projectInstructionsLoading, setProjectInstructionsLoading] = useState(false);
  const [projectInstructionsReady, setProjectInstructionsReady] = useState(false);
  const [projectInstructionsLoadError, setProjectInstructionsLoadError] = useState('');
  const [projectInstructionsConflict, setProjectInstructionsConflict] = useState<Extract<InstructionSaveResult, { kind: 'conflict' }> | null>(null);
  const [projectPreservedInstruction, setProjectPreservedInstruction] = useState<Extract<InstructionSaveResult, { kind: 'conflict' }>['preservedVersion']>(undefined);
  const globalInstructionLoadGeneration = useRef(0);
  const projectInstructionLoadGeneration = useRef(0);
  const chatDetailLoadGeneration = useRef(0);
  const routeGeneration = useRef(0);
  const draftRevision = useRef(0);
  const dialogGeneration = useRef(0);
  const projectFolderChangeRevision = useRef(new Map<string, number>());
  const activeProjectInstructionId = useRef<string | null>(null);
  const pendingChat = useRef<Promise<ChatSummary> | null>(null);
  const homeDraftSession = useRef<HomeDraftSession | null>(null);
  const detachedDraftSessionSet = useRef(new Set<HomeDraftSession>());
  const homeChatId = useRef<string | null>(null);
  const retainedChatDrafts = useRef(new Map<string, { text: string; message: string }>());
  const chatDraftMutationRevision = useRef(new Map<string, number>());
  const pendingPermissionProfileRef = useRef<PermissionProfile | null>(null);
  const pendingPermissionChatIdRef = useRef<string | null>(null);
  const permissionProfileRevision = useRef(0);
  const permissionProfileSave = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSkillIdRef = useRef<string | null>(null);
  const pendingSkillChatIdRef = useRef<string | null>(null);
  const skillSelectionRevision = useRef(0);
  const skillSelectionSave = useRef<Promise<unknown>>(Promise.resolve());
  const draftRef = useRef('');
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const mainPanelRef = useRef<HTMLElement>(null);
  const draftSave = useRef<Promise<unknown>>(Promise.resolve());
  const dialogRef = useRef<HTMLDialogElement>(null);
  const approvalDialogRef = useRef<HTMLDialogElement>(null);
  const closeDialogRef = useRef<HTMLDialogElement>(null);
  const closePendingDialogRef = useRef<HTMLDialogElement>(null);
  const closeActionInFlight = useRef(false);
  const rendererOperations = useRef(createRendererOperationTracker());
  const connectionKeySaveFailed = useRef(false);
  const routeRef = useRef<Route>({ page: 'home' });
  const settingsRevision = useRef(0);
  const sidebarButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const previewCloseTimer = useRef(createPreviewExitTimer(window.setTimeout.bind(window), window.clearTimeout.bind(window)));
  const firstRunMicrophonePrompt = useRef(false);

  function trackRendererOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    return rendererOperations.current.track(operation);
  }

  function resizeComposer(): void {
    const input = composerInputRef.current;
    const panel = mainPanelRef.current;
    const stack = input?.closest<HTMLElement>('.composer-stack');
    if (!input || !panel || !stack) return;
    const previous = input.style.height || `${input.getBoundingClientRect().height}px`;
    input.style.transition = 'none';
    input.style.height = 'auto';
    const naturalHeight = input.scrollHeight;
    const minimum = parseFloat(getComputedStyle(input).minHeight);
    const maximum = Math.max(minimum, Math.min(panel.clientHeight * .55, panel.clientHeight - 180) - (stack.offsetHeight - input.offsetHeight));
    const next = Math.max(minimum, Math.min(naturalHeight, maximum));
    input.style.height = previous;
    void input.offsetHeight;
    input.style.transition = '';
    input.style.height = `${next}px`;
    input.style.overflowY = naturalHeight > maximum ? 'auto' : 'hidden';
  }

  function clearPreviewClose(): void {
    previewCloseTimer.current.clear();
  }

  function closePreview(): void {
    clearPreviewClose();
    setSidebarPreview(false);
  }

  function trackNativeOverlay(id: string, open: boolean): void {
    const openOverlays = nativeOverlayIds.current;
    if (open) openOverlays.add(id);
    else openOverlays.delete(id);
    setNativeOverlayOpen(openOverlays.size > 0);
  }

  function schedulePreviewClose(): void {
    previewCloseTimer.current.schedule(() => {
      if (!sidebarRef.current?.contains(document.activeElement)) setSidebarPreview(false);
    });
  }

  function maxSidebarWidth(): number {
    const width = workspaceRef.current?.clientWidth ?? window.innerWidth;
    const composerWidth = mainPanelRef.current?.querySelector<HTMLElement>('.composer')?.getBoundingClientRect().width ?? 0;
    return computeMaxSidebarWidth(width, composerWidth);
  }

  function startSidebarDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || compactLayout || !settings.sidebarVisible) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarRef.current?.getBoundingClientRect().width ?? 264;
    const maximum = maxSidebarWidth();
    const divider = event.currentTarget;
    divider.setPointerCapture(event.pointerId);
    setSidebarDragging(true);
    const move = (moveEvent: PointerEvent) => setSidebarDragWidth(Math.max(0, Math.min(maximum, startWidth + moveEvent.clientX - startX)));
    const stop = (stopEvent: PointerEvent) => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', stop);
      divider.removeEventListener('pointercancel', stop);
      if (divider.hasPointerCapture(stopEvent.pointerId)) divider.releasePointerCapture(stopEvent.pointerId);
      const width = Math.max(0, Math.min(maximum, startWidth + stopEvent.clientX - startX));
      setSidebarDragWidth(null);
      setSidebarDragging(false);
      if (stopEvent.type === 'pointercancel') return;
      if (width <= 180) void updateLocalSettings({ sidebarVisible: false });
      else void updateLocalSettings({ sidebarWidthPx: Math.max(242, Math.round(width)) });
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
  }

  function setNotice(value: string): void {
    setNoticeText(value);
    setNoticeKind('error');
    setNoticeSequence((sequence) => sequence + 1);
  }
  function showSuccess(value: string): void {
    setNoticeText(value);
    setNoticeKind('success');
    setNoticeSequence((sequence) => sequence + 1);
  }
  const [globalSaver] = useState(() => createInstructionAutosave(
    (_key, value, expectedRevision) => window.gigaChat.settings.saveInstructions(value, expectedRevision),
    (_key, status, error) => {
      setGlobalInstructionsStatus(status);
      if (isInstructionConflict(error)) {
        setGlobalInstructionsConflict(error);
        if (error.preservedVersion) setGlobalPreservedInstruction(error.preservedVersion);
      } else if (status === 'saved') setGlobalInstructionsConflict(null);
      if (error && !isInstructionConflict(error)) setNotice(getErrorMessage(error));
    },
  ));
  const [projectSaver] = useState(() => createInstructionAutosave(
    (id, value, expectedRevision) => window.gigaChat.projects.saveInstructions(id, value, expectedRevision),
    (id, status, error) => {
      if (activeProjectInstructionId.current !== id) return;
      setProjectInstructionsStatus(status);
      if (isInstructionConflict(error)) {
        setProjectInstructionsConflict(error);
        if (error.preservedVersion) setProjectPreservedInstruction(error.preservedVersion);
      } else if (status === 'saved') setProjectInstructionsConflict(null);
      if (error && !isInstructionConflict(error)) setNotice(getErrorMessage(error));
    },
  ));
  const route = navigation.history[navigation.index] ?? { page: 'home' as const };
  useLayoutEffect(resizeComposer, [draft, route.page, route.id, compactLayout]);
  useEffect(() => {
    const panel = mainPanelRef.current;
    if (!panel || (route.page !== 'home' && route.page !== 'chat')) return;
    const observer = new ResizeObserver(resizeComposer);
    observer.observe(panel);
    const chatColumn = panel.querySelector<HTMLElement>('.chat-column');
    if (chatColumn) observer.observe(chatColumn);
    window.addEventListener('resize', resizeComposer);
    return () => { observer.disconnect(); window.removeEventListener('resize', resizeComposer); };
  }, [route.page]);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => window.gigaChat.permissions.onRequest(setApprovalRequest), []);

  useEffect(() => {
    const dialog = approvalDialogRef.current;
    if (!dialog) return;
    if (rendererOperations.current.frozen) return;
    if (approvalRequest && !dialog.open) dialog.showModal();
    else if (!approvalRequest && dialog.open) dialog.close();
  }, [approvalRequest, closeFailure, closePending]);

  useEffect(() => {
    if (!approvalRequest) return;
    const remaining = Math.max(0, Date.parse(approvalRequest.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setApprovalRequest((current) => current?.id === approvalRequest.id ? null : current), remaining);
    return () => window.clearTimeout(timer);
  }, [approvalRequest]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.gigaChat.projects.list(),
      window.gigaChat.chats.list(),
      window.gigaChat.settings.get(),
    ]).then(([loadedProjects, loadedChats, loadedSettings]) => {
      if (cancelled) return;
      setProjects(loadedProjects);
      setChats(loadedChats);
      setSettings(loadedSettings);
      if (!loadedSettings.onboardingCompleted) {
        const onboardingRoute: Route = { page: 'onboarding' };
        routeGeneration.current += 1;
        routeRef.current = onboardingRoute;
        setNavigation({ history: [onboardingRoute], index: 0 });
      }
      setLoading(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setNotice(getErrorMessage(error));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.gigaChat.voice.getStatus().then((availability) => {
      if (!cancelled) setVoiceAvailability(availability);
    }).catch(() => {
      if (!cancelled) setVoiceAvailability({ available: false, reason: 'Не удалось проверить локальный runtime диктовки.' });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (loading || closePending || closeFailure || settings.onboardingCompleted || settings.microphoneConsent !== 'unasked' || firstRunMicrophonePrompt.current) return;
    firstRunMicrophonePrompt.current = true;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const granted = await window.gigaChat.voice.requestAccess();
        if (cancelled || rendererOperations.current.frozen) return;
        if (!granted) {
          setSettings((current) => ({ ...current, microphoneConsent: 'declined' }));
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Запись микрофона недоступна в этой версии приложения.');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled || rendererOperations.current.frozen) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.getTracks().forEach((track) => track.stop());
        setSettings((current) => ({ ...current, microphoneConsent: 'allowed' }));
      })().catch((error: unknown) => { if (!cancelled) setNotice(getCaptureError(error)); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [loading, settings.onboardingCompleted, settings.microphoneConsent, closePending, Boolean(closeFailure)]);

  useEffect(() => {
    let cancelled = false;
    void window.gigaChat.skills.list().then((snapshot) => {
      if (!cancelled) setSkillRegistry(snapshot);
    }).catch((error: unknown) => {
      if (!cancelled) setNotice(getErrorMessage(error));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (route.page !== 'settings' || settingsSection !== 'integrations') return undefined;
    let cancelled = false;
    void window.gigaChat.skills.list().then((snapshot) => {
      if (!cancelled) setSkillRegistry(snapshot);
    }).catch((error: unknown) => { if (!cancelled) setNotice(getErrorMessage(error)); });
    return () => { cancelled = true; };
  }, [route.page, settingsSection]);

  useEffect(() => {
    if (route.page !== 'settings' || settingsSection !== 'hooks') return undefined;
    let cancelled = false;
    void window.gigaChat.hooks.list().then((snapshot) => {
      if (!cancelled) setHookRegistry(snapshot);
    }).catch((error: unknown) => { if (!cancelled) setNotice(getErrorMessage(error)); });
    return () => { cancelled = true; };
  }, [route.page, settingsSection]);

  useEffect(() => {
    if (route.page !== 'profile') return undefined;
    let cancelled = false;
    setLocalUsageStats(null);
    void window.gigaChat.usage.getLocalStats().then((stats) => {
      if (!cancelled) setLocalUsageStats(stats);
    }).catch((error: unknown) => {
      if (!cancelled) setNotice(getErrorMessage(error));
    });
    return () => { cancelled = true; };
  }, [route.page, chats.length, projects.length]);

  useEffect(() => window.gigaChat.onCloseRequested(async () => {
    setCloseFailure(null);
    setClosePending(true);
    let operationFailure: unknown;
    let operationFailed = false;
    try { await rendererOperations.current.freezeAndDrain(); }
    catch (error) { operationFailure = error; operationFailed = true; }
    const results = await Promise.allSettled([
      globalSaver.flushAll(), projectSaver.flushAll(), draftSave.current,
      permissionProfileSave.current, skillSelectionSave.current,
    ]);
    if (operationFailed) throw operationFailure;
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (connectionKeySaveFailed.current) {
      throw new Error('Не удалось сохранить значение локально. Вернитесь к подключению API и повторите сохранение либо очистите поле перед закрытием.');
    }
    const draftSessionFailed = homeDraftSession.current?.error
      || [...detachedDraftSessionSet.current].some((session) => session.error);
    if (closeUiState.current.chatDraftSaveError || retainedChatDrafts.current.size > 0 || draftSessionFailed) {
      throw new Error('Есть несохранённый текст. Вернитесь к работе, чтобы повторить сохранение; окно останется открытым.');
    }
    if (closeUiState.current.configBusy || closeUiState.current.configDraft !== closeUiState.current.configSaved) {
      throw new Error('Изменения config.toml ещё не сохранены. Вернитесь к настройкам, сохраните файл и повторите закрытие.');
    }
  }, (failure) => {
    setClosePending(false);
    setCloseFailure(failure);
  }), [globalSaver, projectSaver]);

  function runCloseAction(action: () => Promise<CloseAttemptResult>): void {
    if (closeActionInFlight.current) return;
    closeActionInFlight.current = true;
    setCloseRetrying(true);
    void action().then((result) => {
      setCloseFailure(result.status === 'failed' ? result : null);
    }).catch((error: unknown) => {
      setCloseFailure({ status: 'failed', reason: 'close', message: getErrorMessage(error) });
    }).finally(() => {
      closeActionInFlight.current = false;
      setCloseRetrying(false);
    });
  }

  function returnFromCloseFailure(): void {
    if (closeActionInFlight.current) return;
    closeActionInFlight.current = true;
    setCloseRetrying(true);
    void window.gigaChat.returnFromClose().then(() => {
      rendererOperations.current.resume();
      setClosePending(false);
      setCloseFailure(null);
    }).catch((error: unknown) => {
      setCloseFailure({ status: 'failed', reason: 'close', message: getErrorMessage(error) });
    }).finally(() => {
      closeActionInFlight.current = false;
      setCloseRetrying(false);
    });
  }

  useEffect(() => () => {
    void Promise.all([globalSaver.flushAll(), projectSaver.flushAll()])
      .catch((error: unknown) => setNotice(getErrorMessage(error)));
  }, [route.page, route.id, settingsSection, globalSaver, projectSaver]);

  useEffect(() => {
    if (!dialogRequest) void projectSaver.flushAll().catch((error: unknown) => setNotice(getErrorMessage(error)));
  }, [dialogRequest, projectSaver]);

  useEffect(() => {
    if (!notice || noticeKind === 'error') return;
    const timer = window.setTimeout(() => setNoticeText(''), 2000);
    return () => window.clearTimeout(timer);
  }, [notice, noticeKind, noticeSequence]);

  useEffect(() => {
    if (dialogRequest) {
      if (rendererOperations.current.frozen) return;
      dialogRef.current?.showModal();
      (dialogRef.current?.querySelector('input') ?? dialogRef.current?.querySelector('textarea') ?? dialogRef.current?.querySelector<HTMLButtonElement>('.dialog-actions button'))?.focus();
    } else dialogRef.current?.close();
  }, [dialogRequest, closeFailure]);

  useEffect(() => {
    const dialogContains = (target: EventTarget | null): boolean => target instanceof Node
      && (Boolean(closePendingDialogRef.current?.contains(target)) || Boolean(closeDialogRef.current?.contains(target)));
    const blockBackgroundInput = (event: Event): void => {
      if (!rendererOperations.current.frozen || dialogContains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const eventNames = ['beforeinput', 'change', 'click', 'input', 'keydown', 'pointerdown', 'submit'] as const;
    for (const eventName of eventNames) document.addEventListener(eventName, blockBackgroundInput, true);
    return () => {
      for (const eventName of eventNames) document.removeEventListener(eventName, blockBackgroundInput, true);
    };
  }, []);

  useEffect(() => {
    const dialog = closePendingDialogRef.current;
    if (closePending) {
      if (dialog && !dialog.open) dialog.showModal();
    } else if (dialog?.open) dialog.close();
  }, [closePending]);

  useEffect(() => {
    const dialog = closeDialogRef.current;
    if (closeFailure) {
      if (dialog && !dialog.open) {
        dialog.showModal();
        dialog.querySelector<HTMLButtonElement>('.close-retry-button')?.focus();
      }
    } else if (dialog?.open) dialog.close();
  }, [closeFailure]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const update = () => {
      setCompactLayout(window.innerWidth <= 802);
      closePreview();
    };
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!sidebarPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePreview();
    };
    const closeOnWindowBlur = () => closePreview();
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('blur', closeOnWindowBlur);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('blur', closeOnWindowBlur);
    };
  }, [sidebarPreview]);

  useEffect(() => () => clearPreviewClose(), []);

  useEffect(() => {
    if (route.page === 'settings') {
      document.querySelector<HTMLButtonElement>('.settings-nav-item.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [route.page, settingsSection, compactLayout]);

  useEffect(() => {
    routeRef.current = route;
    if (route.page === 'chat') {
      const id = route.id;
      if (!id) return;
      const routeRevision = routeGeneration.current;
      const generation = ++chatDetailLoadGeneration.current;
      const fromHome = homeChatId.current === id;
      if (fromHome) homeChatId.current = null;
      if (!fromHome) {
        setDraft('');
        draftRef.current = '';
        draftSave.current = Promise.resolve();
      }
      setChatDraftSaveError(null);
      setChatLoadState({ chatId: id, status: 'loading' });
      let cancelled = false;
      setChatDetail(null);
      void window.gigaChat.chats.get(id).then((detail) => {
        if (cancelled || generation !== chatDetailLoadGeneration.current
          || routeRevision !== routeGeneration.current
          || routeRef.current.page !== 'chat' || routeRef.current.id !== id) return;
        setChatDetail(detail);
        if (!fromHome) {
          const retained = retainedChatDrafts.current.get(id);
          const loadedDraft = retained?.text ?? detail.draft;
          setDraft(loadedDraft);
          draftRef.current = loadedDraft;
          if (retained?.message) setChatDraftSaveError({ chatId: id, message: retained.message });
        }
        setChatLoadState({ chatId: id, status: 'ready' });
      }).catch((error: unknown) => {
        if (cancelled || generation !== chatDetailLoadGeneration.current
          || routeRevision !== routeGeneration.current
          || routeRef.current.page !== 'chat' || routeRef.current.id !== id) return;
        setChatLoadState({ chatId: id, status: 'error', error: getErrorMessage(error) });
      });
      return () => { cancelled = true; };
    } else if (route.page === 'home') {
      chatDetailLoadGeneration.current += 1;
      setDraft('');
      draftRef.current = '';
      draftSave.current = Promise.resolve();
      homeChatId.current = null;
      setChatDetail(null);
      setChatLoadState({ chatId: '', status: 'ready' });
      setChatDraftSaveError(null);
    }
  }, [route.page, route.id, chatLoadRetry]);

  useEffect(() => {
    const chatId = route.page === 'chat' ? route.id : undefined;
    setRuntimeTurns([]);
    if (!chatId) return undefined;
    let cancelled = false;
    const routeRevision = routeGeneration.current;
    const generation = chatDetailLoadGeneration.current;
    const merge = (turn: RuntimeTurnSnapshot): void => {
      if (cancelled || generation !== chatDetailLoadGeneration.current
        || routeRevision !== routeGeneration.current
        || routeRef.current.page !== 'chat' || routeRef.current.id !== chatId || turn.chatId !== chatId) return;
      setRuntimeTurns((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        byId.set(turn.id, turn);
        return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-12);
      });
      if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled') {
        const profileRevision = permissionProfileRevision.current;
        const skillRevision = skillSelectionRevision.current;
        const profileSave = permissionProfileSave.current;
        const skillSave = skillSelectionSave.current;
        void Promise.all([profileSave.catch(() => undefined), skillSave.catch(() => undefined)])
          .then(() => window.gigaChat.chats.get(chatId)).then((detail) => {
            if (cancelled || generation !== chatDetailLoadGeneration.current
              || routeRevision !== routeGeneration.current
              || routeRef.current.page !== 'chat' || routeRef.current.id !== chatId) return;
            if (profileRevision === permissionProfileRevision.current
              && pendingPermissionChatIdRef.current === chatId && detail.nextTurnPermissionProfile === null) {
              pendingPermissionProfileRef.current = null;
              pendingPermissionChatIdRef.current = null;
              setPendingPermissionProfile(null);
            }
            if (skillRevision === skillSelectionRevision.current
              && pendingSkillChatIdRef.current === chatId && detail.nextTurnSkillId === null) {
              pendingSkillIdRef.current = null;
              pendingSkillChatIdRef.current = null;
              setPendingSkillId(null);
            }
            setChatDetail((current) => current?.id === chatId ? {
              ...detail,
              ...(profileRevision === permissionProfileRevision.current ? {} : {
                nextTurnPermissionProfile: current.nextTurnPermissionProfile,
              }),
              ...(skillRevision === skillSelectionRevision.current ? {} : {
                nextTurnSkillId: current.nextTurnSkillId,
              }),
            } : detail);
          }).catch((error: unknown) => {
            if (!cancelled && generation === chatDetailLoadGeneration.current
              && routeRevision === routeGeneration.current
              && routeRef.current.page === 'chat' && routeRef.current.id === chatId) setNotice(getErrorMessage(error));
          });
      }
    };
    const unsubscribe = window.gigaChat.runtime.onUpdate(merge);
    void window.gigaChat.runtime.list(chatId).then((turns) => {
      if (cancelled || generation !== chatDetailLoadGeneration.current
        || routeRevision !== routeGeneration.current
        || routeRef.current.page !== 'chat' || routeRef.current.id !== chatId) return;
      setRuntimeTurns((current) => {
        const byId = new Map(turns.map((turn) => [turn.id, turn]));
        for (const turn of current) if (!byId.has(turn.id)) byId.set(turn.id, turn);
        return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-12);
      });
    }).catch((error: unknown) => {
      if (!cancelled && generation === chatDetailLoadGeneration.current
        && routeRevision === routeGeneration.current
        && routeRef.current.page === 'chat' && routeRef.current.id === chatId) setNotice(getErrorMessage(error));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [route.page, route.id, chatLoadRetry]);

  useEffect(() => {
    if (route.page !== 'settings') return;
    let cancelled = false;
    void Promise.all([
      window.gigaChat.settings.getAutoStart(),
      window.gigaChat.settings.listOpeners(),
      window.gigaChat.settings.getAppInfo(),
    ]).then(([enabled, found, info]) => {
      if (cancelled) return;
      setAutoStart(enabled);
      setOpeners(found);
      setAppInfo(info);
    }).catch((error: unknown) => {
      if (!cancelled) setNotice(getErrorMessage(error));
    });
    return () => { cancelled = true; };
  }, [route.page]);

  useEffect(() => {
    if (route.page !== 'settings' || settingsSection !== 'personalization') return;
    let cancelled = false;
    const generation = ++globalInstructionLoadGeneration.current;
    setGlobalInstructionsLoading(true);
    setGlobalInstructionsReady(false);
    setGlobalInstructionsLoadError('');
    void window.gigaChat.settings.readInstructions()
      .then((document) => {
        if (!cancelled && generation === globalInstructionLoadGeneration.current) {
          setGlobalInstructions(globalSaver.load('global', document));
          setGlobalInstructionsReady(true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && generation === globalInstructionLoadGeneration.current) {
          setGlobalInstructionsStatus('error');
          setGlobalInstructionsLoadError(getErrorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled && generation === globalInstructionLoadGeneration.current) setGlobalInstructionsLoading(false);
      });
    return () => {
      cancelled = true;
      if (generation === globalInstructionLoadGeneration.current) globalInstructionLoadGeneration.current += 1;
    };
  }, [route.page, settingsSection, globalSaver, globalInstructionRetry]);

  useEffect(() => {
    if (route.page !== 'settings' || settingsSection !== 'permissions') return;
    if (closeUiState.current.configDraft !== closeUiState.current.configSaved) return;
    void trackRendererOperation(loadCustomConfig);
  }, [route.page, settingsSection]);

  const library = sidebarSections(projects, chats);
  const { activeProjects, activeChats, pinnedProjects, pinnedChats } = library;
  const visibleProjects = showAllProjects ? library.projects : library.projects.slice(0, 5);
  const visibleChats = showAllChats ? library.recentChats : library.recentChats.slice(0, 8);
  const archivedProjects = projects.filter((project) => project.archived);
  const archivedChats = chats.filter((chat) => chat.archived);
  const selectedChat = chats.find((chat) => chat.id === route.id);
  const chatComposerReady = route.page !== 'chat' || (chatLoadState.chatId === route.id
    && chatLoadState.status === 'ready' && chatDetail?.id === route.id);
  const resolvedTheme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;
  const transparentSidebar = settings.sidebarTransparent;
  const canGoBack = navigation.index > 0;
  const canGoForward = navigation.index < navigation.history.length - 1;
  const settingTitle = SETTINGS_SECTIONS.find((item) => item.id === settingsSection)?.label ?? 'Настройки';
  const activeHomeDraftSession = route.page === 'home' ? homeDraftSession.current : null;
  const composerPermissionProfile = selectedChat && chatDetail?.id === selectedChat.id
    ? chatDetail.nextTurnPermissionProfile ?? (pendingPermissionChatIdRef.current === selectedChat.id ? pendingPermissionProfile : null) ?? settings.defaultPermissionProfile
    : activeHomeDraftSession ? activeHomeDraftSession.permissionProfile ?? settings.defaultPermissionProfile
      : pendingPermissionProfile ?? settings.defaultPermissionProfile;
  const canChangeComposerPermissionProfile = (route.page === 'home' && !selectedChat)
    || Boolean(selectedChat && chatDetail?.id === selectedChat.id);
  const composerModelId = selectedChat && chatDetail?.id === selectedChat.id
    ? chatDetail.modelId ?? settings.defaultModelId : settings.defaultModelId;
  const composerProjectId = route.page === 'chat' ? selectedChat?.projectId ?? null
    : route.page === 'home' ? selectedProjectId || null : null;
  const composerSkills = skillRegistry.skills
    .filter((skill) => skill.scope === 'global' || skill.projectId === composerProjectId)
    .map((skill) => ({
      id: skill.id, name: skill.name, command: skill.command, enabled: skill.enabled,
      scope: skill.scope, projectId: skill.projectId,
      scopeLabel: skill.scope === 'global' ? 'Global' : skill.projectName ?? 'Project',
    }));
  const selectedComposerSkillId = selectedChat && chatDetail?.id === selectedChat.id
    ? (pendingSkillChatIdRef.current === selectedChat.id ? pendingSkillId : null) ?? chatDetail.nextTurnSkillId
    : activeHomeDraftSession ? activeHomeDraftSession.skillId
      : route.page === 'home' && pendingSkillChatIdRef.current === null ? pendingSkillId : null;
  const selectedComposerSkill = skillRegistry.skills.find((skill) => skill.id === selectedComposerSkillId && skill.enabled) ?? null;
  const composerCompletion = completionDismissed ? null : getComposerCompletion(draft, composerCaret, composerSkills, composerProjectId);

  function insertComposerSuggestion(suggestion: ComposerSuggestion, caret = composerInputRef.current?.selectionStart ?? composerCaret): void {
    const inserted = completeComposerSuggestion(draft, caret, suggestion);
    changeDraft(inserted.value, inserted.caret);
    if (suggestion.skillId) void changeComposerSkill(suggestion.skillId);
    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
      composerInputRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return;
    const completion = completionDismissed ? null : getComposerCompletion(draft, event.currentTarget.selectionStart, composerSkills, composerProjectId);
    if (event.key === 'Escape' && completion) {
      event.preventDefault();
      setCompletionDismissed(true);
      return;
    }
    if (completion && completion.items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setCompletionIndex((index) => (index + delta + completion.items.length) % completion.items.length);
      return;
    }
    if (completion && event.key === 'Enter' && !event.shiftKey) {
      const suggestion = completion.items[completionIndex];
      if (suggestion?.available) {
        event.preventDefault();
        insertComposerSuggestion(suggestion, event.currentTarget.selectionStart);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  }

  function navigate(next: Route): void {
    detachHomeDraftForNavigation(next);
    if (!sameRoute(routeRef.current, next)) routeGeneration.current += 1;
    routeRef.current = next;
    if (next.page !== 'chat') homeChatId.current = null;
    closePreview();
    setNavigation((current) => {
      const entries = current.history.slice(0, current.index + 1);
      if (sameRoute(entries[entries.length - 1], next)) return current;
      entries.push(next);
      return { history: entries, index: entries.length - 1 };
    });
  }

  function preserveHomeDraftSession(session: HomeDraftSession): void {
    if (!session.text && !session.creation && !session.error) return;
    if (detachedDraftSessionSet.current.has(session)) return;
    detachedDraftSessionSet.current.add(session);
    setDetachedDraftSessions((current) => [...current, session]);
  }

  function detachHomeDraftForNavigation(next: Route): void {
    const current = routeRef.current;
    const session = homeDraftSession.current;
    if (current.page === 'home' && next.page !== 'home'
      && !(next.page === 'chat' && next.id && next.id === session?.chatId)) {
      if (session) preserveHomeDraftSession(session);
      homeDraftSession.current = null;
    }
    if (next.page === 'home' && current.page !== 'home') {
      if (session) preserveHomeDraftSession(session);
      homeDraftSession.current = null;
    }
  }

  function resumeDetachedDraftSession(session: HomeDraftSession): void {
    const current = homeDraftSession.current;
    if (current && current !== session) preserveHomeDraftSession(current);
    homeDraftSession.current = null;
    detachedDraftSessionSet.current.delete(session);
    setDetachedDraftSessions((current) => current.filter((item) => item !== session));
    navigate({ page: 'home' });
    homeDraftSession.current = session;
    setSelectedProjectId(session.projectId ?? '');
    setDraft(session.text);
    draftRef.current = session.text;
    setHomeDraftError(session.error);
    void startHomeDraftSession(session).catch((error: unknown) => setHomeDraftError(getErrorMessage(error)));
  }

  function startNewHomeChat(): void {
    routeGeneration.current += 1;
    setHomeVoiceGeneration((current) => current + 1);
    draftRevision.current += 1;
    const previous = homeDraftSession.current;
    if (previous) preserveHomeDraftSession(previous);
    homeDraftSession.current = null;
    if (previous && pendingChat.current === previous.creation) pendingChat.current = null;
    homeChatId.current = null;
    permissionProfileRevision.current += 1;
    pendingPermissionProfileRef.current = null;
    pendingPermissionChatIdRef.current = null;
    setPendingPermissionProfile(null);
    skillSelectionRevision.current += 1;
    pendingSkillIdRef.current = null;
    pendingSkillChatIdRef.current = null;
    setPendingSkillId(null);
    setDraft('');
    draftRef.current = '';
    setComposerCaret(0);
    setCompletionDismissed(false);
    setHomeDraftError('');
    setSelectedProjectId('');
    navigate({ page: 'home' });
  }

  function openSettings(section: SettingsSection = 'general'): void {
    detachHomeDraftForNavigation({ page: 'settings' });
    closePreview();
    setSettingsSection(section);
    const next = { page: 'settings' as const };
    if (!sameRoute(routeRef.current, next)) routeGeneration.current += 1;
    routeRef.current = next;
    setNavigation((current) => {
      const entries = current.history.slice(0, current.index + 1);
      if (sameRoute(entries[entries.length - 1], next)) return current;
      entries.push(next);
      return { history: entries, index: entries.length - 1 };
    });
  }

  function moveHistory(delta: -1 | 1): void {
    closePreview();
    setNavigation((current) => {
      const index = Math.max(0, Math.min(current.history.length - 1, current.index + delta));
      const next = current.history[index];
      if (!next) return current;
      detachHomeDraftForNavigation(next);
      if (index !== current.index && !sameRoute(routeRef.current, next)) routeGeneration.current += 1;
      routeRef.current = next;
      if (next.page !== 'chat') homeChatId.current = null;
      return { ...current, index };
    });
  }

  function createChat(projectId: string | null = null, kind: ChatKind = 'text'): Promise<void> {
    return trackRendererOperation(() => createChatOperation(projectId, kind));
  }

  async function createChatOperation(projectId: string | null, kind: ChatKind): Promise<void> {
    const origin = routeRef.current;
    const originGeneration = routeGeneration.current;
    const oldSession = homeDraftSession.current;
    if (origin.page === 'home') {
      if (oldSession) preserveHomeDraftSession(oldSession);
      homeDraftSession.current = null;
      if (oldSession && pendingChat.current === oldSession.creation) pendingChat.current = null;
    }
    try {
      const chat = await window.gigaChat.chats.create(projectId, kind);
      setChats((current) => [chat, ...current]);
      if (origin.page === 'home' && originGeneration === routeGeneration.current && sameRoute(routeRef.current, origin)
        && pendingPermissionProfileRef.current) {
        const profile = pendingPermissionProfileRef.current;
        const nextTurnPermissionProfile = profile === settings.defaultPermissionProfile ? null : profile;
        const revision = permissionProfileRevision.current;
        pendingPermissionChatIdRef.current = chat.id;
        void savePermissionProfileForChat(chat.id, profile).then(() => {
          if (revision !== permissionProfileRevision.current || pendingPermissionChatIdRef.current !== chat.id
            || pendingPermissionProfileRef.current !== profile) return;
          setChatDetail((current) => current?.id === chat.id
            ? { ...current, nextTurnPermissionProfile } : current);
        }).catch((error: unknown) => {
          if (revision === permissionProfileRevision.current && pendingPermissionChatIdRef.current === chat.id) {
            setNotice(getErrorMessage(error));
          }
        });
      }
      if (origin.page === 'home' && originGeneration === routeGeneration.current && sameRoute(routeRef.current, origin) && pendingSkillIdRef.current) {
        pendingSkillChatIdRef.current = chat.id;
        void saveSkillSelectionForChat(chat.id, pendingSkillIdRef.current, skillSelectionRevision.current);
      }
      if (originGeneration === routeGeneration.current && sameRoute(routeRef.current, origin)) {
        draftRef.current = '';
        setDraft('');
        setSelectedProjectId('');
        navigate({ page: 'chat', id: chat.id });
      }
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setNotice(getErrorMessage(error));
    }
  }

  function saveChatDraft(chatId: string, value: string): void {
    const revision = (chatDraftMutationRevision.current.get(chatId) ?? 0) + 1;
    chatDraftMutationRevision.current.set(chatId, revision);
    const current = retainedChatDrafts.current.get(chatId);
    retainedChatDrafts.current.set(chatId, { text: value, message: current?.text === value ? current.message : '' });
    draftSave.current = window.gigaChat.chats.update(chatId, { draft: value });
    void draftSave.current.then(() => {
      if (chatDraftMutationRevision.current.get(chatId) !== revision) return;
      retainedChatDrafts.current.delete(chatId);
      setChatDraftSaveError((previous) => previous?.chatId === chatId ? null : previous);
    }).catch((error: unknown) => {
      const message = getErrorMessage(error);
      if (chatDraftMutationRevision.current.get(chatId) === revision) {
        retainedChatDrafts.current.set(chatId, { text: value, message });
        if (routeRef.current.page === 'chat' && routeRef.current.id === chatId) setChatDraftSaveError({ chatId, message });
      }
    });
  }

  function selectHomeProject(projectId: string): void {
    const nextProjectId = projectId || null;
    const scopedSkill = pendingSkillIdRef.current ? /^project\/([^/]+)\//.exec(pendingSkillIdRef.current) : null;
    if (scopedSkill && scopedSkill[1] !== nextProjectId) {
      pendingSkillIdRef.current = null;
      pendingSkillChatIdRef.current = null;
      skillSelectionRevision.current += 1;
      setPendingSkillId(null);
    }
    setSelectedProjectId(projectId);
    const session = homeDraftSession.current;
    if (!session) return;
    session.projectId = nextProjectId;
    const sessionSkillScope = session.skillId ? /^project\/([^/]+)\//.exec(session.skillId) : null;
    if (sessionSkillScope && sessionSkillScope[1] !== nextProjectId) session.skillId = null;
    if (session.chatId && !session.creation) {
      void startHomeDraftSession(session).catch((error: unknown) => setHomeDraftError(getErrorMessage(error)));
    }
  }

  async function moveDraftChat(chatId: string, projectId: string | null): Promise<ChatSummary> {
    return window.gigaChat.chats.update(chatId, { projectId });
  }

  async function saveDraftSession(chatId: string, text: string): Promise<unknown> {
    return window.gigaChat.chats.update(chatId, { draft: text });
  }

  async function saveDraftSessionSelection(chatId: string, snapshot: Readonly<NewChatDraftSession<PermissionProfile>>): Promise<unknown> {
    return window.gigaChat.chats.update(chatId, {
      nextTurnPermissionProfile: snapshot.permissionProfile,
      nextTurnSkillId: snapshot.skillId,
    });
  }

  function savePermissionProfileForChat(chatId: string, profile: PermissionProfile): Promise<ChatSummary> {
    const nextTurnPermissionProfile = profile === settings.defaultPermissionProfile ? null : profile;
    const save = permissionProfileSave.current.catch(() => undefined).then(() =>
      window.gigaChat.chats.update(chatId, { nextTurnPermissionProfile }),
    );
    permissionProfileSave.current = save;
    return save;
  }

  function startHomeDraftSession(session: HomeDraftSession): Promise<ChatSummary> {
    if (session.creation) return session.creation;
    session.error = '';
    setHomeDraftError('');
    const operation = trackRendererOperation(() => session.chat
      ? persistDraftSession(session, session.chat, moveDraftChat, saveDraftSession, saveDraftSessionSelection)
      : createChatForDraftSession(
        session,
        (projectId) => window.gigaChat.chats.create(projectId),
        moveDraftChat,
        saveDraftSession,
        saveDraftSessionSelection,
        (chat) => {
          session.chat = chat;
          session.chatId = chat.id;
          setChats((current) => current.some((item) => item.id === chat.id)
            ? current.map((item) => item.id === chat.id ? chat : item)
            : [chat, ...current]);
        },
      ));
    session.creation = operation;
    pendingChat.current = operation;
    void operation.then((chat) => {
      session.chat = chat;
      session.chatId = chat.id;
      session.error = '';
      setChats((current) => current.some((item) => item.id === chat.id)
        ? current.map((item) => item.id === chat.id ? chat : item)
        : [chat, ...current]);
      if (!shouldOpenCreatedDraftChat(session, homeDraftSession.current, routeRef.current.page === 'home')) {
        detachedDraftSessionSet.current.delete(session);
        setDetachedDraftSessions((current) => current.filter((item) => item !== session));
        return;
      }
      homeChatId.current = chat.id;
      if (pendingPermissionChatIdRef.current === null
        && pendingPermissionProfileRef.current === session.permissionProfile) {
        pendingPermissionProfileRef.current = null;
        setPendingPermissionProfile(null);
      }
      if (pendingSkillChatIdRef.current === null && pendingSkillIdRef.current === session.skillId) {
        pendingSkillIdRef.current = null;
        setPendingSkillId(null);
      }
      navigate({ page: 'chat', id: chat.id });
      homeDraftSession.current = null;
      setHomeDraftError('');
    }).catch((error: unknown) => {
      session.error = getErrorMessage(error);
      if (session.chatId) retainedChatDrafts.current.set(session.chatId, { text: session.text, message: session.error });
      if (homeDraftSession.current === session) setHomeDraftError(session.error);
      if (detachedDraftSessionSet.current.has(session)) setDetachedDraftSessions((current) => [...current]);
    }).finally(() => {
      if (session.creation === operation) session.creation = null;
      if (pendingChat.current === operation) pendingChat.current = null;
    }).catch(() => undefined);
    return operation;
  }

  function submitMessage(): Promise<void> {
    return trackRendererOperation(() => submitMessageOperation());
  }

  async function submitMessageOperation(): Promise<void> {
    const value = draftRef.current.trim();
    if (!value || sending) return;
    if (isUnavailableCompactCommand(value)) {
      showSuccess('/compact станет доступна после подключения модели. История не изменена.');
      return;
    }
    const sourceRoute = routeRef.current;
    const sourceRouteGeneration = routeGeneration.current;
    const sourceDraftRevision = draftRevision.current;
    const sourceSession = sourceRoute.page === 'home' ? homeDraftSession.current : null;
    const acceptedDraftSave = draftSave.current;
    const acceptedPermissionSave = permissionProfileSave.current;
    const acceptedSkillSave = skillSelectionSave.current;
    const acceptedPermissionProfile = pendingPermissionProfileRef.current;
    const acceptedPermissionChatId = pendingPermissionChatIdRef.current;
    const acceptedPermissionRevision = permissionProfileRevision.current;
    const acceptedSkillId = pendingSkillIdRef.current;
    const acceptedSkillChatId = pendingSkillChatIdRef.current;
    const acceptedSkillRevision = skillSelectionRevision.current;
    setSending(true);
    try {
      let acceptedRouteGeneration = sourceRouteGeneration;
      let chatId: string | undefined;
      if (sourceRoute.page === 'chat') chatId = sourceRoute.id;
      else if (sourceSession) {
        chatId = (await startHomeDraftSession(sourceSession)).id;
        if (routeRef.current.page === 'chat' && routeRef.current.id === chatId && homeChatId.current === chatId) {
          acceptedRouteGeneration = routeGeneration.current;
        }
      } else chatId = homeChatId.current ?? (await pendingChat.current)?.id;
      if (!chatId) throw new Error('Не удалось создать чат. Попробуйте снова.');
      await acceptedDraftSave;
      await acceptedPermissionSave;
      await acceptedSkillSave;
      const pendingProfile = !sourceSession && sourceRoute.page === 'home'
        && acceptedPermissionChatId === null ? acceptedPermissionProfile : null;
      if (pendingProfile) await window.gigaChat.chats.update(chatId, { nextTurnPermissionProfile: pendingProfile });
      const unboundHomeSkill = !sourceSession && sourceRoute.page === 'home'
        && acceptedSkillChatId === null ? acceptedSkillId : null;
      if (unboundHomeSkill) {
        await window.gigaChat.chats.update(chatId, { nextTurnSkillId: unboundHomeSkill });
      }
      const detail = await window.gigaChat.chats.appendLocalMessage(chatId, value);
      const stillCurrent = acceptedRouteGeneration === routeGeneration.current
        && sourceDraftRevision === draftRevision.current
        && ((routeRef.current.page === 'chat' && routeRef.current.id === chatId)
          || (sourceSession !== null && homeDraftSession.current === sourceSession && routeRef.current.page === 'home'));
      if (stillCurrent && routeRef.current.page === 'chat') {
        draftRevision.current += 1;
        setChatDetail((current) => current?.id === chatId ? {
          ...detail,
          ...(acceptedPermissionRevision === permissionProfileRevision.current ? {} : {
            nextTurnPermissionProfile: current.nextTurnPermissionProfile,
          }),
          ...(acceptedSkillRevision === skillSelectionRevision.current ? {} : {
            nextTurnSkillId: current.nextTurnSkillId,
          }),
        } : detail);
        setDraft('');
        draftRef.current = '';
        retainedChatDrafts.current.delete(chatId);
        setChatDraftSaveError(null);
      }
      if (pendingProfile && acceptedPermissionRevision === permissionProfileRevision.current
        && acceptedPermissionChatId === pendingPermissionChatIdRef.current
        && acceptedPermissionProfile === pendingPermissionProfileRef.current) {
        pendingPermissionProfileRef.current = null;
        pendingPermissionChatIdRef.current = null;
        setPendingPermissionProfile(null);
      }
      if (unboundHomeSkill && acceptedSkillRevision === skillSelectionRevision.current
        && acceptedSkillChatId === pendingSkillChatIdRef.current && acceptedSkillId === pendingSkillIdRef.current) {
        pendingSkillChatIdRef.current = chatId;
      }
      setChats(await window.gigaChat.chats.list());
      if (stillCurrent) showSuccess('Не отправлено в GigaChat API. Сообщение сохранено локально.');
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setNotice(getErrorMessage(error));
    } finally {
      setSending(false);
    }
  }

  function attachFile(): Promise<void> {
    return trackRendererOperation(() => attachFileOperation());
  }

  async function attachFileOperation(): Promise<void> {
    const sourceRoute = routeRef.current;
    const sourceRouteGeneration = routeGeneration.current;
    const sourceSession = sourceRoute.page === 'home' ? homeDraftSession.current : null;
    const sourceProjectId = selectedProjectId || null;
    try {
      const chatId = sourceRoute.page === 'chat' ? sourceRoute.id
        : sourceSession ? (await startHomeDraftSession(sourceSession)).id
          : homeChatId.current ?? (await pendingChat.current)?.id ?? null;
      const detail = await window.gigaChat.chats.importFile(chatId ?? null, sourceProjectId);
      if (!detail) return;
      setChats(await window.gigaChat.chats.list());
      const currentRoute = routeRef.current;
      const sameView = sourceRouteGeneration === routeGeneration.current;
      const stillTargetChat = sameView && currentRoute.page === 'chat' && currentRoute.id === detail.id;
      const stillSourceHome = sameView && sourceSession !== null && homeDraftSession.current === sourceSession && currentRoute.page === 'home';
      const unchangedRoute = sameView && sameRoute(currentRoute, sourceRoute);
      if (stillTargetChat || stillSourceHome || unchangedRoute) {
        setChatDetail(detail);
        if (currentRoute.page === 'home') navigate({ page: 'chat', id: detail.id });
        showSuccess('Файл скопирован в чат.');
      }
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setNotice(getErrorMessage(error));
    }
  }

  function changeDraft(value: string, caret = value.length): void {
    draftRevision.current += 1;
    setDraft(value);
    setComposerCaret(Math.max(0, Math.min(value.length, caret)));
    setCompletionDismissed(false);
    setCompletionIndex(0);
    draftRef.current = value;
    const currentRoute = routeRef.current;
    if (currentRoute.page === 'chat' && currentRoute.id) {
      saveChatDraft(currentRoute.id, value);
      return;
    }
    if (currentRoute.page !== 'home') return;
    let session = homeDraftSession.current;
    if (!session) {
      const projectId = selectedProjectId || null;
      const selectedSkillId = pendingSkillIdRef.current;
      const selectedSkillScope = selectedSkillId ? /^project\/([^/]+)\//.exec(selectedSkillId) : null;
      const validSkillId = selectedSkillScope && selectedSkillScope[1] !== projectId ? null : selectedSkillId;
      if (selectedSkillId && !validSkillId) {
        pendingSkillIdRef.current = null;
        pendingSkillChatIdRef.current = null;
        skillSelectionRevision.current += 1;
        setPendingSkillId(null);
      }
      session = {
        ...createNewChatDraftSession({
          text: value,
          projectId,
          permissionProfile: pendingPermissionProfileRef.current,
          skillId: validSkillId,
        }),
        creation: null,
        chatId: null,
        chat: null,
        error: '',
      };
      homeDraftSession.current = session;
    }
    session.text = value;
    if (session.chatId || value) void startHomeDraftSession(session).catch(() => undefined);
  }

  function insertVoiceTranscript(text: string): void {
    const current = draftRef.current;
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    const next = `${current}${separator}${text}`;
    changeDraft(next, next.length);
    window.requestAnimationFrame(() => {
      const input = composerInputRef.current;
      input?.focus();
      input?.setSelectionRange(next.length, next.length);
    });
  }

  function openDialog(request: NonNullable<typeof dialogRequest>, value = ''): void {
    dialogGeneration.current += 1;
    if (activeProjectInstructionId.current !== null) {
      activeProjectInstructionId.current = null;
      projectInstructionLoadGeneration.current += 1;
      setProjectInstructionsReady(false);
    }
    setDialogValue(value);
    setDialogFolder(null);
    setDialogError('');
    setDialogRequest(request);
  }

  function createProject(assignChatId?: string): void { openDialog({ kind: 'create-project', assignChatId }); }
  function renameProject(project: Project): void { openDialog({ kind: 'rename-project', project }, project.name); }

  async function openProjectSettings(project: Project): Promise<void> {
    openDialog({ kind: 'project-settings', project });
    activeProjectInstructionId.current = project.id;
    const generation = ++projectInstructionLoadGeneration.current;
    setProjectInstructions('');
    setProjectInstructionsBackup(null);
    setProjectInstructionsLoading(true);
    setProjectInstructionsReady(false);
    setProjectInstructionsLoadError('');
    setProjectInstructionsStatus('saved');
    setProjectInstructionsConflict(null);
    setProjectPreservedInstruction(undefined);
    setDialogError('');
    try {
      const document = await window.gigaChat.projects.readInstructions(project.id);
      if (generation !== projectInstructionLoadGeneration.current || activeProjectInstructionId.current !== project.id) return;
      setProjectInstructions(projectSaver.load(project.id, document));
      setProjectInstructionsReady(true);
      setProjectInstructionsLoading(false);
      try {
        const backup = await window.gigaChat.projects.instructionsBackupPath(project.id);
        if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === project.id) setProjectInstructionsBackup(backup);
      } catch (error) {
        if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === project.id) setDialogError(getErrorMessage(error));
      }
    } catch (error) {
      if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === project.id) {
        setProjectInstructionsLoadError(getErrorMessage(error));
        setProjectInstructionsStatus('error');
      }
    } finally {
      if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === project.id) setProjectInstructionsLoading(false);
    }
  }

  async function retryProjectInstructions(): Promise<void> {
    const projectId = activeProjectInstructionId.current;
    if (!projectId) return;
    const generation = ++projectInstructionLoadGeneration.current;
    setProjectInstructionsLoading(true);
    setProjectInstructionsLoadError('');
    try {
      const document = await window.gigaChat.projects.readInstructions(projectId);
      if (generation !== projectInstructionLoadGeneration.current || activeProjectInstructionId.current !== projectId) return;
      setProjectInstructions(projectSaver.load(projectId, document));
      setProjectInstructionsReady(true);
      setProjectInstructionsLoading(false);
      try {
        const backup = await window.gigaChat.projects.instructionsBackupPath(projectId);
        if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === projectId) setProjectInstructionsBackup(backup);
      } catch (error) {
        if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === projectId) setDialogError(getErrorMessage(error));
      }
    } catch (error) {
      if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === projectId) {
        setProjectInstructionsLoadError(getErrorMessage(error));
      }
    } finally {
      if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === projectId) setProjectInstructionsLoading(false);
    }
  }

  async function closeProjectSettings(): Promise<boolean> {
    const projectId = dialogRequest?.kind === 'project-settings' ? dialogRequest.project?.id : undefined;
    if (!projectId || activeProjectInstructionId.current !== projectId) return false;
    let generation = projectInstructionLoadGeneration.current;
    if (projectInstructionsLoading) {
      projectInstructionLoadGeneration.current += 1;
      setProjectInstructionsLoading(false);
      generation = projectInstructionLoadGeneration.current;
      if (!projectInstructionsReady) {
        activeProjectInstructionId.current = null;
        setDialogRequest(null);
        return true;
      }
    }
    try {
      await projectSaver.flush(projectId);
      if (generation !== projectInstructionLoadGeneration.current || activeProjectInstructionId.current !== projectId) return false;
      activeProjectInstructionId.current = null;
      projectInstructionLoadGeneration.current += 1;
      setDialogRequest(null);
      return true;
    } catch (error) {
      if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === projectId) setDialogError(getErrorMessage(error));
      return false;
    }
  }

  async function reloadGlobalInstructions(): Promise<void> {
    const conflict = globalInstructionsConflict;
    if (!conflict) return;
    const generation = ++globalInstructionLoadGeneration.current;
    setGlobalInstructionsLoading(true);
    try {
      const current = await window.gigaChat.settings.readInstructions();
      if (generation !== globalInstructionLoadGeneration.current) return;
      setGlobalInstructions(globalSaver.reload('global', current));
      setGlobalInstructionsConflict(null);
    } catch (error) {
      if (generation === globalInstructionLoadGeneration.current) setNotice(getErrorMessage(error));
    } finally {
      if (generation === globalInstructionLoadGeneration.current) setGlobalInstructionsLoading(false);
    }
  }

  function saveGlobalInstructionsCopy(): Promise<void> {
    return trackRendererOperation(() => saveGlobalInstructionsCopyOperation());
  }

  async function saveGlobalInstructionsCopyOperation(): Promise<void> {
    if (!globalInstructionsReady) return;
    try {
      const path = await window.gigaChat.settings.saveInstructionsCopy(globalInstructions);
      showSuccess(`Текст сохранён отдельной копией: ${path}`);
    } catch (error) { rendererOperations.current.reportFailure(error); setNotice(getErrorMessage(error)); }
  }

  async function reloadProjectInstructions(): Promise<void> {
    const conflict = projectInstructionsConflict;
    const projectId = dialogRequest?.kind === 'project-settings' ? dialogRequest.project?.id : undefined;
    if (!conflict || !projectId || activeProjectInstructionId.current !== projectId) return;
    const generation = ++projectInstructionLoadGeneration.current;
    setProjectInstructionsLoading(true);
    try {
      const current = await window.gigaChat.projects.readInstructions(projectId);
      if (generation !== projectInstructionLoadGeneration.current || activeProjectInstructionId.current !== projectId) return;
      setProjectInstructions(projectSaver.reload(projectId, current));
      setProjectInstructionsConflict(null);
      setDialogError('');
    } catch (error) {
      if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === projectId) setDialogError(getErrorMessage(error));
    } finally {
      if (generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === projectId) setProjectInstructionsLoading(false);
    }
  }

  function saveProjectInstructionsCopy(): Promise<void> {
    return trackRendererOperation(() => saveProjectInstructionsCopyOperation());
  }

  async function saveProjectInstructionsCopyOperation(): Promise<void> {
    const projectId = dialogRequest?.kind === 'project-settings' ? dialogRequest.project?.id : undefined;
    if (!projectId || !projectInstructionsReady || activeProjectInstructionId.current !== projectId) return;
    const generation = projectInstructionLoadGeneration.current;
    const operationGeneration = dialogGeneration.current;
    try {
      const path = await window.gigaChat.projects.saveInstructionsCopy(projectId, projectInstructions);
      if (generation === projectInstructionLoadGeneration.current && operationGeneration === dialogGeneration.current
        && activeProjectInstructionId.current === projectId) showSuccess(`Текст сохранён отдельной копией: ${path}`);
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      if (generation === projectInstructionLoadGeneration.current && operationGeneration === dialogGeneration.current
        && activeProjectInstructionId.current === projectId) setDialogError(getErrorMessage(error));
    }
  }

  function pickProjectFolder(): Promise<void> {
    return trackRendererOperation(() => pickProjectFolderOperation());
  }

  async function pickProjectFolderOperation(): Promise<void> {
    const operationGeneration = dialogGeneration.current;
    try {
      const folder = await window.gigaChat.projects.pickFolder();
      if (operationGeneration === dialogGeneration.current && dialogRequest?.kind === 'create-project' && folder) setDialogFolder(folder);
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      if (operationGeneration === dialogGeneration.current && dialogRequest?.kind === 'create-project') setDialogError(getErrorMessage(error));
    }
  }

  function updateProject(project: Project, patch: ProjectPatch): Promise<void> {
    return trackRendererOperation(() => updateProjectOperation(project, patch));
  }

  async function updateProjectOperation(project: Project, patch: ProjectPatch): Promise<void> {
    try {
      const result = await window.gigaChat.projects.update(project.id, patch);
      const updated = result.project;
      setProjects((current) => current.map((item) => item.id === project.id ? updated : item));
      if (result.warning) setNotice(result.warning);
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setNotice(getErrorMessage(error));
    }
  }

  function chooseProjectFolder(project: Project): Promise<void> {
    return trackRendererOperation(() => chooseProjectFolderOperation(project));
  }

  async function chooseProjectFolderOperation(project: Project): Promise<void> {
    const requestRevision = (projectFolderChangeRevision.current.get(project.id) ?? 0) + 1;
    projectFolderChangeRevision.current.set(project.id, requestRevision);
    const isLatestRequest = () => projectFolderChangeRevision.current.get(project.id) === requestRevision;
    const generation = projectInstructionLoadGeneration.current;
    const editorIsActive = activeProjectInstructionId.current === project.id;
    let reloadingInstructions = false;
    try {
      await projectSaver.flush(project.id);
      if (!isLatestRequest() || (editorIsActive && (generation !== projectInstructionLoadGeneration.current || activeProjectInstructionId.current !== project.id))) return;
      const result = await window.gigaChat.projects.chooseFolder(project.id);
      if (!isLatestRequest()) return;
      const updated = result.project;
      setProjects((current) => current.map((item) => item.id === project.id ? updated : item));
      const stillActive = editorIsActive && generation === projectInstructionLoadGeneration.current
        && activeProjectInstructionId.current === project.id && isLatestRequest();
      if (stillActive) setDialogRequest((current) => current?.kind === 'project-settings' && current.project?.id === project.id ? { ...current, project: updated } : current);
      if (result.warning) setNotice(result.warning);
      if (stillActive && updated.workingFolder !== project.workingFolder) {
        reloadingInstructions = true;
        setProjectInstructionsLoading(true);
        setProjectInstructionsReady(false);
        setProjectInstructionsLoadError('');
        const document = await window.gigaChat.projects.readInstructions(project.id);
        if (!isLatestRequest() || generation !== projectInstructionLoadGeneration.current || activeProjectInstructionId.current !== project.id) return;
        setProjectInstructions(projectSaver.load(project.id, document));
        setProjectInstructionsReady(true);
        reloadingInstructions = false;
        try {
          const backup = await window.gigaChat.projects.instructionsBackupPath(project.id);
          if (!isLatestRequest() || generation !== projectInstructionLoadGeneration.current || activeProjectInstructionId.current !== project.id) return;
          setProjectInstructionsBackup(backup);
        } catch (error) {
          if (isLatestRequest() && generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === project.id) setDialogError(getErrorMessage(error));
        }
      }
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      if (isLatestRequest() && editorIsActive && generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === project.id) {
        if (reloadingInstructions) {
          setProjectInstructionsLoadError(getErrorMessage(error));
          setProjectInstructionsReady(false);
        } else setDialogError(getErrorMessage(error));
      } else if (isLatestRequest() && dialogRequest?.kind !== 'project-settings') setNotice(getErrorMessage(error));
    } finally {
      if (isLatestRequest() && editorIsActive && generation === projectInstructionLoadGeneration.current && activeProjectInstructionId.current === project.id) setProjectInstructionsLoading(false);
    }
  }

  function removeProject(project: Project): void { openDialog({ kind: 'delete-project', project }); }

  function renameChat(chat: ChatSummary): void { openDialog({ kind: 'rename-chat', chat }, chat.title); }

  function updateChat(chat: ChatSummary, patch: ChatPatch): Promise<void> {
    return trackRendererOperation(() => updateChatOperation(chat, patch));
  }

  async function updateChatOperation(chat: ChatSummary, patch: ChatPatch): Promise<void> {
    const routeRevision = routeGeneration.current;
    try {
      const updated = await window.gigaChat.chats.update(chat.id, patch);
      setChats((current) => current.map((item) => item.id === chat.id ? updated : item));
      if (routeRevision === routeGeneration.current) {
        setChatDetail((current) => current?.id === chat.id ? { ...current, ...patch } : current);
      }
      if (routeRevision === routeGeneration.current && patch.projectId !== undefined
        && routeRef.current.page === 'chat' && routeRef.current.id === chat.id) {
        const generation = chatDetailLoadGeneration.current;
        const detail = await window.gigaChat.chats.get(chat.id);
        if (routeRevision === routeGeneration.current && generation === chatDetailLoadGeneration.current
          && routeRef.current.page === 'chat' && routeRef.current.id === chat.id) setChatDetail(detail);
      }
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setNotice(getErrorMessage(error));
    }
  }

  function removeChat(chat: ChatSummary): Promise<void> {
    return trackRendererOperation(() => removeChatOperation(chat));
  }

  async function removeChatOperation(chat: ChatSummary): Promise<void> {
    try {
      const detail = await window.gigaChat.chats.get(chat.id);
      openDialog({ kind: 'delete-chat', chat, hasFiles: detail.artifacts.length > 0 });
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setNotice(getErrorMessage(error));
    }
  }

  function submitDialog(): Promise<void> {
    return trackRendererOperation(() => submitDialogOperation());
  }

  async function submitDialogOperation(): Promise<void> {
    if (!dialogRequest || dialogBusy) return;
    setDialogBusy(true);
    setDialogError('');
    try {
      const { kind, chat, project } = dialogRequest;
      if (kind === 'project-settings') {
        if (project) await projectSaver.flush(project.id);
      } else if (kind === 'create-project') {
        const created = dialogRequest.createdProjectId
          ? projects.find((item) => item.id === dialogRequest.createdProjectId)
          : await window.gigaChat.projects.create(dialogValue, dialogFolder);
        if (!created) throw new Error('Созданный проект не найден.');
        if (!dialogRequest.createdProjectId) {
          setProjects((current) => [created, ...current]);
          setDialogRequest((current) => current?.kind === 'create-project' ? { ...current, createdProjectId: created.id } : current);
        }
        if (dialogRequest.assignChatId) {
          const updated = await window.gigaChat.chats.update(dialogRequest.assignChatId, { projectId: created.id }).catch((error: unknown) => {
            throw new Error(`Проект создан, но чат не перемещён: ${getErrorMessage(error)}`);
          });
          setChats((current) => current.map((item) => item.id === updated.id ? updated : item));
          setChatDetail((current) => current?.id === updated.id ? { ...current, projectId: created.id } : current);
        } else setSelectedProjectId(created.id);
        showSuccess(`Проект «${created.name}» создан.`);
      } else if (kind === 'rename-project' && project) {
        const updated = (await window.gigaChat.projects.update(project.id, { name: dialogValue })).project;
        setProjects((current) => current.map((item) => item.id === project.id ? updated : item));
        showSuccess('Название проекта сохранено.');
      } else if (kind === 'delete-project' && project) {
        await window.gigaChat.projects.remove(project.id);
        setProjects((current) => current.filter((item) => item.id !== project.id));
        setChats((current) => current.map((item) => item.projectId === project.id ? { ...item, projectId: null } : item));
        showSuccess('Проект удалён. Его чаты сохранены.');
      } else if (kind === 'rename-chat' && chat) {
        const updated = await window.gigaChat.chats.update(chat.id, { title: dialogValue });
        setChats((current) => current.map((item) => item.id === chat.id ? updated : item));
        setChatDetail((current) => current?.id === chat.id ? { ...current, title: updated.title } : current);
        showSuccess('Название чата сохранено.');
      } else if (kind === 'delete-chat' && chat) {
        await window.gigaChat.chats.remove(chat.id);
        setChats((current) => current.filter((item) => item.id !== chat.id));
        if (routeRef.current.page === 'chat' && routeRef.current.id === chat.id) navigate({ page: 'home' });
        showSuccess('Чат удалён.');
      }
      setDialogRequest(null);
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setDialogError(getErrorMessage(error));
    } finally {
      setDialogBusy(false);
    }
  }

  async function changeChatProject(chat: ChatSummary, projectId: string): Promise<void> {
    const nextProjectId = projectId || null;
    const skillId = chatDetail?.id === chat.id ? chatDetail.nextTurnSkillId : null;
    const projectSkill = skillId ? /^project\/([^/]+)\//.exec(skillId) : null;
    await updateChat(chat, {
      projectId: nextProjectId,
      ...(projectSkill && projectSkill[1] !== nextProjectId ? { nextTurnSkillId: null } : {}),
    });
  }

  async function changeComposerModel(modelId: GigaChatModelId): Promise<void> {
    if (route.page === 'chat' && selectedChat) await updateChat(selectedChat, { modelId });
    else await updateLocalSettings({ defaultModelId: modelId });
  }

  function saveCustomConfig(): Promise<void> {
    return trackRendererOperation(() => saveCustomConfigOperation());
  }

  async function saveCustomConfigOperation(): Promise<void> {
    if (closeUiState.current.configBusy || !configReady) return;
    closeUiState.current.configBusy = true;
    setConfigBusy(true);
    setConfigError('');
    try {
      const saved = await window.gigaChat.permissions.saveConfig(closeUiState.current.configDraft, closeUiState.current.configSaved);
      closeUiState.current.configSaved = saved;
      setConfigSaved(saved);
      showSuccess('Пользовательские разрешения сохранены.');
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setConfigError(getErrorMessage(error));
    }
    finally {
      closeUiState.current.configBusy = false;
      setConfigBusy(false);
    }
  }

  function reloadCustomConfig(): Promise<void> {
    return trackRendererOperation(loadCustomConfig);
  }

  async function loadCustomConfig(): Promise<void> {
    if (closeUiState.current.configBusy) return;
    const revision = configEditRevision.current;
    closeUiState.current.configBusy = true;
    setConfigLoading(true);
    try {
      const { contents, error } = await window.gigaChat.permissions.readConfig();
      if (revision !== configEditRevision.current) return;
      closeUiState.current.configDraft = contents;
      closeUiState.current.configSaved = contents;
      setConfigDraft(contents);
      setConfigSaved(contents);
      setConfigError(error ?? '');
      setConfigReady(true);
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setConfigError(getErrorMessage(error));
    } finally {
      closeUiState.current.configBusy = false;
      setConfigLoading(false);
    }
  }

  async function answerApproval(allowed: boolean): Promise<void> {
    const request = approvalRequest;
    if (!request) return;
    setApprovalRequest(null);
    try { await window.gigaChat.permissions.respond(request.id, allowed); }
    catch (error) { setNotice(getErrorMessage(error)); }
  }

  function updateLocalSettings(patch: SettingsPatch): Promise<void> {
    return trackRendererOperation(() => updateLocalSettingsOperation(patch));
  }

  async function updateLocalSettingsOperation(patch: SettingsPatch): Promise<void> {
    const revision = ++settingsRevision.current;
    const optimisticSettings = { ...settingsRef.current, ...patch };
    settingsRef.current = optimisticSettings;
    setSettings(optimisticSettings);
    try {
      const updated = await window.gigaChat.settings.update(patch);
      if (revision === settingsRevision.current) {
        settingsRef.current = updated;
        setSettings(updated);
      }
    } catch (error) {
      rendererOperations.current.reportFailure(error);
      setNotice(getErrorMessage(error));
      if (revision === settingsRevision.current) {
        try {
          const latest = await window.gigaChat.settings.get();
          settingsRef.current = latest;
          setSettings(latest);
        }
        catch (readError) { setNotice(getErrorMessage(readError)); }
      }
    }
  }

  function updateNotificationSetting(category: keyof NotificationSettings, enabled: boolean): void {
    void updateLocalSettings({ notifications: { ...settingsRef.current.notifications, [category]: enabled } });
  }

  function finishOnboarding(): Promise<void> {
    return trackRendererOperation(() => finishOnboardingOperation());
  }

  async function finishOnboardingOperation(): Promise<void> {
    const updated = await window.gigaChat.settings.update({ onboardingCompleted: true });
    setSettings(updated);
    navigate({ page: 'home' });
  }

  async function saveSkillSelectionForChat(chatId: string, skillId: string | null, revision: number): Promise<void> {
    const routeRevision = routeGeneration.current;
    const detailGeneration = chatDetailLoadGeneration.current;
    const save = skillSelectionSave.current.catch(() => undefined).then(() =>
      window.gigaChat.chats.update(chatId, { nextTurnSkillId: skillId }),
    );
    skillSelectionSave.current = save;
    try {
      await save;
      if (revision !== skillSelectionRevision.current) return;
      if (routeRevision === routeGeneration.current && detailGeneration === chatDetailLoadGeneration.current
        && routeRef.current.page === 'chat' && routeRef.current.id === chatId) {
        setChatDetail((current) => current?.id === chatId ? { ...current, nextTurnSkillId: skillId } : current);
      }
      if (pendingSkillChatIdRef.current === chatId) {
        pendingSkillIdRef.current = null;
        pendingSkillChatIdRef.current = null;
        setPendingSkillId(null);
      }
    } catch (error) {
      if (revision !== skillSelectionRevision.current) return;
      try {
        const latest = await window.gigaChat.chats.get(chatId);
        if (revision === skillSelectionRevision.current && routeRevision === routeGeneration.current
          && detailGeneration === chatDetailLoadGeneration.current
          && routeRef.current.page === 'chat' && routeRef.current.id === chatId) {
          setChatDetail((current) => current?.id === chatId ? latest : current);
        }
      } catch (readError) {
        setNotice(getErrorMessage(readError));
      }
      setNotice(getErrorMessage(error));
    }
  }

  async function changeComposerSkill(skillId: string | null): Promise<void> {
    const skill = skillId ? skillRegistry.skills.find((item) => item.id === skillId) : null;
    if (skillId && (!skill || !skill.enabled)) {
      setNotice('Skill удалён или выключен; обновите список и выберите доступный Skill.');
      return;
    }
    if (skill && skill.scope === 'project' && skill.projectId !== composerProjectId) {
      setNotice('Выберите Skill из Global или текущего проекта.');
      return;
    }
    const revision = ++skillSelectionRevision.current;
    pendingSkillIdRef.current = skillId;
    setPendingSkillId(skillId);
    if (route.page === 'home' && !selectedChat) {
      pendingSkillChatIdRef.current = null;
      const session = homeDraftSession.current;
      if (session) {
        session.skillId = skillId;
        if (session.chatId && !session.creation) void startHomeDraftSession(session).catch(() => undefined);
        return;
      }
      const chatId = homeChatId.current ?? (await pendingChat.current)?.id ?? null;
      if (chatId) {
        pendingSkillChatIdRef.current = chatId;
        await saveSkillSelectionForChat(chatId, skillId, revision);
      }
      return;
    }
    if (!selectedChat) return;
    pendingSkillChatIdRef.current = selectedChat.id;
    setChatDetail((current) => current?.id === selectedChat.id ? { ...current, nextTurnSkillId: skillId } : current);
    await saveSkillSelectionForChat(selectedChat.id, skillId, revision);
  }

  async function refreshSkillRegistry(): Promise<void> {
    try { setSkillRegistry(await window.gigaChat.skills.list()); }
    catch (error) { setNotice(getErrorMessage(error)); }
  }

  function setSkillEnabled(skill: SkillRecord, enabled: boolean): Promise<void> {
    return trackRendererOperation(() => setSkillEnabledOperation(skill, enabled));
  }

  async function setSkillEnabledOperation(skill: SkillRecord, enabled: boolean): Promise<void> {
    setSkillBusyId(skill.id);
    try { setSkillRegistry(await window.gigaChat.skills.setEnabled(skill.id, enabled)); }
    catch (error) { rendererOperations.current.reportFailure(error); setNotice(getErrorMessage(error)); }
    finally { setSkillBusyId(null); }
  }

  async function inspectSkill(skill: SkillRecord): Promise<void> {
    if (skillSource?.id === skill.id) {
      setSkillSource(null);
      return;
    }
    setSkillSourceLoading(skill.id);
    try { setSkillSource(await window.gigaChat.skills.readSource(skill.id)); }
    catch (error) { setNotice(getErrorMessage(error)); }
    finally { setSkillSourceLoading(null); }
  }

  async function openSkillFolder(scope: SkillScope, projectId?: string | null): Promise<void> {
    try { await window.gigaChat.skills.openFolder(scope, projectId); }
    catch (error) { setNotice(getErrorMessage(error)); }
  }

  async function changeComposerPermissionProfile(profile: PermissionProfile): Promise<void> {
    if (!selectedChat || !chatDetail || chatDetail.id !== selectedChat.id) {
      if (route.page === 'home' && !selectedChat) {
        permissionProfileRevision.current += 1;
        pendingPermissionProfileRef.current = profile;
        pendingPermissionChatIdRef.current = null;
        setPendingPermissionProfile(profile);
        const session = homeDraftSession.current;
        if (session) {
          session.permissionProfile = profile;
          if (session.chatId && !session.creation) void startHomeDraftSession(session).catch(() => undefined);
        }
      }
      return;
    }

    const next = profile === settings.defaultPermissionProfile ? null : profile;
    const revision = ++permissionProfileRevision.current;
    const routeRevision = routeGeneration.current;
    const detailGeneration = chatDetailLoadGeneration.current;
    pendingPermissionProfileRef.current = profile;
    pendingPermissionChatIdRef.current = selectedChat.id;
    setPendingPermissionProfile(profile);
    setChatDetail((current) => current?.id === selectedChat.id ? { ...current, nextTurnPermissionProfile: next } : current);
    const save = savePermissionProfileForChat(selectedChat.id, profile);
    try {
      await save;
      if (revision === permissionProfileRevision.current && pendingPermissionChatIdRef.current === selectedChat.id) {
        pendingPermissionProfileRef.current = null;
        pendingPermissionChatIdRef.current = null;
        setPendingPermissionProfile(null);
      }
    } catch (error) {
      if (revision === permissionProfileRevision.current) {
        try {
          const latest = await window.gigaChat.chats.get(selectedChat.id);
          if (revision === permissionProfileRevision.current && routeRevision === routeGeneration.current
            && detailGeneration === chatDetailLoadGeneration.current
            && routeRef.current.page === 'chat' && routeRef.current.id === selectedChat.id) {
            setChatDetail((current) => current?.id === selectedChat.id
              ? { ...current, nextTurnPermissionProfile: latest.nextTurnPermissionProfile } : current);
            if (pendingPermissionChatIdRef.current === selectedChat.id
              && pendingPermissionProfileRef.current === profile) {
              pendingPermissionProfileRef.current = null;
              pendingPermissionChatIdRef.current = null;
              setPendingPermissionProfile(null);
            }
          }
        } catch (readError) {
          setNotice(getErrorMessage(readError));
        }
        setNotice(getErrorMessage(error));
      }
    }
  }

  async function toggleSidebar(): Promise<void> {
    const next = !settings.sidebarVisible;
    closePreview();
    await updateLocalSettings({ sidebarVisible: next });
  }

  function projectMenu(project: Project): ReactNode {
    return (
      <ActionMenu label={`Действия проекта ${project.name}`} onVisibilityChange={trackNativeOverlay}>
        <button type="button" onClick={() => renameProject(project)}><Icon name="edit" />Переименовать</button>
        <button type="button" onClick={() => void updateProject(project, { pinned: !project.pinned })}>
          <Icon name="pin" />{project.pinned ? 'Открепить' : 'Закрепить'}
        </button>
        {!project.archived && <button type="button" onClick={() => void createChat(project.id)}><Icon name="plus" />Новый чат в проекте</button>}
        <button type="button" onClick={() => void openProjectSettings(project)}><Icon name="folderOpen" />Настройки проекта</button>
        {project.workingFolder && <button type="button" onClick={() => void window.gigaChat.projects.openFolder(project.id).catch((error: unknown) => setNotice(getErrorMessage(error)))}><Icon name="external" />Открыть папку</button>}
        <button type="button" onClick={() => void updateProject(project, { archived: !project.archived })}>
          <Icon name="archive" />{project.archived ? 'Восстановить из архива' : 'Архивировать'}
        </button>
        <button type="button" className="danger-item" onClick={() => removeProject(project)}><Icon name="trash" />Удалить</button>
      </ActionMenu>
    );
  }

  function chatMenu(chat: ChatSummary): ReactNode {
    return (
      <ActionMenu label={`Действия чата ${chat.title}`} onVisibilityChange={trackNativeOverlay}>
        <button type="button" onClick={() => renameChat(chat)}><Icon name="edit" />Переименовать</button>
        <button type="button" onClick={() => void updateChat(chat, { pinned: !chat.pinned })}>
          <Icon name="pin" />{chat.pinned ? 'Открепить' : 'Закрепить'}
        </button>
        <ProjectSubmenu chat={chat} projects={activeProjects} onSelect={(projectId) => void changeChatProject(chat, projectId)} onVisibilityChange={trackNativeOverlay} />
        <button type="button" onClick={() => void updateChat(chat, { archived: !chat.archived })}>
          <Icon name="archive" />{chat.archived ? 'Восстановить из архива' : 'Архивировать'}
        </button>
        <button type="button" className="danger-item" onClick={() => void removeChat(chat)}><Icon name="trash" />Удалить</button>
      </ActionMenu>
    );
  }

  function chatRow(chat: ChatSummary, nested = false): ReactNode {
    return <div className={`list-row${nested ? ' nested-chat-row' : ''}${route.page === 'chat' && route.id === chat.id ? ' selected' : ''}`} key={chat.id}>
      <button type="button" className="list-row-main" onClick={() => navigate({ page: 'chat', id: chat.id })}><Icon name="chat" /><ScrollingRowTitle value={chat.title} pinned={chat.pinned} /></button>
      {chat.pinned && <Icon name="pin" className="pin-mark" />}{chatMenu(chat)}
    </div>;
  }

  function projectRow(project: Project): ReactNode {
    const expanded = expandedProjects.has(project.id);
    return <div className="project-tree" key={project.id}>
      <div className="list-row">
        <button type="button" className="list-row-main" aria-expanded={expanded} aria-controls={expanded ? `project-chats-${project.id}` : undefined} onClick={() => setExpandedProjects((current) => {
          const next = new Set(current);
          if (next.has(project.id)) next.delete(project.id);
          else next.add(project.id);
          return next;
        })}><Icon name={expanded ? 'folderOpen' : 'folder'} /><ScrollingRowTitle value={project.name} pinned={project.pinned} /></button>
        {project.pinned && <Icon name="pin" className="pin-mark" />}{projectMenu(project)}
      </div>
      {expanded && <div id={`project-chats-${project.id}`} className="project-nested-chats">
        {library.projectChats(project.id).map((chat) => chatRow(chat, true))}
      </div>}
    </div>;
  }

  function renderArchive(): ReactNode {
    return (
      <section className={route.page === 'settings' ? 'content-page archive-page settings-archive' : 'content-page archive-page'}>
        <div className="page-heading">{route.page !== 'settings' && <><span className="eyebrow">Локальные данные</span><h1>Архив</h1></>}<p>Чаты и проекты, которые вы убрали из списка.</p></div>
        {archivedProjects.length === 0 && archivedChats.length === 0
          ? <EmptyState title="В архиве пока пусто" description="Архивированные чаты и проекты появятся здесь." icon="archive" />
          : <div className="archive-list">
              {archivedProjects.map((project) => (
                <article className="archive-row" key={project.id}>
                  <Icon name="folder" /><span className="archive-row-name">{project.name}<small>Проект</small></span>
                  <button type="button" className="quiet-button" onClick={() => void updateProject(project, { archived: false })}>Восстановить</button>
                  {projectMenu(project)}
                </article>
              ))}
              {archivedChats.map((chat) => (
                <article className="archive-row" key={chat.id}>
                  <Icon name="chat" /><span className="archive-row-name">{chat.title}<small>{chat.kind === 'image' ? 'Чат изображений' : 'Чат'}</small></span>
                  <button type="button" className="quiet-button" onClick={() => void updateChat(chat, { archived: false })}>Восстановить</button>
                  {chatMenu(chat)}
                </article>
              ))}
            </div>}
      </section>
    );
  }

  function renderSettingsSection(): ReactNode {
    switch (settingsSection) {
      case 'general':
        return (
          <>
            <div className="settings-section-heading"><h2>Общие</h2><p>Язык, папка проектов и запуск приложения.</p></div>
            <div className="settings-card settings-list">
              <SettingRow title="Язык интерфейса" description="Сейчас приложение доступно на русском языке.">
                <span className="value-chip">Русский</span>
              </SettingRow>
              <SettingRow title="Дополнительная папка для открытия" description={`${settings.defaultProjectsFolder ?? 'Папка не выбрана.'} Автопапки проектов создаются в «Документы\\GigaChat Agent\\Projects» и не зависят от этой настройки.`}>
                <div className="inline-actions">
                  <button type="button" className="secondary-button" onClick={async () => {
                    try {
                      const updated = await trackRendererOperation(() => window.gigaChat.settings.chooseProjectsFolder());
                      setSettings((current) => ({ ...current, defaultProjectsFolder: updated.defaultProjectsFolder }));
                    } catch (error) { rendererOperations.current.reportFailure(error); setNotice(getErrorMessage(error)); }
                  }}>Выбрать папку</button>
                  <button type="button" className="icon-button" disabled={!settings.defaultProjectsFolder} aria-label="Открыть папку проектов" title="Открыть папку" onClick={() => void window.gigaChat.settings.openProjectsFolder().catch((error: unknown) => setNotice(getErrorMessage(error)))}><Icon name="external" /></button>
                </div>
              </SettingRow>
              <SettingRow title="Запускать вместе с Windows" description={appInfo?.autoStartMigrationIssue ?? (!appInfo ? 'Проверяем установленную версию приложения.' : appInfo.platform !== 'win32' ? 'Доступно только в Windows.' : appInfo.installedLauncherAvailable ? 'Путь запуска сохраняется при обновлении приложения.' : 'Недоступно в переносной версии приложения.')}>
                <label className="switch-control"><input type="checkbox" checked={autoStart} disabled={!appInfo?.installedLauncherAvailable || appInfo.platform !== 'win32'} onChange={(event) => {
                  setAutoStart(event.target.checked);
                  void trackRendererOperation(async () => {
                    try {
                      setAutoStart(await window.gigaChat.settings.setAutoStart(event.target.checked));
                      setAppInfo(await window.gigaChat.settings.getAppInfo());
                    }
                    catch (error: unknown) {
                      rendererOperations.current.reportFailure(error);
                      setNotice(getErrorMessage(error));
                      try { setAutoStart(await window.gigaChat.settings.getAutoStart()); }
                      catch (readError) { setNotice(getErrorMessage(readError)); }
                    }
                  });
                }} /><span /></label>
              </SettingRow>
              <SettingRow title="Открывать папки в" description="Изменение применяется к папкам проектов и к папке по умолчанию.">
                <ChoiceMenu label="Открывать папки в" value={settings.preferredOpener} options={[
                  { value: 'system', label: 'По умолчанию (Windows)' },
                  { value: 'explorer', label: 'Проводник Windows' },
                  ...(openers.some((opener) => opener.id === 'vscode') ? [{ value: 'detected-app', label: 'Visual Studio Code' }] : []),
                  ...(settings.preferredOpener === 'detected-app' && !openers.some((opener) => opener.id === 'vscode') ? [{ value: 'detected-app', label: 'Приложение не найдено', disabled: true }] : []),
                ]} onChange={(value) => { void updateLocalSettings({ preferredOpener: value as Settings['preferredOpener'] }); }} onVisibilityChange={trackNativeOverlay} />
              </SettingRow>
            </div>
          </>
        );
      case 'appearance':
        return (
          <>
            <div className="settings-section-heading"><h2>Оформление</h2><p>Выбранная тема и прозрачность сохраняются сразу.</p></div>
            <section className="appearance-card">
              <div className="setting-subheading"><div><h3>Тема</h3><p>Выберите палитру приложения.</p></div></div>
              <div className="theme-options">
                {(['emerald', 'dark', 'light', 'warm'] as const).map((theme) => (
                    <button key={theme} type="button" className={settings.theme === theme ? 'theme-option selected' : 'theme-option'} aria-pressed={settings.theme === theme} onClick={() => void updateLocalSettings({ theme })}>
                    <ThemePreview theme={theme} transparent={settings.sidebarTransparent} /><span>{themeLabel(theme)}</span>
                  </button>
                ))}
              </div>
              <button type="button" className={settings.theme === 'system' ? 'system-theme selected' : 'system-theme'} aria-pressed={settings.theme === 'system'} onClick={() => void updateLocalSettings({ theme: 'system' })}>
                <Icon name="system" /><span><strong>Как в Windows</strong><small>Автоматически следовать системной теме.</small></span>
                {settings.theme === 'system' && <Icon name="check" className="selected-check" />}
              </button>
              <SettingRow title="Прозрачная боковая панель" description="Показывает фон главного окна сквозь поверхность навигации.">
                <label className="switch-control"><input type="checkbox" checked={settings.sidebarTransparent} onChange={(event) => void updateLocalSettings({ sidebarTransparent: event.target.checked })} /><span /></label>
              </SettingRow>
            </section>
          </>
        );
      case 'models':
        return (
          <>
            <div className="settings-section-heading"><h2>Модели и лимиты</h2><p>Выбор модели сохранится для следующих ходов. Доступность проверим после подключения API.</p></div>
            <div className="settings-card connection-card"><div><strong>GigaChat API</strong><p>Провайдер не подключён. Список моделей и их доступность пока не загружены.</p></div><span className="status-pill"><i />Не подключён</span></div>
            <div className="model-settings-list">
              {GIGACHAT_MODELS.map((model) => <button type="button" key={model.id}
                className={`permission-profile permission-profile-selectable${settings.defaultModelId === model.id ? ' selected' : ''}`}
                aria-pressed={settings.defaultModelId === model.id} onClick={() => void updateLocalSettings({ defaultModelId: model.id })}>
                <span className="permission-profile-copy"><strong>{model.name}</strong><span>{model.description} · Доступ не проверен</span></span>
                <span className="status-label">{settings.defaultModelId === model.id ? 'По умолчанию' : 'Выбрать'}</span>
              </button>)}
              {settings.defaultModelId && <button type="button" className="quiet-button model-clear-button" onClick={() => void updateLocalSettings({ defaultModelId: null })}>Снять выбор модели по умолчанию</button>}
            </div>
            <EmptyState title="Лимиты пока неизвестны" description="Подтверждённые данные о лимитах появятся после подключения API." icon="gauge" />
          </>
        );
      case 'permissions':
        return (
          <>
            <div className="settings-section-heading"><h2>Разрешения</h2><p>Профиль хранится локально. Локальные действия проверяются перед выполнением; запросы к модели пока не отправляются.</p></div>
            <div className="permission-profile-list">
              {AVAILABLE_PERMISSION_PROFILES.map((profile) => {
                const selected = settings.defaultPermissionProfile === profile.id;
                return (
                  <button
                    type="button"
                    className={`permission-profile permission-profile-selectable${selected ? ' selected' : ''}`}
                    key={profile.id}
                    aria-pressed={selected}
                    onClick={() => void updateLocalSettings({ defaultPermissionProfile: profile.id })}
                  >
                    <Icon name="shield" />
                    <span className="permission-profile-copy"><strong>{profile.name}</strong><span>{profile.description}</span></span>
                    <span className="status-label">{selected ? 'По умолчанию' : 'Выбрать'}</span>
                  </button>
                );
              })}
            </div>
            <section className="settings-card custom-config-card">
              <div className="setting-subheading"><div><h3>Пользовательский профиль</h3><p>Правила для доступных локальных инструментов. Дополнительные каталоги указываются абсолютными путями.</p></div></div>
              <p className="config-path path-value">{appInfo?.dataPath ? `${appInfo.dataPath}\\config.toml` : 'config.toml в каталоге данных приложения'}</p>
              <textarea className="config-editor" aria-label="Редактор config.toml" spellCheck={false} value={configDraft} disabled={configLoading || !configReady}
                onChange={(event) => { configEditRevision.current += 1; closeUiState.current.configDraft = event.target.value; setConfigDraft(event.target.value); setConfigError(''); }} />
              <div className="config-actions">
                <span className="config-status" role="status">{configLoading ? 'Чтение…' : configError || (!configReady ? 'Ожидание загрузки' : configDraft === configSaved ? 'Сохранено' : 'Есть несохранённые изменения')}</span>
                <button type="button" className="quiet-button" disabled={configBusy || configLoading} onClick={() => void reloadCustomConfig()}>Обновить с диска</button>
                <button type="button" className="primary-button" disabled={configBusy || configLoading || !configReady || configDraft === configSaved} onClick={() => void saveCustomConfig()}>{configBusy ? 'Сохранение…' : 'Сохранить'}</button>
              </div>
            </section>
          </>
        );
      case 'personalization':
        return (
          <>
            <div className="settings-section-heading"><h2>Персонализация</h2><p>Локальная инструкция хранится в данных приложения и не записывается в рабочую папку.</p></div>
            <section className="settings-card instruction-card">
              <div className="setting-subheading"><div><h3>GIGACHAT.md</h3><p>Применение к ответам заработает после подключения harness и API.</p></div><span className="value-chip">Локальный файл</span></div>
              <SettingRow title="Путь к инструкции" description="Файл хранится в каталоге данных приложения.">
                <span className="path-value" title={appInfo?.dataPath ? `${appInfo.dataPath}\\GIGACHAT.md` : undefined}>
                  {appInfo?.dataPath ? `${appInfo.dataPath}\\GIGACHAT.md` : 'Загрузка…'}
                </span>
              </SettingRow>
              <textarea className="instructions-editor" value={globalInstructions} disabled={globalInstructionsLoading || !globalInstructionsReady} onChange={(event) => {
                setGlobalInstructions(event.target.value);
                globalSaver.edit('global', event.target.value);
              }} onBlur={() => {
                if (globalInstructionsConflict) return;
                void globalSaver.flush('global').catch((error: unknown) => setNotice(getErrorMessage(error)));
              }} placeholder={globalInstructionsLoading ? 'Чтение GIGACHAT.md…' : 'Добавьте общие инструкции для будущих задач…'} maxLength={65536} aria-label="Глобальная инструкция GIGACHAT.md" />
              <div className="editor-footer"><span>До 64 КБ · сохраняется в каталоге приложения</span><span role="status" className={`save-status status-${globalInstructionsStatus}`}>{globalInstructionsLoading ? 'Чтение…' : globalInstructionsReady ? saveStatusLabel(globalInstructionsStatus) : 'Ожидание загрузки'}</span></div>
              {globalInstructionsLoadError && <div className="project-folder-choice" role="alert">
                <strong>Не удалось прочитать GIGACHAT.md</strong><p>{globalInstructionsLoadError} Редактор останется заблокирован, пока файл не будет прочитан.</p>
                <button type="button" className="secondary-button" disabled={globalInstructionsLoading} onClick={() => setGlobalInstructionRetry((value) => value + 1)}>Повторить чтение</button>
              </div>}
              {globalInstructionsConflict && <div className="project-folder-choice" role="alert">
                <strong>{globalInstructionsConflict.phase === 'after-commit' ? 'Найдены две версии инструкции' : 'Файл изменился вне приложения'}</strong>
                <p>Ваш текст остался в редакторе. Перечитайте текущую версию или сохраните свой текст отдельной копией.</p>
                {globalInstructionsConflict.phase === 'before-commit' && <details>
                  <summary>Показать версию на диске</summary>
                  <pre className="approval-target">{globalInstructionsConflict.current.text || 'Файл отсутствует или пуст.'}</pre>
                </details>}
                <div className="inline-actions">
                  <button type="button" className="secondary-button" disabled={globalInstructionsLoading} onClick={() => void reloadGlobalInstructions()}>Перечитать файл</button>
                  <button type="button" className="secondary-button" disabled={globalInstructionsLoading} onClick={() => void saveGlobalInstructionsCopy()}>Сохранить черновик отдельно</button>
                </div>
              </div>}
              {globalPreservedInstruction && <div className="project-backup-note" role="status">
                <strong>Вытесненная версия сохранена</strong>
                <span>{globalPreservedInstruction.path}</span>
                {globalPreservedInstruction.text === null
                  ? <p>Содержимое пока нельзя безопасно прочитать; файл и журнал сохранены.</p>
                  : <details><summary>Показать сохранённый текст</summary><pre className="approval-target">{globalPreservedInstruction.text || 'Файл пуст.'}</pre></details>}
              </div>}
            </section>
            <EmptyState title="Долгосрочная память пока недоступна" description="Её управление появится вместе с подключением API." icon="book" />
          </>
        );
      case 'integrations': {
        const skillProjects = projects.filter((project) => !project.archived);
        return (
          <>
            <div className="settings-section-heading"><h2>Skills и интеграции</h2><p>Локальные Skills доступны только после ручного выбора через `$`. Их инструкции подключатся к ходу после API; scripts/assets не запускаются.</p></div>
            <div className="settings-tabs" role="tablist" aria-label="Интеграции">
              {([['skills', 'Skills'], ['plugins', 'Plugins / MCP'], ['tools', 'Tools']] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={integrationTab === id} className={integrationTab === id ? 'active' : ''} onClick={() => setIntegrationTab(id)}>{label}</button>
              ))}
            </div>
            {integrationTab === 'skills' ? <>
              <section className="settings-card skill-locations">
                <div className="setting-row">
                  <div className="setting-row-copy"><strong>Global Skills</strong><p>Папка приложения · <code>global/&lt;имя&gt;/SKILL.md</code></p></div>
                  <button type="button" className="secondary-button" onClick={() => void openSkillFolder('global')}>Открыть папку</button>
                </div>
                <div className="setting-row">
                  <div className="setting-row-copy"><strong>Project Skills</strong><p>Отдельная папка для каждого проекта.</p></div>
                  <div className="inline-actions">
                    <ChoiceMenu label="Проект для локальных Skills" value={skillProjectId} options={[
                      { value: '', label: 'Выберите проект' },
                      ...skillProjects.map((project) => ({ value: project.id, label: project.name })),
                    ]} onChange={setSkillProjectId} onVisibilityChange={trackNativeOverlay} />
                    <button type="button" className="secondary-button" disabled={!skillProjectId} onClick={() => void openSkillFolder('project', skillProjectId)}>Открыть</button>
                  </div>
                </div>
                <div className="skill-registry-actions"><span>В начале <code>SKILL.md</code> читаются поля <code>name</code> и <code>description</code>.</span><button type="button" className="quiet-button" onClick={() => void refreshSkillRegistry()}>Обновить список</button></div>
              </section>
              {skillRegistry.skills.length === 0
                ? <EmptyState title="SKILL.md не найдены" description="Добавьте папку Skill с SKILL.md в Global или выбранный Project каталог приложения. Skills Codex автоматически не импортируются." icon="puzzle" />
                : <div className="skill-list">{skillRegistry.skills.map((skill) => <article className="settings-card skill-card" key={skill.id}>
                    <div className="skill-card-heading"><div className="skill-card-copy"><h3>{skill.name}</h3><p>{skill.description}</p><small>{skill.scope === 'global' ? 'Global' : `Project · ${skill.projectName ?? 'неизвестный проект'}`} · <code>{skill.source}</code></small></div><span className={`status-label${skill.enabled ? ' status-enabled' : ''}`}>{skill.enabled ? 'Доступен в $' : 'Выключен'}</span></div>
                    <div className="skill-card-actions">
                      <button type="button" className="quiet-button" disabled={skillSourceLoading === skill.id} onClick={() => void inspectSkill(skill)}>{skillSourceLoading === skill.id ? 'Чтение…' : skillSource?.id === skill.id ? 'Скрыть источник' : 'Просмотреть SKILL.md'}</button>
                      <label className="skill-enabled-toggle"><span>Разрешить ручной выбор</span><span className="switch-control"><input type="checkbox" aria-label={`${skill.enabled ? 'Выключить' : 'Включить'} Skill ${skill.name} для ручного выбора`} checked={skill.enabled} disabled={skillBusyId === skill.id} onChange={(event) => void setSkillEnabled(skill, event.target.checked)} /><span /></span></label>
                    </div>
                    {skillSource?.id === skill.id && <details className="skill-source" open><summary>Источник · {skillSource.source}</summary><pre>{skillSource.contents}</pre></details>}
                  </article>)}</div>}
              {skillRegistry.issues.map((issue) => <p className="registry-issue" role="status" key={`${issue.source}:${issue.reason}`}>{issue.source}: {issue.reason}</p>)}
            </> : <EmptyState title={integrationTab === 'plugins' ? 'Plugins / MCP не подключены' : 'Инструменты не настроены'} description={integrationTab === 'plugins' ? 'Реестр Plugins/MCP и их разрешения пока не подключены.' : 'Дополнительные интеграции появятся после отдельной проверки runtime и разрешений.'} icon="puzzle" />}
          </>
        );
      }
      case 'hooks':
        return (
          <>
            <div className="settings-section-heading"><h2>Hooks</h2><p>Реестр показывает только обнаруженные hook.json. Произвольные действия не запускаются и остаются выключенными до проверки источника и разрешения.</p></div>
            {hookRegistry.hooks.length === 0
              ? <EmptyState title="Hook-записи не обнаружены" description="Реальные Global / Project / Skill / Plugin записи будут показаны здесь; события без настроенной записи не выдаются за установленный Hook." icon="plug" />
              : <div className="settings-card settings-list">{hookRegistry.hooks.map((hook) => (
                <div className="setting-row" key={hook.id}>
                  <div className="setting-row-copy">
                    <strong>{hook.name}</strong>
                    <p>{hook.description}</p>
                    <small className="hook-record-location">{hookEventLabel(hook.event)} · {hook.scope} · {hook.source} · {hook.actionFile}</small>
                  </div>
                  <div className="setting-row-control"><span className="status-label">Исполнение выключено</span></div>
                </div>
              ))}</div>}
            {hookRegistry.issues.map((issue) => <p className="registry-issue" role="status" key={`${issue.source}:${issue.reason}`}>{issue.source}: {issue.reason}</p>)}
          </>
        );
      case 'browser':
        return <ConnectionSetup firstRun={false} suspended={sidebarPreview || nativeOverlayOpen || Boolean(dialogRequest) || Boolean(approvalRequest) || closePending || Boolean(closeFailure)} runAcceptedOperation={trackRendererOperation}
          reportOperationFailure={(error) => rendererOperations.current.reportFailure(error)}
          onKeySaveFailureChange={(failed) => { connectionKeySaveFailed.current = failed; }} />;
      case 'voice':
        return (
          <>
            <div className="settings-section-heading"><h2>Голос</h2><p>Диктовка работает локально. Запись начинается после нажатия на микрофон, а распознанный текст добавляется в черновик без отправки.</p></div>
            <div className="settings-card settings-list">
              <SettingRow title="Диктовка" description={voiceAvailability.available ? 'Разрешение микрофона запрашивается только при нажатии на кнопку записи.' : voiceAvailability.reason ?? 'Локальный runtime недоступен.'}><span className={`status-label${voiceAvailability.available ? ' status-enabled' : ''}`}>{voiceAvailability.available ? 'Доступна офлайн' : 'Недоступна'}</span></SettingRow>
              <SettingRow title="GigaAM v3" description="Распознавание речи выполняется на этом компьютере."><span className={`status-label${voiceAvailability.available ? ' status-enabled' : ''}`}>{voiceAvailability.available ? 'Локально' : 'Не загружена'}</span></SettingRow>
              <SettingRow title="Синтез речи" description="Голосовой ответ — FUTURE."><span className="status-label">Позже</span></SettingRow>
            </div>
          </>
        );
      case 'notifications':
        return (
          <>
            <div className="settings-section-heading"><h2>Уведомления</h2><p>Windows показывает уведомления только для реальных событий, когда окно приложения не в фокусе. Запуск очереди и ответ модели появятся после подключения провайдера.</p></div>
            <div className="settings-card settings-list">
              <SettingRow title="Ответ готов" description="Появится после подключения API и завершения настоящего ответа.">
                <label className="notification-toggle"><input type="checkbox" checked={settings.notifications.taskCompleted} onChange={(event) => updateNotificationSetting('taskCompleted', event.target.checked)} /><span>{settings.notifications.taskCompleted ? 'Включено' : 'Выключено'}</span></label>
              </SettingRow>
              <SettingRow title="Начался следующий ход" description="Появится после подключения очереди провайдера.">
                <label className="notification-toggle"><input type="checkbox" checked={settings.notifications.taskStarted} onChange={(event) => updateNotificationSetting('taskStarted', event.target.checked)} /><span>{settings.notifications.taskStarted ? 'Включено' : 'Выключено'}</span></label>
              </SettingRow>
              <SettingRow title="Ошибка локальной операции" description="Ошибка сохранения, импорта или локального инструмента; без текста данных и только когда окно не в фокусе.">
                <label className="notification-toggle"><input type="checkbox" checked={settings.notifications.failures} onChange={(event) => updateNotificationSetting('failures', event.target.checked)} /><span>{settings.notifications.failures ? 'Включено' : 'Выключено'}</span></label>
              </SettingRow>
            </div>
          </>
        );
      case 'files':
        return (
          <>
            <div className="settings-section-heading"><h2>Проекты и файлы</h2><p>Папки открываются только после выбора и проверки существующего пути.</p></div>
            <div className="settings-card settings-list">
              <SettingRow title="Дополнительная папка для открытия" description={`${settings.defaultProjectsFolder ?? 'Не выбрана.'} Автопапки проектов создаются в «Документы\\GigaChat Agent\\Projects» и не зависят от этой настройки.`}>
                <div className="inline-actions"><button type="button" className="secondary-button" onClick={() => void trackRendererOperation(async () => {
                  try {
                    const updated = await window.gigaChat.settings.chooseProjectsFolder();
                    setSettings((current) => ({ ...current, defaultProjectsFolder: updated.defaultProjectsFolder }));
                  } catch (error) { rendererOperations.current.reportFailure(error); setNotice(getErrorMessage(error)); }
                })}>Выбрать</button><button type="button" className="icon-button" disabled={!settings.defaultProjectsFolder} aria-label="Открыть папку" onClick={() => void window.gigaChat.settings.openProjectsFolder().catch((error: unknown) => setNotice(getErrorMessage(error)))}><Icon name="external" /></button></div>
              </SettingRow>
              <SettingRow title="Программа для открытия" description="Применяется при открытии папки проекта.">
                <span className="value-chip">{openers.find((opener) => opener.id === settings.preferredOpener || (settings.preferredOpener === 'detected-app' && opener.id === 'vscode'))?.name ?? 'Не обнаружена'}</span>
              </SettingRow>
            </div>
            <div className="project-folder-settings">
              <h3>Рабочие папки проектов</h3>
              {activeProjects.length === 0
                ? <p className="muted-copy">Создайте проект, чтобы выбрать для него папку.</p>
                : activeProjects.map((project) => (
                    <div className="project-folder-row" key={project.id}><span><strong>{project.name}</strong><small>{project.workingFolder ?? 'Рабочая папка не выбрана'}</small></span><button type="button" className="secondary-button" onClick={() => void chooseProjectFolder(project)}>Выбрать</button></div>
                  ))}
            </div>
          </>
        );
      case 'terminal':
        return (
          <>
            <div className="settings-section-heading"><h2>Терминал и код</h2><p>Настройки отображают будущую конфигурацию без обещания запуска команд.</p></div>
            <div className="settings-card settings-list">
              <SettingRow title="PowerShell" description="Кандидат оболочки Windows; запуск из приложения пока не реализован."><span className="status-label">Не подключён</span></SettingRow>
              <SettingRow title="Рабочий каталог" description="Будет использовать выбранную папку проекта."><span className="status-label">Нет исполнения</span></SettingRow>
              <SettingRow title="Команды кодирования" description="Требуют отдельной настройки и permission engine."><span className="status-label">Недоступно</span></SettingRow>
            </div>
          </>
        );
      case 'advanced':
        return (
          <>
            <div className="settings-section-heading"><h2>Дополнительно</h2><p>Сведения об этой локальной установке.</p></div>
            <div className="settings-card settings-list">
              <SettingRow title="Версия приложения"><span className="value-chip">{appInfo?.version ?? '—'}</span></SettingRow>
              <SettingRow title="Каталог локальных данных" description="Папка приложения, не рабочая папка проекта."><span className="path-value">{appInfo?.dataPath ?? 'Загрузка…'}</span></SettingRow>
              <SettingRow title="Диагностика и журналы"><span className="status-label">Пока недоступно</span></SettingRow>
              <SettingRow title="Экспериментальные параметры"><span className="status-label">Не включены</span></SettingRow>
              <SettingRow title="Удалить локальные данные" description="После подтверждения будут удалены чаты, копии файлов, проекты и настройки приложения, Skills/Hooks и сохранённый ключ. Рабочие папки проектов и исходные файлы не затрагиваются; приложение закроется.">
                <button type="button" className="danger-button" onClick={() => void window.gigaChat.settings.deleteAppData().catch((error: unknown) => setNotice(getErrorMessage(error)))}>Удалить данные…</button>
              </SettingRow>
            </div>
          </>
        );
      case 'archive':
        return renderArchive();
    }
  }

  function renderContent(): ReactNode {
    if (loading) return <div className="loading-state" role="status">Загрузка локальных данных…</div>;
    switch (route.page) {
      case 'onboarding':
        return <ConnectionSetup firstRun suspended={sidebarPreview || nativeOverlayOpen || Boolean(dialogRequest) || Boolean(approvalRequest) || closePending || Boolean(closeFailure)} onContinue={finishOnboarding} runAcceptedOperation={trackRendererOperation}
          reportOperationFailure={(error) => rendererOperations.current.reportFailure(error)}
          onKeySaveFailureChange={(failed) => { connectionKeySaveFailed.current = failed; }} />;
      case 'home':
        return (
          <section className="empty-state">
            <img className="empty-logo" src={gigaChatLogo} alt="" draggable={false} />
            <h1>Что будем создавать?</h1>
            <p>Ваши идеи. Возможности ГигаЧат.</p>
          </section>
        );
      case 'chat':
        return selectedChat ? (
          <section className="chat-view">
            {chatLoadState.chatId === route.id && chatLoadState.status === 'loading' && <div className="loading-state" role="status">Загрузка истории чата…</div>}
            {chatLoadState.chatId === route.id && chatLoadState.status === 'error' && <div className="project-folder-choice" role="alert">
              <strong>Не удалось загрузить этот чат</strong><p>{chatLoadState.error}</p>
              <button type="button" className="secondary-button" onClick={() => setChatLoadRetry((value) => value + 1)}>Повторить загрузку</button>
            </div>}
            {chatDraftSaveError?.chatId === route.id && <div className="project-folder-choice" role="alert">
              <strong>Черновик не сохранён</strong><p>{chatDraftSaveError?.message} Текст оставлен в редакторе.</p>
              <button type="button" className="secondary-button" onClick={() => saveChatDraft(selectedChat.id, draftRef.current)}>Повторить сохранение</button>
            </div>}
            {chatDetail?.id === selectedChat.id && chatLoadState.status === 'ready' && chatDetail.messages.length ? <div className="chat-history" aria-label="История сообщений">
              {chatDetail.messages.map((message) => <article key={message.id} className={`chat-message message-${message.role}`}>
                <span className="message-author">{message.role === 'user' ? 'Вы' : 'GigaChat · тестовый пример'}</span>
                <p>{message.text}</p>
              </article>)}
            </div> : null}
            {runtimeTurns.length ? <section className="runtime-timeline" aria-label="Состояние локального хода">
              {runtimeTurns.map((turn) => <article className="runtime-turn" key={turn.id}>
                <div className="runtime-turn-heading">
                  <strong>{runtimeStatusLabel(turn.status)}</strong>
                  {turn.queueDurationMs !== undefined && <small>Очередь · {elapsedLabel(turn.queueDurationMs)}</small>}
                  {turn.activeDurationMs !== undefined && <small>Работа · {elapsedLabel(turn.activeDurationMs)}</small>}
                  {(turn.status === 'queued' || turn.status === 'running') && <button type="button" className="quiet-button runtime-cancel" onClick={() => {
                    void window.gigaChat.runtime.cancel(turn.chatId, turn.id).catch((error: unknown) => setNotice(getErrorMessage(error)));
                  }}>Отменить</button>}
                </div>
                {turn.activity.length > 0 && <ul className="runtime-activity-list">
                  {turn.activity.map((activity, index) => <li key={`${turn.id}-${index}`}>{runtimeActivityLabel(activity)}{activity.kind === 'tool' && activity.durationMs !== undefined ? ` · ${elapsedLabel(activity.durationMs)}` : ''}</li>)}
                </ul>}
                {turn.error && <p className="runtime-error" role="alert">{turn.error}</p>}
              </article>)}
            </section> : null}
            {chatDetail?.artifacts.length ? <section className="chat-files" aria-label="Файлы чата">
              <h2>Файлы чата</h2>
              {chatDetail.artifacts.map((artifact) => <div className="chat-file" key={artifact.id}>
                <Icon name="file" /><span><strong>{artifact.name}</strong><small>{Math.ceil(artifact.size / 1024)} КБ</small></span>
                <button type="button" className="quiet-button" onClick={() => void window.gigaChat.chats.openArtifact(chatDetail.id, artifact.id).catch((error: unknown) => setNotice(getErrorMessage(error)))}>Открыть</button>
                <button type="button" className="quiet-button" onClick={() => void window.gigaChat.chats.openFolder(chatDetail.id).catch((error: unknown) => setNotice(getErrorMessage(error)))}>Открыть папку чата</button>
              </div>)}
            </section> : null}
          </section>
        ) : <section className="content-page"><h1>Чат не найден</h1><button type="button" className="secondary-button" onClick={() => navigate({ page: 'home' })}>На главный экран</button></section>;
      case 'settings':
        return (
          <section className="settings-layout">
            <nav className="settings-nav" aria-label="Разделы настроек">
              <div className="settings-nav-heading"><h1>Настройки</h1></div>
              {SETTINGS_SECTIONS.map((item) => (
                <button key={item.id} type="button" className={settingsSection === item.id ? 'settings-nav-item active' : 'settings-nav-item'} onClick={() => setSettingsSection(item.id)}>
                  <Icon name={item.icon} /><span>{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="settings-content">
              {settingsSection !== 'browser' && <div className="settings-content-heading"><h1>{settingTitle}</h1></div>}
              {renderSettingsSection()}
            </div>
          </section>
        );
      case 'images':
        return <section className="content-page"><div className="page-heading"><span className="eyebrow">Локальная оболочка</span><h1>Изображения</h1></div><EmptyState title="Генерация пока недоступна" description="Новый чат изображений сохранится локально. Отправка и генерация начнутся после подключения API." icon="image" /><button type="button" className="primary-button" onClick={() => void createChat(null, 'image')}>Создать чат изображений</button></section>;
      case 'video':
        return <section className="content-page"><div className="page-heading"><span className="eyebrow">Будущая функция</span><h1>Создание видео</h1></div><EmptyState title="Раздел подготовлен" description="Генерация видео появится после отдельной проверки возможностей API." icon="video" /><span className="future-badge">FUTURE</span></section>;
      case 'podcasts':
        return <section className="content-page"><div className="page-heading"><span className="eyebrow">Будущая функция</span><h1>Подкасты</h1></div><EmptyState title="Раздел подготовлен" description="Создание подкастов появится после отдельной проверки возможностей API." icon="podcast" /><span className="future-badge">FUTURE</span></section>;
      case 'archive':
        return renderArchive();
      case 'profile':
        return (
          <section className="content-page profile-page">
            <div className="page-heading"><span className="eyebrow">Профиль и использование</span><h1>Локальный профиль</h1><p>Данные принадлежат этому устройству. Учётная запись не подключена.</p></div>
            <div className="profile-summary"><span className="profile-avatar large"><Icon name="user" /></span><div><strong>На этом компьютере</strong><p>GigaChat API не подключён</p></div><span className="status-pill"><i />Локально</span></div>
            <div className="usage-grid">
              <article><span>Всего чатов</span><strong>{localUsageStats?.chatCount ?? '…'}</strong><small>Включая архив</small></article>
              <article><span>Всего проектов</span><strong>{localUsageStats?.projectCount ?? '…'}</strong><small>Включая архив</small></article>
              <article><span>Дни локальной активности</span><strong>{localUsageStats?.activityDayCount ?? '…'}</strong><small>UTC-даты проектов, чатов и сообщений</small></article>
            </div>
            <EmptyState title="Данные API пока недоступны" description="Токены, модели, баланс и тепловая карта появятся только после подключения и реальных измерений." icon="gauge" />
          </section>
        );
    }
  }

  const title = route.page === 'home' ? 'Новый чат'
    : route.page === 'onboarding' ? 'Первый запуск'
    : route.page === 'chat' ? selectedChat?.title ?? 'Чат'
    : route.page === 'images' ? 'Изображения'
    : route.page === 'video' ? 'Видео'
    : route.page === 'podcasts' ? 'Подкасты'
    : route.page === 'archive' ? 'Архив'
    : route.page === 'profile' ? 'Профиль'
    : settingTitle;
  const sidebarClasses = [
    'workspace',
    route.page === 'settings' ? 'settings-workspace' : '',
    route.page === 'onboarding' ? 'onboarding-workspace' : '',
    compactLayout ? 'compact-workspace' : '',
    compactLayout || !settings.sidebarVisible ? 'sidebar-hidden' : '',
    sidebarPreview ? 'sidebar-preview' : '',
    sidebarDragging ? 'sidebar-dragging' : '',
  ].filter(Boolean).join(' ');
  const sidebarShown = compactLayout ? sidebarPreview : settings.sidebarVisible || sidebarPreview;
  const sidebarWidthStyle = compactLayout ? undefined : sidebarDragWidth !== null
    ? { '--sidebar-width': `${sidebarDragWidth}px` } as CSSProperties
    : settings.sidebarWidthPx !== null
      ? { '--sidebar-width': `min(${settings.sidebarWidthPx}px, max(242px, calc(100% - 580px)))` } as CSSProperties
      : undefined;

  return (
    <div className={`app-frame theme-${resolvedTheme}${transparentSidebar ? ' sidebar-transparent' : ''}`}>
      <header className="titlebar" aria-label={`Панель приложения: ${title}`}>
        <div className="titlebar-actions">
          {route.page !== 'settings' && route.page !== 'onboarding' && <button
            ref={sidebarButtonRef}
            type="button"
            className="window-action"
            aria-label={sidebarShown ? 'Скрыть боковую панель' : 'Показать боковую панель'}
            aria-expanded={sidebarShown}
            aria-controls="application-sidebar"
            data-sidebar-collapsed={compactLayout ? !sidebarShown : !settings.sidebarVisible}
            title={sidebarShown ? 'Скрыть боковую панель' : 'Показать боковую панель'}
            onClick={() => { if (compactLayout) setSidebarPreview((value) => !value); else void toggleSidebar(); }}
            onPointerEnter={() => { if (!compactLayout && !settings.sidebarVisible) { clearPreviewClose(); setSidebarPreview(true); } }}
            onPointerLeave={() => { if (!compactLayout && !settings.sidebarVisible) schedulePreviewClose(); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && !compactLayout && !settings.sidebarVisible) {
                event.preventDefault();
                clearPreviewClose();
                setSidebarPreview(true);
              }
              if (event.key === 'Escape' && sidebarPreview) {
                closePreview();
                sidebarButtonRef.current?.blur();
              }
            }}
          ><Icon name="panel" /></button>}
          <button type="button" className="window-action" aria-label="Назад" title="Назад" disabled={!canGoBack} onClick={() => moveHistory(-1)}><Icon name="back" /></button>
          <button type="button" className="window-action" aria-label="Вперёд" title="Вперёд" disabled={!canGoForward} onClick={() => moveHistory(1)}><Icon name="forward" /></button>
        </div>
      </header>

      <div ref={workspaceRef} className={sidebarClasses} style={sidebarWidthStyle}>
        {compactLayout && sidebarPreview && <button type="button" className="compact-backdrop" aria-label="Закрыть боковую панель" onClick={closePreview} />}
        {route.page !== 'settings' && route.page !== 'onboarding' && <aside
          ref={sidebarRef}
          id="application-sidebar"
          className="sidebar"
          aria-label="Навигация"
          aria-hidden={!sidebarShown}
          inert={!sidebarShown}
          onPointerEnter={clearPreviewClose}
          onPointerLeave={() => { if (!settings.sidebarVisible && !compactLayout) schedulePreviewClose(); }}
        >
          <div className="sidebar-inner">
          <ActionMenu className="brand-menu" label="Выбрать режим GigaChat" placement="below" onVisibilityChange={trackNativeOverlay} trigger={
            <><span className="brand-wordmark">ГИГАЧАТ <i>{runtimeMode === 'api' ? 'API' : 'WEB'}</i></span><Icon name="chevron" className="brand-chevron" /></>
          }>
            <button type="button" aria-pressed={runtimeMode === 'api'} onClick={() => setRuntimeMode('api')}>GigaChat API{runtimeMode === 'api' && <Icon name="check" />}</button>
            <button type="button" aria-pressed={runtimeMode === 'web'} onClick={() => setRuntimeMode('web')}>GigaChat Web{runtimeMode === 'web' && <Icon name="check" />}</button>
            <span className="brand-menu-note">Web: подключение появится позже.</span>
          </ActionMenu>
          <nav className="sidebar-actions" aria-label="Основные действия">
            <button type="button" className={route.page === 'home' ? 'nav-action active' : 'nav-action'} onClick={startNewHomeChat}><Icon name="edit" /><span>Новый чат</span></button>
            <button type="button" className={route.page === 'chat' && selectedChat?.kind === 'image' ? 'nav-action active' : 'nav-action'} onClick={() => void createChat(null, 'image')}><Icon name="image" /><span>Сгенерировать изображение</span></button>
            <button type="button" className={route.page === 'video' ? 'nav-action active' : 'nav-action'} onClick={() => navigate({ page: 'video' })}><Icon name="video" /><span>Создать видео</span></button>
            <button type="button" className={route.page === 'podcasts' ? 'nav-action active' : 'nav-action'} onClick={() => navigate({ page: 'podcasts' })}><Icon name="podcast" /><span>Подкасты</span></button>
          </nav>

          <div className="sidebar-library">
          {(pinnedProjects.length > 0 || pinnedChats.length > 0) && <section className="sidebar-section pinned-section">
            <div className="section-heading"><h2>Закреплённые</h2></div>
            {pinnedProjects.map(projectRow)}
            {pinnedChats.map((chat) => chatRow(chat))}
          </section>}
          <section className="sidebar-section project-section">
            <div className="section-heading"><h2>Проекты</h2><button type="button" className="small-icon-button" aria-label="Создать проект" title="Создать проект" onClick={() => void createProject()}><Icon name="plus" /></button></div>
            {library.projects.length === 0
              ? <p className="sidebar-empty">{activeProjects.length === 0 ? 'Здесь появятся ваши проекты' : 'Все проекты закреплены'}</p>
              : visibleProjects.map(projectRow)}
            {library.projects.length > 5 && <button type="button" className="show-more" onClick={() => setShowAllProjects((value) => !value)}>{showAllProjects ? 'Свернуть' : 'Показать больше'}<Icon name="chevron" /></button>}
          </section>

          <section className={activeProjects.length === 0 && activeChats.length === 0 ? 'sidebar-section history-section empty-library' : 'sidebar-section history-section'}>
            <div className="section-heading"><h2>Недавние</h2></div>
            {library.recentChats.length === 0
              ? <p className="sidebar-empty">{activeChats.length === 0 ? 'Нет чатов' : 'Здесь появятся чаты без проекта'}</p>
              : visibleChats.map((chat) => chatRow(chat))}
            {library.recentChats.length > 8 && <button type="button" className="show-more" onClick={() => setShowAllChats((value) => !value)}>{showAllChats ? 'Свернуть' : 'Показать больше'}<Icon name="chevron" /></button>}
            <button type="button" className="archive-link" onClick={() => navigate({ page: 'archive' })}><Icon name="archive" /><span>Архив</span></button>
          </section>
          </div>

          <div className="profile-area">
            <button type="button" className="profile-button" onClick={() => navigate({ page: 'profile' })}>
              <span className="profile-avatar"><Icon name="user" /></span><span className="profile-copy"><strong>Локальный профиль</strong><small>API не подключён</small></span>
            </button>
            <button type="button" className="profile-settings-button" aria-label="Настройки" onClick={() => openSettings('general')}><Icon name="settings" /><span className="profile-tooltip" role="tooltip">Настройки</span></button>
          </div>
          </div>
        </aside>}

        {!compactLayout && settings.sidebarVisible && route.page !== 'settings' && route.page !== 'onboarding' && <div
          className="sidebar-resizer" role="separator" tabIndex={0} aria-label="Ширина боковой панели" aria-orientation="vertical"
          aria-valuemin={0} aria-valuemax={maxSidebarWidth()} aria-valuenow={Math.round(sidebarDragWidth ?? sidebarRef.current?.getBoundingClientRect().width ?? 264)}
          onPointerDown={startSidebarDrag}
          onKeyDown={(event) => {
            if (event.key === 'Home') { event.preventDefault(); void updateLocalSettings({ sidebarVisible: false }); }
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              const current = sidebarRef.current?.getBoundingClientRect().width ?? 264;
              const next = Math.max(242, Math.min(maxSidebarWidth(), current + (event.key === 'ArrowRight' ? 16 : -16)));
              void updateLocalSettings({ sidebarWidthPx: Math.round(next) });
            }
          }}
        />}

        <main ref={mainPanelRef} className={route.page === 'settings' ? 'main-panel settings-panel' : 'main-panel'}>
          {(() => {
            const chatContent = <>
          <div className={route.page === 'home' ? 'view-area home-view' : route.page === 'settings' ? 'view-area settings-view' : route.page === 'onboarding' ? 'view-area onboarding-view' : 'view-area'}>{renderContent()}</div>
          {(route.page === 'home' || route.page === 'chat') && (
            <div className="composer-stack">
              {composerCompletion && <div id="composer-suggestions" className="composer-suggestions" role="listbox" aria-label={composerCompletion.kind === 'command' ? 'Команды' : 'Локальные Skills'}>
                {composerCompletion.items.map((suggestion, index) => <button
                  id={`composer-suggestion-${suggestion.id}`}
                  key={suggestion.id}
                  type="button"
                  role="option"
                  aria-selected={index === completionIndex}
                  disabled={!suggestion.available}
                  className={index === completionIndex ? 'composer-suggestion active' : 'composer-suggestion'}
                  onMouseEnter={() => setCompletionIndex(index)}
                  onClick={() => insertComposerSuggestion(suggestion)}
                >{suggestion.id === 'compact' && <ContextRing compact />}<span className="composer-suggestion-copy"><strong>{suggestion.label}</strong><span>{suggestion.description}</span></span></button>)}
                {composerCompletion.emptyMessage && <p className="composer-suggestions-empty" role="status">{composerCompletion.emptyMessage}</p>}
              </div>}
              {route.page === 'home' && <div className="project-picker">
                <ActionMenu className="composer-project-menu" placement="below-start" label="Выбрать проект" onVisibilityChange={trackNativeOverlay}
                  initialFocus=".project-search-input" onOpen={() => setProjectSearch('')}
                  trigger={<><Icon name="folder" /><span>{activeProjects.find((project) => project.id === composerProjectId)?.name ?? 'Выбрать проект'}</span><Icon name="chevron" /></>}>
                  <div className="project-picker-popup" onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.currentTarget.closest<HTMLDivElement>('.action-menu-content')?.hidePopover();
                      return;
                    }
                    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.project-picker-option')];
                    const active = document.activeElement;
                    const index = buttons.indexOf(active as HTMLButtonElement);
                    event.preventDefault();
                    if (event.key === 'ArrowDown') buttons[Math.min(buttons.length - 1, index + 1)]?.focus();
                    else if (index <= 0) event.currentTarget.querySelector<HTMLInputElement>('.project-search-input')?.focus();
                    else buttons[index - 1]?.focus();
                  }}>
                    <div className="project-search"><Search className="icon" aria-hidden="true" />
                      <input className="project-search-input" type="search" aria-label="Поиск проектов" placeholder="Поиск проектов" value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} />
                    </div>
                    <div className="project-picker-options">
                      <button type="button" className="project-picker-option" aria-current={!composerProjectId} onClick={() => selectHomeProject('')}><Icon name="folder" />Без проекта{!composerProjectId && <Icon name="check" />}</button>
                      {activeProjects.filter((project) => project.name.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase())).map((project) =>
                        <button type="button" className="project-picker-option" key={project.id} aria-current={project.id === composerProjectId} onClick={() => selectHomeProject(project.id)}><Icon name="folder" /><span>{project.name}</span>{project.id === composerProjectId && <Icon name="check" />}</button>)}
                      {activeProjects.length === 0 && <p className="picker-empty">Пока нет проектов</p>}
                      {activeProjects.length > 0 && !activeProjects.some((project) => project.name.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase())) && <p className="picker-empty">Ничего не найдено</p>}
                    </div>
                    <button type="button" className="project-picker-option project-create-option" onClick={() => createProject()}><Icon name="plus" />Новый проект</button>
                  </div>
                </ActionMenu>
              </div>}
              {route.page === 'home' && detachedDraftSessions.map((session, index) => <div className="project-folder-choice" role="status" key={`detached-draft-${index}`}>
                <strong>Есть отложенный черновик</strong><p>{session.text ? `${session.text.slice(0, 120)}${session.text.length > 120 ? '…' : ''}` : 'Текст появится после восстановления сессии.'}</p>
                {session.error && <p role="alert">{session.error}</p>}
                <button type="button" className="secondary-button" onClick={() => resumeDetachedDraftSession(session)}>Восстановить черновик</button>
              </div>)}
              {route.page === 'home' && homeDraftError && <div className="project-folder-choice" role="alert">
                <strong>Черновик пока не сохранён</strong><p>{homeDraftError} Текст сохранён в этой сессии.</p>
                <button type="button" className="secondary-button" disabled={Boolean(homeDraftSession.current?.creation)} onClick={() => {
                  const session = homeDraftSession.current;
                  if (session) void startHomeDraftSession(session).catch((error: unknown) => setHomeDraftError(getErrorMessage(error)));
                }}>Повторить сохранение</button>
              </div>}
              <div className="composer">
                <label className="sr-only" htmlFor="chat-draft">Черновик сообщения</label>
                <textarea
                  id="chat-draft"
                  ref={composerInputRef}
                  value={draft}
                  aria-autocomplete="list"
                  aria-controls={composerCompletion ? 'composer-suggestions' : undefined}
                  aria-activedescendant={composerCompletion?.items[completionIndex] ? `composer-suggestion-${composerCompletion.items[completionIndex]?.id}` : undefined}
                  onChange={(event) => changeDraft(event.target.value, event.currentTarget.selectionStart)}
                  onSelect={(event) => setComposerCaret(event.currentTarget.selectionStart)}
                  onClick={(event) => setComposerCaret(event.currentTarget.selectionStart)}
                  onKeyDown={handleComposerKeyDown}
                  disabled={sending || !chatComposerReady}
                  placeholder={selectedChat?.kind === 'image' ? 'Опишите изображение' : 'Поручите что угодно'}
                  rows={2}
                />
                {selectedComposerSkillId && <div className="composer-skill-selection" role="status">
                  <span><strong>{selectedComposerSkill?.name ?? 'Выбранный Skill недоступен'}</strong><small>{selectedComposerSkill ? `${selectedComposerSkill.scope === 'global' ? 'Global' : selectedComposerSkill.projectName ?? 'Project'} · будет применён при подключении API` : 'Включите Skill в настройках или снимите выбор.'}</small></span>
                  <button type="button" className="quiet-button" aria-label="Снять выбор Skill" title="Снять выбор Skill" onClick={() => void changeComposerSkill(null)}>Снять</button>
                </div>}
                <div className="composer-toolbar">
                  <div className="toolbar-leading">
                  <button type="button" className="attach-button" disabled={sending || !chatComposerReady} aria-label="Прикрепить файл" title="Прикрепить файл" onClick={() => void attachFile()}><Icon name="plus" /></button>
                  <ActionMenu className="composer-permission-menu" placement="below-start" onVisibilityChange={trackNativeOverlay}
                    label={`Разрешения: ${AVAILABLE_PERMISSION_PROFILES.find((profile) => profile.id === composerPermissionProfile)?.name ?? 'Спросить'}`}
                    disabled={!canChangeComposerPermissionProfile}
                    trigger={<><Icon name="shield" /><span>{AVAILABLE_PERMISSION_PROFILES.find((profile) => profile.id === composerPermissionProfile)?.name ?? 'Спросить'}</span><Icon name="chevron" /></>}>
                    <div className="permission-picker-popup"><p className="picker-heading">Как подтверждать действия GigaChat?</p>
                      {AVAILABLE_PERMISSION_PROFILES.map((profile) => <button type="button" className="permission-picker-option" key={profile.id}
                        aria-current={profile.id === composerPermissionProfile} onClick={() => void changeComposerPermissionProfile(profile.id)}>
                        <Icon name={profile.id === 'custom' ? 'settings' : 'shield'} />
                        <span><strong>{profile.name}</strong><small>{profile.description}</small></span>
                        {profile.id === composerPermissionProfile && <Icon name="check" />}
                      </button>)}
                    </div>
                  </ActionMenu>
                  <span className="toolbar-mode-slot" aria-hidden="true" />
                  </div>
                  <div className="toolbar-trailing">
                  <ActionMenu className="composer-model-menu" placement="below" label="Выбрать модель GigaChat" onVisibilityChange={trackNativeOverlay}
                    disabled={!canChangeComposerPermissionProfile}
                    trigger={<><span>{GIGACHAT_MODELS.find((model) => model.id === composerModelId)?.name ?? 'Выбрать модель'}</span><Icon name="chevron" /></>}>
                    <div className="model-picker-popup"><p className="picker-heading">Модель для следующих ходов</p>
                      <p className="picker-caption">Доступность будет проверена после подключения API.</p>
                      {GIGACHAT_MODELS.map((model) => <button type="button" className="model-picker-option" key={model.id}
                        aria-current={model.id === composerModelId} onClick={() => void changeComposerModel(model.id)}>
                        <span><strong>{model.name}</strong><small>{model.description}</small></span>
                        {model.id === composerModelId && <Icon name="check" />}
                      </button>)}
                    </div>
                  </ActionMenu>
                  <span className="context-indicator" role="img" tabIndex={0} aria-label="Использование контекста станет доступно после подключения API" title="Контекст станет доступен после подключения API."><ContextRing /></span>
                  <VoiceCaptureControl
                    key={route.page === 'chat' ? route.id ?? 'chat' : `home-${homeVoiceGeneration}`}
                    available={voiceAvailability.available && chatComposerReady && !sending}
                    reason={!chatComposerReady ? (chatLoadState.error ?? 'Загрузка чата…') : voiceAvailability.reason}
                    canContinue={() => !rendererOperations.current.frozen}
                    suspended={closePending || Boolean(closeFailure)}
                    onTranscript={insertVoiceTranscript}
                    onError={setNotice}
                    onSuccess={showSuccess}
                  />
                  <span className="send-button-wrap" title={draft.trim() ? 'Сохранить локально без отправки в API' : 'Голосовой чат пока недоступен'}><button type="button" className="send-button" disabled={!draft.trim() || sending || !chatComposerReady} aria-label={draft.trim() ? 'Сохранить сообщение локально' : 'Голосовой чат пока недоступен'} onClick={() => void submitMessage()}><Icon name={draft.trim() ? 'send' : 'audio'} /></button></span>
                  </div>
                </div>
              </div>
            </div>
          )}
            </>;
            if (route.page === 'chat') return <BrowserPanel
              chatHeading={<>
                <Icon name={selectedChat?.projectId ? 'folder' : 'chat'} className={selectedChat?.projectId ? 'chat-header-folder' : 'chat-header-chat'} />
                <span className="chat-header-title" title={selectedChat?.title ?? 'Загрузка чата'}>{selectedChat?.title ?? 'Загрузка чата…'}</span>
              </>}
              chatContent={chatContent}
              paneOpen={settings.browserPaneOpen}
              onPaneOpenChange={(browserPaneOpen) => void updateLocalSettings({ browserPaneOpen })}
              paneIcon={<Icon name="panelRight" />}
              onWidthChange={(browserWidthPx) => void updateLocalSettings({ browserWidthPx })}
              preferredWidth={settings.browserWidthPx}
              suspended={sidebarPreview || nativeOverlayOpen || Boolean(dialogRequest) || Boolean(approvalRequest) || closePending || Boolean(closeFailure)}
            />;
            return <div className="content-workspace"><div className="chat-column">{chatContent}</div></div>;
          })()}
          {notice && <div className={`notice notice-${noticeKind}`} role={noticeKind === 'error' ? 'alert' : 'status'}><span>{notice}</span><button type="button" aria-label="Закрыть уведомление" onClick={() => setNotice('')}><Icon name="x" /></button></div>}
        </main>
      </div>
      <dialog ref={dialogRef} className={`app-dialog${dialogRequest?.kind === 'project-settings' ? ' project-settings-dialog' : ''}`} onClose={(event) => {
        if (event.currentTarget.open) return;
        dialogGeneration.current += 1;
        if (activeProjectInstructionId.current !== null) {
          activeProjectInstructionId.current = null;
          projectInstructionLoadGeneration.current += 1;
          setProjectInstructionsReady(false);
        }
        setDialogRequest(null);
      }} onCancel={(event) => {
        if (dialogBusy || dialogRequest?.kind === 'project-settings') {
          event.preventDefault();
          if (!dialogBusy && dialogRequest?.kind === 'project-settings') void closeProjectSettings();
        }
      }}>
        {dialogRequest && <form onSubmit={(event) => { event.preventDefault(); void submitDialog(); }}>
          <button type="button" className="dialog-close" aria-label="Закрыть" disabled={dialogBusy} onClick={() => {
            if (dialogRequest.kind === 'project-settings') void closeProjectSettings();
            else setDialogRequest(null);
          }}><Icon name="x" /></button>
          <h2>{dialogRequest.kind === 'create-project' ? 'Создать проект'
            : dialogRequest.kind === 'project-settings' ? `Настройки проекта «${dialogRequest.project?.name}»`
            : dialogRequest.kind === 'rename-project' ? 'Переименовать проект'
              : dialogRequest.kind === 'delete-project' ? `Удалить проект «${dialogRequest.project?.name}»?`
                : dialogRequest.kind === 'rename-chat' ? 'Переименовать чат'
                  : `Удалить чат «${dialogRequest.chat?.title}»?`}</h2>
          {dialogRequest.kind === 'delete-project' && <p>Чаты проекта останутся в истории без привязки к проекту.</p>}
          {dialogRequest.kind === 'delete-chat' && dialogRequest.hasFiles && <p>Копии файлов внутри этого чата также будут удалены. Исходные файлы останутся на месте.</p>}
          {(dialogRequest.kind === 'create-project' || dialogRequest.kind === 'rename-project' || dialogRequest.kind === 'rename-chat') && <label className="dialog-label">
            {dialogRequest.kind === 'rename-chat' ? 'Название чата' : 'Название проекта'}
            <input autoFocus value={dialogValue} disabled={Boolean(dialogRequest.createdProjectId)} onChange={(event) => setDialogValue(event.target.value)} maxLength={dialogRequest.kind === 'rename-chat' ? 160 : 120} />
          </label>}
          {dialogRequest.kind === 'create-project' && <div className="project-folder-choice">
            <strong>Папка проекта</strong>
            <p>{dialogFolder ?? 'Если не выбрать папку, приложение создаст её в «Документы\\GigaChat Agent\\Projects» с именем «GigaChat Project N».'}</p>
            <button type="button" className="secondary-button" disabled={dialogBusy} onClick={() => void pickProjectFolder()}><Icon name="folder" />Выбрать папку</button>
          </div>}
          {dialogRequest.kind === 'project-settings' && dialogRequest.project && <>
            <div className="project-folder-choice">
              <strong>Рабочая папка</strong>
              <p>{dialogRequest.project.workingFolder ?? 'Папка не назначена.'}</p>
              <div className="inline-actions"><button type="button" className="secondary-button" onClick={() => { if (dialogRequest.project) void chooseProjectFolder(dialogRequest.project); }}>Изменить папку</button>
                <button type="button" className="secondary-button" disabled={!dialogRequest.project.workingFolder} onClick={() => { if (dialogRequest.project) void window.gigaChat.projects.openFolder(dialogRequest.project.id).catch((error: unknown) => setDialogError(getErrorMessage(error))); }}>Открыть</button></div>
            </div>
            {!dialogRequest.project.archived && <button type="button" className="secondary-button project-new-chat" onClick={() => {
              if (!dialogRequest.project) return;
              const projectId = dialogRequest.project.id;
              void closeProjectSettings().then((closed) => { if (closed) void createChat(projectId); });
            }}><Icon name="plus" />Новый чат в проекте</button>}
            {projectInstructionsLoadError && <div className="project-folder-choice" role="alert">
              <strong>Не удалось прочитать AGENTS.md</strong><p>{projectInstructionsLoadError} Редактор останется заблокирован, чтобы не заменить файл пустым текстом.</p>
              <button type="button" className="secondary-button" disabled={projectInstructionsLoading} onClick={() => void retryProjectInstructions()}>Повторить чтение</button>
            </div>}
            <label className="dialog-label project-instructions-label">Инструкции проекта · AGENTS.md
              <textarea value={projectInstructions} disabled={projectInstructionsLoading || !projectInstructionsReady} onChange={(event) => {
                setProjectInstructions(event.target.value);
                if (dialogRequest.project) projectSaver.edit(dialogRequest.project.id, event.target.value);
              }} onBlur={() => {
                const id = dialogRequest.project?.id;
                if (projectInstructionsConflict) return;
                const generation = projectInstructionLoadGeneration.current;
                if (id) void projectSaver.flush(id).catch((error: unknown) => {
                  if (activeProjectInstructionId.current === id && generation === projectInstructionLoadGeneration.current) setDialogError(getErrorMessage(error));
                });
              }} aria-label="Инструкции проекта AGENTS.md" placeholder={projectInstructionsLoading ? 'Чтение AGENTS.md…' : 'Правила для всех чатов этого проекта…'} />
            </label>
            <span role="status" className={`save-status status-${projectInstructionsStatus}`}>{projectInstructionsLoading ? 'Чтение…' : projectInstructionsReady ? saveStatusLabel(projectInstructionsStatus) : 'Ожидание загрузки'}</span>
            {projectInstructionsConflict && <div className="project-folder-choice" role="alert">
              <strong>{projectInstructionsConflict.phase === 'after-commit' ? 'Найдены две версии AGENTS.md' : 'AGENTS.md изменён вне приложения'}</strong>
              <p>Ваш текст остался в редакторе. Перечитайте текущую версию или сохраните свой текст отдельной копией.</p>
              {projectInstructionsConflict.phase === 'before-commit' && <details>
                <summary>Показать версию в рабочей папке</summary>
                <pre className="approval-target">{projectInstructionsConflict.current.text || 'Файл отсутствует или пуст.'}</pre>
              </details>}
              <div className="inline-actions">
                <button type="button" className="secondary-button" disabled={projectInstructionsLoading} onClick={() => void reloadProjectInstructions()}>Перечитать файл</button>
                <button type="button" className="secondary-button" disabled={projectInstructionsLoading} onClick={() => void saveProjectInstructionsCopy()}>Сохранить черновик отдельно</button>
              </div>
            </div>}
            {projectPreservedInstruction && <div className="project-backup-note" role="status">
              <strong>Вытесненная версия сохранена</strong>
              <span>{projectPreservedInstruction.path}</span>
              {projectPreservedInstruction.text === null
                ? <p>Содержимое пока нельзя безопасно прочитать; файл и журнал сохранены.</p>
                : <details><summary>Показать сохранённый текст</summary><pre className="approval-target">{projectPreservedInstruction.text || 'Файл пуст.'}</pre></details>}
            </div>}
            {projectInstructionsBackup && <p className="project-backup-note">Прежняя инструкция сохранена: <span>{projectInstructionsBackup}</span></p>}
          </>}
          {dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}
          <div className="dialog-actions">
            {dialogRequest.kind !== 'project-settings' && <button type="button" className="secondary-button" disabled={dialogBusy} onClick={() => setDialogRequest(null)}>Отмена</button>}
            <button type="submit" className={dialogRequest.kind.startsWith('delete') ? 'danger-button' : 'primary-button'} disabled={dialogBusy || (dialogRequest.kind === 'project-settings' && projectInstructionsLoading)}>{dialogBusy ? 'Подождите…' : dialogRequest.kind.startsWith('delete') ? 'Удалить' : dialogRequest.kind === 'project-settings' ? 'Готово' : dialogRequest.createdProjectId ? 'Повторить перенос' : dialogRequest.kind === 'create-project' ? 'Создать' : 'Сохранить'}</button>
          </div>
        </form>}
      </dialog>
      <dialog ref={closePendingDialogRef} className="app-dialog close-pending-dialog" aria-labelledby="close-pending-title" aria-describedby="close-pending-description" onCancel={(event) => event.preventDefault()}>
        <section>
          <h2 id="close-pending-title">Сохраняем перед закрытием</h2>
          <p id="close-pending-description" role="status" aria-live="polite">Завершаются уже начатые действия и сохранение текста. Окно останется открытым до их завершения.</p>
        </section>
      </dialog>
      <dialog ref={closeDialogRef} className="app-dialog close-error-dialog" role="alertdialog" aria-labelledby="close-error-title" aria-describedby="close-error-description" onCancel={(event) => event.preventDefault()}>
        {closeFailure && <section>
          <h2 id="close-error-title">Не удалось закрыть приложение</h2>
          <p className="close-error-message" role="alert">{closeFailure.message}</p>
          <p id="close-error-description">{closeFailure.reason === 'browser-metadata'
            ? 'Вкладки браузера останутся открытыми. Повторите сохранение или вернитесь к работе.'
            : 'Окно останется открытым, чтобы принятые изменения можно было сохранить или проверить.'}</p>
          <div className="dialog-actions">
            <button type="button" className="secondary-button" disabled={closeRetrying} onClick={returnFromCloseFailure}>Вернуться к работе</button>
            <button type="button" className="primary-button close-retry-button" disabled={closeRetrying} onClick={() => runCloseAction(() => window.gigaChat.retryClose(false))}>{closeRetrying ? 'Повторяем…' : 'Повторить'}</button>
            {closeFailure.reason === 'browser-metadata' && <button type="button" className="danger-button" disabled={closeRetrying} onClick={() => runCloseAction(() => window.gigaChat.retryClose(true))}>Закрыть без сохранения вкладок</button>}
          </div>
        </section>}
      </dialog>
      <dialog ref={approvalDialogRef} className="app-dialog approval-dialog" onCancel={(event) => {
        event.preventDefault();
        void answerApproval(false);
      }}>
        {approvalRequest && <div>
          <h2>Разрешить локальное действие?</h2>
          <p>{approvalRequest.reason}</p>
          <p className="approval-action">{APPROVAL_ACTION_LABELS[approvalRequest.action]}</p>
          <p className="approval-target">{approvalRequest.target}</p>
          <p>Без ответа запрос будет отклонён автоматически.</p>
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={() => void answerApproval(false)}>Отклонить</button>
            <button type="button" className="primary-button" onClick={() => void answerApproval(true)}>Разрешить</button>
          </div>
        </div>}
      </dialog>
    </div>
  );
}

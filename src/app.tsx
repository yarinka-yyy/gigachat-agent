import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
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
  ChatDetail,
  ChatSummary,
  ChatKind,
  ChatPatch,
  FolderOpener,
  HookEvent,
  HookRegistrySnapshot,
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
import ConnectionSetup from './components/ConnectionSetup';
import VoiceCaptureControl from './components/VoiceCaptureControl';

type Page = 'home' | 'chat' | 'project' | 'settings' | 'onboarding' | 'images' | 'video' | 'podcasts' | 'archive' | 'profile';
type Route = { page: Page; id?: string };
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
  | 'panel' | 'back' | 'forward' | 'plus' | 'image' | 'video' | 'podcast' | 'folder'
  | 'chat' | 'settings' | 'archive' | 'send' | 'mic' | 'audio' | 'chevron' | 'sun'
  | 'moon' | 'system' | 'user' | 'sparkle' | 'x' | 'pin' | 'trash' | 'edit' | 'check'
  | 'external' | 'folderOpen' | 'shield' | 'gauge' | 'wrench' | 'puzzle' | 'globe'
  | 'volume' | 'bell' | 'terminal' | 'sliders' | 'palette' | 'book' | 'lock' | 'help' | 'plug'
  | 'cpu' | 'file';
type PageIcon = { id: SettingsSection; label: string; icon: IconName };

const ICONS: Record<IconName, LucideIcon> = {
  panel: PanelLeft,
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
  defaultProjectsFolder: null,
  preferredOpener: 'system',
  defaultPermissionProfile: 'ask',
  defaultModelId: null,
  onboardingCompleted: false,
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

function ActionMenu({ children, label, trigger, className = '', placement = 'side', initialFocus, onOpen, disabled = false }: {
  children: ReactNode; label: string; trigger?: ReactNode; className?: string;
  placement?: 'side' | 'below' | 'below-start'; initialFocus?: string; onOpen?: () => void; disabled?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

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
      <button ref={triggerRef} type="button" aria-label={label} aria-expanded={open} title={label} disabled={disabled} onClick={() => {
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
      <div ref={popupRef} popover="auto" className="action-menu-content" onToggle={() => {
        const isOpen = popupRef.current?.matches(':popover-open') ?? false;
        if (!isOpen) popupRef.current?.querySelectorAll<HTMLDivElement>('.submenu-content:popover-open').forEach((submenu) => submenu.hidePopover());
        if (!isOpen && popupRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
        setOpen(isOpen);
      }} onClick={(event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (button && !button.classList.contains('submenu-trigger')) popupRef.current?.hidePopover();
      }}>{children}</div>
    </div>
  );
}

function ProjectSubmenu({ chat, projects, onSelect }: { chat: ChatSummary; projects: Project[]; onSelect: (projectId: string) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const popupId = useId();

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
      <div ref={popupRef} id={popupId} popover="auto" className="submenu-content" onToggle={() => setOpen(popupRef.current?.matches(':popover-open') ?? false)}
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
      : status === 'error' ? 'Не сохранено — исправьте ошибку и продолжите ввод' : 'Есть несохранённые изменения';
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const [runtimeMode, setRuntimeMode] = useState<'api' | 'web'>('api');
  const [navigation, setNavigation] = useState<Navigation>({ history: [{ page: 'home' }], index: 0 });
  const [sidebarPreview, setSidebarPreview] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => window.innerWidth <= 720);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showAllChats, setShowAllChats] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [composerCaret, setComposerCaret] = useState(0);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null);
  const [runtimeTurns, setRuntimeTurns] = useState<RuntimeTurnSnapshot[]>([]);
  const [pendingPermissionProfile, setPendingPermissionProfile] = useState<PermissionProfile | null>(null);
  const [sending, setSending] = useState(false);
  const [dialogRequest, setDialogRequest] = useState<{ kind: 'create-project' | 'rename-project' | 'delete-project' | 'rename-chat' | 'delete-chat'; project?: Project; chat?: ChatSummary; hasFiles?: boolean; assignChatId?: string; createdProjectId?: string } | null>(null);
  const [dialogValue, setDialogValue] = useState('');
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
  const [approvalRequest, setApprovalRequest] = useState<PermissionApprovalRequest | null>(null);
  const [globalInstructions, setGlobalInstructions] = useState('');
  const [globalInstructionsStatus, setGlobalInstructionsStatus] = useState<SaveStatus>('saved');
  const [integrationTab, setIntegrationTab] = useState<'skills' | 'plugins' | 'tools'>('skills');
  const [projectInstructions, setProjectInstructions] = useState('');
  const [projectInstructionsOpen, setProjectInstructionsOpen] = useState(false);
  const [projectInstructionsStatus, setProjectInstructionsStatus] = useState<SaveStatus>('saved');
  const pendingChat = useRef<Promise<ChatSummary> | null>(null);
  const homeChatId = useRef<string | null>(null);
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
  const draftSave = useRef<Promise<unknown>>(Promise.resolve());
  const dialogRef = useRef<HTMLDialogElement>(null);
  const approvalDialogRef = useRef<HTMLDialogElement>(null);
  const routeRef = useRef<Route>({ page: 'home' });
  const settingsRevision = useRef(0);
  const sidebarButtonRef = useRef<HTMLButtonElement>(null);
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
    (_key, value) => window.gigaChat.settings.saveInstructions(value),
    (_key, status, error) => {
      setGlobalInstructionsStatus(status);
      if (error) setNotice(getErrorMessage(error));
    },
  ));
  const [projectSaver] = useState(() => createInstructionAutosave(
    (id, value) => window.gigaChat.projects.saveInstructions(id, value),
    (id, status, error) => {
      if (routeRef.current.page === 'project' && routeRef.current.id === id) setProjectInstructionsStatus(status);
      if (error) setNotice(getErrorMessage(error));
    },
  ));
  const route = navigation.history[navigation.index] ?? { page: 'home' as const };

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => window.gigaChat.permissions.onRequest(setApprovalRequest), []);

  useEffect(() => {
    const dialog = approvalDialogRef.current;
    if (!dialog) return;
    if (approvalRequest && !dialog.open) dialog.showModal();
    else if (!approvalRequest && dialog.open) dialog.close();
  }, [approvalRequest]);

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
    try {
      await Promise.all([
        globalSaver.flushAll(), projectSaver.flushAll(), draftSave.current,
        permissionProfileSave.current, skillSelectionSave.current,
      ]);
    } catch (error) {
      setNotice(getErrorMessage(error));
      throw error;
    }
  }), [globalSaver, projectSaver]);

  useEffect(() => () => {
    void Promise.all([globalSaver.flushAll(), projectSaver.flushAll()])
      .catch((error: unknown) => setNotice(getErrorMessage(error)));
  }, [route.page, route.id, settingsSection, globalSaver, projectSaver]);

  useEffect(() => {
    if (!notice || noticeKind === 'error') return;
    const timer = window.setTimeout(() => setNoticeText(''), 2000);
    return () => window.clearTimeout(timer);
  }, [notice, noticeKind, noticeSequence]);

  useEffect(() => {
    if (dialogRequest) {
      dialogRef.current?.showModal();
      (dialogRef.current?.querySelector('input') ?? dialogRef.current?.querySelector<HTMLButtonElement>('.dialog-actions .secondary-button'))?.focus();
    } else dialogRef.current?.close();
  }, [dialogRequest]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const update = () => {
      setCompactLayout(window.innerWidth <= 720);
      setSidebarPreview(false);
    };
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!compactLayout || !sidebarPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarPreview(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [compactLayout, sidebarPreview]);

  useEffect(() => {
    if (route.page === 'settings') {
      document.querySelector<HTMLButtonElement>('.settings-nav-item.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [route.page, settingsSection, compactLayout]);

  useEffect(() => {
    routeRef.current = route;
    if (route.page !== 'project') {
      setProjectInstructionsOpen(false);
      setProjectInstructions('');
    }
    if (route.page === 'chat') {
      const id = route.id;
      if (!id) return;
      const fromHome = homeChatId.current === id;
      if (fromHome) homeChatId.current = null;
      if (!fromHome) {
        setDraft('');
        draftRef.current = '';
        draftSave.current = Promise.resolve();
      }
      let cancelled = false;
      setChatDetail(null);
      void window.gigaChat.chats.get(id).then((detail) => {
        if (cancelled) return;
        setChatDetail(detail);
        if (!fromHome) {
          setDraft(detail.draft);
          draftRef.current = detail.draft;
        }
      }).catch((error: unknown) => { if (!cancelled) setNotice(getErrorMessage(error)); });
      return () => { cancelled = true; };
    } else if (route.page === 'home') {
      setDraft('');
      draftRef.current = '';
      draftSave.current = Promise.resolve();
      homeChatId.current = null;
      setChatDetail(null);
    }
  }, [route.page, route.id]);

  useEffect(() => {
    const chatId = route.page === 'chat' ? route.id : undefined;
    setRuntimeTurns([]);
    if (!chatId) return undefined;
    let cancelled = false;
    const merge = (turn: RuntimeTurnSnapshot): void => {
      if (turn.chatId !== chatId) return;
      setRuntimeTurns((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        byId.set(turn.id, turn);
        return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-12);
      });
      if (turn.status === 'completed') {
        void window.gigaChat.chats.get(chatId).then((detail) => {
          if (!cancelled && routeRef.current.page === 'chat' && routeRef.current.id === chatId) setChatDetail(detail);
        }).catch((error: unknown) => { if (!cancelled) setNotice(getErrorMessage(error)); });
      }
    };
    const unsubscribe = window.gigaChat.runtime.onUpdate(merge);
    void window.gigaChat.runtime.list(chatId).then((turns) => {
      if (cancelled) return;
      setRuntimeTurns((current) => {
        const byId = new Map(turns.map((turn) => [turn.id, turn]));
        for (const turn of current) if (!byId.has(turn.id)) byId.set(turn.id, turn);
        return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-12);
      });
    }).catch((error: unknown) => { if (!cancelled) setNotice(getErrorMessage(error)); });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [route.page, route.id]);

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
    void window.gigaChat.settings.readInstructions()
      .then((contents) => { if (!cancelled) setGlobalInstructions(globalSaver.load('global', contents)); })
      .catch((error: unknown) => { if (!cancelled) setNotice(getErrorMessage(error)); });
    return () => { cancelled = true; };
  }, [route.page, settingsSection, globalSaver]);

  useEffect(() => {
    if (route.page !== 'settings' || settingsSection !== 'permissions') return;
    let cancelled = false;
    void window.gigaChat.permissions.readConfig().then(({ contents, error }) => {
      if (cancelled) return;
      setConfigDraft(contents);
      setConfigSaved(contents);
      setConfigError(error ?? '');
    }).catch((error: unknown) => { if (!cancelled) setConfigError(getErrorMessage(error)); });
    return () => { cancelled = true; };
  }, [route.page, settingsSection]);

  const activeProjects = projects.filter((project) => !project.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const activeChats = chats.filter((chat) => !chat.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const pinnedProjects = activeProjects.filter((project) => project.pinned);
  const unpinnedProjects = activeProjects.filter((project) => !project.pinned);
  const visibleProjects = showAllProjects ? activeProjects : [...pinnedProjects, ...unpinnedProjects.slice(0, 5)];
  const pinnedChats = activeChats.filter((chat) => chat.pinned);
  const unpinnedChats = activeChats.filter((chat) => !chat.pinned);
  const visibleChats = showAllChats ? activeChats : [...pinnedChats, ...unpinnedChats.slice(0, 8)];
  const archivedProjects = projects.filter((project) => project.archived);
  const archivedChats = chats.filter((chat) => chat.archived);
  const selectedChat = chats.find((chat) => chat.id === route.id);
  const selectedProject = projects.find((project) => project.id === route.id);
  const resolvedTheme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;
  const transparentSidebar = settings.sidebarTransparent;
  const canGoBack = navigation.index > 0;
  const canGoForward = navigation.index < navigation.history.length - 1;
  const settingTitle = SETTINGS_SECTIONS.find((item) => item.id === settingsSection)?.label ?? 'Настройки';
  const composerPermissionProfile = selectedChat && chatDetail?.id === selectedChat.id
    ? chatDetail.nextTurnPermissionProfile ?? (pendingPermissionChatIdRef.current === selectedChat.id ? pendingPermissionProfile : null) ?? settings.defaultPermissionProfile
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
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submitMessage();
    }
  }

  function navigate(next: Route): void {
    routeRef.current = next;
    if (next.page !== 'chat') homeChatId.current = null;
    setSidebarPreview(false);
    setNavigation((current) => {
      const entries = current.history.slice(0, current.index + 1);
      if (sameRoute(entries[entries.length - 1], next)) return current;
      entries.push(next);
      return { history: entries, index: entries.length - 1 };
    });
  }

  function openSettings(section: SettingsSection = 'general'): void {
    setSidebarPreview(false);
    setSettingsSection(section);
    routeRef.current = { page: 'settings' };
    setNavigation((current) => {
      const entries = current.history.slice(0, current.index + 1);
      if (sameRoute(entries[entries.length - 1], { page: 'settings' })) return current;
      entries.push({ page: 'settings' });
      return { history: entries, index: entries.length - 1 };
    });
  }

  function moveHistory(delta: -1 | 1): void {
    setNavigation((current) => {
      const index = Math.max(0, Math.min(current.history.length - 1, current.index + delta));
      const next = current.history[index];
      if (!next) return current;
      routeRef.current = next;
      if (next.page !== 'chat') homeChatId.current = null;
      setSidebarPreview(false);
      return { ...current, index };
    });
  }

  async function createChat(projectId: string | null = null, kind: ChatKind = 'text'): Promise<void> {
    try {
      const chat = await window.gigaChat.chats.create(projectId, kind);
      setChats((current) => [chat, ...current]);
      if (routeRef.current.page === 'home' && pendingPermissionProfileRef.current) {
        pendingPermissionChatIdRef.current = chat.id;
      }
      if (routeRef.current.page === 'home' && pendingSkillIdRef.current) {
        pendingSkillChatIdRef.current = chat.id;
        void saveSkillSelectionForChat(chat.id, pendingSkillIdRef.current, skillSelectionRevision.current);
      }
      draftRef.current = '';
      setDraft('');
      setSelectedProjectId('');
      navigate({ page: 'chat', id: chat.id });
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  function saveChatDraft(chatId: string, value: string): void {
    draftSave.current = window.gigaChat.chats.update(chatId, { draft: value });
    void draftSave.current.catch((error: unknown) => setNotice(getErrorMessage(error)));
  }

  async function submitMessage(): Promise<void> {
    const value = draftRef.current.trim();
    if (!value || sending) return;
    if (isUnavailableCompactCommand(value)) {
      showSuccess('/compact станет доступна после подключения модели. История не изменена.');
      return;
    }
    setSending(true);
    try {
      const chatId = routeRef.current.page === 'chat' ? routeRef.current.id
        : homeChatId.current ?? (await pendingChat.current)?.id;
      if (!chatId) throw new Error('Не удалось создать чат. Попробуйте снова.');
      await draftSave.current;
      await permissionProfileSave.current;
      await skillSelectionSave.current;
      const pendingProfile = pendingPermissionChatIdRef.current === chatId ? pendingPermissionProfileRef.current : null;
      if (pendingProfile) await window.gigaChat.chats.update(chatId, { nextTurnPermissionProfile: pendingProfile });
      if (pendingSkillChatIdRef.current !== chatId && pendingSkillIdRef.current) {
        pendingSkillChatIdRef.current = chatId;
        await saveSkillSelectionForChat(chatId, pendingSkillIdRef.current, skillSelectionRevision.current);
      }
      const detail = await window.gigaChat.chats.appendLocalMessage(chatId, value);
      if (routeRef.current.page === 'chat' && routeRef.current.id === chatId) {
        setChatDetail(detail);
        setDraft('');
        draftRef.current = '';
      }
      if (pendingProfile) {
        pendingPermissionProfileRef.current = null;
        pendingPermissionChatIdRef.current = null;
        setPendingPermissionProfile(null);
      }
      setChats(await window.gigaChat.chats.list());
      showSuccess('Не отправлено в GigaChat API. Сообщение сохранено локально.');
    } catch (error) {
      setNotice(getErrorMessage(error));
    } finally {
      setSending(false);
    }
  }

  async function attachFile(): Promise<void> {
    try {
      const chatId = routeRef.current.page === 'chat' ? routeRef.current.id
        : homeChatId.current ?? (await pendingChat.current)?.id ?? null;
      const detail = await window.gigaChat.chats.importFile(chatId ?? null, selectedProjectId || null);
      if (!detail) return;
      setChats(await window.gigaChat.chats.list());
      setChatDetail(detail);
      if (routeRef.current.page === 'home') navigate({ page: 'chat', id: detail.id });
      showSuccess('Файл скопирован в чат.');
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  function changeDraft(value: string, caret = value.length): void {
    setDraft(value);
    setComposerCaret(Math.max(0, Math.min(value.length, caret)));
    setCompletionDismissed(false);
    setCompletionIndex(0);
    draftRef.current = value;
    if (route.page === 'chat' && route.id) {
      saveChatDraft(route.id, value);
      return;
    }
    if (route.page !== 'home') return;
    if (homeChatId.current) {
      saveChatDraft(homeChatId.current, value);
      return;
    }
    if (!value || pendingChat.current) return;

    const creation = window.gigaChat.chats.create(selectedProjectId || null);
    pendingChat.current = creation;
    void creation.then((chat) => {
      homeChatId.current = chat.id;
      if (pendingPermissionProfileRef.current) pendingPermissionChatIdRef.current = chat.id;
      if (pendingSkillIdRef.current) {
        pendingSkillChatIdRef.current = chat.id;
        void saveSkillSelectionForChat(chat.id, pendingSkillIdRef.current, skillSelectionRevision.current);
      }
      setChats((current) => [chat, ...current]);
      if (routeRef.current.page === 'home') navigate({ page: 'chat', id: chat.id });
      saveChatDraft(chat.id, draftRef.current);
    }).catch((error: unknown) => {
      setNotice(getErrorMessage(error));
    }).finally(() => {
      if (pendingChat.current === creation) pendingChat.current = null;
    });
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
    setDialogValue(value);
    setDialogError('');
    setDialogRequest(request);
  }

  function createProject(assignChatId?: string): void { openDialog({ kind: 'create-project', assignChatId }); }
  function renameProject(project: Project): void { openDialog({ kind: 'rename-project', project }, project.name); }

  async function updateProject(project: Project, patch: ProjectPatch): Promise<void> {
    try {
      const updated = await window.gigaChat.projects.update(project.id, patch);
      setProjects((current) => current.map((item) => item.id === project.id ? updated : item));
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  async function chooseProjectFolder(project: Project): Promise<void> {
    try {
      const updated = await window.gigaChat.projects.chooseFolder(project.id);
      setProjects((current) => current.map((item) => item.id === project.id ? updated : item));
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  function removeProject(project: Project): void { openDialog({ kind: 'delete-project', project }); }

  function renameChat(chat: ChatSummary): void { openDialog({ kind: 'rename-chat', chat }, chat.title); }

  async function updateChat(chat: ChatSummary, patch: ChatPatch): Promise<void> {
    try {
      const updated = await window.gigaChat.chats.update(chat.id, patch);
      setChats((current) => current.map((item) => item.id === chat.id ? updated : item));
      setChatDetail((current) => current?.id === chat.id ? { ...current, ...patch } : current);
      if (patch.projectId !== undefined && routeRef.current.page === 'chat' && routeRef.current.id === chat.id) {
        setChatDetail(await window.gigaChat.chats.get(chat.id));
      }
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  async function removeChat(chat: ChatSummary): Promise<void> {
    try {
      const detail = await window.gigaChat.chats.get(chat.id);
      openDialog({ kind: 'delete-chat', chat, hasFiles: detail.artifacts.length > 0 });
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  async function submitDialog(): Promise<void> {
    if (!dialogRequest || dialogBusy) return;
    setDialogBusy(true);
    setDialogError('');
    try {
      const { kind, chat, project } = dialogRequest;
      if (kind === 'create-project') {
        const created = dialogRequest.createdProjectId
          ? projects.find((item) => item.id === dialogRequest.createdProjectId)
          : await window.gigaChat.projects.create(dialogValue);
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
        const updated = await window.gigaChat.projects.update(project.id, { name: dialogValue });
        setProjects((current) => current.map((item) => item.id === project.id ? updated : item));
        showSuccess('Название проекта сохранено.');
      } else if (kind === 'delete-project' && project) {
        await window.gigaChat.projects.remove(project.id);
        setProjects((current) => current.filter((item) => item.id !== project.id));
        setChats((current) => current.map((item) => item.projectId === project.id ? { ...item, projectId: null } : item));
        if (routeRef.current.page === 'project' && routeRef.current.id === project.id) navigate({ page: 'home' });
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

  async function saveCustomConfig(): Promise<void> {
    if (configBusy) return;
    setConfigBusy(true);
    setConfigError('');
    try {
      const saved = await window.gigaChat.permissions.saveConfig(configDraft, configSaved);
      setConfigSaved(saved);
      showSuccess('Пользовательские разрешения сохранены.');
    } catch (error) { setConfigError(getErrorMessage(error)); }
    finally { setConfigBusy(false); }
  }

  async function answerApproval(allowed: boolean): Promise<void> {
    const request = approvalRequest;
    if (!request) return;
    setApprovalRequest(null);
    try { await window.gigaChat.permissions.respond(request.id, allowed); }
    catch (error) { setNotice(getErrorMessage(error)); }
  }

  async function updateLocalSettings(patch: SettingsPatch): Promise<void> {
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

  async function finishOnboarding(): Promise<void> {
    const updated = await window.gigaChat.settings.update({ onboardingCompleted: true });
    setSettings(updated);
    navigate({ page: 'home' });
  }

  async function saveSkillSelectionForChat(chatId: string, skillId: string | null, revision: number): Promise<void> {
    const save = skillSelectionSave.current.catch(() => undefined).then(() =>
      window.gigaChat.chats.update(chatId, { nextTurnSkillId: skillId }),
    );
    skillSelectionSave.current = save;
    try {
      await save;
      if (revision !== skillSelectionRevision.current) return;
      setChatDetail((current) => current?.id === chatId ? { ...current, nextTurnSkillId: skillId } : current);
      if (pendingSkillChatIdRef.current === chatId) {
        pendingSkillIdRef.current = null;
        pendingSkillChatIdRef.current = null;
        setPendingSkillId(null);
      }
    } catch (error) {
      if (revision !== skillSelectionRevision.current) return;
      try {
        const latest = await window.gigaChat.chats.get(chatId);
        setChatDetail((current) => current?.id === chatId ? latest : current);
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

  async function setSkillEnabled(skill: SkillRecord, enabled: boolean): Promise<void> {
    setSkillBusyId(skill.id);
    try { setSkillRegistry(await window.gigaChat.skills.setEnabled(skill.id, enabled)); }
    catch (error) { setNotice(getErrorMessage(error)); }
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
        pendingPermissionProfileRef.current = profile;
        pendingPermissionChatIdRef.current = null;
        setPendingPermissionProfile(profile);
      }
      return;
    }

    const next = profile === settings.defaultPermissionProfile ? null : profile;
    const revision = ++permissionProfileRevision.current;
    setChatDetail((current) => current?.id === selectedChat.id ? { ...current, nextTurnPermissionProfile: next } : current);
    const save = permissionProfileSave.current.catch(() => undefined).then(() =>
      window.gigaChat.chats.update(selectedChat.id, { nextTurnPermissionProfile: next }),
    );
    permissionProfileSave.current = save;
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
          setChatDetail((current) => current?.id === selectedChat.id ? latest : current);
        } catch (readError) {
          setNotice(getErrorMessage(readError));
        }
        setNotice(getErrorMessage(error));
      }
    }
  }

  async function toggleSidebar(): Promise<void> {
    const next = !settings.sidebarVisible;
    setSidebarPreview(false);
    await updateLocalSettings({ sidebarVisible: next });
  }

  async function setProjectInstructionsOpenState(open: boolean): Promise<void> {
    setProjectInstructionsOpen(open);
    if (!open) {
      void projectSaver.flushAll().catch((error: unknown) => setNotice(getErrorMessage(error)));
      return;
    }
    if (!selectedProject) return;
    try {
      const contents = await window.gigaChat.projects.readInstructions(selectedProject.id);
      if (routeRef.current.page === 'project' && routeRef.current.id === selectedProject.id) {
        setProjectInstructions(projectSaver.load(selectedProject.id, contents));
      }
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  function projectMenu(project: Project): ReactNode {
    const currentProject = route.page === 'project' && route.id === project.id;
    return (
      <ActionMenu label={`Действия проекта ${project.name}`}>
        <button type="button" onClick={() => renameProject(project)}><Icon name="edit" />Переименовать</button>
        <button type="button" onClick={() => void updateProject(project, { pinned: !project.pinned })}>
          <Icon name="pin" />{project.pinned ? 'Открепить' : 'Закрепить'}
        </button>
        {!currentProject && <button type="button" onClick={() => navigate({ page: 'project', id: project.id })}><Icon name="folderOpen" />Настройки проекта</button>}
        {!currentProject && project.workingFolder && <button type="button" onClick={() => void window.gigaChat.projects.openFolder(project.id).catch((error: unknown) => setNotice(getErrorMessage(error)))}><Icon name="external" />Открыть папку</button>}
        <button type="button" onClick={() => void updateProject(project, { archived: !project.archived })}>
          <Icon name="archive" />{project.archived ? 'Восстановить из архива' : 'Архивировать'}
        </button>
        <button type="button" className="danger-item" onClick={() => removeProject(project)}><Icon name="trash" />Удалить</button>
      </ActionMenu>
    );
  }

  function chatMenu(chat: ChatSummary): ReactNode {
    return (
      <ActionMenu label={`Действия чата ${chat.title}`}>
        <button type="button" onClick={() => renameChat(chat)}><Icon name="edit" />Переименовать</button>
        <button type="button" onClick={() => void updateChat(chat, { pinned: !chat.pinned })}>
          <Icon name="pin" />{chat.pinned ? 'Открепить' : 'Закрепить'}
        </button>
        <ProjectSubmenu chat={chat} projects={activeProjects} onSelect={(projectId) => void changeChatProject(chat, projectId)} />
        <button type="button" onClick={() => void updateChat(chat, { archived: !chat.archived })}>
          <Icon name="archive" />{chat.archived ? 'Восстановить из архива' : 'Архивировать'}
        </button>
        <button type="button" className="danger-item" onClick={() => void removeChat(chat)}><Icon name="trash" />Удалить</button>
      </ActionMenu>
    );
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
              <SettingRow title="Папка проектов и задач" description={settings.defaultProjectsFolder ?? 'Папка не выбрана.'}>
                <div className="inline-actions">
                  <button type="button" className="secondary-button" onClick={async () => {
                    try {
                      const updated = await window.gigaChat.settings.chooseProjectsFolder();
                      setSettings((current) => ({ ...current, defaultProjectsFolder: updated.defaultProjectsFolder }));
                    } catch (error) { setNotice(getErrorMessage(error)); }
                  }}>Выбрать папку</button>
                  <button type="button" className="icon-button" disabled={!settings.defaultProjectsFolder} aria-label="Открыть папку проектов" title="Открыть папку" onClick={() => void window.gigaChat.settings.openProjectsFolder().catch((error: unknown) => setNotice(getErrorMessage(error)))}><Icon name="external" /></button>
                </div>
              </SettingRow>
              <SettingRow title="Запускать вместе с Windows" description={appInfo?.packaged ? 'Состояние читается непосредственно из Windows.' : 'Доступно в установленной версии приложения.'}>
                <label className="switch-control"><input type="checkbox" checked={autoStart} disabled={!appInfo?.packaged || appInfo.platform !== 'win32'} onChange={(event) => {
                  setAutoStart(event.target.checked);
                  void window.gigaChat.settings.setAutoStart(event.target.checked).then(setAutoStart).catch(async (error: unknown) => {
                    setNotice(getErrorMessage(error));
                    try { setAutoStart(await window.gigaChat.settings.getAutoStart()); }
                    catch (readError) { setNotice(getErrorMessage(readError)); }
                  });
                }} /><span /></label>
              </SettingRow>
              <SettingRow title="Открывать папки в" description="Изменение применяется к папкам проектов и к папке по умолчанию.">
                <select className="settings-select" value={settings.preferredOpener} onChange={(event) => {
                  void updateLocalSettings({ preferredOpener: event.target.value as Settings['preferredOpener'] });
                }}>
                  <option value="system" title="Приложение Windows по умолчанию">По умолчанию (Windows)</option>
                  <option value="explorer">Проводник Windows</option>
                  {openers.some((opener) => opener.id === 'vscode') && <option value="detected-app">Visual Studio Code</option>}
                  {settings.preferredOpener === 'detected-app' && !openers.some((opener) => opener.id === 'vscode') && <option value="detected-app" disabled>Приложение не найдено</option>}
                </select>
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
            <div className="settings-card connection-card"><div className="connection-mark">G</div><div><strong>GigaChat API</strong><p>Провайдер не подключён. Список моделей и их доступность пока не загружены.</p></div><span className="status-pill"><i />Не подключён</span></div>
            <div className="model-settings-list">
              {GIGACHAT_MODELS.map((model) => <button type="button" key={model.id}
                className={`permission-profile permission-profile-selectable${settings.defaultModelId === model.id ? ' selected' : ''}`}
                aria-pressed={settings.defaultModelId === model.id} onClick={() => void updateLocalSettings({ defaultModelId: model.id })}>
                <span className="model-mark">G</span>
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
              <textarea className="config-editor" aria-label="Редактор config.toml" spellCheck={false} value={configDraft}
                onChange={(event) => { setConfigDraft(event.target.value); setConfigError(''); }} />
              <div className="config-actions">
                <span className="config-status" role="status">{configError || (configDraft === configSaved ? 'Сохранено' : 'Есть несохранённые изменения')}</span>
                <button type="button" className="quiet-button" onClick={() => void window.gigaChat.permissions.readConfig().then(({ contents, error }) => {
                  setConfigDraft(contents); setConfigSaved(contents); setConfigError(error ?? '');
                }).catch((error: unknown) => setConfigError(getErrorMessage(error)))}>Обновить с диска</button>
                <button type="button" className="primary-button" disabled={configBusy || configDraft === configSaved} onClick={() => void saveCustomConfig()}>{configBusy ? 'Сохранение…' : 'Сохранить'}</button>
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
              <textarea className="instructions-editor" value={globalInstructions} onChange={(event) => {
                setGlobalInstructions(event.target.value);
                globalSaver.edit('global', event.target.value);
              }} onBlur={() => void globalSaver.flushAll().catch((error: unknown) => setNotice(getErrorMessage(error)))} placeholder="Добавьте общие инструкции для будущих задач…" maxLength={65536} aria-label="Глобальная инструкция GIGACHAT.md" />
              <div className="editor-footer"><span>До 64 КБ · сохраняется в каталоге приложения</span><span role="status" className={`save-status status-${globalInstructionsStatus}`}>{saveStatusLabel(globalInstructionsStatus)}</span></div>
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
                    <select className="settings-select" aria-label="Проект для локальных Skills" value={skillProjectId} onChange={(event) => setSkillProjectId(event.target.value)}>
                      <option value="">Выберите проект</option>
                      {skillProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
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
        return <ConnectionSetup firstRun={false} />;
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
              <SettingRow title="Папка по умолчанию" description={settings.defaultProjectsFolder ?? 'Не выбрана.'}>
                <div className="inline-actions"><button type="button" className="secondary-button" onClick={async () => {
                  try {
                    const updated = await window.gigaChat.settings.chooseProjectsFolder();
                    setSettings((current) => ({ ...current, defaultProjectsFolder: updated.defaultProjectsFolder }));
                  } catch (error) { setNotice(getErrorMessage(error)); }
                }}>Выбрать</button><button type="button" className="icon-button" disabled={!settings.defaultProjectsFolder} aria-label="Открыть папку" onClick={() => void window.gigaChat.settings.openProjectsFolder().catch((error: unknown) => setNotice(getErrorMessage(error)))}><Icon name="external" /></button></div>
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
        return <ConnectionSetup firstRun onContinue={finishOnboarding} />;
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
            <div className="chat-intro">
              <span className="eyebrow">{selectedChat.kind === 'image' ? 'Чат изображений · локально' : 'Локальная история'}</span>
              <h1>{selectedChat.title}</h1>
              <p>Сообщения и файлы хранятся на этом компьютере. GigaChat API пока не подключён.</p>
            </div>
            {chatDetail?.messages.length ? <div className="chat-history" aria-label="История сообщений">
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
      case 'project':
        return selectedProject ? (
          <section className="content-page project-page">
            <div className="page-heading"><span className="eyebrow">Проект</span><h1>{selectedProject.name}</h1><p>Чаты, папка и локальные инструкции этого проекта.</p></div>
            <div className="project-toolbar">
              <button type="button" className="primary-button" onClick={() => void createChat(selectedProject.id)}><Icon name="plus" />Новый чат в проекте</button>
              <button type="button" className="secondary-button" onClick={() => void chooseProjectFolder(selectedProject)}><Icon name="folderOpen" />{selectedProject.workingFolder ? 'Изменить папку' : 'Выбрать папку'}</button>
              <button type="button" className="icon-button" aria-label="Открыть рабочую папку" title="Открыть рабочую папку" disabled={!selectedProject.workingFolder} onClick={() => void window.gigaChat.projects.openFolder(selectedProject.id).catch((error: unknown) => setNotice(getErrorMessage(error)))}><Icon name="external" /></button>
              {projectMenu(selectedProject)}
            </div>
            {selectedProject.workingFolder && <p className="project-path"><Icon name="folder" />{selectedProject.workingFolder}</p>}
            <h2 className="section-title">Чаты проекта</h2>
            {activeChats.filter((chat) => chat.projectId === selectedProject.id).length === 0
              ? <EmptyState title="В проекте пока нет чатов" description="Создайте здесь первый локальный черновик." icon="chat" />
              : <div className="project-chat-list">{activeChats.filter((chat) => chat.projectId === selectedProject.id).map((chat) => (
                  <div className="project-chat-row" key={chat.id}>
                    <button type="button" className="project-chat-main" onClick={() => navigate({ page: 'chat', id: chat.id })}>
                      <Icon name="chat" /><span>{chat.title}<small>{chat.kind === 'image' ? 'Чат изображений' : 'Локальный чат'}</small></span>
                    </button>
                    {chatMenu(chat)}
                  </div>
                ))}</div>}
            <section className="project-instructions">
              <button type="button" className="project-instructions-toggle" aria-expanded={projectInstructionsOpen} onClick={() => void setProjectInstructionsOpenState(!projectInstructionsOpen)}>
                <Icon name="book" /><span><strong>Инструкции проекта</strong><small>AGENTS.md хранится внутри данных приложения.</small></span><Icon name="chevron" className={projectInstructionsOpen ? 'rotated' : ''} />
              </button>
              {projectInstructionsOpen && <div className="project-instructions-editor"><textarea value={projectInstructions} onChange={(event) => {
                setProjectInstructions(event.target.value);
                projectSaver.edit(selectedProject.id, event.target.value);
              }} onBlur={() => void projectSaver.flushAll().catch((error: unknown) => setNotice(getErrorMessage(error)))} maxLength={65536} aria-label="Инструкции проекта AGENTS.md" placeholder="Локальные правила для будущей работы в этом проекте…" /><div className="editor-footer"><span>Не записывается в выбранную рабочую папку.</span><span role="status" className={`save-status status-${projectInstructionsStatus}`}>{saveStatusLabel(projectInstructionsStatus)}</span></div></div>}
            </section>
          </section>
        ) : <section className="content-page"><h1>Проект не найден</h1><button type="button" className="secondary-button" onClick={() => navigate({ page: 'home' })}>На главный экран</button></section>;
      case 'settings':
        return (
          <section className="settings-layout">
            <nav className="settings-nav" aria-label="Разделы настроек">
              <div className="settings-nav-heading"><span className="eyebrow">Приложение</span><h1>Настройки</h1></div>
              {SETTINGS_SECTIONS.map((item) => (
                <button key={item.id} type="button" className={settingsSection === item.id ? 'settings-nav-item active' : 'settings-nav-item'} onClick={() => setSettingsSection(item.id)}>
                  <Icon name={item.icon} /><span>{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="settings-content">
              {settingsSection !== 'browser' && <div className="settings-content-heading"><span className="eyebrow">Настройки</span><h1>{settingTitle}</h1></div>}
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
    : route.page === 'project' ? selectedProject?.name ?? 'Проект'
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
  ].filter(Boolean).join(' ');
  const sidebarShown = compactLayout ? sidebarPreview : settings.sidebarVisible;

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
            title={sidebarShown ? 'Скрыть боковую панель' : 'Показать боковую панель'}
            onClick={() => { if (compactLayout) setSidebarPreview((value) => !value); else void toggleSidebar(); }}
            onPointerEnter={() => { if (!compactLayout && !settings.sidebarVisible) setSidebarPreview(true); }}
            onPointerLeave={() => { if (!compactLayout && !settings.sidebarVisible) setSidebarPreview(false); }}
            onFocus={() => { if (!compactLayout && !settings.sidebarVisible) setSidebarPreview(true); }}
            onBlur={() => { if (!compactLayout && !settings.sidebarVisible) setSidebarPreview(false); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && sidebarPreview) {
                setSidebarPreview(false);
                sidebarButtonRef.current?.blur();
              }
            }}
          ><Icon name="panel" /></button>}
          <button type="button" className="window-action" aria-label="Назад" title="Назад" disabled={!canGoBack} onClick={() => moveHistory(-1)}><Icon name="back" /></button>
          <button type="button" className="window-action" aria-label="Вперёд" title="Вперёд" disabled={!canGoForward} onClick={() => moveHistory(1)}><Icon name="forward" /></button>
        </div>
      </header>

      <div className={sidebarClasses}>
        {compactLayout && sidebarPreview && <button type="button" className="compact-backdrop" aria-label="Закрыть боковую панель" onClick={() => setSidebarPreview(false)} />}
        {route.page !== 'settings' && route.page !== 'onboarding' && <aside
          id="application-sidebar"
          className="sidebar"
          aria-label="Навигация"
          aria-hidden={!sidebarShown}
          inert={!sidebarShown}
        >
          <ActionMenu className="brand-menu" label="Выбрать режим GigaChat" placement="below" trigger={
            <><span className="brand-wordmark">ГИГАЧАТ <i>{runtimeMode === 'api' ? 'API' : 'WEB'}</i></span><Icon name="chevron" className="brand-chevron" /></>
          }>
            <button type="button" aria-pressed={runtimeMode === 'api'} onClick={() => setRuntimeMode('api')}>GigaChat API{runtimeMode === 'api' && <Icon name="check" />}</button>
            <button type="button" aria-pressed={runtimeMode === 'web'} onClick={() => setRuntimeMode('web')}>GigaChat Web{runtimeMode === 'web' && <Icon name="check" />}</button>
            <span className="brand-menu-note">Web: подключение появится позже.</span>
          </ActionMenu>
          <nav className="sidebar-actions" aria-label="Основные действия">
            <button type="button" className={route.page === 'home' ? 'nav-action active' : 'nav-action'} onClick={() => void createChat()}><Icon name="edit" /><span>Новый чат</span></button>
            <button type="button" className={route.page === 'chat' && selectedChat?.kind === 'image' ? 'nav-action active' : 'nav-action'} onClick={() => void createChat(null, 'image')}><Icon name="image" /><span>Сгенерировать изображение</span></button>
            <button type="button" className={route.page === 'video' ? 'nav-action active' : 'nav-action'} onClick={() => navigate({ page: 'video' })}><Icon name="video" /><span>Создать видео</span></button>
            <button type="button" className={route.page === 'podcasts' ? 'nav-action active' : 'nav-action'} onClick={() => navigate({ page: 'podcasts' })}><Icon name="podcast" /><span>Подкасты</span></button>
          </nav>

          <section className="sidebar-section project-section">
            <div className="section-heading"><h2>Проекты</h2><button type="button" className="small-icon-button" aria-label="Создать проект" title="Создать проект" onClick={() => void createProject()}><Icon name="plus" /></button></div>
            {activeProjects.length === 0
              ? <p className="sidebar-empty">Здесь появятся ваши проекты</p>
              : visibleProjects.map((project) => (
                  <div className={route.page === 'project' && route.id === project.id ? 'list-row selected' : 'list-row'} key={project.id}>
                    <button type="button" className="list-row-main" onClick={() => navigate({ page: 'project', id: project.id })}><Icon name="folder" /><span>{project.name}</span></button>
                    {project.pinned && <Icon name="pin" className="pin-mark" />}{projectMenu(project)}
                  </div>
                ))}
            {unpinnedProjects.length > 5 && <button type="button" className="show-more" onClick={() => setShowAllProjects((value) => !value)}>{showAllProjects ? 'Свернуть' : 'Показать больше'}<Icon name="chevron" /></button>}
          </section>

          <section className={activeProjects.length === 0 && activeChats.length === 0 ? 'sidebar-section history-section empty-library' : 'sidebar-section history-section'}>
            <div className="section-heading"><h2>Недавние</h2></div>
            {activeChats.length === 0
              ? <p className="sidebar-empty">Нет чатов</p>
              : visibleChats.map((chat) => (
                  <div className={route.page === 'chat' && route.id === chat.id ? 'list-row selected' : 'list-row'} key={chat.id}>
                    <button type="button" className="list-row-main" onClick={() => navigate({ page: 'chat', id: chat.id })}><Icon name="chat" /><span>{chat.title}</span></button>
                    {chat.pinned && <Icon name="pin" className="pin-mark" />}{chatMenu(chat)}
                  </div>
                ))}
            {unpinnedChats.length > 8 && <button type="button" className="show-more" onClick={() => setShowAllChats((value) => !value)}>{showAllChats ? 'Свернуть' : 'Показать больше'}<Icon name="chevron" /></button>}
            <button type="button" className="archive-link" onClick={() => navigate({ page: 'archive' })}><Icon name="archive" /><span>Архив</span></button>
          </section>

          <div className="profile-area">
            <button type="button" className="profile-button" onClick={() => navigate({ page: 'profile' })}>
              <span className="profile-avatar"><Icon name="user" /></span><span className="profile-copy"><strong>Локальный профиль</strong><small>API не подключён</small></span>
            </button>
            <button type="button" className="profile-settings-button" aria-label="Настройки" onClick={() => openSettings('general')}><Icon name="settings" /><span className="profile-tooltip" role="tooltip">Настройки</span></button>
          </div>
        </aside>}

        <main className={route.page === 'settings' ? 'main-panel settings-panel' : 'main-panel'}>
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
                ><strong>{suggestion.label}</strong><span>{suggestion.description}</span></button>)}
                {composerCompletion.emptyMessage && <p className="composer-suggestions-empty" role="status">{composerCompletion.emptyMessage}</p>}
              </div>}
              <div className="project-picker">
                <ActionMenu className="composer-project-menu" placement="below-start" label="Выбрать проект"
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
                      <button type="button" className="project-picker-option" aria-current={!composerProjectId} onClick={() => {
                        if (route.page === 'chat' && selectedChat) void changeChatProject(selectedChat, '');
                        else setSelectedProjectId('');
                      }}><Icon name="folder" />Без проекта{!composerProjectId && <Icon name="check" />}</button>
                      {activeProjects.filter((project) => project.name.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase())).map((project) =>
                        <button type="button" className="project-picker-option" key={project.id} aria-current={project.id === composerProjectId} onClick={() => {
                          if (route.page === 'chat' && selectedChat) void changeChatProject(selectedChat, project.id);
                          else setSelectedProjectId(project.id);
                        }}><Icon name="folder" /><span>{project.name}</span>{project.id === composerProjectId && <Icon name="check" />}</button>)}
                      {activeProjects.length === 0 && <p className="picker-empty">Пока нет проектов</p>}
                      {activeProjects.length > 0 && !activeProjects.some((project) => project.name.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase())) && <p className="picker-empty">Ничего не найдено</p>}
                    </div>
                    <button type="button" className="project-picker-option project-create-option" onClick={() => createProject(selectedChat?.id)}><Icon name="plus" />Новый проект</button>
                  </div>
                </ActionMenu>
              </div>
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
                  disabled={sending}
                  placeholder={selectedChat?.kind === 'image' ? 'Опишите изображение' : 'Поручите что угодно'}
                  rows={2}
                />
                {selectedComposerSkillId && <div className="composer-skill-selection" role="status">
                  <span><strong>{selectedComposerSkill?.name ?? 'Выбранный Skill недоступен'}</strong><small>{selectedComposerSkill ? `${selectedComposerSkill.scope === 'global' ? 'Global' : selectedComposerSkill.projectName ?? 'Project'} · будет применён при подключении API` : 'Включите Skill в настройках или снимите выбор.'}</small></span>
                  <button type="button" className="quiet-button" aria-label="Снять выбор Skill" title="Снять выбор Skill" onClick={() => void changeComposerSkill(null)}>Снять</button>
                </div>}
                <div className="composer-toolbar">
                  <div className="toolbar-leading">
                  <button type="button" className="attach-button" aria-label="Прикрепить файл" title="Прикрепить файл" onClick={() => void attachFile()}><Icon name="plus" /></button>
                  <ActionMenu className="composer-permission-menu" placement="below-start"
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
                  <ActionMenu className="composer-model-menu" placement="below" label="Выбрать модель GigaChat"
                    disabled={!canChangeComposerPermissionProfile}
                    trigger={<><span className="model-mark">G</span><span>{GIGACHAT_MODELS.find((model) => model.id === composerModelId)?.name ?? 'Выбрать модель'}</span><Icon name="chevron" /></>}>
                    <div className="model-picker-popup"><p className="picker-heading">Модель для следующих ходов</p>
                      <p className="picker-caption">Доступность будет проверена после подключения API.</p>
                      {GIGACHAT_MODELS.map((model) => <button type="button" className="model-picker-option" key={model.id}
                        aria-current={model.id === composerModelId} onClick={() => void changeComposerModel(model.id)}>
                        <span><strong>{model.name}</strong><small>{model.description}</small></span>
                        {model.id === composerModelId && <Icon name="check" />}
                      </button>)}
                    </div>
                  </ActionMenu>
                  <span className="disabled-control" role="note" tabIndex={0} aria-label="Контекст станет доступен после загрузки модели" title="Контекст станет доступен после подключения API.">
                    <button type="button" className="context-ring" disabled aria-label="Использование контекста"><i /></button>
                  </span>
                  <VoiceCaptureControl
                    key={route.page === 'chat' ? route.id ?? 'chat' : 'home'}
                    available={voiceAvailability.available}
                    reason={voiceAvailability.reason}
                    onTranscript={insertVoiceTranscript}
                    onError={setNotice}
                    onSuccess={showSuccess}
                  />
                  <button type="button" className="send-button" disabled={!draft.trim() || sending} aria-label={draft.trim() ? 'Сохранить сообщение локально' : 'Голосовой чат пока недоступен'} title={draft.trim() ? 'Сохранить локально без отправки в API' : 'Голосовой чат пока недоступен'} onClick={() => void submitMessage()}><Icon name={draft.trim() ? 'send' : 'audio'} /></button>
                  </div>
                </div>
              </div>
            </div>
          )}
          {notice && <div className={`notice notice-${noticeKind}`} role={noticeKind === 'error' ? 'alert' : 'status'}><span>{notice}</span><button type="button" aria-label="Закрыть уведомление" onClick={() => setNotice('')}><Icon name="x" /></button></div>}
        </main>
      </div>
      <dialog ref={dialogRef} className="app-dialog" onClose={() => setDialogRequest(null)} onCancel={(event) => { if (dialogBusy) event.preventDefault(); }}>
        {dialogRequest && <form onSubmit={(event) => { event.preventDefault(); void submitDialog(); }}>
          <button type="button" className="dialog-close" aria-label="Закрыть" disabled={dialogBusy} onClick={() => setDialogRequest(null)}><Icon name="x" /></button>
          <h2>{dialogRequest.kind === 'create-project' ? 'Создать проект'
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
          {dialogError && <p className="dialog-error" role="alert">{dialogError}</p>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" disabled={dialogBusy} onClick={() => setDialogRequest(null)}>Отмена</button>
            <button type="submit" className={dialogRequest.kind.startsWith('delete') ? 'danger-button' : 'primary-button'} disabled={dialogBusy}>{dialogBusy ? 'Подождите…' : dialogRequest.kind.startsWith('delete') ? 'Удалить' : dialogRequest.createdProjectId ? 'Повторить перенос' : dialogRequest.kind === 'create-project' ? 'Создать' : 'Сохранить'}</button>
          </div>
        </form>}
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

import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import type {
  AppInfo,
  Chat,
  ChatKind,
  ChatPatch,
  FolderOpener,
  Project,
  ProjectPatch,
  Settings,
  SettingsPatch,
  Theme,
} from './contracts';
import gigaChatLogo from './assets/gigachat-logo.png';
import { createInstructionAutosave, type SaveStatus } from './instruction-autosave';

type Page = 'home' | 'chat' | 'project' | 'settings' | 'images' | 'video' | 'podcasts' | 'archive' | 'profile';
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
  { id: 'browser', label: 'Браузер и Computer Use', icon: 'globe' },
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
};

function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const Component = ICONS[name];
  return <Component className={className ? `icon ${className}` : 'icon'} aria-hidden="true" focusable="false" strokeWidth={1.8} />;
}

function ActionMenu({ children, label, trigger, className = '' }: { children: ReactNode; label: string; trigger?: ReactNode; className?: string }) {
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
    const left = Math.max(edge, Math.min(anchor.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - edge));
    const below = window.innerHeight - anchor.bottom;
    const above = anchor.top;
    const placeAbove = below < popup.offsetHeight + gap + edge && above > below;
    const desiredTop = placeAbove ? anchor.top - popup.offsetHeight - gap : anchor.bottom + gap;
    const top = Math.max(edge, Math.min(desiredTop, window.innerHeight - popup.offsetHeight - edge));
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  useEffect(() => {
    if (!open) return;
    const onResize = () => positionPopup();
    const onScroll = () => popupRef.current?.hidePopover();
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
      <button ref={triggerRef} type="button" aria-label={label} aria-expanded={open} title={label} onClick={() => {
        const popup = popupRef.current;
        if (!popup) return;
        if (popup.matches(':popover-open')) popup.hidePopover();
        else {
          document.querySelectorAll<HTMLDivElement>('.action-menu-content:popover-open').forEach((other) => other.hidePopover());
          popup.showPopover();
          positionPopup();
        }
      }}>{trigger ?? <MoreHorizontal className="icon" aria-hidden="true" />}</button>
      <div ref={popupRef} popover="auto" className="action-menu-content" onToggle={() => setOpen(popupRef.current?.matches(':popover-open') ?? false)} onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button')) popupRef.current?.hidePopover();
      }}>{children}</div>
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
  return error instanceof Error ? error.message : 'Не удалось выполнить действие.';
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
  const [chats, setChats] = useState<Chat[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [runtimeMode, setRuntimeMode] = useState<'api' | 'web'>('api');
  const [navigation, setNavigation] = useState<Navigation>({ history: [{ page: 'home' }], index: 0 });
  const [sidebarPreview, setSidebarPreview] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => window.innerWidth <= 720);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showAllChats, setShowAllChats] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [draft, setDraft] = useState('');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoStart, setAutoStart] = useState(false);
  const [openers, setOpeners] = useState<FolderOpener[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [globalInstructions, setGlobalInstructions] = useState('');
  const [globalInstructionsStatus, setGlobalInstructionsStatus] = useState<SaveStatus>('saved');
  const [integrationTab, setIntegrationTab] = useState<'skills' | 'plugins' | 'tools'>('skills');
  const [projectInstructions, setProjectInstructions] = useState('');
  const [projectInstructionsOpen, setProjectInstructionsOpen] = useState(false);
  const [projectInstructionsStatus, setProjectInstructionsStatus] = useState<SaveStatus>('saved');
  const pendingChat = useRef<Promise<Chat> | null>(null);
  const homeChatId = useRef<string | null>(null);
  const draftRef = useRef('');
  const routeRef = useRef<Route>({ page: 'home' });
  const settingsRevision = useRef(0);
  const sidebarButtonRef = useRef<HTMLButtonElement>(null);
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
      setLoading(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setNotice(getErrorMessage(error));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => window.gigaChat.onCloseRequested(async () => {
    try {
      await Promise.all([globalSaver.flushAll(), projectSaver.flushAll()]);
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
    routeRef.current = route;
    if (route.page === 'chat') {
      const selected = chats.find((chat) => chat.id === route.id);
      const value = selected?.draft ?? '';
      setDraft(value);
      draftRef.current = value;
    } else if (route.page === 'home') {
      setDraft('');
      draftRef.current = '';
      homeChatId.current = null;
    }
    if (route.page !== 'project') {
      setProjectInstructionsOpen(false);
      setProjectInstructions('');
    }
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

  const activeProjects = projects.filter((project) => !project.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const activeChats = chats.filter((chat) => !chat.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const archivedProjects = projects.filter((project) => project.archived);
  const archivedChats = chats.filter((chat) => chat.archived);
  const selectedChat = chats.find((chat) => chat.id === route.id);
  const selectedProject = projects.find((project) => project.id === route.id);
  const resolvedTheme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;
  const transparentSidebar = settings.sidebarTransparent;
  const canGoBack = navigation.index > 0;
  const canGoForward = navigation.index < navigation.history.length - 1;
  const settingTitle = SETTINGS_SECTIONS.find((item) => item.id === settingsSection)?.label ?? 'Настройки';
  const disabledReason = 'Станет доступно после подключения GigaChat API.';

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
      draftRef.current = '';
      setDraft('');
      setSelectedProjectId('');
      navigate({ page: 'chat', id: chat.id });
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  function saveChatDraft(chatId: string, value: string): void {
    setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, draft: value } : chat));
    void window.gigaChat.chats.update(chatId, { draft: value }).catch((error: unknown) => setNotice(getErrorMessage(error)));
  }

  function changeDraft(value: string): void {
    setDraft(value);
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
      setChats((current) => [chat, ...current]);
      if (routeRef.current.page === 'home') navigate({ page: 'chat', id: chat.id });
      saveChatDraft(chat.id, draftRef.current);
    }).catch((error: unknown) => {
      setNotice(getErrorMessage(error));
    }).finally(() => {
      if (pendingChat.current === creation) pendingChat.current = null;
    });
  }

  async function createProject(): Promise<void> {
    const name = window.prompt('Название проекта');
    if (name === null) return;
    try {
      const project = await window.gigaChat.projects.create(name);
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setNotice(`Проект «${project.name}» создан.`);
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  async function renameProject(project: Project): Promise<void> {
    const name = window.prompt('Новое название проекта', project.name);
    if (name === null) return;
    try {
      const updated = await window.gigaChat.projects.update(project.id, { name });
      setProjects((current) => current.map((item) => item.id === project.id ? updated : item));
      setNotice('Название проекта сохранено.');
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

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

  async function removeProject(project: Project): Promise<void> {
    if (!window.confirm(`Удалить проект «${project.name}»? Его чаты останутся и будут отвязаны от проекта.`)) return;
    try {
      await window.gigaChat.projects.remove(project.id);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      setChats((current) => current.map((chat) => chat.projectId === project.id ? { ...chat, projectId: null } : chat));
      if (routeRef.current.page === 'project' && routeRef.current.id === project.id) navigate({ page: 'home' });
      setNotice('Проект удалён. Его чаты сохранены.');
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  async function renameChat(chat: Chat): Promise<void> {
    const title = window.prompt('Новое название чата', chat.title);
    if (title === null) return;
    try {
      const updated = await window.gigaChat.chats.update(chat.id, { title });
      setChats((current) => current.map((item) => item.id === chat.id ? updated : item));
      setNotice('Название чата сохранено.');
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  async function updateChat(chat: Chat, patch: ChatPatch): Promise<void> {
    try {
      const updated = await window.gigaChat.chats.update(chat.id, patch);
      setChats((current) => current.map((item) => item.id === chat.id ? updated : item));
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  async function removeChat(chat: Chat): Promise<void> {
    if (!window.confirm(`Удалить чат «${chat.title}»? Это действие нельзя отменить.`)) return;
    try {
      await window.gigaChat.chats.remove(chat.id);
      setChats((current) => current.filter((item) => item.id !== chat.id));
      if (routeRef.current.page === 'chat' && routeRef.current.id === chat.id) navigate({ page: 'home' });
      setNotice('Чат удалён.');
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  async function changeChatProject(chat: Chat, projectId: string): Promise<void> {
    await updateChat(chat, { projectId: projectId || null });
  }

  async function updateLocalSettings(patch: SettingsPatch): Promise<void> {
    const revision = ++settingsRevision.current;
    setSettings((current) => ({ ...current, ...patch }));
    try {
      const updated = await window.gigaChat.settings.update(patch);
      if (revision === settingsRevision.current) setSettings(updated);
    } catch (error) {
      setNotice(getErrorMessage(error));
      if (revision === settingsRevision.current) {
        try { setSettings(await window.gigaChat.settings.get()); }
        catch (readError) { setNotice(getErrorMessage(readError)); }
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
    return (
      <ActionMenu label={`Действия проекта ${project.name}`}>
        <button type="button" onClick={() => void renameProject(project)}>Переименовать</button>
        <button type="button" onClick={() => void updateProject(project, { pinned: !project.pinned })}>
          {project.pinned ? 'Открепить' : 'Закрепить'}
        </button>
        <button type="button" onClick={() => navigate({ page: 'project', id: project.id })}>Открыть проект</button>
        <button type="button" onClick={() => void updateProject(project, { archived: !project.archived })}>
          {project.archived ? 'Восстановить из архива' : 'Архивировать'}
        </button>
        <button type="button" className="danger-item" onClick={() => void removeProject(project)}>Удалить</button>
      </ActionMenu>
    );
  }

  function chatMenu(chat: Chat): ReactNode {
    return (
      <ActionMenu label={`Действия чата ${chat.title}`}>
        <button type="button" onClick={() => void renameChat(chat)}>Переименовать</button>
        <button type="button" onClick={() => void updateChat(chat, { pinned: !chat.pinned })}>
          {chat.pinned ? 'Открепить' : 'Закрепить'}
        </button>
        <details className="submenu">
          <summary>Переместить в проект<ChevronRight className="icon" aria-hidden="true" /></summary>
          <div className="submenu-content">
            <button type="button" onClick={() => void changeChatProject(chat, '')}>Без проекта</button>
            {activeProjects.map((project) => (
              <button key={project.id} type="button" onClick={() => void changeChatProject(chat, project.id)}>
                {project.name}
              </button>
            ))}
          </div>
        </details>
        <button type="button" onClick={() => void updateChat(chat, { archived: !chat.archived })}>
          {chat.archived ? 'Восстановить из архива' : 'Архивировать'}
        </button>
        <button type="button" className="danger-item" onClick={() => void removeChat(chat)}>Удалить</button>
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
            <div className="settings-section-heading"><h2>Модели и лимиты</h2><p>Сведения появятся после подключения GigaChat API.</p></div>
            <div className="settings-card connection-card"><div className="connection-mark">G</div><div><strong>GigaChat API</strong><p>Провайдер не подключён. Список моделей и их доступность пока не загружены.</p></div><span className="status-pill"><i />Не подключён</span></div>
            <EmptyState title="Список моделей пока пуст" description="Здесь появятся доступные модели и подтверждённые данные о лимитах. Значения не подменяются нулями." icon="gauge" />
          </>
        );
      case 'permissions':
        return (
          <>
            <div className="settings-section-heading"><h2>Разрешения</h2><p>Профили появятся вместе с механизмом разрешений. Сейчас выбор не сохраняется и не влияет на доступ.</p></div>
            <div className="permission-profile-list">
              {[
                ['Спросить перед действием', 'Действия внутри заданной границы; запросы на расширение подтверждает пользователь.'],
                ['Подтверждать за меня', 'Действия остаются ограниченными; подходящие запросы сможет обработать политика приложения.'],
                ['Полный доступ', 'Широкий доступ к системе. Этот режим не включён до появления защитного механизма.'],
                ['Настроить вручную', 'Редактор профиля будет добавлен вместе с permission engine.'],
              ].map(([name, description]) => (
                <article className="permission-profile disabled-card" key={name}>
                  <Icon name="lock" /><div><strong>{name}</strong><p>{description}</p></div><span className="status-label">Недоступно</span>
                </article>
              ))}
            </div>
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
      case 'integrations':
        return (
          <>
            <div className="settings-section-heading"><h2>Skills и интеграции</h2><p>Подключение инструментов будет добавлено в следующих планах.</p></div>
            <div className="settings-tabs" role="tablist" aria-label="Интеграции">
              {([['skills', 'Skills'], ['plugins', 'Plugins / MCP'], ['tools', 'Tools']] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={integrationTab === id} className={integrationTab === id ? 'active' : ''} onClick={() => setIntegrationTab(id)}>{label}</button>
              ))}
            </div>
            <EmptyState title={integrationTab === 'skills' ? 'Skills не установлены' : integrationTab === 'plugins' ? 'Plugins / MCP не подключены' : 'Инструменты не настроены'} description="Здесь появятся реальные записи, источник и состояние включения. Skills Codex не являются Skills этого приложения." icon="puzzle" />
          </>
        );
      case 'hooks':
        return (
          <>
            <div className="settings-section-heading"><h2>Hooks</h2><p>Панель подготовлена; произвольные скрипты пока не запускаются.</p></div>
            <div className="settings-card settings-list">
              {['Начало сессии / проекта', 'Отправка запроса', 'Перед инструментом', 'После инструмента', 'Запрос разрешения', 'Перед сжатием контекста', 'После сжатия контекста', 'Остановка и завершение'].map((name) => (
                <SettingRow key={name} title={name} description="Global · Project · Skill · Plugin"><span className="status-label">Нет runtime</span></SettingRow>
              ))}
            </div>
          </>
        );
      case 'browser':
        return (
          <>
            <div className="settings-section-heading"><h2>Браузер и Computer Use</h2><p>Браузерный runtime ещё не подключён.</p></div>
            <EmptyState title="Не настроено" description="Встроенный и внешний браузер, а также управление компьютером появятся после отдельного подключения runtime." icon="globe" />
          </>
        );
      case 'voice':
        return (
          <>
            <div className="settings-section-heading"><h2>Голос</h2><p>Состояние микрофона и локального распознавания будет показано при наличии voice runtime.</p></div>
            <div className="settings-card settings-list">
              <SettingRow title="Диктовка" description="Микрофон не используется приложением."><span className="status-label">Не настроено</span></SettingRow>
              <SettingRow title="GigaAM" description="Локальная модель не подключена."><span className="status-label">Не загружена</span></SettingRow>
              <SettingRow title="Синтез речи" description="Голосовой ответ — FUTURE."><span className="status-label">Позже</span></SettingRow>
            </div>
          </>
        );
      case 'notifications':
        return (
          <>
            <div className="settings-section-heading"><h2>Уведомления</h2><p>Категории перечислены заранее. Настройки появятся вместе с реальными уведомлениями.</p></div>
            <div className="settings-card settings-list">
              {['Ответ готов, когда приложение не в фокусе', 'Ожидающая задача запущена', 'Ошибка требует внимания'].map((name) => (
                <SettingRow key={name} title={name}><span className="status-label">Пока недоступно</span></SettingRow>
              ))}
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
      case 'home':
        return (
          <section className="empty-state">
            <img className="empty-logo" src={gigaChatLogo} alt="" />
            <h1>Что будем создавать?</h1>
            <p>Ваши идеи. Возможности ГигаЧат.</p>
          </section>
        );
      case 'chat':
        return selectedChat ? (
          <section className="chat-view">
            <div className="chat-intro">
              <span className="eyebrow">{selectedChat.kind === 'image' ? 'Чат изображений · локальный черновик' : 'Локальный черновик'}</span>
              <h1>{selectedChat.title}</h1>
              {selectedChat.kind === 'image'
                ? <p>Сохранённая оболочка запроса. Генерация изображений подключится вместе с GigaChat API.</p>
                : <p>GigaChat API не подключён. Текст сохранится в черновике, но не будет отправлен.</p>}
            </div>
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
                      <Icon name="chat" /><span>{chat.title}<small>{chat.kind === 'image' ? 'Чат изображений' : 'Черновик'}</small></span>
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
              <div className="settings-content-heading"><span className="eyebrow">Настройки</span><h1>{settingTitle}</h1></div>
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
            <div className="usage-grid"><article><span>Всего чатов</span><strong>{chats.length}</strong><small>Локальные черновики</small></article><article><span>Всего проектов</span><strong>{projects.length}</strong><small>Локальные проекты</small></article><article className="usage-unavailable"><span>Токены и модели</span><strong>—</strong><small>Нет данных API</small></article></div>
            <EmptyState title="Статистика модели пока не собирается" description="Токены, серии активности и вызовы инструментов не показываются без реальных измерений." icon="gauge" />
            <div className="profile-actions"><button type="button" className="secondary-button" onClick={() => openSettings('general')}><Icon name="settings" />Настройки</button><button type="button" className="secondary-button" onClick={() => navigate({ page: 'archive' })}><Icon name="archive" />Архив</button></div>
          </section>
        );
    }
  }

  const title = route.page === 'home' ? 'Новый чат'
    : route.page === 'chat' ? selectedChat?.title ?? 'Чат'
    : route.page === 'project' ? selectedProject?.name ?? 'Проект'
    : route.page === 'images' ? 'Изображения'
    : route.page === 'video' ? 'Видео'
    : route.page === 'podcasts' ? 'Подкасты'
    : route.page === 'archive' ? 'Архив'
    : route.page === 'profile' ? 'Профиль'
    : settingTitle;
  const composerProjectId = route.page === 'chat' ? selectedChat?.projectId ?? '' : selectedProjectId;
  const sidebarClasses = [
    'workspace',
    route.page === 'settings' ? 'settings-workspace' : '',
    compactLayout ? 'compact-workspace' : '',
    compactLayout || !settings.sidebarVisible ? 'sidebar-hidden' : '',
    sidebarPreview ? 'sidebar-preview' : '',
  ].filter(Boolean).join(' ');
  const sidebarShown = compactLayout ? sidebarPreview : settings.sidebarVisible;

  return (
    <div className={`app-frame theme-${resolvedTheme}${transparentSidebar ? ' sidebar-transparent' : ''}`}>
      <header className="titlebar" aria-label={`Панель приложения: ${title}`}>
        <div className="titlebar-actions">
          {route.page !== 'settings' && <button
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
        {route.page !== 'settings' && <aside
          id="application-sidebar"
          className="sidebar"
          aria-label="Навигация"
          aria-hidden={!sidebarShown}
          inert={!sidebarShown}
        >
          <ActionMenu className="brand-menu" label="Выбрать режим GigaChat" trigger={
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
              : activeProjects.slice(0, showAllProjects ? undefined : 5).map((project) => (
                  <div className={route.page === 'project' && route.id === project.id ? 'list-row selected' : 'list-row'} key={project.id}>
                    <button type="button" className="list-row-main" onClick={() => navigate({ page: 'project', id: project.id })}><Icon name="folder" /><span>{project.name}</span></button>
                    {project.pinned && <Icon name="pin" className="pin-mark" />}{projectMenu(project)}
                  </div>
                ))}
            {activeProjects.length > 5 && <button type="button" className="show-more" onClick={() => setShowAllProjects((value) => !value)}>{showAllProjects ? 'Свернуть' : 'Показать больше'}<Icon name="chevron" /></button>}
          </section>

          <section className={activeProjects.length === 0 && activeChats.length === 0 ? 'sidebar-section history-section empty-library' : 'sidebar-section history-section'}>
            <div className="section-heading"><h2>Недавние</h2></div>
            {activeChats.length === 0
              ? <p className="sidebar-empty">Нет чатов</p>
              : activeChats.slice(0, showAllChats ? undefined : 8).map((chat) => (
                  <div className={route.page === 'chat' && route.id === chat.id ? 'list-row selected' : 'list-row'} key={chat.id}>
                    <button type="button" className="list-row-main" onClick={() => navigate({ page: 'chat', id: chat.id })}><Icon name="chat" /><span>{chat.title}</span></button>
                    {chat.pinned && <Icon name="pin" className="pin-mark" />}{chatMenu(chat)}
                  </div>
                ))}
            {activeChats.length > 8 && <button type="button" className="show-more" onClick={() => setShowAllChats((value) => !value)}>{showAllChats ? 'Свернуть' : 'Показать больше'}<Icon name="chevron" /></button>}
            <button type="button" className="archive-link" onClick={() => navigate({ page: 'archive' })}><Icon name="archive" /><span>Архив</span></button>
          </section>

          <div className="profile-area">
            <button type="button" className="profile-button" onClick={() => navigate({ page: 'profile' })}>
              <span className="profile-avatar"><Icon name="user" /></span><span className="profile-copy"><strong>Локальный профиль</strong><small>API не подключён</small></span>
            </button>
            <ActionMenu label="Меню профиля">
              <button type="button" onClick={() => openSettings('general')}>Настройки</button>
              <button type="button" onClick={() => navigate({ page: 'archive' })}>Архив</button>
              <button type="button" onClick={() => navigate({ page: 'profile' })}>Профиль</button>
            </ActionMenu>
          </div>
        </aside>}

        <main className={route.page === 'settings' ? 'main-panel settings-panel' : 'main-panel'}>
          <div className="panel-controls">
            <button type="button" className="panel-control" aria-label="Справка" title="Справка появится вместе с подключением API" disabled><Icon name="help" /></button>
            <button type="button" className="panel-control" aria-label="Настройки" title="Настройки" onClick={() => openSettings('general')}><Icon name="settings" /></button>
          </div>
          <div className={route.page === 'home' ? 'view-area home-view' : route.page === 'settings' ? 'view-area settings-view' : 'view-area'}>{renderContent()}</div>
          {(route.page === 'home' || route.page === 'chat') && (
            <div className="composer-stack">
              <label className="project-picker"><Icon name="folder" />
                <span className="project-picker-select">
                <select value={composerProjectId} aria-label="Выбрать проект" onChange={(event) => {
                  const projectId = event.target.value;
                  if (route.page === 'chat' && selectedChat) void changeChatProject(selectedChat, projectId);
                  else setSelectedProjectId(projectId);
                }}>
                  <option value="">Выбрать проект</option>
                  {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select><Icon name="chevron" className="picker-chevron" />
                </span>
              </label>
              <div className="composer">
                <label className="sr-only" htmlFor="chat-draft">Черновик сообщения</label>
                <textarea id="chat-draft" value={draft} onChange={(event) => changeDraft(event.target.value)} placeholder={selectedChat?.kind === 'image' ? 'Опишите изображение' : 'Поручите что угодно'} rows={2} />
                <div className="composer-toolbar">
                  <div className="toolbar-leading">
                  <span className="disabled-control" role="note" tabIndex={0} aria-label="Вложения недоступны до подключения GigaChat API" title="Вложения появятся после подключения GigaChat API.">
                    <button type="button" className="attach-button" disabled aria-label="Прикрепить файл"><Icon name="plus" /></button>
                  </span>
                  <span className="disabled-control permission-control" role="note" tabIndex={0} aria-label="Профили доступа пока недоступны" title="Профили разрешений появятся вместе с permission engine.">
                    <button type="button" className="permission-button" disabled><Icon name="shield" /><span>Подтверждать за меня</span><Icon name="chevron" /></button>
                  </span>
                  </div>
                  <div className="toolbar-trailing">
                  <span className="disabled-control" role="note" tabIndex={0} aria-label={`Выбор модели: ${disabledReason}`} title={disabledReason}>
                    <button type="button" className="model-button" disabled><span className="model-mark">G</span><span>Выбрать модель</span><Icon name="chevron" /></button>
                  </span>
                  <span className="disabled-control" role="note" tabIndex={0} aria-label="Контекст станет доступен после загрузки модели" title="Контекст станет доступен после подключения API.">
                    <button type="button" className="context-ring" disabled aria-label="Использование контекста"><i /></button>
                  </span>
                  <span className="disabled-control" role="note" tabIndex={0} aria-label="Диктовка появится в отдельном плане" title="Диктовка появится в отдельном плане.">
                    <button type="button" className="mic-button" disabled aria-label="Диктовка"><Icon name="mic" /></button>
                  </span>
                  <span className="disabled-control" role="note" tabIndex={0} aria-label={`Отправка недоступна: ${disabledReason}`} title={disabledReason}>
                    <button type="button" className="send-button" disabled aria-label="Отправить"><Icon name="audio" /></button>
                  </span>
                  </div>
                </div>
              </div>
            </div>
          )}
          {notice && <div className="notice" role="status"><span>{notice}</span><button type="button" aria-label="Закрыть уведомление" onClick={() => setNotice('')}><Icon name="x" /></button></div>}
        </main>
      </div>
    </div>
  );
}

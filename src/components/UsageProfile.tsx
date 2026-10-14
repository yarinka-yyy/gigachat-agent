import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { Activity, BarChart3, CalendarDays, CircleHelp, RefreshCw, Sparkles, Wrench, X } from 'lucide-react';
import type {
  BalanceFamilyId,
  ProviderConnectionSnapshot,
  RuntimeTurnSnapshot,
  StudioBalanceAnchorInput,
  UsageAggregate,
  UsageProfileDay,
  UsageProfileView,
} from '../contracts';
import { CHAT_MODEL_FAMILIES } from '../model-catalog';

type ChartMode = 'day' | 'week' | 'cumulative';
type Amounts = Record<BalanceFamilyId, number>;
type ChartPoint = {
  date: string;
  values: Amounts;
  unmappedTokens: number;
  totalKnownTokens: number;
  unknownRequests: number;
  conflictedRequests: number;
};
type ChartRange = '30d' | '90d' | '12m';

const FAMILY_IDS: BalanceFamilyId[] = ['ultra', 'max', 'pro', 'lite'];
const NUMBER_FORMAT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const FULL_DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const SHORT_DATE = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const MONTH_LABEL = new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' });

function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatDay(day: string, formatter = FULL_DATE): string {
  return formatter.format(new Date(`${day}T12:00:00.000Z`));
}

function formatTimestamp(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(time)) : 'дата неизвестна';
}

function pluralRequests(value: number): string {
  const rule = new Intl.PluralRules('ru-RU').select(value);
  return `${formatNumber(value)} ${rule === 'one' ? 'запрос' : rule === 'few' ? 'запроса' : 'запросов'}`;
}

function familyLabel(family: BalanceFamilyId): string {
  return CHAT_MODEL_FAMILIES.find((item) => item.family === family)?.displayName ?? 'GigaChat';
}

function knownTokens(aggregate: UsageAggregate): string {
  const value = aggregate.totalTokens;
  if (aggregate.requestCount === 0) return '0';
  if (value.knownTokens === 0 && (value.unknownRequests > 0 || value.conflictedRequests > 0)) return 'Неизвестно';
  if (value.unknownRequests === 0 && value.conflictedRequests === 0) return formatNumber(value.knownTokens);
  return `${formatNumber(value.knownTokens)} известно`;
}

function weekday(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

function heatmapColumns(days: readonly UsageProfileDay[]): Array<Array<UsageProfileDay | null>> {
  if (days.length === 0) return [];
  const cells: Array<UsageProfileDay | null> = Array(weekday(days[0]!.date)).fill(null);
  cells.push(...days);
  while (cells.length % 7 !== 0) cells.push(null);
  const columns: Array<Array<UsageProfileDay | null>> = [];
  for (let index = 0; index < cells.length; index += 7) columns.push(cells.slice(index, index + 7));
  return columns;
}

function monthLabels(days: readonly UsageProfileDay[]): Array<{ week: number; label: string }> {
  if (days.length === 0) return [];
  const offset = weekday(days[0]!.date);
  const seen = new Set<string>();
  const labels: Array<{ week: number; label: string }> = [];
  days.forEach((day, index) => {
    const month = day.date.slice(0, 7);
    if (seen.has(month)) return;
    seen.add(month);
    labels.push({ week: Math.floor((index + offset) / 7), label: MONTH_LABEL.format(new Date(`${day.date.slice(0, 7)}-01T12:00:00.000Z`)).replace('.', '') });
  });
  return labels;
}

function dayAmounts(day: UsageProfileDay): Amounts {
  return Object.fromEntries(FAMILY_IDS.map((family) => [
    family,
    day.byFamily.find((item) => item.key === family)?.totalTokens.knownTokens ?? 0,
  ])) as Amounts;
}

function dayUnmappedTokens(day: UsageProfileDay): number {
  return day.byFamily.find((item) => item.key === 'unknown')?.totalTokens.knownTokens ?? 0;
}

function dayFamilyTokens(day: UsageProfileDay, family: BalanceFamilyId): string {
  const aggregate = day.byFamily.find((item) => item.key === family);
  const unmapped = day.byFamily.find((item) => item.key === 'unknown');
  if (unmapped?.requestCount) return 'Неизвестно';
  return aggregate ? knownTokens(aggregate) : '0';
}

function dayUncertainty(day: UsageProfileDay): { unknownRequests: number; conflictedRequests: number } {
  return {
    unknownRequests: day.aggregate.totalTokens.unknownRequests,
    conflictedRequests: day.aggregate.totalTokens.conflictedRequests,
  };
}

function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function chartPoints(days: readonly UsageProfileDay[], mode: ChartMode): ChartPoint[] {
  const daily = days.map((day) => ({
    date: day.date,
    values: dayAmounts(day),
    unmappedTokens: dayUnmappedTokens(day),
    totalKnownTokens: day.aggregate.totalTokens.knownTokens,
    ...dayUncertainty(day),
  }));
  if (mode === 'day') return daily;
  if (mode === 'week') {
    const weeks = new Map<string, ChartPoint>();
    for (const day of daily) {
      const key = weekStart(day.date);
      const current = weeks.get(key) ?? {
        date: key,
        values: { ultra: 0, max: 0, pro: 0, lite: 0 },
        unmappedTokens: 0,
        totalKnownTokens: 0,
        unknownRequests: 0,
        conflictedRequests: 0,
      };
      for (const family of FAMILY_IDS) current.values[family] += day.values[family];
      current.unmappedTokens += day.unmappedTokens;
      current.totalKnownTokens += day.totalKnownTokens;
      current.unknownRequests += day.unknownRequests;
      current.conflictedRequests += day.conflictedRequests;
      weeks.set(key, current);
    }
    return [...weeks.values()];
  }
  const running: Amounts = { ultra: 0, max: 0, pro: 0, lite: 0 };
  let runningUnmapped = 0;
  let runningTotal = 0;
  let runningUnknownRequests = 0;
  let runningConflictedRequests = 0;
  return daily.map((day) => {
    for (const family of FAMILY_IDS) running[family] += day.values[family];
    runningUnmapped += day.unmappedTokens;
    runningTotal += day.totalKnownTokens;
    runningUnknownRequests += day.unknownRequests;
    runningConflictedRequests += day.conflictedRequests;
    return {
      ...day,
      values: { ...running },
      unmappedTokens: runningUnmapped,
      totalKnownTokens: runningTotal,
      unknownRequests: runningUnknownRequests,
      conflictedRequests: runningConflictedRequests,
    };
  });
}

function aggregateUnknown(aggregate: UsageAggregate): number {
  return aggregate.totalTokens.unknownRequests + aggregate.totalTokens.conflictedRequests;
}

function balanceCopy(state: string): string {
  return state === 'missing' ? 'Нет строки для этого семейства.'
    : state === 'ambiguous' ? 'Строку остатка нельзя сопоставить однозначно.'
      : state === 'expired' ? 'Срок сверки истёк. Обновите данные на сайте.'
        : 'Нет подтверждённого остатка.';
}

function safeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message.trim()) return fallback;
  const message = error.message
    .replace(/^Error invoking remote method '[^']+': (?:Error: |GigaChatProviderError:\s*)/, '')
    .replace(/^GigaChatProviderError:\s*/, '')
    .trim();
  const category = /^(auth|tls|network|rate-limit|quota|model|context|protocol|tool|storage|cancel)$/.exec(message)?.[1];
  const categoryCopy: Record<string, string> = {
    auth: 'Не удалось подтвердить подключение к аккаунту. Проверьте подключение и повторите сверку.',
    tls: 'Не удалось проверить защищённое соединение. Остаток не обновлён.',
    network: 'Не удалось связаться с сервером. Остаток не обновлён; попробуйте позже.',
    'rate-limit': 'Сервер временно ограничил запросы. Попробуйте обновить остаток позже.',
    quota: 'Сервер не подтвердил остаток. Проверьте сведения аккаунта и повторите сверку.',
    model: 'Сервер не подтвердил доступ к модели. Остаток не обновлён.',
    context: 'Сервер отклонил запрос сверки. Остаток не обновлён.',
    protocol: 'Ответ сервера не удалось проверить. Остаток не обновлён.',
    tool: 'Не удалось получить сведения об остатке. Попробуйте позже.',
    storage: 'Не удалось сохранить сверку на этом устройстве.',
    cancel: 'Сверка была отменена; сохранённые данные не изменены.',
  };
  if (category) return categoryCopy[category] ?? fallback;
  const knownMessages = new Map([
    ['Сверка уже выполняется.', 'Сверка уже выполняется. Дождитесь её завершения.'],
    ['Сначала подключитесь к аккаунту GigaChat.', 'Для сверки по API сначала подключитесь к аккаунту GigaChat.'],
    ['Сверка доступна после завершения всех ходов.', 'Дождитесь завершения текущих ходов и повторите действие.'],
    ['Сохранённый ключ аккаунта недоступен.', 'Сохранённый ключ аккаунта недоступен. Проверьте подключение.'],
    ['Ключ аккаунта изменился во время сверки. Повторите действие.', 'Ключ аккаунта изменился во время сверки. Повторите действие.'],
    ['Подключение изменилось во время сверки. Повторите действие.', 'Подключение изменилось во время сверки. Повторите действие.'],
  ]);
  return knownMessages.get(message) ?? fallback;
}

function chartPointLabel(point: ChartPoint): string {
  const uncertain = point.unknownRequests + point.conflictedRequests;
  const familyBreakdownUnknown = uncertain > 0 || point.unmappedTokens > 0;
  const families = FAMILY_IDS.map((family) => `${familyLabel(family)}: ${familyBreakdownUnknown
    ? point.values[family] > 0 ? `${formatNumber(point.values[family])} известно` : 'неизвестно'
    : formatNumber(point.values[family])}`).join(', ');
  const unmapped = point.unmappedTokens ? ` Не сопоставлено с семейством: ${formatNumber(point.unmappedTokens)} токенов.` : '';
  const total = point.totalKnownTokens === 0 && uncertain > 0 ? 'неизвестно'
    : `${formatNumber(point.totalKnownTokens)} токенов${uncertain > 0 ? ' известно; неполный расход неизвестен' : ''}`;
  return `${formatDay(point.date)}. ${families}.${unmapped} Всего: ${total}${uncertain ? `; неполных запросов: ${uncertain}` : ''}.`;
}

function chartFamilyValue(point: ChartPoint, family: BalanceFamilyId): string {
  const incomplete = point.unknownRequests + point.conflictedRequests > 0 || point.unmappedTokens > 0;
  const value = point.values[family];
  if (!incomplete) return formatNumber(value);
  return value > 0 ? `${formatNumber(value)} известно` : 'Неизвестно';
}

function chartTotalValue(point: ChartPoint): string {
  const incomplete = point.unknownRequests + point.conflictedRequests > 0;
  if (point.totalKnownTokens === 0 && incomplete) return 'Неизвестно';
  return `${formatNumber(point.totalKnownTokens)}${incomplete ? ' известно' : ''}`;
}

function chartAxisValue(value: number): string {
  return value >= 1_000_000 ? COMPACT_NUMBER_FORMAT.format(value) : formatNumber(value);
}

function dateRangeLabel(mode: ChartMode, range: ChartRange): string {
  const period = range === '30d' ? 'последние 30 дней' : range === '90d' ? 'последние 90 дней' : 'последние 12 месяцев';
  return mode === 'week' ? `Недели за ${period}, с понедельника` : mode === 'cumulative' ? `Нарастающий итог за ${period}` : `Каждый день за ${period}`;
}

export default function UsageProfile({
  skillNames,
  onOpenConnection,
}: {
  skillNames: readonly { id: string; name: string }[];
  onOpenConnection: () => void;
}) {
  const [view, setView] = useState<UsageProfileView | null>(null);
  const viewRef = useRef<UsageProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [connection, setConnection] = useState<ProviderConnectionSnapshot | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [refreshingBalance, setRefreshingBalance] = useState(false);
  const [balanceError, setBalanceError] = useState('');
  const [anchorOpen, setAnchorOpen] = useState(false);
  const [anchorBusy, setAnchorBusy] = useState(false);
  const [anchorError, setAnchorError] = useState('');
  const [anchorSaved, setAnchorSaved] = useState('');
  const [anchorAmounts, setAnchorAmounts] = useState<Record<BalanceFamilyId, string>>({ ultra: '', max: '', pro: '', lite: '' });
  const [anchorExpiry, setAnchorExpiry] = useState('');
  const [chartMode, setChartMode] = useState<ChartMode>('week');
  const [chartRange, setChartRange] = useState<ChartRange>('90d');
  const [selectedChartIndex, setSelectedChartIndex] = useState(Number.MAX_SAFE_INTEGER);
  const [chartFocused, setChartFocused] = useState(false);
  const [chartHovered, setChartHovered] = useState(false);
  const [chartOwnerWidth, setChartOwnerWidth] = useState(0);
  const [selectedHeatIndex, setSelectedHeatIndex] = useState(Number.MAX_SAFE_INTEGER);
  const [hoveredHeatDate, setHoveredHeatDate] = useState<string | null>(null);
  const [focusedHeatDate, setFocusedHeatDate] = useState<string | null>(null);
  const [summaryPeriod, setSummaryPeriod] = useState<'today' | 'week' | 'month'>('today');
  const [showSkillDetails, setShowSkillDetails] = useState(false);
  const loadGeneration = useRef(0);
  const connectionGeneration = useRef(0);
  const mounted = useRef(false);
  const anchorTriggerRef = useRef<HTMLButtonElement>(null);
  const firstAnchorInputRef = useRef<HTMLInputElement>(null);
  const chartScrollRef = useRef<HTMLDivElement>(null);
  const heatCellRefs = useRef(new Map<number, HTMLButtonElement>());

  const commitView = (next: UsageProfileView): void => {
    loadGeneration.current += 1;
    viewRef.current = next;
    setView(next);
    setLoadError('');
    setLoading(false);
  };

  const loadView = async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    if (!viewRef.current) setLoading(true);
    setLoadError('');
    try {
      const next = await window.gigaChat.usage.getProfileView();
      if (!mounted.current || generation !== loadGeneration.current) return;
      viewRef.current = next;
      setView(next);
    } catch (error) {
      if (mounted.current && generation === loadGeneration.current) setLoadError(safeError(error, 'Не удалось загрузить сводку.'));
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoading(false);
    }
  };

  const loadConnection = async (): Promise<void> => {
    const generation = ++connectionGeneration.current;
    setConnectionLoading(true);
    try {
      const status = await window.gigaChat.onboarding.getConnectionStatus();
      if (mounted.current && generation === connectionGeneration.current) setConnection(status);
    } catch {
      if (mounted.current && generation === connectionGeneration.current) setConnection(null);
    } finally {
      if (mounted.current && generation === connectionGeneration.current) setConnectionLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void loadView();
    void loadConnection();
    const terminalKeys = new Set<string>();
    const unsubscribe = window.gigaChat.runtime.onUpdate((turn: RuntimeTurnSnapshot) => {
      if (!['completed', 'failed', 'cancelled'].includes(turn.status)) return;
      const key = `${turn.id}:${turn.status}:${turn.endedAt ?? ''}`;
      if (terminalKeys.has(key)) return;
      terminalKeys.add(key);
      void loadView();
    });
    return () => {
      mounted.current = false;
      loadGeneration.current += 1;
      connectionGeneration.current += 1;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const element = chartScrollRef.current;
    if (!element) return;
    const measure = (): void => setChartOwnerWidth((current) => {
      const next = Math.max(0, Math.round(element.clientWidth));
      return current === next ? current : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);

  const days = view?.localActivity.rollingYear.days ?? [];
  const weeks = useMemo(() => heatmapColumns(days), [days]);
  const labels = useMemo(() => monthLabels(days), [days]);
  const maximumDayTokens = useMemo(() => Math.max(0, ...days.map((day) => day.aggregate.totalTokens.knownTokens)), [days]);
  const chartDays = useMemo(() => days.slice(-(chartRange === '30d' ? 30 : chartRange === '90d' ? 90 : days.length)), [days, chartRange]);
  const points = useMemo(() => chartPoints(chartDays, chartMode), [chartDays, chartMode]);
  const safeChartIndex = Math.max(0, Math.min(selectedChartIndex, points.length - 1));
  const selectedChartPoint = points[safeChartIndex];
  const currentPeriod = summaryPeriod === 'today' ? view?.localActivity.today
    : summaryPeriod === 'week' ? view?.localActivity.week : view?.localActivity.month;
  const heatDays = weeks.flat().filter((day): day is UsageProfileDay => day !== null);
  const activeHeatDay = heatDays.find((day) => day.date === (hoveredHeatDate ?? focusedHeatDate));
  const rovingHeatIndex = Math.max(0, Math.min(selectedHeatIndex, heatDays.length - 1));
  const skillNameById = useMemo(() => new Map(skillNames.map((skill) => [skill.id, skill.name])), [skillNames]);

  useEffect(() => {
    if (heatDays.length > 0) setSelectedHeatIndex(heatDays.length - 1);
  }, [heatDays.length]);

  function focusHeatCell(index: number): void {
    if (heatDays.length === 0) return;
    const bounded = Math.max(0, Math.min(index, heatDays.length - 1));
    setSelectedHeatIndex(bounded);
    requestAnimationFrame(() => heatCellRefs.current.get(bounded)?.focus());
  }

  function closeAnchorForm(): void {
    if (anchorBusy) return;
    setAnchorOpen(false);
    requestAnimationFrame(() => anchorTriggerRef.current?.focus());
  }

  function openAnchorForm(): void {
    if (anchorBusy || refreshingBalance) return;
    setAnchorAmounts({ ultra: '', max: '', pro: '', lite: '' });
    setAnchorExpiry('');
    setAnchorError('');
    setAnchorSaved('');
    setAnchorOpen(true);
    requestAnimationFrame(() => firstAnchorInputRef.current?.focus());
  }

  async function refreshBalance(): Promise<void> {
    if (refreshingBalance || anchorBusy || anchorOpen || connection?.state !== 'connected') return;
    setRefreshingBalance(true);
    setBalanceError('');
    setAnchorSaved('');
    try {
      const next = await window.gigaChat.usage.refreshBalance();
      if (!mounted.current) return;
      commitView(next);
      await loadConnection();
    } catch (error) {
      if (mounted.current) {
        setBalanceError(safeError(error, 'Не удалось обновить остаток.'));
        void loadConnection();
      }
    } finally {
      if (mounted.current) setRefreshingBalance(false);
    }
  }

  async function saveAnchor(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (anchorBusy) return;
    const amounts = Object.fromEntries(FAMILY_IDS.map((family) => [family, Number(anchorAmounts[family])])) as Amounts;
    if (FAMILY_IDS.some((family) => anchorAmounts[family].trim() === ''
      || !Number.isSafeInteger(amounts[family]) || amounts[family] < 0) || !anchorExpiry) {
      setAnchorError('Введите целый неотрицательный остаток для каждого семейства и дату окончания сверки.');
      return;
    }
    const input: StudioBalanceAnchorInput = { remainingTokens: amounts, expiresAt: anchorExpiry };
    setAnchorBusy(true);
    setAnchorError('');
    try {
      const next = await window.gigaChat.usage.saveStudioBalanceAnchor(input);
      if (!mounted.current) return;
      commitView(next);
      setAnchorSaved('Сверка сохранена. Последующий известный расход приложения учитывается как оценка.');
      setAnchorOpen(false);
      requestAnimationFrame(() => anchorTriggerRef.current?.focus());
    } catch (error) {
      if (mounted.current) setAnchorError(safeError(error, 'Не удалось сохранить сверку.'));
    } finally {
      if (mounted.current) setAnchorBusy(false);
    }
  }

  function onAnchorKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Escape' && !anchorBusy) {
      event.preventDefault();
      closeAnchorForm();
    }
  }

  function onHeatKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next = index;
    if (event.key === 'ArrowLeft') next -= 7;
    else if (event.key === 'ArrowRight') next += 7;
    else if (event.key === 'ArrowUp') next -= 1;
    else if (event.key === 'ArrowDown') next += 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = heatDays.length - 1;
    else return;
    event.preventDefault();
    focusHeatCell(next);
  }

  function onChartKeyDown(event: KeyboardEvent<SVGSVGElement>): void {
    let next = safeChartIndex;
    if (event.key === 'ArrowLeft') next -= 1;
    else if (event.key === 'ArrowRight') next += 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = points.length - 1;
    else return;
    event.preventDefault();
    setSelectedChartIndex(Math.max(0, Math.min(next, points.length - 1)));
  }

  if (loading && !view) return (
    <section className="content-page profile-page" aria-busy="true">
      <div className="page-heading"><h1>Профиль</h1><p>Загружаем расход и историю сверок…</p></div>
      <div className="profile-loading" role="status"><Activity aria-hidden="true" />Подготавливаем сводку</div>
    </section>
  );
  if (loadError && !view) return (
    <section className="content-page profile-page">
      <div className="page-heading"><h1>Профиль</h1></div>
      <div className="profile-message profile-message-error" role="alert"><strong>Не удалось загрузить сводку</strong><span>{loadError}</span>
        <button type="button" className="secondary-button" onClick={() => void loadView()}>Повторить</button></div>
    </section>
  );
  if (!view) return null;

  const chartMax = Math.max(0, ...points.map((point) => point.totalKnownTokens));
  const chartMinimumWidth = chartOwnerWidth > 0 ? Math.min(480, chartOwnerWidth) : 480;
  const chartWidth = Math.max(chartMinimumWidth, chartOwnerWidth,
    points.length * (chartMode === 'week' ? 20 : chartMode === 'cumulative' ? 3 : 5));
  const chartHeight = 216;
  const chartAxisLabels = [0, 1, 2, 3].map((line) => chartAxisValue(Math.round(chartMax * (1 - line / 3))));
  const axisLabelWidth = Math.max(0, ...chartAxisLabels.map((label) => label.length * 6));
  const plot = { left: Math.max(42, axisLabelWidth + 10), right: 12, top: 14, bottom: 31 };
  const plotWidth = chartWidth - plot.left - plot.right;
  const plotHeight = chartHeight - plot.top - plot.bottom;
  const barWidth = Math.min(10, Math.max(2, plotWidth / Math.max(1, points.length) * 0.62));
  const balance = view.balance;
  const chartRangeSummary = chartDays.reduce((summary, day) => ({
    knownTokens: summary.knownTokens + day.aggregate.totalTokens.knownTokens,
    unmappedTokens: summary.unmappedTokens + dayUnmappedTokens(day),
    unknownRequests: summary.unknownRequests + day.aggregate.totalTokens.unknownRequests,
    conflictedRequests: summary.conflictedRequests + day.aggregate.totalTokens.conflictedRequests,
  }), { knownTokens: 0, unmappedTokens: 0, unknownRequests: 0, conflictedRequests: 0 });
  const rangeUncertain = chartRangeSummary.unknownRequests + chartRangeSummary.conflictedRequests;
  const rangeSummaryText = chartRangeSummary.knownTokens === 0 && rangeUncertain > 0
    ? `Расход за период неизвестен. Без полного числа: ${pluralRequests(rangeUncertain)}.`
    : `Измерено ${formatNumber(chartRangeSummary.knownTokens)} токенов${chartRangeSummary.unmappedTokens > 0
      ? `, из них ${formatNumber(chartRangeSummary.unmappedTokens)} не сопоставлено с моделью` : ''}${rangeUncertain > 0
        ? `; без полного числа: ${pluralRequests(rangeUncertain)}` : ''}.`;

  function onChartPointerMove(event: PointerEvent<SVGSVGElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || plotWidth <= 0 || points.length === 0) return;
    const scaleX = chartWidth / bounds.width;
    const plotX = (event.clientX - bounds.left) * scaleX - plot.left;
    const ratio = Math.max(0, Math.min(0.999999, plotX / plotWidth));
    setSelectedChartIndex(Math.floor(ratio * points.length));
    setChartHovered(true);
  }

  return (
    <section className="content-page profile-page">
      <header className="page-heading profile-heading">
        <div><span className="eyebrow">Расход и остаток</span><h1>Профиль</h1>
          <p>Расход отражает измерения этого приложения. Остаток аккаунта обновляется отдельно.</p></div>
        <span className="profile-generated">Обновлено {formatTimestamp(view.generatedAt)}</span>
      </header>

      {loadError && <div className="profile-message profile-message-error" role="status"><span>Сводка пока не обновилась: {loadError}</span></div>}
      {connection?.state !== 'connected' && <div className="profile-connection-note" role="status">
        <span>{connectionLoading ? 'Проверяем подключение…' : connection?.state === 'connecting'
          ? 'Подключение ещё проверяется.' : 'Для сверки по API нужно подключиться к GigaChat.'}</span>
        {!connectionLoading && connection?.state !== 'connecting' && <button type="button" className="quiet-button" onClick={onOpenConnection}
          disabled={anchorBusy || refreshingBalance}>Настроить подключение</button>}
      </div>}

      <section className="profile-balance-section" aria-labelledby="profile-balance-title">
        <div className="profile-section-heading profile-balance-heading">
          <div><h2 id="profile-balance-title">Остаток токенов</h2>
            <p>{balance.source === 'studio' ? 'Остаток записан по вашей сверке с сайтом.' : 'API сообщает остаток, но не тип пакета и не срок его действия.'}</p></div>
          <div className="profile-balance-actions">
            <button type="button" className="primary-button" onClick={() => void refreshBalance()}
              disabled={refreshingBalance || anchorBusy || anchorOpen || connectionLoading || connection?.state !== 'connected'}
              title={connection?.state !== 'connected' ? 'Сначала подключитесь к аккаунту GigaChat.' : undefined}>
              <RefreshCw className={refreshingBalance ? 'profile-spin' : ''} aria-hidden="true" />
              {refreshingBalance ? 'Сверяем…' : 'Обновить остаток'}
            </button>
            <button ref={anchorTriggerRef} type="button" className="secondary-button" onClick={openAnchorForm}
              disabled={refreshingBalance || anchorBusy || anchorOpen}>Сверить с сайтом</button>
          </div>
        </div>
        {balanceError && <div className="profile-message profile-message-error" role="alert">{balanceError}</div>}
        {anchorSaved && <div className="profile-message profile-message-success" role="status">{anchorSaved}</div>}
        {balance.state === 'unknown' && <div className="profile-balance-empty" role="status"><strong>Остаток неизвестен</strong>
          <span>Обновите данные по API или внесите числа, которые видите на сайте.</span></div>}
        {balance.incomplete && balance.state !== 'unknown' && <div className="profile-uncertainty" role="status">
          <CircleHelp aria-hidden="true" /><span>Часть расхода неизвестна или не сопоставлена. Для затронутых семейств текущая оценка скрыта.</span></div>}
        <div className="profile-balance-grid">
          {CHAT_MODEL_FAMILIES.map((definition) => {
            const family = balance.families.find((item) => item.family === definition.family);
            const current = family?.estimatedRemainingTokens ?? null;
            const snapshot = family?.snapshotRemainingTokens ?? null;
            const expired = balance.state === 'expired' || family?.state === 'expired';
            const status = current !== null ? balance.source === 'studio' ? 'Бесплатный остаток' : 'Остаток по API'
              : expired ? 'Срок сверки истёк' : 'Остаток неизвестен';
            return <article className={`profile-balance-card profile-family-${definition.family}`} key={definition.family}>
              <div className="profile-balance-card-title"><span className="profile-family-dot" aria-hidden="true" />
                <h3>{definition.displayName}</h3></div>
              <span className="profile-balance-status">{status}</span>
              <strong className="profile-balance-value">{current !== null ? formatNumber(current) : 'Неизвестно'}</strong>
              {current !== null && <span className="profile-estimate-label">Оценка</span>}
              {current === null && snapshot !== null && <small>При сверке: {formatNumber(snapshot)}</small>}
              {balance.source === 'studio' && balance.expiresAt
                ? <small>До {formatDay(balance.expiresAt, SHORT_DATE)}</small>
                : balance.source === 'api' ? <small>Срок API не сообщает</small>
                  : <small>{balanceCopy(family?.state ?? 'unknown')}</small>}
              {family && (family.unknownRequests > 0 || family.conflictedRequests > 0)
                ? <small>Неполных запросов: {family.unknownRequests + family.conflictedRequests}</small> : null}
            </article>;
          })}
        </div>
        {balance.source && balance.observedAt && <p className="profile-observed-at">Сверка: {formatTimestamp(balance.observedAt)}.
          {balance.unknownUsageCount === null ? ' Часть строк остатка неизвестна.' : balance.unknownUsageCount > 0 ? ` Нераспознанных строк: ${balance.unknownUsageCount}.` : ''}</p>}
        {anchorOpen && <form className="profile-anchor-form" onSubmit={(event) => void saveAnchor(event)} onKeyDown={onAnchorKeyDown} aria-busy={anchorBusy}>
          <div className="profile-anchor-heading"><div><h3>Данные со страницы баланса</h3>
            <p>Введите значения, которые сейчас видите на сайте. Приложение сохранит дату сверки и будет вычитать только известный расход после неё.</p></div>
            <button type="button" className="small-icon-button" aria-label="Закрыть форму сверки" onClick={closeAnchorForm} disabled={anchorBusy}><X aria-hidden="true" /></button></div>
          <div className="profile-anchor-grid">
            {CHAT_MODEL_FAMILIES.map((definition, index) => <label className={`profile-anchor-field profile-family-${definition.family}`} key={definition.family}>
              <span>{definition.displayName}</span>
              <input ref={index === 0 ? firstAnchorInputRef : undefined} type="number" min="0" step="1" inputMode="numeric" required disabled={anchorBusy}
                aria-label={`Остаток ${definition.displayName}`} value={anchorAmounts[definition.family]}
                onChange={(event) => setAnchorAmounts((current) => ({ ...current, [definition.family]: event.target.value }))} />
            </label>)}
            <label className="profile-anchor-field profile-anchor-expiry"><span>Срок действия на сайте</span>
              <input type="date" required aria-label="Дата окончания остатка" value={anchorExpiry} disabled={anchorBusy} onChange={(event) => setAnchorExpiry(event.target.value)} /></label>
          </div>
          {anchorError && <p className="profile-form-error" role="alert">{anchorError}</p>}
          <div className="profile-anchor-footer">
            <div><button type="button" className="secondary-button" disabled={anchorBusy} onClick={closeAnchorForm}>Отмена</button>
              <button type="submit" className="primary-button" disabled={anchorBusy}>{anchorBusy ? 'Сохраняем…' : 'Сохранить сверку'}</button></div></div>
        </form>}
      </section>

      <section className="profile-metrics" aria-label="Расход и активность">
        <article className="profile-metric profile-metric-primary"><span>Потрачено токенов</span><strong>{knownTokens(view.total)}</strong>
          <small>{aggregateUnknown(view.total) ? `${pluralRequests(aggregateUnknown(view.total))} без полного числа токенов` : 'По измерениям API этого приложения'}</small></article>
        <article className="profile-metric"><span>Запросы к API</span><strong>{formatNumber(view.total.requestCount)}</strong>
          <small>Включая продолжения ответов и другие вызовы</small></article>
        <article className="profile-metric"><span>Чаты</span><strong>{formatNumber(view.chats.count)}</strong></article>
        <article className="profile-metric"><span>Проекты</span><strong>{formatNumber(view.projects.count)}</strong></article>
        <article className="profile-metric"><span>Дни активности</span><strong>{formatNumber(view.localActivity.activityDayCount)}</strong><small>По отправленным сообщениям и API-вызовам</small></article>
        <article className="profile-metric"><span>Дней подряд</span><strong>{formatNumber(view.localActivity.streakDays)}</strong><small>С учётом сегодняшнего или вчерашнего дня</small></article>
      </section>

      <section className="profile-activity-section" aria-labelledby="profile-activity-title">
        <div className="profile-section-heading profile-activity-heading"><div><h2 id="profile-activity-title">Активность за 12 месяцев</h2>
          <p>Яркость показывает измеренный расход токенов. Пустой день означает отсутствие измеренного расхода.</p></div>
          <CalendarDays aria-hidden="true" />
        </div>
        <div className="profile-heatmap-scroll" tabIndex={0} aria-label="Прокручиваемый календарь активности">
          <div className="profile-heatmap-content">
            <div className="profile-heatmap-months" style={{ gridTemplateColumns: `repeat(${Math.max(1, weeks.length)}, 13px)` }} aria-hidden="true">
              {labels.map((item, index) => <span key={`${item.week}-${item.label}`} style={{ gridColumn: item.week + 1, gridRow: 1,
                justifySelf: 'start', marginLeft: index === 0 ? 0 : undefined }}>{item.label}</span>)}
            </div>
            <div className="profile-heatmap-grid" role="grid" aria-label="Дневной расход токенов за год">
              {Array.from({ length: 7 }, (_, weekdayIndex) => <div className="profile-heatmap-row" role="row" key={weekdayIndex}
                style={{ gridTemplateColumns: `repeat(${Math.max(1, weeks.length)}, 13px)` }}>
                {weeks.map((week, weekIndex) => {
                  const day = week[weekdayIndex] ?? null;
                  if (!day) return <span className="profile-heatmap-empty" role="gridcell" aria-hidden="true" key={`empty-${weekIndex}-${weekdayIndex}`} />;
                  const index = heatDays.findIndex((item) => item.date === day.date);
                  const tokens = day.aggregate.totalTokens.knownTokens;
                  const level = maximumDayTokens === 0 || tokens === 0 ? 0 : Math.max(1, Math.ceil(tokens / maximumDayTokens * 4));
                  const uncertain = day.aggregate.totalTokens.unknownRequests + day.aggregate.totalTokens.conflictedRequests > 0;
                  const byFamily = FAMILY_IDS.map((family) => `${familyLabel(family)} ${dayFamilyTokens(day, family)}`).join(', ');
                  const unmapped = dayUnmappedTokens(day);
                  const detail = `${formatDay(day.date)}: ${knownTokens(day.aggregate)} токенов. ${byFamily}${unmapped > 0 ? `, не сопоставлено с моделью ${formatNumber(unmapped)}` : ''}${uncertain ? '. Есть запросы без полного числа.' : ''}`;
                  return <button key={day.date} ref={(element) => {
                    if (element) heatCellRefs.current.set(index, element);
                    else heatCellRefs.current.delete(index);
                  }} type="button" role="gridcell" tabIndex={index === rovingHeatIndex ? 0 : -1}
                    aria-label={detail} title={detail} data-level={level} data-uncertain={uncertain ? 'true' : undefined}
                    className={`profile-heat-cell${uncertain ? ' is-uncertain' : ''}`}
                    onFocus={() => { setSelectedHeatIndex(index); setFocusedHeatDate(day.date); }}
                    onBlur={() => setFocusedHeatDate((current) => current === day.date ? null : current)}
                    onMouseEnter={() => setHoveredHeatDate(day.date)}
                    onMouseLeave={() => setHoveredHeatDate((current) => current === day.date ? null : current)}
                    onKeyDown={(event) => onHeatKeyDown(event, index)} />;
                })}
              </div>)}
            </div>
          </div>
        </div>
        <div className="profile-heat-detail" role={activeHeatDay ? 'status' : undefined} aria-hidden={!activeHeatDay}>
          {activeHeatDay && <>
            <strong>{formatDay(activeHeatDay.date)}</strong><span>{knownTokens(activeHeatDay.aggregate)} токенов</span>
            <small>{FAMILY_IDS.map((family) => `${familyLabel(family)} ${dayFamilyTokens(activeHeatDay, family)}`).join(' · ')}
              {dayUnmappedTokens(activeHeatDay) > 0 ? ` · Неизвестные модели ${formatNumber(dayUnmappedTokens(activeHeatDay))}` : ''}</small>
          </>}
        </div>
        <div className="profile-period-switch" role="group" aria-label="Сводка расхода за период">
          {([['today', 'Сегодня'], ['week', 'Неделя'], ['month', 'Месяц']] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={summaryPeriod === value} onClick={() => setSummaryPeriod(value)}>{label}</button>)}
          <span className="profile-period-value">{currentPeriod ? `${knownTokens(currentPeriod)} токенов` : 'Нет данных'}</span>
        </div>
        {currentPeriod && aggregateUnknown(currentPeriod) > 0 && <small className="profile-period-note">За период есть запросы без полного числа токенов.</small>}
      </section>

      <section className="profile-chart-section" aria-labelledby="profile-chart-title">
        <div className="profile-section-heading profile-chart-heading"><div><h2 id="profile-chart-title">Расход по моделям</h2>
          <p>{chartMode === 'cumulative' ? `Нарастающий итог: ${rangeSummaryText}` : chartMode === 'week' ? `Сумма по неделям. ${rangeSummaryText}` : `Сумма по дням. ${rangeSummaryText}`}</p></div>
          <div className="profile-chart-controls">
            <div className="profile-chart-range" role="group" aria-label="Период графика">
              {([['30d', '30 дней'], ['90d', '90 дней'], ['12m', '12 месяцев']] as const).map(([value, label]) =>
                <button key={value} type="button" aria-pressed={chartRange === value} onClick={() => { setChartRange(value); setSelectedChartIndex(Number.MAX_SAFE_INTEGER); }}>{label}</button>)}
            </div>
            <div className="profile-chart-switch" role="group" aria-label="Агрегация графика">
              {([['day', 'По дням'], ['week', 'По неделям'], ['cumulative', 'Нарастающим итогом']] as const).map(([value, label]) =>
                <button key={value} type="button" aria-pressed={chartMode === value} onClick={() => { setChartMode(value); setSelectedChartIndex(Number.MAX_SAFE_INTEGER); }}>{label}</button>)}
            </div>
          </div>
        </div>
        <div className="profile-chart-legend" aria-label="Модели">
          {CHAT_MODEL_FAMILIES.map((family) => <span className={`profile-legend-item profile-family-${family.family}`} key={family.family}>
            <i aria-hidden="true" />{family.displayName}</span>)}
          {points.some((point) => point.unmappedTokens > 0) && <span className="profile-legend-item profile-legend-unmapped"><i aria-hidden="true" />Неизвестные модели</span>}
        </div>
        <div className="profile-chart-frame">
          <div className="profile-chart-scroll" ref={chartScrollRef}>
            <svg className="profile-usage-chart" width={chartWidth} height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              role="img" tabIndex={0} aria-describedby={(chartFocused || chartHovered) && selectedChartPoint ? 'profile-chart-tooltip' : undefined}
              aria-label={selectedChartPoint ? chartPointLabel(selectedChartPoint) : 'Нет данных для графика'}
              onFocus={() => setChartFocused(true)} onBlur={() => setChartFocused(false)} onPointerMove={onChartPointerMove}
              onPointerLeave={() => setChartHovered(false)} onKeyDown={onChartKeyDown}>
              <title>Расход токенов по моделям</title><desc>{dateRangeLabel(chartMode, chartRange)}. Стрелки влево и вправо переключают дату или период.</desc>
              {[0, 1, 2, 3].map((line) => {
                const y = plot.top + (plotHeight / 3) * line;
                return <g key={line}><line x1={plot.left} x2={chartWidth - plot.right} y1={y} y2={y} className="profile-chart-gridline" />
                  <text x={plot.left - 7} y={y + 4} textAnchor="end" className="profile-chart-axis">{chartAxisLabels[line]}</text></g>;
              })}
              {points.map((point, index) => {
                const total = point.totalKnownTokens;
                const center = plot.left + ((index + 0.5) / Math.max(1, points.length)) * plotWidth;
                let baseY = plot.top + plotHeight;
                const bars = FAMILY_IDS.map((family) => {
                  const value = point.values[family];
                  const height = chartMax > 0 ? value / chartMax * plotHeight : 0;
                  baseY -= height;
                  return <rect key={family} x={center - barWidth / 2} y={baseY} width={barWidth} height={Math.max(0, height)}
                    className={`profile-chart-bar profile-family-${family}`} />;
                });
                const unmappedHeight = chartMax > 0 ? point.unmappedTokens / chartMax * plotHeight : 0;
                baseY -= unmappedHeight;
                const previousMonth = index > 0 ? points[index - 1]!.date.slice(0, 7) : null;
                const month = point.date.slice(0, 7);
                const showMonthLabel = index === 0 || (chartMode === 'week' ? month !== previousMonth : point.date.slice(8, 10) === '01');
                return <g key={`${point.date}-${index}`} data-chart-date={point.date}>
                  <rect className={`profile-chart-hit${index === safeChartIndex && (chartFocused || chartHovered) ? ' is-selected' : ''}`}
                    x={center - Math.max(barWidth, plotWidth / Math.max(1, points.length)) / 2} y={plot.top} width={Math.max(barWidth, plotWidth / Math.max(1, points.length))}
                    height={plotHeight} aria-hidden="true" />
                  {bars}
                  {unmappedHeight > 0 && <rect x={center - barWidth / 2} y={baseY} width={barWidth} height={unmappedHeight} className="profile-chart-unmapped" />}
                  {showMonthLabel
                    ? <text x={center} y={chartHeight - 6} textAnchor="middle" className="profile-chart-axis">{MONTH_LABEL.format(new Date(`${point.date.slice(0, 7)}-01T12:00:00.000Z`)).replace('.', '')}</text> : null}
                  <title>{chartPointLabel(point)}{total === 0 && point.unknownRequests + point.conflictedRequests === 0 ? ' Измеренный расход за этот день — 0.' : ''}</title>
                </g>;
              })}
            </svg>
          </div>
          {(chartFocused || chartHovered) && selectedChartPoint && <div id="profile-chart-tooltip" className="profile-chart-tooltip" role="tooltip">
            <strong>{formatDay(selectedChartPoint.date)}</strong>
            <div>{FAMILY_IDS.map((family) => <span className={`profile-family-${family}`} key={family}>{familyLabel(family)}: {chartFamilyValue(selectedChartPoint, family)}</span>)}</div>
            <small>{selectedChartPoint.totalKnownTokens === 0
              && selectedChartPoint.unknownRequests + selectedChartPoint.conflictedRequests > 0
              ? 'Расход неизвестен'
              : `Измерено: ${chartTotalValue(selectedChartPoint)} токенов`}
              {selectedChartPoint.unmappedTokens > 0 ? ` · не сопоставлено с моделью: ${formatNumber(selectedChartPoint.unmappedTokens)}` : ''}
              {selectedChartPoint.unknownRequests + selectedChartPoint.conflictedRequests > 0 ? ` · неполных запросов: ${selectedChartPoint.unknownRequests + selectedChartPoint.conflictedRequests}` : ''}</small>
          </div>}
          {!view.total.requestCount && <p className="profile-chart-empty">Пока нет измеренных вызовов API.</p>}
        </div>
        <details className="profile-chart-data">
          <summary>Текстовая таблица графика</summary>
          <div className="profile-table-scroll"><table><thead><tr><th>Период</th>{CHAT_MODEL_FAMILIES.map((family) => <th key={family.family}>{family.displayName}</th>)}{points.some((point) => point.unmappedTokens > 0) && <th>Неизвестные модели</th>}<th>Измерено</th></tr></thead>
            <tbody>{points.map((point, index) => <tr key={`${point.date}-${index}`}><th scope="row">{formatDay(point.date, SHORT_DATE)}</th>
              {FAMILY_IDS.map((family) => <td key={family}>{chartFamilyValue(point, family)}</td>)}
              {points.some((item) => item.unmappedTokens > 0) && <td>{formatNumber(point.unmappedTokens)}</td>}
              <td>{chartTotalValue(point)}{point.unknownRequests + point.conflictedRequests > 0 ? ` · без полного числа: ${pluralRequests(point.unknownRequests + point.conflictedRequests)}` : ''}</td></tr>)}</tbody></table></div>
        </details>
      </section>

      <section className="profile-detail-grid" aria-label="Детализация и дополнительные показатели">
        <section className="profile-detail-section" aria-labelledby="profile-family-table-title">
          <div className="profile-section-heading"><div><h2 id="profile-family-table-title">Расход по моделям</h2><p>Сумма известных значений всех API-вызовов.</p></div><BarChart3 aria-hidden="true" /></div>
          <div className="profile-table-scroll"><table><thead><tr><th>Модель</th><th>Запросы</th><th>Токены</th></tr></thead><tbody>
          {view.byFamily.map((aggregate) => {
              const id = FAMILY_IDS.find((family) => family === aggregate.key);
            return <tr key={aggregate.key}><th scope="row">{id ? familyLabel(id) : 'Неизвестные модели'}</th>
                <td>{formatNumber(aggregate.requestCount)}</td><td>{knownTokens(aggregate)}</td></tr>;
            })}
          </tbody></table></div>
          {view.providerIdentityConflictCount > 0 && <small className="profile-table-note">Некоторые записи запросов содержат несовместимые данные; они не объединены автоматически.</small>}
        </section>
        <section className="profile-detail-section" aria-labelledby="profile-chat-table-title">
          <div className="profile-section-heading"><div><h2 id="profile-chat-table-title">По чатам</h2><p>Измерения распределены по чатам приложения.</p></div><Activity aria-hidden="true" /></div>
          {view.byChat.length === 0 ? <p className="profile-detail-empty">Пока нет запросов, привязанных к чатам.</p> : <div className="profile-table-scroll"><table><thead><tr><th>Чат</th><th>Запросы</th><th>Токены</th></tr></thead><tbody>
            {view.byChat.map((row, index) => <tr key={`${row.chatId ?? 'unlinked'}-${index}`}><th scope="row">{row.title}</th>
              <td>{formatNumber(row.aggregate.requestCount)}</td><td>{knownTokens(row.aggregate)}</td></tr>)}
          </tbody></table></div>}
        </section>
      </section>

      <section className="profile-extra-section" aria-labelledby="profile-extra-title">
        <div className="profile-section-heading"><div><h2 id="profile-extra-title">Ещё о работе</h2><p>Только сведения, которые удалось сохранить.</p></div><Sparkles aria-hidden="true" /></div>
        <div className="profile-extra-grid">
          <article><span>Самый длинный чат</span><strong>{view.chats.longestByMessages ? `${formatNumber(view.chats.longestByMessages.messageCount)} сообщений` : 'Нет данных'}</strong>
            {view.chats.longestByMessages && <small>{view.chats.longestByMessages.title}</small>}</article>
          <article><span>Наибольший расход одного чата</span><strong>{view.chats.maxTokens ? `${formatNumber(view.chats.maxTokens.knownTokens)} токенов` : 'Нет данных'}</strong>
            {view.chats.maxTokens && <small>{view.chats.maxTokens.title}{view.chats.maxTokens.complete ? '' : ' · частичные данные'}</small>}</article>
          <article><span>Установлено Skills</span><strong>{view.skills.installedCount === null ? 'Неизвестно' : formatNumber(view.skills.installedCount)}</strong>
            <small>{formatNumber(view.skills.invocationCount)} подтверждённых запусков{view.skills.unknownTurnCount ? ` · ${view.skills.unknownTurnCount} ходов без записи` : ''}</small></article>
          <article><span>Вызовы инструментов</span><strong>{formatNumber(view.tools.invocationCount)}</strong>
            <small>{view.tools.unknownInvocationCount ? `${view.tools.unknownInvocationCount} результатов требуют проверки` : 'По сохранённым результатам чатов'}</small></article>
        </div>
        {view.skills.bySkill.length > 0 && <details className="profile-skill-details" open={showSkillDetails} onToggle={(event) => setShowSkillDetails(event.currentTarget.open)}>
          <summary>Использование по Skills</summary>
          <ul>{view.skills.bySkill.map((entry) => <li key={entry.skillId}><span>{skillNameById.get(entry.skillId) ?? entry.skillId}</span><strong>{formatNumber(entry.invocationCount)}</strong></li>)}</ul>
        </details>}
        {view.tools.byTool.length > 0 && <ul className="profile-tool-list" aria-label="Использование инструментов">
          {view.tools.byTool.map((entry) => <li key={entry.tool}><span><Wrench aria-hidden="true" />{entry.tool === 'read' ? 'Чтение файлов' : entry.tool === 'write' ? 'Запись файлов'
            : entry.tool === 'list' ? 'Список файлов' : entry.tool === 'search' ? 'Поиск файлов' : entry.tool === 'open' ? 'Открытие файлов' : 'PowerShell'}</span>
            <strong>{formatNumber(entry.invocationCount)}{entry.unknownInvocationCount ? ` · неизвестно ${entry.unknownInvocationCount}` : ''}</strong></li>)}
        </ul>}
      </section>
      <p className="profile-scope-note"><CircleHelp aria-hidden="true" />Расход показывает только измерения этого приложения; действия в других клиентах видны лишь после новой сверки остатка.</p>
    </section>
  );
}

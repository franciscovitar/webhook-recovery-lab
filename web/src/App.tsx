import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Tab = 'Overview' | 'Events' | 'Deliveries' | 'Recovery' | 'Endpoints' | 'Activity';
type JobState = 'PENDING' | 'LEASED' | 'SUCCEEDED' | 'DEAD';
type EventRow = {
  id: string;
  event_id: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  payload: { data: { order_id: string } };
  job_id: string;
  delivery_id: string;
  status: JobState;
  total_attempts: number;
  attempts_in_generation: number;
  replay_generation: number;
  next_attempt_at: string;
  last_error_class: string | null;
};
type Counts = { received: number; delivered: number; pending: number; failed: number };
type RecoveryRow = {
  id: string;
  delivery_id: string;
  event_id: string;
  order_id: string;
  last_error_class: string | null;
  total_attempts: number;
  replay_generation: number;
  updated_at: string;
};
type DeliveryRow = {
  job_id: string;
  delivery_id: string;
  event_id: string;
  order_id: string;
  status: JobState;
  total_attempts: number;
  replay_generation: number;
  next_attempt_at: string;
  latest_http_status: number | null;
  latest_latency_ms: number | null;
  latest_attempt_result: string | null;
  latest_error_class: string | null;
};
type ActivityRow = {
  action: string;
  happened_at: string;
  event_id: string;
  order_id: string;
  job_id: string;
  detail: string;
  http_status: number | null;
  latency_ms: number | null;
};
type EventDetail = EventRow & {
  signature_verified: boolean;
  attempts: Array<{
    attempt_sequence: number;
    replay_generation: number;
    started_at: string;
    finished_at: string | null;
    result: string;
    http_status: number | null;
    latency_ms: number | null;
    error_class: string | null;
  }>;
};

function userFacingError(message: string): string {
  const known: Record<string, string> = {
    origin_rejected: 'No pudimos verificar la solicitud. Recargá la página e intentá nuevamente.',
    workspace_expired: 'Tu espacio temporal venció. Abrí uno nuevo para continuar.',
    workspace_event_limit: 'Alcanzaste el límite de eventos de este espacio.',
    workspace_mutation_limit: 'Alcanzaste el límite de acciones por hora. Intentá más tarde.',
    workspace_capacity: 'Hay muchos espacios de prueba activos. Intentá en unos minutos.',
    receiver_unavailable: 'El receptor de prueba no está disponible. Intentá nuevamente.',
    event_not_repeatable: 'Este evento no tiene datos verificados para reenviar.',
    replay_limit_reached: 'Esta entrega alcanzó el límite de recuperaciones.',
    replay_reason_required: 'Ingresá un motivo antes de recuperar la entrega.',
    request_identity_conflict: 'La solicitud ya se utilizó con otros datos.',
    'Failed to fetch': 'No pudimos conectarnos con el servicio. Intentá nuevamente.',
  };
  return known[message] ?? 'No pudimos completar la operación. Intentá nuevamente.';
}

const tabLabels: Record<Tab, string> = {
  Overview: 'Resumen',
  Events: 'Eventos',
  Deliveries: 'Entregas',
  Recovery: 'Recuperación',
  Endpoints: 'Receptor',
  Activity: 'Actividad',
};

function orderLabel(reference: string): string {
  return /^ord_[a-f0-9-]+$/i.test(reference)
    ? `Pedido de prueba · ${reference.slice(-4).toUpperCase()}`
    : `Pedido ${reference}`;
}

function eventLabel(type: string): string {
  return type === 'order.created' ? 'Pedido creado' : 'Otro evento';
}

function attemptCount(count: number): string {
  return `${count} ${count === 1 ? 'intento' : 'intentos'}`;
}

function attemptLabel(result: string): string {
  const labels: Record<string, string> = {
    STARTED: 'En proceso',
    SUCCEEDED: 'Entrega correcta',
    RETRY: 'Reintento programado',
    DEAD: 'Entrega fallida',
    ABANDONED: 'Intento interrumpido',
    STALE_ACK: 'Respuesta fuera de plazo',
  };
  return labels[result] ?? 'Resultado registrado';
}

function errorLabel(error: string | null): string {
  const labels: Record<string, string> = {
    permanent_http: 'El receptor rechazó el envío',
    transient_http: 'Respuesta temporal del receptor',
    timeout: 'Tiempo de espera agotado',
    network: 'Error de comunicación',
  };
  return error ? (labels[error] ?? 'Error de entrega') : 'Sin causa registrada';
}

function httpLabel(status: number): string {
  if (status >= 200 && status < 300) return `Correcta · HTTP ${status}`;
  if (status >= 400) return `Error · HTTP ${status}`;
  return `HTTP ${status}`;
}

function activityLabel(action: string, detail: string): string {
  if (action === 'event_received') return 'Evento recibido';
  if (action === 'replay_requested') return 'Recuperación solicitada';
  return attemptLabel(detail.split(' · ')[0] ?? '');
}

const navigation: Array<{ title: Tab; icon: string }> = [
  { title: 'Overview', icon: '◫' },
  { title: 'Events', icon: '◷' },
  { title: 'Deliveries', icon: '⇢' },
  { title: 'Recovery', icon: '↻' },
  { title: 'Endpoints', icon: '◎' },
  { title: 'Activity', icon: '≡' },
];

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? '—'
    : date.toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
}

function stateLabel(state: JobState): string {
  return { PENDING: 'En espera', LEASED: 'En proceso', SUCCEEDED: 'Entregado', DEAD: 'Fallido' }[state];
}

function Badge({ state }: { state: JobState }) {
  return (
    <span className={`badge badge-${state.toLowerCase()}`}>
      <span className="badge-dot" />
      {stateLabel(state)}
    </span>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>('Overview');
  const [session, setSession] = useState<'starting' | 'ready' | 'expired' | 'error'>('starting');
  const [dataLoaded, setDataLoaded] = useState(false);
  const [counts, setCounts] = useState<Counts>({ received: 0, delivered: 0, pending: 0, failed: 0 });
  const [events, setEvents] = useState<EventRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [recovery, setRecovery] = useState<RecoveryRow[]>([]);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [offset, setOffset] = useState(0);
  const [eventTotal, setEventTotal] = useState(0);
  const [orderId, setOrderId] = useState('');
  const [scenario, setScenario] = useState<'normal' | 'permanent_failure'>('normal');
  const [replayReason, setReplayReason] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receiverReady, setReceiverReady] = useState<boolean | null>(null);
  const [pollingPaused, setPollingPaused] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (search.trim()) query.set('q', search.trim());
      if (statusFilter) query.set('status', statusFilter);
      if (fromDate) query.set('from', new Date(`${fromDate}T00:00:00.000Z`).toISOString());
      if (toDate)
        query.set('to', new Date(new Date(`${toDate}T00:00:00.000Z`).valueOf() + 86_400_000).toISOString());
      query.set('offset', String(offset));
      const [nextCounts, nextEvents, nextRecovery, nextDeliveries, nextActivity, endpointStatus] =
        await Promise.all([
          request<Counts>('/api/demo/overview'),
          request<{ total: number; events: EventRow[] }>(`/api/demo/events?${query.toString()}`),
          request<{ dead_jobs: RecoveryRow[] }>('/api/demo/recovery'),
          request<{ deliveries: DeliveryRow[] }>('/api/demo/deliveries'),
          request<{ activity: ActivityRow[] }>('/api/demo/activity'),
          request<{ endpoints: Array<{ status: string }> }>('/api/demo/endpoints'),
        ]);
      setCounts(nextCounts);
      setDataLoaded(true);
      setEvents(nextEvents.events);
      setEventTotal(nextEvents.total);
      setRecovery(nextRecovery.dead_jobs);
      setDeliveries(nextDeliveries.deliveries);
      setActivity(nextActivity.activity);
      setReceiverReady(endpointStatus.endpoints[0]?.status === 'healthy');
      setSession('ready');
      setError('');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not load workspace';
      if (message === 'workspace_expired') setSession('expired');
      else setError(message);
      setNotice('');
    }
  }, [search, statusFilter, fromDate, toDate, offset]);

  const startSession = useCallback(async (fresh = false) => {
    setSession('starting');
    setDataLoaded(false);
    setError('');
    setNotice('');
    try {
      await request(fresh ? '/api/demo/session/new' : '/api/demo/session', { method: 'POST' });
      setSession('ready');
      setError('');
    } catch (cause) {
      setSession('error');
      setError(cause instanceof Error ? cause.message : 'Could not start a workspace');
      setNotice('');
    }
  }, []);

  useEffect(() => {
    void startSession();
  }, [startSession]);
  useEffect(() => {
    if (session === 'ready') void refresh();
  }, [refresh, session]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    if (session !== 'ready' || counts.pending === 0) return;
    let polls = 0;
    let timer = 0;
    setPollingPaused(false);
    const schedule = () => {
      if (document.visibilityState !== 'visible') return;
      if (polls >= 60) {
        setPollingPaused(true);
        return;
      }
      timer = window.setTimeout(() => {
        if (document.visibilityState !== 'visible') return;
        polls++;
        void refresh().finally(schedule);
      }, 5000);
    };
    const visibilityChanged = () => {
      if (document.visibilityState === 'visible') schedule();
      else window.clearTimeout(timer);
    };
    schedule();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [counts.pending, refresh, refreshGeneration, session]);

  const deliveredPercent = useMemo(
    () =>
      counts.received === 0
        ? 'Todavía sin eventos'
        : `${Math.round((counts.delivered / counts.received) * 100)}% de los eventos recibidos`,
    [counts],
  );

  async function sendEvent() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request<{ event_id: string; status: string }>('/api/demo/test-events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(orderId.trim() ? { order_id: orderId.trim() } : {}),
          request_id: crypto.randomUUID(),
          scenario,
        }),
      });
      setNotice('Evento recibido y verificado. Consultá el estado de la entrega.');
      setOrderId('');
      setSearch('');
      setStatusFilter('');
      setFromDate('');
      setToDate('');
      setOffset(0);
      await refresh();
      setTab(scenario === 'permanent_failure' ? 'Recovery' : 'Events');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The event was not accepted');
      setNotice('');
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(eventOrId: EventRow | string) {
    const eventId = typeof eventOrId === 'string' ? eventOrId : eventOrId.event_id;
    try {
      const next = await request<EventDetail>(`/api/demo/events/${eventId}`);
      detailTrigger.current = document.activeElement as HTMLElement | null;
      setDetail(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open event');
      setNotice('');
    }
  }

  async function duplicateEvent(eventId: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ status: string }>(`/api/demo/events/${eventId}/duplicate`, {
        method: 'POST',
      });
      setNotice(
        result.status === 'duplicate'
          ? 'Duplicado detectado: no se creó otra entrega.'
          : 'Reenvío procesado. Consultá el historial del evento.',
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not resend event');
      setNotice('');
    } finally {
      setBusy(false);
    }
  }

  const closeDetail = useCallback(() => {
    setDetail(null);
    window.requestAnimationFrame(() => detailTrigger.current?.focus());
  }, []);

  function openSendForm() {
    setTab('Overview');
    window.setTimeout(() => {
      document.getElementById('send-event')?.scrollIntoView({ block: 'start' });
      document.getElementById('order-reference')?.focus();
    }, 0);
  }

  async function restoreAndReplay(job: RecoveryRow) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const headers = { 'content-type': 'application/json' };
      await request(`/api/demo/recovery/${job.id}/restore`, { method: 'POST' });
      const result = await request<{ replay_generation: number }>(`/api/demo/recovery/${job.id}/replay`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          reason: replayReason[job.id] ?? 'Receptor de prueba restaurado después del fallo',
          request_id: crypto.randomUUID(),
        }),
      });
      setNotice(
        `Recuperación ${result.replay_generation} en cola. El resultado aparecerá cuando termine la entrega.`,
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Recovery action failed');
      setNotice('');
    } finally {
      setBusy(false);
    }
  }

  if (session === 'ready' && !dataLoaded && error)
    return (
      <main className="center-state">
        <div className="state-mark" aria-hidden="true">!</div>
        <h1>No pudimos cargar los datos</h1>
        <p role="alert">{userFacingError(error)}</p>
        <button className="button button-primary" onClick={() => void refresh()}>
          Volver a intentar
        </button>
      </main>
    );
  if (session === 'starting' || (session === 'ready' && !dataLoaded))
    return (
      <main className="center-state" role="status" aria-busy="true">
        <div className="loader" aria-hidden="true" />
        <h1>Preparando tu espacio de prueba…</h1>
        <p>El servicio gratuito puede tardar alrededor de un minuto en iniciar. No necesitás registrarte.</p>
      </main>
    );
  if (session === 'expired' || session === 'error')
    return (
      <main className="center-state">
        <div className="state-mark">◈</div>
        <h1>{session === 'expired' ? 'Tu espacio de prueba venció' : 'No pudimos abrir tu espacio'}</h1>
        <p>El historial es temporal. Podés iniciar un espacio independiente para continuar.</p>
        {error && <p className="error-text">{userFacingError(error)}</p>}
        <button className="button button-primary" onClick={() => void startSession(true)}>
          Abrir un espacio nuevo
        </button>
      </main>
    );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" tabIndex={detail ? -1 : undefined}>
        Ir al contenido principal
      </a>
      <aside className="sidebar" inert={Boolean(detail)}>
        <a
          className="brand"
          href="#overview"
          onClick={() => setTab('Overview')}
          aria-label="Inicio de Webhook Recovery Lab"
        >
          <span className="brand-mark" aria-hidden="true">↗</span>
          <span>
            Webhook<span className="brand-light"> Recovery</span>
            <small>GESTIÓN DE ENTREGAS</small>
          </span>
        </a>
        <div className="nav-label">OPERACIONES</div>
        <nav aria-label="Navegación principal">
          {navigation.map((item) => (
            <button
              key={item.title}
              className={`nav-item ${tab === item.title ? 'active' : ''}`}
              onClick={() => setTab(item.title)}
              aria-current={tab === item.title ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {tabLabels[item.title]}
              {item.title === 'Recovery' && recovery.length > 0 && (
                <span className="nav-count">{recovery.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sandbox-card">
          <span className="live-dot" />
          <div>
            <strong>Espacio temporal</strong>
            <small>Privado para este navegador</small>
          </div>
        </div>
        <a
          className="case-link"
          href="https://github.com/franciscovitar/webhook-recovery-lab"
          target="_blank"
          rel="noreferrer"
        >
          Ver caso técnico <span aria-hidden="true">↗</span>
        </a>
      </aside>

      <div className="main-column" inert={Boolean(detail)}>
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Mi espacio</span>
            <span className="crumb-sep">/</span>
            <strong>{tabLabels[tab]}</strong>
          </div>
          <div className="top-actions">
            <span className="environment">
              <span className="live-dot" /> Modo demostración
            </span>
            <button
              className="button button-quiet"
              onClick={() => {
                setRefreshGeneration((value) => value + 1);
                void refresh();
              }}
              aria-label="Actualizar datos"
            >
              ↻ <span>Actualizar</span>
            </button>
          </div>
        </header>

        <main className="content" id="main-content">
          {error && !detail && (
            <div className="notice notice-error" role="alert">
              <span>{userFacingError(error)}</span>
              <button onClick={() => setError('')} aria-label="Cerrar error">
                ×
              </button>
            </div>
          )}
          {notice && !detail && (
            <div className="notice notice-success" role="status">
              <span>{notice}</span>
              <button onClick={() => setNotice('')} aria-label="Cerrar aviso">
                ×
              </button>
            </div>
          )}
          {pollingPaused && (
            <p className="polling-note" role="status">
              La actualización automática se pausó después de cinco minutos. Usá Actualizar para consultar el estado.
            </p>
          )}
          {tab === 'Overview' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">CENTRO DE OPERACIONES</div>
                  <h1>Resumen de entregas</h1>
                  <p>Supervisá los eventos de tus pedidos, detectá fallos y recuperá entregas desde un mismo lugar.</p>
                </div>
                <button className="button button-primary" onClick={openSendForm}>
                  <span>＋</span> Crear evento de prueba
                </button>
              </div>
              <section className="intro-panel" aria-label="Cómo funciona">
                <div className="intro-copy">
                  <div className="eyebrow">TU ESPACIO DE PRUEBA</div>
                  <h2>De un pedido a una entrega confiable</h2>
                  <p>
                    Un webhook es un aviso automático entre sistemas. Probá cómo se recibe, se
                    entrega y se recupera si algo falla, sin usar pedidos reales.
                  </p>
                </div>
                <ol className="workflow">
                  <li>
                    <span aria-hidden="true">1</span>
                    <div>
                      <strong>Recibir</strong>
                      <small>El pedido genera un evento firmado.</small>
                    </div>
                  </li>
                  <li>
                    <span aria-hidden="true">2</span>
                    <div>
                      <strong>Entregar</strong>
                      <small>El aviso llega al receptor.</small>
                    </div>
                  </li>
                  <li>
                    <span aria-hidden="true">3</span>
                    <div>
                      <strong>Recuperar</strong>
                      <small>Si falla, podés volver a enviarlo.</small>
                    </div>
                  </li>
                </ol>
              </section>
              <section className="stat-grid" aria-label="Cantidad de eventos del espacio">
                <Stat label="Recibidos" value={counts.received} foot="Guardados en el sistema" icon="↓" />
                <Stat
                  label="Entregados"
                  value={counts.delivered}
                  foot={deliveredPercent}
                  icon="✓"
                  tone="green"
                />
                <Stat
                  label="En curso"
                  value={counts.pending}
                  foot="En espera o procesamiento"
                  icon="◷"
                  tone="amber"
                />
                <Stat label="Fallidos" value={counts.failed} foot="Requieren recuperación" icon="!" tone="red" />
              </section>
              <section className="panel send-panel" id="send-event">
                <div className="panel-heading">
                  <div>
                    <h2>Crear un pedido de prueba</h2>
                    <p>
                      Generá un aviso de pedido nuevo. El sistema lo verifica, guarda y entrega al receptor de prueba.
                    </p>
                  </div>
                  <span className="pill">PRUEBA CONTROLADA</span>
                </div>
                <div className="form-row">
                  <label className="field">
                    <span>
                      Referencia del pedido <span className="optional">opcional</span>
                    </span>
                    <input
                      id="order-reference"
                      value={orderId}
                      onChange={(event) => setOrderId(event.target.value)}
                      placeholder="Ej.: PED-1042"
                      maxLength={64}
                    />
                  </label>
                  <div className="scenario-options">
                    <label className="field">
                      Tipo de entrega
                      <select
                        value={scenario}
                        onChange={(event) => setScenario(event.target.value as typeof scenario)}
                      >
                        <option value="normal">Entrega correcta</option>
                        <option value="permanent_failure">Fallo controlado</option>
                      </select>
                    </label>
                  </div>
                  <button
                    className="button button-primary send-button"
                    disabled={busy}
                    onClick={() => void sendEvent()}
                  >
                    {busy ? 'Enviando…' : 'Enviar evento'} <span aria-hidden="true">→</span>
                  </button>
                </div>
                <p className="scenario-hint">
                  {scenario === 'normal'
                    ? 'Se genera una referencia si no ingresás ninguna. El receptor aceptará el pedido en condiciones normales.'
                    : 'El receptor rechazará este evento de forma controlada. Después podrás restaurarlo y reenviarlo en Recuperación.'}
                </p>
                <div className="secure-note">
                  <span aria-hidden="true">◇</span> Solo datos ficticios · Verificación de firma HMAC · Sin destinos externos
                </div>
              </section>
              <EventTable
                events={events.slice(0, 5)}
                onOpen={openDetail}
                title="Últimos eventos"
                empty="Creá tu primer pedido de prueba para ver cómo se procesa y entrega."
                action={() => setTab('Events')}
              />
            </>
          )}

          {tab === 'Events' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">REGISTRO DE ENTRADA</div>
                  <h1>Eventos</h1>
                  <p>
                    Cada evento es un aviso recibido por el sistema. Consultá su contenido y el estado de entrega.
                  </p>
                </div>
                <button className="button button-primary" onClick={openSendForm}>
                  ＋ Crear evento de prueba
                </button>
              </div>
              <div className="filter-row">
                <label className="search-box">
                  <span aria-hidden="true">⌕</span>
                  <input
                    aria-label="Buscar eventos"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setOffset(0);
                    }}
                    placeholder="Buscar pedido o identificador"
                  />
                </label>
                <label className="filter-select">
                  <span className="sr-only">Filtrar por estado</span>
                  <select
                    value={statusFilter}
                    onChange={(event) => {
                      setStatusFilter(event.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">Todos los estados</option>
                    <option value="SUCCEEDED">Entregado</option>
                    <option value="PENDING">En espera</option>
                    <option value="LEASED">En proceso</option>
                    <option value="DEAD">Fallido</option>
                  </select>
                </label>
                <label className="date-filter">
                  Desde{' '}
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(event) => {
                      setFromDate(event.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                <label className="date-filter">
                  Hasta{' '}
                  <input
                    type="date"
                    value={toDate}
                    onChange={(event) => {
                      setToDate(event.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                {(fromDate || toDate) && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setFromDate('');
                      setToDate('');
                      setOffset(0);
                    }}
                  >
                    Limpiar fechas
                  </button>
                )}
              </div>
              <EventTable
                events={events}
                onOpen={openDetail}
                title="Todos los eventos"
                empty="No hay eventos que coincidan con estos filtros."
              />
              <div className="pagination" aria-label="Páginas de eventos">
                <span>
                  {eventTotal
                    ? `Mostrando ${offset + 1}–${Math.min(offset + events.length, eventTotal)} de ${eventTotal}`
                    : 'Sin coincidencias'}
                </span>
                <div>
                  <button
                    className="button button-quiet"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 25))}
                  >
                    Anterior
                  </button>
                  <button
                    className="button button-quiet"
                    disabled={offset + 25 >= eventTotal}
                    onClick={() => setOffset(offset + 25)}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'Deliveries' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">SEGUIMIENTO</div>
                  <h1>Entregas</h1>
                  <p>Seguí el envío de cada aviso al receptor. Abrí un pedido para revisar todos sus intentos.</p>
                </div>
              </div>
              <DeliveryTable deliveries={deliveries} onOpen={openDetail} />
            </>
          )}

          {tab === 'Recovery' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">GESTIÓN DE FALLOS</div>
                  <h1>Recuperación</h1>
                  <p>Revisá las entregas fallidas, restaurá el receptor y volvé a intentar el envío.</p>
                </div>
              </div>
              <div className="section-guide">
                <strong>¿Cómo se recupera una entrega?</strong>
                <p>Elegí una entrega fallida, indicá el motivo y restaurá el receptor antes de reenviar. El sistema conserva los intentos anteriores.</p>
                <button
                  className="text-button"
                  onClick={() => {
                    setScenario('permanent_failure');
                    openSendForm();
                  }}
                >
                  Probar un fallo controlado →
                </button>
              </div>
              {recovery.length === 0 ? (
                <EmptyState
                  title="No hay entregas por recuperar"
                  body="Cuando una entrega quede en estado fallido, aparecerá acá."
                />
              ) : (
                <div className="recovery-list">
                  {recovery.map((job) => (
                    <article className="panel recovery-card" key={job.id}>
                      <div className="recovery-title">
                        <div>
                          <div className="eyebrow">ENTREGA QUE REQUIERE ATENCIÓN</div>
                          <h2>{orderLabel(job.order_id)}</h2>
                        </div>
                        <Badge state="DEAD" />
                      </div>
                      <div className="recovery-meta">
                        <span>
                          Referencia: <code>{job.order_id}</code>
                        </span>
                        <span>{attemptCount(job.total_attempts)}</span>
                        <span>{errorLabel(job.last_error_class)}</span>
                      </div>
                      <label className="field">
                        Motivo de la recuperación
                        <textarea
                          value={replayReason[job.id] ?? ''}
                          onChange={(event) =>
                            setReplayReason({ ...replayReason, [job.id]: event.target.value })
                          }
                          placeholder="Ej.: Se restauró el receptor de pedidos"
                          maxLength={256}
                          minLength={4}
                        />
                      </label>
                      <div className="recovery-actions">
                        <button
                          className="button button-primary"
                          disabled={busy || (replayReason[job.id] ?? '').trim().length < 4}
                          onClick={() => void restoreAndReplay(job)}
                        >
                          Restaurar y reenviar
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            void openDetail(job.event_id);
                          }}
                        >
                          Ver detalle
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'Endpoints' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">DESTINO DE LOS EVENTOS</div>
                  <h1>Receptor</h1>
                  <p>
                    El receptor recibe los avisos de pedidos. En esta demo el destino es interno y no se puede cambiar.
                  </p>
                </div>
                <button className="button button-primary" onClick={openSendForm}>
                  ＋ Crear evento de prueba
                </button>
              </div>
              <section className="panel endpoint-card">
                <div className="endpoint-icon">⇢</div>
                <div className="endpoint-info">
                  <div className="endpoint-title">
                    <h2>Receptor de pedidos</h2>
                    <span
                      className={`badge ${receiverReady === true ? 'badge-succeeded' : receiverReady === false ? 'badge-dead' : 'badge-pending'}`}
                    >
                      <span className="badge-dot" />
                      {receiverReady === true
                        ? 'Disponible'
                        : receiverReady === false
                          ? 'No disponible'
                          : 'Comprobando'}
                    </span>
                  </div>
                  <p>Servicio interno que recibe los eventos enviados por el sistema.</p>
                  <div className="endpoint-detail">
                    <span>Evento admitido</span>
                    <span>Pedido creado <code>(order.created)</code></span>
                    <span>Comunicación</span>
                    <code>HTTP · ruta fija</code>
                  </div>
                </div>
              </section>
            </>
          )}

          {tab === 'Activity' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">HISTORIAL</div>
                  <h1>Actividad</h1>
                  <p>Historial de eventos recibidos, intentos de entrega y recuperaciones guardadas.</p>
                </div>
              </div>
              <section className="panel activity-list">
                {activity.length === 0 ? (
                  <EmptyState
                    title="Todavía no hay actividad"
                    body="Los eventos y sus intentos aparecerán acá cuando envíes un pedido de prueba."
                  />
                ) : (
                  activity.map((item, index) => (
                    <button
                      className="activity-row"
                      key={`${item.action}-${item.event_id}-${item.happened_at}-${index}`}
                      onClick={() => {
                        void openDetail(item.event_id);
                      }}
                    >
                      <span
                        className={`activity-symbol ${item.action === 'event_received' || item.detail.startsWith('SUCCEEDED') ? 'state-succeeded' : item.detail.startsWith('DEAD') ? 'state-dead' : 'state-pending'}`}
                      >
                        {item.action === 'event_received'
                          ? '↓'
                          : item.action === 'replay_requested'
                            ? '↻'
                            : item.detail.startsWith('SUCCEEDED')
                              ? '✓'
                              : '!'}
                      </span>
                      <span className="activity-copy">
                        <strong>{activityLabel(item.action, item.detail)}</strong>
                        <small>
                          {orderLabel(item.order_id)} · Ref. {item.order_id}
                          {item.http_status ? ` · HTTP ${item.http_status}` : ''}
                          {item.latency_ms === null ? '' : ` · ${item.latency_ms} ms`}
                        </small>
                      </span>
                      <time>{dateTime(item.happened_at)}</time>
                    </button>
                  ))
                )}
              </section>
            </>
          )}
          <footer className="page-footer">
            <span>Webhook Recovery Lab</span>
            <span>Espacio temporal · Pedidos ficticios</span>
          </footer>
        </main>
      </div>
      {detail && (
        <EventDialog
          event={detail}
          onClose={closeDetail}
          onDuplicate={() => void duplicateEvent(detail.event_id)}
          busy={busy}
          notice={notice}
          error={error}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  foot,
  icon,
  tone = '',
}: {
  label: string;
  value: number;
  foot: string;
  icon: string;
  tone?: string;
}) {
  return (
    <article className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <span className={`stat-icon ${tone}`} aria-hidden="true">{icon}</span>
      </div>
      <strong>{value.toLocaleString('es-AR')}</strong>
      <small>{foot}</small>
    </article>
  );
}

function EventTable({
  events,
  onOpen,
  title,
  empty,
  action,
  showAttempts = false,
}: {
  events: EventRow[];
  onOpen: (event: EventRow) => void;
  title: string;
  empty: string;
  action?: () => void;
  showAttempts?: boolean;
}) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {action && (
          <button className="text-button" onClick={action}>
            Ver todos <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
      {events.length === 0 ? (
        <EmptyState title="Todavía sin eventos" body={empty} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Tipo de evento</th>
                <th>Estado</th>
                <th>Recibido</th>
                <th>{showAttempts ? 'Intentos' : 'Entrega'}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td data-label="Pedido">
                    <button className="row-link" onClick={() => onOpen(event)}>
                      {orderLabel(event.payload.data.order_id)}
                    </button>
                    <small className="order-reference">Ref. {event.payload.data.order_id}</small>
                  </td>
                  <td data-label="Tipo de evento">
                    <span className="event-type">{eventLabel(event.event_type)}</span>
                  </td>
                  <td data-label="Estado">
                    <Badge state={event.status} />
                  </td>
                  <td data-label="Recibido">{dateTime(event.received_at)}</td>
                  <td data-label={showAttempts ? 'Intentos' : 'Entrega'}>
                    {showAttempts
                      ? event.total_attempts
                      : event.status === 'PENDING'
                        ? dateTime(event.next_attempt_at)
                        : event.total_attempts
                          ? attemptCount(event.total_attempts)
                          : 'En cola'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DeliveryTable({
  deliveries,
  onOpen,
}: {
  deliveries: DeliveryRow[];
  onOpen: (eventId: string) => void;
}) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <h2>Envíos al receptor</h2>
      </div>
      {deliveries.length === 0 ? (
        <EmptyState
          title="Todavía no hay entregas"
          body="Cada evento aceptado genera una entrega que podés seguir desde acá."
        />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Destino</th>
                <th>Estado</th>
                <th>Última respuesta</th>
                <th>Intentos</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.job_id}>
                  <td data-label="Pedido">
                    <button className="row-link" onClick={() => onOpen(delivery.event_id)}>
                      {orderLabel(delivery.order_id)}
                    </button>
                    <small className="order-reference">Ref. {delivery.order_id}</small>
                  </td>
                  <td data-label="Destino">
                    <span className="event-type">Receptor de pedidos</span>
                  </td>
                  <td data-label="Estado">
                    <Badge state={delivery.status} />
                  </td>
                  <td data-label="Última respuesta">
                    {delivery.latest_http_status
                      ? httpLabel(delivery.latest_http_status)
                      : delivery.status === 'PENDING'
                        ? dateTime(delivery.next_attempt_at)
                        : 'Todavía sin intentos'}
                    {delivery.latest_error_class && (
                      <small>{errorLabel(delivery.latest_error_class)}</small>
                    )}
                  </td>
                  <td data-label="Intentos">{delivery.total_attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">
        ⌁
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function EventDialog({
  event,
  onClose,
  onDuplicate,
  busy,
  notice,
  error,
}: {
  event: EventDetail;
  onClose: () => void;
  onDuplicate: () => void;
  busy: boolean;
  notice: string;
  error: string;
}) {
  useEffect(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input, textarea, select, summary, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    focusables()[0]?.focus();
    const closeOnEscape = (keyboard: KeyboardEvent) => {
      if (keyboard.key === 'Escape') onClose();
      if (keyboard.key === 'Tab') {
        const items = focusables();
        if (keyboard.shiftKey && document.activeElement === items[0]) {
          keyboard.preventDefault();
          items.at(-1)?.focus();
        } else if (!keyboard.shiftKey && document.activeElement === items.at(-1)) {
          keyboard.preventDefault();
          items[0]?.focus();
        }
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="event-dialog" role="dialog" aria-modal="true" aria-labelledby="event-dialog-title">
        <div className="dialog-heading">
          <div>
            <div className="eyebrow">DETALLE DEL EVENTO</div>
            <h2 id="event-dialog-title">{orderLabel(event.payload.data.order_id)}</h2>
            <p className="order-reference">Referencia: {event.payload.data.order_id}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Cerrar detalle del evento">
            ×
          </button>
        </div>
        <div className="detail-summary">
          <Badge state={event.status} />
          <span className={event.signature_verified ? 'signature-ok' : 'signature-unknown'}>
            {event.signature_verified ? 'Firma verificada' : 'Firma sin verificar'}
          </span>
          <span>{eventLabel(event.event_type)}</span>
          <time>{dateTime(event.received_at)}</time>
        </div>
        <button
          className="button button-quiet"
          disabled={busy || !event.signature_verified}
          onClick={onDuplicate}
        >
          Reenviar el mismo evento
        </button>
        <p className="scenario-hint">
          Comprobá que enviar los mismos datos no genere otra entrega. El sistema detecta duplicados.
        </p>
        {notice && <p className="notice notice-success" role="status">{notice}</p>}
        {error && <p className="notice notice-error" role="alert">{userFacingError(error)}</p>}
        <details className="detail-block technical-details">
          <summary>Datos técnicos e identificadores</summary>
          <h3>Identificador del evento</h3>
          <code className="copy-code">{event.event_id}</code>
          <h3>Identificador de entrega</h3>
          <code className="copy-code">{event.delivery_id}</code>
          <h3>Datos del evento (JSON)</h3>
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
          <h3>Resultados técnicos de los intentos</h3>
          <pre>{JSON.stringify(event.attempts, null, 2)}</pre>
        </details>
        <div className="detail-block">
          <h3>
            Intentos de entrega <span className="count-chip">{event.attempts.length}</span>
          </h3>
          {event.attempts.length === 0 ? (
            <p className="muted">Todavía no comenzó ningún intento.</p>
          ) : (
            <ol className="attempt-list">
              {event.attempts.map((attempt) => (
                <li key={attempt.attempt_sequence}>
                  <div>
                    <strong>Intento {attempt.attempt_sequence}</strong>
                    <small>
                      {dateTime(attempt.started_at)} · Ciclo {attempt.replay_generation + 1}
                    </small>
                  </div>
                  <span>
                    {attempt.http_status ? httpLabel(attempt.http_status) : attemptLabel(attempt.result)}
                  </span>
                  <small>
                    {attempt.latency_ms === null ? '—' : `${attempt.latency_ms} ms`} ·{' '}
                    {attempt.error_class ? errorLabel(attempt.error_class) : attemptLabel(attempt.result)}
                  </small>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}

export default App;

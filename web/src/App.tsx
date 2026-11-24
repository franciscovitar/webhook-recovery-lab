import { useCallback, useEffect, useMemo, useState } from 'react';

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
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function stateLabel(state: JobState): string {
  return { PENDING: 'Pending retry', LEASED: 'Processing', SUCCEEDED: 'Delivered', DEAD: 'Failed' }[state];
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
  const [counts, setCounts] = useState<Counts>({ received: 0, delivered: 0, pending: 0, failed: 0 });
  const [events, setEvents] = useState<EventRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [recovery, setRecovery] = useState<RecoveryRow[]>([]);
  const [detail, setDetail] = useState<EventDetail | null>(null);
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
    }
  }, [search, statusFilter, fromDate, toDate, offset]);

  const startSession = useCallback(async (fresh = false) => {
    setSession('starting');
    try {
      await request(fresh ? '/api/demo/session/new' : '/api/demo/session', { method: 'POST' });
      setSession('ready');
      setError('');
    } catch (cause) {
      setSession('error');
      setError(cause instanceof Error ? cause.message : 'Could not start a workspace');
    }
  }, []);

  useEffect(() => {
    void startSession();
  }, [startSession]);
  useEffect(() => {
    if (session === 'ready') void refresh();
  }, [refresh, session]);
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
        ? 'No events yet'
        : `${Math.round((counts.delivered / counts.received) * 100)}% of received events`,
    [counts],
  );

  async function sendEvent() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ event_id: string; status: string }>('/api/demo/test-events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(orderId.trim() ? { order_id: orderId.trim() } : {}),
          request_id: crypto.randomUUID(),
          scenario,
        }),
      });
      setNotice(`Event ${result.event_id} was accepted by the signed ingress.`);
      setOrderId('');
      await refresh();
      setTab(scenario === 'permanent_failure' ? 'Recovery' : 'Events');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The event was not accepted');
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(eventOrId: EventRow | string) {
    const eventId = typeof eventOrId === 'string' ? eventOrId : eventOrId.event_id;
    try {
      const next = await request<EventDetail>(`/api/demo/events/${eventId}`);
      setDetail(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open event');
    }
  }

  async function duplicateEvent(eventId: string) {
    setBusy(true);
    try {
      const result = await request<{ status: string }>(`/api/demo/events/${eventId}/duplicate`, {
        method: 'POST',
      });
      setNotice(`Identical signed payload reached ingress: ${result.status}.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not resend event');
    } finally {
      setBusy(false);
    }
  }

  const closeDetail = useCallback(() => setDetail(null), []);

  function openSendForm() {
    setTab('Overview');
    window.setTimeout(() => {
      document.getElementById('send-event')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('order-reference')?.focus();
    }, 0);
  }

  async function restoreAndReplay(job: RecoveryRow) {
    setBusy(true);
    setError('');
    try {
      const headers = { 'content-type': 'application/json' };
      await request(`/api/demo/recovery/${job.id}/restore`, { method: 'POST' });
      const result = await request<{ replay_generation: number }>(`/api/demo/recovery/${job.id}/replay`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          reason: replayReason[job.id] ?? 'Controlled receiver restored after test failure',
          request_id: crypto.randomUUID(),
        }),
      });
      setNotice(
        `Replay generation ${result.replay_generation} was queued and will show its persisted outcome.`,
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Recovery action failed');
    } finally {
      setBusy(false);
    }
  }

  if (session === 'starting')
    return (
      <main className="center-state">
        <div className="loader" />
        <p>Opening your private sandbox…</p>
      </main>
    );
  if (session === 'expired' || session === 'error')
    return (
      <main className="center-state">
        <div className="state-mark">◈</div>
        <h1>{session === 'expired' ? 'This sandbox has expired' : 'The sandbox could not start'}</h1>
        <p>Your event history is temporary. Start a fresh isolated workspace to continue.</p>
        {error && <p className="error-text">{error}</p>}
        <button className="button button-primary" onClick={() => void startSession(true)}>
          Start a fresh workspace
        </button>
      </main>
    );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#overview"
          onClick={() => setTab('Overview')}
          aria-label="Webhook Recovery Lab home"
        >
          <span className="brand-mark">↗</span>
          <span>
            Webhook<span className="brand-light"> Recovery</span>
            <small>LAB / SANDBOX</small>
          </span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
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
              {item.title}
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
            <strong>Temporary sandbox</strong>
            <small>Private to this browser</small>
          </div>
        </div>
        <a
          className="case-link"
          href="https://github.com/franciscovitar/webhook-recovery-lab"
          target="_blank"
          rel="noreferrer"
        >
          View engineering case <span aria-hidden="true">↗</span>
        </a>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <span className="crumb-sep">/</span>
            <strong>{tab}</strong>
          </div>
          <div className="top-actions">
            <span className="environment">
              <span className="live-dot" /> Demo environment
            </span>
            <button
              className="button button-quiet"
              onClick={() => {
                setRefreshGeneration((value) => value + 1);
                void refresh();
              }}
              aria-label="Refresh data"
            >
              ↻ <span>Refresh</span>
            </button>
          </div>
        </header>

        <main className="content" id="main-content">
          {error && (
            <div className="notice notice-error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="notice notice-success" role="status">
              <span>{notice}</span>
              <button onClick={() => setNotice('')} aria-label="Dismiss message">
                ×
              </button>
            </div>
          )}
          {pollingPaused && (
            <p className="polling-note" role="status">
              Automatic refresh paused after five minutes. Use Refresh to check again.
            </p>
          )}
          {tab === 'Overview' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">OPERATIONS</div>
                  <h1>Webhook overview</h1>
                  <p>Signed events, delivery health, and recovery in one place.</p>
                </div>
                <button className="button button-primary" onClick={openSendForm}>
                  <span>＋</span> Send test event
                </button>
              </div>
              <section className="stat-grid" aria-label="Workspace event counts">
                <Stat label="Received" value={counts.received} foot="Persisted events" icon="↓" />
                <Stat
                  label="Delivered"
                  value={counts.delivered}
                  foot={deliveredPercent}
                  icon="✓"
                  tone="green"
                />
                <Stat
                  label="Pending retry"
                  value={counts.pending}
                  foot="Waiting or processing"
                  icon="◷"
                  tone="amber"
                />
                <Stat label="Failed" value={counts.failed} foot="Needs recovery" icon="!" tone="red" />
              </section>
              <section className="panel send-panel" id="send-event">
                <div className="panel-heading">
                  <div>
                    <h2>Send a synthetic order</h2>
                    <p>
                      Creates one signed <code>order.created</code> event and sends it through the real
                      worker.
                    </p>
                  </div>
                  <span className="pill">CONTROLLED TEST</span>
                </div>
                <div className="form-row">
                  <label className="field">
                    Order reference <span className="optional">optional</span>
                    <input
                      id="order-reference"
                      value={orderId}
                      onChange={(event) => setOrderId(event.target.value)}
                      placeholder="Generated automatically"
                      maxLength={64}
                    />
                  </label>
                  <details className="scenario-options">
                    <summary>Recovery test options</summary>
                    <label className="field">
                      Test scenario
                      <select
                        value={scenario}
                        onChange={(event) => setScenario(event.target.value as typeof scenario)}
                      >
                        <option value="normal">Successful delivery</option>
                        <option value="permanent_failure">Receiver rejects · recovery test</option>
                      </select>
                    </label>
                  </details>
                  <button
                    className="button button-primary send-button"
                    disabled={busy}
                    onClick={() => void sendEvent()}
                  >
                    {busy ? 'Sending…' : 'Send event'} <span aria-hidden="true">→</span>
                  </button>
                </div>
                <div className="secure-note">
                  <span aria-hidden="true">◇</span> Synthetic data only · HMAC signature verified · No
                  external destinations
                </div>
              </section>
              <EventTable
                events={events.slice(0, 5)}
                onOpen={openDetail}
                title="Recent events"
                empty="No events received yet. Send a test event to see the real delivery flow."
                action={() => setTab('Events')}
              />
            </>
          )}

          {tab === 'Events' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">INGRESS</div>
                  <h1>Events</h1>
                  <p>Inspect accepted payloads and the delivery state derived from storage.</p>
                </div>
                <button className="button button-primary" onClick={() => void sendEvent()}>
                  ＋ Send test event
                </button>
              </div>
              <div className="filter-row">
                <label className="search-box">
                  <span aria-hidden="true">⌕</span>
                  <input
                    aria-label="Search events"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setOffset(0);
                    }}
                    placeholder="Search order or event ID"
                  />
                </label>
                <label className="filter-select">
                  <span className="sr-only">Filter by status</span>
                  <select
                    value={statusFilter}
                    onChange={(event) => {
                      setStatusFilter(event.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All statuses</option>
                    <option value="SUCCEEDED">Delivered</option>
                    <option value="PENDING">Pending retry</option>
                    <option value="LEASED">Processing</option>
                    <option value="DEAD">Failed</option>
                  </select>
                </label>
                <label className="date-filter">
                  From{' '}
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
                  To{' '}
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
                    Clear dates
                  </button>
                )}
              </div>
              <EventTable
                events={events}
                onOpen={openDetail}
                title="All events"
                empty="No events match these filters."
              />
              <div className="pagination" aria-label="Event pages">
                <span>
                  {eventTotal
                    ? `Showing ${offset + 1}–${Math.min(offset + events.length, eventTotal)} of ${eventTotal}`
                    : 'No matching events'}
                </span>
                <div>
                  <button
                    className="button button-quiet"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 25))}
                  >
                    Previous
                  </button>
                  <button
                    className="button button-quiet"
                    disabled={offset + 25 >= eventTotal}
                    onClick={() => setOffset(offset + 25)}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'Deliveries' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">DELIVERY WORKER</div>
                  <h1>Deliveries</h1>
                  <p>Each row is a durable job. Open an event to inspect its recorded attempts.</p>
                </div>
              </div>
              <DeliveryTable deliveries={deliveries} onOpen={openDetail} />
            </>
          )}

          {tab === 'Recovery' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">DEAD LETTER QUEUE</div>
                  <h1>Recovery</h1>
                  <p>Restore the controlled receiver, then replay a failed delivery with a reason.</p>
                </div>
              </div>
              {recovery.length === 0 ? (
                <EmptyState
                  title="Nothing needs recovery"
                  body="When a real delivery exhausts its retry budget, it will appear here."
                />
              ) : (
                <div className="recovery-list">
                  {recovery.map((job) => (
                    <article className="panel recovery-card" key={job.id}>
                      <div className="recovery-title">
                        <div>
                          <div className="eyebrow">ORDER {job.order_id}</div>
                          <h2>Delivery failed</h2>
                        </div>
                        <Badge state="DEAD" />
                      </div>
                      <div className="recovery-meta">
                        <span>
                          Event <code>{job.event_id}</code>
                        </span>
                        <span>{job.total_attempts} attempts</span>
                        <span>{job.last_error_class ?? 'Unknown error'}</span>
                      </div>
                      <label className="field">
                        Replay reason
                        <textarea
                          value={replayReason[job.id] ?? ''}
                          onChange={(event) =>
                            setReplayReason({ ...replayReason, [job.id]: event.target.value })
                          }
                          placeholder="Explain what was restored before replay"
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
                          Restore receiver and replay
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            void openDetail(job.event_id);
                          }}
                        >
                          Inspect event
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
                  <div className="eyebrow">CONTROLLED DESTINATION</div>
                  <h1>Endpoints</h1>
                  <p>
                    One fixed synthetic Orders receiver. Destinations cannot be changed from this workspace.
                  </p>
                </div>
                <button className="button button-primary" onClick={openSendForm}>
                  ＋ Send test event
                </button>
              </div>
              <section className="panel endpoint-card">
                <div className="endpoint-icon">⇢</div>
                <div className="endpoint-info">
                  <div className="endpoint-title">
                    <h2>Orders receiver</h2>
                    <span
                      className={`badge ${receiverReady === true ? 'badge-succeeded' : receiverReady === false ? 'badge-dead' : 'badge-pending'}`}
                    >
                      <span className="badge-dot" />
                      {receiverReady === true
                        ? 'Healthy'
                        : receiverReady === false
                          ? 'Unavailable'
                          : 'Checking'}
                    </span>
                  </div>
                  <p>Internal HTTP receiver · loopback only · authenticated worker delivery</p>
                  <div className="endpoint-detail">
                    <span>Event type</span>
                    <code>order.created</code>
                    <span>Transport</span>
                    <code>HTTP / fixed route</code>
                  </div>
                </div>
              </section>
            </>
          )}

          {tab === 'Activity' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">AUDIT TRAIL</div>
                  <h1>Activity</h1>
                  <p>Chronological view of persisted events and delivery attempts.</p>
                </div>
              </div>
              <section className="panel activity-list">
                {activity.length === 0 ? (
                  <EmptyState
                    title="No activity yet"
                    body="Accepted events and their stored delivery attempts will appear here."
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
                        <strong>{item.order_id}</strong>
                        <small>
                          {item.action.replaceAll('_', ' ')} · {item.detail}
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
            <span>Temporary workspace · Synthetic Orders data</span>
          </footer>
        </main>
      </div>
      {detail && (
        <EventDialog
          event={detail}
          onClose={closeDetail}
          onDuplicate={() => void duplicateEvent(detail.event_id)}
          busy={busy}
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
        <span className={`stat-icon ${tone}`}>{icon}</span>
      </div>
      <strong>{value.toLocaleString()}</strong>
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
            View all <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
      {events.length === 0 ? (
        <EmptyState title="No events yet" body={empty} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Event</th>
                <th>Status</th>
                <th>Received</th>
                <th>{showAttempts ? 'Attempts' : 'Delivery'}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td data-label="Order">
                    <button className="row-link" onClick={() => onOpen(event)}>
                      {event.payload.data.order_id}
                    </button>
                    <small>{event.event_id.slice(0, 8)}…</small>
                  </td>
                  <td data-label="Event">
                    <span className="event-type">{event.event_type}</span>
                  </td>
                  <td data-label="Status">
                    <Badge state={event.status} />
                  </td>
                  <td data-label="Received">{dateTime(event.received_at)}</td>
                  <td data-label={showAttempts ? 'Attempts' : 'Delivery'}>
                    {showAttempts
                      ? event.total_attempts
                      : event.status === 'PENDING'
                        ? dateTime(event.next_attempt_at)
                        : event.total_attempts
                          ? `${event.total_attempts} ${event.total_attempts === 1 ? 'attempt' : 'attempts'}`
                          : 'Queued'}
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
        <h2>Delivery jobs</h2>
      </div>
      {deliveries.length === 0 ? (
        <EmptyState title="No deliveries yet" body="Delivery jobs appear after an event is accepted." />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Delivery ID</th>
                <th>Status</th>
                <th>Last response</th>
                <th>Attempts</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.job_id}>
                  <td data-label="Order">
                    <button className="row-link" onClick={() => onOpen(delivery.event_id)}>
                      {delivery.order_id}
                    </button>
                    <small>{delivery.event_id.slice(0, 8)}…</small>
                  </td>
                  <td data-label="Delivery ID">
                    <code className="event-type">{delivery.delivery_id.slice(0, 8)}…</code>
                  </td>
                  <td data-label="Status">
                    <Badge state={delivery.status} />
                  </td>
                  <td data-label="Last response">
                    {delivery.latest_http_status
                      ? `HTTP ${delivery.latest_http_status}`
                      : delivery.status === 'PENDING'
                        ? dateTime(delivery.next_attempt_at)
                        : 'No attempt yet'}
                    {delivery.latest_error_class && <small>{delivery.latest_error_class}</small>}
                  </td>
                  <td data-label="Attempts">{delivery.total_attempts}</td>
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
}: {
  event: EventDetail;
  onClose: () => void;
  onDuplicate: () => void;
  busy: boolean;
}) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
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
      previous?.focus();
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
            <div className="eyebrow">EVENT DETAIL</div>
            <h2 id="event-dialog-title">{event.payload.data.order_id}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close event details">
            ×
          </button>
        </div>
        <div className="detail-summary">
          <Badge state={event.status} />
          <span className={event.signature_verified ? 'signature-ok' : 'signature-unknown'}>
            {event.signature_verified ? 'Signature accepted' : 'Signature unknown'}
          </span>
          <span>{event.event_type}</span>
          <time>{dateTime(event.received_at)}</time>
        </div>
        <button
          className="button button-quiet"
          disabled={busy || !event.signature_verified}
          onClick={onDuplicate}
        >
          Send identical payload again
        </button>
        <div className="detail-block">
          <h3>Event identity</h3>
          <code className="copy-code">{event.event_id}</code>
          <h3>Delivery ID</h3>
          <code className="copy-code">{event.delivery_id}</code>
        </div>
        <div className="detail-block">
          <h3>Sanitized payload</h3>
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
        </div>
        <div className="detail-block">
          <h3>
            Delivery attempts <span className="count-chip">{event.attempts.length}</span>
          </h3>
          {event.attempts.length === 0 ? (
            <p className="muted">No attempt has started yet.</p>
          ) : (
            <ol className="attempt-list">
              {event.attempts.map((attempt) => (
                <li key={attempt.attempt_sequence}>
                  <div>
                    <strong>Attempt {attempt.attempt_sequence}</strong>
                    <small>
                      {dateTime(attempt.started_at)} · Generation {attempt.replay_generation}
                    </small>
                  </div>
                  <span>{attempt.http_status ?? attempt.result}</span>
                  <small>
                    {attempt.latency_ms === null ? '—' : `${attempt.latency_ms} ms`} ·{' '}
                    {attempt.error_class ?? attempt.result}
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

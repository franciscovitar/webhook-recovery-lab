/** Deterministic, browser-only illustration of the private Webhook Recovery Lab invariants. */
export const MAX_ATTEMPTS = 5;

export function initialState() {
  return { event: null, job: 'EMPTY', attempts: 0, generation: 1, receipts: 0, sends: 0,
    inbox: 0, deduplicated: 0, lease: 0, replays: 0, nextRetry: null, tick: 0,
    log: [{ id: 0, code: 'READY', title: 'Laboratorio preparado', detail: 'Datos inventados; no se reciben webhooks ni se abre una conexión real.', tone: 'info' }] };
}

function emit(state, code, title, detail, tone='info') {
  const tick = state.tick + 1;
  return { ...state, tick, log: [{ id: tick, code, title, detail, tone }, ...state.log].slice(0,30) };
}

function isPending(s) { return s.job === 'PENDING'; }

export function apply(state, action) {
  switch(action.type) {
    case 'RESET': return initialState();
    case 'SIGNATURE_BAD': return emit(state,'401','Firma HMAC inválida','La puerta de entrada rechaza el cuerpo antes de tocar el inbox.','error');
    case 'TIMESTAMP_STALE': return emit(state,'401','Ventana de replay vencida','Un timestamp fuera de la ventana de ±5 minutos se rechaza.','error');
    case 'INGEST':
      if (state.event) return emit(state,'200','Redelivery idéntica','La clave (provider, event_id) ya existe y el cuerpo coincide: no se duplica el trabajo.','success');
      return emit({ ...state, event:{ id:'evt_00042', provider:'shop-demo', deliveryId:'dlv_evt_00042' }, inbox:1, job:'PENDING' }, '202','Evento persistido','Inbox y delivery job se guardan en una transacción antes de responder 202.','success');
    case 'DUPLICATE':
      if(!state.event) return emit(state,'422','Sin evento original','Primero generá un evento firmado.','error');
      return emit({ ...state,deduplicated:state.deduplicated+1 },'200','Duplicado absorbido','Mismo event_id + mismos bytes: una fila de inbox, un único job.','success');
    case 'CHANGED_PAYLOAD':
      if(!state.event) return emit(state,'422','Sin clave existente','Primero persistí un evento.','error');
      return emit(state,'409','Conflicto de identidad','Mismo event_id, payload diferente: la transacción no crea una segunda operación.','error');
    case 'SUCCESS':
      if(!isPending(state)) return emit(state,'409','No hay trabajo disponible','El worker solo reclama jobs PENDING que ya están listos.','error');
      return emit({ ...state, job:'SUCCEEDED', attempts:state.attempts+1, sends:state.sends+1, lease:state.lease+1,
        receipts:1, nextRetry:null },'200','Entrega confirmada','Worker tomó el lease, receptor guardó el delivery_id y el ACK fue confirmado.','success');
    case 'HTTP_503':
      if(!isPending(state)) return emit(state,'409','No hay intento disponible','En este escenario no hay trabajo PENDING.','error');
      {
        const attempts=state.attempts+1;const dead=attempts>=MAX_ATTEMPTS;
        return emit({ ...state,attempts,sends:state.sends+1,lease:state.lease+1,job:dead?'DEAD':'PENDING',
          nextRetry:dead?null:`backoff ${2**attempts}s + jitter` },dead?'DEAD':'503',
          dead?'Límite de reintentos alcanzado':'Falla transitoria del receptor',
          dead?`El intento ${attempts}/${MAX_ATTEMPTS} agotó el presupuesto; requiere revisión y replay autorizado.`:`Intento ${attempts}/${MAX_ATTEMPTS}. Se programa retry limitado; no se pierde el evento.`,dead?'error':'warning');
      }
    case 'CRASH_AFTER_COMMIT':
      if(!isPending(state)) return emit(state,'409','Crash no aplicable','Se necesita un job PENDING.','error');
      return emit({ ...state,job:'LEASED',attempts:state.attempts+1,sends:state.sends+1,lease:state.lease+1,receipts:1,nextRetry:null },
        'CRASH','Worker cae después del commit','El receptor guardó el efecto, pero el worker murió antes de reconocerlo. El lease queda pendiente.','warning');
    case 'RECOVER_LEASE':
      if(state.job!=='LEASED') return emit(state,'409','No hay lease expirado','Primero simulá un crash después del commit.','error');
      return emit({ ...state,job:'SUCCEEDED',attempts:state.attempts+1,sends:state.sends+1,lease:state.lease+1,nextRetry:null },
        '200','Lease recuperado; efecto deduplicado',
        'Nuevo fencing token, mismo delivery_id. Hubo dos envíos HTTP y exactamente un recibo durable.','success');
    case 'REPLAY':
      if(state.job!=='DEAD') return emit(state,'403','Replay no aplicable','Solo se reintenta manualmente un job DEAD luego de revisar la causa.','error');
      return emit({ ...state,job:'PENDING',attempts:0,generation:state.generation+1,replays:state.replays+1,nextRetry:null },
        'REPLAY','Nueva generación auditada','El operador habilita otra generación de hasta cinco intentos. No duplica el inbox.','success');
    case 'EXHAUST': {
      if(!isPending(state)) return emit(state,'409','Agotamiento no aplicable','Primero ingresá el evento.','error');
      let s=state;
      while (s.job==='PENDING' && s.attempts<MAX_ATTEMPTS) s=apply(s,{type:'HTTP_503'});
      return s;
    }
    default: return state;
  }
}

export function available(state) {
  return { ingest:!state.event, processing:isPending(state), recover:state.job==='LEASED', replay:state.job==='DEAD', duplicate:!!state.event };
}

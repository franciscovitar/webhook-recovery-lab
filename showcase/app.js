/* global document -- browser-only entrypoint; the backend's default ESLint environment is Node. */
import { apply, available, initialState, MAX_ATTEMPTS } from './model.js';

let state=initialState();
const $=(id)=>document.getElementById(id);
const pad=(n)=>String(n).padStart(2,'0');

function render(){
  const allowed=available(state);
  $('inbox-count').textContent=state.inbox;
  $('send-count').textContent=state.sends;
  $('receipt-count').textContent=state.receipts;
  $('attempt-count').textContent=`${state.attempts} / ${MAX_ATTEMPTS}`;
  $('lease-count').textContent=state.lease;
  $('job-status').textContent=state.job;
  $('job-status').dataset.status=state.job;
  $('event-id').textContent=state.event?.id||'No ingresado';
  $('generation').textContent=pad(state.generation);
  $('next-retry').textContent=state.nextRetry||'—';
  $('replay-count').textContent=state.replays;
  const buttons={ingest:allowed.ingest,duplicate:allowed.duplicate,changed:allowed.duplicate,success:allowed.processing,fail:allowed.processing,crash:allowed.processing,recover:allowed.recover,exhaust:allowed.processing,replay:allowed.replay};
  Object.entries(buttons).forEach(([id,enabled])=>{$(id).disabled=!enabled});
  const log=$('event-log');
  log.replaceChildren(...state.log.map((event)=>{
    const li=document.createElement('li');li.className=`log-item ${event.tone}`;
    const heading=document.createElement('div');
    const code=document.createElement('span');code.textContent=event.code;
    const title=document.createElement('strong');title.textContent=event.title;
    heading.append(code,title);
    const detail=document.createElement('p');detail.textContent=event.detail;
    li.append(heading,detail);return li;
  }));
  $('log-count').textContent=pad(state.log.length);
  $('dedup-count').textContent=state.deduplicated;
  $('gen-bottom').textContent=pad(state.generation);
}

document.addEventListener('click',(event)=>{
  const button=event.target.closest('button[data-action]');
  if(!button||button.disabled)return;
  state=apply(state,{type:button.dataset.action});
  render();
});
render();

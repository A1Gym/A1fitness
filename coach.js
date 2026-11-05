import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, collection, getDoc, getDocs, setDoc, onSnapshot, query, where, orderBy, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBmMtXSGjH8_oZclmFVMe9d7f2RvEc77FU",
  authDomain: "a1-fitness-b21d0.firebaseapp.com",
  projectId: "a1-fitness-b21d0",
  storageBucket: "a1-fitness-b21d0.firebasestorage.app",
  messagingSenderId: "505856161087",
  appId: "1:505856161087:web:287c740e463eb077efcf8a"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const $ = (id) => document.getElementById(id);
const S = {
  members: {}, signups: {}, cfg: { closedWeekdays: [0], closedDates: [] }, todayDocs: [],
  loaded: false, error: '', filter: 'all', q: '', confirmId: null, renewId: null, renewDraft: null, busy: false
};
let unsubs = [];
let todayUnsub = null;
let todayWatching = '';
let addDraft = null;
let addPlan = null;
let cdDraft = null;
let downloadsOk = true;
let toastTimer = 0;

/* ---------- dates (plain YYYY-MM-DD strings, device local time) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const parseISO = (s) => { const a = s.split('-').map(Number); return { y: a[0], m: a[1], d: a[2] }; };
const dayNum = (s) => { const p = parseISO(s); return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000); };
const addDays = (s, n) => { const t = new Date((dayNum(s) + n) * 86400000); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
const weekday = (s) => new Date(dayNum(s) * 86400000).getUTCDay();
function addMonths(s, n) {
  const p = parseISO(s);
  let m = p.m - 1 + n;
  const y = p.y + Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  const dim = new Date(y, m + 1, 0).getDate();
  return y + '-' + pad(m + 1) + '-' + pad(Math.min(p.d, dim));
}
function fmt(s) {
  if (!s) return '—';
  const p = parseISO(s);
  return new Date(p.y, p.m - 1, p.d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const daysSince = (day) => dayNum(todayISO()) - dayNum(day);
const timeOf = (ms) => ms ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
const dayWord = (n) => n + (n === 1 ? ' day' : ' days');
const isClosed = (day) => S.cfg.closedWeekdays.indexOf(weekday(day)) !== -1 || S.cfg.closedDates.indexOf(day) !== -1;
function openBefore(day) {
  let d = day;
  for (let i = 0; i < 60; i++) { d = addDays(d, -1); if (!isClosed(d)) return d; }
  return d;
}

/* ---------- people ---------- */
const phoneKey = (p) => String(p || '').replace(/\D/g, '').slice(-9);
function allPeople() {
  const list = Object.keys(S.members).map((k) => Object.assign({ id: k }, S.members[k]));
  Object.keys(S.signups).forEach((k) => {
    if (S.members[k]) return;
    const s = S.signups[k];
    list.push({ id: k, name: s.name, phone: s.phone, pendingSignup: true, createdAtMs: s.createdAt && s.createdAt.toMillis ? s.createdAt.toMillis() : 0 });
  });
  return list;
}
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });

/* ---------- membership rules ---------- */
function monthsOf(d) {
  if (d.custom) { const n = parseInt(d.customText, 10); return n >= 1 && n <= 60 ? n : 0; }
  return d.months;
}
const planLabel = (m) => { const n = Number(m.months); return !n ? '—' : n === 1 ? '1 month' : n + ' months'; };
const fmtPrice = (p) => typeof p === 'number' && isFinite(p) ? p.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : '—';
/* A membership closes on its end date: from that day on it shows as expired until the coach renews it. */
function status(m) {
  if (m.pendingSignup) return { kind: 'warn', label: 'New sign-up', pending: true };
  if (m.active === false) return { kind: 'idle', label: 'Paused', paused: true };
  if (!m.end) return { kind: 'warn', label: 'Pending plan', pending: true };
  const diff = dayNum(m.end) - dayNum(todayISO());
  if (diff <= 0) return { kind: 'bad', label: diff === 0 ? 'Expired today' : 'Expired ' + (-diff) + (diff === -1 ? ' day ago' : ' days ago'), expired: true };
  if (diff <= 7) return { kind: 'warn', label: 'Ends in ' + dayWord(diff), soon: true };
  return { kind: 'ok', label: 'Active' };
}
/* A streak is alive until the next open day passes without a visit. */
function streakNow(m) {
  if (!m.lastVisit) return 0;
  return m.lastVisit >= openBefore(todayISO()) ? (Number(m.streak) || 0) : 0;
}
function visitText(m) {
  if (!m.lastVisit) return 'Never';
  const d = daysSince(m.lastVisit);
  const t = timeOf(m.lastVisitAt);
  if (d <= 0) return 'Today' + (t ? ' ' + t : '');
  if (d === 1) return 'Yesterday' + (t ? ' ' + t : '');
  return d + ' days ago';
}
function awayText(m) {
  const ref = m.lastVisit || m.start || m.joined || '';
  if (!ref) return '—';
  const d = daysSince(ref);
  return d <= 0 ? '0 days' : dayWord(d) + (m.lastVisit ? '' : ' (new)');
}
function isAbsent(m) {
  const st = status(m);
  if (st.paused || st.expired || st.pending) return false;
  const ref = m.lastVisit || m.start || m.joined || '';
  return !!ref && daysSince(ref) >= 7;
}
function newDraft() { return { start: todayISO(), months: 1, custom: false, customText: '', price: '', paid: false }; }
function draftFor(m) {
  const d = newDraft();
  if (m.end && dayNum(m.end) > dayNum(todayISO())) d.start = m.end;
  const n = Number(m.months);
  if (n && [1, 3, 6, 12].indexOf(n) === -1) { d.custom = true; d.customText = String(n); } else if (n) { d.months = n; }
  if (typeof m.price === 'number') d.price = String(m.price);
  return d;
}
function validatePlan(d) {
  if (!d.start) return 'Choose the start date.';
  if (!monthsOf(d)) return d.custom ? 'Enter a number of months between 1 and 60.' : 'Choose a plan length.';
  if (d.price === '' || !isFinite(Number(d.price)) || Number(d.price) < 0) return 'Enter the price this member pays.';
  return '';
}

/* ---------- small helpers ---------- */
function h(tag, props) {
  const el = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach((k) => {
      const v = props[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    });
  }
  for (let i = 2; i < arguments.length; i++) {
    const kid = arguments[i];
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) { kid.forEach((k2) => el.append(k2)); continue; }
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}
function errMsg(e) {
  const c = e && e.code;
  if (c === 'permission-denied') return 'This account is not allowed to change members.';
  if (c === 'unavailable') return 'No connection. Try again.';
  return 'Could not save. Check your connection and try again.';
}
function run(fn, okMsg) {
  if (S.busy) return Promise.resolve(false);
  S.busy = true;
  return Promise.resolve().then(fn).then(() => { if (okMsg) toast(okMsg); return true; })
    .catch((e) => { toast(errMsg(e)); return false; })
    .then((ok) => { S.busy = false; return ok; });
}

/* ---------- plan picker: start date, plan length, price, paid ---------- */
function buildPlan(d, idp, startLabel) {
  const chips = [];
  const endLine = h('p', { class: 'endline' });
  const errEl = h('p', { class: 'err full', role: 'alert', hidden: true });
  const customInput = h('input', {
    id: idp + 'Custom', type: 'number', min: '1', max: '60', step: '1', inputmode: 'numeric',
    placeholder: 'Number of months (1 to 60)', 'aria-label': 'Custom number of months', value: d.customText || '',
    oninput: (e) => { d.customText = e.target.value; upd(); }
  });
  const customField = h('div', { class: 'field full' }, customInput);
  function upd() {
    const mo = monthsOf(d);
    endLine.replaceChildren();
    if (mo && d.start) endLine.append('Ends on ', h('strong', { text: fmt(addMonths(d.start, mo)) }), '. The membership closes by itself that day.');
    else endLine.textContent = 'Pick a plan length to see the end date.';
    chips.forEach((c) => { c.el.setAttribute('aria-pressed', String(c.custom ? d.custom : (!d.custom && d.months === c.n))); });
    customField.hidden = !d.custom;
    errEl.hidden = true;
  }
  const opts = [1, 3, 6, 12].map((n) => {
    const el = h('button', { class: 'chip', type: 'button', text: n === 1 ? '1 month' : n + ' months', onclick: () => { d.custom = false; d.months = n; upd(); } });
    chips.push({ el: el, n: n });
    return el;
  });
  const customChip = h('button', { class: 'chip', type: 'button', text: 'Custom', onclick: () => { d.custom = true; upd(); customInput.focus(); } });
  chips.push({ el: customChip, custom: true });
  const el = h('div', { class: 'plan' },
    h('div', { class: 'field' }, h('label', { for: idp + 'Start', text: startLabel }),
      h('input', { id: idp + 'Start', type: 'date', value: d.start, oninput: (e) => { d.start = e.target.value; upd(); } })),
    h('div', { class: 'field' }, h('label', { for: idp + 'Price', text: 'Price paid' }),
      h('input', { id: idp + 'Price', type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '0', value: d.price, oninput: (e) => { d.price = e.target.value; } })),
    h('div', { class: 'field full' }, h('span', { class: 'lbl', text: 'Plan length' }),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Plan length' }, opts, customChip)),
    customField,
    h('div', { class: 'field full' }, endLine),
    h('label', { class: 'paid full' },
      h('input', { id: idp + 'Paid', type: 'checkbox', checked: d.paid, onchange: (e) => { d.paid = e.target.checked; } }),
      h('span', { text: 'Paid for this plan' })),
    errEl
  );
  upd();
  return { el: el, setError: (msg) => { errEl.textContent = msg; errEl.hidden = !msg; } };
}

/* ---------- rendering ---------- */
function visibleMembers() {
  const q = S.q.trim().toLowerCase();
  return allPeople().filter((m) => {
    const st = status(m);
    if (S.filter === 'active' && (st.paused || st.expired || st.pending)) return false;
    if (S.filter === 'pending' && !st.pending) return false;
    if (S.filter === 'expired' && (st.paused || !st.expired)) return false;
    if (S.filter === 'paused' && !st.paused) return false;
    if (S.filter === 'absent' && !isAbsent(m)) return false;
    if (!q) return true;
    return String(m.name || '').toLowerCase().indexOf(q) !== -1 || String(m.phone || '').replace(/\s+/g, '').indexOf(q.replace(/\s+/g, '')) !== -1;
  }).sort((a, b) => {
    const pa = status(a).pending ? 0 : 1, pb = status(b).pending ? 0 : 1;
    return pa - pb || byName(a, b);
  });
}
function renderStats() {
  let active = 0, unpaid = 0, expired = 0, paused = 0, absent = 0, pending = 0;
  const list = allPeople();
  list.forEach((m) => {
    const st = status(m);
    if (isAbsent(m)) absent++;
    if (st.paused) { paused++; return; }
    if (st.pending) { pending++; return; }
    if (st.expired) { expired++; return; }
    active++;
    if (m.paid !== true) unpaid++;
  });
  $('nActive').textContent = active;
  $('nToday').textContent = S.todayDocs.length;
  $('nUnpaid').textContent = unpaid;
  $('nUnpaid').className = 'stat-n' + (unpaid ? ' bad' : '');
  $('cAll').textContent = list.length;
  $('cActive').textContent = active;
  $('cExpired').textContent = expired;
  $('cPaused').textContent = paused;
  $('cPending').textContent = pending;
  $('cAbsent').textContent = absent;
  $('pendingBar').hidden = pending === 0;
  $('pendingText').textContent = pending + (pending === 1 ? ' new member is' : ' new members are') + ' waiting for a plan.';
}
function renderToday() {
  const docs = S.todayDocs.slice().sort((a, b) => b.atMs - a.atMs);
  $('todayCount').textContent = !S.loaded ? '' : docs.length ? docs.length + ' in today' : 'No one in yet today';
  $('closedNote').hidden = !isClosed(todayISO());
  const box = $('todayList');
  box.replaceChildren();
  docs.slice(0, 10).forEach((c) => {
    const m = S.members[c.key];
    box.append(h('li', null, h('span', { class: 'in-t', text: timeOf(c.atMs) }), h('span', { class: 'in-n', text: c.name || 'Member' }), h('span', { class: 'in-s', text: (Number(c.streak) || 0) + 'd' })));
  });
  if (docs.length > 10) box.append(h('li', { class: 'in-more', text: 'and ' + (docs.length - 10) + ' more' }));
}
function renderEmpty(list) {
  const box = $('empty');
  box.replaceChildren();
  if (!S.loaded) { box.append(h('p', { text: S.error ? 'The member list could not be opened.' : 'Loading members…' })); return; }
  if (allPeople().length === 0) {
    box.append(h('h2', { text: 'No members yet' }), h('p', { text: 'Add your first member with the button above, or let new members scan the gym poster and sign up on their phones.' }));
  } else if (list.length === 0) {
    const q = S.q.trim();
    box.append(h('p', { text: q ? 'No one matches “' + q + '”.' : 'No members in this view.' }));
  }
}
function memberRow(m) {
  const st = status(m);
  const name = m.name || 'this member';
  const paidNow = m.paid === true;
  const parts = [];
  if (S.confirmId === m.id) {
    parts.push(h('div', { class: 'confirm' },
      h('span', { text: 'Remove ' + name + ' for good?' }),
      h('button', { class: 'btn btn-danger', type: 'button', text: 'Yes, remove', onclick: () => removeMember(m) }),
      h('button', { class: 'btn btn-quiet', type: 'button', text: 'Keep', onclick: () => { S.confirmId = null; renderList(); } })
    ));
  } else if (m.pendingSignup) {
    parts.push(h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', text: 'Set plan', onclick: () => openRenew(m) }),
      h('button', { class: 'btn btn-quiet btn-danger', type: 'button', text: 'Remove', onclick: () => { S.confirmId = m.id; renderList(); } })
    ));
  } else {
    parts.push(h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', text: 'Check in', onclick: () => coachCheckIn(m) }),
      h('label', { class: 'paid' },
        h('input', {
          type: 'checkbox', checked: paidNow, 'aria-label': 'Paid for ' + name,
          onchange: (e) => {
            const v = e.target.checked;
            run(() => writeBatchOps((b) => b.update(doc(db, 'members', m.id), { paid: v })), v ? name + ' marked as paid' : name + ' marked as not paid').then(() => renderList());
          }
        }),
        h('span', { class: paidNow ? 'ok' : 'warn', text: paidNow ? 'Paid' : 'Not paid' })),
      h('button', { class: 'btn' + (st.expired || st.pending ? ' btn-primary' : ''), type: 'button', text: st.pending ? 'Set plan' : 'Renew', onclick: () => openRenew(m) }),
      h('button', { class: 'btn btn-quiet', type: 'button', text: st.paused ? 'Resume' : 'Pause', onclick: () => toggleActive(m) }),
      h('button', { class: 'btn btn-quiet btn-danger', type: 'button', text: 'Remove', onclick: () => { S.confirmId = m.id; renderList(); } })
    ));
  }
  if (S.renewId === m.id && S.renewDraft) {
    const plan = buildPlan(S.renewDraft, 'r' + m.id, 'Starts on');
    parts.push(h('div', { class: 'renew' },
      h('h4', { text: m.pendingSignup || st.pending ? 'Set the plan' : 'Renew or change plan' }),
      plan.el,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Save plan', onclick: () => savePlan(m, plan) }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Cancel', onclick: () => { S.renewId = null; S.renewDraft = null; renderList(); } })
      )
    ));
  }
  const streak = streakNow(m);
  return h('li', { class: 'row', 'data-id': m.id },
    h('div', { class: 'name-line' }, h('h3', { class: 'name', text: m.name || 'Unnamed' }), h('span', { class: 'pill ' + st.kind, text: st.label })),
    h('dl', { class: 'meta' },
      h('div', null, h('dt', { text: 'Phone' }), h('dd', { text: m.phone || '—' })),
      h('div', null, h('dt', { text: 'Plan' }), h('dd', { text: planLabel(m) })),
      h('div', null, h('dt', { text: 'Price' }), h('dd', { text: fmtPrice(m.price) })),
      h('div', null, h('dt', { text: 'Ends' }), h('dd', { text: fmt(m.end) })),
      h('div', null, h('dt', { text: 'Last visit' }), h('dd', { text: visitText(m) })),
      h('div', null, h('dt', { text: 'Days away' }), h('dd', { text: awayText(m) })),
      h('div', null, h('dt', { text: 'Streak' }), h('dd', { text: dayWord(streak) + ((Number(m.bestStreak) || 0) > streak ? ' (best ' + m.bestStreak + ')' : '') }))
    ),
    parts
  );
}
function renderList() {
  renderStats();
  renderToday();
  const list = S.loaded ? visibleMembers() : [];
  const ul = $('rows');
  ul.replaceChildren.apply(ul, list.map(memberRow));
  ul.hidden = list.length === 0;
  renderEmpty(list);
}
function setFilter(f) {
  S.filter = f;
  Array.prototype.forEach.call($('tabs').querySelectorAll('button'), (x) => { x.setAttribute('aria-pressed', String(x.getAttribute('data-f') === f)); });
  renderList();
}

/* ---------- writes ---------- */
async function writeBatchOps(fn) {
  const b = writeBatch(db);
  fn(b);
  await b.commit();
}
/* Saves a plan for a new member, a sign-up from a phone, or an existing member. Also refreshes the public summary the check-in page reads. */
function writeMemberPlan(key, info, plan) {
  const existing = S.members[key];
  const hadSignup = !!S.signups[key];
  return writeBatchOps((b) => {
    const fields = { name: info.name, phone: info.phone, start: plan.start, months: plan.months, price: plan.price, end: plan.end, paid: plan.paid };
    if (existing) b.update(doc(db, 'members', key), fields);
    else b.set(doc(db, 'members', key), Object.assign({ joined: plan.start, active: true, createdAt: serverTimestamp() }, fields));
    b.set(doc(db, 'pub', key), { name: info.name, state: existing && existing.active === false ? 'paused' : 'active', end: plan.end });
    if (hadSignup) b.delete(doc(db, 'signups', key));
  });
}
function planFromDraft(d) {
  const months = monthsOf(d);
  return { start: d.start, months: months, price: Number(d.price), end: addMonths(d.start, months), paid: d.paid };
}
function savePlan(m, plan) {
  const d = S.renewDraft;
  const msg = validatePlan(d);
  if (msg) { plan.setError(msg); return; }
  const p = planFromDraft(d);
  run(() => writeMemberPlan(m.id, { name: m.name, phone: m.phone }, p), 'Plan saved. ' + (m.name || 'Member') + ' ends ' + fmt(p.end)).then((ok) => {
    if (ok) { S.renewId = null; S.renewDraft = null; renderList(); }
  });
}
function openRenew(m) {
  S.confirmId = null;
  S.renewId = m.id;
  S.renewDraft = draftFor(m);
  if (!visibleMembers().some((x) => x.id === m.id)) { S.q = ''; $('q').value = ''; setFilter('all'); }
  renderList();
  const row = document.querySelector('.row[data-id="' + m.id + '"]');
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
}
function toggleActive(m) {
  const resume = m.active === false;
  run(() => writeBatchOps((b) => {
    b.update(doc(db, 'members', m.id), { active: resume });
    b.update(doc(db, 'pub', m.id), { state: resume ? 'active' : 'paused' });
  }), resume ? m.name + ' is active again' : m.name + ' paused');
}
function removeMember(m) {
  run(() => writeBatchOps((b) => {
    if (m.pendingSignup) b.delete(doc(db, 'signups', m.id));
    else { b.delete(doc(db, 'members', m.id)); b.delete(doc(db, 'pub', m.id)); }
  }), (m.name || 'Member') + ' removed').then((ok) => { if (ok) { S.confirmId = null; renderList(); } });
}
/* For a member who has no phone: the coach checks them in. Same record as a phone check-in. */
function coachCheckIn(m) {
  const st = status(m);
  const today = todayISO();
  if (st.pending) { toast('Set a plan first.'); return; }
  if (st.paused) { toast(m.name + ' is paused.'); return; }
  if (st.expired) { toast(m.name + "'s plan has ended. Renew it first."); return; }
  if (isClosed(today)) { toast('A1 is closed today.'); return; }
  run(async () => {
    const id = m.id + '_' + today;
    const ex = await getDoc(doc(db, 'checkins', id));
    if (ex.exists()) { toast(m.name + ' is already checked in today.'); return; }
    const ps = await getDoc(doc(db, 'checkins', m.id + '_' + openBefore(today)));
    const streak = ps.exists() ? (Number(ps.data().streak) || 0) + 1 : 1;
    await setDoc(doc(db, 'checkins', id), { key: m.id, name: m.name, date: today, at: serverTimestamp(), streak: streak });
    toast(m.name + ' checked in. Streak ' + dayWord(streak) + '.');
  });
}

/* ---------- reading check-ins into each member's summary ---------- */
/* Members check in on their own phones, which can only add check-in records. This copies the latest visit and streak onto the member, so the list is quick to read. */
function applyCheckins(docs) {
  if (!S.loaded) return Promise.resolve();
  const best = {};
  docs.forEach((c) => {
    if (!c || !c.key || !c.date) return;
    const b = best[c.key] || (best[c.key] = { date: '', atMs: 0, streak: 0, max: 0 });
    if (c.date > b.date || (c.date === b.date && c.atMs > b.atMs)) { b.date = c.date; b.atMs = c.atMs; b.streak = Number(c.streak) || 0; }
    b.max = Math.max(b.max, Number(c.streak) || 0);
  });
  const writes = [];
  Object.keys(best).forEach((key) => {
    const m = S.members[key];
    if (!m) return;
    const b = best[key];
    const upd = {};
    const lv = m.lastVisit || '';
    if (lv < b.date || (lv === b.date && (m.lastVisitAt || 0) < b.atMs)) { upd.lastVisit = b.date; upd.lastVisitAt = b.atMs; upd.streak = b.streak; }
    const bs = Math.max(Number(m.bestStreak) || 0, b.max);
    if (bs !== (Number(m.bestStreak) || 0)) upd.bestStreak = bs;
    if (Object.keys(upd).length) writes.push([key, upd]);
  });
  if (!writes.length) return Promise.resolve();
  const chunks = [];
  for (let i = 0; i < writes.length; i += 400) chunks.push(writes.slice(i, i + 400));
  return Promise.all(chunks.map((ch) => writeBatchOps((b) => ch.forEach((w) => b.update(doc(db, 'members', w[0]), w[1]))))).catch(() => {});
}
const readCheckin = (d) => {
  const c = d.data();
  return { key: c.key, name: c.name, date: c.date, streak: c.streak, atMs: c.at && c.at.toMillis ? c.at.toMillis() : 0 };
};
async function catchUp() {
  try {
    const st = await getDoc(doc(db, 'sync', 'state'));
    const done = st.exists() ? (st.data().doneThrough || '') : '';
    const q = done ? query(collection(db, 'checkins'), where('date', '>', done), orderBy('date')) : query(collection(db, 'checkins'), orderBy('date'));
    const snap = await getDocs(q);
    await applyCheckins(snap.docs.map(readCheckin));
    const yesterday = addDays(todayISO(), -1);
    if (yesterday > done) await setDoc(doc(db, 'sync', 'state'), { doneThrough: yesterday });
  } catch (e) { /* the live list below still works */ }
}
function watchToday() {
  const t = todayISO();
  if (todayWatching === t) return;
  if (todayUnsub) todayUnsub();
  todayWatching = t;
  todayUnsub = onSnapshot(query(collection(db, 'checkins'), where('date', '==', t)), (snap) => {
    S.todayDocs = snap.docs.map(readCheckin);
    renderList();
    applyCheckins(S.todayDocs);
  }, () => {});
}

/* ---------- live data ---------- */
function startData() {
  stopData();
  S.loaded = false;
  S.error = '';
  let firstMembers = true;
  unsubs.push(onSnapshot(collection(db, 'members'), (snap) => {
    S.members = {};
    snap.docs.forEach((d) => { S.members[d.id] = d.data(); });
    const first = !S.loaded;
    S.loaded = true;
    renderList();
    if (first) catchUp();
    else applyCheckins(S.todayDocs);
    if (firstMembers) {
      firstMembers = false;
      if (allPeople().length === 0) setAddOpen(true);
    }
  }, (err) => {
    S.error = (err && err.code) || 'error';
    showGate(S.error === 'permission-denied' ? 'This account is not set up as a coach. Ask the owner to add your email to the security rules.' : 'The member list could not be opened. Check your connection and reload.');
  }));
  unsubs.push(onSnapshot(collection(db, 'signups'), (snap) => {
    S.signups = {};
    snap.docs.forEach((d) => { S.signups[d.id] = d.data(); });
    renderList();
  }, () => {}));
  unsubs.push(onSnapshot(doc(db, 'config', 'gym'), (snap) => {
    if (snap.exists()) {
      const d = snap.data();
      S.cfg = { closedWeekdays: Array.isArray(d.closedWeekdays) ? d.closedWeekdays : [0], closedDates: Array.isArray(d.closedDates) ? d.closedDates : [] };
    } else {
      S.cfg = { closedWeekdays: [0], closedDates: [] };
    }
    renderList();
  }, () => {}));
  watchToday();
}
function stopData() {
  unsubs.forEach((u) => { try { u(); } catch (e) {} });
  unsubs = [];
  if (todayUnsub) { todayUnsub(); todayUnsub = null; }
  todayWatching = '';
  S.members = {}; S.signups = {}; S.todayDocs = [];
}

/* ---------- add member ---------- */
function mountAdd() {
  addPlan = buildPlan(addDraft, 'a', 'Join date');
  $('addPlan').replaceChildren(addPlan.el);
}
function setAddOpen(open) {
  $('addForm').hidden = !open;
  $('addToggle').setAttribute('aria-expanded', String(open));
  $('addToggle').textContent = open ? 'Close form' : 'Add member';
}
function resetForm() {
  $('fName').value = '';
  $('fPhone').value = '';
  $('fNameErr').hidden = true;
  $('fPhoneErr').hidden = true;
  addDraft = newDraft();
  mountAdd();
}
function onAddSubmit(e) {
  e.preventDefault();
  const name = $('fName').value.trim();
  const phone = $('fPhone').value.trim();
  const key = phoneKey(phone);
  let bad = false, phoneBad = false;
  if (!name) { $('fNameErr').hidden = false; bad = true; }
  if (phone.replace(/\D/g, '').length < 6) { $('fPhoneErr').textContent = "Enter the member's phone number."; $('fPhoneErr').hidden = false; bad = true; phoneBad = true; }
  else if (S.members[key]) { $('fPhoneErr').textContent = 'This number is already on the list for ' + (S.members[key].name || 'another member') + '.'; $('fPhoneErr').hidden = false; bad = true; phoneBad = true; }
  const msg = validatePlan(addDraft);
  if (msg) { addPlan.setError(msg); bad = true; }
  if (bad) { (!name ? $('fName') : phoneBad ? $('fPhone') : $('fName')).focus(); return; }
  $('fSave').disabled = true;
  run(() => writeMemberPlan(key, { name: name, phone: phone }, planFromDraft(addDraft)), name + ' added').then((ok) => {
    $('fSave').disabled = false;
    if (ok) { resetForm(); $('fName').focus(); }
  });
}

/* ---------- gym wall poster ---------- */
function joinUrl() { return new URL('./', location.href).href; }
function drawPoster(canvas) {
  const W = 900, H = 1270;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#2A1650'); bg.addColorStop(0.55, '#150E26'); bg.addColorStop(1, '#0B0713');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 250, 20, W / 2, 250, 520);
  glow.addColorStop(0, 'rgba(155,77,255,0.45)'); glow.addColorStop(1, 'rgba(155,77,255,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, 760);
  const img = document.querySelector('.logo img');
  if (img && img.complete && img.naturalWidth) {
    const lw = 400, lh = Math.round(lw * img.naturalHeight / img.naturalWidth);
    ctx.drawImage(img, (W - lw) / 2, 36, lw, lh);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#F2B83B';
  ctx.font = 'italic 700 96px "Barlow Condensed", "Arial Narrow", sans-serif';
  ctx.fillText('SCAN TO CHECK IN', W / 2, 536);
  ctx.fillStyle = '#E9DFFF';
  ctx.font = '500 24px "IBM Plex Mono", monospace';
  ctx.fillText('NEW MEMBERS AND CURRENT MEMBERS', W / 2, 580);
  let ok = false;
  const cardX = 235, cardY = 614, cardS = 430;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cardX, cardY, cardS, cardS);
  if (typeof qrcode === 'function') {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(joinUrl());
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 2;
      const cell = Math.floor(cardS / (n + quiet * 2));
      const size = cell * (n + quiet * 2);
      const x0 = cardX + Math.round((cardS - size) / 2), y0 = cardY + Math.round((cardS - size) / 2);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(x0 + (c + quiet) * cell, y0 + (r + quiet) * cell, cell, cell);
      ok = true;
    } catch (e) { ok = false; }
  }
  ctx.textAlign = 'left';
  const steps = ['Scan with your phone camera', 'Enter your phone number', 'New here? Add your name once'];
  let fs = 40, widest = 0;
  do {
    ctx.font = '600 ' + fs + 'px "Barlow Condensed", "Arial Narrow", sans-serif';
    widest = Math.max.apply(null, steps.map((t) => ctx.measureText(t).width));
    fs -= 2;
  } while (widest > 700 && fs > 20);
  const bx = Math.round((W - (widest + 42)) / 2);
  steps.forEach((t, i) => {
    const y = 1126 + i * 52;
    ctx.fillStyle = '#F2B83B'; ctx.fillText(String(i + 1), bx, y);
    ctx.fillStyle = '#F6F1E7'; ctx.fillText(t, bx + 42, y);
  });
  return ok;
}
function openPoster() {
  const ok = drawPoster($('posterCanvas'));
  $('posterSave').hidden = !ok;
  $('posterNote').textContent = ok
    ? 'Print this and put it on the gym wall. A phone camera that scans it opens the A1 check-in page: ' + joinUrl()
    : 'The QR code library did not load. Reload the page and try again.';
  $('posterOverlay').hidden = false;
  $('posterClose').focus();
}
function closePoster() { $('posterOverlay').hidden = true; }
function savePoster() {
  $('posterCanvas').toBlob((blob) => {
    if (!blob) { toast('Could not make the image.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'A1-gym-poster.png';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Poster saved');
  }, 'image/png');
}

/* ---------- closed days ---------- */
const WEEK = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];
function renderClosed() {
  const chips = $('cdChips');
  chips.replaceChildren.apply(chips, WEEK.map((w) => h('button', {
    class: 'chip', type: 'button', text: w[0], 'aria-pressed': String(cdDraft.closedWeekdays.indexOf(w[1]) !== -1),
    onclick: () => {
      const i = cdDraft.closedWeekdays.indexOf(w[1]);
      if (i === -1) cdDraft.closedWeekdays.push(w[1]); else cdDraft.closedWeekdays.splice(i, 1);
      renderClosed();
    }
  })));
  const ul = $('cdList');
  ul.replaceChildren();
  const dates = cdDraft.closedDates.slice().sort();
  if (!dates.length) ul.append(h('li', { class: 'muted', text: 'No one-off closed dates.' }));
  dates.forEach((d) => ul.append(h('li', null, h('span', { text: fmt(d) }),
    h('button', { class: 'btn btn-quiet btn-danger', type: 'button', text: 'Remove', onclick: () => { cdDraft.closedDates = cdDraft.closedDates.filter((x) => x !== d); renderClosed(); } }))));
}
function openClosed() {
  cdDraft = { closedWeekdays: S.cfg.closedWeekdays.slice(), closedDates: S.cfg.closedDates.slice() };
  renderClosed();
  $('closedOverlay').hidden = false;
  $('cdClose').focus();
}
function closeClosed() { $('closedOverlay').hidden = true; }

/* ---------- sign in and wiring ---------- */
function showGate(msg) { $('gate').hidden = !msg; $('gate').textContent = msg || ''; }
function setSignedIn(user) {
  $('loginCard').hidden = !!user;
  $('desk').hidden = !user;
  $('topBtns').hidden = !user;
  showGate('');
  if (user) startData(); else { stopData(); renderList(); }
}
function wire() {
  $('todayLabel').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('loginErr').hidden = true;
    $('loginBtn').disabled = true;
    signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value).catch((err) => {
      $('loginErr').textContent = err && /network/i.test(err.code || '') ? 'No connection. Try again.' : 'That email or password is not right.';
      $('loginErr').hidden = false;
    }).then(() => { $('loginBtn').disabled = false; });
  });
  $('signOutBtn').addEventListener('click', () => { signOut(auth); });
  $('addToggle').addEventListener('click', () => { setAddOpen($('addForm').hidden); if (!$('addForm').hidden) $('fName').focus(); });
  $('fCancel').addEventListener('click', () => { resetForm(); setAddOpen(false); });
  $('fName').addEventListener('input', () => { $('fNameErr').hidden = true; });
  $('fPhone').addEventListener('input', () => { $('fPhoneErr').hidden = true; });
  $('addForm').addEventListener('submit', onAddSubmit);
  $('q').addEventListener('input', (e) => { S.q = e.target.value; renderList(); });
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (b) setFilter(b.getAttribute('data-f')); });
  $('pendingShow').addEventListener('click', () => setFilter('pending'));
  $('posterBtn').addEventListener('click', openPoster);
  $('posterClose').addEventListener('click', closePoster);
  $('posterSave').addEventListener('click', savePoster);
  $('posterOverlay').addEventListener('click', (e) => { if (e.target === $('posterOverlay')) closePoster(); });
  $('closedBtn').addEventListener('click', openClosed);
  $('cdClose').addEventListener('click', closeClosed);
  $('closedOverlay').addEventListener('click', (e) => { if (e.target === $('closedOverlay')) closeClosed(); });
  $('cdAdd').addEventListener('click', () => {
    const v = $('cdDate').value;
    if (!v) return;
    if (cdDraft.closedDates.indexOf(v) === -1) cdDraft.closedDates.push(v);
    $('cdDate').value = '';
    renderClosed();
  });
  $('cdSave').addEventListener('click', () => {
    const data = { closedWeekdays: cdDraft.closedWeekdays.slice().sort(), closedDates: cdDraft.closedDates.slice().sort() };
    run(() => setDoc(doc(db, 'config', 'gym'), data), 'Closed days saved').then((ok) => { if (ok) closeClosed(); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('posterOverlay').hidden) closePoster();
    if (!$('closedOverlay').hidden) closeClosed();
  });
  resetForm();
  renderList();
  setInterval(() => {
    if (todayWatching && todayWatching !== todayISO()) {
      $('todayLabel').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      watchToday();
      renderList();
    }
  }, 60000);
}

wire();
onAuthStateChanged(auth, (user) => { setSignedIn(user); });

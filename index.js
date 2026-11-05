import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBmMtXSGjH8_oZclmFVMe9d7f2RvEc77FU",
  authDomain: "a1-fitness-b21d0.firebaseapp.com",
  projectId: "a1-fitness-b21d0",
  storageBucket: "a1-fitness-b21d0.firebasestorage.app",
  messagingSenderId: "505856161087",
  appId: "1:505856161087:web:287c740e463eb077efcf8a"
};
const db = getFirestore(initializeApp(firebaseConfig));

const $ = (id) => document.getElementById(id);
let cfg = { closedWeekdays: [0], closedDates: [] };
let busy = false;
let pendingPhone = '';
let toastTimer = 0;

/* ---------- dates (plain YYYY-MM-DD strings, device local time) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const dayNum = (s) => { const a = s.split('-').map(Number); return Math.round(Date.UTC(a[0], a[1] - 1, a[2]) / 86400000); };
const addDays = (s, n) => { const t = new Date((dayNum(s) + n) * 86400000); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
const weekday = (s) => new Date(dayNum(s) * 86400000).getUTCDay();
const fmtDate = (s) => { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const isClosed = (day) => cfg.closedWeekdays.indexOf(weekday(day)) !== -1 || cfg.closedDates.indexOf(day) !== -1;
/* The latest open day before `day`. Closed days (Sundays, holidays) never break a streak. */
function openBefore(day) {
  let d = day;
  for (let i = 0; i < 60; i++) { d = addDays(d, -1); if (!isClosed(d)) return d; }
  return d;
}

/* ---------- phone and name ---------- */
const phoneKey = (p) => String(p || '').replace(/\D/g, '').slice(-9);
function cleanPhone(s) { const t = String(s || '').trim(); return (t.charAt(0) === '+' ? '+' : '') + t.replace(/\D/g, ''); }
const validPhone = (p) => { const n = p.replace(/\D/g, '').length; return n >= 7 && n <= 15; };
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
function remember(phone, name) { try { localStorage.setItem('a1.phone', phone); if (name) localStorage.setItem('a1.name', name); } catch (e) {} }
function recall(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

/* ---------- screens ---------- */
function showCard(id) {
  ['cardPhone', 'cardName', 'cardResult'].forEach((c) => { $(c).hidden = c !== id; });
  window.scrollTo(0, 0);
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}
function result(kind, title, lines, extra) {
  const labels = { ok: 'Checked in', warn: 'Please note', bad: 'Not checked in', info: 'Info' };
  $('cardResult').className = 'card result ' + kind;
  $('resKind').textContent = labels[kind] || '';
  $('resTitle').textContent = title;
  const box = $('resLines');
  box.replaceChildren();
  (lines || []).forEach((l) => { const p = document.createElement('p'); p.textContent = l; box.append(p); });
  const hasStreak = extra && typeof extra.streak === 'number';
  $('resStreak').hidden = !hasStreak;
  if (hasStreak) $('resN').textContent = String(extra.streak);
  showCard('cardResult');
  $('resDone').focus();
}
function errText(e) {
  const c = (e && e.code) || '';
  if (c === 'unavailable' || /offline|network/i.test((e && e.message) || '')) return 'No internet connection. Check your data or Wi-Fi and try again.';
  if (c === 'permission-denied') return 'The gym could not accept this. Please ask the coach.';
  return 'Something went wrong. Please try again.';
}
function planLines(p, today) {
  const left = dayNum(p.end) - dayNum(today);
  const lines = ['Your plan ends on ' + fmtDate(p.end) + (left > 0 ? ' (' + left + (left === 1 ? ' day' : ' days') + ' left).' : '.')];
  if (left <= 7) lines.push('Ask the coach about renewing.');
  return lines;
}

/* ---------- gym settings ---------- */
async function loadConfig() {
  try {
    const s = await getDoc(doc(db, 'config', 'gym'));
    if (s.exists()) {
      const d = s.data();
      cfg = {
        closedWeekdays: Array.isArray(d.closedWeekdays) ? d.closedWeekdays : [0],
        closedDates: Array.isArray(d.closedDates) ? d.closedDates : []
      };
    }
  } catch (e) { /* keep the default: Sunday closed */ }
}

/* ---------- check in ---------- */
async function checkInFlow(phone) {
  if (busy) return;
  busy = true;
  $('goBtn').disabled = true;
  try {
    const key = phoneKey(phone);
    await loadConfig();
    const pubSnap = await getDoc(doc(db, 'pub', key));
    if (!pubSnap.exists()) {
      pendingPhone = phone;
      remember(phone, '');
      $('phoneEcho').textContent = 'Phone: ' + phone;
      $('fullname').value = recall('a1.name');
      showCard('cardName');
      $('fullname').focus();
      return;
    }
    const p = pubSnap.data();
    const today = todayISO();
    remember(phone, p.name);
    if (p.state === 'paused') { result('warn', 'Membership on hold', ['Your membership is paused. Please see the coach.']); return; }
    if (!p.end || p.end <= today) {
      result('bad', 'Your plan has ended', [p.end ? 'It ended on ' + fmtDate(p.end) + '.' : 'Your plan is not set up yet.', 'Please see the coach to renew.']);
      return;
    }
    if (isClosed(today)) { result('info', 'A1 is closed today', ['Your streak is safe. See you on the next open day.']); return; }
    const id = key + '_' + today;
    const ex = await getDoc(doc(db, 'checkins', id));
    if (ex.exists()) {
      result('info', 'You are already in', ['You checked in earlier today.'].concat(planLines(p, today)), { streak: Number(ex.data().streak) || 1 });
      return;
    }
    const prev = openBefore(today);
    const ps = await getDoc(doc(db, 'checkins', key + '_' + prev));
    const streak = ps.exists() ? (Number(ps.data().streak) || 0) + 1 : 1;
    await setDoc(doc(db, 'checkins', id), { key: key, name: p.name, date: today, at: serverTimestamp(), streak: streak });
    const first = String(p.name || '').split(' ')[0];
    result('ok', first ? 'Welcome, ' + first : 'Welcome', [streak === 1 ? 'Day one. Come back on the next open day to build your streak.' : 'Keep it going.'].concat(planLines(p, today)), { streak: streak });
  } catch (err) {
    result('bad', 'Could not check in', [errText(err)]);
  } finally {
    busy = false;
    $('goBtn').disabled = false;
  }
}

async function joinFlow(name) {
  if (busy) return;
  busy = true;
  $('joinBtn').disabled = true;
  const key = phoneKey(pendingPhone);
  try {
    await setDoc(doc(db, 'signups', key), { name: name, phone: pendingPhone, createdAt: serverTimestamp() });
    remember(pendingPhone, name);
    result('ok', 'You are on the list', ['Thank you, ' + name.split(' ')[0] + '. The coach will set up your plan.', 'Check in again once your plan is ready.']);
    $('resKind').textContent = 'Welcome';
  } catch (err) {
    if (err && err.code === 'permission-denied') {
      result('info', 'You are already on the list', ['The coach will set up your plan soon.', 'Check in again once your plan is ready.']);
    } else {
      result('bad', 'Could not join', [errText(err)]);
    }
  } finally {
    busy = false;
    $('joinBtn').disabled = false;
  }
}

/* ---------- wiring ---------- */
$('todayLabel').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
$('phone').value = recall('a1.phone');
$('phoneForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const phone = cleanPhone($('phone').value);
  if (!validPhone(phone)) { $('phoneErr').hidden = false; $('phone').focus(); return; }
  $('phoneErr').hidden = true;
  checkInFlow(phone);
});
$('phone').addEventListener('input', () => { $('phoneErr').hidden = true; });
$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = cleanName($('fullname').value);
  if (name.length < 2) { $('nameErr').hidden = false; $('fullname').focus(); return; }
  $('nameErr').hidden = true;
  joinFlow(name);
});
$('fullname').addEventListener('input', () => { $('nameErr').hidden = true; });
$('nameBack').addEventListener('click', () => { showCard('cardPhone'); $('phone').focus(); });
$('resDone').addEventListener('click', () => { showCard('cardPhone'); });

if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

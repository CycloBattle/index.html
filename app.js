'use strict';
/* =====================================================================
   Vélocards : front-end (JS pur, aucun outil de build)
   Toute la logique sensible (boosters, achats, points, récompenses,
   cadeaux, validation des courses) est dans les fonctions SQL et les
   Edge Functions de Supabase. Ici on ne fait qu'afficher.
   ===================================================================== */

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/* ---------- Constantes d'affichage (à garder alignées avec le SQL) ---------- */
const RARITY = {
  common:    { label: 'Commune',           value: 20,   mult: 1 },
  rare:      { label: 'Rare',              value: 60,   mult: 1.1 },
  ultra:     { label: 'Ultra rare',        value: 200,  mult: 1.25 },
  legendary: { label: 'Légendaire',        value: 600,  mult: 1.5 },
  mythic:    { label: 'Mythique vintage',  value: 1500, mult: 1.75 },
};
const RARITY_ORDER = ['common', 'rare', 'ultra', 'legendary', 'mythic'];
const RECYCLE_RATE = 0.12;

/* Barème des courses d'un jour : points de base selon la place réelle (1er au 30e), 0 au-delà */
const POSITION_POINTS = [
  350, 270, 220, 150, 120, 100, 85, 72, 62, 54,
  48, 43, 39, 35, 32, 29, 26, 24, 22, 20,
  18, 16, 14, 12, 10, 8, 6, 4, 3, 2,
];
const MAX_POSITION = POSITION_POINTS.length; // 30
const CAPTAIN_MULT = 2;   // multiplicateur du capitaine...
const CAPTAIN_TOP = 10;   // ...uniquement s'il termine dans le Top 10 réel
const MYTHIC_BONUS = 40;  // bonus fixe des cartes mythiques (coureurs retraités)
const TEAM_SIZE = 8;

/* Points de base d'une place (0 si hors du Top 30 ou place inconnue) */
function basePoints(pos) {
  return Number.isInteger(pos) && pos >= 1 && pos <= MAX_POSITION ? POSITION_POINTS[pos - 1] : 0;
}

/* Points d'une carte selon sa rareté, la place réelle du coureur et le statut de capitaine.
   Doit rester identique à la fonction SQL validate_race. */
function cardPoints(rarity, pos, isCaptain = false) {
  if (rarity === 'mythic') return MYTHIC_BONUS;
  const base = basePoints(pos);
  const cap = isCaptain && Number.isInteger(pos) && pos >= 1 && pos <= CAPTAIN_TOP ? CAPTAIN_MULT : 1;
  return Math.floor(base * (RARITY[rarity]?.mult ?? 1) * cap);
}

/* Calculateur du score d'une équipe à partir des résultats réels.
   - riders    : tableau de { id, rarity } (les 8 coureurs alignés)
   - captainId : id du coureur capitaine (ou null)
   - results   : tableau de { pos, rider_id } (classement réel enregistré en base)
   Renvoie { cards: [{ rider_id, pos, base, mult, isCaptain, captainApplied, points }], total } */
function computeTeamScore(riders, captainId, results) {
  const posByRider = new Map(results.map(r => [r.rider_id, r.pos]));
  const cards = riders.map(r => {
    const pos = posByRider.has(r.id) ? posByRider.get(r.id) : null;
    const isCaptain = r.id === captainId;
    const mythic = r.rarity === 'mythic';
    const captainApplied = isCaptain && !mythic && pos !== null && pos >= 1 && pos <= CAPTAIN_TOP;
    return {
      rider_id: r.id,
      pos,
      mythic,
      base: mythic ? MYTHIC_BONUS : basePoints(pos),
      mult: RARITY[r.rarity]?.mult ?? 1,
      isCaptain,
      captainApplied,
      points: cardPoints(r.rarity, pos, isCaptain),
    };
  });
  return { cards, total: cards.reduce((s, c) => s + c.points, 0) };
}

const BOOSTERS = {
  bronze: { name: 'Booster Bronze', price: 100, odds: 'Cartes communes, avec 8 % de chances d\'obtenir une rare par carte.' },
  silver: { name: 'Booster Argent', price: 300, odds: 'Communes et rares, avec 6 % de chances d\'obtenir une ultra rare par carte.' },
  gold:   { name: 'Booster Or',     price: 800, odds: 'Rare minimum, 22 % d\'ultra rares, et une fine chance de légendaire ou de mythique vintage.' },
};
const SPECIALTIES = ['sprinteur', 'grimpeur', 'rouleur', 'puncheur', 'classiques', 'complet', 'vintage'];

/* Compétences des coureurs (jauges de type ProCyclingStats).
   STAT_MAX = note qui remplit entièrement la barre (au-delà, la barre reste pleine). */
const STAT_MAX = 1000;
const STAT_DEFS = [
  { key: 'oneday',  label: 'Un jour',  color: '#8ec63f' },
  { key: 'gc',      label: 'GC',       color: '#ed1c24' },
  { key: 'tt',      label: 'TT',       color: '#49b2e8' },
  { key: 'sprint',  label: 'Sprint',   color: '#f8a13f' },
  { key: 'climber', label: 'Grimpeur', color: '#92278f' },
  { key: 'hills',   label: 'Collines', color: '#f05a92' },
];

/* Récompenses quotidiennes : dimanche (0) à vendredi (5) = Bronze, samedi (6) = Argent.
   Doit rester identique à la fonction SQL claim_daily. */
const WEEKDAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const WEEKDAYS_LONG = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const dailyType = dow => (dow === 6 ? 'silver' : 'bronze');

/* ---------- Petits outils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const coin = n => `${Number(n).toLocaleString('fr-FR')} 🪙`;
const fmtDate = d => new Date(d).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const flag = cc => (cc && cc.length === 2)
  ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '🏁';
/* Nom du pays en français à partir du code à 2 lettres (le code lui-même si indisponible) */
const regionNames = (() => { try { return new Intl.DisplayNames(['fr'], { type: 'region' }); } catch (e) { return null; } })();
const countryName = cc => {
  if (!cc) return '';
  try { return regionNames?.of(cc.toUpperCase()) || cc; } catch (e) { return cc; }
};
const cap1 = s => String(s ?? '').charAt(0).toUpperCase() + String(s ?? '').slice(1);
const slug = n => n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const IMG_EXTS = ['jpg', 'png', 'webp'];
/* Photo d'un coureur : image_url si renseignée, sinon img/riders/<nom-du-coureur>.jpg (puis .png, puis .webp) */
window.imgFallback = img => {
  const i = +img.dataset.i + 1;
  if (!img.dataset.url && i < IMG_EXTS.length) { img.dataset.i = i; img.src = `img/riders/${img.dataset.slug}.${IMG_EXTS[i]}`; }
  else img.remove();
};
function riderImg(r, lazy = true) {
  const s = slug(r.name);
  const src = r.image_url || `img/riders/${s}.${IMG_EXTS[0]}`;
  return `<img src="${esc(src)}" alt="" ${lazy ? 'loading="lazy"' : ''} data-slug="${s}" data-i="0" ${r.image_url ? 'data-url="1"' : ''} onerror="imgFallback(this)">`;
}
const initials = n => { const w = n.trim().split(/\s+/); return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); };
const rarityIdx = r => RARITY_ORDER.indexOf(r);
const ordinal = n => (n === 1 ? '1<sup>er</sup>' : `${n}<sup>e</sup>`);
const fmtClock = s => {
  s = Math.max(0, Math.floor(s));
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
/* Clé de comparaison de noms : sans accents, sans majuscules, espaces simplifiés */
const nameKey = n => String(n ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/* Clé de rapprochement des noms de coureurs (résultats de course) : sans accents, sans ponctuation,
   mots triés. « POGAČAR Tadej » et « Tadej Pogačar » donnent la même clé.
   Doit rester identique à matchKey() dans la fonction process-race-scores. */
const matchKey = n => String(n ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ø/gi, 'o').replace(/ł/gi, 'l').replace(/đ/gi, 'd').replace(/æ/gi, 'ae').replace(/ß/g, 'ss')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').filter(Boolean).sort().join(' ');
const state = { uid: null, user: null, profile: null, unread: 0, dailyAvailable: false };
let app; // conteneur <main>

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

/* Charge toutes les lignes d'une requête par paquets de 1000 (limite de l'API Supabase).
   make() doit renvoyer une requête neuve, avec un tri stable. */
async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await q(make().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3800);
}

function openModal(html, { wide = false } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  return { el: ov, box: $('.modal', ov), close };
}

function confirmBox(text, ok = 'Confirmer') {
  return new Promise(res => {
    const m = openModal(`<h3>${esc(text)}</h3><div class="row"><button class="btn" data-x>Annuler</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`);
    $('[data-x]', m.box).onclick = () => { m.close(); res(false); };
    $('[data-ok]', m.box).onclick = () => { m.close(); res(true); };
  });
}

function askNumber({ title, text = '', value = 1, min = 1, ok = 'Valider' }) {
  return new Promise(res => {
    const m = openModal(`<h3>${esc(title)}</h3><p class="muted">${text}</p>
      <label>Montant en pièces<input type="number" id="num" min="${min}" value="${value}" inputmode="numeric"></label>
      <div class="row"><button class="btn" data-x>Annuler</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`);
    const input = $('#num', m.box); input.focus(); input.select();
    $('[data-x]', m.box).onclick = () => { m.close(); res(null); };
    $('[data-ok]', m.box).onclick = () => { const v = parseInt(input.value, 10); m.close(); res(Number.isFinite(v) ? v : null); };
  });
}

/* Appel RPC avec message d'erreur lisible */
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) { toast(error.message, 'error'); return { ok: false }; }
  return { ok: true, data };
}

/* Appel d'une Edge Function Supabase.
   Renvoie { ok: true, data } si la fonction a répondu { ok: true },
   { ok: false, error } si elle a refusé (message lisible),
   { ok: false, unreachable: true, error } si elle est injoignable (non déployée, panne...). */
async function callFn(name, body) {
  try {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      return { ok: false, unreachable: true, error: `La fonction « ${name} » est injoignable. Vérifie qu'elle est bien déployée dans Supabase (Edge Functions).` };
    }
    if (!data || data.ok !== true) return { ok: false, error: data?.error || 'Réponse vide de la fonction.' };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, unreachable: true, error: e?.message || String(e) };
  }
}

/* ---------- Jauges de compétences (composant réutilisable) ----------
   RiderStatsBars(rider, { compact })
   - rider   : objet avec oneday, gc, tt, sprint, climber, hills
   - compact : true = barres fines sans libellés (pour les cartes)
   Renvoie '' si le coureur n'a aucune note (toutes à 0). */
function RiderStatsBars(r, { compact = false } = {}) {
  const vals = STAT_DEFS.map(s => ({ ...s, v: Math.max(0, Number(r?.[s.key]) || 0) }));
  if (!vals.some(s => s.v > 0)) return '';
  return `<div class="rsb ${compact ? 'compact' : ''}">${vals.map(s => `<div class="rsb-row" title="${esc(s.label)} : ${s.v}">
    <span class="rsb-l">${esc(s.label)}</span>
    <span class="rsb-t"><span class="rsb-f" style="width:${Math.min(100, (s.v / STAT_MAX) * 100).toFixed(1)}%;background:${s.color}"></span></span>
    <span class="rsb-v">${s.v}</span></div>`).join('')}</div>`;
}

/* ---------- Composant carte ----------
   Options : cls (classes CSS), attrs (attributs HTML), count (×N), noStats (sans jauges), badge (ex. « ✓ Possédée ») */
function cardHTML(r, o = {}) {
  return `<div class="card r-${r.rarity} ${o.cls || ''}" ${o.attrs || ''}>
    <span class="bib">${String(r.id).padStart(3, '0')}</span>
    ${o.badge ? `<span class="own">${esc(o.badge)}</span>` : ''}
    ${o.count > 1 ? `<span class="count">×${o.count}</span>` : ''}
    <div class="art"><span class="flag">${flag(r.country)}</span><span class="mono">${esc(initials(r.name))}</span>${riderImg(r)}</div>
    <div class="meta"><strong class="nm">${esc(r.name)}</strong><span class="sp">${esc(r.specialty)}${r.team ? ' · ' + esc(r.team) : ''}</span><span class="rar">${RARITY[r.rarity].label}</span>${o.noStats ? '' : RiderStatsBars(r, { compact: true })}</div>
  </div>`;
}

/* Fenêtre de détail d'un coureur : carte + jauges complètes.
   count = nombre d'exemplaires possédés ; owned = false pour signaler une carte non possédée. */
function showRiderDetail(r, count = 0, owned = null) {
  const m = openModal(`<div class="detail">
      <div class="detail-card">${cardHTML(r, { noStats: true })}</div>
      <div class="detail-info">
        <h2>${esc(r.name)}</h2>
        <p class="muted">${flag(r.country)} ${esc(r.specialty)}${r.team ? ' · ' + esc(r.team) : ''} · ${RARITY[r.rarity].label}</p>
        ${RiderStatsBars(r) || '<p class="muted">Compétences non renseignées.</p>'}
        ${count ? `<p class="muted" style="margin-top:.8rem">Exemplaires : ${count}</p>`
          : owned === false ? '<p class="muted" style="margin-top:.8rem">Tu ne possèdes pas encore cette carte.</p>' : ''}
      </div>
    </div>
    <div class="row"><button class="btn primary" data-x>Fermer</button></div>`);
  $('[data-x]', m.box).onclick = m.close;
}

/* Tableau du barème (1er au 30e) : utilisé dans l'onglet Équipe et le Portefeuille */
function baremeTable() {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Place</th><th class="num">Points de base</th><th class="num">Capitaine ×${CAPTAIN_MULT}</th></tr></thead>
    <tbody>${POSITION_POINTS.map((v, i) => `<tr><td>${ordinal(i + 1)}</td><td class="num">${v}</td>
      <td class="num">${i + 1 <= CAPTAIN_TOP ? v * CAPTAIN_MULT : '–'}</td></tr>`).join('')}
    <tr><td>Au-delà de la ${MAX_POSITION}<sup>e</sup></td><td class="num">0</td><td class="num">–</td></tr></tbody>
  </table></div>`;
}

/* ---------- Données partagées ---------- */
const myCards = () => q(sb.from('user_cards').select('id,rider_id,acquired_at,riders(*)').eq('owner_id', state.uid));

/* Stock de boosters non ouverts (tableau { type, quantity }, trié comme BOOSTERS) */
async function myBoosters() {
  const rows = await q(sb.from('user_boosters').select('type,quantity').eq('owner_id', state.uid).gt('quantity', 0));
  const order = Object.keys(BOOSTERS);
  return rows.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

/* État des récompenses quotidiennes, calculé par le serveur (jour de Paris) */
async function fetchDaily() {
  const { data, error } = await sb.rpc('daily_status');
  if (error) throw error;
  return data;
}

/* Met à jour le badge « récompense disponible » (silencieux si le SQL n'est pas encore installé) */
async function refreshDaily() {
  try {
    const st = await fetchDaily();
    state.dailyAvailable = !st.claimed;
  } catch (e) {
    state.dailyAvailable = false;
  }
  updateChrome();
}

function groupByRider(cards) {
  const m = new Map();
  for (const c of cards) {
    if (!m.has(c.rider_id)) m.set(c.rider_id, { rider: c.riders, cards: [] });
    m.get(c.rider_id).cards.push(c);
  }
  return [...m.values()];
}

/* Cartes en vente (listed) ou engagées dans une équipe à venir (locked) */
async function lockInfo() {
  const listed = await q(sb.from('listings').select('card_id').eq('seller_id', state.uid).eq('status', 'active'));
  const locked = await q(sb.from('lineup_cards')
    .select('user_card_id, lineups!inner(user_id, races!inner(status))')
    .eq('lineups.user_id', state.uid).eq('lineups.races.status', 'upcoming'));
  return {
    listed: new Set(listed.map(x => x.card_id)),
    locked: new Set(locked.map(x => x.user_card_id).filter(Boolean)),
  };
}

async function usernames(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const rows = await q(sb.from('public_profiles').select('id,username').in('id', uniq));
  return Object.fromEntries(rows.map(r => [r.id, r.username]));
}

/* Grille de collection avec filtres (utilisée par « Collection » et « Profil »).
   Un clic sur une carte ouvre le détail avec les jauges complètes. */
function mountCollection(target, cards) {
  const groups = groupByRider(cards);
  target.innerHTML = `
    <div class="filters">
      <label>Rareté<select id="fr"><option value="">Toutes</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select></label>
      <label>Recherche<input id="fq" placeholder="Nom du coureur"></label>
      <label>Tri<select id="fs"><option value="rar">Rareté</option><option value="name">Nom</option><option value="recent">Plus récentes</option></select></label>
    </div>
    <div class="cards" id="grid"></div>`;
  const draw = () => {
    const fr = $('#fr', target).value, fq = $('#fq', target).value.toLowerCase(), fs = $('#fs', target).value;
    let list = groups.filter(g => (!fr || g.rider.rarity === fr) && g.rider.name.toLowerCase().includes(fq));
    list.sort((a, b) => fs === 'name' ? a.rider.name.localeCompare(b.rider.name)
      : fs === 'recent' ? Math.max(...b.cards.map(c => +new Date(c.acquired_at))) - Math.max(...a.cards.map(c => +new Date(c.acquired_at)))
      : rarityIdx(b.rider.rarity) - rarityIdx(a.rider.rarity) || a.rider.name.localeCompare(b.rider.name));
    $('#grid', target).innerHTML = list.length
      ? list.map(g => `<div class="card-wrap">${cardHTML(g.rider, { count: g.cards.length, cls: 'pick', attrs: `data-rid="${g.rider.id}" tabindex="0"` })}</div>`).join('')
      : `<p class="muted">Aucune carte ne correspond.</p>`;
    $$('#grid .card', target).forEach(c => {
      const open = () => {
        const g = groups.find(x => x.rider.id === +c.dataset.rid);
        if (g) showRiderDetail(g.rider, g.cards.length);
      };
      c.onclick = open;
      c.onkeydown = e => { if (e.key === 'Enter') open(); };
    });
  };
  $$('select,input', target).forEach(el => el.oninput = draw);
  draw();
}

/* =====================================================================
   CONNEXION
   ===================================================================== */
function renderAuth(mode = 'login') {
  const login = mode === 'login';
  $('#root').innerHTML = `
  <div class="auth"><div class="auth-box">
    <div class="auth-fan"><span></span><span></span><span></span><span></span></div>
    <h1>Vélocards</h1>
    <p class="muted">Collectionne les coureurs, aligne ton équipe de ${TEAM_SIZE} avant chaque course et gagne des pièces selon les vraies performances.</p>
    <form id="authForm">
      <label>Pseudo<input name="u" autocomplete="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" title="3 à 20 caractères : lettres, chiffres ou _"></label>
      <label>Mot de passe<input name="p" type="password" autocomplete="${login ? 'current-password' : 'new-password'}" required minlength="6"></label>
      <button class="btn primary" type="submit">${login ? 'Se connecter' : 'Créer mon compte'}</button>
      <p id="authErr" class="error" role="alert"></p>
    </form>
    <p>${login ? 'Pas encore de compte ?' : 'Déjà un compte ?'} <a href="#" id="swap">${login ? 'Créer un compte' : 'Se connecter'}</a></p>
  </div></div>`;
  $('#swap').onclick = e => { e.preventDefault(); renderAuth(login ? 'signup' : 'login'); };
  $('#authForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = $('button', f), err = $('#authErr');
    const u = f.u.value.trim().toLowerCase(), p = f.p.value;
    const email = `${u}@velocards.game`;
    btn.disabled = true; err.textContent = '';
    const res = login
      ? await sb.auth.signInWithPassword({ email, password: p })
      : await sb.auth.signUp({ email, password: p, options: { data: { username: u } } });
    btn.disabled = false;
    if (res.error) {
      const m = res.error.message;
      err.textContent = /Invalid login/i.test(m) ? 'Pseudo ou mot de passe incorrect.'
        : /already registered|duplicate|unique/i.test(m) ? 'Ce pseudo est déjà pris.'
        : /Database error/i.test(m) ? 'Pseudo invalide ou déjà pris.'
        : m;
    } else if (!login && !res.data.session) {
      err.textContent = 'Compte créé, mais la confirmation par e-mail est activée dans Supabase : désactive « Confirm email » (voir le README).';
    }
  };
}

/* =====================================================================
   COQUE + ROUTEUR
   ===================================================================== */
const NAV = [
  ['boosters', 'Boosters'], ['recompenses', 'Récompenses'], ['collection', 'Collection'], ['vitrine', 'Vitrine'], ['equipe', 'Équipe'],
  ['transferts', 'Transferts'], ['messages', 'Messagerie'], ['portefeuille', 'Portefeuille'],
  ['classement', 'Classement UCI'],
];

function renderShell() {
  const p = state.profile;
  $('#root').innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/boosters">Vélo<small>cards</small></a>
      <a class="wallet" id="wallet" href="#/portefeuille" title="Ton portefeuille"></a>
      <a class="who" href="#/profil/${encodeURIComponent(p.username)}">${esc(p.username)}</a>
      <button class="btn small" id="logout" style="color:#fff;border-color:#fff">Quitter</button>
    </header>
    <nav class="nav" id="nav">
      ${NAV.map(([k, l]) => `<a href="#/${k}" data-r="${k}">${l}<span class="badge" data-badge="${k}" hidden></span></a>`).join('')}
      ${p.is_admin ? `<a href="#/admin" data-r="admin">Admin</a>` : ''}
    </nav>
    <main id="app"></main>`;
  app = $('#app');
  $('#logout').onclick = () => sb.auth.signOut();
  updateChrome();
}

function updateChrome() {
  const w = $('#wallet'); if (w && state.profile) w.textContent = coin(state.profile.coins);
  const b = $('[data-badge="messages"]');
  if (b) { b.hidden = !state.unread; b.textContent = state.unread; }
  const d = $('[data-badge="recompenses"]');
  if (d) { d.hidden = !state.dailyAvailable; d.textContent = '1'; }
}

async function refreshProfile() {
  state.profile = await q(sb.from('profiles').select('*').eq('id', state.uid).single());
  const { count } = await sb.from('messages').select('id', { count: 'exact', head: true }).gt('created_at', state.profile.last_seen_messages);
  state.unread = count || 0;
  updateChrome();
}

const ROUTES = {
  boosters: pageBoosters, recompenses: pageRewards, collection: pageCollection, vitrine: pageShowcase, equipe: pageTeam, transferts: pageTransfers,
  messages: pageMessages, portefeuille: pageWallet, classement: pageRanking, profil: pageProfile, admin: pageAdmin,
};

async function route() {
  if (!state.uid || !app) return;
  const [name = 'boosters', ...args] = location.hash.replace(/^#\/?/, '').split('/');
  const key = ROUTES[name] ? name : 'boosters';
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === key));
  app.innerHTML = '<p class="muted">Chargement…</p>';
  try { await ROUTES[key](...args.map(decodeURIComponent)); }
  catch (e) { console.error(e); app.innerHTML = `<p class="error">Erreur : ${esc(e.message || e)}</p>`; }
}
window.addEventListener('hashchange', route);

async function handleSession(session) {
  const uid = session?.user?.id || null;
  if (uid === state.uid && uid) return;          // simple rafraîchissement du jeton
  state.uid = uid; state.user = session?.user || null;
  if (!uid) { state.profile = null; state.dailyAvailable = false; app = null; renderAuth(); return; }
  try {
    await refreshProfile();
    await refreshDaily();
    renderShell();
    route();
  } catch (e) {
    $('#root').innerHTML = `<div class="auth"><div class="auth-box"><h2>Profil introuvable</h2><p class="error">${esc(e.message)}</p><p class="muted">Vérifie que schema.sql a bien été exécuté dans Supabase.</p></div></div>`;
  }
}
sb.auth.onAuthStateChange((_evt, session) => setTimeout(() => handleSession(session), 0));

/* =====================================================================
   BOOSTERS EN STOCK (partagé entre « Boosters » et « Récompenses »)
   ===================================================================== */
function stockHTML(stock) {
  if (!stock.length) return '';
  return `<div class="panel stock">
    <h2>Mes boosters gratuits</h2>
    <p class="muted">Ces boosters t'appartiennent déjà : les ouvrir ne coûte aucune pièce.</p>
    ${stock.map(s => `<div class="stock-row">
      <span class="dpack ${s.type}"></span>
      <div class="grow"><b>${esc(BOOSTERS[s.type].name)}</b> ×${s.quantity}</div>
      <button class="btn primary small" data-stock="${s.type}">Ouvrir</button>
    </div>`).join('')}
  </div>`;
}

/* Ouvre un booster du stock. Renvoie true si l'ouverture a réussi. */
async function openStored(type) {
  const r = await rpc('open_stored_booster', { p_type: type });
  if (!r.ok) return false;
  showReveal(type, r.data);
  return true;
}

function bindStock(refresh) {
  $$('[data-stock]').forEach(b => b.onclick = async () => {
    $$('[data-stock]').forEach(x => x.disabled = true);
    const ok = await openStored(b.dataset.stock);
    if (ok) refresh(); else $$('[data-stock]').forEach(x => x.disabled = false);
  });
}

/* =====================================================================
   PAGE : BOOSTERS
   ===================================================================== */
async function pageBoosters() {
  let stock = [];
  try { stock = await myBoosters(); } catch (e) { stock = []; }
  app.innerHTML = `<h1>Boosters</h1>
    <p class="lead">Chaque booster contient 5 cartes. Tu gagnes des pièces en alignant des coureurs qui marquent des points dans les vraies courses.</p>
    ${state.dailyAvailable ? `<div class="panel row">
      <div class="grow"><b>Ton booster gratuit du jour t'attend !</b></div>
      <a class="btn primary" href="#/recompenses" style="text-decoration:none">Aller aux récompenses</a></div>` : ''}
    ${stockHTML(stock)}
    <div class="boosters">${Object.entries(BOOSTERS).map(([k, b]) => `
      <article class="pack pack-${k}">
        <div class="foil"><span>${b.name}</span><img src="img/boosters/${k}.png" alt="" onload="this.parentElement.classList.add('has-img')" onerror="this.remove()"></div>
        <p>${b.odds}</p>
        <button class="btn primary" data-open="${k}">Ouvrir pour ${coin(b.price)}</button>
      </article>`).join('')}</div>`;
  bindStock(() => pageBoosters());
  $$('[data-open]').forEach(btn => btn.onclick = async () => {
    const type = btn.dataset.open;
    if (state.profile.coins < BOOSTERS[type].price) return toast('Pas assez de pièces pour ce booster.', 'error');
    $$('[data-open]').forEach(b => b.disabled = true);
    const r = await rpc('open_booster', { p_type: type });
    $$('[data-open]').forEach(b => b.disabled = false);
    if (!r.ok) return;
    await refreshProfile();
    showReveal(type, r.data);
  });
}

function showReveal(type, cards) {
  cards = [...cards].sort((a, b) => rarityIdx(a.rarity) - rarityIdx(b.rarity)); // la meilleure en dernier
  const m = openModal(`<div class="reveal">
    <h2>${BOOSTERS[type].name}</h2>
    <p class="muted" style="text-align:center">Clique sur chaque carte pour la retourner.</p>
    <div class="reveal-grid">${cards.map(c => `
      <div class="flip" tabindex="0" role="button" aria-label="Retourner la carte">
        <div class="flip-in"><div class="face back"><img src="img/card-back.png" alt="" onload="this.parentElement.classList.add('has-img')" onerror="this.remove()"></div>
        <div class="face front">${cardHTML({ ...c, id: c.rider_id })}</div></div>
      </div>`).join('')}</div>
    <div class="row" style="justify-content:center">
      <button class="btn" id="revAll">Tout révéler</button>
      <button class="btn primary" id="revClose">Terminer</button>
    </div></div>`, { wide: true });
  $$('.flip', m.box).forEach(f => {
    const go = () => f.classList.add('up');
    f.onclick = go; f.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
  $('#revAll', m.box).onclick = () => $$('.flip', m.box).forEach((f, i) => setTimeout(() => f.classList.add('up'), i * 180));
  $('#revClose', m.box).onclick = m.close;
}

/* =====================================================================
   PAGE : RÉCOMPENSES QUOTIDIENNES
   Dimanche à vendredi : 1 booster Bronze gratuit. Samedi : 1 booster Argent.
   Le jour change à minuit (heure de Paris). Tout est décidé par le serveur.
   ===================================================================== */
async function pageRewards() {
  const draw = async () => {
    const [st, stock] = await Promise.all([fetchDaily(), myBoosters()]);
    state.dailyAvailable = !st.claimed;
    updateChrome();

    const todayType = dailyType(st.dow);
    const tomorrowType = dailyType((st.dow + 1) % 7);
    const base = new Date(st.today + 'T00:00:00Z');
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base.getTime() + (i - st.dow) * 864e5);
      const iso = d.toISOString().slice(0, 10);
      let status;
      if (iso < st.today) status = st.claimed_dates.includes(iso) ? 'done' : 'missed';
      else if (iso === st.today) status = st.claimed ? 'done' : 'available';
      else status = 'future';
      return { i, iso, num: d.getUTCDate(), type: dailyType(i), status };
    });

    const hero = st.claimed
      ? `<div class="panel daily-hero">
          <span class="dpack ${todayType} big"></span>
          <div class="info">
            <h2>Récompense du jour réclamée ✓</h2>
            <p class="muted">Reviens demain ! Ton prochain booster : <b>${BOOSTERS[tomorrowType].name}</b>.</p>
            <p class="muted" style="margin:0">Prochaine récompense dans</p>
            <div class="countdown" id="countdown">--:--:--</div>
          </div>
          <button class="btn big" disabled>Déjà réclamé</button>
        </div>`
      : `<div class="panel daily-hero ready">
          <span class="dpack ${todayType} big"></span>
          <div class="info">
            <h2>${WEEKDAYS_LONG[st.dow]} : ${BOOSTERS[todayType].name} offert</h2>
            <p class="muted">${todayType === 'silver' ? 'Le samedi, la récompense passe au booster Argent !' : 'Un booster gratuit chaque jour, du dimanche au vendredi.'}</p>
            <p class="muted" style="margin:0">À réclamer avant minuit (encore)</p>
            <div class="countdown" id="countdown">--:--:--</div>
          </div>
          <button class="btn primary big pulse" id="claim">Réclamer mon booster</button>
        </div>`;

    app.innerHTML = `<h1>Récompenses</h1>
      <p class="lead">Connecte-toi chaque jour pour récupérer un booster gratuit. Du dimanche au vendredi, c'est un Bronze. Le samedi, c'est un Argent. Le compteur repart à zéro à minuit, heure de Paris.</p>
      ${hero}
      <h2>Cette semaine</h2>
      <div class="week">${days.map(d => `
        <div class="day ${d.status === 'available' ? 'today' : ''} ${d.iso === st.today ? 'today' : ''} ${d.status === 'done' ? 'done' : ''} ${d.status === 'missed' ? 'missed' : ''} ${d.i === 6 ? 'sat' : ''}">
          ${d.i === 6 ? '<span class="ribbon">SPÉCIAL</span>' : ''}
          ${d.status === 'done' ? '<span class="tick" aria-hidden="true">✓</span>' : ''}
          <span class="dn">${WEEKDAYS[d.i]}</span>
          <span class="dd">${d.num}</span>
          <span class="dpack ${d.type}"></span>
          <span class="reward">${d.type === 'silver' ? 'Argent' : 'Bronze'}</span>
          <span class="st">${d.status === 'done' ? 'Réclamé' : d.status === 'available' ? 'À réclamer' : d.status === 'missed' ? 'Manqué' : '&nbsp;'}</span>
        </div>`).join('')}</div>
      ${stockHTML(stock)}`;

    bindStock(() => draw().catch(e => { app.innerHTML = `<p class="error">Erreur : ${esc(e.message || e)}</p>`; }));

    const claimBtn = $('#claim');
    if (claimBtn) {
      claimBtn.onclick = async () => {
        claimBtn.disabled = true;
        const r = await rpc('claim_daily');
        if (r.ok) toast(`${BOOSTERS[r.data.type].name} ajouté à ton stock !`, 'ok');
        await draw();
      };
    }

    /* Compte à rebours jusqu'à minuit (heure de Paris), basé sur l'heure du serveur */
    const el = $('#countdown');
    if (el) {
      const target = Date.now() + st.seconds_left * 1000;
      const tick = () => {
        if (!document.body.contains(el)) { clearInterval(timer); return; }
        const left = Math.ceil((target - Date.now()) / 1000);
        if (left <= 0) {
          clearInterval(timer);
          draw().catch(() => {});
          return;
        }
        el.textContent = fmtClock(left);
      };
      const timer = setInterval(tick, 1000);
      tick();
    }
  };
  await draw();
}

/* =====================================================================
   PAGE : COLLECTION
   ===================================================================== */
async function pageCollection() {
  const [cards, all] = await Promise.all([myCards(), q(sb.from('riders').select('id'))]);
  const groups = groupByRider(cards);
  app.innerHTML = `<h1>Ma collection</h1>
    <p class="lead">${groups.length} coureurs différents sur ${all.length} au catalogue, ${cards.length} cartes au total. Clique sur une carte pour voir ses compétences.</p>
    <div id="col"></div>`;
  if (!cards.length) {
    $('#col').innerHTML = `<div class="panel"><p>Ta vitrine est vide. <a href="#/boosters"><b>Ouvre ton premier booster</b></a> pour commencer.</p></div>`;
    return;
  }
  mountCollection($('#col'), cards);
}

/* =====================================================================
   PAGE : VITRINE (catalogue complet des cartes du jeu)
   Toutes les cartes existantes, même celles qu'on ne possède pas.
   Les cartes non possédées sont estompées, les possédées portent un badge.
   Filtres : nom, équipe, pays, rareté, spécialité, possession. Tri au choix.
   ===================================================================== */
async function pageShowcase() {
  const PAGE = 60;
  const [riders, ownedRows] = await Promise.all([
    fetchAll(() => sb.from('riders').select('*').order('name').order('id')),
    fetchAll(() => sb.from('user_cards').select('rider_id').eq('owner_id', state.uid).order('id')),
  ]);
  const owned = new Map();                        // rider_id -> nombre d'exemplaires
  ownedRows.forEach(c => owned.set(c.rider_id, (owned.get(c.rider_id) || 0) + 1));
  const ownedDistinct = riders.filter(r => owned.has(r.id)).length;
  const pct = riders.length ? Math.round((ownedDistinct / riders.length) * 100) : 0;

  const teams = [...new Set(riders.map(r => r.team).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const countries = [...new Set(riders.map(r => r.country).filter(Boolean))]
    .sort((a, b) => countryName(a).localeCompare(countryName(b)));
  const specialties = SPECIALTIES.filter(s => riders.some(r => r.specialty === s));

  const cmpName = (a, b) => a.name.localeCompare(b.name);
  const sorters = {
    rar: (a, b) => rarityIdx(b.rarity) - rarityIdx(a.rarity) || cmpName(a, b),
    name: cmpName,
    team: (a, b) => (a.team ? 0 : 1) - (b.team ? 0 : 1) || (a.team || '').localeCompare(b.team || '') || cmpName(a, b),
    country: (a, b) => (a.country ? 0 : 1) - (b.country ? 0 : 1) || countryName(a.country).localeCompare(countryName(b.country)) || cmpName(a, b),
  };

  app.innerHTML = `<h1>Vitrine</h1>
    <p class="lead">Tous les coureurs du jeu, même ceux que tu n'as pas encore. Les cartes grisées ne sont pas dans ta collection. Clique sur une carte pour voir ses compétences.</p>
    <div class="panel showcase-head">
      <div class="stat"><b>${ownedDistinct} / ${riders.length}</b><span>coureurs dans ta collection</span></div>
      <div class="grow">
        <div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
        <p class="muted" style="margin:.4rem 0 0">${pct} % du catalogue</p>
      </div>
    </div>
    <div class="filters">
      <label>Recherche<input id="sq" placeholder="Nom du coureur"></label>
      <label>Équipe<select id="st"><option value="">Toutes</option>${teams.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></label>
      <label>Pays<select id="sc"><option value="">Tous</option>${countries.map(c => `<option value="${esc(c)}">${flag(c)} ${esc(countryName(c))}</option>`).join('')}</select></label>
      <label>Rareté<select id="sr"><option value="">Toutes</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select></label>
      <label>Spécialité<select id="ss"><option value="">Toutes</option>${specialties.map(s => `<option value="${s}">${esc(cap1(s))}</option>`).join('')}</select></label>
      <label>Possession<select id="so"><option value="">Toutes les cartes</option><option value="owned">Possédées</option><option value="missing">Manquantes</option></select></label>
      <label>Tri<select id="sort"><option value="rar">Rareté</option><option value="name">Nom</option><option value="team">Équipe</option><option value="country">Pays</option></select></label>
      <button class="btn small" id="sreset" type="button">Réinitialiser</button>
    </div>
    <p class="muted" id="scount"></p>
    <div class="cards" id="grid"></div>
    <p style="margin-top:1rem"><button class="btn" id="smore" type="button" hidden>Afficher plus</button></p>`;

  let shown = PAGE;
  let current = [];

  const draw = () => {
    const fq = nameKey($('#sq').value), ft = $('#st').value, fc = $('#sc').value;
    const fr = $('#sr').value, fs = $('#ss').value, fo = $('#so').value, fsort = $('#sort').value;
    current = riders.filter(r =>
      (!fq || nameKey(r.name).includes(fq))
      && (!ft || r.team === ft)
      && (!fc || r.country === fc)
      && (!fr || r.rarity === fr)
      && (!fs || r.specialty === fs)
      && (fo === 'owned' ? owned.has(r.id) : fo === 'missing' ? !owned.has(r.id) : true)
    ).sort(sorters[fsort] || sorters.rar);

    const part = current.slice(0, shown);
    $('#scount').textContent = riders.length
      ? `${current.length} carte${current.length > 1 ? 's' : ''} affichée${current.length > 1 ? 's' : ''} sur ${riders.length}`
      : '';
    $('#grid').innerHTML = part.length
      ? part.map(r => {
          const n = owned.get(r.id) || 0;
          return `<div class="card-wrap">${cardHTML(r, {
            cls: 'pick ' + (n ? '' : 'unowned'),
            attrs: `data-rid="${r.id}" tabindex="0"`,
            count: n,
            badge: n ? '✓ Possédée' : '',
          })}</div>`;
        }).join('')
      : `<p class="muted">${riders.length ? 'Aucune carte ne correspond à ces filtres.' : 'Le catalogue est vide pour le moment.'}</p>`;
    $('#smore').hidden = current.length <= shown;
  };

  const openCard = el => {
    const card = el.closest('.card');
    if (!card) return;
    const r = riders.find(x => x.id === +card.dataset.rid);
    if (!r) return;
    const n = owned.get(r.id) || 0;
    showRiderDetail(r, n, n > 0);
  };
  $('#grid').onclick = e => openCard(e.target);
  $('#grid').onkeydown = e => { if (e.key === 'Enter') openCard(e.target); };

  $('#sq').oninput = () => { shown = PAGE; draw(); };
  ['st', 'sc', 'sr', 'ss', 'so', 'sort'].forEach(id => { $('#' + id).oninput = () => { shown = PAGE; draw(); }; });
  $('#smore').onclick = () => { shown += PAGE; draw(); };
  $('#sreset').onclick = () => {
    $('#sq').value = '';
    ['st', 'sc', 'sr', 'ss', 'so'].forEach(id => { $('#' + id).value = ''; });
    $('#sort').value = 'rar';
    shown = PAGE;
    draw();
  };
  draw();
}

/* =====================================================================
   PAGE : ÉQUIPE (courses d'un jour)
   Le joueur choisit seulement ses 8 cartes et son capitaine.
   Les points sont calculés automatiquement à la validation de la course.
   ===================================================================== */
function raceState(r) {
  const now = Date.now(), s = +new Date(r.start_at);
  if (r.status === 'finished') return 'finished';
  if (now >= s) return 'locked';
  if (now >= s - 5 * 864e5) return 'open';
  return 'soon';
}
const STATE_LABEL = { soon: 'Bientôt', open: 'Ouverte', locked: 'Verrouillée', finished: 'Terminée' };

async function pageTeam(raceId) {
  if (raceId) return composer(+raceId);
  const [races, mine, done] = await Promise.all([
    q(sb.from('races').select('*').eq('status', 'upcoming').order('start_at')),
    q(sb.from('lineups').select('race_id').eq('user_id', state.uid)),
    q(sb.from('lineups').select('race_id,points,coins_earned,races!inner(id,name,start_at,category,status)').eq('user_id', state.uid).eq('races.status', 'finished')),
  ]);
  const has = new Set(mine.map(m => m.race_id));
  done.sort((a, b) => +new Date(b.races.start_at) - +new Date(a.races.start_at));
  app.innerHTML = `<h1>Équipe</h1>
    <p class="lead">Compose ton équipe de ${TEAM_SIZE} coureurs à partir de 5 jours avant le départ, et choisis un capitaine. Elle se verrouille au départ de la vraie course. Ensuite, tes points sont calculés automatiquement d'après le classement réel : les ${MAX_POSITION} premiers rapportent des points, et ton capitaine compte double s'il finit dans le Top ${CAPTAIN_TOP}.</p>
    <div class="race-list">${races.length ? races.map(r => {
      const s = raceState(r);
      return `<a class="panel race-item" href="#/equipe/${r.id}" style="text-decoration:none">
        <div class="grow"><h3>${esc(r.name)}</h3><span class="muted">${fmtDate(r.start_at)} ${r.category ? '(' + esc(r.category) + ')' : ''}</span></div>
        ${has.has(r.id) ? '<span class="pill">Équipe enregistrée</span>' : ''}
        <span class="pill ${s}">${STATE_LABEL[s]}</span></a>`;
    }).join('') : '<div class="panel"><p>Aucune course à venir pour le moment.</p></div>'}</div>
    ${done.length ? `<h2 style="margin-top:2rem">Mes courses terminées</h2>
    <div class="race-list">${done.map(d => `<a class="panel race-item" href="#/equipe/${d.races.id}" style="text-decoration:none">
        <div class="grow"><h3>${esc(d.races.name)}</h3><span class="muted">${fmtDate(d.races.start_at)} ${d.races.category ? '(' + esc(d.races.category) + ')' : ''}</span></div>
        <b>${d.points} pts (+${d.coins_earned} 🪙)</b>
        <span class="pill finished">${STATE_LABEL.finished}</span></a>`).join('')}</div>` : ''}`;
}

async function composer(raceId) {
  const race = await q(sb.from('races').select('*').eq('id', raceId).single());
  const st = raceState(race);
  const editable = st === 'open';
  const [cards, lk, lineup, results] = await Promise.all([
    myCards(), lockInfo(),
    q(sb.from('lineups').select('id,captain_rider_id,points,coins_earned,lineup_cards(user_card_id,rider_id,riders(*))').eq('race_id', raceId).eq('user_id', state.uid).maybeSingle()),
    st === 'finished' ? q(sb.from('race_results').select('pos,rider_id').eq('race_id', raceId).order('pos')) : Promise.resolve([]),
  ]);
  const groups = groupByRider(cards)
    .map(g => ({ ...g, free: g.cards.filter(c => !lk.listed.has(c.id)) }))
    .filter(g => g.free.length);
  const byRider = new Map(groups.map(g => [g.rider.id, g]));
  const lineupRiders = new Map((lineup?.lineup_cards || []).map(lc => [lc.rider_id, lc.riders]));
  const riderOf = rid => byRider.get(rid)?.rider || lineupRiders.get(rid);

  const sel = new Map();               // rider_id -> user_card_id
  let captain = lineup?.captain_rider_id ?? null;
  if (editable) {
    for (const lc of lineup?.lineup_cards || []) {
      const g = byRider.get(lc.rider_id);
      if (g) sel.set(lc.rider_id, g.free.find(c => c.id === lc.user_card_id)?.id || g.free[0].id);
    }
    if (captain && !sel.has(captain)) captain = null;
  } else {
    for (const lc of lineup?.lineup_cards || []) sel.set(lc.rider_id, lc.user_card_id);
  }

  /* Score réel (course terminée) : calculé à partir des résultats enregistrés en base */
  const score = st === 'finished' && lineup
    ? computeTeamScore([...sel.keys()].map(rid => riderOf(rid)), captain, results)
    : null;
  const scoreOf = rid => score?.cards.find(c => c.rider_id === rid);

  let resultPanel = '';
  if (st === 'finished') {
    if (!lineup) {
      resultPanel = `<div class="panel">Tu n'avais pas aligné d'équipe sur cette course.</div>`;
    } else {
      const sorted = [...score.cards].sort((a, b) => b.points - a.points);
      const diff = score.total !== lineup.points;
      resultPanel = `<div class="panel">
        <h2 style="margin-top:0">Résultat de ton équipe</h2>
        <div class="stat-row">
          <div class="stat"><b>${lineup.points}</b><span>points (+${lineup.coins_earned} pièces)</span></div>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Coureur</th><th>Rareté</th><th class="num">Place réelle</th><th>Calcul</th><th class="num">Points</th></tr></thead><tbody>
        ${sorted.map(c => {
          const r = riderOf(c.rider_id);
          let calc;
          if (c.mythic) calc = `bonus fixe ${MYTHIC_BONUS}`;
          else if (c.pos === null || c.pos > MAX_POSITION) calc = 'hors Top ' + MAX_POSITION;
          else calc = `${c.base} × ${c.mult}${c.captainApplied ? ' × ' + CAPTAIN_MULT + ' (capitaine)' : ''}`;
          return `<tr><td>${esc(r.name)}${c.isCaptain ? ' <span class="captain-mark">★ Capitaine</span>' : ''}</td>
            <td>${RARITY[r.rarity].label}</td>
            <td class="num">${c.mythic ? '–' : (c.pos === null ? 'hors résultats' : c.pos)}</td>
            <td class="muted">${calc}</td>
            <td class="num"><b>${c.points}</b></td></tr>`;
        }).join('')}
        </tbody></table></div>
        ${diff ? `<p class="muted" style="margin:.8rem 0 0">Le total officiel (${lineup.points}) fait foi : il a été calculé au moment de la validation de la course.</p>` : ''}
      </div>`;
    }
  }

  app.innerHTML = `<p><a href="#/equipe">← Toutes les courses</a></p>
    <h1>${esc(race.name)}</h1>
    <p class="lead">${fmtDate(race.start_at)} <span class="pill ${st}">${STATE_LABEL[st]}</span></p>
    ${st === 'soon' ? `<div class="panel">Les équipes ouvrent le ${fmtDate(new Date(+new Date(race.start_at) - 5 * 864e5))}.</div>` : ''}
    ${st === 'locked' ? `<div class="panel">La course a démarré : ton équipe est verrouillée. Les points seront calculés automatiquement dès la validation des résultats.</div>` : ''}
    ${resultPanel}
    <div class="panel">
      <div class="row"><h2 class="grow" style="margin:0">Mon équipe <span id="cnt"></span></h2>
      ${editable ? '<button class="btn primary" id="save">Enregistrer l\'équipe</button>' : ''}</div>
      <div class="slots" id="slots"></div>
      <p class="muted" style="margin:0">Le capitaine marque ×${CAPTAIN_MULT} s'il termine dans le Top ${CAPTAIN_TOP} réel (sinon, il compte comme une carte normale). Les points de chaque carte dépendent de la place réelle du coureur (Top ${MAX_POSITION}) et de sa rareté. 1 point = 1 pièce.</p>
    </div>
    <details class="panel">
      <summary><b>Voir le barème complet (1er au ${MAX_POSITION}e)</b></summary>
      <p class="muted" style="margin-top:.6rem">Points de base, avant multiplicateur de rareté : ${RARITY_ORDER.map(r => `${RARITY[r].label} ×${RARITY[r].mult}`).join(', ')}. Les cartes mythiques vintage rapportent un bonus fixe de ${MYTHIC_BONUS} points.</p>
      ${baremeTable()}
    </details>
    ${editable ? `<h2>Ma collection</h2>
    <div class="filters">
      <label>Rareté<select id="fr"><option value="">Toutes</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select></label>
      <label>Recherche<input id="fq" placeholder="Nom du coureur"></label>
    </div>
    <div class="cards" id="grid"></div>` : ''}`;

  const drawSlots = () => {
    const ids = [...sel.keys()];
    $('#cnt').textContent = `(${ids.length}/${TEAM_SIZE})`;
    $('#slots').innerHTML = Array.from({ length: TEAM_SIZE }, (_, i) => {
      const rid = ids[i];
      if (rid == null) return `<div class="slot"><span class="muted">Libre</span></div>`;
      const r = riderOf(rid);
      const isCap = captain === rid;
      const sc = scoreOf(rid);
      return `<div class="slot full"><b>${esc(r.name)}</b><span class="muted">${RARITY[r.rarity].label}</span>
        ${editable ? `<button class="cap ${isCap ? 'on' : ''}" data-cap="${rid}">${isCap ? '★ Capitaine ×' + CAPTAIN_MULT : '☆ Capitaine'}</button>`
          : (isCap ? '<span class="captain-mark">★ Capitaine</span>' : '')}
        ${sc ? `<span><b>${sc.points} pts</b></span>` : ''}</div>`;
    }).join('');
    $$('[data-cap]').forEach(b => b.onclick = () => { captain = +b.dataset.cap; drawSlots(); });
  };
  const drawGrid = () => {
    if (!editable) return;
    const fr = $('#fr').value, fq = $('#fq').value.toLowerCase();
    const list = groups.filter(g => (!fr || g.rider.rarity === fr) && g.rider.name.toLowerCase().includes(fq))
      .sort((a, b) => rarityIdx(b.rider.rarity) - rarityIdx(a.rider.rarity) || a.rider.name.localeCompare(b.rider.name));
    $('#grid').innerHTML = list.length ? list.map(g => `<div class="card-wrap">${cardHTML(g.rider, {
      count: g.free.length, cls: 'pick ' + (sel.has(g.rider.id) ? 'sel' : (sel.size >= TEAM_SIZE ? 'dim' : '')), attrs: `data-rid="${g.rider.id}" tabindex="0"`,
    })}</div>`).join('') : '<p class="muted">Aucun coureur disponible. Les cartes en vente ne peuvent pas être alignées.</p>';
    $$('#grid .card').forEach(c => {
      const toggle = () => {
        const rid = +c.dataset.rid;
        if (sel.has(rid)) { sel.delete(rid); if (captain === rid) captain = null; }
        else if (sel.size < TEAM_SIZE) sel.set(rid, byRider.get(rid).free[0].id);
        else return toast(`Ton équipe est déjà complète (${TEAM_SIZE} coureurs).`);
        drawSlots(); drawGrid();
      };
      c.onclick = toggle; c.onkeydown = e => { if (e.key === 'Enter') toggle(); };
    });
  };
  drawSlots(); drawGrid();
  if (!editable) return;
  $('#fr').oninput = drawGrid; $('#fq').oninput = drawGrid;
  $('#save').onclick = async () => {
    if (sel.size !== TEAM_SIZE) return toast(`Il faut exactement ${TEAM_SIZE} coureurs.`, 'error');
    if (!captain) return toast('Choisis un capitaine.', 'error');
    const r = await rpc('save_lineup', { p_race_id: raceId, p_card_ids: [...sel.values()], p_captain_rider: captain });
    if (r.ok) toast('Équipe enregistrée !', 'ok');
  };
}

/* =====================================================================
   PAGE : TRANSFERTS (marché, vente, recyclage)
   ===================================================================== */
async function pageTransfers(tab = 'marche') {
  const tabs = [['marche', 'Marché'], ['vendre', 'Vendre'], ['recycler', 'Recyclage']];
  app.innerHTML = `<h1>Transferts</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/transferts/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</div>
    <div id="tab"></div>`;
  const box = $('#tab');
  if (tab === 'vendre') return tabSell(box);
  if (tab === 'recycler') return tabRecycle(box);
  return tabMarket(box);
}

async function tabMarket(box) {
  const rows = await q(sb.from('listings')
    .select('id,price,seller_id,card_id,user_cards(rider_id,riders(*))')
    .eq('status', 'active').order('created_at', { ascending: false }));
  const names = await usernames(rows.map(r => r.seller_id));
  box.innerHTML = `<p class="lead">Achète au prix demandé, ou propose moins : le vendeur accepte ou refuse dans sa messagerie.</p>
    <div class="filters">
      <label>Rareté<select id="fr"><option value="">Toutes</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select></label>
      <label>Recherche<input id="fq" placeholder="Nom du coureur"></label>
    </div><div class="cards" id="grid"></div>`;
  const draw = () => {
    const fr = $('#fr').value, fq = $('#fq').value.toLowerCase();
    const list = rows.filter(l => { const r = l.user_cards.riders; return (!fr || r.rarity === fr) && r.name.toLowerCase().includes(fq); });
    $('#grid').innerHTML = list.length ? list.map(l => {
      const r = l.user_cards.riders, mine = l.seller_id === state.uid;
      return `<div class="card-wrap">${cardHTML(r)}
        <div><b>${coin(l.price)}</b><br><span class="muted">de ${esc(names[l.seller_id] || '?')}</span></div>
        ${mine ? '<span class="pill">Ton annonce</span>' : `<div class="row">
          <button class="btn primary small" data-buy="${l.id}">Acheter</button>
          <button class="btn small" data-offer="${l.id}">Négocier</button></div>`}</div>`;
    }).join('') : '<p class="muted">Aucune annonce pour le moment.</p>';
    $$('[data-buy]').forEach(b => b.onclick = async () => {
      const l = rows.find(x => x.id === b.dataset.buy);
      if (!await confirmBox(`Acheter ${l.user_cards.riders.name} pour ${l.price} pièces ?`, 'Acheter')) return;
      const r = await rpc('buy_listing', { p_listing_id: l.id });
      if (r.ok) { toast('Carte achetée !', 'ok'); await refreshProfile(); pageTransfers('marche'); }
    });
    $$('[data-offer]').forEach(b => b.onclick = async () => {
      const l = rows.find(x => x.id === b.dataset.offer);
      const v = await askNumber({ title: `Offre pour ${l.user_cards.riders.name}`, text: `Prix demandé : ${l.price} pièces. Ton offre doit être inférieure.`, value: Math.max(1, Math.floor(l.price * 0.8)), ok: 'Envoyer l\'offre' });
      if (v == null) return;
      const r = await rpc('make_offer', { p_listing_id: l.id, p_amount: v });
      if (r.ok) toast('Offre envoyée au vendeur.', 'ok');
    });
  };
  $('#fr').oninput = draw; $('#fq').oninput = draw; draw();
}

async function tabSell(box) {
  const [cards, lk, mine] = await Promise.all([
    myCards(), lockInfo(),
    q(sb.from('listings').select('id,price,user_cards(riders(*))').eq('seller_id', state.uid).eq('status', 'active')),
  ]);
  const sellable = cards.filter(c => !lk.listed.has(c.id) && !lk.locked.has(c.id))
    .sort((a, b) => rarityIdx(b.riders.rarity) - rarityIdx(a.riders.rarity));
  box.innerHTML = `
    <h2>Mes annonces</h2>
    <div class="cards" id="mine">${mine.length ? mine.map(l => `<div class="card-wrap">${cardHTML(l.user_cards.riders)}
      <b>${coin(l.price)}</b><button class="btn danger small" data-cancel="${l.id}">Retirer</button></div>`).join('') : '<p class="muted">Aucune annonce en cours.</p>'}</div>
    <h2 style="margin-top:2rem">Mettre une carte en vente</h2>
    <p class="muted">Les cartes engagées dans une équipe à venir ne peuvent pas être vendues. Clique sur une carte pour fixer son prix.</p>
    <div class="cards">${sellable.length ? sellable.map(c => `<div class="card-wrap">${cardHTML(c.riders, { cls: 'pick', attrs: `data-sell="${c.id}" tabindex="0"` })}</div>`).join('') : '<p class="muted">Aucune carte disponible à la vente.</p>'}</div>`;
  $$('[data-cancel]').forEach(b => b.onclick = async () => {
    const r = await rpc('cancel_listing', { p_listing_id: b.dataset.cancel });
    if (r.ok) { toast('Annonce retirée.'); pageTransfers('vendre'); }
  });
  $$('[data-sell]').forEach(el => {
    const go = async () => {
      const c = sellable.find(x => x.id === el.dataset.sell);
      const v = await askNumber({ title: `Vendre ${c.riders.name}`, text: `Valeur de référence : ${RARITY[c.riders.rarity].value} pièces.`, value: RARITY[c.riders.rarity].value, ok: 'Mettre en vente' });
      if (v == null) return;
      const r = await rpc('create_listing', { p_card_id: c.id, p_price: v });
      if (r.ok) { toast('Carte mise en vente.', 'ok'); pageTransfers('vendre'); }
    };
    el.onclick = go; el.onkeydown = e => { if (e.key === 'Enter') go(); };
  });
}

async function tabRecycle(box) {
  const [cards, lk] = await Promise.all([myCards(), lockInfo()]);
  const dups = groupByRider(cards).filter(g => g.cards.length > 1)
    .sort((a, b) => rarityIdx(b.rider.rarity) - rarityIdx(a.rider.rarity));
  box.innerHTML = `<p class="lead">Recycle tes doublons contre des pièces. Tu reçois ${Math.round(RECYCLE_RATE * 100)} % de la valeur de la carte : mieux vaut vendre sur le marché quand c'est possible. Tu gardes toujours un exemplaire de chaque coureur.</p>
    <div id="dups">${dups.length ? dups.map(g => {
      const free = g.cards.filter(c => !lk.listed.has(c.id) && !lk.locked.has(c.id));
      const max = Math.min(g.cards.length - 1, free.length);
      const gain = Math.floor(RARITY[g.rider.rarity].value * RECYCLE_RATE);
      return `<div class="panel row">
        <div class="mini" style="width:96px">${cardHTML(g.rider)}</div>
        <div class="grow"><h3>${esc(g.rider.name)}</h3>
          <p class="muted">${g.cards.length} exemplaires, ${max} recyclable${max > 1 ? 's' : ''}. Gain : ${coin(gain)} par carte.</p></div>
        <label>Quantité<input type="number" min="0" max="${max}" value="${max ? 1 : 0}" style="width:90px" data-q="${g.rider.id}" ${max ? '' : 'disabled'}></label>
        <button class="btn" data-rec="${g.rider.id}" ${max ? '' : 'disabled'}>Recycler</button></div>`;
    }).join('') : '<div class="panel"><p>Tu n\'as aucun doublon pour le moment.</p></div>'}</div>`;
  $$('[data-rec]').forEach(b => b.onclick = async () => {
    const rid = +b.dataset.rec, g = dups.find(x => x.rider.id === rid);
    const n = parseInt($(`[data-q="${rid}"]`).value, 10) || 0;
    const free = g.cards.filter(c => !lk.listed.has(c.id) && !lk.locked.has(c.id));
    if (n < 1) return toast('Choisis une quantité.', 'error');
    const gain = n * Math.floor(RARITY[g.rider.rarity].value * RECYCLE_RATE);
    if (!await confirmBox(`Recycler ${n} × ${g.rider.name} pour ${gain} pièces ?`, 'Recycler')) return;
    const r = await rpc('recycle_cards', { p_card_ids: free.slice(0, n).map(c => c.id) });
    if (r.ok) { toast(`+${r.data} pièces`, 'ok'); await refreshProfile(); pageTransfers('recycler'); }
  });
}

/* =====================================================================
   PAGE : MESSAGERIE
   Offres de transfert, notifications, et cadeaux à réclamer
   (cadeau de bienvenue, cadeaux envoyés par l'admin : Bronze, Argent, Or).
   ===================================================================== */
async function pageMessages() {
  const [msgs, offers] = await Promise.all([
    q(sb.from('messages').select('*').order('created_at', { ascending: false }).limit(60)),
    q(sb.from('offers').select('id,amount,buyer_id,created_at,listings(id,price,seller_id,status,user_cards(riders(*)))').eq('status', 'pending').order('created_at', { ascending: false })),
  ]);

  /* Cadeaux liés aux messages (silencieux si le SQL des cadeaux n'est pas encore installé) */
  let gifts = {};
  try {
    const rows = await q(sb.from('user_gifts').select('id,bronze,silver,gold,claimed_at').eq('user_id', state.uid));
    gifts = Object.fromEntries(rows.map(g => [g.id, g]));
  } catch (e) { gifts = {}; }

  const active = offers.filter(o => o.listings?.status === 'active');
  const received = active.filter(o => o.buyer_id !== state.uid);
  const sent = active.filter(o => o.buyer_id === state.uid);
  const names = await usernames([...received.map(o => o.buyer_id), ...sent.map(o => o.listings.seller_id)]);
  const seenAt = +new Date(state.profile.last_seen_messages);

  const offerRow = (o, mine) => {
    const r = o.listings.user_cards.riders;
    return `<div class="panel offer"><div class="mini" style="width:74px">${cardHTML(r)}</div>
      <div class="grow"><b>${esc(r.name)}</b><br>
        ${mine ? `Ton offre : <b>${coin(o.amount)}</b> (annoncé ${coin(o.listings.price)}) à ${esc(names[o.listings.seller_id] || '?')}`
               : `${esc(names[o.buyer_id] || '?')} propose <b>${coin(o.amount)}</b> (annoncé ${coin(o.listings.price)})`}</div>
      ${mine ? `<button class="btn small danger" data-cancel-offer="${o.id}">Annuler</button>`
             : `<button class="btn small primary" data-yes="${o.id}">Accepter</button><button class="btn small" data-no="${o.id}">Refuser</button>`}</div>`;
  };

  /* Bloc cadeau d'un message : boosters offerts + bouton de réclamation (ou date de réclamation) */
  const giftBlock = m => {
    const g = m.gift_id ? gifts[m.gift_id] : null;
    if (!g) return '';
    const items = `${g.bronze ? `<span class="gift-item"><span class="dpack bronze"></span>×${g.bronze}</span>` : ''}
      ${g.silver ? `<span class="gift-item"><span class="dpack silver"></span>×${g.silver}</span>` : ''}
      ${g.gold ? `<span class="gift-item"><span class="dpack gold"></span>×${g.gold}</span>` : ''}`;
    if (g.claimed_at) {
      return `<div class="gift">${items}</div>
        <p class="muted gift-done">✓ Réclamés le ${fmtDate(g.claimed_at)}. <a href="#/boosters"><b>Ouvrir mes boosters</b></a></p>`;
    }
    return `<div class="gift">${items}<button class="btn primary" data-gift="${g.id}">Réclamer mes boosters</button></div>`;
  };

  app.innerHTML = `<h1>Messagerie</h1>
    <h2>Offres reçues</h2>${received.length ? received.map(o => offerRow(o, false)).join('') : '<p class="muted">Aucune offre en attente.</p>'}
    ${sent.length ? `<h2 style="margin-top:1.5rem">Mes offres envoyées</h2>${sent.map(o => offerRow(o, true)).join('')}` : ''}
    <h2 style="margin-top:1.5rem">Notifications</h2>
    ${msgs.length ? msgs.map(m => `<div class="msg ${m.kind} ${+new Date(m.created_at) > seenAt ? 'new' : ''}">
      <b>${esc(m.title)}</b> <time>${fmtDate(m.created_at)}</time><br><span style="white-space:pre-line">${esc(m.body)}</span>${giftBlock(m)}</div>`).join('') : '<p class="muted">Aucun message.</p>'}`;

  $$('[data-yes]').forEach(b => b.onclick = async () => {
    const r = await rpc('respond_offer', { p_offer_id: b.dataset.yes, p_accept: true });
    if (r.ok) { toast('Offre acceptée, carte vendue.', 'ok'); await refreshProfile(); pageMessages(); }
  });
  $$('[data-no]').forEach(b => b.onclick = async () => {
    const r = await rpc('respond_offer', { p_offer_id: b.dataset.no, p_accept: false });
    if (r.ok) { toast('Offre refusée.'); pageMessages(); }
  });
  $$('[data-cancel-offer]').forEach(b => b.onclick = async () => {
    const r = await rpc('cancel_offer', { p_offer_id: b.dataset.cancelOffer });
    if (r.ok) { toast('Offre annulée.'); pageMessages(); }
  });
  $$('[data-gift]').forEach(b => b.onclick = async () => {
    $$('[data-gift]').forEach(x => x.disabled = true);
    const r = await rpc('claim_gift', { p_gift_id: b.dataset.gift });
    if (r.ok) {
      const parts = [];
      if (r.data.bronze) parts.push(`${r.data.bronze} Bronze`);
      if (r.data.silver) parts.push(`${r.data.silver} Argent`);
      if (r.data.gold) parts.push(`${r.data.gold} Or`);
      toast(`${parts.join(' + ')} ajoutés à ton stock de boosters !`, 'ok');
      pageMessages();
    } else {
      $$('[data-gift]').forEach(x => x.disabled = false);
    }
  });
  await sb.rpc('mark_messages_seen');
  await refreshProfile();
}

/* =====================================================================
   PAGE : PORTEFEUILLE
   ===================================================================== */
async function pageWallet() {
  await refreshProfile();
  const p = state.profile;
  const hist = await q(sb.from('lineups').select('points,coins_earned,races!inner(name,start_at,status)').eq('user_id', state.uid).eq('races.status', 'finished'));
  hist.sort((a, b) => +new Date(b.races.start_at) - +new Date(a.races.start_at));
  app.innerHTML = `<h1>Portefeuille</h1>
    <div class="stat-row">
      <div class="stat"><b>${coin(p.coins)}</b><span>Solde</span></div>
      <div class="stat"><b>${p.points_total}</b><span>Points au classement UCI</span></div>
    </div>
    <p><a class="btn" href="#/profil/${encodeURIComponent(p.username)}" style="text-decoration:none;display:inline-block">Voir mon profil public</a></p>
    <h2 style="margin-top:1.5rem">Mes résultats</h2>
    ${hist.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Date</th><th class="num">Points</th><th class="num">Pièces gagnées</th></tr></thead><tbody>
      ${hist.map(h => `<tr><td>${esc(h.races.name)}</td><td>${fmtDate(h.races.start_at)}</td><td class="num">${h.points}</td><td class="num">+${h.coins_earned}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Aucun résultat pour l\'instant. Compose ton équipe dans l\'onglet Équipe.</p>'}
    <h2 style="margin-top:1.5rem">Barème</h2>
    <div class="panel">
      <p>Les ${MAX_POSITION} premiers de chaque course rapportent des points de base : 1<sup>er</sup> : ${POSITION_POINTS[0]}, 2<sup>e</sup> : ${POSITION_POINTS[1]}, 3<sup>e</sup> : ${POSITION_POINTS[2]}, puis une baisse marquée jusqu'au 10<sup>e</sup> (${POSITION_POINTS[9]}) et plus douce jusqu'au ${MAX_POSITION}<sup>e</sup> (${POSITION_POINTS[MAX_POSITION - 1]}). Au-delà : 0.</p>
      <p>Multiplicateur de rareté : ${RARITY_ORDER.map(r => `${RARITY[r].label} ×${RARITY[r].mult}`).join(', ')}. Capitaine ×${CAPTAIN_MULT} s'il termine dans le Top ${CAPTAIN_TOP}. Les cartes mythiques vintage (coureurs retraités) rapportent un bonus fixe de ${MYTHIC_BONUS} points à chaque course. 1 point = 1 pièce.</p>
      <details><summary><b>Tableau complet</b></summary>${baremeTable()}</details>
    </div>`;
}

/* =====================================================================
   PAGE : CLASSEMENT UCI
   ===================================================================== */
async function pageRanking() {
  const [rows, races] = await Promise.all([
    q(sb.from('public_profiles').select('id,username,points_total,card_count').order('points_total', { ascending: false }).order('username').limit(100)),
    q(sb.from('races').select('id,name,start_at').eq('status', 'finished').order('start_at', { ascending: false })),
  ]);
  app.innerHTML = `<h1>Classement UCI</h1>
    <div class="filters"><label>Classement<select id="rk"><option value="">Général</option>${races.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></label></div>
    <div class="table-wrap" id="tbl"></div>`;
  const drawGeneral = () => {
    $('#tbl').innerHTML = `<table><thead><tr><th>#</th><th>Joueur</th><th class="num">Points</th><th class="num">Cartes</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${r.id === state.uid ? 'me' : ''}"><td>${i + 1}</td>
        <td><a href="#/profil/${encodeURIComponent(r.username)}">${esc(r.username)}</a></td><td class="num">${r.points_total}</td><td class="num">${r.card_count}</td></tr>`).join('')}
    </tbody></table>`;
  };
  const drawRace = async id => {
    const data = await q(sb.rpc('race_ranking', { p_race_id: +id }));
    $('#tbl').innerHTML = `<table><thead><tr><th>#</th><th>Joueur</th><th class="num">Points</th><th class="num">Pièces</th></tr></thead><tbody>
      ${data.length ? data.map((r, i) => `<tr class="${r.username === state.profile.username ? 'me' : ''}"><td>${i + 1}</td>
        <td><a href="#/profil/${encodeURIComponent(r.username)}">${esc(r.username)}</a></td><td class="num">${r.points}</td><td class="num">${r.coins_earned}</td></tr>`).join('')
        : '<tr><td colspan="4" class="muted">Personne n\'a aligné d\'équipe sur cette course.</td></tr>'}
    </tbody></table>`;
  };
  $('#rk').onchange = e => e.target.value ? drawRace(e.target.value) : drawGeneral();
  drawGeneral();
}

/* =====================================================================
   PAGE : PROFIL PUBLIC
   ===================================================================== */
async function pageProfile(username) {
  if (!username) username = state.profile.username;
  const p = await q(sb.from('public_profiles').select('*').eq('username', username.toLowerCase()).maybeSingle());
  if (!p) { app.innerHTML = '<p class="error">Joueur introuvable.</p>'; return; }
  const [cards, ahead] = await Promise.all([
    q(sb.from('user_cards').select('id,rider_id,acquired_at,riders(*)').eq('owner_id', p.id)),
    sb.from('public_profiles').select('id', { count: 'exact', head: true }).gt('points_total', p.points_total),
  ]);
  const counts = Object.fromEntries(RARITY_ORDER.map(r => [r, cards.filter(c => c.riders.rarity === r).length]));
  app.innerHTML = `<h1>${esc(p.username)}</h1>
    <div class="stat-row">
      <div class="stat"><b>${(ahead.count ?? 0) + 1}<sup style="font-size:.5em">e</sup></b><span>au classement</span></div>
      <div class="stat"><b>${p.points_total}</b><span>points</span></div>
      <div class="stat"><b>${cards.length}</b><span>cartes (${groupByRider(cards).length} coureurs)</span></div>
    </div>
    <p class="muted">${RARITY_ORDER.slice().reverse().filter(r => counts[r]).map(r => `${counts[r]} ${RARITY[r].label.toLowerCase()}${counts[r] > 1 ? 's' : ''}`).join(', ') || 'Vitrine vide.'}</p>
    <div id="col"></div>`;
  if (cards.length) mountCollection($('#col'), cards);
}

/* =====================================================================
   IMPORT DES COUREURS : parsing du format texte
   Format : Nom;PAYS;TEAM;spécialité;(Notes);rareté
   Exemple : Filippo BARONCINI;ITA;UAE Team Emirates;Un jour;(506 Un jour, 391 GC, 428 TT, 126 Sprint, 184 Grimpeur, 399 Collines);rare
   ===================================================================== */
const RARITY_ALIAS = { commune: 'common', common: 'common', rare: 'rare', ultra: 'ultra', 'ultra rare': 'ultra', legendaire: 'legendary', legendary: 'legendary', mythique: 'mythic', mythic: 'mythic', vintage: 'mythic' };

/* Libellé de spécialité (format texte) vers la spécialité stockée en base */
const SPECIALTY_ALIAS = {
  'un jour': 'classiques', classiques: 'classiques', classique: 'classiques',
  gc: 'complet', complet: 'complet', general: 'complet',
  tt: 'rouleur', chrono: 'rouleur', 'contre la montre': 'rouleur', rouleur: 'rouleur',
  sprint: 'sprinteur', sprinteur: 'sprinteur',
  grimpeur: 'grimpeur', climber: 'grimpeur',
  collines: 'puncheur', vallons: 'puncheur', hills: 'puncheur', puncheur: 'puncheur',
  vintage: 'vintage',
};

/* Libellé de compétence (dans le bloc de notes) vers la colonne de la base */
const STAT_ALIAS = {
  'un jour': 'oneday', oneday: 'oneday', 'one day': 'oneday',
  gc: 'gc', general: 'gc',
  tt: 'tt', chrono: 'tt', clm: 'tt', 'contre la montre': 'tt',
  sprint: 'sprint',
  grimpeur: 'climber', climber: 'climber',
  collines: 'hills', vallons: 'hills', hills: 'hills',
};

/* Codes pays à 3 lettres (formats usuels du cyclisme) vers codes à 2 lettres */
const ISO3_TO_ISO2 = {
  FRA: 'FR', BEL: 'BE', NED: 'NL', NLD: 'NL', ITA: 'IT', ESP: 'ES', GBR: 'GB', GER: 'DE', DEU: 'DE',
  DEN: 'DK', DNK: 'DK', SLO: 'SI', SVN: 'SI', SUI: 'CH', CHE: 'CH', AUT: 'AT', NOR: 'NO', SWE: 'SE',
  FIN: 'FI', POL: 'PL', CZE: 'CZ', SVK: 'SK', POR: 'PT', PRT: 'PT', USA: 'US', CAN: 'CA', AUS: 'AU',
  NZL: 'NZ', COL: 'CO', ECU: 'EC', MEX: 'MX', ERI: 'ER', RSA: 'ZA', ZAF: 'ZA', IRL: 'IE', LUX: 'LU',
  LAT: 'LV', LVA: 'LV', LTU: 'LT', EST: 'EE', UKR: 'UA', RUS: 'RU', KAZ: 'KZ', CRO: 'HR', HRV: 'HR',
  HUN: 'HU', ROU: 'RO', ROM: 'RO', BLR: 'BY', ISR: 'IL', JPN: 'JP', ETH: 'ET', RWA: 'RW', VEN: 'VE',
  ARG: 'AR', BRA: 'BR', CHI: 'CL', CHL: 'CL', CRC: 'CR', CRI: 'CR', BUL: 'BG', BGR: 'BG', GRE: 'GR',
  GRC: 'GR', TUR: 'TR', SRB: 'RS', BIH: 'BA', ISL: 'IS', CHN: 'CN', KOR: 'KR', IRI: 'IR', IRN: 'IR',
  UAE: 'AE', ARE: 'AE', MAR: 'MA', ALG: 'DZ', DZA: 'DZ', TUN: 'TN', EGY: 'EG', NAM: 'NA', BOL: 'BO',
  URU: 'UY', URY: 'UY', PER: 'PE', MDA: 'MD', GEO: 'GE', ARM: 'AM', AZE: 'AZ', ALB: 'AL', MLT: 'MT',
  CYP: 'CY', MNE: 'ME', MKD: 'MK', LIE: 'LI', MON: 'MC', AND: 'AD',
};

/* Libellé normalisé : sans accents, minuscules, tirets remplacés par des espaces */
const normLabel = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();

/* Code pays à 2 ou 3 lettres vers code à 2 lettres (null si inconnu) */
function toIso2(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c)) return c;
  return ISO3_TO_ISO2[c] || null;
}

/* « Filippo BARONCINI » devient « Filippo Baroncini » (les mots tout en majuscules sont recapitalisés) */
function prettyName(n) {
  return String(n).trim().replace(/\s+/g, ' ').split(' ').map(w => {
    const letters = w.replace(/[^\p{L}]/gu, '');
    if (letters.length > 1 && w === w.toUpperCase() && w !== w.toLowerCase()) {
      return w.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    }
    return w;
  }).join(' ');
}

/* Bloc de notes « (506 Un jour, 391 GC, ...) » vers { oneday, gc, tt, sprint, climber, hills } */
function parseStatsBlock(text) {
  const stats = { oneday: 0, gc: 0, tt: 0, sprint: 0, climber: 0, hills: 0 };
  const inner = String(text ?? '').replace(/^\s*\(/, '').replace(/\)\s*$/, '').trim();
  if (!inner) return { stats };
  for (const chunk of inner.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    let num, label;
    let m = part.match(/^(\d+)\s+(.+)$/);
    if (m) { num = m[1]; label = m[2]; }
    else {
      m = part.match(/^(.+?)\s+(\d+)$/);
      if (!m) return { error: `note illisible « ${part} »` };
      label = m[1]; num = m[2];
    }
    const key = STAT_ALIAS[normLabel(label)];
    if (!key) return { error: `compétence inconnue « ${label.trim()} »` };
    stats[key] = parseInt(num, 10);
  }
  return { stats };
}

/* Analyse d'une ligne. Renvoie { row } ou { error } */
function parseRiderLine(line) {
  const parts = line.split(';').map(s => s.trim());
  if (parts.length !== 6) {
    return { error: `6 champs attendus (Nom;PAYS;TEAM;spécialité;(Notes);rareté), ${parts.length} trouvé(s)` };
  }
  const [rawName, rawCountry, team, rawSpec, rawNotes, rawRar] = parts;
  if (!rawName) return { error: 'nom manquant' };

  let country = '';
  if (rawCountry) {
    country = toIso2(rawCountry);
    if (country === null) return { error: `pays inconnu « ${rawCountry} »` };
  }
  const specialty = SPECIALTY_ALIAS[normLabel(rawSpec)];
  if (!specialty) return { error: `spécialité inconnue « ${rawSpec} »` };
  const rarity = RARITY_ALIAS[normLabel(rawRar)];
  if (!rarity) return { error: `rareté inconnue « ${rawRar} » (commune, rare, ultra, légendaire, mythique)` };
  const parsed = parseStatsBlock(rawNotes);
  if (parsed.error) return { error: parsed.error };

  return { row: { name: prettyName(rawName), country, team, specialty, rarity, ...parsed.stats } };
}

/* Analyse d'un texte complet (une ligne par coureur).
   Renvoie { rows: [...], errors: [{ n, line, error }] } */
function parseRidersText(text) {
  const rows = [], errors = [];
  String(text ?? '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const res = parseRiderLine(line);
    if (res.error) errors.push({ n: i + 1, line, error: res.error });
    else rows.push(res.row);
  });
  return { rows, errors };
}

/* Résultats de course collés à la main : un coureur par ligne, avec ou sans numéro de place.
   Exemples : « 1. Tadej Pogačar », « 2 Jonas Vingegaard », « Remco Evenepoel » (place = numéro de ligne).
   Renvoie [{ position, rider_name }] limité au Top 30. */
function parsePastedResults(text) {
  const out = [];
  String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    const m = line.match(/^(\d{1,3})\s*[.)\-:–]?\s+(.+)$/);
    const name = (m ? m[2] : line).trim();
    const position = m ? parseInt(m[1], 10) : out.length + 1;
    out.push({ position, rider_name: name });
  });
  return out.filter(r => r.position >= 1 && r.position <= MAX_POSITION).slice(0, MAX_POSITION);
}

/* =====================================================================
   PAGE : ADMIN (validation de course, courses, coureurs, cadeaux de boosters, actualités)
   ===================================================================== */
async function pageAdmin() {
  if (!state.profile.is_admin) { app.innerHTML = '<p class="error">Accès réservé.</p>'; return; }
  const [races, ridersInit, playersInit] = await Promise.all([
    q(sb.from('races').select('*').eq('status', 'upcoming').order('start_at')),
    fetchAll(() => sb.from('riders').select('*').order('name').order('id')),
    fetchAll(() => sb.from('public_profiles').select('id,username').order('username').order('id')),
  ]);
  let riders = ridersInit;
  const players = playersInit;
  let riderByKey = new Map();        // clé de rapprochement -> coureurs du catalogue
  let top30 = [];                    // classement à valider : [{ position, rider_name }]
  let shown = 50;
  let picked = null;                 // joueur choisi pour le cadeau de boosters
  const rarityOptions = RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('');

  app.innerHTML = `<h1>Administration</h1>

    <div class="panel"><h2>Validation de course</h2>
      <p class="muted">1. Choisis la course et colle le lien de sa page de résultats sur firstcycling.com. 2. Clique sur « Récupérer les résultats de la course » et vérifie le Top ${MAX_POSITION} (tu peux corriger un nom). 3. Clique sur « Valider et calculer les scores » : les points et pièces sont crédités aux joueurs et la course passe en « Terminée ». Les coureurs absents de ton catalogue sont ignorés. Action définitive.</p>
      <label>Course<select id="vr">${races.length ? races.map(r => `<option value="${r.id}">${esc(r.name)} (${fmtDate(r.start_at)})</option>`).join('') : '<option value="">Aucune course à venir</option>'}</select></label>
      <label style="margin-top:.6rem">Lien de la page de résultats (firstcycling.com)<input id="vurl" type="url" placeholder="https://firstcycling.com/..." autocomplete="off"></label>
      <p style="margin-top:.8rem"><button class="btn" id="vFetch">Récupérer les résultats de la course</button></p>
      <p id="vStatus" class="muted" role="status"></p>
      <details id="vManualBox"><summary><b>Saisie manuelle (secours)</b></summary>
        <p class="muted" style="margin-top:.6rem">Colle un coureur par ligne, dans l'ordre d'arrivée, avec ou sans numéro de place. Exemple : <code>1. Tadej Pogačar</code></p>
        <textarea id="vPaste" style="min-height:140px" placeholder="1. Tadej Pogačar&#10;2. Mathieu van der Poel&#10;3. Wout van Aert"></textarea>
        <p><button class="btn small" id="vPasteBtn">Utiliser ces résultats</button></p>
      </details>
      <div id="vTable" class="table-wrap" style="margin-top:.8rem"></div>
      <p id="vSummary" class="muted" style="margin-top:.6rem"></p>
      <p><button class="btn primary" id="vBtn" disabled>Valider et calculer les scores</button></p></div>

    <div class="panel"><h2>Offrir des boosters</h2>
      <p class="muted">Envoie des boosters à un joueur ou à toute la communauté. Le joueur reçoit un message dans sa messagerie avec un bouton « Réclamer mes boosters » (ou les boosters sont crédités tout de suite si tu coches la case correspondante). Les boosters offerts vont dans son stock et s'ouvrent gratuitement.</p>
      <label style="display:flex;gap:.5rem;align-items:center;font-size:15px">
        <input type="checkbox" id="gAll"> Distribuer à tous les joueurs (${players.length} joueur${players.length > 1 ? 's' : ''})
      </label>
      <div id="gWho" style="margin-top:.8rem">
        <label>Rechercher un joueur (pseudo)<input id="gq" placeholder="Tape un pseudo" autocomplete="off"></label>
        <select id="gsel" size="6" style="width:100%;margin-top:.5rem" aria-label="Liste des joueurs"></select>
        <p class="muted" id="gpicked" style="margin:.4rem 0 0">Aucun joueur sélectionné.</p>
      </div>
      <div class="filters">
        <label>Bronze<input type="number" id="gBronze" min="0" max="100" step="1" value="0" inputmode="numeric" style="width:100px"></label>
        <label>Argent<input type="number" id="gSilver" min="0" max="100" step="1" value="0" inputmode="numeric" style="width:100px"></label>
        <label>Or<input type="number" id="gGold" min="0" max="100" step="1" value="0" inputmode="numeric" style="width:100px"></label>
      </div>
      <label>Message personnalisé (optionnel, 500 caractères maximum)
        <textarea id="gmsg" maxlength="500" style="min-height:80px" placeholder="Ex. Merci d'être là pour le lancement !"></textarea>
      </label>
      <label style="display:flex;gap:.5rem;align-items:center;font-size:15px;margin-top:.6rem">
        <input type="checkbox" id="gDirect"> Créditer directement les boosters (sans bouton « Réclamer »)
      </label>
      <p style="margin-top:.8rem"><button class="btn primary" id="gBtn">Envoyer le cadeau</button></p></div>

    <div class="panel"><h2>Ajouter des courses</h2>
      <p class="muted">Une course par ligne, format : <code>Nom;Catégorie;AAAA-MM-JJ HH:MM</code> (heure de départ de ton fuseau). Copie les courses du calendrier L'Équipe puis mets-les à ce format.</p>
      <textarea id="raceCsv" placeholder="Il Lombardia;WorldTour;2026-10-10 10:30"></textarea>
      <p><button class="btn" id="raceBtn">Importer les courses</button></p></div>

    <div class="panel"><h2>Importer des coureurs</h2>
      <p class="muted">Un coureur par ligne : <code>Nom;PAYS;TEAM;spécialité;(Notes);rareté</code>. Le pays peut avoir 2 ou 3 lettres. Spécialités acceptées : Un jour, GC, TT, Sprint, Grimpeur, Collines (ou ${SPECIALTIES.join(', ')}). Raretés : commune, rare, ultra, légendaire, mythique. Un coureur déjà au catalogue (même nom) est mis à jour. Si une ligne est invalide, rien n'est importé.</p>
      <textarea id="riderCsv" placeholder="Filippo BARONCINI;ITA;UAE Team Emirates;Un jour;(506 Un jour, 391 GC, 428 TT, 126 Sprint, 184 Grimpeur, 399 Collines);rare"></textarea>
      <p><button class="btn" id="riderBtn">Importer les coureurs</button></p>
      <div id="riderReport" class="report"></div></div>

    <div class="panel"><h2>Gérer les coureurs</h2>
      <div class="filters" style="margin-top:0">
        <label>Recherche (nom ou équipe)<input id="mq" placeholder="Ex. Pogačar ou UAE"></label>
        <label>Rareté<select id="mr"><option value="">Toutes</option>${rarityOptions}</select></label>
        <span class="muted" id="mcount"></span>
      </div>
      <div class="table-wrap"><table class="mtable"><thead><tr><th>Coureur</th><th>Équipe</th><th>Rareté</th><th>Compétences</th><th></th></tr></thead>
        <tbody id="mbody"></tbody></table></div>
      <p style="margin:.8rem 0 0"><button class="btn small" id="mmore" hidden>Afficher plus</button></p></div>

    <div class="panel"><h2>Publier une actualité</h2>
      <div class="row"><input id="nt" placeholder="Titre" class="grow"></div>
      <textarea id="nb" placeholder="Message pour tous les joueurs" style="margin-top:.6rem"></textarea>
      <p><button class="btn" id="newsBtn">Publier</button></p></div>

    <div class="panel"><h2>Visuels des coureurs</h2>
      <p class="muted">Pour chaque coureur, envoie sur GitHub une photo dans le dossier <code>img/riders/</code> avec exactement le nom de fichier indiqué (.jpg, .png ou .webp). Le mot « manquant » disparaît quand la photo est trouvée.</p>
      <div class="table-wrap"><table><thead><tr><th>Coureur</th><th>Nom du fichier</th><th>Aperçu</th></tr></thead><tbody id="visBody"></tbody></table></div></div>`;

  /* ----- Statut de chaque ligne du classement par rapport au catalogue ----- */
  const statusInfo = () => {
    const seen = new Set();
    return top30.map(r => {
      const hits = riderByKey.get(matchKey(r.rider_name)) || [];
      if (!hits.length) return { cls: 'pill', label: 'Hors catalogue', ok: false };
      if (hits.length > 1) return { cls: 'pill locked', label: 'Nom ambigu', ok: false };
      if (seen.has(hits[0].id)) return { cls: 'pill locked', label: 'Doublon', ok: false };
      seen.add(hits[0].id);
      return { cls: 'pill open', label: '✓ ' + hits[0].name, ok: true };
    });
  };
  /* Résultats prêts pour validate_race (uniquement les coureurs du catalogue) */
  const matchedResults = () => {
    const seen = new Set(), out = [];
    top30.forEach(r => {
      const hits = riderByKey.get(matchKey(r.rider_name)) || [];
      if (hits.length === 1 && !seen.has(hits[0].id)) {
        seen.add(hits[0].id);
        out.push({ pos: r.position, rider_id: hits[0].id });
      }
    });
    return out;
  };
  const refreshStatus = () => {
    const info = statusInfo();
    info.forEach((s, i) => {
      const td = $(`[data-st="${i}"]`);
      if (td) td.innerHTML = `<span class="${s.cls}">${esc(s.label)}</span>`;
    });
    const n = info.filter(s => s.ok).length;
    $('#vSummary').textContent = top30.length
      ? `${top30.length} place${top30.length > 1 ? 's' : ''} · ${n} coureur${n > 1 ? 's' : ''} du catalogue crédité${n > 1 ? 's' : ''} · ${top30.length - n} ignoré${top30.length - n > 1 ? 's' : ''} (hors catalogue, doublon ou ambigu)`
      : '';
    $('#vBtn').disabled = n === 0;
  };
  const drawTop = () => {
    $('#vTable').innerHTML = top30.length
      ? `<table><thead><tr><th class="num">Place</th><th>Coureur (modifiable)</th><th>Catalogue</th></tr></thead><tbody>
        ${top30.map((r, i) => `<tr><td class="num">${r.position}</td>
          <td><input data-vn="${i}" value="${esc(r.rider_name)}" style="width:100%;min-width:200px" aria-label="Nom du coureur à la place ${r.position}"></td>
          <td data-st="${i}"></td></tr>`).join('')}</tbody></table>`
      : '';
    $$('[data-vn]').forEach(inp => {
      inp.oninput = () => { top30[+inp.dataset.vn].rider_name = inp.value; refreshStatus(); };
    });
    refreshStatus();
  };

  /* ----- Listes dérivées de la liste des coureurs ----- */
  const rebuildLookups = () => {
    riderByKey = new Map();
    riders.forEach(r => {
      const k = matchKey(r.name);
      riderByKey.set(k, [...(riderByKey.get(k) || []), r]);
    });
    if (top30.length) refreshStatus();
  };
  const drawVisuals = () => {
    $('#visBody').innerHTML = riders.map(r => {
      const sl = slug(r.name);
      return `<tr><td>${esc(r.name)}</td><td><code>${sl}.jpg</code></td><td><span class="muted">manquant</span><img class="thumb" src="img/riders/${sl}.jpg" alt="" data-slug="${sl}" data-i="0" onload="this.previousElementSibling.hidden=true" onerror="imgFallback(this)"></td></tr>`;
    }).join('');
  };
  const drawManage = () => {
    const fq = nameKey($('#mq').value), fr = $('#mr').value;
    const list = riders.filter(r => (!fr || r.rarity === fr)
      && (!fq || nameKey(r.name).includes(fq) || nameKey(r.team).includes(fq)));
    const part = list.slice(0, shown);
    $('#mcount').textContent = `${list.length} coureur${list.length > 1 ? 's' : ''}`;
    $('#mbody').innerHTML = part.length ? part.map(r => `<tr>
        <td>${flag(r.country)} <b>${esc(r.name)}</b></td>
        <td>${esc(r.team || '–')}</td>
        <td>${RARITY[r.rarity].label}</td>
        <td style="min-width:130px">${RiderStatsBars(r, { compact: true }) || '<span class="muted">–</span>'}</td>
        <td class="act"><button class="btn small" data-edit="${r.id}">Éditer</button> <button class="btn small danger" data-del="${r.id}">Supprimer</button></td>
      </tr>`).join('')
      : '<tr><td colspan="5" class="muted">Aucun coureur ne correspond.</td></tr>';
    $('#mmore').hidden = list.length <= shown;
  };
  const reloadRiders = async () => {
    riders = await fetchAll(() => sb.from('riders').select('*').order('name').order('id'));
    rebuildLookups(); drawManage(); drawVisuals();
  };

  /* ----- Cadeau de boosters : choix du joueur ----- */
  const drawPlayers = () => {
    const fq = nameKey($('#gq').value);
    const list = players.filter(p => !fq || nameKey(p.username).includes(fq));
    const part = list.slice(0, 200);
    $('#gsel').innerHTML = part.length
      ? part.map(p => `<option value="${p.id}" ${picked && picked.id === p.id ? 'selected' : ''}>${esc(p.username)}</option>`).join('')
      : '<option value="" disabled>Aucun joueur ne correspond</option>';
    if (list.length > part.length) {
      $('#gsel').insertAdjacentHTML('beforeend', `<option value="" disabled>… ${list.length - part.length} autre(s) : affine la recherche</option>`);
    }
  };
  const drawPicked = () => {
    $('#gpicked').textContent = picked ? `Destinataire : ${picked.username}` : 'Aucun joueur sélectionné.';
  };
  $('#gq').oninput = drawPlayers;
  $('#gsel').onchange = () => {
    picked = players.find(p => p.id === $('#gsel').value) || null;
    drawPicked();
  };
  $('#gAll').onchange = () => {
    $('#gWho').style.display = $('#gAll').checked ? 'none' : '';
  };
  $('#gBtn').onclick = async () => {
    const readQty = id => {
      const raw = $(id).value.trim();
      if (raw === '') return 0;
      const v = Number(raw);
      return Number.isInteger(v) ? v : NaN;
    };
    const bronze = readQty('#gBronze'), silver = readQty('#gSilver'), gold = readQty('#gGold');
    if ([bronze, silver, gold].some(v => Number.isNaN(v) || v < 0 || v > 100)) {
      return toast('Quantités : des nombres entiers de 0 à 100.', 'error');
    }
    if (bronze + silver + gold === 0) return toast('Choisis au moins un booster à offrir.', 'error');
    const all = $('#gAll').checked;
    if (!all && !picked) return toast('Choisis un joueur, ou coche « Distribuer à tous les joueurs ».', 'error');
    const direct = $('#gDirect').checked;
    const message = $('#gmsg').value.trim();

    const parts = [];
    if (bronze) parts.push(`${bronze} Bronze`);
    if (silver) parts.push(`${silver} Argent`);
    if (gold) parts.push(`${gold} Or`);
    const who = all ? `les ${players.length} joueurs` : picked.username;
    const total = all ? players.length : 1;
    const ok = await confirmBox(
      `Offrir ${parts.join(' + ')} à ${who}${all ? ` (${total * (bronze + silver + gold)} boosters au total)` : ''} ${direct ? ', crédités tout de suite' : ', à réclamer depuis la messagerie'} ?`,
      'Envoyer'
    );
    if (!ok) return;

    const btn = $('#gBtn'); btn.disabled = true;
    const r = await rpc('admin_give_boosters', {
      p_user_id: all ? null : picked.id,
      p_all: all,
      p_bronze: bronze,
      p_silver: silver,
      p_gold: gold,
      p_message: message,
      p_direct: direct,
    });
    btn.disabled = false;
    if (!r.ok) return;
    toast(`Cadeau envoyé à ${r.data} joueur${r.data > 1 ? 's' : ''}.`, 'ok');
    $('#gBronze').value = '0'; $('#gSilver').value = '0'; $('#gGold').value = '0';
    $('#gmsg').value = '';
    $('#gDirect').checked = false;
  };

  /* ----- Édition d'un coureur (fenêtre modale) ----- */
  const editRider = r => {
    const m = openModal(`<h3>Modifier ${esc(r.name)}</h3>
      <form id="rf" class="rform">
        <label>Nom<input name="name" required maxlength="80" value="${esc(r.name)}"></label>
        <label>Pays (code à 2 ou 3 lettres)<input name="country" maxlength="3" value="${esc(r.country)}"></label>
        <label>Équipe<input name="team" maxlength="80" value="${esc(r.team || '')}"></label>
        <label>Spécialité<select name="specialty">${SPECIALTIES.map(s => `<option value="${s}" ${s === r.specialty ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>Rareté<select name="rarity">${RARITY_ORDER.map(k => `<option value="${k}" ${k === r.rarity ? 'selected' : ''}>${RARITY[k].label}</option>`).join('')}</select></label>
        <fieldset class="stats-edit"><legend>Compétences</legend>
          ${STAT_DEFS.map(s => `<label>${esc(s.label)}<input type="number" min="0" step="1" inputmode="numeric" name="${s.key}" value="${Number(r[s.key]) || 0}"></label>`).join('')}
        </fieldset>
        <div id="rprev"></div>
        <p id="rerr" class="error" role="alert"></p>
        <div class="row"><button type="button" class="btn" data-x>Annuler</button><button type="submit" class="btn primary">Enregistrer</button></div>
      </form>`);
    const f = $('#rf', m.box);
    const readStats = () => Object.fromEntries(STAT_DEFS.map(s => [s.key, Math.max(0, parseInt(f.elements[s.key].value, 10) || 0)]));
    const preview = () => { $('#rprev', m.box).innerHTML = RiderStatsBars(readStats()); };
    STAT_DEFS.forEach(s => { f.elements[s.key].oninput = preview; });
    preview();
    $('[data-x]', m.box).onclick = m.close;
    f.onsubmit = async e => {
      e.preventDefault();
      const err = $('#rerr', m.box); err.textContent = '';
      const name = f.elements['name'].value.trim().replace(/\s+/g, ' ');
      if (!name) { err.textContent = 'Le nom est obligatoire.'; return; }
      const rawCountry = f.elements['country'].value.trim();
      const country = rawCountry ? toIso2(rawCountry) : '';
      if (country === null) { err.textContent = 'Code pays inconnu (2 ou 3 lettres, ex. FR ou FRA).'; return; }
      const patch = {
        name, country,
        team: f.elements['team'].value.trim(),
        specialty: f.elements['specialty'].value,
        rarity: f.elements['rarity'].value,
        ...readStats(),
      };
      const btn = $('[type="submit"]', f); btn.disabled = true;
      const { data, error } = await sb.from('riders').update(patch).eq('id', r.id).select().single();
      btn.disabled = false;
      if (error) {
        err.textContent = /duplicate|unique/i.test(error.message) ? 'Un coureur porte déjà ce nom.' : error.message;
        return;
      }
      riders = riders.map(x => (x.id === r.id ? data : x)).sort((a, b) => a.name.localeCompare(b.name));
      rebuildLookups(); drawManage(); drawVisuals();
      m.close();
      toast('Coureur modifié.', 'ok');
    };
  };

  /* ----- Suppression d'un coureur (avec confirmation) ----- */
  const deleteRider = async r => {
    if (!await confirmBox(`Supprimer définitivement ${r.name} du catalogue ?`, 'Supprimer')) return;
    const res = await rpc('admin_delete_rider', { p_id: r.id });
    if (res.ok) {
      riders = riders.filter(x => x.id !== r.id);
      rebuildLookups(); drawManage(); drawVisuals();
      toast('Coureur supprimé.', 'ok');
    }
  };

  rebuildLookups(); drawManage(); drawVisuals(); drawPlayers(); drawPicked();

  $('#mq').oninput = () => { shown = 50; drawManage(); };
  $('#mr').oninput = () => { shown = 50; drawManage(); };
  $('#mmore').onclick = () => { shown += 50; drawManage(); };
  $('#mbody').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    const id = +(b.dataset.edit || b.dataset.del);
    const r = riders.find(x => x.id === id);
    if (!r) return;
    if (b.dataset.edit) editRider(r); else deleteRider(r);
  };

  /* ----- Validation de course : récupération automatique du classement ----- */
  $('#vFetch').onclick = async () => {
    const url = $('#vurl').value.trim();
    if (!url) return toast('Colle d\'abord le lien de la page de résultats.', 'error');
    const btn = $('#vFetch'); btn.disabled = true;
    $('#vStatus').className = 'muted';
    $('#vStatus').textContent = 'Récupération en cours…';
    const out = await callFn('fetch-race-results', { url });
    btn.disabled = false;
    if (!out.ok) {
      $('#vStatus').className = 'error';
      $('#vStatus').textContent = out.error + ' Tu peux coller les résultats à la main dans « Saisie manuelle ».';
      $('#vManualBox').open = true;
      return;
    }
    top30 = out.data.results.map(r => ({ position: r.position, rider_name: r.rider_name }));
    $('#vStatus').className = 'muted';
    $('#vStatus').textContent = `${top30.length} résultat${top30.length > 1 ? 's' : ''} récupéré${top30.length > 1 ? 's' : ''}. Vérifie le tableau ci-dessous avant de valider.${out.data.warning ? ' ⚠ ' + out.data.warning : ''}`;
    drawTop();
  };

  /* ----- Validation de course : saisie manuelle de secours ----- */
  $('#vPasteBtn').onclick = () => {
    const list = parsePastedResults($('#vPaste').value);
    if (!list.length) return toast('Colle au moins un coureur (un par ligne).', 'error');
    top30 = list;
    $('#vStatus').className = 'muted';
    $('#vStatus').textContent = `${top30.length} ligne${top30.length > 1 ? 's' : ''} saisie${top30.length > 1 ? 's' : ''} à la main. Vérifie le tableau ci-dessous avant de valider.`;
    drawTop();
  };

  /* ----- Validation de course : calcul et distribution des gains ----- */
  $('#vBtn').onclick = async () => {
    const raceId = +$('#vr').value;
    if (!raceId) return toast('Aucune course sélectionnée.', 'error');
    const n = statusInfo().filter(s => s.ok).length;
    if (!n) return toast('Aucun coureur du catalogue dans ce classement.', 'error');
    const raceName = $('#vr').selectedOptions[0]?.textContent || 'cette course';
    if (!await confirmBox(`Valider définitivement « ${raceName} » ? ${n} coureur${n > 1 ? 's' : ''} du catalogue sera${n > 1 ? 'ont' : ''} pris en compte, les points et pièces seront crédités aux joueurs.`, 'Valider')) return;

    const btn = $('#vBtn'); btn.disabled = true;
    const out = await callFn('process-race-scores', {
      race_id: raceId,
      results: top30.map(r => ({ position: r.position, rider_name: String(r.rider_name).trim() })),
    });
    if (out.ok) {
      const d = out.data;
      toast(`Course validée : ${d.players} équipe${d.players > 1 ? 's' : ''} créditée${d.players > 1 ? 's' : ''}, ${d.total_points} points distribués.`, 'ok');
      pageAdmin();
      return;
    }
    if (out.unreachable) {
      /* Secours : la fonction serveur est injoignable, on applique le même calcul SQL directement */
      if (await confirmBox('La fonction serveur est injoignable. Valider directement avec le calcul intégré à la base (même barème, même résultat) ?', 'Valider directement')) {
        const r = await rpc('validate_race', { p_race_id: raceId, p_results: matchedResults() });
        if (r.ok) { toast('Course validée, gains distribués.', 'ok'); pageAdmin(); return; }
      }
    } else {
      toast(out.error, 'error');
    }
    btn.disabled = false;
    refreshStatus();
  };

  /* ----- Import des courses ----- */
  $('#raceBtn').onclick = async () => {
    const rows = []; const bad = [];
    for (const line of $('#raceCsv').value.split('\n').map(l => l.trim()).filter(Boolean)) {
      const [name, category = '', dt] = line.split(';').map(s => s.trim());
      const d = dt ? new Date(dt.replace(' ', 'T')) : null;
      if (!name || !d || isNaN(d)) { bad.push(line); continue; }
      rows.push({ name, category, start_at: d.toISOString() });
    }
    if (bad.length) return toast('Ligne invalide : ' + bad[0], 'error');
    if (!rows.length) return toast('Rien à importer.', 'error');
    const { error } = await sb.from('races').upsert(rows, { onConflict: 'name,start_at', ignoreDuplicates: true });
    if (error) return toast(error.message, 'error');
    toast(`${rows.length} course(s) importée(s).`, 'ok'); pageAdmin();
  };

  /* ----- Import des coureurs (création ou mise à jour, en une seule requête) ----- */
  $('#riderBtn').onclick = async () => {
    const report = $('#riderReport');
    report.innerHTML = '';
    const { rows, errors } = parseRidersText($('#riderCsv').value);
    if (errors.length) {
      report.innerHTML = `<div class="panel" style="margin:.8rem 0 0"><b class="error">${errors.length} ligne(s) invalide(s) : rien n'a été importé.</b>
        <ul>${errors.slice(0, 20).map(e => `<li>Ligne ${e.n} : ${esc(e.error)}</li>`).join('')}</ul>
        ${errors.length > 20 ? `<p class="muted" style="margin:.4rem 0 0">… et ${errors.length - 20} autre(s).</p>` : ''}</div>`;
      return toast('Corrige les lignes invalides avant d\'importer.', 'error');
    }
    if (!rows.length) return toast('Rien à importer.', 'error');

    /* Un même coureur répété dans le texte : la dernière ligne l'emporte.
       Un coureur déjà au catalogue (nom comparé sans accents ni majuscules) garde son nom actuel. */
    const existing = new Map(riders.map(r => [nameKey(r.name), r]));
    const unique = new Map();
    rows.forEach(r => unique.set(nameKey(r.name), r));
    let created = 0, updated = 0;
    const payload = [...unique.entries()].map(([k, r]) => {
      const ex = existing.get(k);
      if (ex) { updated++; return { ...r, name: ex.name }; }
      created++;
      return r;
    });

    if (!await confirmBox(`Importer ${created} nouveau(x) coureur(s) et mettre à jour ${updated} coureur(s) existant(s) ?`, 'Importer')) return;
    const { error } = await sb.from('riders').upsert(payload, { onConflict: 'name' });
    if (error) return toast(error.message, 'error');
    $('#riderCsv').value = '';
    report.innerHTML = `<p class="muted" style="margin:.8rem 0 0">Import terminé : ${created} créé(s), ${updated} mis à jour.</p>`;
    toast(`${created} créé(s), ${updated} mis à jour.`, 'ok');
    await reloadRiders();
  };

  /* ----- Actualité ----- */
  $('#newsBtn').onclick = async () => {
    const t = $('#nt').value.trim(); if (!t) return toast('Ajoute un titre.', 'error');
    const r = await rpc('post_news', { p_title: t, p_body: $('#nb').value.trim() });
    if (r.ok) { toast('Actualité publiée.', 'ok'); $('#nt').value = ''; $('#nb').value = ''; }
  };
}

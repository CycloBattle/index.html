'use strict';
/* =====================================================================
   Vélocards : front-end (JS pur, aucun outil de build)
   Toute la logique sensible (boosters, achats, points) est dans les
   fonctions SQL de supabase/schema.sql. Ici on ne fait qu'afficher.
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

/* ---------- Petits outils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const coin = n => `${Number(n).toLocaleString('fr-FR')} 🪙`;
const fmtDate = d => new Date(d).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const flag = cc => (cc && cc.length === 2)
  ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '🏁';
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
const state = { uid: null, user: null, profile: null, unread: 0 };
let app; // conteneur <main>

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
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

/* ---------- Composant carte ---------- */
function cardHTML(r, o = {}) {
  return `<div class="card r-${r.rarity} ${o.cls || ''}" ${o.attrs || ''}>
    <span class="bib">${String(r.id).padStart(3, '0')}</span>
    ${o.count > 1 ? `<span class="count">×${o.count}</span>` : ''}
    <div class="art"><span class="flag">${flag(r.country)}</span><span class="mono">${esc(initials(r.name))}</span>${riderImg(r)}</div>
    <div class="meta"><strong class="nm">${esc(r.name)}</strong><span class="sp">${esc(r.specialty)}</span><span class="rar">${RARITY[r.rarity].label}</span></div>
  </div>`;
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

/* Grille de collection avec filtres (utilisée par « Collection » et « Profil ») */
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
      ? list.map(g => `<div class="card-wrap">${cardHTML(g.rider, { count: g.cards.length })}</div>`).join('')
      : `<p class="muted">Aucune carte ne correspond.</p>`;
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
  ['boosters', 'Boosters'], ['collection', 'Collection'], ['equipe', 'Équipe'],
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
}

async function refreshProfile() {
  state.profile = await q(sb.from('profiles').select('*').eq('id', state.uid).single());
  const { count } = await sb.from('messages').select('id', { count: 'exact', head: true }).gt('created_at', state.profile.last_seen_messages);
  state.unread = count || 0;
  updateChrome();
}

const ROUTES = {
  boosters: pageBoosters, collection: pageCollection, equipe: pageTeam, transferts: pageTransfers,
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
  if (!uid) { state.profile = null; app = null; renderAuth(); return; }
  try {
    await refreshProfile();
    renderShell();
    route();
  } catch (e) {
    $('#root').innerHTML = `<div class="auth"><div class="auth-box"><h2>Profil introuvable</h2><p class="error">${esc(e.message)}</p><p class="muted">Vérifie que schema.sql a bien été exécuté dans Supabase.</p></div></div>`;
  }
}
sb.auth.onAuthStateChange((_evt, session) => setTimeout(() => handleSession(session), 0));

/* =====================================================================
   PAGE : BOOSTERS
   ===================================================================== */
async function pageBoosters() {
  app.innerHTML = `<h1>Boosters</h1>
    <p class="lead">Chaque booster contient 5 cartes. Tu gagnes des pièces en alignant des coureurs qui marquent des points dans les vraies courses.</p>
    <div class="boosters">${Object.entries(BOOSTERS).map(([k, b]) => `
      <article class="pack pack-${k}">
        <div class="foil"><span>${b.name}</span><img src="img/boosters/${k}.png" alt="" onload="this.parentElement.classList.add('has-img')" onerror="this.remove()"></div>
        <p>${b.odds}</p>
        <button class="btn primary" data-open="${k}">Ouvrir pour ${coin(b.price)}</button>
      </article>`).join('')}</div>`;
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
        <div class="face front">${cardHTML({ id: c.rider_id, name: c.name, country: c.country, specialty: c.specialty, rarity: c.rarity })}</div></div>
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
   PAGE : COLLECTION
   ===================================================================== */
async function pageCollection() {
  const [cards, all] = await Promise.all([myCards(), q(sb.from('riders').select('id'))]);
  const groups = groupByRider(cards);
  app.innerHTML = `<h1>Ma collection</h1>
    <p class="lead">${groups.length} coureurs différents sur ${all.length} au catalogue, ${cards.length} cartes au total.</p>
    <div id="col"></div>`;
  if (!cards.length) {
    $('#col').innerHTML = `<div class="panel"><p>Ta vitrine est vide. <a href="#/boosters"><b>Ouvre ton premier booster</b></a> pour commencer.</p></div>`;
    return;
  }
  mountCollection($('#col'), cards);
}

/* =====================================================================
   PAGE : ÉQUIPE (courses d'un jour)
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
   ===================================================================== */
async function pageMessages() {
  const [msgs, offers] = await Promise.all([
    q(sb.from('messages').select('*').order('created_at', { ascending: false }).limit(60)),
    q(sb.from('offers').select('id,amount,buyer_id,created_at,listings(id,price,seller_id,status,user_cards(riders(*)))').eq('status', 'pending').order('created_at', { ascending: false })),
  ]);
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

  app.innerHTML = `<h1>Messagerie</h1>
    <h2>Offres reçues</h2>${received.length ? received.map(o => offerRow(o, false)).join('') : '<p class="muted">Aucune offre en attente.</p>'}
    ${sent.length ? `<h2 style="margin-top:1.5rem">Mes offres envoyées</h2>${sent.map(o => offerRow(o, true)).join('')}` : ''}
    <h2 style="margin-top:1.5rem">Notifications</h2>
    ${msgs.length ? msgs.map(m => `<div class="msg ${m.kind} ${+new Date(m.created_at) > seenAt ? 'new' : ''}">
      <b>${esc(m.title)}</b> <time>${fmtDate(m.created_at)}</time><br>${esc(m.body)}</div>`).join('') : '<p class="muted">Aucun message.</p>'}`;

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
   PAGE : ADMIN
   ===================================================================== */
const RARITY_ALIAS = { commune: 'common', common: 'common', rare: 'rare', ultra: 'ultra', 'ultra rare': 'ultra', legendaire: 'legendary', 'légendaire': 'legendary', legendary: 'legendary', mythique: 'mythic', mythic: 'mythic', vintage: 'mythic' };

async function pageAdmin() {
  if (!state.profile.is_admin) { app.innerHTML = '<p class="error">Accès réservé.</p>'; return; }
  const [races, riders] = await Promise.all([
    q(sb.from('races').select('*').eq('status', 'upcoming').order('start_at')),
    q(sb.from('riders').select('id,name').order('name')),
  ]);
  const byName = new Map(riders.map(r => [r.name.toLowerCase(), r.id]));
  app.innerHTML = `<h1>Administration</h1>

    <div class="panel"><h2>Valider les résultats d'une course</h2>
      <p class="muted">Choisis la course, saisis le top ${MAX_POSITION} réel (les coureurs doivent exister au catalogue ; seuls les ${MAX_POSITION} premiers rapportent des points), puis valide. Les points et pièces sont distribués immédiatement à tous les joueurs qui avaient aligné une équipe. Action définitive.</p>
      <label>Course<select id="vr">${races.length ? races.map(r => `<option value="${r.id}">${esc(r.name)} (${fmtDate(r.start_at)})</option>`).join('') : '<option value="">Aucune course à venir</option>'}</select></label>
      <datalist id="dl">${riders.map(r => `<option value="${esc(r.name)}">`).join('')}</datalist>
      <div class="results-grid" style="margin:1rem 0">${Array.from({ length: MAX_POSITION }, (_, i) => `<label>${i + 1}<input list="dl" data-pos="${i + 1}" placeholder="Coureur"></label>`).join('')}</div>
      <button class="btn primary" id="vBtn">Valider et distribuer les gains</button></div>

    <div class="panel"><h2>Ajouter des courses</h2>
      <p class="muted">Une course par ligne, format : <code>Nom;Catégorie;AAAA-MM-JJ HH:MM</code> (heure de départ de ton fuseau). Copie les courses du calendrier L'Équipe puis mets-les à ce format.</p>
      <textarea id="raceCsv" placeholder="Il Lombardia;WorldTour;2026-10-10 10:30"></textarea>
      <p><button class="btn" id="raceBtn">Importer les courses</button></p></div>

    <div class="panel"><h2>Ajouter des coureurs</h2>
      <p class="muted">Un coureur par ligne : <code>Nom;PAYS;spécialité;rareté</code>. Spécialités : ${SPECIALTIES.join(', ')}. Raretés : commune, rare, ultra, légendaire, mythique.</p>
      <textarea id="riderCsv" placeholder="Tadej Pogačar;SI;complet;légendaire"></textarea>
      <p><button class="btn" id="riderBtn">Importer les coureurs</button></p></div>

    <div class="panel"><h2>Publier une actualité</h2>
      <div class="row"><input id="nt" placeholder="Titre" class="grow"></div>
      <textarea id="nb" placeholder="Message pour tous les joueurs" style="margin-top:.6rem"></textarea>
      <p><button class="btn" id="newsBtn">Publier</button></p></div>

    <div class="panel"><h2>Visuels des coureurs</h2>
      <p class="muted">Pour chaque coureur, envoie sur GitHub une photo dans le dossier <code>img/riders/</code> avec exactement le nom de fichier indiqué (.jpg, .png ou .webp). Le mot « manquant » disparaît quand la photo est trouvée.</p>
      <div class="table-wrap"><table><thead><tr><th>Coureur</th><th>Nom du fichier</th><th>Aperçu</th></tr></thead><tbody>
      ${riders.map(r => { const sl = slug(r.name); return `<tr><td>${esc(r.name)}</td><td><code>${sl}.jpg</code></td><td><span class="muted">manquant</span><img class="thumb" src="img/riders/${sl}.jpg" alt="" data-slug="${sl}" data-i="0" onload="this.previousElementSibling.hidden=true" onerror="imgFallback(this)"></td></tr>`; }).join('')}
      </tbody></table></div></div>`;

  $('#vBtn').onclick = async () => {
    const raceId = +$('#vr').value;
    if (!raceId) return toast('Aucune course sélectionnée.', 'error');
    const results = [], unknown = [], seen = new Set();
    for (const inp of $$('[data-pos]')) {
      const name = inp.value.trim(); if (!name) continue;
      const id = byName.get(name.toLowerCase());
      if (!id) { unknown.push(name); continue; }
      if (seen.has(id)) return toast(`${name} apparaît deux fois.`, 'error');
      seen.add(id); results.push({ pos: +inp.dataset.pos, rider_id: id });
    }
    if (unknown.length) return toast('Coureur(s) inconnu(s) : ' + unknown.join(', ') + '. Ajoute-les d\'abord au catalogue.', 'error');
    if (!results.length) return toast('Saisis au moins un résultat.', 'error');
    if (!await confirmBox(`Valider définitivement ${results.length} résultat(s) et distribuer les gains ?`, 'Valider')) return;
    const r = await rpc('validate_race', { p_race_id: raceId, p_results: results });
    if (r.ok) { toast('Course validée, gains distribués.', 'ok'); pageAdmin(); }
  };

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

  $('#riderBtn').onclick = async () => {
    const rows = []; const bad = [];
    for (const line of $('#riderCsv').value.split('\n').map(l => l.trim()).filter(Boolean)) {
      const [name, country = '', specialty = 'complet', rar = ''] = line.split(';').map(s => s.trim());
      const rarity = RARITY_ALIAS[rar.toLowerCase()];
      const sp = SPECIALTIES.includes(specialty.toLowerCase()) ? specialty.toLowerCase() : null;
      if (!name || !rarity || !sp) { bad.push(line); continue; }
      rows.push({ name, country: country.toUpperCase().slice(0, 2), specialty: sp, rarity });
    }
    if (bad.length) return toast('Ligne invalide : ' + bad[0], 'error');
    if (!rows.length) return toast('Rien à importer.', 'error');
    const { error } = await sb.from('riders').upsert(rows, { onConflict: 'name', ignoreDuplicates: true });
    if (error) return toast(error.message, 'error');
    toast(`${rows.length} coureur(s) importé(s).`, 'ok'); pageAdmin();
  };

  $('#newsBtn').onclick = async () => {
    const t = $('#nt').value.trim(); if (!t) return toast('Ajoute un titre.', 'error');
    const r = await rpc('post_news', { p_title: t, p_body: $('#nb').value.trim() });
    if (r.ok) { toast('Actualité publiée.', 'ok'); $('#nt').value = ''; $('#nb').value = ''; }
  };
}

// PinFilmBoard — импорт фильмов из Pinterest-доски «фильмы-для-просмотра» в data/db.js.
// Usage: node tools/import-pinterest.mjs [--dry] [--commit]
// Для каждого пина: ссылка -> резолвер (js/movies.js); если ссылка не парсится —
// фильм ищется в Википедии по названию пина. Дедуп: стабильный id t-pin<pinId> + URL по всем доскам.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// undici без этого падает в ConnectTimeout на pinterest/wikimedia (IPv6-маршрут)
dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PIN_USER = 'mmitekk';
const DEFAULT_BOARD = 'фильмы-для-просмотра';
const TARGET_BOARD_NAME = 'Фильмы';
const PAGE_SIZE = 25;
const DELAY_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// даты пинов приходят в RFC-формате («Wed, 26 Aug 2026…») — приводим к ISO,
// иначе сортировка «Сначала новые» сравнивает строки разных форматов
const isoDate = (d) => { const ts = Date.parse(d); return isNaN(ts) ? new Date().toISOString() : new Date(ts).toISOString(); };

// ---------- js/movies.js (браузерный файл, эмулируем window) ----------
globalThis.window = {};
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'movies.js'), 'utf8'));
const M = globalThis.window.__PFB_MOVIES;

// ---------- cookie jar ----------
function makeJar() {
  const jar = new Map();
  return {
    absorb(res) {
      for (const line of res.headers.getSetCookie?.() || []) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    get(k) { return jar.get(k) || ''; },
  };
}

function extractScript(html, id) {
  const marker = `<script id="${id}" type="application/json">`;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const from = start + marker.length;
  const end = html.indexOf('</script>', from);
  if (end === -1) return null;
  try { return JSON.parse(html.slice(from, end)); } catch { return null; }
}

// ---------- скрейпинг доски ----------
async function scrapeBoard(slug) {
  const boardUrl = `/${PIN_USER}/${slug}/`;
  const jar = makeJar();
  let pageRes = null;
  for (let attempt = 0; attempt < 4 && !pageRes; attempt++) {
    try {
      pageRes = await fetch('https://ru.pinterest.com' + encodeURI(boardUrl), {
        headers: { 'user-agent': UA, accept: 'text/html' },
      });
    } catch (e) {
      console.log(`  страница: ${e.cause?.code || e.message}, retry ${3 * (attempt + 1)}s`);
      await sleep(3000 * (attempt + 1));
    }
  }
  if (!pageRes) throw new Error('страница доски недоступна после ретраев');
  jar.absorb(pageRes);
  const html = await pageRes.text();
  const pws = extractScript(html, '__PWS_DATA__') || {};
  const appVersion = pws.appVersion || '';
  const csrf = jar.get('csrftoken');

  let boardId = '';
  const m = html.match(/board_id[^0-9]{0,6}(\d{6,})/) || html.match(/board_id=(\d{6,})/);
  boardId = m ? m[1] : '';

  const pins = new Map();
  let bookmarks = [];
  let pages = 0;
  while (true) {
    const dataObj = { options: { board_id: boardId, board_url: boardUrl, page_size: PAGE_SIZE, bookmarks }, context: {} };
    const url = 'https://www.pinterest.com/resource/BoardFeedResource/get/?source_url=' + encodeURIComponent(encodeURI(boardUrl)) +
      '&data=' + encodeURIComponent(JSON.stringify(dataObj));
    let json = null;
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            accept: 'application/json, text/javascript, */*, q=0.01',
            cookie: jar.header(),
            'user-agent': UA,
            'x-app-version': appVersion,
            'x-csrf-token': csrf,
            'x-pinterest-appstate': 'active',
            'x-pinterest-pws-handler': 'www/board/[username]/[slug].js',
            'x-pinterest-source-url': encodeURI(boardUrl),
            'x-requested-with': 'XMLHttpRequest',
            referer: 'https://ru.pinterest.com' + encodeURI(boardUrl),
          },
        });
        jar.absorb(res);
        if (res.status === 429 || res.status === 403 || res.status === 401) {
          console.log(`  http ${res.status}, retry ${3 * (attempt + 1)}s`);
          await sleep(3000 * (attempt + 1));
          continue;
        }
        json = await res.json();
        ok = true;
      } catch (e) {
        console.log(`  fetch error: ${e.message}, retry`);
        await sleep(2500);
      }
    }
    if (!ok) throw new Error('BoardFeedResource недоступен после ретраев');

    const arr = json?.resource_response?.data || [];
    for (const raw of arr) {
      if (raw && raw.type === 'pin' && raw.id && !pins.has(String(raw.id))) {
        pins.set(String(raw.id), {
          id: String(raw.id),
          title: raw.grid_title || raw.title || '',
          description: raw.description || '',
          link: raw.link || null,
          domain: raw.domain || null,
          created: raw.created_at || null,
          img: raw.images?.['474x']?.url || raw.images?.orig?.url || raw.images?.['236x']?.url || null,
        });
      }
    }
    pages++;
    const next = json?.resource?.options?.bookmarks || [];
    const end = !next.length || next[0] === '-end-';
    console.log(`  страница ${pages}: пинов ${pins.size}`);
    if (end || arr.length === 0) break;
    bookmarks = next;
    await sleep(DELAY_MS);
  }
  return [...pins.values()];
}

// ---------- main ----------
const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const commit = argv.includes('--commit');
const boardSlugIdx = argv.indexOf('--board');
const BOARD_SLUG = boardSlugIdx > -1 ? argv[boardSlugIdx + 1] : DEFAULT_BOARD;

const dataFile = path.join(ROOT, 'data', 'db.js');
const src = fs.readFileSync(dataFile, 'utf8');
// присваивание идёт в начале строки (в комментарии-шапке тоже упоминается — не путать)
const assignMatch = src.match(/^window\.__PFB_DATA\s*=\s*/m);
if (!assignMatch) throw new Error('data/db.js: не найдено присваивание window.__PFB_DATA');
const assignAt = assignMatch.index;
const db = JSON.parse(src.slice(src.indexOf('{', assignAt)).trim().replace(/;\s*$/, ''));

// глобальный дедуп URL по всем доскам
const globalUrls = new Set();
for (const b of db.boards || []) for (const t of b.tiles || []) globalUrls.add(t.url);

const target = (db.boards || []).find((b) => b.name === TARGET_BOARD_NAME) || (db.boards || [])[0];
if (!target) throw new Error('в data/db.js нет досок');
const col = (target.columns || [])[0];
if (!col) throw new Error('у доски «' + target.name + '» нет колонок');
console.log(`цель: доска «${target.name}», колонка «${col.name}» (${col.id})`);

console.log(`скрейп pinterest.com/${PIN_USER}/${BOARD_SLUG} ...`);
const pins = await scrapeBoard(BOARD_SLUG);
console.log(`всего пинов: ${pins.length}`);

const existingIds = new Set((target.tiles || []).map((t) => t.id));
const existingTitles = new Set((target.tiles || []).map((t) => String(t.title || '').toLowerCase().trim()));
let added = 0;
let enriched = 0;
const skipped = [];

// чистка названий пинов: мусор от сайтов-источников
function cleanPinTitle(t) {
  return String(t || '')
    .replace(/\s*⭐[\s\S]*$/, '')                                  // imdb-скриншоты: "… ⭐ 7.9 | Drama"
    .replace(/^\s*(смотрите|смотреть)\s+онлайн\s+(фильм|сериал|мультфильм)?\s*[«"']?/i, '')
    .replace(/\s*[»"']?\s*(в онлайн-кино\w*|смотреть онлайн|онлайн)?\s*[–-]\s*(на\s+)?(Иви|ivi|Okko|Кинопоиск|Кинопоиске)\s*!?\s*$/i, '')
    .replace(/\s*[–-]\s*смот\s*ре?ть?\s*онлайн[\s\S]*$/i, '')
    .replace(/\s*[–-]\s*на\s+(Иви|ivi)\s*!?\s*$/i, '')
    .trim();
}

for (const p of pins) {
  const tileId = 't-pin' + p.id;
  if (existingIds.has(tileId)) { console.log(`  уже есть: pin ${p.id}`); continue; }

  const info = p.link ? M.parse(p.link) : null;
  const known = info && info.provider !== 'other';

  let title = '', poster = null, description = '', year = 0, resolvedVia = '';

  // 1) резолвер по ссылке (IMDb через Wikidata, Okko/Википедия через поиск); при сбое — повтор
  if (known) {
    for (let attempt = 0; attempt < 2 && !title; attempt++) {
      try {
        const meta = await M.resolve(p.link);
        if (meta && meta.title) {
          title = meta.title;
          poster = meta.poster || null;
          description = meta.description || '';
          year = meta.year || 0;
          resolvedVia = 'ссылка (' + info.provider + ')';
        } else if (meta && meta.error && attempt === 0) {
          await sleep(2000); // похоже на лимит WDQS — подождём и повторим
        }
      } catch (e) { /* фолбэк ниже */ }
      if (!title && attempt === 0) await sleep(DELAY_MS);
    }
  }

  // 2) фолбэк: Википедия по очищенному названию пина
  const pinTitle = cleanPinTitle(p.title);
  if (!title && pinTitle) {
    try {
      const wiki = await M.enrichByTitle(pinTitle);
      if (wiki && wiki.title) {
        title = wiki.title;
        poster = poster || wiki.poster || null;
        description = description || wiki.description || '';
        year = year || wiki.year || 0;
        resolvedVia = 'википедия по названию пина';
        enriched++;
      }
    } catch (e) { /* игнор */ }
    await sleep(DELAY_MS);
  }

  // 3) всё ещё пусто — берём очищенное название пина
  if (!title) title = pinTitle || (p.description || '').slice(0, 80).trim();
  if (!description) description = (p.description || '').trim();
  // imdb-скриншоты как обложка не годятся — оставляем плейсхолдер
  const imgOk = p.img && !/⭐/.test(p.title || '');
  if (!poster && imgOk) poster = p.img;
  if (!title) {
    skipped.push({ pin: p.id, reason: 'ни ссылки, ни названия' });
    console.log(`  ? pin ${p.id}: пропущен (нет названия)`);
    continue;
  }

  const url = p.link || 'https://ru.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
  const provider = known ? info.provider : (p.link ? (info ? info.provider : 'other') : 'wikipedia');

  const normTitle = title.toLowerCase().trim();
  if (existingTitles.has(normTitle)) {
    skipped.push({ pin: p.id, reason: 'дубль названия «' + title.slice(0, 40) + '»' });
    console.log(`  дубль названия: pin ${p.id} -> «${title.slice(0, 40)}»`);
    continue;
  }

  if (globalUrls.has(url)) {
    skipped.push({ pin: p.id, reason: 'дубль URL' });
    console.log(`  дубль URL: pin ${p.id} -> ${url.slice(0, 60)}`);
    continue;
  }
  globalUrls.add(url);
  existingTitles.add(normTitle);

  target.tiles = (target.tiles || []).concat([{
    id: tileId,
    columnId: col.id,
    url,
    provider,
    title,
    poster,
    description,
    year,
    tags: ['pinterest'],
    note: '',
      addedAt: isoDate(p.created),
  }]);
  existingIds.add(tileId);
  added++;
  console.log(`  + «${title.slice(0, 50)}» [${provider}${year ? ' ' + year : ''}] via ${resolvedVia || 'данные пина'}`);
}

console.log(`итого: +${added} фильмов (обогащено через Википедию: ${enriched}), пропусков ${skipped.length}`);
for (const s of skipped) console.log(`  - ${s.pin}: ${s.reason}`);
if (dry) { console.log('--dry: data/db.js не изменён'); process.exit(0); }
if (!added) { console.log('изменений нет'); process.exit(0); }

db.updatedAt = new Date().toISOString();
fs.writeFileSync(dataFile, 'window.__PFB_DATA = ' + JSON.stringify(db, null, 2) + ';\n');
console.log('data/db.js записан');

if (commit) {
  try {
    execSync('git add data', { cwd: ROOT });
    execSync(`git commit -m "PinFilmBoard: доска «${target.name}»: импорт ${added} фильмов из pinterest.com/${PIN_USER}/${BOARD_SLUG}"`, { cwd: ROOT });
    console.log('закоммичено локально (push — за вами)');
  } catch (e) { console.log('коммит не сделан: ' + (e.message || e)); }
}

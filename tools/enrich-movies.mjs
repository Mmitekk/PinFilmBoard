// PinFilmBoard — автозаполнение карточек: описания и обложки из Википедии.
// Usage: node tools/enrich-movies.mjs [--dry] [--commit] [--all]
// По умолчанию обрабатываются плитки без описания или без обложки (--all — принудительно все).
// Правила: заполняются только пустые поля; год-несовпадение (>1 года) = промах; латинское
// название заменяется на русское из Википедии.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// undici без ipv4first падает в ConnectTimeout на wikimedia/pinterest
dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DELAY_MS = 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.window = {};
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'movies.js'), 'utf8'));
const M = globalThis.window.__PFB_MOVIES;

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const commit = argv.includes('--commit');
const all = argv.includes('--all');

// ---------- чистка названий ----------
function cleanTitle(t) {
  var s = String(t || '');
  s = s.replace(/\s*⭐[\s\S]*$/, '');                                   // imdb-скриншоты: "… ⭐ 7.9 | Drama"
  s = s.replace(/^\s*(смотрите|смотреть)\s+онлайн\s+(фильм|сериал|мультфильм)?\s*[«"']?/i, '');
  s = s.replace(/\s*[»"']?\s*(в онлайн-кинотеатре?|в онлайн-кино)\s*!?\s*$/i, '');
  s = s.replace(/\s*[–-]\s*(на\s+)?(Иви|ivi|Okko|Кинопоиск|Кинопоиске)\s*!?\s*$/i, '');
  s = s.replace(/\s*[–-]\s*смотреть\s+(плейлист|онлайн)[\s\S]*$/i, '');
  s = s.replace(/\s*–\s*смотреть\s+плейлист[\s\S]*$/i, '');
  s = s.replace(/\s*:\s*рейтинг и даты[\s\S]*$/i, '');
  s = s.replace(/\s*-\s*\d\s*сезон\s*\/[\s\S]*$/, '');                  // «Игра смерти - 1 сезон / …»
  s = s.replace(/^\s*(сериал|фильм)\s+/i, '');
  return s.replace(/\s+/g, ' ').trim();
}

// вариант запроса без скобок и лет (для поиска)
function looseQuery(t) {
  return cleanTitle(t).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function quotedFromDescription(desc) {
  var m = String(desc || '').match(/[«""]([^»""]{2,60})[»""]/);
  return m ? m[1].trim() : null;
}

function isLatin(s) {
  return /^[^А-Яа-яЁё]*$/.test(String(s || ''));
}

// ---------- main ----------
const dataFile = path.join(ROOT, 'data', 'db.js');
const src = fs.readFileSync(dataFile, 'utf8');
const assignMatch = src.match(/^window\.__PFB_DATA\s*=\s*/m);
if (!assignMatch) throw new Error('data/db.js: не найдено присваивание window.__PFB_DATA');
const db = JSON.parse(src.slice(src.indexOf('{', assignMatch.index)).trim().replace(/;\s*$/, ''));

let touched = 0;
let filled = 0;
let misses = [];

for (const b of db.boards || []) {
  for (const t of b.tiles || []) {
    const needDesc = !t.description || t.description.trim() === t.title.trim();
    const needPoster = !t.poster;
    if (!all && !needDesc && !needPoster) continue;
    touched++;

    // кандидаты запроса: резолвер по ссылке (с ретраями — WDQS душит очереди) -> цитата из описания -> чистое название -> без скобок -> до двоеточия
    let urlMeta = null;
    const info = t.url ? M.parse(t.url) : null;
    if (info && (info.provider === 'imdb' || info.provider === 'kinopoisk')) {
      for (let attempt = 0; attempt < 3 && !urlMeta; attempt++) {
        try {
          const meta = await M.resolve(t.url);
          if (meta && meta.resolved && meta.title) urlMeta = meta;
        } catch (e) { /* повтор */ }
        if (!urlMeta && attempt < 2) await sleep(2000 + 2000 * attempt);
      }
      if (urlMeta && t.year && urlMeta.year && Math.abs(t.year - urlMeta.year) > 1) urlMeta = null;
    }

    const candidates = [];
    const quoted = quotedFromDescription(t.description);
    if (quoted && quoted.toLowerCase() !== String(t.title || '').toLowerCase()) candidates.push(quoted);
    const c1 = cleanTitle(t.title);
    if (c1) candidates.push(c1);
    const c2 = looseQuery(t.title);
    if (c2 && c2.toLowerCase() !== (c1 || '').toLowerCase()) candidates.push(c2);
    const c3 = cleanTitle(t.title).split(/[:–-]/)[0].trim();
    if (c3 && c3.length > 2 && !candidates.includes(c3)) candidates.push(c3);

    let applied = null;
    if (urlMeta && urlMeta.title) {
      applied = { query: 'resolve (' + info.provider + ')', s: urlMeta };
    }
    for (const query of candidates) {
      if (!query || query.length < 2) continue;
      let s = null;
      try { s = await M.enrichByTitle(query); } catch (e) { s = null; }
      await sleep(DELAY_MS);
      if (!s || !s.title) continue;
      // промах по году? (известный год фильма и найденный расходятся >1)
      if (t.year && s.year && Math.abs(t.year - s.year) > 1) continue;
      applied = { query, s };
      break;
    }

    if (!applied) {
      misses.push({ title: t.title, url: t.url });
      console.log(`  ? «${String(t.title).slice(0, 50)}» — не найдено в Википедии`);
      continue;
    }

    const { s } = applied;
    let changed = [];
    if (needDesc && s.description) {
      t.description = s.description;
      changed.push('описание');
    }
    if (needPoster && s.poster) {
      t.poster = s.poster;
      changed.push('обложка');
    }
    if (!t.year && s.year) { t.year = s.year; changed.push('год'); }
    // латинское название заменяем на русское из Википедии
    if (isLatin(t.title) && /[А-Яа-яЁё]/.test(s.title || '')) {
      t.title = s.title;
      changed.push('название→RU');
    } else if (!s.description && !s.poster) {
      // промах без пользы
    }
    filled++;
    console.log(`  + «${t.title.slice(0, 45)}»: ${changed.join(', ') || 'без изменений'} (via «${applied.query.slice(0, 40)}»)`);
  }
}

console.log(`итого: просмотрено ${touched}, заполнено ${filled}, промахов ${misses.length}`);
for (const m of misses) console.log(`  - ${String(m.title).slice(0, 60)} | ${m.url.slice(0, 60)}`);
if (dry) { console.log('--dry: data/db.js не изменён'); process.exit(0); }
if (!filled) { console.log('изменений нет'); process.exit(0); }

db.updatedAt = new Date().toISOString();
fs.writeFileSync(dataFile, 'window.__PFB_DATA = ' + JSON.stringify(db, null, 2) + ';\n');
console.log('data/db.js записан');

if (commit) {
  try {
    execSync('git add data', { cwd: ROOT });
    execSync(`git commit -m "PinFilmBoard: автозаполнение описаний и обложек из Википедии (${filled} карточек)"`, { cwd: ROOT });
    console.log('закоммичено локально (push — за вами)');
  } catch (e) { console.log('коммит не сделан: ' + (e.message || e)); }
}

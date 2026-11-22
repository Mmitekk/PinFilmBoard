// PinFilmBoard — тест парсера ссылок (js/movies.js).
// Запуск: node tools/test-movies.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = {};
(0, eval)(readFileSync(path.join(__dirname, '..', 'js', 'movies.js'), 'utf8'));
const M = globalThis.window.__PFB_MOVIES;

let failed = 0;
function check(name, url, expected) {
  const got = M.parse(url);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`FAIL ${name}\n  url:  ${url}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

check('kinopoisk', 'https://www.kinopoisk.ru/film/326/',
  { provider: 'kinopoisk', id: '326', url: 'https://www.kinopoisk.ru/film/326/' });
check('kinopoisk + params', 'https://www.kinopoisk.ru/film/326/?utm_referrer=organic.kinopoisk.ru',
  { provider: 'kinopoisk', id: '326', url: 'https://www.kinopoisk.ru/film/326/?utm_referrer=organic.kinopoisk.ru' });
check('kinopoisk без схемы', 'kinopoisk.ru/film/522506/',
  { provider: 'kinopoisk', id: '522506', url: 'https://kinopoisk.ru/film/522506/' });

check('imdb', 'https://www.imdb.com/title/tt0111161/',
  { provider: 'imdb', id: 'tt0111161', url: 'https://www.imdb.com/title/tt0111161/' });
check('imdb с хвостом', 'https://www.imdb.com/title/tt0111161/?ref_=nv_sr_1',
  { provider: 'imdb', id: 'tt0111161', url: 'https://www.imdb.com/title/tt0111161/?ref_=nv_sr_1' });
check('imdb mobile', 'https://m.imdb.com/title/tt1375666/',
  { provider: 'imdb', id: 'tt1375666', url: 'https://m.imdb.com/title/tt1375666/' });

check('okko', 'https://okko.tv/movie/interstellar',
  { provider: 'okko', id: 'interstellar', url: 'https://okko.tv/movie/interstellar' });
check('okko сериальный slug', 'https://okko.tv/movie/the-dark-knight',
  { provider: 'okko', id: 'the-dark-knight', url: 'https://okko.tv/movie/the-dark-knight' });

check('wikipedia ru', 'https://ru.wikipedia.org/wiki/%D0%9F%D0%BE%D0%B1%D0%B5%D0%B3_%D0%B8%D0%B7_%D0%A8%D0%BE%D1%83%D1%88%D0%B5%D0%BD%D0%BA%D0%B0',
  { provider: 'wikipedia', id: 'Побег из Шоушенка', lang: 'ru', url: 'https://ru.wikipedia.org/wiki/%D0%9F%D0%BE%D0%B1%D0%B5%D0%B3_%D0%B8%D0%B7_%D0%A8%D0%BE%D1%83%D1%88%D0%B5%D0%BD%D0%BA%D0%B0' });
check('wikipedia en + anchor', 'https://en.wikipedia.org/wiki/Interstellar_(film)#Plot',
  { provider: 'wikipedia', id: 'Interstellar (film)', lang: 'en', url: 'https://en.wikipedia.org/wiki/Interstellar_(film)#Plot' });

check('other', 'https://okko.tv/serial/the-last-of-us',
  { provider: 'other', id: null, url: 'https://okko.tv/serial/the-last-of-us' });
check('other 2', 'https://example.org/page', { provider: 'other', id: null, url: 'https://example.org/page' });

check('rutube плейлист', 'https://rutube.ru/plst/1655721/',
  { provider: 'rutube', kind: 'plst', id: '1655721', url: 'https://rutube.ru/plst/1655721/' });
check('fandom ru', 'https://violet-evergarden.fandom.com/ru/wiki/%D0%92%D0%B0%D0%B9iolet_%D0%AD%D0%B2%D0%B5%D1%80%D0%B3%D0%B0%D1%80%D0%B4%D0%B5%D0%BD',
  { provider: 'fandom', id: 'Вайiolet Эвергарден', sub: 'violet-evergarden', lang: 'ru', url: 'https://violet-evergarden.fandom.com/ru/wiki/%D0%92%D0%B0%D0%B9iolet_%D0%AD%D0%B2%D0%B5%D1%80%D0%B3%D0%B0%D1%80%D0%B4%D0%B5%D0%BD' });
check('fandom en', 'https://naruto.fandom.com/wiki/Naruto_Uzumaki?so=search',
  { provider: 'fandom', id: 'Naruto Uzumaki', sub: 'naruto', lang: 'en', url: 'https://naruto.fandom.com/wiki/Naruto_Uzumaki?so=search' });

if (M.yearFromText('фильм 1994 года') !== 1994) { failed++; console.log('FAIL yearFromText'); }
if (M.upgradeThumb('https://thumb.wikimedia.org/wikipedia/ru/thumb/d/de/x.jpg/330px-x.jpg') !== 'https://thumb.wikimedia.org/wikipedia/ru/thumb/d/de/x.jpg/480px-x.jpg') { failed++; console.log('FAIL upgradeThumb'); }
if (M.providerLabel('kinopoisk') !== 'Кинопоиск') { failed++; console.log('FAIL providerLabel'); }
if (!failed) console.log('ok   yearFromText / upgradeThumb / providerLabel');

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nвсе проверки пройдены');

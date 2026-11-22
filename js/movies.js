/* PinFilmBoard — разбор ссылок на фильмы и получение метаданных (Wikidata SPARQL + Wikipedia REST) */
(function () {
  'use strict';

  var PROVIDER_LABEL = {
    kinopoisk: 'Кинопоиск',
    imdb: 'IMDb',
    okko: 'Okko',
    rutube: 'Rutube',
    fandom: 'Fandom',
    wikipedia: 'Википедия',
    other: 'Другое'
  };

  // ---------- утилиты ----------

  function fetchJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error('timeout')); }
      }, timeoutMs || 10000);
      // Wikimedia требует осмысленный User-Agent (в браузере заголовок запрещён и игнорируется,
      // в node — применяется; без него WDQS отвечает 403)
      fetch(url, {
        credentials: 'omit',
        headers: { 'User-Agent': 'PinFilmBoard/1.0 (github.com/Mmitekk/PinFilmBoard; personal watchlist)' }
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (json) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(json); }
      }).catch(function (err) {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });
    });
  }

  function withScheme(url) {
    url = (url || '').trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
    return url;
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function yearFromText(text) {
    var m = String(text || '').match(/\b(18|19|20)\d{2}\b/);
    return m ? parseInt(m[0], 10) : 0;
  }

  // постеры Википедии: миниатюру можно запросить любой ширины (…/330px-… → …/480px-…)
  function upgradeThumb(src, width) {
    if (!src) return src;
    return String(src).replace(/\/(\d+)px-/, '/' + (width || 480) + 'px-');
  }

  // ---------- парсеры провайдеров ----------

  function parseKinopoisk(u) {
    var m = u.match(/^https?:\/\/(?:www\.)?kinopoisk\.ru\/film\/(\d{2,})(?:[\/?#]|$)/i);
    return m ? m[1] : null;
  }

  function parseImdb(u) {
    var m = u.match(/^https?:\/\/(?:www\.|m\.)?imdb\.com\/title\/(tt\d{5,})/i);
    return m ? m[1] : null;
  }

  function parseOkko(u) {
    var m = u.match(/^https?:\/\/(?:www\.)?okko\.tv\/movie\/([a-z0-9-]+)/i);
    return m ? m[1] : null;
  }

  function parseWikipedia(u) {
    var m = u.match(/^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^?#\/]+)/i);
    if (!m) return null;
    return { lang: m[1].toLowerCase(), title: safeDecode(m[2]).replace(/_/g, ' ') };
  }

  // плейлисты Rutube: rutube.ru/plst/<id>/
  function parseRutubePlst(u) {
    var m = u.match(/^https?:\/\/rutube\.ru\/plst\/(\d{3,})/i);
    return m ? m[1] : null;
  }

  // вики Fandom: <sub>.fandom.com/<lang>/wiki/<Название> (lang может отсутствовать = en)
  function parseFandom(u) {
    var m = u.match(/^https?:\/\/([a-z0-9-]+)\.fandom\.com\/(?:([a-z-]{2,5})\/)?wiki\/([^?#\/]+)/i);
    if (!m) return null;
    var sub = m[1].toLowerCase();
    if (sub === 'www' || sub === 'community') return null;
    return { sub: sub, lang: m[2] ? m[2].toLowerCase() : 'en', title: safeDecode(m[3]).replace(/_/g, ' ') };
  }

  // parse(url) -> { provider, id, url, lang?, kind? }
  function parse(url) {
    var u = withScheme(url);
    if (!u) return null;
    var id;
    if ((id = parseKinopoisk(u))) return { provider: 'kinopoisk', id: id, url: u };
    if ((id = parseImdb(u))) return { provider: 'imdb', id: id, url: u };
    if ((id = parseOkko(u))) return { provider: 'okko', id: id, url: u };
    if ((id = parseRutubePlst(u))) return { provider: 'rutube', kind: 'plst', id: id, url: u };
    var wiki = parseWikipedia(u);
    if (wiki) return { provider: 'wikipedia', id: wiki.title, lang: wiki.lang, url: u };
    var fd = parseFandom(u);
    if (fd) return { provider: 'fandom', id: fd.title, sub: fd.sub, lang: fd.lang, url: u };
    return { provider: 'other', id: null, url: u };
  }

  // ---------- Wikidata ----------

  var WDQS = 'https://query.wikidata.org/sparql?format=json&query=';

  // SPARQL: возвращает список id сущностей (Q…)
  function sparqlEntities(query) {
    return fetchJSON(WDQS + encodeURIComponent(query), 15000).then(function (j) {
      var b = (j && j.results && j.results.bindings) || [];
      return b.map(function (x) {
        return x.item && x.item.value ? String(x.item.value).split('/').pop() : null;
      }).filter(Boolean);
    });
  }

  // описание сущности: ru-название, ru-описание, название статьи ru.wikipedia
  function entityInfo(entityId) {
    var url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' + entityId +
      '&props=labels|descriptions|sitelinks&languages=ru&sitefilter=ruwiki&format=json&origin=*';
    return fetchJSON(url, 12000).then(function (j) {
      var e = j && j.entities && j.entities[entityId];
      if (!e) return null;
      return {
        title: (e.labels && e.labels.ru && e.labels.ru.value) || '',
        description: (e.descriptions && e.descriptions.ru && e.descriptions.ru.value) || '',
        wikiTitle: (e.sitelinks && e.sitelinks.ruwiki && e.sitelinks.ruwiki.title) || ''
      };
    });
  }

  // ---------- Wikipedia ----------

  function wikiSummary(lang, title) {
    var url = 'https://' + lang + '.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(String(title).replace(/ /g, '_'));
    return fetchJSON(url, 12000).then(function (j) {
      if (!j || !j.title) return null;
      // миниатюру оставляем в исходном размере (запрос другой ширины может дать 404), utm-хвост режем
      var poster = j.thumbnail ? j.thumbnail.source.replace(/\?.*$/, '') : null;
      return {
        title: j.title,
        description: j.extract || '',
        poster: poster,
        year: yearFromText(j.extract || j.description || '')
      };
    });
  }

  // поиск статьи: возвращает название первой статьи
  function wikiSearch(lang, query) {
    var url = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
      encodeURIComponent(query) + '&srlimit=3&format=json&origin=*';
    return fetchJSON(url, 12000).then(function (j) {
      var hits = (j && j.query && j.query.search) || [];
      return hits.length ? hits[0].title : null;
    });
  }

  // en-статья → её ru-аналог (langlinks)
  function enTitleToRu(enTitle) {
    var url = 'https://en.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(enTitle) +
      '&prop=langlinks&lllang=ru&format=json&origin=*';
    return fetchJSON(url, 12000).then(function (j) {
      var pages = (j && j.query && j.query.pages) || {};
      for (var k in pages) {
        var ll = pages[k].langlinks || [];
        return ll.length ? ll[0]['*'] : null;
      }
      return null;
    });
  }

  // сводка по запросу: ru-поиск → (fallback) en-поиск → langlinks → ru-сводка
  function summaryByQuery(query) {
    return wikiSearch('ru', query).then(function (ruTitle) {
      if (ruTitle) return wikiSummary('ru', ruTitle);
      return wikiSearch('en', query).then(function (enTitle) {
        if (!enTitle) return null;
        return enTitleToRu(enTitle).then(function (ruTitle2) {
          return ruTitle2 ? wikiSummary('ru', ruTitle2) : wikiSummary('en', enTitle);
        });
      });
    });
  }

  // «Найти в Википедии» по введённому названию.
  // Пробуем деградирующие варианты запроса: как есть → без скобок → без латиницы
  // («Вайiolet Эвергарден» → «Вай Эвергарден») → без кириллицы (для en-поиска).
  function enrichByTitle(title) {
    title = String(title || '').trim();
    if (!title) return Promise.resolve(null);
    var queries = [title];
    var noParen = title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (noParen && queries.indexOf(noParen) < 0) queries.push(noParen);
    var noLatin = title.replace(/[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
    if (noLatin.length >= 4 && queries.indexOf(noLatin) < 0) queries.push(noLatin);
    var noCyr = title.replace(/[А-Яа-яЁё]/g, '').replace(/\s+/g, ' ').trim();
    if (noCyr.length >= 4 && queries.indexOf(noCyr) < 0) queries.push(noCyr);

    function attempt(i) {
      if (i >= queries.length) return Promise.resolve(null);
      return summaryByQuery(queries[i]).then(function (s) {
        if (s) {
          s.provider = 'wikipedia';
          s.id = s.title;
          s.url = 'https://ru.wikipedia.org/wiki/' + encodeURIComponent(String(s.title).replace(/ /g, '_'));
          if (!s.year) s.year = yearFromText(s.description);
          return s;
        }
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  // ---------- resolve(url) ----------
  // -> { title, poster, description, year, provider, id, url, lang?, resolved, reason? }
  function resolve(url) {
    var info = parse(url);
    if (!info) return Promise.resolve(null);

    function base(extra) {
      return Object.assign({ title: '', poster: null, description: '', year: 0, provider: info.provider, id: info.id, url: info.url, resolved: false }, extra || {});
    }
    function finish(s) {
      var out = base({
        title: s.title || '',
        poster: s.poster || null,
        description: s.description || '',
        year: s.year || 0,
        resolved: !!s.title
      });
      return out;
    }

    // imdb / kinopoisk: SPARQL по внешнему id → сущность → ru-сводка Википедии
    function viaWikidata(prop) {
      return sparqlEntities('SELECT ?item WHERE { ?item wdt:' + prop + ' "' + info.id + '" } LIMIT 2')
        .then(function (ids) {
          if (!ids.length) return null;
          return entityInfo(ids[0]);
        })
        .then(function (ei) {
          if (!ei) return null;
          if (ei.wikiTitle) return wikiSummary('ru', ei.wikiTitle).then(function (s) {
            return s || { title: ei.title, description: ei.description, poster: null, year: yearFromText(ei.description) };
          });
          return { title: ei.title, description: ei.description, poster: null, year: yearFromText(ei.description) };
        });
    }

    // плейлист Rutube: у страницы нет og-метатегов и API — берём <title> (в браузере
    // fetch заблокирует CORS — тогда честный отказ) и ищем фильм в Википедии
    function rutubePlstTitle(id) {
      return fetch('https://rutube.ru/plst/' + id + '/', { credentials: 'omit', headers: { 'User-Agent': 'PinFilmBoard/1.0 (github.com/Mmitekk/PinFilmBoard)' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (h) {
          var m = h.match(/<title>([^<]*)<\/title>/i);
          if (!m) return null;
          var t = safeDecode(m[1]);
          t = t.split(' | ')[0];
          t = t.replace(/\s*[–-]\s*смотреть\s+плейлист[\s\S]*$/i, '');
          t = t.replace(/\s*-\s*все\s+серии\s*$/i, '');
          return t.trim() || null;
        })
        .catch(function () { return null; });
    }

    // вики Fandom: MediaWiki api.php на том же домене (CORS с origin=*), затем Википедия
    function fandomPageTitle(info) {
      var base = 'https://' + info.sub + '.fandom.com/' + (info.lang !== 'en' ? info.lang + '/' : '') + 'api.php';
      var url = base + '?action=query&titles=' + encodeURIComponent(info.id) + '&redirects=1&format=json&origin=*';
      return fetchJSON(url, 12000).then(function (j) {
        var pages = (j && j.query && j.query.pages) || {};
        for (var k in pages) return pages[k].title || null;
        return null;
      }).catch(function () { return null; });
    }

    var chain;
    if (info.provider === 'imdb') {
      chain = viaWikidata('P345');
    } else if (info.provider === 'kinopoisk') {
      chain = viaWikidata('P1713');
    } else if (info.provider === 'okko') {
      var query = String(info.id).replace(/[-_]+/g, ' ').trim();
      chain = summaryByQuery(query);
    } else if (info.provider === 'wikipedia') {
      chain = wikiSummary(info.lang || 'ru', info.id);
    } else if (info.provider === 'rutube' && info.kind === 'plst') {
      chain = rutubePlstTitle(info.id).then(function (title) {
        if (!title) return null;
        return enrichByTitle(title).then(function (s) {
          return s || { title: title, description: '', poster: null, year: 0 };
        });
      });
    } else if (info.provider === 'fandom') {
      chain = fandomPageTitle(info).then(function (title) {
        if (!title) return { title: info.id, description: '', poster: null, year: 0 };
        return enrichByTitle(title).then(function (s) {
          return s || { title: title, description: '', poster: null, year: 0 };
        });
      });
    } else {
      // незнакомый сайт: не выдумываем запросы — пользователь введёт название сам
      chain = Promise.resolve(null);
    }

    return chain
      .then(function (s) { return finish(s || {}); })
      .catch(function (err) { return base({ error: String((err && err.message) || err) }); });
  }

  function providerLabel(p) { return PROVIDER_LABEL[p] || PROVIDER_LABEL.other; }

  window.__PFB_MOVIES = {
    parse: parse,
    resolve: resolve,
    enrichByTitle: enrichByTitle,
    providerLabel: providerLabel,
    yearFromText: yearFromText,
    upgradeThumb: upgradeThumb,
    summaryByQuery: summaryByQuery,
    wikiSearch: wikiSearch,
    wikiSummary: wikiSummary
  };
})();

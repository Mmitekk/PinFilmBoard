/* PinFilmBoard — разбор ссылок на фильмы и получение метаданных (Wikidata SPARQL + Wikipedia REST) */
(function () {
  'use strict';

  var PROVIDER_LABEL = {
    kinopoisk: 'Кинопоиск',
    imdb: 'IMDb',
    okko: 'Okko',
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

  // parse(url) -> { provider, id, url, lang? }
  function parse(url) {
    var u = withScheme(url);
    if (!u) return null;
    var id;
    if ((id = parseKinopoisk(u))) return { provider: 'kinopoisk', id: id, url: u };
    if ((id = parseImdb(u))) return { provider: 'imdb', id: id, url: u };
    if ((id = parseOkko(u))) return { provider: 'okko', id: id, url: u };
    var wiki = parseWikipedia(u);
    if (wiki) return { provider: 'wikipedia', id: wiki.title, lang: wiki.lang, url: u };
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

  // «Найти в Википедии» по введённому названию
  function enrichByTitle(title) {
    title = String(title || '').trim();
    if (!title) return Promise.resolve(null);
    return summaryByQuery(title).then(function (s) {
      if (!s) return null;
      s.provider = 'wikipedia';
      s.id = s.title;
      s.url = 'https://ru.wikipedia.org/wiki/' + encodeURIComponent(String(s.title).replace(/ /g, '_'));
      if (!s.year) s.year = yearFromText(s.description);
      return s;
    });
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
    } else {
      // незнакомый сайт: пробуем последний сегмент пути как запрос
      var seg = safeDecode(info.url.replace(/^https?:\/\/[^\/]+\//, '').split(/[?#]/)[0].split('/')[0])
        .replace(/[-_]+/g, ' ').replace(/\.\w{2,4}$/, '').trim();
      chain = seg ? summaryByQuery(seg) : Promise.resolve(null);
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

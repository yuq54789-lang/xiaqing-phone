/* =====================================================================
 * 我的小手机 —— 单文件版
 * 结构：① 数据库  ② 提示词拼接  ③ 调用模型（含流式）  ④ 记忆  ⑤ 界面
 * 数据格式见 myphone-format-v1.md
 * ===================================================================== */

/* ---------- ① 数据库（原生 IndexedDB，无需外部库） ---------- */
var DB_NAME = 'myphone', DB_VER = 4, db = null;
var STORES = {
  characters: { keyPath: 'id' },
  messages: { keyPath: 'id', index: [['byChar', ['characterId', 'ts', 'id']]] },
  memories: { keyPath: 'id', index: [['byChar', 'characterId']] },
  thoughts: { autoIncrement: true },
  worldBooks: { keyPath: 'id' },
  worldBookCategories: { keyPath: 'id' },
  userPersonas: { keyPath: 'id' },
  offlinePresets: { keyPath: 'id' },   /* 线下模式写作预设 */
  beautyPresets: { keyPath: 'id' },    /* 美化预设 */
  miniPresets: { keyPath: 'id' },      /* 小预设：字体 / 提示音 / 美化 CSS / 气泡 CSS，每项单独存 */
  stickers: { keyPath: 'id' },
  stickerCategories: { keyPath: 'id' },
  settings: { keyPath: 'key' }
};

function openDB() {
  return new Promise(function (res, rej) {
    var req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = function () {
      var d = req.result;
      Object.keys(STORES).forEach(function (name) {
        if (d.objectStoreNames.contains(name)) return;   /* 老用户升级：只补新增的仓库，不动已有数据 */
        var def = STORES[name];
        var os = d.createObjectStore(name, def.keyPath ? { keyPath: def.keyPath } : { autoIncrement: true });
        (def.index || []).forEach(function (ix) { os.createIndex(ix[0], ix[1]); });
      });
    };
    req.onsuccess = function () { db = req.result; res(db); };
    req.onerror = function () { rej(req.error); };
  });
}
function reqP(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
function dbGet(store, key) { return reqP(db.transaction(store).objectStore(store).get(key)); }
function dbAll(store) { return reqP(db.transaction(store).objectStore(store).getAll()); }
function dbPut(store, val) { return reqP(db.transaction(store, 'readwrite').objectStore(store).put(val)); }
function dbDel(store, key) { return reqP(db.transaction(store, 'readwrite').objectStore(store).delete(key)); }
function dbClear(store) { return reqP(db.transaction(store, 'readwrite').objectStore(store).clear()); }
function dbBulkPut(store, arr) {
  return new Promise(function (res, rej) {
    if (!arr || !arr.length) return res();
    var tx = db.transaction(store, 'readwrite'), os = tx.objectStore(store);
    for (var i = 0; i < arr.length; i++) os.put(arr[i]);
    tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; tx.onabort = function () { rej(tx.error); };
  });
}
function dbAllWithKeys(store) {
  return new Promise(function (res, rej) {
    var out = [], cur = db.transaction(store).objectStore(store).openCursor();
    cur.onsuccess = function () { var c = cur.result; if (c) { out.push({ key: c.primaryKey, value: c.value }); c.continue(); } else res(out); };
    cur.onerror = function () { rej(cur.error); };
  });
}
function dbByIndex(store, index, key) { return reqP(db.transaction(store).objectStore(store).index(index).getAll(key)); }

/* 取某角色的一页消息（从新到旧，返回时已按时间正序）。before = {ts,id} 表示取比它更早的 */
function pageMessages(cid, before, limit) {
  return new Promise(function (res, rej) {
    var idx = db.transaction('messages').objectStore('messages').index('byChar');
    var upper = before ? [cid, before.ts, before.id] : [cid, Infinity, '￿'];
    var range = IDBKeyRange.bound([cid, -Infinity, ''], upper, false, !!before);
    var out = [], cur = idx.openCursor(range, 'prev');
    cur.onsuccess = function () {
      var c = cur.result;
      if (c && out.length < limit) { out.push(c.value); c.continue(); }
      else res(out.reverse());
    };
    cur.onerror = function () { rej(cur.error); };
  });
}
function countMessagesAfter(cid, ts) {
  return new Promise(function (res, rej) {
    var idx = db.transaction('messages').objectStore('messages').index('byChar');
    var r = reqP(idx.count(IDBKeyRange.bound([cid, ts, '￿'], [cid, Infinity, '￿'], true, false)));
    r.then(res, rej);
  });
}

/* ---------- 设置 ---------- */
/* 系统提示词里的「回复要求」：内置在代码里，不在界面上显示 */
var OUTPUT_RULES = '像真人在手机上聊天一样回复：口语化，简短自然。\n把回复拆成几条短消息，每条消息单独一行（最多 6 条）。\n想引用用户说过的某句话来回复时，在那条消息开头写 [引用：用户原话片段]，后面接你的回复，同一行；偶尔用就好。\n不要在开头写你的名字，不要写旁白、括号动作或解释，除非角色设定要求这样。\n始终保持角色设定，不要承认自己是 AI。';
/* 线下模式：面对面的小说式叙述，不拆气泡、不发表情包 */
var OFFLINE_RULES = '现在是线下场景，你和用户面对面相处，不再是手机聊天。\n用小说式的叙述回复：用第三人称写角色的动作、神态、环境，对白用「」括起来，连贯地写成一段或几段文字。\n篇幅 {{MIN}} 到 {{MAX}} 字，一次写完，不要拆成多条消息，不要发表情包，不要用你的名字做开头。\n只写角色自己的言行和感受，不要替用户说话、替用户做动作。\n始终保持角色设定，不要承认自己是 AI。';
/* 线下模式的完整规则 = 内置规则（字数按角色设置填） + 你选的预设（文风/格式要求） */
function offlineRules(c, preset) {
  var w = (c && c.offlineWords) || {}, mn = Number(w.min) > 0 ? Math.round(w.min) : 200, mx = Number(w.max) > 0 ? Math.round(w.max) : 600;
  if (mn > mx) { var t = mn; mn = mx; mx = t; }
  var out = OFFLINE_RULES.replace('{{MIN}}', mn).replace('{{MAX}}', mx);
  if (preset && preset.content && String(preset.content).trim()) out += '\n\n# 线下写作预设（文风、格式的额外要求，请遵守）\n' + String(preset.content).trim();
  return out;
}
/* 心声并入回复：不另外请求，让模型在同一次回复末尾顺带写 */
var THOUGHT_RULES = '写完回复正文后，另起一行，写下你此刻的内心，严格按下面格式，只写一次，放在整个回复的最末尾：\n<心声>{"heartfeltVoice":"…","randomJottings":"…"}</心声>\nheartfeltVoice：一句话，你心里没有说出口的真实想法，不超过 40 字；randomJottings：一小段随笔，像日记或碎碎念，记录此刻的心情或刚发生的小事，不超过 120 字。语气必须符合角色设定。这一段只给用户在「心声」页看，不是聊天内容，正文里不要提到它。';
var DEFAULTS = {
  baseUrl: '', apiKey: '', model: '', temperature: 0.8,
  stream: false, themeId: 'default', customCss: '', homeBg: '', fontUrl: '', fontData: '', fontName: '',
  secBaseUrl: '', secApiKey: '', secModel: '',
  scanDepth: 5, worldBookMaxChars: 6000, memoryLimit: 20, summaryMax: 200, defaultContext: 30, stickerPromptLimit: 60, autoReply: false, apiPresets: [], activePresetId: null, weather: null, homeLayout: null,
  bubbleSlow: 1,                 /* 气泡出现速度倍数：1=默认，越大越慢 */
  notifyUrl: '', notifyName: '', /* 消息提示音（网址 / 上传的文件名） */
  iconUrls: {},                  /* 自定义桌面图标：{ 应用名: 图片网址或 data URI } */
  asrLang: 'zh-CN',              /* 语音识别语言 */
  showTime: true,                /* 每条气泡下面显示时间（几点几分） */
  sysNotify: false,              /* 页面在后台时发系统通知（需要浏览器允许） */
  voiceSend: 'audio'             /* 发语音给 AI 的方式：audio=直接发音频（Gemini 等能听的模型）；text=只发文字+语气提示 */
};
var settings = Object.assign({}, DEFAULTS);
var notifyFile = '';   /* 上传的提示音文件（data URI，单独存） */
var homeBgFile = '';   /* 上传的桌面壁纸原图（单独存，不压缩） */
async function loadSettings() {
  var row = await dbGet('settings', 'app');
  settings = Object.assign({}, DEFAULTS, row ? row.value : {});
}
function saveSettings() { return dbPut('settings', { key: 'app', value: settings }); }

/* ---------- ② 提示词拼接 ---------- */
function uid(prefix) { return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* 世界书：扫描最近的文字，命中关键词的条目才放进提示词；没有关键词的条目=常驻 */
function triggeredEntries(books, texts, maxChars) {
  var hay = texts.join('\n').toLowerCase(), out = [], total = 0;
  books.forEach(function (b) {
    (b.entries || []).forEach(function (e) {
      if (e.enabled === false || !e.content) return;
      var keys = (e.keys || []).filter(Boolean);
      var hit = keys.length === 0 || keys.some(function (k) { return hay.indexOf(String(k).toLowerCase()) !== -1; });
      if (!hit) return;
      if (total + e.content.length > maxChars) return;
      total += e.content.length;
      out.push({ book: b.name, title: e.title, content: e.content, always: keys.length === 0 });
    });
  });
  return out;
}

/* 记忆：最新一条精炼 + 它之后的自动总结 + 所有手动记忆，最多 limit 条 */
function pickMemories(mems, limit) {
  var refined = null;
  mems.forEach(function (m) { if (m.kind === 'refined' && (!refined || m.ts > refined.ts)) refined = m; });
  var rest = mems.filter(function (m) {
    if (m.kind === 'refined') return false;
    if (m.kind === 'note') return true;
    return !refined || m.ts > refined.ts;
  }).sort(function (a, b) { return a.ts - b.ts; });
  rest = rest.slice(-limit);
  return (refined ? [refined] : []).concat(rest);
}

/* 三层记忆：①常驻（core）每次都带 ②最近 N 条记忆（滑动窗口）每次都带 ③更早的历史记忆库——用当前聊天里的关键词在本地匹配，匹配到才带入 */
var STOPCH = '的了是我你他她它在有和就不也都吗吧呢啊嗯哦这那一个什么么着过到说要会可以还很';
var COMMON_BI = ['今天','明天','昨天','觉得','知道','时候','现在','已经','因为','所以','但是','如果','可是','还是','没有','自己','真的','感觉','一下','一起','出来','起来','东西','怎么','然后','应该','可能','不会','我们','你们','他们','她们','开始','不过','其实','比较','一点','有点','今晚','晚上','早上','最近'];
function memTokens(text) {
  var set = {}, t = String(text || '').toLowerCase();
  (t.match(/[\u4e00-\u9fff]+/g) || []).forEach(function (run) {
    for (var i = 0; i < run.length - 1; i++) {
      var a = run.charAt(i), b = run.charAt(i + 1);
      if (STOPCH.indexOf(a) >= 0 || STOPCH.indexOf(b) >= 0 || COMMON_BI.indexOf(a + b) >= 0) continue;
      set[a + b] = 1;
    }
  });
  (t.match(/[a-z0-9]{3,}/g) || []).forEach(function (w) { set[w] = 2; });
  return set;
}
function selectMemories(mems, queryTexts, windowSize, matchLimit) {
  var byTs = function (a, b) { return a.ts - b.ts; };
  var core = mems.filter(function (m) { return m.core; }).sort(byTs);
  var rest = mems.filter(function (m) { return !m.core; }).sort(byTs);
  var n = windowSize > 0 ? windowSize : 20;
  var recent = rest.slice(-n), older = rest.slice(0, Math.max(0, rest.length - n));      /* 第二层：最近 N 条记忆；第三层：更早的历史记忆库 */
  var q = memTokens((queryTexts || []).join('\n')), keys = Object.keys(q), scored = [];
  older.forEach(function (m) {
    var c = String(m.content || '').toLowerCase(), sc = 0;
    keys.forEach(function (k) { if (c.indexOf(k) >= 0) sc += q[k]; });
    if (sc >= 1) scored.push({ m: m, s: sc });
  });
  scored.sort(function (a, b) { return b.s - a.s || b.m.ts - a.m.ts; });
  var matched = scored.slice(0, matchLimit || 8).map(function (x) { return x.m; }).sort(byTs);
  return { core: core, recent: recent, matched: matched, all: core.concat(matched, recent) };
}

function fmtTime(ts, tz) {
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false, timeZone: tz || undefined }); }
  catch (e) { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); }
}

function buildSystem(ctx) {
  var c = ctx.char, s = ctx.settings, L = [];
  L.push('你正在扮演「' + (c.realName || c.name) + '」，' + (c.offlineMode ? '和用户面对面相处。' : '通过手机和用户聊天。'));
  if (c.persona) L.push('# 角色设定\n' + c.persona);
  var me = [];
  if (c.userNickname) me.push('你称呼用户为：' + c.userNickname);
  if (c.userPersona) me.push(c.userPersona);
  if (me.length) L.push('# 用户\n' + me.join('\n'));
  if (ctx.entries.length) {
    L.push('# 世界书（当前相关的设定）\n' + ctx.entries.map(function (e) {
      return '【' + (e.title || e.book) + '】\n' + e.content;
    }).join('\n\n'));
  }
  if (ctx.memories.length) {
    L.push('# 长期记忆（你们之前发生的事，按时间从早到晚）\n' + ctx.memories.map(function (m) { return '- ' + m.content; }).join('\n'));
  }
  if (!c.offlineMode && ctx.stickers && ctx.stickers.length) {
    L.push('# 可发送的表情包\n想发表情包时，单独占一行，写成 [表情包：名称]，名称必须从下面选一个，不要自己编：\n' +
      ctx.stickers.map(function (st) { return st.name; }).join('、'));
  }
  if (ctx.thought) {
    L.push('# 你此刻的内心（只有你自己知道，不要直接念出来，但要让言行和它保持一致）\n心声：' + ctx.thought.heartfeltVoice + (ctx.thought.randomJottings ? '\n散记：' + ctx.thought.randomJottings : ''));
  }
  L.push('# 当前时间\n' + fmtTime(ctx.now, c.timeZone));
  L.push('# 回复要求\n' + (c.offlineMode ? offlineRules(c, ctx.preset) : OUTPUT_RULES));
  if (ctx.wantThought) L.push('# 心声（附加输出）\n' + THOUGHT_RULES);
  if (ctx.changes) L.push('# 消息的变动\n用户有时会撤回、删除或编辑消息。方括号里的「[用户撤回了一条消息。撤回前的内容：…]」「[用户删除了…]」和消息后面的「（…原文是…）」就是你看到的变动，你确实知道原来写了什么。像真人一样自然地反应（好奇、调侃、装作没看见都行，看角色性格），不要机械复述这些提示，也不要每次都点破。');
  if (c.aiVoice && !c.offlineMode) L.push('# 发语音\n想发语音消息时，把那一条单独写成一行：[语音：说的话]。方括号里就是语音里说的原话（口语、带语气词），会自动显示成文字，不用再重复。偶尔用，适合轻声说话、撒娇、叹气、情绪起伏的时候；每次回复最多 1 条。');
  if (ctx.dictate) L.push('# 听写（必须）\n用户发来的 ' + ctx.dictate + ' 条语音还没有文字。请在回复的最最开头，按语音出现的顺序，每条语音写一段 <听写>用户语音里说的原话</听写>（逐字写，不翻译、不润色；完全听不清就写 听不清）。写完标签再正常回复；标签里的字不要在正文里重复，标签本身用户看不到。');
  if (ctx.voice === 'audio') L.push('# 语音消息\n用户的语音会直接以音频发给你（标着「[用户发来一条语音…]」的那条）：请真的去听——语气、情绪、语速、停顿、背景声音，再自然地回应。不要念出「语气」「音频」这类词，也不要复述括号里的提示。历史里更早的语音只剩文字。听不清就坦白说没听清。');
  else if (ctx.voice) L.push('# 语音消息\n用户发来的「[语音 N秒，语气：…] 文字」是语音消息：方括号里是时长和语气提示（根据音量、语速、停顿粗略估计的，仅供参考），后面才是说的内容。请结合语气和内容自然回应，不要把方括号里的提示原样复述。如果写着「没有转成文字」，就说你没听清，让对方再说一遍或打字。');
  return L.join('\n\n');
}

/* 表情包：从角色选中的分类里挑出可用的；太多时随机抽 limit 个，避免提示词过长 */
function stickerPool(stickers, categoryIds) {
  if (categoryIds == null) return stickers.slice();
  if (!categoryIds.length) return [];
  var set = {}; categoryIds.forEach(function (id) { set[String(id)] = true; });
  return stickers.filter(function (s) { return set[String(s.categoryId)]; });
}
function sampleStickers(pool, limit) {
  var a = pool.filter(function (s) { return s.name; }).slice();
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a.slice(0, limit);
}
function findSticker(pool, name) {
  var n = String(name).trim();
  return pool.find(function (s) { return s.name === n; }) ||
    pool.find(function (s) { return s.name && (s.name.indexOf(n) !== -1 || n.indexOf(s.name) !== -1); }) || null;
}
/* 模型回复的每一行 -> 消息草稿（文字或表情包） */
function estSpeakSecs(t) { var n = String(t || '').replace(/\s/g, '').length; return Math.max(1, Math.round(n / 4.5)); }
function parseReplyLines(lines, pool, voiceOn) {
  var out = [];
  lines.forEach(function (ln) {
    var m = ln.match(/^[\[【]\s*表情包?\s*[:：]\s*(.+?)\s*[\]】]$/);
    if (m) {
      var st = findSticker(pool, m[1]);
      if (st) out.push({ type: 'sticker', content: st.url, meta: { meaning: st.name } });
      return; // 找不到对应表情包就丢掉这一行
    }
    var vo = voiceOn && ln.match(/^[\[【]\s*语音\s*[:：]\s*([\s\S]+?)\s*[\]】]$/);
    if (vo) { out.push({ type: 'voice', content: vo[1], meta: { tts: true, duration: estSpeakSecs(vo[1]) } }); return; }
    var q = ln.match(/^[\[【]\s*引用\s*[:：]\s*(.+?)\s*[\]】]\s*([\s\S]*)$/);
    if (q && q[2]) { out.push({ type: 'text', content: q[2], meta: { quote: { content: q[1] } } }); return; }
    out.push({ type: 'text', content: ln });
  });
  return out;
}

/* 一条历史消息 -> 给模型看的文字 */
/* 消息被用户编辑过：让角色知道原话是什么 */
function msgToText(m) {
  var t = msgToTextBase(m), ed = m.meta && m.meta.edited;
  if (ed && ed.from != null && t) t += (m.role === 'assistant' ? '（这句是你之前说的，被用户改成了现在这样；你原来写的是「' : '（用户事后编辑过这条消息；原文是「') + String(ed.from).slice(0, 80) + '」）';
  return t;
}
function msgToTextBase(m) {
  var t = m.type || 'text', meta = m.meta || {}, c = m.content || '';
  if (t === 'sticker') return '[表情包：' + (meta.meaning || '无描述') + ']';
  if (t === 'image') return '[用户发送了一张图片]';   /* 历史里的图片一律变成这行文字：省 token，也不占算力 */
  if (t === 'transfer') return '[转账 ' + (meta.amount != null ? '¥' + meta.amount : '') + (meta.note ? '，备注：' + meta.note : '') + ']';
  if (t === 'voice') {
    if (m.role === 'user' && meta.audio) {   /* 用户发的语音：时长 + 语气提示 + 转出来的文字 */
      var vd = (meta.duration ? meta.duration + '秒' : ''), vt = meta.tone ? '，语气：' + meta.tone : '';
      return c ? '[语音 ' + vd + vt + '] ' + c : '[语音 ' + vd + '，没有转成文字，听不清内容]';
    }
    return '[语音] ' + c;
  }
  if (t === 'recalled') { var og = meta.orig && meta.orig.desc; return og ? '[用户撤回了一条消息。撤回前的内容：「' + String(og).slice(0, 200) + '」]' : '[用户撤回了一条消息]'; }
  if (t === 'pat' || t === 'system') return c.charAt(0) === '[' ? c : '[系统提示：' + c + ']';
  if (meta.quote && typeof meta.quote === 'object') {
    var q = meta.quote.content || meta.quote.text || '';
    if (q) return '（回复「' + String(q).slice(0, 60) + '」）' + c;
  }
  return c;
}

/* 历史 -> API 消息：system 当作 user 提示，连续同角色的合并成一条 */
function addAudio(item, mime, b64, secs) {
  if (typeof item.content === 'string') item.content = item.content ? [{ type: 'text', text: item.content }] : [];
  item.content.push({ type: 'text', text: '[用户发来一条语音，时长 ' + secs + ' 秒]' }, { type: 'audio_data', mime: mime, data: b64 });
}
function imgUsable(u) { return /^data:image\//.test(u || ''); }
function addText(item, text) {
  if (typeof item.content === 'string') { item.content = item.content ? item.content + '\n' + text : text; return; }
  var p = item.content[item.content.length - 1];
  if (p && p.type === 'text') p.text += '\n' + text; else item.content.push({ type: 'text', text: text });
}
function addImage(item, url) {
  if (typeof item.content === 'string') item.content = item.content ? [{ type: 'text', text: item.content }] : [];
  item.content.push({ type: 'text', text: '[用户发来一张图片]' }, { type: 'image_url', image_url: { url: url } });
}
/* 只有「还没被角色回复过」的那一轮里的图片才会真的发给模型；
 * 角色回复之后，这些图片在请求里自动变成文字「[用户发送了一张图片]」，聊天界面里图片照常显示。 */
function toApiMessages(history, opt) {
  opt = opt || {};
  var lastA = -1;
  history.forEach(function (m, i) { if (m.role === 'assistant' && !m.hidden && m.type !== 'pat' && m.type !== 'system') lastA = i; });
  var out = [];
  history.forEach(function (m, i) {
    var role = m.role === 'assistant' ? 'assistant' : 'user';
    var asImage = m.type === 'image' && role === 'user' && opt.images !== false && i > lastA && imgUsable(m.content);
    var wav = opt.wav && opt.wav[m.id], asAudio = !!(wav && role === 'user' && i > lastA);
    var text = (asImage || asAudio) ? '' : msgToText(m);
    if (!asImage && !asAudio && !text) return;
    var last = out[out.length - 1];
    if (!last || last.role !== role) { last = { role: role, content: '' }; out.push(last); }
    if (asImage) addImage(last, m.content); else if (asAudio) addAudio(last, 'audio/wav', wav, (m.meta && m.meta.duration) || 1); else addText(last, text);
  });
  return out;
}

/* 模型的回复 -> 多条气泡 */
function splitReply(text, max) {
  var lines = String(text || '').replace(/\r/g, '').split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (lines.length > max) lines = lines.slice(0, max - 1).concat([lines.slice(max - 1).join('\n')]);
  return lines;
}

/* ---------- ③ 调用模型 ---------- */
function isGemini(base) { return /generativelanguage\.googleapis\.com/.test(base || ''); }
function openaiUrl(base) {
  var b = String(base || '').trim().replace(/\/+$/, '');
  return /\/v1$/.test(b) ? b + '/chat/completions' : b + '/v1/chat/completions';
}
function modelsUrl(base) {
  var b = String(base || '').trim().replace(/\/+$/, '');
  return /\/v1$/.test(b) ? b + '/models' : b + '/v1/models';
}

async function httpError(res) {
  var msg = '', raw = '';
  try { raw = await res.clone().text(); } catch (e0) {}
  try {
    var j = await res.json();
    msg = (j && j.error && (j.error.message || j.error)) || JSON.stringify(j);
  } catch (e) { try { msg = await res.text(); } catch (e2) {} }
  var er = new Error('API 返回错误: ' + res.status + ' ' + res.statusText + (msg ? ' - ' + String(msg).slice(0, 400) : ''));
  er.status = res.status; er.statusText = res.statusText; er.raw = raw;
  return er;
}

async function readSSE(res, onData) {
  var reader = res.body.getReader(), dec = new TextDecoder('utf-8'), buf = '';
  while (true) {
    var r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    var lines = buf.split(/\r?\n/); buf = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (ln.indexOf('data:') !== 0) continue;
      var d = ln.slice(5).trim();
      if (!d) continue;
      if (d === '[DONE]') return;
      var o; try { o = JSON.parse(d); } catch (e) { continue; }
      onData(o);
    }
  }
  var tail = (buf + dec.decode()).trim();
  if (tail.indexOf('data:') === 0) { try { onData(JSON.parse(tail.slice(5))); } catch (e) {} }
}

/*
 * 统一调用入口。opts: {base,key,model,temperature,system,messages,stream,onDelta,signal}
 * 返回完整回复文字。流式时每收到一块就调用 onDelta(目前为止的全文)。
 */
function geminiParts(c) {
  if (typeof c === 'string') return [{ text: c }];
  return c.map(function (p) {
    if (p.type === 'image_url') {
      var m = /^data:([^;]+);base64,([\s\S]*)$/.exec((p.image_url && p.image_url.url) || '');
      return m ? { inlineData: { mimeType: m[1], data: m[2] } } : { text: '[图片]' };
    }
    if (p.type === 'audio_data') return { inlineData: { mimeType: p.mime, data: p.data } };
    return { text: p.text || '' };
  });
}
async function callLLM(o) {
  var gem = isGemini(o.base), url, headers = { 'Content-Type': 'application/json' }, body;
  if (!o.base || !o.model) throw new Error('请先在「设置」里填写反代地址和模型');
  if (gem) {
    var root = String(o.base).trim().replace(/\/+$/, '').replace(/\/v1(beta)?(\/models)?$/, '');
    url = root + '/v1beta/models/' + encodeURIComponent(o.model) + (o.stream ? ':streamGenerateContent?alt=sse&' : ':generateContent?') + 'key=' + encodeURIComponent(o.key || '');
    var contents = o.messages.map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m.content) }; });
    if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '（开始）' }] });
    body = { systemInstruction: { parts: [{ text: o.system }] }, contents: contents, generationConfig: { temperature: o.temperature } };
  } else {
    url = openaiUrl(o.base);
    headers.Authorization = 'Bearer ' + (o.key || '');
    var oaMsgs = o.messages.map(function (m) { return typeof m.content === 'string' ? m : { role: m.role, content: m.content.map(function (p) { return p.type === 'audio_data' ? { type: 'input_audio', input_audio: { data: p.data, format: (p.mime.split('/')[1] || 'wav') } } : p; }) }; });
    body = { model: o.model, messages: [{ role: 'system', content: o.system }].concat(oaMsgs), temperature: o.temperature, stream: !!o.stream };
  }

  var res;
  try {
    res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: o.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    var ne = new Error('网络请求失败: ' + e.message); ne.title = '网络请求失败'; ne.raw = e.message; throw ne;
  }
  if (!res.ok) throw await httpError(res);

  var ct = res.headers.get('content-type') || '';
  var text = '';
  try {
    if (o.stream && res.body && ct.indexOf('text/event-stream') !== -1) {
      await readSSE(res, function (j) {
        var piece = '';
        if (gem) {
          var ps = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
          (ps || []).forEach(function (p) { if (typeof p.text === 'string' && !p.thought) piece += p.text; });
        } else {
          if (j.error) { var se = new Error('API 返回错误: ' + (j.error.message || JSON.stringify(j.error))); se.raw = JSON.stringify(j); throw se; }
          var ch = j.choices && j.choices[0];
          if (ch && ch.delta && typeof ch.delta.content === 'string') piece = ch.delta.content;
        }
        if (piece) { text += piece; if (o.onDelta) o.onDelta(text); }
      });
    } else {
      var j = await res.json();
      if (gem) {
        var ps2 = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
        text = (ps2 || []).filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('');
      } else {
        text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      }
      if (o.onDelta && text) o.onDelta(text);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    if (/^API 返回错误/.test(e.message)) throw e;
    var ne2 = new Error('网络请求失败: ' + e.message); ne2.title = '网络请求失败'; ne2.raw = e.message; throw ne2;
  }
  if (!String(text).trim()) throw new Error('模型返回了空内容（可能被安全策略拦截，或模型名不对）');
  return text;
}

async function fetchModelList(base, key) {
  var res;
  try {
    if (isGemini(base)) {
      var root = String(base).trim().replace(/\/+$/, '').replace(/\/v1(beta)?(\/models)?$/, '');
      res = await fetch(root + '/v1beta/models?key=' + encodeURIComponent(key || ''));
    } else {
      res = await fetch(modelsUrl(base), { headers: { Authorization: 'Bearer ' + (key || '') } });
    }
  } catch (e) { throw new Error('网络请求失败: ' + e.message); }
  if (!res.ok) throw await httpError(res);
  var j = await res.json();
  if (j.models) return j.models.map(function (m) { return String(m.name).replace(/^models\//, ''); });
  return (j.data || []).map(function (m) { return m.id; });
}

/* ---------- ④ 记忆：自动总结 / 精炼 ---------- */
function transcript(msgs, char) {
  var me = char.userNickname || '用户', her = char.realName || char.name;
  return msgs.filter(function (m) { return m.type !== 'pat'; }).map(function (m) {
    return (m.role === 'assistant' ? her : me) + '：' + msgToText(m);
  }).join('\n');
}
function secondaryApi() {
  return {
    base: settings.secBaseUrl || settings.baseUrl,
    key: settings.secBaseUrl ? settings.secApiKey : settings.apiKey,
    model: settings.secModel || settings.model
  };
}
async function summarizeMessages(char, msgs) {
  var api = secondaryApi(), max = Number(settings.summaryMax) > 30 ? Number(settings.summaryMax) : 200;
  var system = '你是「' + (char.realName || char.name) + '」。请站在你自己的角度，用第一人称（“我”）把下面这段聊天记录总结成一条记忆。' +
    '保留关键事实、约定、情绪变化和称呼变化，忽略寒暄和重复内容。严格控制在 ' + max + ' 字以内（越短越好），不要分点、不要标题、不要解释，只输出一段总结正文。';
  var out = (await callLLM({ base: api.base, key: api.key, model: api.model, temperature: 0.5, system: system,
    messages: [{ role: 'user', content: transcript(msgs, char) }], stream: false })).trim();
  /* 模型写超字数也不再追加请求压缩：总结永远只请求 1 次（字数上限只写在提示词里） */
  return out;
}
async function refineMemories(char, mems, targetChars) {
  var api = secondaryApi();
  var system = '你是「' + (char.realName || char.name) + '」。下面是你已有的记忆，请合并、去重、按时间顺序整理成一份连贯的第一人称记忆档案。' +
    '保留所有重要事实、约定、关系变化和关键细节，删掉重复和琐碎内容。总长度控制在约 ' + targetChars + ' 字以内，只输出整理后的正文。';
  var body = mems.slice().sort(function (a, b) { return a.ts - b.ts; }).map(function (m) { return '- ' + m.content; }).join('\n');
  return (await callLLM({ base: api.base, key: api.key, model: api.model, temperature: 0.4, system: system,
    messages: [{ role: 'user', content: body }], stream: false })).trim();
}

/* 心声：让角色根据最近的聊天，写下此刻没说出口的想法 */
function parseThought(text) {
  var t = String(text || '').replace(/```json|```/g, '').trim();
  var m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没有返回 JSON 格式：' + t.slice(0, 120));
  var o; try { o = JSON.parse(m[0]); } catch (e) { throw new Error('心声解析失败：' + m[0].slice(0, 120)); }
  var v = String(o.heartfeltVoice || '').trim(), j = String(o.randomJottings || '').trim();
  if (!v && !j) throw new Error('模型返回的心声是空的');
  return { heartfeltVoice: v, randomJottings: j };
}
/* 从模型回复里拆出 <心声>…</心声>：返回 { reply: 去掉心声后的正文, thought: 解析成功的心声或 null } */
/* 模型在回复开头顺带写出的用户语音文字：<听写>…</听写>（可能有多段，按语音顺序）。返回 { texts, reply } */
function extractDictation(text) {
  var t = String(text || ''), texts = [], re = /<听写>([\s\S]*?)<\/听写>/g, m;
  while ((m = re.exec(t))) texts.push(m[1].trim());
  var reply = t.replace(re, '');
  var i = reply.indexOf('<听写>');   /* 被截断、没写结束标签：取到这一行结束 */
  if (i !== -1) { var rest = reply.slice(i + 4), nl = rest.indexOf('\n'); texts.push((nl === -1 ? rest : rest.slice(0, nl)).trim()); reply = reply.slice(0, i) + (nl === -1 ? '' : rest.slice(nl + 1)); }
  return { texts: texts, reply: reply.replace(/^\s+/, '') };
}
function extractThought(text) {
  var t = String(text || ''), th = null, reply = t, m = t.match(/<心声>([\s\S]*?)<\/心声>/);
  if (m) { reply = t.replace(m[0], ''); try { th = parseThought(m[1]); } catch (e) {} }
  else { var i = t.indexOf('<心声>'); if (i !== -1) { reply = t.slice(0, i); try { th = parseThought(t.slice(i + 4)); } catch (e) {} } }   /* 被截断、没写结束标签 */
  return { reply: reply.trim(), thought: th };
}

/* 导出给测试用 */
if (typeof module !== 'undefined') module.exports = { extractThought: extractThought, offlineRules: offlineRules, selectMemories: selectMemories, triggeredEntries: triggeredEntries, pickMemories: pickMemories, buildSystem: buildSystem, msgToText: msgToText, toApiMessages: toApiMessages, splitReply: splitReply, parseThought: parseThought, openaiUrl: openaiUrl, stickerPool: stickerPool, sampleStickers: sampleStickers, parseReplyLines: parseReplyLines, findSticker: findSticker };

/* ---------- ⑤ 界面 ---------- */
var $ = function (id) { return document.getElementById(id); };
function h(tag, props) {
  var el = document.createElement(tag);
  Object.keys(props || {}).forEach(function (k) {
    var v = props[k];
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  });
  (function add(list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) add(c);
      else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  })(Array.prototype.slice.call(arguments, 2));
  return el;
}
var toastTimer;
function toast(msg) {
  var t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
}

/* 弹层 */
function openSheet(nodes) {
  var p = $('sheet-panel'); p.innerHTML = '';
  nodes.forEach(function (n) { if (n) p.appendChild(n); });
  $('sheet').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; }
$('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) closeSheet(); });
function menuSheet(title, items) {
  openSheet([title ? h('h3', { text: title }) : null].concat(items.map(function (it) {
    return h('button', { class: 'menu-btn', text: it[0], onclick: function () { closeSheet(); it[1](); } });
  })).filter(Boolean));
}
function confirmSheet(msg, okText, onOk, danger) {
  openSheet([h('h3', { text: msg }), h('div', { class: 'btn-row' },
    h('button', { class: 'btn' + (danger ? ' danger' : ' primary'), text: okText, onclick: function () { closeSheet(); onOk(); } }),
    h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
}
function textSheet(title, value, buttons, hint) {
  var ta = h('textarea', {}); ta.value = value || '';
  openSheet([h('h3', { text: title }), hint ? h('div', { class: 'hint', text: hint, style: 'color:var(--sub);font-size:12px;margin-bottom:8px' }) : null, ta,
    h('div', { class: 'btn-row', style: 'margin-top:10px' }, buttons.map(function (b) {
      return h('button', { class: 'btn' + (b.cls ? ' ' + b.cls : ''), text: b.text, onclick: function () { closeSheet(); if (b.fn) b.fn(ta.value); } });
    }))].filter(Boolean));
  return ta;
}

/* 页面导航 */
var nav = ['s-home'];
var onShow = {};
var transTimer = null;
function clearTrans() {
  if (transTimer) { clearTimeout(transTimer); transTimer = null; }
  document.querySelectorAll('.screen').forEach(function (el) {
    el.classList.remove('leaving', 'in-fwd', 'out-fwd', 'in-back', 'out-back');
    if (!el.classList.contains('active')) el.classList.remove('leaving');
  });
}
function activate(id, isBack) {
  clearTrans();
  if (id === 's-home' || id === 's-list') clearChatLook();
  var prev = document.querySelector('.screen.active'), next = $(id);
  if (prev === next) { if (onShow[id]) onShow[id](); return; }
  if (prev) {
    prev.classList.remove('active');
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      prev.classList.add('leaving', isBack ? 'out-back' : 'out-fwd');
      next.classList.add(isBack ? 'in-back' : 'in-fwd');
      transTimer = setTimeout(clearTrans, 320);
    }
  }
  next.classList.add('active');
  if (onShow[id]) onShow[id]();
}
function go(id) { nav.push(id); activate(id); }
function back(force) {
  if (!force && nav[nav.length - 1] === 's-settings' && settingsDirty) {
    openSheet([h('h3', { text: '设置有改动还没保存' }), h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '保存并离开', onclick: async function () { closeSheet(); await commitSettings(); back(true); } }),
      h('button', { class: 'btn danger', text: '不保存', onclick: function () { closeSheet(); settingsDirty = false; back(true); } }),
      h('button', { class: 'btn', text: '继续编辑', onclick: closeSheet }))]);
    return;
  }
  if (!force && nav[nav.length - 1] === 's-beauty' && beautyDirty()) {
    openSheet([h('h3', { text: '美化有改动还没保存' }), h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '保存并离开', onclick: function () { closeSheet(); beautySnap = snapBeauty(); iosAlert('已保存', '美化已保存'); back(true); } }),
      h('button', { class: 'btn danger', text: '不保存（还原）', onclick: async function () { closeSheet(); await restoreBeauty(); back(true); } }),
      h('button', { class: 'btn', text: '继续编辑', onclick: closeSheet }))]);
    return;
  }
  if (nav.length > 1) nav.pop(); activate(nav[nav.length - 1], true);
}
document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-back]')) back(); });

/* ---------- 小预设：字体 / 提示音 / 美化 CSS / 气泡 CSS 各自单独存一组，随时切换 ----------
 * 用法：presetBar('font', { snap: function(){ return 当前值; }, apply: async function(值){ … } })
 * kind 只是分类名，同一类的预设互相独立。数据存在 miniPresets 仓库里。 */
async function miniList(kind) {
  return (await dbAll('miniPresets')).filter(function (p) { return p.kind === kind; }).sort(function (a, b) { return b.ts - a.ts; });
}
function presetBar(kind, o) {
  var box = h('div', { class: 'pbar' });
  async function draw() {
    var list = await miniList(kind); box.innerHTML = '';
    var sel = h('select', {}, h('option', { value: '', text: list.length ? '切换预设…（共 ' + list.length + ' 个）' : '还没有预设' }));
    list.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: p.name })); });
    sel.onchange = async function () {
      var p = list.find(function (x) { return x.id === sel.value; }); sel.value = '';
      if (p) { try { await o.apply(cloneJ(p.v)); toast('已应用「' + p.name + '」'); } catch (e) { toast('应用失败：' + e.message); } draw(); }
    };
    box.appendChild(h('div', { class: 'prow' }, sel,
      h('button', { type: 'button', class: 'btn', text: '存为预设', onclick: function () {
        nameSheet('存为预设（保存当前这一项）', '', async function (nm) { await dbPut('miniPresets', { id: uid('mp'), kind: kind, name: nm, ts: Date.now(), v: cloneJ(await o.snap()) }); toast('已存为「' + nm + '」'); draw(); }, '给预设起个名字');
      } }),
      list.length ? h('button', { type: 'button', class: 'btn', text: '管理', onclick: function () {
        menuSheet('管理预设', list.map(function (p) { return [p.name, function () {
          menuSheet(p.name, [
            ['用当前内容覆盖它', async function () { p.v = cloneJ(await o.snap()); p.ts = Date.now(); await dbPut('miniPresets', p); toast('已更新「' + p.name + '」'); draw(); }],
            ['重命名', function () { nameSheet('重命名', p.name, async function (nm) { p.name = nm; await dbPut('miniPresets', p); draw(); }, '预设名称'); }],
            ['删除', function () { confirmSheet('删除预设「' + p.name + '」？', '删除', async function () { await dbDel('miniPresets', p.id); draw(); }, true); }]]);
        }]; }));
      } }) : null));
    return box;
  }
  draw(); return box;
}

/* ---------- 多选下拉：点一下弹出列表（可搜索）→ 勾选 → 点「完成」就收起 ----------
 * 用在角色设置的「挂载世界书」「表情包分类」。options: [{id,name,sub}]；selected: id 数组。
 * 返回 { el, get() }，get() 给出当前选中的 id 数组。 */
function multiPick(title, options, selected, emptyText) {
  var sel = {}; (selected || []).forEach(function (id) { sel[String(id)] = true; });
  var btn = h('button', { type: 'button', class: 'mp-btn' });
  function summary() {
    var names = options.filter(function (o) { return sel[String(o.id)]; }).map(function (o) { return o.name; });
    btn.innerHTML = ''; btn.appendChild(h('span', { class: 'mp-txt', text: !options.length ? (emptyText || '没有可选项') : names.length ? '已选 ' + names.length + '：' + names.join('、') : '没有选择（点这里选择）' }));
    btn.appendChild(h('span', { class: 'mp-arrow', text: '▾' }));
  }
  btn.onclick = function () {
    if (!options.length) return;
    var tmp = Object.assign({}, sel), q = h('input', { type: 'search', placeholder: '搜索…', class: 'mp-search' }), list = h('div', { class: 'mp-list' }), cnt = h('span', { class: 'mp-cnt' });
    function drawList() {
      var kw = q.value.trim().toLowerCase(); list.innerHTML = '';
      options.filter(function (o) { return !kw || o.name.toLowerCase().indexOf(kw) !== -1; }).forEach(function (o) {
        var cb = h('input', { type: 'checkbox' }); cb.checked = !!tmp[String(o.id)];
        cb.onchange = function () { if (cb.checked) tmp[String(o.id)] = true; else delete tmp[String(o.id)]; cnt.textContent = '已选 ' + Object.keys(tmp).length + ' / ' + options.length; };
        list.appendChild(h('label', { class: 'check' }, cb, h('span', { text: o.name + (o.sub ? '（' + o.sub + '）' : '') })));
      });
      if (!list.firstChild) list.appendChild(h('div', { class: 'hint', text: '没有匹配的' }));
      cnt.textContent = '已选 ' + Object.keys(tmp).length + ' / ' + options.length;
    }
    q.oninput = drawList; drawList();
    openSheet([h('h3', { text: title }), options.length > 8 ? q : null, list,
      h('div', { class: 'mp-foot' }, cnt,
        h('button', { type: 'button', class: 'btn', text: '全选', onclick: function () { options.forEach(function (o) { tmp[String(o.id)] = true; }); drawList(); } }),
        h('button', { type: 'button', class: 'btn', text: '全不选', onclick: function () { tmp = {}; drawList(); } }),
        h('button', { type: 'button', class: 'btn primary', text: '完成', onclick: function () { sel = tmp; closeSheet(); summary(); } }))].filter(Boolean));
  };
  summary();
  return { el: btn, get: function () { return options.filter(function (o) { return sel[String(o.id)]; }).map(function (o) { return String(o.id); }); }, count: function () { return Object.keys(sel).length; } };
}

/* ---------- 桌面 ----------
 * 想增删图标、改顺序或颜色，只改下面这个 APPS 数组就行：
 * name=名字，color=图标底色，icon=SVG 路径，tap=点击后做什么
 * img=图标图片网址（可选；加载失败自动用 icon 矢量图）
 * 图标的大小/圆角/阴影/间距 -> 改最上面 CSS 的「桌面可调参数」
 * 默认排列在 defaultLayout() 里；你在桌面上长按拖动后的排列会存起来，点「重置排列」恢复默认 */
var APPS = [
  { name: '聊天', img: 'https://i.imgs.ovh/2026/11/12/c26c5b797e2947f12e96db4ba63d430d.jpg', color: '#c4572a', icon: 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    tap: function () { go('s-list'); } },
  { name: '记忆', img: 'https://i.imgs.ovh/2026/11/12/40a87fcf8fb35d7c49c396bf7455623f.jpg', color: '#4f7c6a', icon: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6zM9 3v18M12 8h4M12 12h4',
    tap: function () { pickCharThen('选择角色', function (c) { cur = c; go('s-memory'); }); } },
  { name: '世界书', img: 'https://i.imgs.ovh/2026/11/12/d67bd0f136d13523ba65030a3b438ec7.jpg', color: '#c08a2e', icon: 'M12 6c-2-1.5-5-2-8-1.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-13C17 4 14 4.5 12 6zM12 6v13',
    tap: function () { go('s-wblist'); } },
  { name: '表情包', img: 'https://i.imgs.ovh/2026/11/12/21ffb2ac40aec04e658fe44111c04e70.jpg', color: '#8a5a8f', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 14c1 1.5 2.2 2 3.5 2s2.5-.5 3.5-2M9 9.5h.01M15 9.5h.01',
    tap: function () { go('s-stickers'); } },
  { name: '美化', img: 'https://i.imgs.ovh/2026/11/12/8500e6fda76097cda9ee7f8a6090a3e3.jpg', color: '#b0577a', icon: 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-1.4-1.3-1.7-1.3-3 0-1 .8-1.7 1.9-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01',
    tap: function () { beautySnap = snapBeauty(); go('s-beauty'); } },
  { name: 'API设置', img: 'https://i.imgs.ovh/2026/11/12/e5ce0267cf4bd0b37d18a1866a178dd9.jpg', color: '#3d5a80', icon: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 4v6M7 14v6',
    tap: function () { go('s-settings'); } },
  { name: '数据备份', img: 'https://i.imgs.ovh/2026/11/12/fb4761d50fc0237e8566e4ed097f9920.jpg', color: '#6b6b6b', icon: 'M4 7h16v4H4zM6 11v8h12v-8M10 15h4',
    tap: function () { menuSheet('数据备份', [['导入数据', startImport], ['导出数据', exportData]]); } },
  { name: '网易云音乐', img:'https://i.imgs.ovh/2026/11/12/bec70652b9dafca1319ae6c0186d3087.jpg', color: '#d43c33', icon: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    tap: function () { toast('网易云音乐（一起听歌）还在开发中'); } },
  { name: '看手机', img:'https://i.imgs.ovh/2026/11/12/79c9fc0024948a5505778c43d91a6bfd.jpg', color: '#2f6f8f', icon: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2M9.5 11.5C10.5 9.8 11.3 9.3 12 9.3s1.5.5 2.5 2.2c-1 1.7-1.8 2.2-2.5 2.2s-1.5-.5-2.5-2.2z',
    tap: function () { toast('看手机还在开发中'); } },
  { name: '预设', color: '#7a6aa8', icon: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',   /* 想换图标图片：在这里加 img:'图片网址' */
    tap: function () { go('s-prlist'); } }
];
function pickCharThen(title, fn) {
  if (!chars.length) { toast('还没有角色，先去聊天里新建一个'); return; }
  menuSheet(title, chars.map(function (c) { return [c.name, function () { fn(c); }]; }));
}
var SVGNS = 'http://www.w3.org/2000/svg';
function appIcon(d) {
  var svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
  var p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); svg.appendChild(p); return svg;
}
/* ---- 时钟：固定用北京时间（Asia/Shanghai），不受手机时区设置影响 ---- */
function bjNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })); }
var lastDateKey = '';
function renderClock() {
  var n = bjNow(), pad = function (x) { return (x < 10 ? '0' : '') + x; };
  $('home-time').textContent = pad(n.getHours()) + ':' + pad(n.getMinutes());
  var key = n.toDateString(); if (key === lastDateKey) return; lastDateKey = key;
  var per = n.getHours() < 5 ? '凌晨' : n.getHours() < 12 ? '上午' : n.getHours() < 18 ? '下午' : '晚上';
  $('home-date').textContent = (n.getMonth() + 1) + '月' + n.getDate() + '日 ' + '周' + '日一二三四五六'.charAt(n.getDay()) + ' ' + per;
  var lunar = '';
  try {
    var pp = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' }).formatToParts(n), mo = '', dd = 0;
    pp.forEach(function (x) { if (x.type === 'month') mo = x.value; if (x.type === 'day') dd = Number(x.value); });
    var CN = ['', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
    lunar = mo + (CN[dd] || '');
  } catch (e) {}
  $('home-lunar').textContent = lunar;
  var wk = $('home-week'); wk.innerHTML = '';
  var mon = new Date(n); mon.setDate(n.getDate() - ((n.getDay() + 6) % 7));
  for (var k = 0; k < 7; k++) {
    var d = new Date(mon); d.setDate(mon.getDate() + k);
    wk.appendChild(h('div', { class: 'd' + (d.toDateString() === n.toDateString() ? ' today' : '') }, h('b', { text: String(d.getDate()) }), h('span', { text: '周' + '一二三四五六日'.charAt(k) })));
  }
}

/* ---- 天气：Open-Meteo（免费、不用 Key）。默认城市在下面改；也可以在桌面点天气文字换城市/用定位 ---- */
var WEATHER_DEFAULT = { city: '北京', lat: 39.9042, lon: 116.4074 };
function wxInfo(c) {
  if (c === 0) return ['晴', '☀️']; if (c <= 2) return ['多云', '⛅']; if (c === 3) return ['阴', '☁️'];
  if (c === 45 || c === 48) return ['雾', '🌫️']; if (c >= 51 && c <= 57) return ['毛毛雨', '🌦️'];
  if (c >= 61 && c <= 65) return ['雨', '🌧️']; if (c === 66 || c === 67) return ['冻雨', '🌧️'];
  if (c >= 71 && c <= 77) return ['雪', '❄️']; if (c >= 80 && c <= 82) return ['阵雨', '🌦️'];
  if (c === 85 || c === 86) return ['阵雪', '🌨️']; if (c >= 95) return ['雷雨', '⛈️'];
  return ['未知', '🌡️'];
}
async function renderWeather() {
  var el = $('home-weather'), w = settings.weather || WEATHER_DEFAULT, key = w.lat + ',' + w.lon, cache = null;
  try { cache = JSON.parse(localStorage.getItem('wx-cache') || 'null'); } catch (e) {}
  if (cache && cache.key !== key) cache = null;
  function show(c) { var i = wxInfo(c.code); el.textContent = i[1] + ' ' + i[0] + ' ' + c.temp + '° ' + w.city; }
  if (cache) { show(cache); if (Date.now() - cache.t < 20 * 60000) return; } else el.textContent = w.city + ' 天气加载中…';
  try {
    var r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + w.lat + '&longitude=' + w.lon + '&current=temperature_2m,weather_code&timezone=Asia%2FShanghai');
    if (!r.ok) throw new Error(r.status);
    var j = await r.json(), c = { key: key, t: Date.now(), temp: Math.round(j.current.temperature_2m), code: j.current.weather_code };
    try { localStorage.setItem('wx-cache', JSON.stringify(c)); } catch (e) {}
    show(c);
  } catch (e) { if (!cache) el.textContent = w.city + ' 天气获取失败，点这里重试'; }
}
function weatherSheet() {
  var inp = h('input', { type: 'text', placeholder: '输入城市名，如 上海 / 成都 / Tokyo', style: 'width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:10px' });
  async function setW(w) { settings.weather = w; await saveSettings(); try { localStorage.removeItem('wx-cache'); } catch (e) {} closeSheet(); renderWeather(); }
  openSheet([h('h3', { text: '天气城市（当前：' + (settings.weather || WEATHER_DEFAULT).city + '）' }), inp, h('div', { class: 'btn-row' },
    h('button', { class: 'btn primary', text: '搜索并使用', onclick: async function () {
      var v = inp.value.trim(); if (!v) { toast('先输入城市名'); return; }
      try {
        var r = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(v) + '&count=1&language=zh'), j = await r.json();
        if (!j.results || !j.results.length) { toast('没找到这个城市'); return; }
        setW({ city: j.results[0].name, lat: j.results[0].latitude, lon: j.results[0].longitude });
      } catch (e) { toast('搜索失败：' + e.message); }
    } }),
    h('button', { class: 'btn', text: '用当前定位', onclick: function () {
      if (!navigator.geolocation) { toast('这个浏览器不支持定位'); return; }
      navigator.geolocation.getCurrentPosition(function (p) { setW({ city: '当前位置', lat: Number(p.coords.latitude.toFixed(3)), lon: Number(p.coords.longitude.toFixed(3)) }); }, function () { toast('定位失败：请允许定位权限，或直接输入城市'); }, { timeout: 8000 });
    } }),
    h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
}
$('home-weather').onclick = weatherSheet;

/* ---- 桌面图标 ---- */
var DOCK_NAMES = ['聊天', '记忆', '世界书', '表情包'];
function appBtn(a) {
  var tile = h('div', { class: 'tile', style: 'background:' + a.color + ';--tc:' + a.color }, appIcon(a.icon));
  var b = h('button', { class: 'app', 'data-id': a.name, onclick: a.tap, 'aria-label': a.name }, tile, h('span', { text: a.name }));
  var iconSrc = (settings.iconUrls && settings.iconUrls[a.name]) || a.img;   /* 美化里自定义的图标优先 */
  if (iconSrc) {
    var im = new Image(); im.alt = ''; im.draggable = false;
    im.onload = function () { tile.innerHTML = ''; tile.classList.add('img'); tile.appendChild(im); };   /* 图片加载成功才替换，失败就保留默认图标 */
    im.src = iconSrc;
  }
  return b;
}
function photoWidget(key) {
  var w = h('button', { type: 'button', class: 'wdg', 'data-id': key, 'aria-label': '照片小组件', text: '＋' });
  dbGet('settings', key).then(function (r) { if (r && r.data) { w.textContent = ''; w.style.backgroundImage = 'url(' + r.data + ')'; } });
  w.onclick = async function () {
    var has = await dbGet('settings', key);
    var pick = function () { pickImage(900, 0.8, async function (d) { await dbPut('settings', { key: key, data: d }); renderHome(); }); };
    if (!has || !has.data) pick();
    else menuSheet('照片小组件', [['更换照片', pick], ['移除照片', async function () { await dbDel('settings', key); renderHome(); }]]);
  };
  return w;
}
/* 默认排列：dock=底栏四个；grid=桌面格子（widgetA / widgetB 是两个照片组件，也能拖动换位置） */
function defaultLayout() {
  var rest = APPS.map(function (a) { return a.name; }).filter(function (n) { return DOCK_NAMES.indexOf(n) === -1; });
  return { dock: DOCK_NAMES.slice(), grid: rest.slice(0, 2).concat(['widgetA'], rest.slice(2, 4), ['widgetB'], rest.slice(4)) };
}
function resolveLayout() {
  var def = defaultLayout(), sv = settings.homeLayout;
  if (!sv) return def;
  var all = {}, used = {}; def.grid.concat(def.dock).forEach(function (id) { all[id] = 1; });
  function clean(list) { var out = []; (list || []).forEach(function (id) { if (id === 'empty') { out.push(id); return; } if (all[id] && !used[id]) { used[id] = 1; out.push(id); } }); return out; }   /* 'empty' = 桌面上留的空格 */
  var dock = clean(sv.dock).filter(function (id) { return id !== 'empty'; }), grid = clean(sv.grid);
  def.grid.concat(def.dock).forEach(function (id) { if (!used[id]) grid.push(id); });   /* 以后新增的图标自动补到最后 */
  return { dock: dock, grid: grid };
}
async function renderHome() {
  editMode = false; $('s-home').classList.remove('editing'); $('home-edit').hidden = true;
  renderClock(); renderWeather();
  var grid = $('app-grid'), dock = $('dock'); grid.innerHTML = ''; dock.innerHTML = '';
  var byName = {}; APPS.forEach(function (a) { byName[a.name] = a; });
  var L = resolveLayout();
  function node(id) { if (id === 'empty') return slotNode(); return (id === 'widgetA' || id === 'widgetB') ? photoWidget(id) : (byName[id] ? appBtn(byName[id]) : null); }
  L.dock.forEach(function (id) { var n = node(id); if (n) { dock.appendChild(n); bindHomeDrag(n); } });
  L.grid.forEach(function (id) { var n = node(id); if (n) { grid.appendChild(n); if (id !== 'empty') bindHomeDrag(n); } });
  chars = await dbAll('characters');
  refreshBadges();
}
onShow['s-home'] = renderHome;

/* ---- 长按图标 → 进入编辑模式，拖动调整位置（桌面格子 ⇄ 底栏 可互相拖；底栏最多 4 个，照片组件不能进底栏） ---- */
var editMode = false, dragState = null, suppressClick = false;
/* 空格：桌面上留空的一个格子（和图标一样大，编辑时显示虚线框，可以把图标放进来） */
function slotNode() { return h('div', { class: 'app slot', 'data-id': 'empty', 'aria-hidden': 'true' }, h('div', { class: 'tile' }), h('span', { text: ' ' })); }
function trimTailSlots() { var g = $('app-grid'); while (g.lastElementChild && g.lastElementChild.classList.contains('slot')) g.lastElementChild.remove(); }
function setEdit(on, skipSave) {
  editMode = on; $('s-home').classList.toggle('editing', on); $('home-edit').hidden = !on;
  trimTailSlots();
  if (on) { for (var i = 0; i < 4; i++) $('app-grid').appendChild(slotNode()); }   /* 编辑时多给一排空格，方便放到最后面 */
  else if (!skipSave) saveHomeLayout();
}
function saveHomeLayout() {
  var ids = function (box) { return Array.prototype.map.call(box.children, function (el) { return el.getAttribute('data-id'); }).filter(Boolean); };
  var g = ids($('app-grid')); while (g.length && g[g.length - 1] === 'empty') g.pop();   /* 末尾的空格不用存 */
  settings.homeLayout = { grid: g, dock: ids($('dock')).filter(function (id) { return id !== 'empty'; }) };
  return saveSettings();
}
function beginDrag(el, x, y) {
  var r = el.getBoundingClientRect(), clone = el.cloneNode(true);
  clone.classList.add('drag-clone'); clone.style.left = r.left + 'px'; clone.style.top = r.top + 'px'; clone.style.width = r.width + 'px'; clone.style.height = r.height + 'px';
  document.body.appendChild(clone); el.classList.add('ph');
  dragState = { el: el, clone: clone, ox: x - r.left, oy: y - r.top, box: el.parentNode, last: 0 };
  suppressClick = true;
}
/* 交换两个节点的位置（相邻也行） */
function swapNodes(a, b) {
  var mk = document.createElement('i');
  a.parentNode.insertBefore(mk, a); b.parentNode.insertBefore(a, b); mk.parentNode.insertBefore(b, mk); mk.remove();
}
/* 拖动规则（像手机桌面）：
 * ① 放到空格上 → 图标就放进这个空格，原来的位置变成空格，别的图标不动；
 * ② 放到另一个图标上 → 两个图标互换位置；
 * ③ 桌面 → 底栏：底栏没满就插进去（桌面原位留空格）；满了就和被放到的那个互换；
 * ④ 照片组件只在桌面里动，不能进底栏，也不和图标互换。 */
function dragMove(x, y) {
  var d = dragState; d.clone.style.left = (x - d.ox) + 'px'; d.clone.style.top = (y - d.oy) + 'px';
  d.px = x; d.py = y;
  if (Date.now() - d.last < 140) {            /* 换位后冷却一下防抖；冷却结束后用最新位置补一次，保证手停在哪就落在哪 */
    if (!d.timer) d.timer = setTimeout(function () { d.timer = null; if (dragState === d) dragMove(d.px, d.py); }, 150);
    return;
  }
  var dockEl = $('dock'), a = d.el, isW = a.classList.contains('wdg'), fromDock = a.parentNode === dockEl;
  var under = document.elementFromPoint(x, y), tgt = under && under.closest && under.closest('#app-grid > [data-id], #dock > [data-id]');
  var dr = dockEl.getBoundingClientRect(), inDock = x >= dr.left && x <= dr.right && y >= dr.top && y <= dr.bottom, changed = false;
  /* 悬停到「有图标的位置」要停住 0.35 秒才换位（松手时立刻换）；经过时不会把路上的图标一路带着走。放到空格是立刻的。 */
  var hoverKey = (tgt && tgt !== a && !tgt.classList.contains('slot')) ? tgt : ((!tgt && inDock) ? dockEl : null);
  if (hoverKey && !d.final) {
    if (d.hoverTgt !== hoverKey) { d.hoverTgt = hoverKey; d.hoverSince = Date.now(); }
    var wait = 350 - (Date.now() - d.hoverSince);
    if (wait > 0) { if (!d.timer) d.timer = setTimeout(function () { d.timer = null; if (dragState === d) dragMove(d.px, d.py); }, wait + 10); return; }
  } else if (!hoverKey) d.hoverTgt = null;
  if (tgt && tgt !== a) {
    var toDock = tgt.parentNode === dockEl, tIsW = tgt.classList.contains('wdg'), tIsSlot = tgt.classList.contains('slot');
    if (isW && (toDock || !tIsSlot && !tIsW)) return;     /* 组件：不进底栏，也不和图标互换 */
    if (!isW && tIsW) return;                              /* 图标不能放到组件上 */
    if (!fromDock && toDock && dockEl.children.length < 4) { a.parentNode.insertBefore(slotNode(), a); dockEl.insertBefore(a, tgt); changed = true; }
    else { swapNodes(a, tgt); changed = true; }
  } else if (!tgt && inDock && !fromDock && !isW && dockEl.children.length < 4) {
    a.parentNode.insertBefore(slotNode(), a); dockEl.appendChild(a); changed = true;
  }
  if (changed) {
    Array.prototype.slice.call(dockEl.querySelectorAll('.slot')).forEach(function (e) { e.remove(); });   /* 底栏里不留空格 */
    d.box = a.parentNode; d.last = Date.now();
  }
}
function endDrag() {
  var d = dragState; if (!d) return;
  if (d.timer) { clearTimeout(d.timer); d.timer = null; }
  d.last = 0; d.final = true; if (d.px != null) dragMove(d.px, d.py);      /* 松手时按最后位置再落一次（立刻生效） */
  dragState = null;
  d.clone.remove(); d.el.classList.remove('ph'); saveHomeLayout();
  setTimeout(function () { suppressClick = false; }, 400);
}
function bindHomeDrag(el) {
  var tm = null, sx = 0, sy = 0, armed = false;
  function pt(e) { var t = e.touches && e.touches[0] ? e.touches[0] : e; return { x: t.clientX, y: t.clientY }; }
  function down(e) {
    var p = pt(e); sx = p.x; sy = p.y; armed = true;
    if (!editMode) tm = setTimeout(function () { tm = null; if (!armed) return; if (navigator.vibrate) try { navigator.vibrate(12); } catch (x) {} setEdit(true); beginDrag(el, sx, sy); }, 450);
  }
  function move(e) {
    var p = pt(e);
    if (dragState && dragState.el === el) { if (e.cancelable) e.preventDefault(); dragMove(p.x, p.y); return; }
    if (!armed) return;
    if (Math.abs(p.x - sx) > 8 || Math.abs(p.y - sy) > 8) {
      if (tm) { clearTimeout(tm); tm = null; armed = false; }          /* 还没进编辑模式就滑动了：当作普通滑动 */
      else if (editMode) { if (e.cancelable) e.preventDefault(); beginDrag(el, p.x, p.y); dragMove(p.x, p.y); }
    }
  }
  function up() { if (tm) { clearTimeout(tm); tm = null; } armed = false; if (dragState && dragState.el === el) endDrag(); }
  el.addEventListener('touchstart', down, { passive: true });
  el.addEventListener('touchmove', move, { passive: false });
  el.addEventListener('touchend', up); el.addEventListener('touchcancel', up);
  el.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return; down(e);
    var mm = function (ev) { move(ev); }, mu = function () { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); up(); };
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
  });
}
$('s-home').addEventListener('click', function (e) {
  if ((editMode || suppressClick) && !(e.target.closest && e.target.closest('#home-edit'))) { e.stopPropagation(); e.preventDefault(); }
}, true);
$('s-home').addEventListener('contextmenu', function (e) { e.preventDefault(); });
$('home-done').onclick = function () { setEdit(false); };
$('home-reset').onclick = async function () { setEdit(false, true); settings.homeLayout = null; await saveSettings(); renderHome(); toast('已恢复默认排列'); };
setInterval(function () { if ($('s-home').classList.contains('active')) renderClock(); }, 1000);
setInterval(function () { if ($('s-home').classList.contains('active')) renderWeather(); }, 20 * 60000);

/* ---------- 角色列表 ---------- */
var chars = [], cur = null; // cur = 当前聊天的角色
function avatarNode(src, name) {
  var a = h('div', { class: 'avatar' });
  if (src) a.appendChild(h('img', { src: src, alt: '', onerror: function () { a.textContent = (name || '?').charAt(0); } }));
  else a.textContent = (name || '?').charAt(0);
  return a;
}
function shortTime(ts) {
  var d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return d.toTimeString().slice(0, 5);
  return (d.getMonth() + 1) + '/' + d.getDate();
}
async function renderList() {
  chars = await dbAll('characters');
  var box = $('char-list'); box.innerHTML = '';
  if (!chars.length) {
    box.appendChild(h('div', { class: 'empty' }, '还没有角色\n', h('br'), '点右上角 ＋ 新建，或点下方「导入数据」\n导入 myphone-v1.json'));
    box.firstChild.style.whiteSpace = 'pre-line';
    return;
  }
  var rows = [];
  for (var i = 0; i < chars.length; i++) {
    var last = (await pageMessages(chars[i].id, null, 8)).filter(function (m) { return !m.hidden && m.type !== 'system'; }).pop();
    rows.push({ c: chars[i], last: last });
  }
  rows.sort(function (a, b) { return ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0); });
  rows.forEach(function (r) {
    var prev = r.last ? (r.last.role === 'user' ? '我：' : '') + msgToText(r.last).replace(/\n/g, ' ') : '还没有消息';
    box.appendChild(h('div', { class: 'char', 'data-cid': r.c.id, onclick: function () { openChat(r.c.id); } },
      avatarNode(r.c.avatar, r.c.name),
      h('div', { class: 'meta' }, h('div', { class: 'name', text: r.c.name }), h('div', { class: 'last', text: prev })),
      h('div', { class: 'time', text: r.last ? shortTime(r.last.ts) : '' })));
  });
  refreshBadges();
}
onShow['s-list'] = renderList;

$('b-newchar').onclick = async function () {
  var c = { id: uid('chat'), name: '新角色', realName: '新角色', persona: '', userNickname: '', userPersona: '', avatar: null, userAvatar: null,
    worldBookIds: [], contextLimit: null, autoMemory: { enabled: false, interval: 20 }, lastSummaryTs: 0 };
  await dbPut('characters', c);
  editChar(c.id);
};

/* ---------- 聊天 ---------- */
var PAGE = 60, oldest = null;
var rounds = {}; /* 每个角色当前这一轮回复的状态 */

async function openChat(cid) {
  cur = chars.find(function (c) { return c.id === cid; }) || await dbGet('characters', cid);
  refreshTitle(); if (selMode) exitSelect(); setQuote(null); $('input').placeholder = cur.offlineMode ? '写下你的动作或对白…' : '说点什么…';
  clearUnread(cid);
  var page = await pageMessages(cid, null, PAGE);
  applyChatLook();
  $('msgs').innerHTML = ''; oldest = null; lastShownTs = 0;
  renderPage(page, false);
  go('s-chat');
  scrollBottom();
}
/* 滚到底；之后 6 秒内图片(表情包)加载撑高了，也会自动再滚到底，避免被底栏挡住 */
var pinUntil = 0;
function scrollBottom() { var m = $('msgs'); m.scrollTop = m.scrollHeight; pinUntil = Date.now() + 6000; }
function pinScroll() { if (Date.now() < pinUntil) { var m = $('msgs'); m.scrollTop = m.scrollHeight; } }
['touchstart', 'wheel', 'mousedown'].forEach(function (ev) { $('msgs').addEventListener(ev, function () { pinUntil = 0; }, { passive: true }); });

function msgNode(m) {
  if (m.hidden || m.type === 'system') return null;
  if (m.type === 'pat') return h('div', { class: 'sysline', text: m.content });
  if (m.type === 'recalled') {
    var rl = h('div', { class: 'sysline recalled-line', text: (m.role === 'user' ? '你' : cur.name) + '撤回了一条消息' });
    var ot = m.meta && m.meta.orig && m.meta.orig.text;
    if (m.role === 'user' && ot) rl.appendChild(h('button', { type: 'button', text: '重新编辑', onclick: function () { $('input').value = ot; $('input').focus(); } }));
    return rl;
  }
  var me = m.role === 'user', t = m.type || 'text', meta = m.meta || {}, b;
  if (t === 'sticker') {
    b = h('div', { class: 'bubble sticker' });
    var img = h('img', { src: m.content, alt: meta.meaning || '表情包' });
    img.onload = pinScroll;
    img.onerror = function () { b.innerHTML = ''; b.appendChild(h('div', { class: 'alt', text: '[表情包] ' + (meta.meaning || '') })); pinScroll(); };
    b.appendChild(img);
  } else if (t === 'voice' && !meta.audio && m.role === 'assistant') {
    b = h('div', { class: 'bubble vmsg' });
    var tb = h('button', { type: 'button', class: 'vplay', text: '▶', 'aria-label': '朗读语音' });
    tb.addEventListener('click', function (e) { e.stopPropagation(); speakVoice(tb, m.content); });
    b.appendChild(h('div', { class: 'vrow' }, tb, h('span', { class: 'vbar' }), h('span', { class: 'vdur', text: fmtDur(meta.duration || estSpeakSecs(m.content)) })));
    var tx = h('div', { class: 'vtext', text: m.content });
    if (cur && cur.autoVoiceText === false) { tx.hidden = true; b.appendChild(tx); b.appendChild(h('button', { type: 'button', class: 'vconv', text: '转文字', onclick: function (e) { e.stopPropagation(); tx.hidden = false; this.remove(); } })); }
    else b.appendChild(tx);
  } else if (t === 'voice' && meta.audio) {
    b = h('div', { class: 'bubble vmsg' });
    var pb = h('button', { type: 'button', class: 'vplay', text: '▶', 'aria-label': '播放语音' });
    pb.addEventListener('click', function (e) { e.stopPropagation(); toggleVoice(pb, meta.audio); });
    b.appendChild(h('div', { class: 'vrow' }, pb, h('span', { class: 'vbar' }), h('span', { class: 'vdur', text: fmtDur(meta.duration) })));
    if (m.content) b.appendChild(h('div', { class: 'vtext', text: m.content }));
    else b.appendChild(h('button', { type: 'button', class: 'vconv', text: '转文字', onclick: function (e) { e.stopPropagation(); transcribeLocal(m); } }));
  } else if (t === 'image') {
    b = h('div', { class: 'bubble image' });
    var pic = h('img', { src: m.content, alt: '图片' });
    pic.onload = pinScroll;
    pic.onerror = function () { b.innerHTML = ''; b.appendChild(h('div', { class: 'alt', text: '[图片读取失败]' })); };
    pic.addEventListener('click', function () { if (Date.now() - lastLP > 700 && !selMode) openLightbox(m.content); });
    b.appendChild(pic);
  } else if (t === 'transfer') {
    b = h('div', { class: 'bubble transfer' }, h('b', { text: '¥ ' + (meta.amount != null ? meta.amount : '') }), meta.note || '转账');
  } else {
    b = h('div', { class: 'bubble' + (t === 'voice' ? ' voice' : '') + (t === 'offline' ? ' offline' : '') });
    if (meta.quote && typeof meta.quote === 'object' && (meta.quote.content || meta.quote.text))
      b.appendChild(h('div', { class: 'quote', text: String(meta.quote.content || meta.quote.text) }));
    b.appendChild(document.createTextNode(m.content));
  }
  var row = h('div', { class: 'row' + (me ? ' me' : ''), 'data-id': m.id });
  bindLongPress(b, function () { if (!selMode) messageMenu(m, b); });
  if (!me) { var av0 = avatarNode(cur.avatar, cur.name); av0.style.cursor = 'pointer'; av0.title = '查看心声'; av0.addEventListener('click', function (e) { e.stopPropagation(); showThoughtCloud(av0); }); row.appendChild(av0); }
  else { var avMe = avatarNode(cur.userAvatar, cur.userNickname || '我'); if (!cur.userAvatar) avMe.classList.add('me-av'); row.appendChild(avMe); }   /* 没设置头像就显示一个字母/「我」头像 */
  var wrap = h('div', { class: 'bwrap' + (t === 'offline' ? ' wide' : '') }, b), edTxt = meta.edited ? '已编辑' : '';
  if (settings.showTime !== false || edTxt) wrap.appendChild(h('div', { class: 'mtime', text: (settings.showTime !== false ? hm(m.ts) : '') + (settings.showTime !== false && edTxt ? ' · ' : '') + edTxt }));
  row.appendChild(wrap);
  return row;
}

var lastShownTs = 0;
function hm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
function renderPage(page, prepend) {
  var box = $('msgs'), frag = document.createDocumentFragment(), prevTs = prepend ? 0 : lastShownTs;
  page.forEach(function (m) {
    var n = msgNode(m);
    if (n) {
      if (m.ts - prevTs > 10 * 60 * 1000) frag.appendChild(h('div', { class: 'sysline', text: fmtTime(m.ts).replace(/:\d\d$/, '') }));
      frag.appendChild(n); prevTs = m.ts;
    }
  });
  if (page.length && (!oldest || prepend)) oldest = { ts: page[0].ts, id: page[0].id };
  var old = box.querySelector('.more'); if (old) old.remove();
  if (prepend) {
    var h0 = box.scrollHeight; box.insertBefore(frag, box.firstChild); box.scrollTop += box.scrollHeight - h0;
  } else { box.appendChild(frag); if (page.length) lastShownTs = page[page.length - 1].ts; }
  if (page.length >= PAGE) box.insertBefore(h('button', { class: 'more', text: '加载更早的消息', onclick: loadMore }), box.firstChild);
}
async function loadMore() {
  pinUntil = 0;
  var page = await pageMessages(cur.id, oldest, PAGE);
  renderPage(page, true);
}
async function reloadChat() {
  $('msgs').innerHTML = ''; oldest = null; lastShownTs = 0;
  renderPage(await pageMessages(cur.id, null, PAGE), false); scrollBottom();
}

var lastLP = 0;   /* 最近一次长按的时间，用来避免长按后又触发点击 */
function bindLongPress(el, fn) {
  var tm = null, sx = 0, sy = 0;
  function clear() { if (tm) { clearTimeout(tm); tm = null; } }
  el.addEventListener('touchstart', function (e) { var t = e.touches[0]; sx = t.clientX; sy = t.clientY; clear(); tm = setTimeout(function () { tm = null; if (navigator.vibrate) try { navigator.vibrate(12); } catch (x) {} lastLP = Date.now(); fn(); }, 480); }, { passive: true });
  el.addEventListener('touchmove', function (e) { var t = e.touches[0]; if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) clear(); }, { passive: true });
  el.addEventListener('touchend', clear); el.addEventListener('touchcancel', clear);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); clear(); lastLP = Date.now(); fn(); });
}
/* 引用 */
var quoting = null;
function setQuote(q) {
  quoting = q; $('quote-bar').hidden = !q;
  if (q) { $('quote-text').textContent = q.content.slice(0, 80); $('input').focus(); }
}
$('quote-x').onclick = function () { setQuote(null); };
/* 多选 */
var selMode = false, selected = {};
function enterSelect(first) { selMode = true; selected = {}; $('s-chat').classList.add('selecting'); $('selbar').hidden = false; $('composer').hidden = true; if (first) toggleSel(first); else updSel(); }
function exitSelect() {
  selMode = false; selected = {}; $('s-chat').classList.remove('selecting'); $('selbar').hidden = true; $('composer').hidden = false;
  $('msgs').querySelectorAll('.row.sel').forEach(function (r) { r.classList.remove('sel'); });
}
function updSel() { $('sel-n').textContent = '已选 ' + Object.keys(selected).length + ' 条'; }
function toggleSel(id) {
  var row = $('msgs').querySelector('.row[data-id="' + id + '"]'); if (!row) return;
  if (selected[id]) { delete selected[id]; row.classList.remove('sel'); } else { selected[id] = true; row.classList.add('sel'); }
  updSel();
}
$('msgs').addEventListener('click', function (e) {
  if (!selMode) return;
  var row = e.target.closest && e.target.closest('.row[data-id]'); if (!row) return;
  e.stopPropagation(); e.preventDefault(); toggleSel(row.getAttribute('data-id'));
}, true);
$('sel-cancel').onclick = exitSelect;
async function selectedMsgs() {
  var all = await pageMessages(cur.id, null, 1e9), ids = selected;
  return all.filter(function (m) { return ids[m.id]; });
}
$('sel-copy').onclick = async function () {
  var ms = await selectedMsgs(); if (!ms.length) { toast('还没选消息'); return; }
  var t = ms.map(function (m) { return (m.role === 'user' ? '我' : cur.name) + '：' + plainText(m); }).join('\n');
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('已复制 ' + ms.length + ' 条'); exitSelect(); }, function () { toast('复制失败'); });
};
$('sel-del').onclick = function () {
  var n = Object.keys(selected).length; if (!n) { toast('还没选消息'); return; }
  confirmSheet('删除选中的 ' + n + ' 条消息？', '删除', async function () {
    var dm = await selectedMsgs(); await deleteMessages(dm);
    exitSelect(); reloadChat();
  }, true);
};

function plainText(m) { return m.type === 'image' ? msgToText(m) : (m.content || msgToText(m)); }
function editable(m) { return !m.type || m.type === 'text' || m.type === 'voice' || m.type === 'offline'; }
function editMessage(m) {
  textSheet('编辑消息（角色会按新内容理解，也会知道你改过）', m.content, [{ text: '保存', cls: 'primary', fn: async function (v) {
    if (v === m.content) return;
    m.meta = m.meta || {}; if (!m.meta.edited) m.meta.edited = { from: m.content, at: Date.now() }; else m.meta.edited.at = Date.now();   /* 只记最初的原文 */
    m.content = v; await dbPut('messages', m); reloadChat();
  } }, { text: '取消' }]);
}
/* 描述一条消息给模型看（删除/撤回时用）：去掉方括号包装，截短 */
function msgBrief(m, n) { return (msgToTextBase(m).replace(/\n/g, ' ').trim() || '（空）').slice(0, n || 40); }
/* 撤回自己的消息：气泡变成「你撤回了一条消息」，但角色下次回复时能看到撤回了什么 */
async function recallMessage(m) {
  var brief = msgToTextBase(m).replace(/\n/g, ' ').slice(0, 200), isText = !m.type || m.type === 'text' || m.type === 'offline';
  m.meta = { orig: { type: m.type || 'text', text: isText ? m.content : '', desc: brief } };
  m.type = 'recalled'; m.content = '';
  await dbPut('messages', m); reloadChat();
}
/* 删除消息：真的删掉，但留一条看不见的记录，让角色知道你删了什么 */
async function deleteMessages(list) {
  var real = list.filter(function (m) { return isRealMsg(m) && m.type !== 'recalled'; });
  for (var i = 0; i < list.length; i++) await dbDel('messages', list[i].id);
  if (real.length) {
    var parts = real.slice(0, 6).map(function (m) { return (m.role === 'user' ? '用户发的「' : '你发的「') + msgBrief(m, 40) + '」'; });
    await dbPut('messages', { id: uid(cur.id), characterId: cur.id, role: 'user', type: 'system', content: '[用户删除了 ' + real.length + ' 条消息：' + parts.join('；') + (real.length > 6 ? '…等' : '') + '。这些消息已从聊天里消失，但你知道它们的内容。]', ts: Date.now() });
  }
}
$('sel-edit').onclick = async function () {
  var ids = Object.keys(selected); if (ids.length !== 1) { toast('编辑只能选一条消息'); return; }
  var m = (await selectedMsgs())[0]; if (!m || !editable(m)) { toast('这种消息不能编辑'); return; }
  exitSelect(); editMessage(m);
};
function messageMenu(m, anchor) {
  var items = [['引用', function () { setQuote({ id: m.id, content: String(plainText(m)), name: m.role === 'user' ? '我' : cur.name }); }],
    ['选择', function () { enterSelect(m.id); }]];
  if (editable(m)) items.push(['编辑', function () { editMessage(m); }]);
  if (m.role === 'user' && m.type !== 'recalled') items.push(['撤回', function () { recallMessage(m); }]);
  items.push(['复制', function () { (navigator.clipboard ? navigator.clipboard.writeText(plainText(m)) : Promise.reject()).then(function () { toast('已复制'); }, function () { toast('复制失败'); }); }]);
  if (m.type === 'voice' && m.meta && m.meta.audio) { items.push([m.content ? '重新转文字' : '转文字', function () { transcribeLocal(m); }]); }
  items.push(['删除', async function () { await deleteMessages([m]); reloadChat(); }]);
  if (anchor) showMsgPop(items, anchor); else menuSheet('', items);
}

function isTyping(cid) { var r = rounds[cid]; return !!(r && r.active); }
function refreshTitle() {
  var t = $('chat-title'); if (!cur) return;
  if (isTyping(cur.id)) { t.className = 'typing-title'; t.innerHTML = '对方正在输入中<i>.</i><i>.</i><i>.</i>'; }
  else { t.className = ''; t.textContent = cur.name + (cur.offlineMode ? ' · 线下' : ''); }
}
function appendMsgNode(node) { $('msgs').appendChild(node); }

$('input').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; });
$('composer').addEventListener('submit', async function (e) {
  e.preventDefault();
  var v = $('input').value.trim(); if (!v) return;
  $('input').value = ''; $('input').style.height = 'auto';
  var m = { id: uid(cur.id), characterId: cur.id, role: 'user', type: cur.offlineMode ? 'offline' : 'text', content: v, ts: Date.now() };
  if (quoting) { m.meta = { quote: { content: quoting.content, name: quoting.name } }; setQuote(null); }
  await dbPut('messages', m);
  var n = msgNode(m); if (lastShownTs && m.ts - lastShownTs > 600000) appendMsgNode(h('div', { class: 'sysline', text: fmtTime(m.ts).replace(/:\d\d$/, '') }));
  if (n) appendMsgNode(n); lastShownTs = m.ts; scrollBottom();
  if (settings.autoReply) generateReply(); // 默认只发送，不回复：要你点「等回复」才会回
});
$('b-wait').onclick = function () { generateReply(); };

/* ---- 图片：压缩 / 灯箱 / 从相册发送 ---- */
/* 压缩：长边不超过 maxDim。o.alpha=true 保留透明（输出 webp/png），否则输出 jpeg。返回 { url, w, h } */
function compressImage(file, o) {
  o = o || {};
  return new Promise(function (res, rej) {
    var u = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(u);
      var k = Math.min(1, (o.maxDim || 512) / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * k)), hh = Math.max(1, Math.round(img.height * k));
      var cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
      var g = cv.getContext('2d');
      if (!o.alpha) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh); }
      g.drawImage(img, 0, 0, w, hh);
      var out;
      if (o.alpha) { out = cv.toDataURL('image/webp', o.quality || 0.8); if (out.indexOf('data:image/webp') !== 0) out = cv.toDataURL('image/png'); }
      else out = cv.toDataURL('image/jpeg', o.quality || 0.8);
      res({ url: out, w: w, h: hh });
    };
    img.onerror = function () { URL.revokeObjectURL(u); rej(new Error('这张图片读不了：' + (file.name || ''))); };
    img.src = u;
  });
}
function openLightbox(src) {
  var o = h('div', { class: 'lightbox', onclick: function () { o.remove(); } }, h('img', { src: src, alt: '' }));
  document.body.appendChild(o);
}
var IMG_SEND_MAX = 512;   /* 发给 AI 的图片：长边最多多少像素（越小越省 token）；质量 0.8 */
function openImagePicker() {
  if (!cur) return;
  var f = h('input', { type: 'file', accept: 'image/*', multiple: true });
  f.addEventListener('change', async function () {
    var files = Array.prototype.slice.call(f.files || []).slice(0, 6); if (!files.length) return;
    var ok = 0, bad = 0, before = 0, after = 0;
    for (var i = 0; i < files.length; i++) {
      try {
        var r = await compressImage(files[i], { maxDim: IMG_SEND_MAX, quality: 0.8 });
        var m = { id: uid(cur.id), characterId: cur.id, role: 'user', type: 'image', content: r.url, ts: Date.now() + i, meta: { w: r.w, h: r.h } };
        await dbPut('messages', m);
        if (lastShownTs && m.ts - lastShownTs > 600000) appendMsgNode(h('div', { class: 'sysline', text: fmtTime(m.ts).replace(/:\d\d$/, '') }));
        var n = msgNode(m); if (n) appendMsgNode(n); lastShownTs = m.ts; scrollBottom();
        ok++; before += files[i].size; after += r.url.length * 0.75;
      } catch (e) { bad++; }
    }
    if (ok) toast('已发送 ' + ok + ' 张图片（' + Math.round(before / 1024) + 'KB → ' + Math.round(after / 1024) + 'KB）' + (bad ? '，' + bad + ' 张失败' : '') + (settings.autoReply ? '' : '。点「等回复」让 TA 看图'));
    else toast('图片读取失败');
    if (ok && settings.autoReply) generateReply();
  });
  f.click();
}
$('input').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('composer').requestSubmit(); } });

/* ---------- 长按消息：在气泡旁边弹出的小菜单 ---------- */
var msgPop = null;
function closeMsgPop() { if (msgPop) { msgPop.remove(); msgPop = null; } }
/* items: [[文字, 函数], …]；anchor: 被长按的气泡元素 */
function showMsgPop(items, anchor) {
  closeMsgPop();
  var shade = h('div', { class: 'msgpop-shade' }), pop = h('div', { class: 'msgpop' }, h('i', { class: 'arrow' }));
  items.forEach(function (it) { pop.insertBefore(h('button', { type: 'button', text: it[0], onclick: function (e) { e.stopPropagation(); closeMsgPop(); it[1](); } }), pop.lastChild); });
  shade.appendChild(pop); document.body.appendChild(shade); msgPop = shade;
  /* 长按时手指还按在屏幕上，抬起后浏览器会补发一次点击落在这层遮罩上——刚弹出的 0.5 秒内不响应关闭，否则菜单一闪就没了 */
  var born = Date.now();
  ['touchstart', 'mousedown', 'click'].forEach(function (ev) { shade.addEventListener(ev, function (e) { if (e.target !== shade) return; e.preventDefault(); if (Date.now() - born > 500) closeMsgPop(); }, { passive: false }); });
  shade.addEventListener('contextmenu', function (e) { e.preventDefault(); if (Date.now() - born > 500) closeMsgPop(); });
  var r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, pw = pop.offsetWidth, ph = pop.offsetHeight, top, below = false, arrow = true;
  if (r.top - ph - 10 >= 56) top = r.top - ph - 10;
  else if (r.bottom + ph + 10 <= vh - 8) { top = r.bottom + 10; below = true; }
  else { top = Math.max(60, Math.min(vh - ph - 12, r.top + 12)); arrow = false; }   /* 气泡太高，上下都放不下：盖在气泡上面一点 */
  var left = Math.max(8, Math.min(vw - pw - 8, r.left + r.width / 2 - pw / 2));
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  var ar = pop.querySelector('.arrow');
  if (!arrow) ar.style.display = 'none';
  else { ar.style.left = Math.max(14, Math.min(pw - 14, r.left + r.width / 2 - left)) + 'px'; if (below) pop.classList.add('below'); }
}

/* ---------- 语音消息 ---------- */
var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;   /* 浏览器自带的实时语音识别（Chrome 有；有些内置浏览器没有） */
var SPEECH_LANGS = [['zh-CN', '中文（普通话）'], ['zh-TW', '中文（繁体）'], ['en-US', 'English'], ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['es-ES', 'Español'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['ru-RU', 'Русский']];
function asrLang() { return settings.asrLang || 'zh-CN'; }
function fmtDur(s) { return Math.max(1, Math.round(s || 0)) + '″'; }
var vAudio = null, vBtn = null;
function toggleVoice(btn, src) {
  if (vAudio && vBtn === btn && !vAudio.paused) { vAudio.pause(); btn.textContent = '▶'; return; }
  if (vAudio) { vAudio.pause(); if (vBtn) vBtn.textContent = '▶'; }
  vAudio = new Audio(src); vBtn = btn; btn.textContent = '⏸';
  vAudio.onended = function () { btn.textContent = '▶'; };
  vAudio.play().catch(function () { btn.textContent = '▶'; toast('播放失败'); });
}
/* 根据音量、停顿、语速粗略估一个语气提示（不是真的听出情绪，只是给模型的参考；情绪主要还是靠文字内容） */
function toneFromFrames(frames, text) {
  var peak = 0; frames.forEach(function (v) { if (v > peak) peak = v; });
  if (peak < 0.01) return '';
  var thr = Math.max(0.012, peak * 0.15), act = frames.filter(function (v) { return v > thr; });
  if (!act.length) return '';
  var avg = act.reduce(function (a, b) { return a + b; }, 0) / act.length;
  var sd = Math.sqrt(act.reduce(function (a, b) { return a + (b - avg) * (b - avg); }, 0) / act.length), out = [];
  if (avg < 0.03) out.push('声音偏轻'); else if (avg > 0.15) out.push('声音偏大');
  if (sd / avg > 0.7) out.push('起伏明显');
  var gaps = 0, run = 0, seen = false;
  frames.forEach(function (v) { if (v > thr) { if (seen && run >= 8) gaps++; run = 0; seen = true; } else run++; });
  if (gaps >= 2) out.push('停顿较多');
  var secs = act.length / 10;
  if (text && secs >= 1.5) {
    var cjk = /[一-鿿぀-ヿ가-힯]/.test(text), n = cjk ? text.replace(/\s/g, '').length : text.trim().split(/\s+/).length, r = n / secs;
    if (r > (cjk ? 5 : 3.3)) out.push('语速偏快'); else if (r < (cjk ? 2.2 : 1.5)) out.push('语速偏慢');
  }
  return out.join('、');
}
var VOICE_MAX = 60;   /* 单条语音最长多少秒 */
/* 录不了音时：说清楚原因（含环境信息，方便排查），并给备用办法——用手机系统自带录音机录，或选一个已有的音频文件 */
function voiceUnavailable(why, err) {
  var info = '页面地址类型：' + location.protocol + '\n安全环境(https/localhost)：' + (window.isSecureContext ? '是' : '否') + '\n浏览器开放的录音接口：' + (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? '有' : '没有') + '\nMediaRecorder：' + (window.MediaRecorder ? '有' : '没有') + (err ? '\n错误：' + (err.name || '') + ' ' + (err.message || '') : '');
  openSheet([h('h3', { text: '这里没法直接录音' }), h('div', { class: 'hint', text: why }),
    h('pre', { class: 'vdiag', text: info }),
    h('div', { class: 'hint', text: '备用办法：用手机系统自带的录音机录一段（或选一个已有的音频文件）发出去。这样不需要浏览器的麦克风权限，但没有实时转文字。部署到 https 网址（比如 GitHub Pages）就能直接录。' }),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn primary', text: '用系统录音机录', onclick: function () { closeSheet(); voiceFromFile(true); } }),
      h('button', { type: 'button', class: 'btn', text: '选择音频文件', onclick: function () { closeSheet(); voiceFromFile(false); } }),
      h('button', { type: 'button', class: 'btn', text: '关闭', onclick: closeSheet }))]);
}
/* 把一条语音消息放进聊天（录音和选文件共用） */
async function pushVoiceMsg(m) {
  await dbPut('messages', m);
  if (lastShownTs && m.ts - lastShownTs > 600000) appendMsgNode(h('div', { class: 'sysline', text: fmtTime(m.ts).replace(/:\d\d$/, '') }));
  var n = msgNode(m); if (n) appendMsgNode(n); lastShownTs = m.ts; scrollBottom();
  if (settings.autoReply) generateReply();
}
function voiceFromFile(capture) {
  if (!cur) return;
  var f = h('input', { type: 'file', accept: 'audio/*' }); if (capture) f.setAttribute('capture', 'microphone');
  f.addEventListener('change', async function () {
    var file = f.files && f.files[0]; if (!file) return;
    if (file.size > 4 * 1024 * 1024) { toast('音频太大了（超过 4MB），请选短一点的'); return; }
    var url = await new Promise(function (res, rej) { var rd = new FileReader(); rd.onload = function () { res(rd.result); }; rd.onerror = rej; rd.readAsDataURL(file); });
    var secs = await new Promise(function (res) {
      var a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = function () { res(isFinite(a.duration) && a.duration > 0 ? a.duration : 0); }; a.onerror = function () { res(0); }; a.src = url; setTimeout(function () { res(0); }, 3000);
    });
    if (!secs) secs = Math.max(1, Math.round(file.size / 6000));   /* 读不出时长就按大小估一个 */
    if (!/^data:audio\//.test(url)) url = url.replace(/^data:[^;,]*/, 'data:' + (file.type || 'audio/mp4'));
    await pushVoiceMsg({ id: uid(cur.id), characterId: cur.id, role: 'user', type: 'voice', content: '', ts: Date.now(), meta: { duration: Math.round(Math.min(secs, 600)), audio: url, tone: '', asr: '' } });
    if (cur.autoVoiceText !== false) toast((settings.voiceSend || 'audio') === 'audio' ? 'AI 回复你的时候会顺带把这条语音的文字写出来' : '这条语音没有文字，点气泡里的「转文字」');
  });
  f.click();
}
async function openVoiceRecorder() {
  if (!cur) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { voiceUnavailable('这个页面里浏览器没有开放录音功能（通常是因为不是 https 网址，或者这个浏览器不允许本地文件使用麦克风）。', null); return; }
  var stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { voiceUnavailable(e && e.name === 'NotAllowedError' ? '没拿到麦克风权限。本地文件页面有的浏览器每次都不让用麦克风，或者需要在系统设置里给这个浏览器开麦克风权限。' : '打不开麦克风。', e); return; }
  var autoOn = cur.autoVoiceText !== false, auto = autoOn && !!SpeechRec;
  var mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].filter(function (t) { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } })[0] || '';
  var rec;
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 }); }
  catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); voiceUnavailable('录音启动失败。', e); return; }
  var chunks = [], frames = [], transcript = '', baseText = '', t0 = Date.now(), done = false, rc = null, ac = null, an = null, buf = null, timer = null;
  rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
  try { ac = new (window.AudioContext || window.webkitAudioContext)(); an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaStreamSource(stream).connect(an); buf = new Float32Array(an.fftSize); } catch (e) { ac = null; an = null; }
  var timeEl = h('div', { class: 'vtime', text: '0:00' }), lvl = h('i');
  var live = h('div', { class: 'vlive', text: auto ? '正在听…说完点「发送」' : (!autoOn ? '已关闭自动转文字：发送后点气泡里的「转文字」' : '这个浏览器没有语音识别：发送后点气泡里的「转文字」') });
  var sendBtn = h('button', { type: 'button', class: 'btn primary', text: '发送' }), cancelBtn = h('button', { type: 'button', class: 'btn', text: '取消' });
  var pop = h('div', { class: 'voice-pop' }, h('div', { class: 'voice-card' }, h('div', { class: 'vrec' }, h('span', { class: 'dot' }), '正在录音'), timeEl, h('div', { class: 'vlevel' }, lvl), live, h('div', { class: 'btn-row' }, cancelBtn, sendBtn)));
  document.body.appendChild(pop);
  function stopRec() { return new Promise(function (res) { if (rec.state === 'inactive') return res(); rec.onstop = res; try { rec.stop(); } catch (e) { res(); } }); }
  function cleanup() {
    clearInterval(timer);
    try { if (rc) { rc.onend = null; rc.abort(); } } catch (e) {}
    try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {}
    stream.getTracks().forEach(function (t) { t.stop(); }); try { if (ac) ac.close(); } catch (e) {}
    pop.remove();
  }
  timer = setInterval(function () {
    var el = (Date.now() - t0) / 1000;
    if (an) { an.getFloatTimeDomainData(buf); var sq = 0; for (var i = 0; i < buf.length; i++) sq += buf[i] * buf[i]; var rms = Math.sqrt(sq / buf.length); frames.push(rms); lvl.style.width = Math.min(100, rms * 400) + '%'; }
    timeEl.textContent = Math.floor(el / 60) + ':' + ('0' + Math.floor(el % 60)).slice(-2);
    if (el >= VOICE_MAX) { clearInterval(timer); live.textContent = '已录满 ' + VOICE_MAX + ' 秒，点「发送」'; stopRec(); }
  }, 100);
  if (auto) {
    try {
      rc = new SpeechRec(); rc.lang = asrLang(); rc.continuous = true; rc.interimResults = true;
      rc.onresult = function (e) { var t = ''; for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; transcript = baseText + t; live.textContent = transcript || '正在听…'; };
      rc.onerror = function () {};
      rc.onend = function () { if (!done) { baseText = transcript ? transcript + (/[一-鿿぀-ヿ]$/.test(transcript) ? '' : ' ') : ''; try { rc.start(); } catch (e) {} } };   /* 连续识别中途会自己结束，接着开 */
      rc.start();
    } catch (e) { rc = null; }
  }
  rec.start(500);
  cancelBtn.onclick = function () { done = true; cleanup(); };
  sendBtn.onclick = async function () {
    if (done) return; done = true; sendBtn.disabled = true; sendBtn.textContent = '处理中…';
    var secs = (Date.now() - t0) / 1000;
    try { if (rc) rc.stop(); } catch (e) {}
    if (rc) await sleep(450);   /* 等识别器吐出最后一句 */
    await stopRec();
    var blob = new Blob(chunks, { type: (mime || 'audio/webm').split(';')[0] });
    if (secs < 0.8 || !blob.size) { cleanup(); toast('说话时间太短'); return; }
    var url = await new Promise(function (res, rej) { var rd = new FileReader(); rd.onload = function () { res(rd.result); }; rd.onerror = rej; rd.readAsDataURL(blob); });
    cleanup();
    var text = String(transcript || '').trim();
    var m = { id: uid(cur.id), characterId: cur.id, role: 'user', type: 'voice', content: text, ts: Date.now(), meta: { duration: Math.round(Math.min(secs, VOICE_MAX)), audio: url, tone: toneFromFrames(frames, text), asr: text ? 'live' : '' } };
    if (autoOn && !text) toast((settings.voiceSend || 'audio') === 'audio' ? 'AI 回复你的时候会顺带把这条语音的文字写出来' : (SpeechRec ? '没识别出文字，可以点「转文字」再试' : '这个浏览器没有语音识别，点气泡里的「转文字」手动转'));
    await pushVoiceMsg(m);
  };
}
$('b-plus').onclick = function () { if (cur) menuSheet('', [['🎤 语音', openVoiceRecorder], ['🎙 用系统录音机录 / 选音频文件', function () { voiceFromFile(true); }], ['🖼 图片', openImagePicker]]); };

/* AI 的语音：用浏览器自带的朗读（免费、不请求）。声音是系统的，不是角色本人的声音 */
function speakLang(t) { return /[぀-ヿ]/.test(t) ? 'ja-JP' : /[가-힯]/.test(t) ? 'ko-KR' : /[一-鿿]/.test(t) ? 'zh-CN' : 'en-US'; }
var spBtn = null;
function speakVoice(btn, text) {
  if (!window.speechSynthesis) { toast('这个浏览器不能朗读'); return; }
  var was = spBtn === btn; speechSynthesis.cancel(); if (spBtn) spBtn.textContent = '▶'; spBtn = null;
  if (was) return;
  var u = new SpeechSynthesisUtterance(text); u.lang = speakLang(text); spBtn = btn; btn.textContent = '⏸';
  u.onend = u.onerror = function () { btn.textContent = '▶'; if (spBtn === btn) spBtn = null; };
  speechSynthesis.speak(u);
}
/* 本机转文字（不走你的 API）：新版 Chrome 能直接把录音喂给识别器；旧的就「外放 + 麦克风听」 */
async function localTranscribe(dataUri, onTick) {
  if (!SpeechRec) throw new Error('这个浏览器没有语音识别，没法本机转文字。可以改用「用 API 转文字」');
  var mm = /^data:[^,]*;base64,([\s\S]*)$/.exec(dataUri || ''); if (!mm) throw new Error('这条语音的音频数据坏了');
  var bin = atob(mm[1]), u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  var AC = window.AudioContext || window.webkitAudioContext, ac = new AC(), buf;
  try { buf = await new Promise(function (res, rej) { var p = ac.decodeAudioData(u8.buffer, res, rej); if (p && p.catch) p.catch(rej); }); } catch (e) { try { ac.close(); } catch (e2) {} throw new Error('音频解码失败'); }
  var direct = typeof SpeechRec.available === 'function', dest = null, mic = null, src = ac.createBufferSource();
  src.buffer = buf;
  if (direct) { dest = ac.createMediaStreamDestination(); src.connect(dest); }
  else { src.connect(ac.destination); try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { try { ac.close(); } catch (e2) {} throw new Error('没拿到麦克风权限（本机转文字需要用麦克风听）'); } }
  return await new Promise(function (resolve, reject) {
    var rc = new SpeechRec(), text = '', base = '', fin = false;
    rc.lang = asrLang(); rc.continuous = true; rc.interimResults = true;
    function end() { if (fin) return; fin = true; clearTimeout(guard); try { rc.onend = null; rc.abort(); } catch (e) {} try { src.stop(); } catch (e) {} try { ac.close(); } catch (e) {} if (mic) mic.getTracks().forEach(function (t) { t.stop(); }); resolve(text.trim()); }
    rc.onresult = function (e) { var t = ''; for (var k = 0; k < e.results.length; k++) t += e.results[k][0].transcript; text = base + t; if (onTick) onTick(text); };
    rc.onerror = function (e) { if (e && e.error && e.error !== 'no-speech' && e.error !== 'aborted' && !fin) { fin = true; clearTimeout(guard); try { src.stop(); } catch (x) {} try { ac.close(); } catch (x) {} if (mic) mic.getTracks().forEach(function (t) { t.stop(); }); reject(new Error('识别失败：' + e.error)); } };
    rc.onend = function () { if (!fin) { base = text ? text + (/[一-鿿぀-ヿ]$/.test(text) ? '' : ' ') : ''; try { rc.start(); } catch (e) {} } };
    src.onended = function () { setTimeout(end, 1200); };
    var guard = setTimeout(end, (buf.duration + 6) * 1000);
    try { if (direct) rc.start(dest.stream.getAudioTracks()[0]); else rc.start(); } catch (e) { fin = true; clearTimeout(guard); try { ac.close(); } catch (x) {} reject(e); return; }
    src.start();
  });
}
async function transcribeLocal(m) {
  var direct = typeof SpeechRec === 'function' && typeof SpeechRec.available === 'function';
  toast(direct ? '正在转文字（在本机识别，不走 API）…' : '正在转文字：会外放这段语音，请保持安静…');
  try {
    var text = await localTranscribe(m.meta.audio, function (t) { /* 识别中不刷新界面 */ });
    if (!text) { toast('没识别出文字。可以试试「用 API 转文字」'); return; }
    m.content = text; m.meta.asr = 'local'; await dbPut('messages', m);
    if (cur && cur.id === m.characterId) reloadChat();
    toast('已转文字');
  } catch (e) { toast(e.message || '转文字失败'); }
}
/* 用 API 转文字（会请求 1 次）：Gemini 官方地址 → 用主模型听；其它 → 走反代的 /v1/audio/transcriptions（OpenAI 格式的 whisper 接口） */
async function transcribeAudio(dataUri) {
  var base = settings.baseUrl, key = settings.apiKey;
  if (!base) throw new Error('请先在「设置」里填写反代地址');
  var mm = /^data:([^;,]+)[^,]*;base64,([\s\S]*)$/.exec(dataUri || ''); if (!mm) throw new Error('这条语音的音频数据坏了');
  if (isGemini(base)) {
    var out = await callLLM({ base: base, key: key, model: settings.model, temperature: 0, stream: false, system: '你是语音转写工具。只输出语音里说的话，逐字转写，不要任何解释。听不清就输出空。',
      messages: [{ role: 'user', content: [{ type: 'text', text: '请转写这段语音（语言：' + asrLang() + '）：' }, { type: 'audio_data', mime: mm[1], data: mm[2] }] }] });
    return String(out || '').trim();
  }
  var bin = atob(mm[2]), arr = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  var fd = new FormData(); fd.append('file', new Blob([arr], { type: mm[1] }), 'voice.' + (mm[1].split('/')[1] || 'webm')); fd.append('model', settings.asrModel || 'whisper-1'); fd.append('language', asrLang().split('-')[0]);
  var res;
  try { res = await fetch(openaiUrl(base).replace(/\/chat\/completions$/, '/audio/transcriptions'), { method: 'POST', headers: { Authorization: 'Bearer ' + (key || '') }, body: fd }); }
  catch (e) { var ne = new Error('网络请求失败: ' + e.message); ne.title = '网络请求失败'; ne.raw = e.message; throw ne; }
  if (!res.ok) throw await httpError(res);
  var j = await res.json(); return String((j && j.text) || '').trim();
}
async function transcribeMsg(m) {
  toast('正在转文字…');
  try {
    var text = await transcribeAudio(m.meta.audio);
    if (!text) { toast('没识别出文字'); return; }
    m.content = text; m.meta.asr = 'api'; await dbPut('messages', m);
    if (cur && cur.id === m.characterId) reloadChat();
    toast('已转文字');
  } catch (e) { showError(e, { label: '语音转文字失败。点「重试」会再请求 1 次。', retry: function () { transcribeMsg(m); } }); }
}

/* 表情包面板 */
$('b-sticker').onclick = function () { openStickerPanel('all', false); };
async function openStickerPanel(catId, manage) {
  var inChat = $('s-chat').classList.contains('active'); if (!inChat) manage = true;
  var stickers = await dbAll('stickers'), cats = await dbAll('stickerCategories');
  var tabs = h('div', { class: 'stk-tabs' }), grid = h('div', { class: 'stk-grid' });
  function tab(id, name) {
    tabs.appendChild(h('button', { type: 'button', class: String(catId) === String(id) ? 'on' : '', text: name, onclick: function () { openStickerPanel(id, manage); } }));
  }
  var curCat = cats.find(function (c) { return String(c.id) === String(catId); });
  tab('all', '全部'); cats.forEach(function (c) { tab(c.id, c.name); });
  var list = stickers.filter(function (s) { return catId === 'all' || String(s.categoryId) === String(catId); });
  if (!list.length) grid.appendChild(h('div', { class: 'empty', style: 'grid-column:1/-1;padding:30px 0', text: '这里还没有表情包' }));
  list.forEach(function (st) {
    var cell = h('div', { class: 'stk', title: st.name });
    var img = h('img', { src: st.url, loading: 'lazy', alt: st.name });
    img.onerror = function () { cell.textContent = st.name; };
    cell.appendChild(img);
    cell.onclick = function () {
      if (manage) { confirmSheet('删除表情包「' + st.name + '」？', '删除', async function () { await dbDel('stickers', st.id); openStickerPanel(catId, manage); }, true); }
      else { closeSheet(); sendSticker(st); }
    };
    grid.appendChild(cell);
  });
  openSheet([h('h3', { text: manage ? '管理表情包（点一个删除）' : '发送表情包（' + list.length + '）' }), tabs, grid,
    manage ? h('div', { class: 'btn-row', style: 'margin-bottom:8px' },
      h('button', { class: 'btn', text: '＋ 新建分类', onclick: function () { addStickerCategory(function () { openStickerPanel(catId, manage); }); } }),
      curCat ? h('button', { class: 'btn', text: '重命名分类', onclick: function () { renameStickerCategory(curCat, function () { openStickerPanel(catId, manage); }); } }) : null,
      curCat ? h('button', { class: 'btn danger', text: '删除分类', onclick: function () { deleteStickerCategory(curCat, function () { openStickerPanel('all', manage); }); } }) : null) : null,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', text: '＋ 添加', onclick: function () { addStickerForm(cats, catId); } }),
      inChat ? h('button', { class: 'btn', text: manage ? '完成管理' : '管理', onclick: function () { openStickerPanel(catId, !manage); } }) : null,
      h('button', { class: 'btn', text: '关闭', onclick: closeSheet }))]);
}
function nameFromUrl(u) { try { var f = decodeURIComponent(String(u).split('?')[0].split('/').pop() || ''); return f.replace(/\.[a-z0-9]+$/i, '') || '表情'; } catch (e) { return '表情'; } }
/* 一段文字 -> [{name,url}]。每行「名称 网址」（名称和网址之间可以是空格 / 冒号 / 逗号 / 竖线 / Tab），也认 JSON 数组 */
function parseStickerLines(text) {
  var t = String(text || '').replace(/\r/g, '').trim(), out = [];
  if (t.charAt(0) === '[' || t.charAt(0) === '{') {
    try {
      var j = JSON.parse(t);
      (Array.isArray(j) ? j : (j.stickers || [])).forEach(function (x) { var u = x && (x.url || x.src); if (u) out.push({ name: String(x.name || x.title || '').trim() || nameFromUrl(u), url: String(u).trim() }); });
      if (out.length) return out;
    } catch (e) {}
  }
  var clean = function (s) { return s.replace(/^\s*(?:\d+[.、)）]\s*|[-*•]\s+)/, '').replace(/[\s:：,，|｜=＝>\-—]+$/, '').replace(/^[\s:：,，|｜=＝]+/, '').trim(); };
  t.split('\n').forEach(function (ln) {
    ln = ln.trim(); if (!ln || ln.charAt(0) === '#') return;
    var m = ln.match(/(https?:\/\/[^\s"'<>]+|data:image\/[^\s"'<>]+)/); if (!m) return;
    var name = clean(ln.slice(0, m.index)) || clean(ln.slice(m.index + m[0].length)) || nameFromUrl(m[0]);
    out.push({ name: name, url: m[0] });
  });
  return out;
}
var STK_MAX = 320;   /* 本地上传的表情包：长边最多多少像素（越小越省内存） */
async function stickerFromFile(file) {
  if (file.type === 'image/gif' && file.size <= 400 * 1024) {   /* 小 GIF 原样保留（保住动画） */
    var url = await new Promise(function (res, rej) { var rd = new FileReader(); rd.onload = function () { res(rd.result); }; rd.onerror = rej; rd.readAsDataURL(file); });
    return { url: url, kept: true };
  }
  var r = await compressImage(file, { maxDim: STK_MAX, quality: 0.8, alpha: /png|webp|gif/.test(file.type) });
  return { url: r.url, kept: false, anim: file.type === 'image/gif' };
}
function batchStickerForm(cats, catId) {
  var st = 'width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:8px';
  var ta = h('textarea', { placeholder: '每行一个：名称 网址\n例如：\n委屈巴巴 https://xxx.com/a.png\n开心：https://xxx.com/b.gif\n也可以直接粘贴 JSON 数组', style: st + ';min-height:150px;font-size:13px' });
  var sel = h('select', { style: st }, h('option', { value: '', text: '不分类' }));
  cats.forEach(function (c) { sel.appendChild(h('option', { value: String(c.id), text: c.name })); });
  if (catId !== 'all') sel.value = String(catId);
  var info = h('div', { class: 'hint', style: 'font-size:12.5px;color:var(--sub);margin-bottom:8px', text: '网址图片不会被压缩（它存在别人的服务器上，不占你的内存）。' });
  openSheet([h('h3', { text: '批量导入表情包' }), ta, h('button', { type: 'button', class: 'btn', style: 'width:100%;margin-bottom:8px', text: '读取 txt / Word / json 文件', onclick: function () {
      var f = h('input', { type: 'file', accept: '.txt,.md,.json,.docx,text/plain,application/json' });
      f.addEventListener('change', async function () {
        var file = f.files[0]; if (!file) return;
        try {
          var ext = ((file.name.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
          if (ext === 'doc') throw new Error('旧版 .doc 读不了，请另存为 .docx 或 .txt');
          var txt = ext === 'docx' ? await readDocxText(await file.arrayBuffer()) : await file.text();
          ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + '\n' : '') + txt; info.textContent = '已读入「' + file.name + '」，检查一下再点导入。';
        } catch (e) { toast('读取失败：' + e.message); }
      });
      f.click();
    } }), sel, info,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '导入', onclick: async function () {
        var items = parseStickerLines(ta.value); if (!items.length) { toast('没读到任何「名称 网址」'); return; }
        var have = {}; (await dbAll('stickers')).forEach(function (s) { have[s.url] = 1; });
        var add = [], dup = 0;
        items.forEach(function (it) { if (have[it.url]) { dup++; return; } have[it.url] = 1; add.push({ id: uid('sticker'), name: it.name, url: it.url, categoryId: sel.value || null }); });
        await dbBulkPut('stickers', add);
        toast('已导入 ' + add.length + ' 个' + (dup ? '，跳过 ' + dup + ' 个重复' : ''));
        openStickerPanel(catId, false);
      } }), h('button', { class: 'btn', text: '返回', onclick: function () { openStickerPanel(catId, false); } }))]);
}
function addStickerForm(cats, catId) {
  var name = h('input', { type: 'text', placeholder: '名称（也是让角色认识它的描述，如：委屈巴巴）', style: 'width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:8px' });
  var url = h('input', { type: 'text', placeholder: '图片网址 https://…', style: 'width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:8px' });
  var sel = h('select', { style: 'width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:8px' }, h('option', { value: '', text: '不分类' }));
  cats.forEach(function (c) { sel.appendChild(h('option', { value: String(c.id), text: c.name })); });
  if (catId !== 'all') sel.value = String(catId);
  var upBtn = h('button', { type: 'button', class: 'btn', style: 'width:100%;margin-bottom:8px', text: '上传本地图片（可多选，自动压缩）', onclick: function () {
    var f = h('input', { type: 'file', accept: 'image/*', multiple: true });
    f.addEventListener('change', async function () {
      var files = Array.prototype.slice.call(f.files || []); if (!files.length) return;
      toast('正在压缩 ' + files.length + ' 张…');
      var add = [], bad = 0, anim = 0, before = 0, after = 0;
      for (var i = 0; i < files.length; i++) {
        try {
          var r = await stickerFromFile(files[i]);
          add.push({ id: uid('sticker'), name: files[i].name.replace(/\.[^.]+$/, '') || '表情', url: r.url, categoryId: sel.value || null });
          before += files[i].size; after += r.url.length * 0.75; if (r.anim) anim++;
        } catch (e) { bad++; }
      }
      await dbBulkPut('stickers', add);
      toast('已添加 ' + add.length + ' 张（' + Math.round(before / 1024) + 'KB → ' + Math.round(after / 1024) + 'KB）' + (bad ? '，' + bad + ' 张失败' : '') + (anim ? '，' + anim + ' 张大动图变成了静态' : ''));
      stickersChanged(catId);
    });
    f.click();
  } });
  openSheet([h('h3', { text: '添加表情包' }), name, url, sel, h('div', { class: 'btn-row' },
    h('button', { class: 'btn primary', text: '添加', onclick: async function () {
      if (!name.value.trim() || !url.value.trim()) { toast('名称和网址都要填'); return; }
      await dbPut('stickers', { id: uid('sticker'), name: name.value.trim(), url: url.value.trim(), categoryId: sel.value || null });
      stickersChanged(catId);
    } }), h('button', { class: 'btn', text: '返回', onclick: function () { stickersChanged(catId); } })), upBtn,
    h('button', { type: 'button', class: 'btn', style: 'width:100%', text: '批量导入（粘贴 / txt / Word）', onclick: function () { batchStickerForm(cats, catId); } })]);
}
/* ---------- 表情包分类：新建 / 重命名 / 删除 ---------- */
function addStickerCategory(done) {
  nameSheet('新建表情包分类', '', async function (nm) { await dbPut('stickerCategories', { id: uid('cat'), name: nm }); toast('已新建「' + nm + '」'); if (done) done(); }, '例如：委屈 / 开心 / 日常');
}
function renameStickerCategory(cat, done) {
  nameSheet('重命名分类', cat.name, async function (nm) { cat.name = nm; await dbPut('stickerCategories', cat); if (done) done(); }, '分类名称');
}
function deleteStickerCategory(cat, done) {
  openSheet([h('h3', { text: '删除分类「' + cat.name + '」' }), h('div', { class: 'hint', text: '里面的表情包怎么处理？' }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '只删分类（表情包移到「未分类」）', onclick: async function () { closeSheet(); await dropCategory(cat, false); if (done) done(); } }),
      h('button', { class: 'btn danger', text: '连里面的表情包一起删', onclick: async function () { closeSheet(); await dropCategory(cat, true); if (done) done(); } }),
      h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
}
async function dropCategory(cat, withStickers) {
  var all = await dbAll('stickers'), mine = all.filter(function (s) { return String(s.categoryId) === String(cat.id); });
  for (var i = 0; i < mine.length; i++) { if (withStickers) await dbDel('stickers', mine[i].id); else { mine[i].categoryId = null; await dbPut('stickers', mine[i]); } }
  await dbDel('stickerCategories', cat.id);
  toast(withStickers ? '已删除分类和 ' + mine.length + ' 个表情包' : '已删除分类，' + mine.length + ' 个表情包移到了未分类');
}

/* ---------- 桌面「表情包」：全屏管理页（聊天里的 ☺ 面板不变） ---------- */
var stkCat = 'all';
async function renderStickerPage(catId) {
  if (catId !== undefined) stkCat = catId;
  var stickers = await dbAll('stickers'), cats = await dbAll('stickerCategories'), body = $('stk-body'); body.innerHTML = '';
  if (stkCat !== 'all' && stkCat !== 'null' && !cats.some(function (c) { return String(c.id) === String(stkCat); })) stkCat = 'all';
  var counts = {}; stickers.forEach(function (s) { var k = String(s.categoryId); counts[k] = (counts[k] || 0) + 1; });
  var tabs = h('div', { class: 'stk-tabs' });
  function tab(id, name, n) { tabs.appendChild(h('button', { type: 'button', class: String(stkCat) === String(id) ? 'on' : '', text: name + (n != null ? ' ' + n : ''), onclick: function () { renderStickerPage(id); } })); }
  tab('all', '全部', stickers.length); cats.forEach(function (c) { tab(c.id, c.name, counts[String(c.id)] || 0); });
  if (counts['null']) tab('null', '未分类', counts['null']);
  tabs.appendChild(h('button', { type: 'button', class: 'add', text: '＋ 分类', onclick: function () { addStickerCategory(function () { renderStickerPage(); }); } }));
  body.appendChild(tabs);
  var cat = cats.find(function (c) { return String(c.id) === String(stkCat); });
  if (cat) body.appendChild(h('div', { class: 'btn-row', style: 'margin:0 0 10px' },
    h('button', { type: 'button', class: 'btn', text: '重命名分类', onclick: function () { renameStickerCategory(cat, function () { renderStickerPage(); }); } }),
    h('button', { type: 'button', class: 'btn danger', text: '删除分类', onclick: function () { deleteStickerCategory(cat, function () { stkCat = 'all'; renderStickerPage(); }); } })));
  var list = stickers.filter(function (s) { return stkCat === 'all' || String(s.categoryId) === String(stkCat); });
  var grid = h('div', { class: 'stk-grid page' });
  if (!list.length) grid.appendChild(h('div', { class: 'empty', style: 'grid-column:1/-1;padding:40px 0', text: '这里还没有表情包\n点右上角「＋ 添加」' }));
  list.forEach(function (st) {
    var cell = h('div', { class: 'stk', title: st.name }, h('img', { src: st.url, loading: 'lazy', alt: st.name }));
    cell.firstChild.onerror = function () { cell.textContent = st.name; };
    cell.appendChild(h('span', { class: 'stk-name', text: st.name }));
    cell.onclick = function () {
      menuSheet(st.name, [
        ['移到其他分类', function () {
          menuSheet('移到哪个分类', [['不分类', function () { moveSticker(st, null); }]].concat(cats.map(function (c) { return [c.name, function () { moveSticker(st, c.id); }]; })));
        }],
        ['改名（也是角色认识它的描述）', function () { nameSheet('表情包名称', st.name, async function (nm) { st.name = nm; await dbPut('stickers', st); renderStickerPage(); }, '例如：委屈巴巴'); }],
        ['删除', function () { confirmSheet('删除表情包「' + st.name + '」？', '删除', async function () { await dbDel('stickers', st.id); renderStickerPage(); }, true); }]]);
    };
    grid.appendChild(cell);
  });
  body.appendChild(grid);
}
async function moveSticker(st, catId) { st.categoryId = catId; await dbPut('stickers', st); renderStickerPage(); toast('已移动'); }
onShow['s-stickers'] = function () { renderStickerPage(); };
$('b-stk-add').onclick = async function () { addStickerForm(await dbAll('stickerCategories'), stkCat === 'null' ? 'all' : stkCat); };
/* 添加/导入表情包之后：在全屏页里就刷新页面，在聊天面板里就刷新面板 */
function stickersChanged(catId) {
  if ($('s-stickers').classList.contains('active')) { closeSheet(); renderStickerPage(); } else openStickerPanel(catId, false);
}

async function sendSticker(st) {
  var m = { id: uid(cur.id), characterId: cur.id, role: 'user', type: 'sticker', content: st.url, ts: Date.now(), meta: { meaning: st.name } };
  await dbPut('messages', m);
  var n = msgNode(m); if (n) appendMsgNode(n); lastShownTs = m.ts; scrollBottom();
}

/* 把录音转成 16kHz 单声道 WAV（base64）：Gemini / OpenAI 格式都认 wav，webm 不一定认 */
async function audioToWavB64(dataUri) {
  var mm = /^data:[^,]*;base64,([\s\S]*)$/.exec(dataUri || ''); if (!mm) throw new Error('bad audio');
  var bin = atob(mm[1]), u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  var AC = window.AudioContext || window.webkitAudioContext, ac = new AC(), buf;
  try { buf = await new Promise(function (res, rej) { var p = ac.decodeAudioData(u8.buffer, res, rej); if (p && p.catch) p.catch(rej); }); } finally { try { ac.close(); } catch (e) {} }
  var rate = 16000, len = Math.max(1, Math.ceil(buf.duration * rate)), oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, len, rate);
  var src = oc.createBufferSource(); src.buffer = buf; src.connect(oc.destination); src.start();
  var pcm = (await oc.startRendering()).getChannelData(0), out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  function ws(o, t) { for (var k = 0; k < t.length; k++) out.setUint8(o + k, t.charCodeAt(k)); }
  ws(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); ws(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); ws(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (var j = 0; j < pcm.length; j++) { var v = Math.max(-1, Math.min(1, pcm[j])); out.setInt16(44 + j * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
  var bytes = new Uint8Array(out.buffer), str = ''; for (var q = 0; q < bytes.length; q += 8192) str += String.fromCharCode.apply(null, bytes.subarray(q, q + 8192));
  return btoa(str);
}
/* 组装提示词 */
async function buildPrompt(char) {
  var limit = char.contextLimit > 0 ? char.contextLimit : settings.defaultContext;
  var history = await pageMessages(char.id, null, limit);
  var lastAi = -1; history.forEach(function (m, i) { if (m.role === 'assistant' && !m.hidden && m.type !== 'pat' && m.type !== 'system') lastAi = i; });
  var wavs = {}, audioUsed = false, dictIds = [];
  if ((settings.voiceSend || 'audio') === 'audio') {
    for (var vi = lastAi + 1; vi < history.length; vi++) {
      var vm = history[vi];
      if (vm.type === 'voice' && vm.role === 'user' && vm.meta && vm.meta.audio) {
        try { wavs[vm.id] = await audioToWavB64(vm.meta.audio); audioUsed = true; if (!String(vm.content || '').trim()) dictIds.push(vm.id); } catch (e) { toast('这条语音没法转成可发送的音频，改发文字提示'); }
      }
    }
  }
  var changes = history.some(function (m) { return m.type === 'recalled' || (m.meta && m.meta.edited) || (m.type === 'system' && typeof m.content === 'string' && m.content.indexOf('[用户删除') === 0); });
  var apiMsgs = toApiMessages(history, { wav: wavs });
  var hasVoice = history.some(function (m) { return m.type === 'voice' && m.role === 'user' && m.meta && m.meta.audio; });
  var scan = history.slice(-settings.scanDepth).map(msgToText);
  var allBooks = await dbAll('worldBooks');
  var books = allBooks.filter(function (b) { return (char.worldBookIds || []).indexOf(b.id) !== -1; });
  var entries = triggeredEntries(books, scan, settings.worldBookMaxChars);
  var mems = selectMemories(await dbByIndex('memories', 'byChar', char.id), history.slice(-4).map(msgToText), settings.memoryLimit).all;
  var thought = null;
  if (char.injectThought) {
    var th = (await dbAllWithKeys('thoughts')).map(function (r) { return r.value; }).filter(function (t) { return t.characterId === char.id; }).sort(function (a, b) { return b.ts - a.ts; })[0];
    if (th) thought = th;
  }
  var preset = null;
  if (char.offlineMode && char.offlinePresetId) { try { preset = (await dbGet('offlinePresets', char.offlinePresetId)) || null; } catch (e) {} }
  var wantThought = !!(char.autoThought && char.autoThought.enabled);
  var pool = stickerPool(await dbAll('stickers'), char.stickerCategoryIds);
  var shown = sampleStickers(pool, settings.stickerPromptLimit);
  var system = buildSystem({ char: char, settings: settings, entries: entries, memories: mems, stickers: shown, thought: thought, preset: preset, wantThought: wantThought, voice: audioUsed ? 'audio' : hasVoice, dictate: dictIds.length, changes: changes, now: Date.now() });
  return { system: system, messages: apiMsgs, pool: pool, wantThought: wantThought, dictIds: dictIds, stats: { history: history.length, entries: entries.length, memories: mems.length, stickers: shown.length } };
}

/* 点「等回复」= 发一次请求。按钮永远可点：后台慢时可以再点一次，
 * 同一轮里谁先成功就用谁，后到的结果直接丢掉；全部失败才报错。 */
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
/* 模拟真人打字：每条气泡出现前等多久（毫秒）。想再慢/再快：改这里的数字，或在「设置」里调倍数 */
function bubbleDelay(content, first) {
  var k = Number(settings.bubbleSlow); if (!(k >= 0)) k = 1;
  if (document.hidden) return 0;   /* 页面在后台：不模拟打字，尽快把所有气泡存好 */
  var len = String(content || '').length;
  var ms = first ? 800 + Math.min(len * 80, 2000)      /* 第一条：基础 0.8 秒 + 每个字 0.08 秒，最多 2.8 秒 */
                 : 1100 + Math.min(len * 140, 3400);    /* 后面几条：基础 1.1 秒 + 每个字 0.14 秒，最多 4.5 秒 */
  return Math.round(ms * k);
}
/* 把模型听写出来的文字填进对应的语音消息（存进历史，转文字框直接显示） */
async function applyDictation(ids, texts) {
  if (!ids || !ids.length) return;
  var got = 0;
  for (var i = 0; i < ids.length; i++) {
    var tx = String(texts[i] || '').trim(); if (!tx || /^\[?听不清\]?$/.test(tx)) continue;
    var vm = await dbGet('messages', ids[i]); if (!vm || String(vm.content || '').trim()) continue;
    vm.content = tx; vm.meta = Object.assign({}, vm.meta, { asr: 'model' }); await dbPut('messages', vm); got++;
    var old = document.querySelector('.row[data-id="' + vm.id + '"]'), nn = msgNode(vm); if (old && nn) old.replaceWith(nn);
  }
  if (!got) toast('这次模型没有写出语音的文字，可以点气泡里的「转文字」');
}
async function generateReply(fresh) {
  var char = cur, box = $('msgs'), r = rounds[char.id];
  if (fresh || !r || !r.active || r.won) r = rounds[char.id] = { active: true, won: false, total: 0, fails: 0 };
  r.total++; refreshTitle();
  try {
    var prompt = await buildPrompt(char); prompt.chatId = char.id;
    var text = await callLLM({
      base: settings.baseUrl, key: settings.apiKey, model: settings.model, temperature: Number(settings.temperature),
      system: prompt.system, messages: prompt.messages, stream: settings.stream
    });
    if (!r.active || r.won) return;
    var dict = extractDictation(text);   /* 用户语音的文字也随回复一起回来，不另外请求 */
    var ex = extractThought(dict.reply), replyText = ex.reply;   /* 心声同理 */
    var items = char.offlineMode ? (replyText.trim() ? [{ type: 'offline', content: replyText.trim() }] : []) : parseReplyLines(splitReply(replyText, 12), prompt.pool, !!char.aiVoice), base = Date.now(), saved = [];
    if (!items.length) throw new Error('模型的回复里没有可显示的内容（只有找不到的表情包）。原始回复：' + text.slice(0, 200));
    r.won = true;
    items.forEach(function (it, i) {
      var m = { id: uid(char.id), characterId: char.id, role: 'assistant', type: it.type, content: it.content, ts: base + i };
      if (it.meta) m.meta = it.meta; saved.push(m);
    });
    await dbBulkPut('messages', saved);
    await applyDictation(prompt.dictIds, dict.texts);
    if (prompt.wantThought) {
      if (ex.thought) { await dbPut('thoughts', { characterId: char.id, heartfeltVoice: ex.thought.heartfeltVoice, randomJottings: ex.thought.randomJottings, ts: Date.now() }); refreshThoughtCloud(); }
      else toast('这次回复没带上心声（模型没按格式写）');
    }
    /* 先存好，再一条一条弹出来；中途退出聊天也不丢 */
    var told = false;
    for (var k = 0; k < saved.length; k++) {
      var m2 = saved[k];
      await sleep(bubbleDelay(m2.type === 'text' || m2.type === 'offline' ? m2.content : '', k === 0));
      playNotify();   /* 每条气泡都响一声 */
      if (!viewingChat(char.id)) { notifyNewMsg(char, m2, !told); told = true; }   /* 用户不在这个聊天里：未读+1，第一条弹通知条 */
      if (cur && cur.id === char.id && !box.querySelector('.row[data-id="' + m2.id + '"]')) {
        var n = msgNode(m2); if (n) { n.classList.add('pop'); box.appendChild(n); } lastShownTs = m2.ts; scrollBottom();
      }
    }
    r.active = false;
    maybeAutoSummarize(char);
  } catch (e) {
    r.fails++;
    showError(e);                                   /* 每个请求失败都弹，不等别的请求 */
    if (r.active && !r.won && r.fails >= r.total) r.active = false;   /* 全失败了，名字才恢复 */
  } finally { refreshTitle(); }
}

/* 居中报错弹窗：内容就是上游原话 */
var errRetry = null;
function showError(e, opts) {
  opts = opts || {};
  var title = e.title || (e.status ? e.status + ' ' + (e.statusText || '') : '出错了');   /* 上游状态码，如 400 / 429 / 503 */
  var body = e.raw != null && e.raw !== '' ? e.raw : e.message;
  if (opts.label) body = opts.label + '\n\n' + body;
  $('errpop-title').textContent = title.trim();
  $('errpop-body').textContent = body;
  $('errpop').hidden = false;
  errRetry = opts.retry || ((cur && s_chatActive()) ? function () { generateReply(true); } : null);
  $('errpop-retry').hidden = !errRetry;
}
function s_chatActive() { return $('s-chat').classList.contains('active'); }
function closeErr() { $('errpop').hidden = true; }
$('errpop-close').onclick = closeErr;
$('errpop-retry').onclick = function () { var f = errRetry; closeErr(); if (f) f(); };
$('errpop-copy').onclick = function () {
  var t = $('errpop-title').textContent + '\n' + $('errpop-body').textContent;
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('已复制'); }, function () { toast('复制失败'); });
};
$('errpop').addEventListener('click', function (e) { if (e.target === this) closeErr(); });

/* 聊天菜单 */
var FAB_ITEMS = [
  ['心声', 'M12 21s-7-4.4-9.3-9A5.3 5.3 0 0 1 12 6.5 5.3 5.3 0 0 1 21.3 12C19 16.6 12 21 12 21z', function () { openThoughts(cur); }],
  ['记忆', 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM8 17h11M9 8h6', function () { go('s-memory'); }],
  ['角色设置', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1.3-2-3.4-2.3.8a7 7 0 0 0-1.7-1L14.6 4h-4l-.4 2.1a7 7 0 0 0-1.7 1l-2.3-.8-2 3.4L6 12l-2 1.3 2 3.4 2.3-.8a7 7 0 0 0 1.7 1l.4 2.1h4l.4-2.1a7 7 0 0 0 1.7-1l2.3.8 2-3.4z', function () { editChar(cur.id); }],
  ['聊天设置', 'M4 7h9M17 7h3M4 17h3M11 17h9M13 4v6M7 14v6', function () { go('s-chatset'); }],
  ['重新生成上一轮回复', 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', regenerate],
  ['清空聊天记录', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6', function () { confirmSheet('清空和「' + cur.name + '」的全部聊天记录？', '清空', clearChat, true); }]
];
function closeFab() { $('fab').hidden = true; }
$('b-chatmenu').onclick = function () {
  var fab = $('fab'), st = $('fab-stack');
  if (!fab.hidden) { closeFab(); return; }
  st.innerHTML = '';
  FAB_ITEMS.forEach(function (it, i) {
    var b = h('button', { type: 'button', title: it[0], 'aria-label': it[0], onclick: function (e) { e.stopPropagation(); closeFab(); it[2](); } });
    b.style.animationDelay = (i * 40) + 'ms';
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + it[1] + '"/></svg>';
    st.appendChild(b);
  });
  fab.hidden = false;
};
$('fab').addEventListener('click', function (e) { if (e.target === this) closeFab(); });
async function regenerate() {
  var tail = await pageMessages(cur.id, null, 30), del = [];
  for (var i = tail.length - 1; i >= 0; i--) {
    if (tail[i].role === 'assistant' && !tail[i].hidden) del.push(tail[i]); else break;
  }
  for (var j = 0; j < del.length; j++) await dbDel('messages', del[j].id);
  await reloadChat(); generateReply(true);
}
async function clearChat() {
  var all = await pageMessages(cur.id, null, 1e9);
  var tx = db.transaction('messages', 'readwrite'), os = tx.objectStore('messages');
  all.forEach(function (m) { os.delete(m.id); });
  await new Promise(function (r) { tx.oncomplete = r; });
  reloadChat(); toast('已清空');
}

/* ---------- 消息提示音 / 未读红点 / 顶部通知条 / 系统通知 ---------- */
function notifySrc() { return notifyFile || settings.notifyUrl || ''; }
function playNotify() {
  try { var src = notifySrc(); if (!src) return; var a = new Audio(src); a.play().catch(function () {}); } catch (e) {}
}
var unread = {};   /* { 角色id: 未读条数 }，存在 settings 仓库的 unread 项里，刷新页面也在 */
async function loadUnread() { try { var r = await dbGet('settings', 'unread'); unread = (r && r.value) || {}; } catch (e) { unread = {}; } }
function saveUnread() { dbPut('settings', { key: 'unread', value: unread }).catch(function () {}); }
function badgeNode(n) { return h('span', { class: 'ubadge', text: n > 99 ? '99+' : String(n) }); }
/* 用户现在是不是正看着这个角色的聊天 */
function viewingChat(cid) { return !!(cur && cur.id === cid && s_chatActive() && !document.hidden); }
/* 刷新桌面「聊天」图标和角色列表上的红色数字 */
function refreshBadges() {
  var total = 0; Object.keys(unread).forEach(function (k) { total += unread[k] || 0; });
  document.querySelectorAll('.app[data-id="聊天"]').forEach(function (a) {
    var b = a.querySelector(':scope > .ubadge'); if (b) b.remove();
    if (total) a.appendChild(badgeNode(total));
  });
  document.querySelectorAll('#char-list .char[data-cid]').forEach(function (row) {
    var n = unread[row.getAttribute('data-cid')] || 0, b = row.querySelector('.ubadge'); if (b) b.remove();
    if (n) row.appendChild(badgeNode(n));
  });
  try { document.title = total ? '(' + total + ') 小手机' : '小手机'; } catch (e) {}
}
function clearUnread(cid) { if (unread[cid]) { delete unread[cid]; saveUnread(); refreshBadges(); } }
/* 角色的一条新消息到了，但用户没在看这个聊天 */
function notifyNewMsg(char, m, isFirst) {
  unread[char.id] = (unread[char.id] || 0) + 1; saveUnread(); refreshBadges();
  if (!isFirst) return;
  var text = msgToText(m).replace(/\n/g, ' ').slice(0, 60);
  if (document.hidden) { sysNotify(char, text); return; }
  showBanner(char, text);
}
var bannerTimer = null;
function showBanner(char, text) {
  var old = document.getElementById('msg-banner'); if (old) old.remove(); clearTimeout(bannerTimer);
  var b = h('div', { id: 'msg-banner', class: 'banner', onclick: function () { b.remove(); if (s_chatActive() && nav[nav.length - 1] === 's-chat') nav.pop(); openChat(char.id); } },
    avatarNode(char.avatar, char.name), h('div', { class: 'bn-main' }, h('b', { text: char.name }), h('span', { text: text })));
  document.body.appendChild(b); requestAnimationFrame(function () { b.classList.add('on'); });
  bannerTimer = setTimeout(function () { b.classList.remove('on'); setTimeout(function () { b.remove(); }, 300); }, 4500);
}
/* 页面在后台（切到别的 App / 锁屏）时的系统通知：要在「API设置」里打开并允许通知；不同浏览器支持不一样 */
function sysNotify(char, text) {
  if (!settings.sysNotify || !('Notification' in window) || Notification.permission !== 'granted') return;
  var opt = { body: text, tag: 'chat-' + char.id, renotify: true, data: { cid: char.id }, icon: /^data:image|^https?:/.test(char.avatar || '') ? char.avatar : undefined };
  function direct() { try { var n = new Notification(char.name, opt); n.onclick = function () { window.focus(); openChatFromOutside(char.id); n.close(); }; } catch (e) {} }
  /* 优先走 Service Worker 通知：点击后由 sw.js 把页面切到对应聊天（安卓 Chrome 也只支持这种） */
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(function (reg) { if (reg && reg.showNotification) reg.showNotification(char.name, opt).catch(direct); else direct(); }, direct);
      return;
    }
  } catch (e) {}
  direct();
}
document.addEventListener('visibilitychange', function () { if (!document.hidden && cur && viewingChat(cur.id)) clearUnread(cur.id); });

/* ---------- 聊天记录搜索 / 导出 ---------- */
var searchHits = [], searchTimer = null;
$('b-search').onclick = function () { go('s-search'); };
onShow['s-search'] = function () { $('search-q').value = ''; $('search-d1').value = ''; $('search-d2').value = ''; runSearch(); setTimeout(function () { $('search-q').focus(); }, 320); };
function snippetNode(text, kw) {
  var t = String(text).replace(/\s+/g, ' '), i = kw ? t.toLowerCase().indexOf(kw) : -1, st = i > 30 ? i - 30 : 0, seg = t.slice(st, st + 120), d = h('div', { class: 'c' });
  if (st > 0) d.appendChild(document.createTextNode('…'));
  if (!kw) { d.appendChild(document.createTextNode(seg)); return d; }
  var low = seg.toLowerCase(), p = 0, j;
  while ((j = low.indexOf(kw, p)) !== -1) { d.appendChild(document.createTextNode(seg.slice(p, j))); d.appendChild(h('mark', { text: seg.slice(j, j + kw.length) })); p = j + kw.length; }
  d.appendChild(document.createTextNode(seg.slice(p))); return d;
}
async function runSearch() {
  var kw = $('search-q').value.trim().toLowerCase(), d1 = $('search-d1').value, d2 = $('search-d2').value;
  var from = d1 ? new Date(d1 + 'T00:00:00').getTime() : 0, to = d2 ? new Date(d2 + 'T23:59:59.999').getTime() : Infinity;
  var list = $('search-list'), cnt = $('search-count'); list.innerHTML = '';
  if (!kw && !d1 && !d2) { searchHits = []; cnt.textContent = '输入关键词，或选一个日期范围'; return; }
  var all = await pageMessages(cur.id, null, 1e9);
  searchHits = all.filter(function (m) {
    if (m.hidden || m.type === 'system' || m.type === 'pat') return false;
    if (m.ts < from || m.ts > to) return false;
    return !kw || msgToText(m).toLowerCase().indexOf(kw) !== -1;
  });
  cnt.textContent = '共 ' + searchHits.length + ' 条' + (searchHits.length > 200 ? '（列表只显示最新 200 条，导出包含全部）' : '') + (searchHits.length ? '，点一条跳到聊天里的位置' : '');
  searchHits.slice(-200).reverse().forEach(function (m) {
    list.appendChild(h('div', { class: 'item', onclick: function () { jumpToMsg(m.id); } },
      h('div', { class: 't' }, h('b', { text: m.role === 'user' ? '我' : cur.name }), h('span', { class: 'badge', text: fmtTime(m.ts).replace(/:\d\d$/, '') })),
      snippetNode(msgToText(m), kw)));
  });
}
function scheduleSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); }
$('search-q').addEventListener('input', scheduleSearch);
$('search-d1').addEventListener('change', runSearch); $('search-d2').addEventListener('change', runSearch);
async function jumpToMsg(id) {
  var all = await pageMessages(cur.id, null, 1e9), i = all.findIndex(function (m) { return m.id === id; }); if (i < 0) return;
  back();
  $('msgs').innerHTML = ''; oldest = null; lastShownTs = 0; pinUntil = 0;
  renderPage(all.slice(Math.max(0, i - 15)), false);
  var row = $('msgs').querySelector('.row[data-id="' + id + '"]');
  if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('hit'); setTimeout(function () { row.classList.remove('hit'); }, 2200); }
}
function exportHits(kind) {
  if (!searchHits.length) { toast('没有可导出的消息'); return; }
  var name = cur.name + '-聊天记录-' + new Date().toISOString().slice(0, 10);
  if (kind === 'json') downloadBlob(name + '.json', new Blob([JSON.stringify({ format: 'myphone-chat-export', character: cur.name, count: searchHits.length, messages: searchHits }, null, 1)], { type: 'application/json' }));
  else downloadBlob(name + '.txt', new Blob([searchHits.map(function (m) { return '[' + fmtTime(m.ts) + '] ' + (m.role === 'user' ? (cur.userNickname || '我') : cur.name) + '：' + msgToText(m); }).join('\n')], { type: 'text/plain' }));
  toast('已导出 ' + searchHits.length + ' 条');
}
$('search-exp-txt').onclick = function () { exportHits('txt'); };
$('search-exp-json').onclick = function () { exportHits('json'); };

/* ---------- 每个角色单独的聊天记录：条数统计 / 导出 / 导入（入口在角色设置里） ---------- */
function isRealMsg(m) { return !m.hidden && m.type !== 'system' && m.type !== 'pat'; }
/* 数一数聊了多少条（逐条读取，不把全部消息一次性装进内存） */
function chatStats(cid) {
  return new Promise(function (res, rej) {
    var idx = db.transaction('messages').objectStore('messages').index('byChar'), st = { total: 0, me: 0, ai: 0, first: 0, last: 0 };
    var q = idx.openCursor(IDBKeyRange.bound([cid, -Infinity, ''], [cid, Infinity, '￿']));
    q.onsuccess = function () {
      var c = q.result; if (!c) return res(st);
      var m = c.value; if (isRealMsg(m) && m.type !== 'recalled') { st.total++; if (m.role === 'user') st.me++; else st.ai++; if (!st.first || m.ts < st.first) st.first = m.ts; if (m.ts > st.last) st.last = m.ts; }
      c.continue();
    };
    q.onerror = function () { rej(q.error); };
  });
}
async function exportChatLog(c, light) {
  toast('正在导出…');
  var all = (await pageMessages(c.id, null, 1e9)).filter(function (m) { return !m.hidden; });
  if (light) all = all.map(function (m) {
    if (m.type === 'image') return Object.assign({}, m, { content: '', meta: Object.assign({}, m.meta, { omitted: 'image' }) });
    if (m.type === 'voice' && m.meta && m.meta.audio) { var mm = Object.assign({}, m.meta); delete mm.audio; mm.omitted = 'audio'; return Object.assign({}, m, { meta: mm }); }
    return m;
  });
  var out = { format: 'myphone-chat-export', version: 1, exportedAt: Date.now(), character: { id: c.id, name: c.name }, count: all.filter(isRealMsg).length, messages: all };
  downloadBlob(c.name + '-聊天记录-' + new Date().toISOString().slice(0, 10) + '.json', new Blob([JSON.stringify(out)], { type: 'application/json' }));
  toast('已导出 ' + out.count + ' 条消息');
}
function importChatLog(c, done) {
  var f = h('input', { type: 'file', accept: '.json,application/json' });
  f.addEventListener('change', async function () {
    var file = f.files[0]; if (!file) return;
    var data; try { data = JSON.parse(await file.text()); } catch (e) { toast('文件不是有效的 JSON'); return; }
    var list = Array.isArray(data) ? data : (data && data.format === 'myphone-chat-export' ? data.messages : (data && data.format === 'myphone-v1' ? (data.messages || []).filter(function (m) { return m.characterId === c.id; }) : null));
    if (!list || !list.length) { toast('没找到聊天记录（需要本软件导出的聊天记录文件）'); return; }
    list = list.filter(function (m) { return m && m.role && m.ts && (m.type || m.content != null); });
    var n = list.filter(isRealMsg).length;
    openSheet([h('h3', { text: '导入 ' + n + ' 条消息到「' + c.name + '」' }), h('div', { class: 'hint', text: '合并：保留现有记录，只补上没有的（相同的消息不会重复）。覆盖：先清空这个角色现有的全部聊天记录再导入。' }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', text: '合并', onclick: function () { closeSheet(); run(false); } }),
        h('button', { class: 'btn danger', text: '覆盖', onclick: function () { closeSheet(); run(true); } }),
        h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
    async function run(replace) {
      toast('导入中…');
      try {
        var have = {};
        if (replace) { var olds = await pageMessages(c.id, null, 1e9); for (var oi = 0; oi < olds.length; oi++) await dbDel('messages', olds[oi].id); }
        else (await pageMessages(c.id, null, 1e9)).forEach(function (m) { have[m.id] = true; have[m.role + '|' + m.ts + '|' + (m.content || '').slice(0, 40)] = true; });
        var add = [];
        list.forEach(function (m) {
          var k = m.role + '|' + m.ts + '|' + (m.content || '').slice(0, 40); if (!replace && ((m.id && have[m.id]) || have[k])) return;
          var x = Object.assign({}, m, { characterId: c.id }); if (!x.id || (!replace && have[x.id])) x.id = uid(c.id); add.push(x);
        });
        await dbBulkPut('messages', add);
        toast('已导入 ' + add.length + ' 条' + (list.length - add.length > 0 ? '，跳过重复 ' + (list.length - add.length) + ' 条' : ''));
        if (cur && cur.id === c.id) reloadChat();
        if (done) done();
      } catch (e) { toast('导入失败：' + e.message); }
    }
  });
  f.click();
}

/* ---------- 心声页 ---------- */
var thoughtChar = null;
function openThoughts(c) { thoughtChar = c; go('s-thoughts'); }
async function charThoughts(cid) {
  return (await dbAllWithKeys('thoughts')).filter(function (r) { return r.value.characterId === cid; })
    .sort(function (a, b) { return b.value.ts - a.value.ts; });
}
async function renderThoughts() {
  var c = thoughtChar; if (!c) return;
  $('th-title').textContent = c.name + ' · 心声';
  var rows = await charThoughts(c.id), body = $('th-body'); body.innerHTML = '';
  if (!rows.length) { body.appendChild(h('div', { class: 'empty', text: '还没有心声。\n在「角色设置」里打开「自动更新心声」，之后 TA 每次回复你，都会顺带写一条（不额外请求）。' })); body.firstChild.style.whiteSpace = 'pre-line'; return; }
  var t = rows[0].value;
  body.appendChild(h('div', { class: 'th-card' }, h('div', { class: 'th-cap', text: '最新 · ' + fmtTime(t.ts).replace(/:\d\d$/, '') }),
    t.heartfeltVoice ? h('div', { class: 'th-voice', text: '“' + t.heartfeltVoice + '”' }) : null, t.randomJottings ? h('div', { class: 'th-jot', text: t.randomJottings }) : null));
  if (rows.length > 1) {
    body.appendChild(h('div', { class: 'group-title', text: '历史记录（' + (rows.length - 1) + '）' }));
    var g = h('div', { class: 'group' });
    rows.slice(1).forEach(function (r) {
      g.appendChild(h('div', { class: 'item', onclick: function () {
        openSheet([h('h3', { text: fmtTime(r.value.ts).replace(/:\d\d$/, '') }), h('div', { class: 'th-voice', text: '“' + (r.value.heartfeltVoice || '') + '”' }), h('div', { class: 'th-jot', text: r.value.randomJottings || '' }),
          h('div', { class: 'btn-row', style: 'margin-top:12px' },
            h('button', { class: 'btn danger', text: '删除', onclick: async function () { closeSheet(); await dbDel('thoughts', r.key); renderThoughts(); } }),
            h('button', { class: 'btn', text: '关闭', onclick: closeSheet }))]);
      } }, h('div', { class: 't' }, h('b', { text: fmtTime(r.value.ts).replace(/:\d\d$/, '') })), h('div', { class: 'c', text: r.value.heartfeltVoice || r.value.randomJottings })));
    });
    body.appendChild(g);
  }
}
onShow['s-thoughts'] = renderThoughts;

/* ---------- 点角色头像：弹出云朵气泡，显示最新的心声和散记 ----------
 * 每次回复生成新心声时，如果云朵开着，会直接换成最新的；历史记录在聊天页右上角的心声图标里。 */
var cloudEl = null, cloudAnchor = null;
function closeCloud() { if (cloudEl) { cloudEl.remove(); cloudEl = null; cloudAnchor = null; } }
async function fillCloud() {
  if (!cloudEl || !cur) return;
  var rows = await charThoughts(cur.id), box = cloudEl.querySelector('.cloud-body'); box.innerHTML = '';
  if (!rows.length) { box.appendChild(h('div', { class: 'cl-empty', text: '还没有心声。\n在角色设置里打开「每次回复都更新心声」，TA 之后每次回复你都会顺带写一条。' })); return; }
  var t = rows[0].value;
  box.appendChild(h('div', { class: 'cl-cap', text: '💭 ' + cur.name + ' 的心声 · ' + fmtTime(t.ts).replace(/:\d\d$/, '').slice(5) }));
  if (t.heartfeltVoice) box.appendChild(h('div', { class: 'cl-voice', text: '“' + t.heartfeltVoice + '”' }));
  if (t.randomJottings) box.appendChild(h('div', { class: 'cl-jot', text: t.randomJottings }));
  placeCloud();
}
function placeCloud() {
  if (!cloudEl || !cloudAnchor) return;
  var r = cloudAnchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, cw = cloudEl.offsetWidth, ch = cloudEl.offsetHeight;
  var left = Math.max(10, Math.min(vw - cw - 10, r.left - 4)), top = r.bottom + 16, up = false;
  if (top + ch > vh - 70 && r.top - ch - 16 > 60) { top = r.top - ch - 16; up = true; }
  cloudEl.classList.toggle('up', up); cloudEl.style.left = left + 'px'; cloudEl.style.top = top + 'px';
  cloudEl.style.setProperty('--tail', Math.max(14, Math.min(cw - 30, r.left + r.width / 2 - left - 6)) + 'px');
}
function showThoughtCloud(anchor) {
  if (cloudEl) { closeCloud(); return; }
  var shade = h('div', { class: 'cloud-shade' }), c = h('div', { class: 'cloud' }, h('i', { class: 't1' }), h('i', { class: 't2' }), h('div', { class: 'cloud-body' }),
    h('button', { type: 'button', class: 'cl-more', text: '查看全部心声 ›', onclick: function (e) { e.stopPropagation(); closeCloud(); openThoughts(cur); } }));
  shade.appendChild(c); document.body.appendChild(shade); cloudEl = shade; cloudAnchor = anchor;
  shade.addEventListener('click', function (e) { if (e.target === shade) closeCloud(); });
  fillCloud();
}
/* 新心声写进数据库后调用：云朵开着就换成最新的 */
function refreshThoughtCloud() { if (cloudEl) fillCloud(); }

/* ---------- 记忆页 ---------- */
var KIND = { summary: '总结', refined: '精炼', note: '记忆' };
async function renderMemory() {
  $('mem-title').textContent = cur.name + ' · 记忆';
  var mems = (await dbByIndex('memories', 'byChar', cur.id)).sort(function (a, b) { return b.ts - a.ts; });
  var layer = selectMemories(mems, [], settings.memoryLimit), injected = {};
  layer.core.forEach(function (m) { injected[m.id] = '常驻'; }); layer.recent.forEach(function (m) { injected[m.id] = '近期'; });
  var body = $('mem-body'); body.innerHTML = '';
  body.appendChild(h('div', { class: 'group-title', text: '三层记忆：「常驻」和最近 ' + settings.memoryLimit + ' 条（近期）每次都带；更早的历史记忆只有聊天里出现相关关键词时才带入。共 ' + mems.length + ' 条' }));
  if (!mems.length) { body.appendChild(h('div', { class: 'empty', text: '还没有记忆。点「总结」手动生成，或在角色设置里开启自动总结。' })); return; }
  var g = h('div', { class: 'group' });
  mems.forEach(function (m) {
    g.appendChild(h('div', { class: 'item', onclick: function () { editMemory(m); } },
      h('div', { class: 't' }, h('b', { text: fmtTime(m.ts).replace(/:\d\d$/, '') }),
        h('span', { class: 'badge' + (m.kind === 'refined' ? ' acc' : ''), text: KIND[m.kind] || m.kind }),
        injected[m.id] ? h('span', { class: 'badge on', text: injected[m.id] }) : null),
      h('div', { class: 'c', text: m.content })));
  });
  body.appendChild(g);
}
onShow['s-memory'] = renderMemory;
function editMemory(m) {
  textSheet('编辑记忆', m.content, [
    { text: '保存', cls: 'primary', fn: async function (v) { m.content = v; await dbPut('memories', m); renderMemory(); } },
    { text: m.core ? '取消常驻' : '设为常驻', fn: async function (v) { m.content = v; m.core = !m.core; if (!m.core) delete m.core; await dbPut('memories', m); renderMemory(); toast(m.core ? '已设为常驻，每次都会带入' : '已取消常驻'); } },
    { text: '删除', cls: 'danger', fn: async function () { await dbDel('memories', m.id); renderMemory(); } },
    { text: '取消' }]);
}
$('b-mem-add').onclick = function () {
  function add(core) { return async function (v) {
    if (!v.trim()) return;
    var m = { id: uid('mem'), characterId: cur.id, content: v.trim(), ts: Date.now(), kind: 'note' }; if (core) m.core = true;
    await dbPut('memories', m); renderMemory();
  }; }
  textSheet('新增记忆', '', [{ text: '保存', cls: 'primary', fn: add(false) }, { text: '保存为常驻', fn: add(true) }, { text: '取消' }],
    '普通记忆在聊天里出现相关关键词时才会带入；「常驻」的记忆每次都带（适合核心设定和底线规则）。');
};
var sumBusy = {}, sumBlocked = {};   /* sumBusy：同一角色同时只允许 1 个总结请求；sumBlocked：自动总结失败后暂停，等你点「重试」 */
async function summarizeNow(char, silent) {
  if (sumBusy[char.id]) { if (!silent) toast('正在总结中，请稍等'); return false; }
  sumBusy[char.id] = true;
  try {
    var since = char.lastSummaryTs || 0;
    var recent = (await pageMessages(char.id, null, 120)).filter(function (m) { return m.ts > since && !m.hidden && m.type !== 'system'; });
    if (recent.length < 2) { if (!silent) toast('没有需要总结的新消息'); return false; }
    var text = await summarizeMessages(char, recent);   /* 只请求这 1 次 */
    await dbPut('memories', { id: uid('mem'), characterId: char.id, content: text, ts: Date.now(), kind: 'summary' });
    char.lastSummaryTs = recent[recent.length - 1].ts; await dbPut('characters', char);
    sumBlocked[char.id] = false;
    return true;
  } finally { sumBusy[char.id] = false; }
}
async function runSummary(char, auto) {
  if (!auto) toast('正在总结…');
  try {
    if (await summarizeNow(char, auto)) toast(auto ? '已自动总结一条记忆' : '已生成一条总结');
    if ($('s-memory').classList.contains('active') && cur && cur.id === char.id) renderMemory();
  } catch (e) {
    if (auto) sumBlocked[char.id] = true;
    showError(e, { label: (auto ? '自动总结失败' : '总结失败') + '。点「重试」会再请求 1 次。', retry: function () { sumBlocked[char.id] = false; runSummary(char, false); } });
  }
}
$('b-mem-sum').onclick = function () { runSummary(cur, false); };
async function maybeAutoSummarize(char) {
  try {
    var am = char.autoMemory || {};
    if (!am.enabled || sumBlocked[char.id] || sumBusy[char.id]) return;
    var n = await countMessagesAfter(char.id, char.lastSummaryTs || 0);
    if (n >= (am.interval || 20)) runSummary(char, true);
  } catch (e) { toast('自动总结检查失败：' + e.message.slice(0, 60)); }
}
$('b-mem-refine').onclick = async function () {
  var mems = pickMemories(await dbByIndex('memories', 'byChar', cur.id), 9999);
  if (mems.length < 2) { toast('记忆太少，不需要精炼'); return; }
  var total = mems.reduce(function (n, m) { return n + m.content.length; }, 0);
  var inp = h('input', { type: 'number', value: Math.min(1500, Math.max(300, Math.round(total / 3))), style: 'width:100%;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--bg)' });
  openSheet([h('h3', { text: '精炼记忆' }), h('div', { class: 'hint', style: 'color:var(--sub);font-size:13px;margin-bottom:8px', text: '把当前带入提示词的 ' + mems.length + ' 条记忆（共 ' + total + ' 字）合并成一份。生成后你可以先看看再决定是否保存，不会直接覆盖。目标字数：' }), inp,
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', { class: 'btn primary', text: '开始精炼', onclick: async function () {
        var target = Number(inp.value) || 1500; closeSheet(); toast('正在精炼…');
        try {
          var out = await refineMemories(cur, mems, target);
          textSheet('精炼结果（可编辑）', out, [
            { text: '保存为精炼记忆', cls: 'primary', fn: async function (v) {
              await dbPut('memories', { id: uid('mem'), characterId: cur.id, content: v.trim(), ts: Date.now(), kind: 'refined' }); renderMemory(); toast('已保存'); } },
            { text: '放弃' }], '保存后，这条精炼记忆会取代它之前的总结带入提示词；旧记忆仍保留在列表里，不会被删除。');
        } catch (e) { openSheet([h('h3', { text: '精炼失败' }), h('pre', { text: e.message }), h('button', { class: 'btn', text: '关闭', onclick: closeSheet })]); }
      } }), h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
};

/* ---------- 角色设置 ---------- */
function field(label, input, hint) { return h('div', { class: 'field' }, h('label', { text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : null); }
function switchEl(checked, onchange) {
  var i = h('input', { type: 'checkbox' }); i.checked = !!checked; if (onchange) i.addEventListener('change', function () { onchange(i.checked); });
  return { el: h('label', { class: 'switch' }, i, h('i')), input: i };
}
function pickAvatar(cb) {
  var inp = h('input', { type: 'file', accept: 'image/*' });
  inp.onchange = function () {
    var f = inp.files[0]; if (!f) return;
    var img = new Image(), url = URL.createObjectURL(f);
    img.onload = function () {
      var k = Math.min(1, 256 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
      cb(cv.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = function () { toast('图片读取失败'); };
    img.src = url;
  };
  inp.click();
}
var editing = null, charOffWas = false;
async function editChar(cid) {
  editing = await dbGet('characters', cid);
  go('s-char');
}
onShow['s-char'] = async function () {
  if (!editing) return;
  var c = editing, body = $('char-body'); body.innerHTML = '';
  var books = await dbAll('worldBooks'), presets = await dbAll('userPersonas');
  var f = {
    name: h('input', { type: 'text', value: c.name }),
    realName: h('input', { type: 'text', value: c.realName || '' }),
    userNickname: h('input', { type: 'text', value: c.userNickname || '' }),
    userPersona: h('textarea', {}), persona: h('textarea', { style: 'min-height:220px' }),
    ctx: h('input', { type: 'number', value: c.contextLimit || '', placeholder: '默认 ' + settings.defaultContext }),
    interval: h('input', { type: 'number', value: (c.autoMemory && c.autoMemory.interval) || 20 })
  };
  f.userPersona.value = c.userPersona || ''; f.persona.value = c.persona || '';
  var auto = switchEl(c.autoMemory && c.autoMemory.enabled);
  var thAuto = switchEl(c.autoThought && c.autoThought.enabled), thInject = switchEl(c.injectThought);
  charOffWas = !!c.offlineMode;
  var avOn = switchEl(c.autoVoiceText !== false, function () {});
  var aiVoiceOn = switchEl(!!c.aiVoice, function () {});
  var offPresets = await dbAll('offlinePresets');
  var offOn = switchEl(c.offlineMode, function (v) { offBox.hidden = !v; });
  var offMin = h('input', { type: 'number', min: '1', value: (c.offlineWords && c.offlineWords.min) || 200 });
  var offMax = h('input', { type: 'number', min: '1', value: (c.offlineWords && c.offlineWords.max) || 600 });
  var offSel = h('select', {}, h('option', { value: '', text: '不使用预设（只用内置写作要求）' }));
  offPresets.forEach(function (p) { var o = h('option', { value: p.id, text: p.name || '未命名' }); if (p.id === c.offlinePresetId) o.selected = true; offSel.appendChild(o); });
  var offBox = h('div', {}, field('回复字数：最少', offMin), field('回复字数：最多', offMax, '线下模式像写小说，字数会作为要求写进提示词；字数越多越费 token'),
    field('线下预设', offSel, offPresets.length ? '预设在桌面「预设」里新建、导入和导出' : '还没有预设，可以去桌面「预设」里新建或导入'));
  offBox.hidden = !c.offlineMode;
  var av = { avatar: c.avatar || null, userAvatar: c.userAvatar || null };
  function avRow(label, key, nm) {
    var row = h('div', { class: 'av-pick' });
    function draw() {
      row.innerHTML = '';
      row.appendChild(avatarNode(av[key], nm));
      row.appendChild(h('div', { style: 'flex:1', text: label }));
      row.appendChild(h('button', { type: 'button', class: 'btn', text: '更换', onclick: function () { pickAvatar(function (d) { av[key] = d; draw(); }); } }));
      if (av[key]) row.appendChild(h('button', { type: 'button', class: 'btn', text: '移除', onclick: function () { av[key] = null; draw(); } }));
    }
    draw(); return row;
  }
  var cats = await dbAll('stickerCategories'), allSt = await dbAll('stickers');
  var sel = h('select', {}, h('option', { value: '', text: '套用我的人设预设…' }));
  presets.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: (p.persona || '').slice(0, 24) || p.id })); });
  sel.onchange = function () { var p = presets.find(function (x) { return x.id === sel.value; }); if (p) f.userPersona.value = p.persona; sel.value = ''; };
  body.appendChild(h('div', { class: 'group' }, avRow('角色头像', 'avatar', c.name), avRow('我的头像', 'userAvatar', '我')));
  body.appendChild(h('div', { class: 'group' }, field('显示名', f.name), field('角色真名（写进提示词）', f.realName), field('角色称呼你为', f.userNickname)));
  body.appendChild(h('div', { class: 'group-title', text: '角色设定' }));
  body.appendChild(h('div', { class: 'group' }, field('角色人设', f.persona, '放进系统提示词最前面，决定角色是谁、怎么说话。')));
  body.appendChild(h('div', { class: 'group-title', text: '你的人设' }));
  body.appendChild(h('div', { class: 'group' }, field('你在 TA 面前是谁', f.userPersona), presets.length ? field('', sel) : null));
  body.appendChild(h('div', { class: 'group-title', text: '上下文与记忆' }));
  body.appendChild(h('div', { class: 'group' }, field('每次带最近多少条消息', f.ctx),
    h('div', { class: 'field inline' }, h('label', { text: '自动总结记忆' }), auto.el), field('每新增多少条消息总结一次', f.interval)));
  body.appendChild(h('div', { class: 'group-title', text: '语音' }));
  body.appendChild(h('div', { class: 'group' }, h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '语音自动转文字' }), h('div', { class: 'hint', text: '你发语音时，用浏览器自带的识别实时转成文字（不走 API）；角色的语音气泡也据此直接显示文字。关闭后都先不显示，点气泡里的「转文字」再显示。AI 听你的语音不受这个开关影响。' })), avOn.el)));
  body.appendChild(h('div', { class: 'group' }, h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '允许角色发语音' }), h('div', { class: 'hint', text: '角色偶尔会发语音气泡：说的话直接带在回复里（不额外请求），点 ▶ 用浏览器朗读（不是角色本人的声音）。线下模式不会发。' })), aiVoiceOn.el)));
  body.appendChild(h('div', { class: 'group-title', text: '线下模式（小说式长文回复）' }));
  body.appendChild(h('div', { class: 'group' }, h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '开启线下模式' }), h('div', { class: 'hint', text: '开启后角色用小说式长文回复，不拆气泡、不发表情包' })), offOn.el), offBox));
  body.appendChild(h('div', { class: 'group-title', text: '心声（点聊天里角色的头像查看）' }));
  body.appendChild(h('div', { class: 'group' },
    h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '每次回复都更新心声' }), h('div', { class: 'hint', text: '心声跟着 TA 的回复一起生成，不会多发一次请求；只是每次回复末尾多一小段' })), thAuto.el),
    h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '让角色知道自己的心声' }), h('div', { class: 'hint', text: '把最新心声放进提示词，言行会更一致，但会多花一点 token' })), thInject.el)));
  body.appendChild(h('div', { class: 'group-title', text: '挂载世界书' }));
  var wbPick = multiPick('选择要挂载的世界书', books.map(function (b) { return { id: b.id, name: b.name, sub: (b.entries || []).length + ' 条' }; }), c.worldBookIds || [], '还没有世界书');
  body.appendChild(h('div', { class: 'group' }, wbPick.el));
  body.appendChild(h('div', { class: 'group-title', text: '角色可以发的表情包分类' }));
  var counts = {}; allSt.forEach(function (s) { var k = String(s.categoryId); counts[k] = (counts[k] || 0) + 1; });
  var stOpts = cats.concat(counts['null'] ? [{ id: 'null', name: '未分类' }] : []).map(function (ct) { return { id: String(ct.id), name: ct.name, sub: String(counts[String(ct.id)] || 0) }; });
  var stPick = multiPick('选择角色可以发的表情包分类', stOpts, c.stickerCategoryIds == null ? stOpts.map(function (o) { return o.id; }) : c.stickerCategoryIds, allSt.length ? '还没有表情包分类' : '还没有表情包（聊天页左下角 ☺ 可以添加）');
  body.appendChild(h('div', { class: 'group' }, stPick.el));
  body.appendChild(h('div', { class: 'group-title', text: '聊天记录' }));
  var statEl = h('div', { class: 'stat-line', text: '统计中…' });
  function fillStat() { chatStats(c.id).then(function (st) { statEl.textContent = st.total ? '共聊了 ' + st.total + ' 条（你 ' + st.me + ' · ' + c.name + ' ' + st.ai + '）\n从 ' + fmtTime(st.first).slice(0, 16) + ' 到 ' + fmtTime(st.last).slice(0, 16) : '还没有聊天记录'; statEl.style.whiteSpace = 'pre-line'; }); }
  fillStat();
  body.appendChild(h('div', { class: 'group' }, statEl, h('div', { class: 'btn-row' },
    h('button', { type: 'button', class: 'btn', text: '导出聊天记录', onclick: function () { menuSheet('导出「' + c.name + '」的聊天记录', [['完整导出（含图片和语音）', function () { exportChatLog(c, false); }], ['精简导出（不含图片和语音文件，更小）', function () { exportChatLog(c, true); }]]); } }),
    h('button', { type: 'button', class: 'btn', text: '导入聊天记录', onclick: function () { importChatLog(c, fillStat); } })),
    h('div', { class: 'hint', text: '只针对这个角色。导出的文件可以导入到同一个角色，或换设备后导回来。' })));
  body.appendChild(h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', text: '删除这个角色', onclick: function () {
    confirmSheet('删除「' + c.name + '」及其全部聊天和记忆？', '删除', async function () {
      var all = await pageMessages(c.id, null, 1e9), tx = db.transaction(['messages', 'memories', 'characters'], 'readwrite');
      all.forEach(function (m) { tx.objectStore('messages').delete(m.id); });
      (await dbByIndex('memories', 'byChar', c.id)).forEach(function (m) { tx.objectStore('memories').delete(m.id); });
      tx.objectStore('characters').delete(c.id);
      await new Promise(function (r) { tx.oncomplete = r; });
      editing = null; nav = ['s-home', 's-list']; activate('s-list'); toast('已删除');
    }, true);
  } })));
  editing._collect = function () {
    c.name = f.name.value.trim() || '未命名'; c.realName = f.realName.value.trim() || c.name;
    c.userNickname = f.userNickname.value.trim(); c.persona = f.persona.value; c.userPersona = f.userPersona.value;
    c.contextLimit = Number(f.ctx.value) > 0 ? Number(f.ctx.value) : null;
    c.autoMemory = { enabled: auto.input.checked, interval: Number(f.interval.value) > 0 ? Number(f.interval.value) : 20 };
    c.worldBookIds = wbPick.get();
    var on = stPick.get();
    c.stickerCategoryIds = (!stOpts.length || on.length === stOpts.length) ? null : on;
    c.avatar = av.avatar; c.userAvatar = av.userAvatar;
    c.autoThought = { enabled: thAuto.input.checked };
    c.autoVoiceText = avOn.input.checked; c.aiVoice = aiVoiceOn.input.checked;
    c.offlineMode = offOn.input.checked;
    var mn = Math.max(1, Math.round(Number(offMin.value) || 200)), mx = Math.max(1, Math.round(Number(offMax.value) || 600));
    if (mn > mx) { var tt = mn; mn = mx; mx = tt; }
    c.offlineWords = { min: mn, max: mx }; c.offlinePresetId = offSel.value || null;
    c.injectThought = thInject.input.checked;
    return c;
  };
};
$('b-char-save').onclick = async function () {
  if (!editing || !editing._collect) return;
  var c = editing._collect(); delete c._collect;
  await dbPut('characters', c);
  if (!!c.offlineMode !== charOffWas) {   /* 线下/线上切换时，在聊天里留一条分隔提示 */
    await dbPut('messages', { id: uid(c.id), characterId: c.id, role: 'user', type: 'pat', content: c.offlineMode ? '—— 进入线下模式 ——' : '—— 回到线上聊天 ——', ts: Date.now() });
    charOffWas = !!c.offlineMode;
  }
  if (cur && cur.id === c.id) { Object.assign(cur, c); refreshTitle(); $('input').placeholder = cur.offlineMode ? '写下你的动作或对白…' : '说点什么…'; }
  chars = await dbAll('characters');
  iosAlert('已保存', '角色设置已保存'); back();
  if (nav[nav.length - 1] === 's-chat') reloadChat();
};

/* ---------- 美化 ----------
 * 想改默认方案：只改下面 THEMES 里的颜色就行。
 * vars 里的名字 = 页面 CSS 变量（bg 背景 / card 卡片 / ink 文字 / sub 次要文字 / line 分割线 / accent 主色 / me 我的气泡 / them 对方气泡）。
 * 'default' 是原样（跟随系统深浅色），不要删。 */
/* 选图 -> 压缩成 jpeg 数据（避免撑爆存储） */
function pickImage(maxDim, quality, cb) {
  var f = h('input', { type: 'file', accept: 'image/*' });
  f.addEventListener('change', function () {
    var file = f.files[0]; if (!file) return;
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var k = Math.min(1, maxDim / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      var out = c.toDataURL('image/jpeg', quality);
      toast('已压缩：' + (file.size / 1024).toFixed(0) + 'KB → ' + (out.length * 0.75 / 1024).toFixed(0) + 'KB');
      cb(out);
    };
    img.onerror = function () { toast('图片读取失败'); };
    img.src = url;
  });
  f.click();
}
/* 聊天页外观（每个角色自己的背景 / 字号 / 气泡 CSS） */
function applyChatLook() {
  var c = cur || {}, st = document.getElementById('chat-look');
  if (!st) { st = document.createElement('style'); st.id = 'chat-look'; document.head.appendChild(st); }
  var fs = Number(c.chatFontSize) || 0, css = '';
  if (fs) css += '#msgs .bubble{font-size:' + fs + 'px}#msgs .bubble.offline{font-size:' + (fs - 0.5) + 'px}\n';
  st.textContent = css + (c.bubbleCss || '');
  $('chat-bg').style.backgroundImage = c.chatBg ? 'url("' + c.chatBg + '")' : '';
}
function clearChatLook() { var st = document.getElementById('chat-look'); if (st) st.textContent = ''; $('chat-bg').style.backgroundImage = ''; }
async function saveCur() { await dbPut('characters', cur); var ix = chars.findIndex(function (x) { return x.id === cur.id; }); if (ix >= 0) chars[ix] = cur; }
/* token 估算：中文约 1.3/字，其余约 0.3/字符（不同模型的分词不同，仅供参考） */
function estTokens(s) {
  s = String(s || ''); var cjk = (s.match(/[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/g) || []).length;
  return Math.round(cjk * 1.3 + (s.length - cjk) * 0.3);
}
async function renderTokenCard(host) {
  host.innerHTML = ''; host.appendChild(h('h4', { text: '提示词占用（估算）' }));
  var info = h('div', { class: 'bt-hint', text: '计算中…' }); host.appendChild(info);
  try {
    var p = await buildPrompt(cur), parts = [];
    p.system.split(/\n\n(?=# )/).forEach(function (sec, i) {
      var m = sec.match(/^# ([^\n]*)/); parts.push({ name: m ? m[1].replace(/（.*$/, '') : '开头（身份说明）', n: estTokens(sec) });
    });
    /* 图片和语音按「多模态」估算，不能把 base64 当文字数（会虚高几十倍）：语音约 32 token/秒（Gemini），图片约 600 */
    var media = { img: 0, aud: 0, secs: 0 };
    var hist = p.messages.reduce(function (n, m) {
      if (typeof m.content === 'string') return n + estTokens(m.content) + 4;
      return n + 4 + m.content.reduce(function (k, part) {
        if (part.type === 'text') return k + estTokens(part.text);
        if (part.type === 'image_url') { media.img++; return k; }
        if (part.type === 'audio_data') { var sec = Math.max(1, Math.round(String(part.data || '').length * 0.75 / 32000)); media.secs += sec; media.aud++; return k; }
        return k;
      }, 0);
    }, 0);
    parts.push({ name: '聊天记录（最近 ' + p.messages.length + ' 条）', n: hist, hist: true });
    if (media.aud) parts.push({ name: '这一轮的语音（' + media.aud + ' 条，共约 ' + media.secs + ' 秒，直接发音频）', n: media.secs * 32 });
    if (media.img) parts.push({ name: '这一轮的图片（' + media.img + ' 张）', n: media.img * 600 });
    var total = parts.reduce(function (n, x) { return n + x.n; }, 0) || 1;
    info.remove();
    host.appendChild(h('div', { style: 'font-size:22px;font-weight:700;margin:2px 0 8px', text: '约 ' + total + ' tokens' }));
    parts.sort(function (a, b) { return b.n - a.n; }).forEach(function (x) {
      var pct = Math.round(x.n / total * 100), bar = h('div', { style: 'height:6px;border-radius:3px;background:var(--accent);opacity:' + (x.hist ? '.45' : '.9') + ';width:' + Math.max(2, pct) + '%' });
      host.appendChild(h('div', { style: 'margin:7px 0' }, h('div', { style: 'display:flex;justify-content:space-between;font-size:13px' }, h('span', { text: x.name }), h('span', { style: 'color:var(--sub)', text: x.n + '（' + pct + '%）' })), bar));
    });
    host.appendChild(h('div', { class: 'bt-hint', text: '这是发给模型的输入部分，不含它的回复。按中文约 1.3 token/字估算，实际以你的模型分词为准。想降低就缩小「近期记忆窗口」、精炼记忆或减少上下文条数。' }));
    host.appendChild(h('button', { class: 'btn', style: 'margin-top:8px', text: '重新计算', onclick: function () { renderTokenCard(host); } }));
  } catch (e) { info.textContent = '计算失败：' + e.message; }
}
onShow['s-chatset'] = function () {
  var body = $('chatset-body'); body.innerHTML = '';
  var tokHost = h('div', { class: 'glass' }); body.appendChild(tokHost); renderTokenCard(tokHost);
  var prev = h('div', { class: 'bg-prev', text: cur.chatBg ? '' : '未设置背景' });
  if (cur.chatBg) prev.style.backgroundImage = 'url("' + cur.chatBg + '")';
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '聊天背景（只对「' + cur.name + '」生效）' }), prev,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '上传图片', onclick: function () { pickImage(1280, 0.75, async function (d) { cur.chatBg = d; await saveCur(); applyChatLook(); onShow['s-chatset'](); }); } }),
      h('button', { class: 'btn', text: '清除', onclick: async function () { cur.chatBg = ''; await saveCur(); applyChatLook(); onShow['s-chatset'](); } }))));
  var fsv = h('span', { class: 'val', text: (cur.chatFontSize || 15) + 'px' });
  var fr = h('input', { type: 'range', min: '12', max: '22', step: '1', value: String(cur.chatFontSize || 15) });
  fr.addEventListener('input', function () { fsv.textContent = fr.value + 'px'; });
  fr.addEventListener('change', async function () { cur.chatFontSize = Number(fr.value); await saveCur(); applyChatLook(); });
  var fl = field('气泡字体大小', fr); fl.firstChild.appendChild(fsv);
  body.appendChild(h('div', { class: 'glass' }, fl, h('button', { class: 'btn', text: '恢复默认', onclick: async function () { cur.chatFontSize = 0; await saveCur(); applyChatLook(); onShow['s-chatset'](); } })));
  var ta = h('textarea', { id: 'beauty-css', spellcheck: 'false', placeholder: '/* 例：.row:not(.me) .bubble { background: rgba(255,255,255,.6); border-radius: 8px; } */' });
  ta.value = cur.bubbleCss || '';
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '气泡自定义 CSS（只对这个角色的聊天页生效）' }),
    presetBar('bubble', { snap: function () { return { css: ta.value }; }, apply: async function (v) { ta.value = v.css || ''; cur.bubbleCss = ta.value; await saveCur(); applyChatLook(); } }), ta,
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', { class: 'btn primary', text: '应用并保存', onclick: async function () { cur.bubbleCss = ta.value; await saveCur(); applyChatLook(); toast('已应用'); } }),
      h('button', { class: 'btn', text: '清空', onclick: async function () { ta.value = ''; cur.bubbleCss = ''; await saveCur(); applyChatLook(); } })),
    h('div', { class: 'bt-hint', text: '常用选择器：.bubble 气泡、.row.me 我的消息、.row:not(.me) 对方消息、.bubble.offline 线下长文、.sysline 提示行、#msgs 聊天区' })));
};
var THEMES = [
  { id: 'default', name: '默认（暖橙）', vars: null, sw: ['#f6f5f2', '#c4572a', '#f3d9cb'] },
  { id: 'mist', name: '雾蓝', vars: { bg: '#eef2f6', card: '#ffffff', ink: '#1f2a37', sub: '#6b7a8c', line: '#dbe3ec', accent: '#3d6fb0', 'accent-ink': '#ffffff', me: '#cfe1f5', them: '#ffffff' } },
  { id: 'night', name: '夜间', vars: { bg: '#101114', card: '#1b1d22', ink: '#e8e9ec', sub: '#8d919a', line: '#2c2f36', accent: '#7c9cff', 'accent-ink': '#0b1020', me: '#2c3a63', them: '#23262d', shadow: 'none' } },
  { id: 'sakura', name: '樱粉', vars: { bg: '#fbf1f3', card: '#ffffff', ink: '#3a2428', sub: '#9a7b82', line: '#f0dadf', accent: '#d4577a', 'accent-ink': '#ffffff', me: '#f8d4de', them: '#ffffff' } },
  { id: 'matcha', name: '抹茶', vars: { bg: '#f1f4ec', card: '#fbfcf8', ink: '#25301f', sub: '#7a8570', line: '#dde3d2', accent: '#5b8a4a', 'accent-ink': '#ffffff', me: '#d9e8c8', them: '#ffffff' } }
];
THEMES.forEach(function (t) { if (t.vars && !t.sw) t.sw = [t.vars.bg, t.vars.accent, t.vars.me]; });
function applyTheme() {
  var st = document.getElementById('theme-style');
  if (!st) { st = document.createElement('style'); st.id = 'theme-style'; document.head.appendChild(st); }
  var t = THEMES.find(function (x) { return x.id === settings.themeId; }), css = '';
  if (t && t.vars) {
    css += ':root{' + Object.keys(t.vars).map(function (k) { return '--' + k + ':' + t.vars[k] + ';'; }).join('') + '}\n';
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', t.vars.bg);
  }
  var wpSrc = homeBgFile || settings.homeBg;   /* 桌面壁纸：想改填充方式，改下面的 background-size / background-position */
  if (wpSrc) css += '#s-home{background-image:url("' + String(wpSrc).replace(/"/g, '%22') + '");background-size:cover;background-position:center}\n';
  var fsrc = settings.fontData || settings.fontUrl;
  if (fsrc) {
    css += "@font-face{font-family:'UserFont';src:url('" + String(fsrc).replace(/'/g, '%27') + "');font-display:swap}\n" +
      "html,body,button,input,textarea,select,pre{font-family:'UserFont',-apple-system,BlinkMacSystemFont,'PingFang SC','Noto Sans SC',sans-serif !important}\n";
  }
  st.textContent = css + (settings.customCss || '');
}
/* ---- 美化预设：把「方案 / 壁纸 / 字体 / 自定义 CSS / 提示音 / 桌面图标」一起存起来，一键切换 ---- */
var BEAUTY_KEYS = ['themeId', 'customCss', 'homeBg', 'fontUrl', 'fontData', 'fontName', 'notifyUrl', 'notifyName', 'iconUrls'];
function cloneJ(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
function beautySnapshot() {
  var o = {}; BEAUTY_KEYS.forEach(function (k) { o[k] = cloneJ(settings[k] !== undefined ? settings[k] : DEFAULTS[k]); });
  o.homeBgFile = homeBgFile || ''; o.notifyFile = notifyFile || ''; return o;
}
async function applyBeauty(p) {
  BEAUTY_KEYS.forEach(function (k) { var v = p[k] !== undefined ? p[k] : DEFAULTS[k]; settings[k] = cloneJ(v); });
  homeBgFile = p.homeBgFile || ''; notifyFile = p.notifyFile || '';
  if (homeBgFile) await dbPut('settings', { key: 'homeBgFile', data: homeBgFile }); else await dbDel('settings', 'homeBgFile');
  if (notifyFile) await dbPut('settings', { key: 'notifyFile', data: notifyFile }); else await dbDel('settings', 'notifyFile');
  await saveSettings(); applyTheme(); onShow['s-beauty']();
}
async function fillBeautyPresets(box) {
  var list = (await dbAll('beautyPresets')).sort(function (a, b) { return b.ts - a.ts; });
  box.innerHTML = '';
  if (!list.length) box.appendChild(h('div', { class: 'bt-hint', style: 'margin:0 0 8px', text: '还没有预设。把当前的方案、壁纸、字体、提示音、桌面图标和自定义 CSS 调好后，点下面按钮存起来，以后一键切换。' }));
  else {
    var g = h('div', { class: 'group' });
    list.forEach(function (p) {
      g.appendChild(h('div', { class: 'item', onclick: function () {
        menuSheet(p.name, [
          ['应用这个预设（当前没存成预设的美化会被替换）', async function () { await applyBeauty(p); toast('已应用「' + p.name + '」'); }],
          ['用当前美化覆盖它', async function () { var np = Object.assign({ id: p.id, name: p.name, ts: Date.now() }, beautySnapshot()); await dbPut('beautyPresets', np); fillBeautyPresets(box); toast('已更新「' + p.name + '」'); }],
          ['重命名', function () { nameSheet('重命名', p.name, async function (nm) { p.name = nm; await dbPut('beautyPresets', p); fillBeautyPresets(box); }, '预设名称'); }],
          ['删除', function () { confirmSheet('删除美化预设「' + p.name + '」？', '删除', async function () { await dbDel('beautyPresets', p.id); fillBeautyPresets(box); }, true); }]]);
      } }, h('div', { class: 't' }, h('b', { text: p.name }), h('span', { class: 'badge', text: fmtTime(p.ts).replace(/:\d\d$/, '') }))));
    });
    box.appendChild(g);
  }
  box.appendChild(h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', text: '＋ 把当前美化存为新预设', onclick: function () {
    nameSheet('预设名称', '', async function (nm) { await dbPut('beautyPresets', Object.assign({ id: uid('bp'), name: nm, ts: Date.now() }, beautySnapshot())); fillBeautyPresets(box); toast('已保存「' + nm + '」'); }, '例如：夜间粉 / 极简白');
  } })));
}
onShow['s-beauty'] = function () {
  var body = $('beauty-body'); body.innerHTML = '';
  var prev = h('div', { class: 'glass' }, h('h4', { text: '预览' }), h('div', { class: 'bt-prev' },
    h('div', { class: 'row' }, avatarNode(null, '她'), h('div', { class: 'bubble', text: '今天有点冷，你出门穿厚点。' })),
    h('div', { class: 'row me' }, h('div', { class: 'bubble', text: '好～知道啦' })),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', text: '主按钮' }), h('button', { class: 'btn', text: '次按钮' }))));
  body.appendChild(prev);
  var pbox = h('div', {});
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '美化预设（可存多套，一键切换）' }), pbox)); fillBeautyPresets(pbox);
  var grid = h('div', { class: 'bt-grid' });
  THEMES.forEach(function (t) {
    var c = h('button', { type: 'button', class: 'bt-card' + (settings.themeId === t.id ? ' on' : ''), onclick: async function () {
      settings.themeId = t.id; await saveSettings(); applyTheme(); onShow['s-beauty']();
    } }, h.apply(null, ['div', { class: 'sw' }].concat(t.sw.map(function (col) { var i = h('i'); i.style.background = col; return i; }))), h('b', { text: t.name }));
    grid.appendChild(c);
  });
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '默认方案' }), grid));
  var wpSrc = homeBgFile || settings.homeBg;
  var wp = h('div', { class: 'bg-prev', text: wpSrc ? '' : '未设置桌面壁纸' });
  if (wpSrc) wp.style.backgroundImage = 'url("' + wpSrc.replace(/"/g, '%22') + '")';
  var wu = h('input', { type: 'text', placeholder: '壁纸图片网址 https://…', value: settings.homeBg || '' });
  wu.style.cssText = 'width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:8px';
  async function clearWp() { settings.homeBg = ''; homeBgFile = ''; await dbDel('settings', 'homeBgFile'); await saveSettings(); applyTheme(); onShow['s-beauty'](); }
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '桌面壁纸（推荐用网址，不占本机空间；上传的是原图，不压缩）' }), wp, wu,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '应用网址', onclick: async function () {
        settings.homeBg = wu.value.trim(); homeBgFile = ''; await dbDel('settings', 'homeBgFile'); await saveSettings(); applyTheme(); onShow['s-beauty'](); toast(settings.homeBg ? '已应用' : '已清除'); } }),
      h('button', { class: 'btn', text: '上传原图', onclick: function () {
        var f = h('input', { type: 'file', accept: 'image/*' });
        f.addEventListener('change', function () {
          var file = f.files[0]; if (!file) return;
          var rd = new FileReader(); rd.onload = async function () {
            homeBgFile = rd.result; settings.homeBg = ''; await dbPut('settings', { key: 'homeBgFile', data: homeBgFile }); await saveSettings(); applyTheme(); onShow['s-beauty'](); toast('已应用（' + (file.size / 1048576).toFixed(1) + 'MB 原图）');
          }; rd.onerror = function () { toast('图片读取失败'); }; rd.readAsDataURL(file);
        }); f.click();
      } }),
      h('button', { class: 'btn', text: '清除', onclick: clearWp }))));
  var fu = h('input', { type: 'text', placeholder: '字体文件网址（.ttf / .otf / .woff2）', value: settings.fontUrl || '' });
  fu.style.cssText = 'width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:8px';
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '字体（应用到所有页面）' }),
    presetBar('font', { snap: function () { return { fontUrl: settings.fontUrl || '', fontData: settings.fontData || '', fontName: settings.fontName || '' }; }, apply: async function (v) { settings.fontUrl = v.fontUrl || ''; settings.fontData = v.fontData || ''; settings.fontName = v.fontName || ''; await saveSettings(); applyTheme(); onShow['s-beauty'](); } }),
    h('div', { class: 'bt-hint', style: 'margin:0 0 8px', text: settings.fontData ? '当前：已上传的字体 ' + (settings.fontName || '') : (settings.fontUrl ? '当前：网址字体' : '当前：系统默认字体') }), fu,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '应用网址', onclick: async function () { settings.fontUrl = fu.value.trim(); settings.fontData = ''; settings.fontName = ''; await saveSettings(); applyTheme(); onShow['s-beauty'](); toast(settings.fontUrl ? '已应用' : '已恢复默认'); } }),
      h('button', { class: 'btn', text: '上传字体文件', onclick: function () {
        var f = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2,font/*' });
        f.addEventListener('change', function () {
          var file = f.files[0]; if (!file) return;
          if (file.size > 12 * 1048576) { toast('字体文件超过 12MB，太大了，换个精简版或用网址'); return; }
          var rd = new FileReader(); rd.onload = async function () {
            settings.fontData = rd.result; settings.fontName = file.name; settings.fontUrl = ''; await saveSettings(); applyTheme(); onShow['s-beauty']();
            toast(file.size > 4 * 1048576 ? '已应用（字体较大，加载可能偏慢）' : '已应用');
          }; rd.readAsDataURL(file);
        }); f.click();
      } }),
      h('button', { class: 'btn', text: '恢复默认', onclick: async function () { settings.fontUrl = ''; settings.fontData = ''; settings.fontName = ''; await saveSettings(); applyTheme(); onShow['s-beauty'](); } }))));
  /* 消息提示音：角色回复到达时响一声 */
  var nu = h('input', { type: 'text', placeholder: '音频网址 https://…（mp3 / wav / ogg）', value: settings.notifyUrl || '' });
  nu.style.cssText = 'width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:8px';
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '消息提示音（角色每发一条消息响一声）' }),
    presetBar('notify', { snap: function () { return { notifyUrl: settings.notifyUrl || '', notifyName: settings.notifyName || '', notifyFile: notifyFile || '' }; }, apply: async function (v) { settings.notifyUrl = v.notifyUrl || ''; settings.notifyName = v.notifyName || ''; notifyFile = v.notifyFile || ''; if (notifyFile) await dbPut('settings', { key: 'notifyFile', data: notifyFile }); else await dbDel('settings', 'notifyFile'); await saveSettings(); onShow['s-beauty'](); playNotify(); } }),
    h('div', { class: 'bt-hint', style: 'margin:0 0 8px', text: notifyFile ? '当前：已上传的音频 ' + (settings.notifyName || '') : (settings.notifyUrl ? '当前：网址音频' : '当前：没有提示音') }), nu,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '应用网址', onclick: async function () { settings.notifyUrl = nu.value.trim(); notifyFile = ''; settings.notifyName = ''; await dbDel('settings', 'notifyFile'); await saveSettings(); onShow['s-beauty'](); toast(settings.notifyUrl ? '已应用' : '已清除'); } }),
      h('button', { class: 'btn', text: '上传音频', onclick: function () {
        var f = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.aac' });
        f.addEventListener('change', function () {
          var file = f.files[0]; if (!file) return;
          if (file.size > 3 * 1048576) { toast('音频超过 3MB 了，提示音剪短一点，或者用网址'); return; }
          var rd = new FileReader(); rd.onload = async function () {
            notifyFile = rd.result; settings.notifyUrl = ''; settings.notifyName = file.name;
            await dbPut('settings', { key: 'notifyFile', data: notifyFile }); await saveSettings(); onShow['s-beauty'](); toast('已应用'); playNotify();
          }; rd.onerror = function () { toast('音频读取失败'); }; rd.readAsDataURL(file);
        }); f.click();
      } }),
      h('button', { class: 'btn', text: '试听', onclick: function () { if (!notifySrc() && !nu.value.trim()) { toast('还没有设置提示音'); return; } try { new Audio(notifySrc() || nu.value.trim()).play().catch(function () { toast('播放失败：音频格式不支持或网址打不开'); }); } catch (e) { toast('播放失败'); } } }),
      h('button', { class: 'btn', text: '清除', onclick: async function () { notifyFile = ''; settings.notifyUrl = ''; settings.notifyName = ''; await dbDel('settings', 'notifyFile'); await saveSettings(); onShow['s-beauty'](); } }))));
  /* 桌面图标：每个图标可以填图片网址或上传；留空用默认 */
  var ics = h('div', {});
  APPS.forEach(function (a) {
    var cur0 = (settings.iconUrls || {})[a.name] || '', isData = cur0.indexOf('data:') === 0;
    var pv = h('div', { class: 'pv' }); pv.style.background = a.color;
    var psrc = cur0 || a.img; if (psrc) { pv.style.backgroundImage = 'url("' + String(psrc).replace(/"/g, '%22') + '")'; pv.style.backgroundSize = 'cover'; pv.style.backgroundPosition = 'center'; }
    var inp = h('input', { type: 'text', placeholder: isData ? '已上传图片（可填网址替换）' : '图片网址 https://…（留空=默认）', value: isData ? '' : cur0 });
    inp.addEventListener('change', async function () {
      if (!settings.iconUrls) settings.iconUrls = {};
      var v = inp.value.trim(); if (v) settings.iconUrls[a.name] = v; else if (!isData) delete settings.iconUrls[a.name];
      await saveSettings(); onShow['s-beauty'](); toast(v ? '已设置「' + a.name + '」的图标' : '已恢复默认');
    });
    ics.appendChild(h('div', { class: 'ic-row' }, pv, h('div', { class: 'ic-main' }, h('b', { text: a.name }), inp),
      h('button', { class: 'btn', text: '上传', onclick: function () {
        pickImage(192, 0.9, async function (dataUrl) { if (!settings.iconUrls) settings.iconUrls = {}; settings.iconUrls[a.name] = dataUrl; await saveSettings(); onShow['s-beauty'](); toast('已设置'); });
      } }),
      cur0 ? h('button', { class: 'btn', text: '清除', onclick: async function () { delete settings.iconUrls[a.name]; await saveSettings(); onShow['s-beauty'](); } }) : null));
  });
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '桌面图标（自定义图片；回到桌面后生效）' }), ics));
  var ta = h('textarea', { id: 'beauty-css', placeholder: '/* 例：把对方气泡改成半透明、圆角小一点 */\n.row:not(.me) .bubble { background: rgba(255,255,255,.6); border-radius: 8px; }', spellcheck: 'false' });
  ta.value = settings.customCss || '';
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '自定义美化 CSS' }),
    presetBar('css', { snap: function () { return { css: ta.value }; }, apply: async function (v) { ta.value = v.css || ''; settings.customCss = ta.value; await saveSettings(); applyTheme(); } }), ta,
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', { class: 'btn primary', text: '应用并保存', onclick: async function () { settings.customCss = ta.value; await saveSettings(); applyTheme(); toast('已应用'); } }),
      h('button', { class: 'btn', text: '清空', onclick: async function () { ta.value = ''; settings.customCss = ''; await saveSettings(); applyTheme(); toast('已清空'); } })),
    h('div', { class: 'bt-hint', text: '写在这里的 CSS 会盖在上面的方案之上。\n可用变量：--bg --card --ink --sub --line --accent --me --them\n常用选择器：.bubble 气泡、.row.me 我的消息、.bar 顶栏、.app .tile 桌面图标、.glass 磨砂卡片' })));
};

/* ---------- 设置页 ---------- */
var draft = null, settingsDirty = false;
function markDirty() { settingsDirty = true; }
async function commitSettings() {
  settings = JSON.parse(JSON.stringify(draft)); await saveSettings(); settingsDirty = false;
}
var PRESET_KEYS = ['baseUrl', 'apiKey', 'model', 'temperature', 'stream', 'secBaseUrl', 'secApiKey', 'secModel'];
function nameSheet(title, init, cb, ph) {
  var inp = h('input', { type: 'text', value: init || '', placeholder: ph || '例如：官方直连 / 备用反代', style: 'width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:10px' });
  openSheet([h('h3', { text: title }), inp, h('div', { class: 'btn-row' },
    h('button', { class: 'btn primary', text: '保存', onclick: function () { var v = inp.value.trim(); if (!v) { toast('请输入名称'); return; } closeSheet(); cb(v); } }),
    h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
  setTimeout(function () { inp.focus(); }, 50);
}
function presetGroup() {
  if (!draft.apiPresets) draft.apiPresets = [];
  var list = draft.apiPresets, active = list.find(function (p) { return p.id === draft.activePresetId; });
  var sel = h('select', {}, h('option', { value: '', text: '（未使用预设）' }));
  list.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: p.name })); });
  sel.value = active ? active.id : '';
  sel.onchange = async function () {
    var p = list.find(function (x) { return x.id === sel.value; });
    draft.activePresetId = p ? p.id : null;
    if (p) PRESET_KEYS.forEach(function (k) { draft[k] = p[k] !== undefined ? p[k] : DEFAULTS[k]; });
    markDirty(); buildSettings(); toast(p ? '已切换到「' + p.name + '」' : '已取消预设');
  };
  function snapshot() { var o = {}; PRESET_KEYS.forEach(function (k) { o[k] = draft[k]; }); return o; }
  var row = h('div', { class: 'btn-row', style: 'margin:8px 0 14px' },
    h('button', { class: 'btn', text: '另存为新预设', onclick: function () {
      nameSheet('预设名称', '', async function (name) {
        var p = Object.assign({ id: uid('api'), name: name }, snapshot());
        list.push(p); draft.activePresetId = p.id; markDirty(); buildSettings(); toast('已加入预设，记得点右上角「保存」');
      });
    } }),
    active ? h('button', { class: 'btn', text: '更新「' + active.name + '」', onclick: async function () {
      Object.assign(active, snapshot()); markDirty(); toast('已更新「' + active.name + '」，记得点右上角「保存」');
    } }) : null,
    active ? h('button', { class: 'btn', text: '重命名', onclick: function () {
      nameSheet('重命名', active.name, async function (name) { active.name = name; markDirty(); buildSettings(); });
    } }) : null,
    active ? h('button', { class: 'btn danger', text: '删除', onclick: function () {
      confirmSheet('删除预设「' + active.name + '」？当前填写的内容不会被清空。', '删除', async function () {
        list.splice(list.indexOf(active), 1); draft.activePresetId = null; markDirty(); buildSettings();
      }, true);
    } }) : null);
  return [h('div', { class: 'group-title', text: '配置预设（一键切换渠道）' }), h('div', { class: 'group' }, field('当前预设', sel,
    '预设包含：反代地址、Key、模型、温度、流式开关、副 API。修改下面的内容后，要点「更新」才会存进预设。改完后点右上角「保存」才会生效。')), row];
}
function pickModel(mk, bk, kk, done) {
  var q = h('input', { type: 'text', placeholder: '搜索，或直接输入模型名', style: 'width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg)' });
  var list = h('div', { class: 'mdl-list' }), info = h('div', { class: 'hint', style: 'font-size:12px;color:var(--sub)' });
  function choose(name) { draft[mk] = name; markDirty(); closeSheet(); done(); }
  function render() {
    var all = draft.modelList || [], kw = q.value.trim().toLowerCase(); list.innerHTML = '';
    var shown = all.filter(function (n) { return !kw || n.toLowerCase().indexOf(kw) !== -1; });
    if (q.value.trim() && all.indexOf(q.value.trim()) === -1) list.appendChild(h('button', { type: 'button', text: '使用「' + q.value.trim() + '」', onclick: function () { choose(q.value.trim()); } }));
    shown.forEach(function (n) { list.appendChild(h('button', { type: 'button', class: n === draft[mk] ? 'on' : '', text: n, onclick: function () { choose(n); } })); });
    if (!list.children.length) list.appendChild(h('div', { class: 'empty', text: all.length ? '没有匹配的模型' : '还没有模型列表，点下面「拉取模型列表」' }));
    info.textContent = all.length ? '共 ' + all.length + ' 个模型' : '';
  }
  q.addEventListener('input', render);
  var pull = h('button', { type: 'button', class: 'btn', text: '拉取模型列表', onclick: async function () {
    pull.disabled = true; pull.textContent = '拉取中…';
    try {
      draft.modelList = await fetchModelList(draft[bk] || draft.baseUrl, draft[kk] || draft.apiKey); markDirty(); render();
    } catch (e) { list.innerHTML = ''; list.appendChild(h('div', { class: 'empty', style: 'white-space:pre-wrap;word-break:break-all;text-align:left;user-select:text', text: e.message })); }
    pull.disabled = false; pull.textContent = '拉取模型列表';
  } });
  openSheet([h('h3', { text: '选择模型' }), q, list, info, h('div', { class: 'btn-row', style: 'margin-top:8px' }, pull, h('button', { type: 'button', class: 'btn', text: '关闭', onclick: closeSheet }))]);
  render();
}
function buildSettings() {
  function tempField() {
    var v = h('span', { class: 'val', text: Number(draft.temperature).toFixed(1) });
    var r = h('input', { type: 'range', min: '0', max: '2', step: '0.1', value: String(draft.temperature) });
    r.addEventListener('input', function () { draft.temperature = Number(r.value); v.textContent = Number(r.value).toFixed(1); markDirty(); });
    var f = field('温度', r, '越低越稳定，越高越发散。常用 0.7–1.0。');
    f.firstChild.appendChild(v); return f;
  }
  var body = $('settings-body'); body.innerHTML = '';
  presetGroup().forEach(function (n) { body.appendChild(n); });
  function txt(key, label, type, ph, hint) {
    var i = h('input', { type: type || 'text', placeholder: ph || '', value: draft[key] == null ? '' : draft[key] });
    i.addEventListener('change', function () { draft[key] = type === 'number' ? Number(i.value) : i.value.trim(); markDirty(); });
    return field(label, i, hint);
  }
  function sw(key, label, hint) {
    var s = switchEl(draft[key], function (v) { draft[key] = v; markDirty(); if (key === 'sysNotify' && v) { if (!('Notification' in window)) toast('这个浏览器不支持系统通知'); else if (Notification.permission === 'default') Notification.requestPermission().then(function (p) { if (p !== 'granted') toast('没有通知权限，后台通知不会弹出'); }); else if (Notification.permission === 'denied') toast('通知权限被拒绝了，请在浏览器的网站设置里允许'); } });
    var row = h('div', { class: 'field inline' }, h('div', {}, h('label', { text: label }), hint ? h('div', { class: 'hint', text: hint }) : null), s.el);
    return row;
  }
  function modelField(label, mk, bk, kk, hint) {
    var b = h('button', { type: 'button', class: 'sel-btn', onclick: function () { pickModel(mk, bk, kk, function () { buildSettings(); }); } },
      h('span', { text: draft[mk] || '点击选择模型' }));
    if (!draft[mk]) b.firstChild.style.color = 'var(--sub)';
    return field(label, b, hint);
  }
  body.appendChild(h('div', { class: 'group-title', text: '主 API（对话）' }));
  body.appendChild(h('div', { class: 'group' },
    txt('baseUrl', '反代地址', 'text', 'https://api.openai.com', '填到域名即可，会自动补 /v1/chat/completions；填 Gemini 官方地址会自动用 Gemini 格式'),
    txt('apiKey', 'API Key', 'password', 'sk-...', '只保存在你这台设备的浏览器里'),
    modelField('模型', 'model', 'baseUrl', 'apiKey', '点一下选择；先在选择窗里「拉取」模型列表，也可以直接手动输入模型名。选好后记得点右上角「保存」。'), tempField()));

  body.appendChild(h('div', { class: 'group-title', text: '输出方式' }));
  body.appendChild(h('div', { class: 'group' },
    sw('stream', '流式输出', '长回复不容易被网关超时掐断。回复会收完再一起显示。'),
    sw('autoReply', '发送后自动回复', '关闭时，发送消息后角色不会立刻回，要你点聊天页的「等回复」才会回复。'),
    sw('showTime', '显示消息时间', '每条气泡下面显示几点几分。'),
    sw('sysNotify', '后台系统通知', '切到别的 App 或锁屏时，角色发来的第一条消息会弹系统通知。打开时会向浏览器申请通知权限；有些内置浏览器不支持。'),
    txt('bubbleSlow', '气泡出现速度（倍数）', 'number', '1', '模拟真人打字：1=默认，2=再慢一倍，0.5=快一倍，0=不等待、直接全部弹出')));

  var asrSel = h('select', {}); SPEECH_LANGS.forEach(function (l) { asrSel.appendChild(h('option', { value: l[0], text: l[1] })); });
  asrSel.value = draft.asrLang || 'zh-CN'; asrSel.onchange = function () { draft.asrLang = asrSel.value; markDirty(); };
  var vsSel = h('select', {}, h('option', { value: 'audio', text: '直接发音频（Gemini 等能听的模型）' }), h('option', { value: 'text', text: '只发文字 + 语气提示' }));
  vsSel.value = draft.voiceSend || 'audio'; vsSel.onchange = function () { draft.voiceSend = vsSel.value; markDirty(); };
  body.appendChild(h('div', { class: 'group-title', text: '语音' }));
  body.appendChild(h('div', { class: 'group' },
    field('发语音给 AI 的方式', vsSel, '直接发音频：AI 自己听语气，不用先转文字，也不多一次请求（只发还没被回复过的那条语音，之后变成文字）。模型听不了音频时选「只发文字」'),
    field('语音识别语言', asrSel, '录音时实时识别、长按「转文字」都用这个语言')));
  body.appendChild(h('div', { class: 'group-title', text: '副 API（总结、精炼记忆；留空则用主 API）' }));
  body.appendChild(h('div', { class: 'group' },
    txt('secBaseUrl', '反代地址', 'text', '留空使用主 API'), txt('secApiKey', 'API Key', 'password', '可选'), modelField('模型', 'secModel', 'secBaseUrl', 'secApiKey', '建议用便宜的小模型')));

  body.appendChild(h('div', { class: 'group-title', text: '上下文' }));
  body.appendChild(h('div', { class: 'group' },
    txt('defaultContext', '默认带最近多少条消息', 'number', '30', '角色设置里可以单独覆盖'),
    txt('summaryMax', '每条总结的字数上限（越小越省 token）', 'number', '200'),
    txt('memoryLimit', '近期记忆窗口（最近多少条记忆每次都带）', 'number', '20'),
    txt('scanDepth', '世界书扫描最近几条消息', 'number', '5'),
    txt('worldBookMaxChars', '世界书最多带入多少字', 'number', '6000'),
    txt('stickerPromptLimit', '提示词里最多列出多少个表情包', 'number', '60', '表情包很多时会随机抽取这么多告诉角色，避免提示词太长')));
}
onShow['s-settings'] = function () { draft = JSON.parse(JSON.stringify(settings)); settingsDirty = false; buildSettings(); };
$('b-set-save').onclick = async function () { await commitSettings(); iosAlert('已保存', '设置已保存'); };

/* ---------- 世界书导入导出：json / txt / Word(docx) ---------- */
var CRC_T = null;
function crc32(u8) {
  if (!CRC_T) { CRC_T = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
  var crc = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) crc = CRC_T[(crc ^ u8[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {
  var enc = new TextEncoder(), parts = [], cd = [], off = 0;
  files.forEach(function (f) {
    var name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    var lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    var ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), name, data); cd.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  });
  var cdLen = cd.reduce(function (n, p) { return n + p.length; }, 0);
  var end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdLen, true); end.setUint32(16, off, true);
  return new Blob(parts.concat(cd, [new Uint8Array(end.buffer)]), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
function xmlEsc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function makeDocx(text) {
  var paras = text.split('\n').map(function (l) { return '<w:p><w:r><w:t xml:space="preserve">' + xmlEsc(l) + '</w:t></w:r></w:p>'; }).join('');
  return zipStore([
    { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paras + '</w:body></w:document>' }
  ]);
}
async function readDocxText(buf) {
  var u8 = new Uint8Array(buf), dv = new DataView(buf), e = -1;
  for (var i = u8.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('不是有效的 Word 文件');
  var cnt = dv.getUint16(e + 10, true), p = dv.getUint32(e + 16, true), dec = new TextDecoder();
  for (var n = 0; n < cnt; n++) {
    var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    var name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    if (name === 'word/document.xml') {
      var ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), raw = u8.subarray(ds, ds + csize), xml;
      if (method === 0) xml = dec.decode(raw);
      else if (method === 8 && typeof DecompressionStream !== 'undefined') {
        var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        xml = dec.decode(await new Response(stream).arrayBuffer());
      } else throw new Error('这个浏览器不支持读取 Word 压缩内容，请另存为 txt 再导入');
      return xml.split(/<w:p[ >]/).slice(1).map(function (para) {
        var t = para.replace(/<w:br\s*\/>/g, '\n').replace(/<w:tab\s*\/>/g, '\t').replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, '\u0001$1\u0002').replace(/<[^>]+>/g, '');
        return t.replace(/\u0002\u0001/g, '').replace(/[\u0001\u0002]/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      }).join('\n');
    }
    p += 46 + nl + el + cl;
  }
  throw new Error('Word 文件里找不到正文');
}
function wbToText(books) {
  return books.map(function (b) {
    return '# ' + (b.name || '未命名') + '\n\n' + (b.entries || []).map(function (e) {
      return '## ' + (e.title || '') + '\n' + ((e.keys || []).length ? '关键词：' + e.keys.join(',') + '\n' : '') + (e.content || '');
    }).join('\n\n');
  }).join('\n\n\n');
}
function parseWbText(text, defName) {
  var books = [], book = null, entry = null;
  function newBook(n) { book = { name: n, entries: [] }; books.push(book); entry = null; }
  function newEntry(t) { if (!book) newBook(defName); entry = { title: t, keys: [], content: '', enabled: true, _n: 0 }; book.entries.push(entry); }
  String(text).replace(/\r/g, '').split('\n').forEach(function (ln) {
    var m;
    if ((m = ln.match(/^#\s+(.+)$/))) newBook(m[1].trim());
    else if ((m = ln.match(/^##\s*(.*)$/))) newEntry(m[1].trim());
    else if (entry && entry._n === 0 && (m = ln.match(/^(?:关键词|keys)\s*[:：]\s*(.*)$/i))) { entry.keys = m[1].split(/[,，、]/).map(function (x) { return x.trim(); }).filter(Boolean); }
    else { if (!entry) { if (!ln.trim()) return; newEntry(''); } entry.content += (entry._n ? '\n' : '') + ln; entry._n++; }
  });
  books.forEach(function (b) { b.entries = b.entries.filter(function (e) { return e.content.trim() || e.title; }).map(function (e) { delete e._n; e.content = e.content.replace(/\s+$/, ''); return e; }); });
  return books.filter(function (b) { return b.entries.length; });
}
function normalizeWbJson(data, defName) {
  var list = Array.isArray(data) ? data : (data && data.worldBooks) ? data.worldBooks : (data && data.entries) ? [data] : null;
  if (!list) throw new Error('JSON 里找不到世界书（需要 worldBooks 数组，或带 entries 的对象）');
  return list.map(function (b) {
    return { name: b.name || defName, entries: (Array.isArray(b.entries) ? b.entries : []).map(function (e) {
      return { title: e.title || e.comment || '', keys: Array.isArray(e.keys) ? e.keys : (typeof e.keys === 'string' ? e.keys.split(/[,，、]/).map(function (x) { return x.trim(); }).filter(Boolean) : []), content: e.content || '', enabled: e.enabled !== false };
    }) };
  }).filter(function (b) { return b.entries.length; });
}
function downloadBlob(name, blob) {
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
}
async function importWorldBooks() {
  var f = h('input', { type: 'file', accept: '.json,.txt,.docx,.md,text/plain,application/json' });
  f.addEventListener('change', async function () {
    var file = f.files[0]; if (!file) return;
    try {
      var base = file.name.replace(/\.[^.]+$/, ''), ext = (file.name.match(/\.([^.]+)$/) || [])[1] || '', books;
      ext = ext.toLowerCase();
      if (ext === 'json') books = normalizeWbJson(JSON.parse(await file.text()), base);
      else if (ext === 'docx') books = parseWbText(await readDocxText(await file.arrayBuffer()), base);
      else if (ext === 'doc') throw new Error('旧版 .doc 读不了，请在 Word 里另存为 .docx 或 .txt');
      else books = parseWbText(await file.text(), base);
      if (!books.length) throw new Error('没有读到任何条目');
      for (var i = 0; i < books.length; i++) await dbPut('worldBooks', { id: uid('wb'), name: books[i].name, categoryId: null, entries: books[i].entries });
      toast('已导入 ' + books.length + ' 本世界书，共 ' + books.reduce(function (n, b) { return n + b.entries.length; }, 0) + ' 条'); renderWbList();
    } catch (e) { openSheet([h('h3', { text: '导入失败' }), h('pre', { text: e.message }), h('button', { class: 'btn', text: '关闭', onclick: closeSheet })]); }
  });
  f.click();
}
async function exportWorldBooks() {
  var books = await dbAll('worldBooks'); if (!books.length) { toast('还没有世界书可导出'); return; }
  var day = new Date().toISOString().slice(0, 10);
  openSheet([h('h3', { text: '导出全部世界书（' + books.length + ' 本）' }), h('div', { class: 'hint', style: 'font-size:12.5px;color:var(--sub);margin-bottom:8px', text: 'JSON 保留全部信息（含是否启用）；txt 和 Word 是可读格式，方便自己编辑后再导入。' }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: 'JSON', onclick: function () { closeSheet(); downloadBlob('世界书-' + day + '.json', new Blob([JSON.stringify({ format: 'myphone-v1', worldBooks: books }, null, 1)], { type: 'application/json' })); } }),
      h('button', { class: 'btn', text: 'txt', onclick: function () { closeSheet(); downloadBlob('世界书-' + day + '.txt', new Blob([wbToText(books)], { type: 'text/plain' })); } }),
      h('button', { class: 'btn', text: 'Word', onclick: function () { closeSheet(); downloadBlob('世界书-' + day + '.docx', makeDocx(wbToText(books))); } }),
      h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
}

/* ---------- 世界书 ---------- */
async function renderWbList() {
  var books = await dbAll('worldBooks'), body = $('wblist-body'); body.innerHTML = '';
  body.appendChild(h('div', { class: 'btn-row', style: 'margin-bottom:10px' }, h('button', { class: 'btn', text: '导入（json / txt / Word）', onclick: importWorldBooks }), h('button', { class: 'btn', text: '导出', onclick: exportWorldBooks })));
  if (!books.length) { body.appendChild(h('div', { class: 'empty', text: '还没有世界书。点右上角新建。\n关键词留空的条目会一直带入；填了关键词的条目，聊天里出现关键词才带入。' })); body.firstChild.style.whiteSpace = 'pre-line'; return; }
  var g = h('div', { class: 'group' });
  books.forEach(function (b) {
    g.appendChild(h('div', { class: 'item', onclick: function () { editWb(b.id); } },
      h('div', { class: 't' }, h('b', { text: b.name || '未命名' }), h('span', { class: 'badge', text: (b.entries || []).length + ' 条' })),
      h('div', { class: 'c', text: (b.entries || []).map(function (e) { return e.title; }).filter(Boolean).join('、') })));
  });
  body.appendChild(g);
}
onShow['s-wblist'] = renderWbList;
$('b-wb-add').onclick = async function () {
  var b = { id: uid('wb'), name: '新世界书', categoryId: null, entries: [{ title: '', keys: [], content: '', enabled: true }] };
  await dbPut('worldBooks', b); editWb(b.id);
};
var wbEditing = null;
async function editWb(id) { wbEditing = await dbGet('worldBooks', id); go('s-wbedit'); }
onShow['s-wbedit'] = function () {
  if (!wbEditing) return;
  var b = wbEditing, body = $('wbedit-body'); body.innerHTML = '';
  var name = h('input', { type: 'text', value: b.name });
  body.appendChild(h('div', { class: 'group' }, field('世界书名称', name)));
  var holder = h('div', {}), rows = [];
  function addEntry(e) {
    var t = h('input', { type: 'text', value: e.title || '', placeholder: '条目标题' });
    var k = h('input', { type: 'text', value: (e.keys || []).join(','), placeholder: '关键词，用逗号分隔；留空 = 一直带入' });
    var c = h('textarea', {}); c.value = e.content || '';
    var en = switchEl(e.enabled !== false);
    var box = h('div', { class: 'group' }, field('标题', t), field('关键词', k), field('内容', c),
      h('div', { class: 'field inline' }, h('label', { text: '启用' }), en.el),
      h('div', { class: 'field' }, h('button', { class: 'btn danger', text: '删除此条目', onclick: function () { box.remove(); rows = rows.filter(function (r) { return r.box !== box; }); } })));
    rows.push({ box: box, t: t, k: k, c: c, en: en.input }); holder.appendChild(box);
  }
  (b.entries || []).forEach(addEntry);
  body.appendChild(holder);
  body.appendChild(h('div', { class: 'btn-row' }, h('button', { class: 'btn', text: '＋ 添加条目', onclick: function () { addEntry({ enabled: true }); } }),
    h('button', { class: 'btn danger', text: '删除这本世界书', onclick: function () {
      confirmSheet('删除「' + b.name + '」？', '删除', async function () { await dbDel('worldBooks', b.id); wbEditing = null; back(); }, true);
    } })));
  b._collect = function () {
    b.name = name.value.trim() || '未命名';
    b.entries = rows.map(function (r) {
      return { title: r.t.value.trim(), keys: r.k.value.split(/[,，、]/).map(function (s) { return s.trim(); }).filter(Boolean), content: r.c.value, enabled: r.en.checked };
    });
    return b;
  };
};
$('b-wb-save').onclick = async function () {
  if (!wbEditing || !wbEditing._collect) return;
  var b = wbEditing._collect(); delete b._collect;
  await dbPut('worldBooks', b); iosAlert('已保存', '世界书已保存'); back();
};

/* ---------- 线下预设（写作风格 / 格式要求；和世界书一样可导入导出） ---------- */
function presetsToText(list) {
  return list.map(function (p) { return '# ' + (p.name || '未命名') + '\n\n' + (p.content || ''); }).join('\n\n\n');
}
function parsePresetText(text, defName) {
  var out = [], p = null;
  String(text).replace(/\r/g, '').split('\n').forEach(function (ln) {
    var m = ln.match(/^#\s+(.+)$/);
    if (m) { p = { name: m[1].trim(), content: '', n: 0 }; out.push(p); return; }
    if (!p) { if (!ln.trim()) return; p = { name: defName, content: '', n: 0 }; out.push(p); }
    p.content += (p.n ? '\n' : '') + ln; p.n++;
  });
  return out.map(function (x) { return { name: x.name, content: x.content.trim() }; }).filter(function (x) { return x.content; });
}
function normalizePresetJson(data, defName) {
  var list = Array.isArray(data) ? data : (data && data.offlinePresets) ? data.offlinePresets : (data && data.content) ? [data] : null;
  if (!list) throw new Error('JSON 里找不到预设（需要 offlinePresets 数组，或带 name / content 的对象）');
  return list.map(function (x) { return { name: x.name || x.title || defName, content: String(x.content || x.prompt || '').trim() }; }).filter(function (x) { return x.content; });
}
async function importPresets() {
  var f = h('input', { type: 'file', accept: '.json,.txt,.docx,.md,text/plain,application/json' });
  f.addEventListener('change', async function () {
    var file = f.files[0]; if (!file) return;
    try {
      var base = file.name.replace(/\.[^.]+$/, ''), ext = ((file.name.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase(), list;
      if (ext === 'json') list = normalizePresetJson(JSON.parse(await file.text()), base);
      else if (ext === 'docx') list = parsePresetText(await readDocxText(await file.arrayBuffer()), base);
      else if (ext === 'doc') throw new Error('旧版 .doc 读不了，请在 Word 里另存为 .docx 或 .txt');
      else list = parsePresetText(await file.text(), base);
      if (!list.length) throw new Error('没有读到任何预设内容');
      for (var i = 0; i < list.length; i++) await dbPut('offlinePresets', { id: uid('pr'), name: list[i].name, content: list[i].content });
      toast('已导入 ' + list.length + ' 个预设'); renderPrList();
    } catch (e) { openSheet([h('h3', { text: '导入失败' }), h('pre', { text: e.message }), h('button', { class: 'btn', text: '关闭', onclick: closeSheet })]); }
  });
  f.click();
}
async function exportPresets() {
  var list = await dbAll('offlinePresets'); if (!list.length) { toast('还没有预设可导出'); return; }
  var day = new Date().toISOString().slice(0, 10);
  openSheet([h('h3', { text: '导出全部预设（' + list.length + ' 个）' }), h('div', { class: 'hint', style: 'font-size:12.5px;color:var(--sub);margin-bottom:8px', text: 'JSON 保留全部信息；txt 和 Word 用「# 预设名」分隔，方便自己编辑后再导入。' }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: 'JSON', onclick: function () { closeSheet(); downloadBlob('预设-' + day + '.json', new Blob([JSON.stringify({ format: 'myphone-v1', offlinePresets: list }, null, 1)], { type: 'application/json' })); } }),
      h('button', { class: 'btn', text: 'txt', onclick: function () { closeSheet(); downloadBlob('预设-' + day + '.txt', new Blob([presetsToText(list)], { type: 'text/plain' })); } }),
      h('button', { class: 'btn', text: 'Word', onclick: function () { closeSheet(); downloadBlob('预设-' + day + '.docx', makeDocx(presetsToText(list))); } }),
      h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
}
async function renderPrList() {
  var list = await dbAll('offlinePresets'), body = $('prlist-body'); body.innerHTML = '';
  body.appendChild(h('div', { class: 'btn-row', style: 'margin-bottom:10px' }, h('button', { class: 'btn', text: '导入（json / txt / Word）', onclick: importPresets }), h('button', { class: 'btn', text: '导出', onclick: exportPresets })));
  if (!list.length) { body.appendChild(h('div', { class: 'empty', text: '还没有预设。点右上角新建。\n预设是线下模式的写作要求（文风、视角、格式等），\n在「角色设置 → 线下模式」里给角色选用。' })); body.lastChild.style.whiteSpace = 'pre-line'; return; }
  var g = h('div', { class: 'group' });
  list.forEach(function (p) {
    g.appendChild(h('div', { class: 'item', onclick: function () { editPreset(p.id); } },
      h('div', { class: 't' }, h('b', { text: p.name || '未命名' }), h('span', { class: 'badge', text: (p.content || '').length + ' 字' })),
      h('div', { class: 'c', text: (p.content || '').slice(0, 60) })));
  });
  body.appendChild(g);
}
onShow['s-prlist'] = renderPrList;
$('b-pr-add').onclick = async function () {
  var p = { id: uid('pr'), name: '新预设', content: '' };
  await dbPut('offlinePresets', p); editPreset(p.id);
};
var prEditing = null;
async function editPreset(id) { prEditing = await dbGet('offlinePresets', id); go('s-predit'); }
onShow['s-predit'] = function () {
  if (!prEditing) return;
  var p = prEditing, body = $('predit-body'); body.innerHTML = '';
  var name = h('input', { type: 'text', value: p.name }), ta = h('textarea', { style: 'min-height:320px' }); ta.value = p.content || '';
  body.appendChild(h('div', { class: 'group' }, field('预设名称', name), field('预设内容', ta, '写给模型的写作要求，比如文风、人称、描写重点、格式。字数请在角色设置里填，这里不用写。')));
  body.appendChild(h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', text: '删除这个预设', onclick: function () {
    confirmSheet('删除「' + p.name + '」？用了它的角色会回到不使用预设。', '删除', async function () { await dbDel('offlinePresets', p.id); prEditing = null; back(); }, true);
  } })));
  p._collect = function () { p.name = name.value.trim() || '未命名'; p.content = ta.value; return p; };
};
$('b-pr-save').onclick = async function () {
  if (!prEditing || !prEditing._collect) return;
  var p = prEditing._collect(); delete p._collect;
  await dbPut('offlinePresets', p); iosAlert('已保存', '预设已保存'); back();
};

/* ---------- 导入 / 导出 ---------- */
var IMPORT_STORES = ['characters', 'messages', 'memories', 'thoughts', 'worldBooks', 'worldBookCategories', 'userPersonas', 'stickers', 'stickerCategories'];
function startImport() { $('file-import').click(); }
$('file-import').addEventListener('change', async function () {
  var f = this.files[0]; this.value = ''; if (!f) return;
  var data;
  try { data = JSON.parse(await f.text()); } catch (e) { toast('文件不是有效的 JSON'); return; }
  if (data.format !== 'myphone-v1') { toast('不是 myphone-v1 格式的文件'); return; }
  var existing = (await dbAll('characters')).length;
  var withSettings = false;
  var doImport = async function () {
    toast('导入中，请稍候…');
    try {
      for (var i = 0; i < IMPORT_STORES.length; i++) await dbClear(IMPORT_STORES[i]);
      var lastByChar = {};
      (data.memories || []).forEach(function (m) { if (m.kind !== 'note') lastByChar[m.characterId] = Math.max(lastByChar[m.characterId] || 0, m.ts || 0); });
      var lastTh = {}; (data.thoughts || []).forEach(function (t) { lastTh[t.characterId] = Math.max(lastTh[t.characterId] || 0, t.ts || 0); });
      (data.characters || []).forEach(function (c) { c.lastSummaryTs = lastByChar[c.id] || 0; c.lastThoughtTs = lastTh[c.id] || 0; });
      for (var j = 0; j < IMPORT_STORES.length; j++) await dbBulkPut(IMPORT_STORES[j], data[IMPORT_STORES[j]] || []);
      if (data.beautyPresets) { await dbClear('beautyPresets'); await dbBulkPut('beautyPresets', data.beautyPresets); }
      if (data.miniPresets) { await dbClear('miniPresets'); await dbBulkPut('miniPresets', data.miniPresets); }
      if (data.offlinePresets) { await dbClear('offlinePresets'); await dbBulkPut('offlinePresets', data.offlinePresets); }   /* 老备份没有这一项就不动现有预设 */
      if (withSettings && data.settings) { settings = Object.assign({}, DEFAULTS, data.settings); await saveSettings(); applyTheme(); }
      toast('导入完成：' + (data.characters || []).length + ' 个角色，' + (data.messages || []).length + ' 条消息');
      renderList();
    } catch (e) { toast('导入失败：' + e.message); }
  };
  var proceed = function () {
    if (existing) confirmSheet('导入会覆盖现有的角色、聊天、记忆和世界书。继续吗？', '覆盖导入', doImport, true);
    else doImport();
  };
  if (data.settings) {
    openSheet([h('h3', { text: '这个文件里带有设置' }), h('div', { class: 'hint', text: '包含 API Key 和配置预设。要一并导入（覆盖现在的设置）吗？' }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', text: '连设置一起导入', onclick: function () { withSettings = true; closeSheet(); proceed(); } }),
        h('button', { class: 'btn', text: '只导入数据', onclick: function () { closeSheet(); proceed(); } }),
        h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
  } else proceed();
});
function exportData() {
  openSheet([h('h3', { text: '导出数据' }), h('div', { class: 'hint', text: '带上设置，换设备导入后不用重新填 API Key 和预设。带 Key 的文件请自己保管，不要发给别人。' }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '导出（含 API Key 和预设）', onclick: function () { closeSheet(); doExport(true); } }),
      h('button', { class: 'btn', text: '只导出数据', onclick: function () { closeSheet(); doExport(false); } }),
      h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
}
async function doExport(withSettings) {
  toast('正在导出…');
  var out = { format: 'myphone-v1', exportedAt: Date.now(), source: 'myphone' };
  for (var i = 0; i < IMPORT_STORES.length; i++) out[IMPORT_STORES[i]] = await dbAll(IMPORT_STORES[i]);
  out.offlinePresets = await dbAll('offlinePresets');
  out.beautyPresets = await dbAll('beautyPresets');
  out.miniPresets = await dbAll('miniPresets');
  out.characters.forEach(function (c) { delete c.lastSummaryTs; delete c.lastThoughtTs; });
  if (withSettings) out.settings = JSON.parse(JSON.stringify(settings));
  var blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'myphone-v1-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  toast('已导出 ' + (blob.size / 1048576).toFixed(1) + 'MB');
}


/* ---------- 美化页保存总开关 ---------- */
var beautySnap = null;
function snapBeauty() { return JSON.stringify({ s: settings, bg: homeBgFile || '', nf: notifyFile || '' }); }
function beautyDirty() { return beautySnap !== null && snapBeauty() !== beautySnap; }
async function restoreBeauty() {
  if (beautySnap === null) return;
  var o = JSON.parse(beautySnap); settings = o.s; homeBgFile = o.bg; notifyFile = o.nf;
  if (homeBgFile) await dbPut('settings', { key: 'homeBgFile', data: homeBgFile }); else await dbDel('settings', 'homeBgFile');
  if (notifyFile) await dbPut('settings', { key: 'notifyFile', data: notifyFile }); else await dbDel('settings', 'notifyFile');
  await saveSettings(); applyTheme(); await renderHome();
}
$('b-beauty-save').onclick = function () { beautySnap = snapBeauty(); iosAlert('已保存', '美化设置已保存'); };

/* ---------- iOS 风格居中弹窗 ---------- */
function iosAlert(title, msg) {
  var old = document.getElementById('ios-alert'); if (old) old.remove();
  var el = h('div', { id: 'ios-alert', class: 'ios-alert' }, h('div', { class: 'ia-card' },
    (function () { var d = h('div', { class: 'ia-ck' }); d.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'; return d; })(),
    h('div', { class: 'ia-t', text: title }), msg ? h('div', { class: 'ia-m', text: msg }) : null,
    h('button', { class: 'ia-ok', text: '好', onclick: function () { el.remove(); } })));
  document.body.appendChild(el);
  setTimeout(function () { if (el.parentNode) { el.classList.add('out'); setTimeout(function () { el.remove(); }, 200); } }, 1600);
}

/* ---------- 手机返回键 / 返回手势：回到上一页（先关弹层，再退页面；桌面不拦截） ---------- */
var trapped = false, skipPop = false;
function hasOverlay() {
  return !$('errpop').hidden || !$('sheet').hidden || !!msgPop || !!cloudEl || !$('fab').hidden || selMode;
}
function closeTopOverlay() {
  if (!$('errpop').hidden) { closeErr(); return true; }
  if (!$('sheet').hidden) { closeSheet(); return true; }
  if (msgPop) { closeMsgPop(); return true; }
  if (cloudEl) { closeCloud(); return true; }
  if (!$('fab').hidden) { closeFab(); return true; }
  if (selMode) { exitSelect(); return true; }
  return false;
}
function hasBackTarget() { return hasOverlay() || nav.length > 1; }
function syncTrap() {
  try {
    if (hasBackTarget() && !trapped) { history.pushState({ trap: 1 }, ''); trapped = true; }
    else if (!hasBackTarget() && trapped) { skipPop = true; trapped = false; history.back(); }
  } catch (e) {}
}
window.addEventListener('popstate', function () {
  if (skipPop) { skipPop = false; return; }
  trapped = false;
  if (!closeTopOverlay()) { if (nav.length > 1) back(); }
  syncTrap();
});
setInterval(syncTrap, 250);

/* ---------- 点系统通知 → 直接进对应角色的聊天（页面还活着就切过去；已被系统清掉就带 ?chat= 重新打开） ---------- */
async function openChatFromOutside(cid) {
  if (!cid) return;
  try { closeTopOverlay(); closeBannerNow(); } catch (e) {}
  chars = await dbAll('characters');
  if (!chars.some(function (c) { return c.id === cid; })) return;
  nav = ['s-home', 's-list']; activate('s-list');
  await openChat(cid);
}
function closeBannerNow() { var b = document.getElementById('msg-banner'); if (b) b.remove(); }
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'open-chat') openChatFromOutside(e.data.cid);
});

/* ---------- 启动 ---------- */
(async function () {
  try {
    await openDB(); await loadSettings();
    try { var hb = await dbGet('settings', 'homeBgFile'); homeBgFile = (hb && hb.data) || ''; } catch (e) {}
    try { var nf = await dbGet('settings', 'notifyFile'); notifyFile = (nf && nf.data) || ''; } catch (e) {}
    await loadUnread(); applyTheme(); await renderHome();
    try { var q0 = new URLSearchParams(location.search).get('chat'); if (q0) { history.replaceState({}, '', location.pathname); await openChatFromOutside(q0); } } catch (e) {}
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) { document.body.innerHTML = '<pre style="padding:20px;white-space:pre-wrap">启动失败：' + e.message + '</pre>'; }
})();

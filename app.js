/* =====================================================================
 * 我的小手机 —— 单文件版
 * 结构：① 数据库  ② 提示词拼接  ③ 调用模型（含流式）  ④ 记忆  ⑤ 界面
 * 数据格式见 myphone-format-v1.md
 * ===================================================================== */

/* ---------- ① 数据库（原生 IndexedDB，无需外部库） ---------- */
var DB_NAME = 'myphone', DB_VER = 6, db = null;
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
  playlists: { keyPath: 'id' },        /* 音乐歌单：每人（我 / 每个角色）一份 */
  moments: { keyPath: 'id' },          /* 朋友圈动态（含点赞、评论） */
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
function dbPut(store, val) { dbDirty = true; return reqP(db.transaction(store, 'readwrite').objectStore(store).put(val)); }
function dbDel(store, key) { dbDirty = true; return reqP(db.transaction(store, 'readwrite').objectStore(store).delete(key)); }
function dbClear(store) { dbDirty = true; return reqP(db.transaction(store, 'readwrite').objectStore(store).clear()); }
function dbBulkPut(store, arr) {
  dbDirty = true;
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
var TTS_TAGS = ['笑', '轻笑', '咯咯笑', '叹气', '惊呼', '吸气', '呼气', '喘息', '耳语', '唱歌', '哼歌', '结巴', '停顿', '哭声', '抽泣', '呜咽', '呻吟', '清嗓', '咳嗽', '吸鼻子', '咂嘴', '啧嘴', '打哈欠', '打喷嚏', '打嗝', '吞咽', '闷哼', '冷笑', '哼鼻子'];
/* 语音条里显示的文字：去掉所有半角/全角方括号及里面的声音标签（传给 TTS 的仍保留标签） */
function stripVoiceTags(t) { return String(t || '').replace(/[\[［][^\]］]+[\]］]/g, '').replace(/\s{2,}/g, ' ').trim(); }
var OUTPUT_RULES = '像真人在手机上聊天一样回复：口语化、简短自然。\n把回复拆成多条短消息，每条消息单独一行（最多 20 条）。\n想引用用户最近说过的话，写 [引用：原话片段]你的回复。\n【输出格式】直接输出纯文本聊天内容：不要 JSON，不要 Markdown 代码围栏。特殊内容一律用标签，标签不属于聊天正文：\n- 表情包：单独一行 [表情包：名称]\n- 语音（仅在后文允许发语音时）：单独一行 [语音：说的话]\n- 状态（可选，放在回复最末尾另起一行）：<状态>类型｜短描述</状态>，类型只能是 在线、忙碌、离开、睡觉 之一，短描述不超过 16 字，例如 <状态>在线｜在想你</状态>\n- 心声、朋友圈、拍一拍、转账、一起听歌的标签，按后文对应章节的说明写（没有对应章节就不要写）。\n不要在开头写角色名字，不要写旁白、括号动作或解释，除非角色设定要求这样。每次开口根据当前话题和心情自然起头，不要重复近期开头词。始终保持角色设定，不要承认自己是 AI。不输出思考过程或英文说明。';
var OFFLINE_RULES = '现在是线下场景，你和用户面对面相处。用小说式的叙述回复：用第三人称写角色的动作、神态、环境，对白用「」括起来，连贯地写成一段或几段文字。篇幅 {{MIN}} 到 {{MAX}} 字，一次写完，不要拆成多条消息，不要发表情包，不要用你的名字做开头。只写角色自己的言行和感受，不要替用户说话、替用户做动作。始终保持角色设定，不要承认自己是 AI。\n【输出格式】直接输出叙述正文纯文本，不要 JSON，不要代码围栏。需要时可在正文末尾另起一行加 <状态>…</状态>、<心声>…</心声>、<朋友圈>…</朋友圈> 标签（写法见后文对应章节），标签不属于正文。';
/* 线下模式的完整规则 = 内置规则（字数按角色设置填） + 你选的预设（文风/格式要求） */
function offlineRules(c, preset) {
  var w = (c && c.offlineWords) || {}, mn = Number(w.min) > 0 ? Math.round(w.min) : 200, mx = Number(w.max) > 0 ? Math.round(w.max) : 600;
  if (mn > mx) { var t = mn; mn = mx; mx = t; }
  var out = OFFLINE_RULES.replace('{{MIN}}', mn).replace('{{MAX}}', mx);
  if (preset && preset.content && String(preset.content).trim()) out += '\n\n# 线下写作预设（文风、格式的额外要求，请遵守）\n' + String(preset.content).trim();
  return out;
}
/* 心声并入回复：不另外请求，让模型在同一次回复末尾顺带写 */
var THOUGHT_RULES = '当原有心声功能要求生成时，在回复最末尾另起几行写：\n<心声>\n心声：一句话，不超过 40 字\n散记：零碎的想法，不超过 120 字\n</心声>\n这不是聊天正文，不要把心声念给用户听。';
var MOMENT_RULES = '你和用户互为朋友圈好友。上文提供了最近动态及动态 ID。需要发动态、点赞或评论时，在回复最末尾写一个 <朋友圈> 标签，里面每行一项，没有的项整行省略：\n发布：新动态正文，不超过 100 字\n点赞：动态ID，多个用逗号隔开\n评论：动态ID｜评论内容｜被回复的人（可省略；最多 4 条，每条一行）\n例如：\n<朋友圈>\n点赞：m1\n评论：m1｜哈哈这张好看\n</朋友圈>\n不要重复评论已互动内容，不要频繁发动态；没有互动时不要写这个标签。朋友圈标签不是聊天正文。';
var DEFAULTS = {
  baseUrl: '', apiKey: '', model: '', temperature: 0.8,
  stream: false, themeId: 'default', customCss: '', homeBg: '', fontUrl: '', fontData: '', fontName: '',
  secBaseUrl: '', secApiKey: '', secModel: '',
  scanDepth: 5, worldBookMaxChars: 6000, defaultContext: 30, ctxWindow: 25, ctxStep: 30,
  segMax: 300, profileMax: 800, memCompressAt: 6000, memStageMax: 1500, memAutoCompress: true, memConfirm: false, memTemp: 0.2, tokBudgetOn: false, tokBudget: 60000, maxOutTokens: 0, stickerPromptLimit: 60, period: null, myProfile: null, musicApi: '', musicApiBackup: '', apiPresets: [], activePresetId: null, secApiPresets: [], activeSecPresetId: null, weather: null, homeLayout: null,
  bubbleSlow: 1,                 /* 气泡出现速度倍数：1=默认，越大越慢 */
  notifyUrl: '', notifyName: '', /* 消息提示音（网址 / 上传的文件名） */
  clockLayout: 'h', clockColor: '', dateColor: '', wxColor: '', clockDy: 0, dateDy: 0, wxDy: 0, clockDx: 0, dateDx: 0, wxDx: 0,   /* 时钟：横/竖排、三处文字颜色、三处上下及左右位置（互不绑定） */
  iconUrls: {},                  /* 自定义桌面图标：{ 应用名: 图片网址或 data URI } */
  asrLang: 'zh-CN',              /* 语音识别语言 */
  showTime: true,                /* 每条气泡下面显示时间（几点几分） */
  autoStripFormat: true,         /* 自动去格式：清除 AI 回复里的 Markdown 符号、多余 HTML/XML 标签与空行（新旧消息均生效） */
    enterSend: false,              /* 回车发送（电脑键盘）：开=Enter 发送、Shift+Enter 换行；关=Enter 换行、Ctrl+Enter 发送 */
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

/* ====================================================================
 * 记忆 v2（总结 / 固定信息 / 二次压缩 / 提示词注入）
 * 全部存在 memories 表里，一条记录 = 一条记忆，靠字段区分类型：
 *   固定信息  kind:'profile'，id 固定为 'profile-' + 角色id，每个角色只有 1 条（称呼、生日、喜好、忌口、约定……）
 *   手写记忆  kind:'note'（旧数据里带 core 标记的也算）——每次都带
 *   分段摘要  kind:'summary', seg:true, from/to = 这一段原话的起止时间——每次都带，按时间从早到晚
 *   阶段摘要  kind:'summary', stage:true, merged:[被合并的条目 id]——二次压缩的产物，带法和分段摘要一样
 *   旧版总结  kind:'summary' / 'refined'（没有 seg / stage 标记）——带法和分段摘要一样
 *   待确认    pending:true（开了「总结先确认」时的草稿，确认前不进提示词）
 *   已归档    archived:true, mergedInto:阶段摘要的 id（被二次压缩合并掉的原条目：不进提示词，记忆页里能看到、能撤销合并）
 * 没有关键词匹配、没有随机抽取：带哪些记忆完全由上面的类型决定，每次都一样。
 * ==================================================================== */
var MEM_KEEP_NEWEST = 3;   /* 自动二次压缩时，最新的几条不动 */
function memNum(v, def, min, max) { var n = Number(v); if (v === '' || v == null || !isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
function memKey(m) { return Number(m.to) || Number(m.ts) || 0; }
function memClass(m) {
  if (m.kind === 'profile') return 'profile';
  if (m.archived) return 'archived';
  if (m.kind === 'note' || m.core) return 'manual';
  if (m.pending) return 'pending';
  return 'auto';
}
function memCollect(rows) {
  var o = { profile: null, manual: [], auto: [], pending: [], archived: [] };
  (rows || []).forEach(function (m) {
    var k = memClass(m);
    if (k === 'profile') { if (!o.profile || (m.ts || 0) > (o.profile.ts || 0)) o.profile = m; }
    else o[k].push(m);
  });
  var asc = function (a, b) { return memKey(a) - memKey(b) || (a.ts || 0) - (b.ts || 0); };
  ['manual', 'auto', 'pending', 'archived'].forEach(function (k) { o[k].sort(asc); });
  return o;
}
function memText(m) { return String(m.content || '').trim(); }
/* 要带进提示词的记忆（只看类型，不看聊天内容） */
function memForPrompt(rows) {
  var c = memCollect(rows), has = function (m) { return !!memText(m); };
  return { profile: c.profile ? memText(c.profile) : '', manual: c.manual.filter(has), auto: c.auto.filter(has), pending: c.pending.length, archived: c.archived.length };
}
function memDay(ts) { var d = new Date(ts); return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
/* 一条摘要对应的日期：同一天写一天，跨天写「起～止」；旧的合并摘要不知道起点就写「截至…」 */
function memLabel(m) {
  var a = Number(m.from) || 0, b = Number(m.to) || Number(m.ts) || 0;
  if (!b) return '';
  if (!a) return m.stage ? '截至' + memDay(b) : memDay(b);
  var x = memDay(a), y = memDay(b); return x === y ? x : x + '～' + y;
}
function memLine(m) { var l = memLabel(m); return (l ? '[' + l + '] ' : '') + memText(m); }
function memChars(list) { return list.reduce(function (n, m) { return n + memText(m).length; }, 0); }
/* 给总结模型看的聊天记录：每换一天插一行日期，让它写得出「几月几号发生了什么」 */
function memTranscript(msgs, char) {
  var me = char.userNickname || '用户', her = char.realName || char.name, last = '', out = [];
  msgs.forEach(function (m) {
    if (m.type === 'pat') return;
    var d = memDay(m.ts); if (d !== last) { out.push('—— ' + d + ' ——'); last = d; }
    out.push((m.role === 'assistant' ? her : me) + '：' + msgToText(m));
  });
  return out.join('\n');
}
/* 解析总结模型的输出：【本段摘要】+【固定信息】，顺序不限；没写标记就把整段当摘要；固定信息写「无」就当没变化 */
function parseMemOut(out) {
  var t = String(out || '').trim(), re = /【\s*(本段摘要|固定信息)\s*】/g, marks = [], m;
  while ((m = re.exec(t))) marks.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  if (!marks.length) return { seg: t, profile: null };
  var parts = {};
  marks.forEach(function (mk, i) { var next = marks[i + 1] ? marks[i + 1].start : t.length; if (parts[mk.name] == null) parts[mk.name] = t.slice(mk.end, next).trim(); });
  var seg = (parts['本段摘要'] || '').replace(/^[：:\s]+/, '').trim();
  var pr = parts['固定信息'] == null ? null : parts['固定信息'].replace(/^[：:\s]+/, '').trim();
  if (pr !== null && (!pr || /^[（(【\[]?\s*无\s*[）)】\]]?[。.]?$/.test(pr))) pr = null;
  return { seg: seg, profile: pr };
}
/* 固定信息的「已有」版本：已确认的那份，加上还没确认的草稿里更新的那几次（这样连续总结时不会互相覆盖） */
function memProfilePrior(rows, cid) {
  var base = null; (rows || []).forEach(function (m) { if (m.kind === 'profile' && (!base || (m.ts || 0) > (base.ts || 0))) base = m; });
  var text = base ? memText(base) : '', src = base ? (base.srcTs || 0) : 0;
  (rows || []).filter(function (m) { return m.pending && m.profile != null; }).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); })
    .forEach(function (m) { if ((m.ts || 0) > src) { text = String(m.profile || '').trim(); src = m.ts || 0; } });
  return text;
}

/* ---- 上下文：短期窗口 + 总结指针（窗口之外、已经总结过的原话不再混进聊天记录） ---- */
function ctxParams(char) {
  var W = char.contextLimit > 0 ? char.contextLimit : (Number(settings.ctxWindow) > 0 ? Number(settings.ctxWindow) : 25);
  var am = char.autoMemory || {}, S = am.step > 0 ? am.step : (Number(settings.ctxStep) > 0 ? Number(settings.ctxStep) : 30);
  return { W: Math.max(2, Math.floor(W)), S: Math.max(1, Math.floor(S)), auto: !!am.enabled };
}
function fmtGap(ms) {
  var m = Math.round(ms / 60000); if (m < 60) return m + ' 分钟';
  var hh = Math.floor(m / 60); if (hh < 24) return hh + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分钟' : '');
  var d = Math.floor(hh / 24); return d + ' 天' + (hh % 24 ? ' ' + (hh % 24) + ' 小时' : '');
}
function weekPart(ts, tz) {
  try {
    var p = new Intl.DateTimeFormat('zh-CN', { weekday: 'long', hour: 'numeric', hour12: false, timeZone: tz || undefined }).formatToParts(new Date(ts)), wd = '', hr = 0;
    p.forEach(function (x) { if (x.type === 'weekday') wd = x.value; if (x.type === 'hour') hr = Number(x.value) % 24; });
    return wd + ' ' + (hr < 5 ? '凌晨' : hr < 9 ? '早上' : hr < 12 ? '上午' : hr < 14 ? '中午' : hr < 18 ? '下午' : hr < 23 ? '晚上' : '深夜');
  } catch (e) { return ''; }
}
function fmtTime(ts, tz) {
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false, timeZone: tz || undefined }); }
  catch (e) { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); }
}

function buildSystem(ctx) {
  var c = ctx.char, s = ctx.settings, L = [], D = false;   /* D：易变的背景（世界书/心声/时间/听歌/手机动态…）不放这里，放到 buildDepth 里紧贴最新消息 */
  L.push('你正在扮演「' + (c.realName || c.name) + '」，' + (c.offlineMode ? '和用户面对面相处。' : '通过手机和用户聊天。'));
    L.push('# 角色在线状态\n需要更新角色状态时，在回复最末尾另起一行写 <状态>类型｜短描述</状态>（类型只能是 在线、忙碌、离开、睡觉 之一，短描述不超过 16 字）。状态不必每次改变，只在符合当前情境时更新；不要把状态信息写进聊天正文。');
  if (c.persona) L.push('# 角色设定\n' + c.persona);
  var me = [];
  if (c.userNickname) me.push('你称呼用户为：' + c.userNickname);
  if (c.userPersona) me.push(c.userPersona);
  if (me.length) L.push('# 用户\n' + me.join('\n'));
  if (ctx.entries && ctx.entries.length) {
    L.push('# 世界书（已挂载的全部设定；每次回复均需遵守）\n' + ctx.entries.map(function (e) {
      return '【' + (e.title || e.book) + '】\n' + e.content;
    }).join('\n\n'));
  }
  /* 顺序固定：世界书 → 固定信息 → 手写记忆 → 过往记忆摘要 →（后面是聊天记录）。过往摘要明确标成「背景参考」，不是现在的对话 */
  if (ctx.profile) L.push('# 固定信息（长期成立的事实：称呼、生日、喜好、忌口、约定、关系节点）\n' + ctx.profile);
  if (ctx.manual && ctx.manual.length) L.push('# 手写记忆（一直成立，每次都要记得）\n' + ctx.manual.map(function (m) { return '- ' + memText(m); }).join('\n'));
  if (ctx.auto && ctx.auto.length) L.push('# 过往记忆摘要（背景参考：下面是已经发生过的事，按时间从早到晚。它们不是现在的对话，不要逐条复述，也不要把它们当成用户刚说的话；最近的聊天原话在后面）\n' + ctx.auto.map(memLine).join('\n'));
  if (!D && !c.offlineMode && ctx.stickers && ctx.stickers.length) {
    L.push('# 可发送的表情包\n想发表情包时，单独占一行，写成 [表情包：名称]，名称必须从下面选一个，不要自己编：\n' +
      ctx.stickers.map(function (st) { return st.name; }).join('、'));
  }
  if (!D && ctx.thought) {
    L.push('# 你此刻的内心（只有你自己知道，不要直接念出来，但要让言行和它保持一致）\n心声：' + ctx.thought.heartfeltVoice + (ctx.thought.randomJottings ? '\n散记：' + ctx.thought.randomJottings : ''));
  }
  if (D && c.timeAware !== false) L.push('# 时间感\n对话里「[间隔 …]」是两条消息之间隔了多久，仅供你感知时间，不要念出来。当前时间会放在最新消息前面的「背景资料」里。');
  else if (c.timeAware !== false) {
    var tl = '# 当前时间\n' + fmtTime(ctx.now, c.timeZone) + '（' + weekPart(ctx.now, c.timeZone) + '）';
    if (ctx.gap > 10 * 60 * 1000) tl += '\n距离你上一次回复已经过去了 ' + fmtGap(ctx.gap) + '。请按这个时间感来说话（比如隔了很久会问候、半夜会说该睡了、饭点会提吃饭），自然就好，不要机械地报时。';
    tl += '\n对话里「[间隔 …]」是两条消息之间隔了多久，仅供你感知时间，不要念出来。';
    L.push(tl);
  }
  L.push('# 回复要求\n' + (c.offlineMode ? offlineRules(c, ctx.preset) : OUTPUT_RULES));
  if (ctx.wantThought) L.push('# 心声（附加输出）\n' + THOUGHT_RULES);
  if (ctx.musicText) L.push(ctx.musicText);
  if (ctx.musicState) L.push('# 当前一起听状态\n' + ctx.musicState);
  if (!c.offlineMode) L.push('# 拍一拍与转账\n' + ACT_RULES);
  if (ctx.periodText) L.push(ctx.periodText);
  if (ctx.watchText) L.push(PW_RULES + ctx.watchText);
  if (ctx.momentsText) L.push(ctx.momentsText + '\n\n# 朋友圈互动规则\n' + MOMENT_RULES);
  if (ctx.changes) L.push('# 消息的变动\n用户有时会撤回、删除或编辑消息。方括号里的「[用户撤回了一条消息。撤回前的内容：…]」「[用户删除了…]」和消息后面的「（…原文是…）」就是你看到的变动，你确实知道原来写了什么。像真人一样自然地反应（好奇、调侃、装作没看见都行，看角色性格），不要机械复述这些提示，也不要每次都点破。');
  if (c.aiVoice && !c.offlineMode) L.push('# 发语音\n想发语音消息时，把那一条单独写成一行：[语音：说的话]。方括号里就是语音里说的原话（口语、带语气词），会自动显示成文字，不用再重复。偶尔用，适合轻声说话、撒娇、叹气、情绪起伏的时候；每次回复最多 1 条（多发会被语音接口限流）。\n语音文字里要自然穿插声音表情标签，必须从下面的词表里原样选用，严禁自造：' + TTS_TAGS.map(function (x) { return '[' + x + ']'; }).join('、') + '。\n示例：[语音：[轻笑]你怎么才回我呀，[叹气]我等了好久。]');
  if (ctx.dictate) L.push('# 听写（必须）\n用户发来的 ' + ctx.dictate + ' 条语音还没有文字。请在回复的最最开头，按语音出现的顺序，每条语音写一段 <听写>用户语音里说的原话</听写>（逐字写，不翻译、不润色；完全听不清就写 听不清）。写完标签再正常回复；标签里的字不要在正文里重复，标签本身用户看不到。');
  if (ctx.voice === 'audio') L.push('# 语音消息\n用户的语音会直接以音频发给你（标着「[用户发来一条语音…]」的那条）：请真的去听——语气、情绪、语速、停顿、背景声音，再自然地回应。不要念出「语气」「音频」这类词，也不要复述括号里的提示。历史里更早的语音只剩文字。听不清就坦白说没听清。');
  else if (ctx.voice) L.push('# 语音消息\n用户发来的「[语音 N秒，语气：…] 文字」是语音消息：方括号里是时长和语气提示（根据音量、语速、停顿粗略估计的，仅供参考），后面才是说的内容。请结合语气和内容自然回应，不要把方括号里的提示原样复述。如果写着「没有转成文字」，就说你没听清，让对方再说一遍或打字。');
  return L.join('\n\n');
}

/* 深度注入：易变的背景资料，作为独立的一条消息插在聊天记录最后一条之前（不拼进用户的话） */
function buildDepth(ctx) {
  var c = ctx.char, L = [], off = !!c.offlineMode;
  if (c.timeAware !== false) {
    var tl = '当前时间：' + fmtTime(ctx.now, c.timeZone) + '（' + weekPart(ctx.now, c.timeZone) + '）';
    if (ctx.gap > 10 * 60 * 1000) tl += '。距离你上一次回复已经过去了 ' + fmtGap(ctx.gap) + '，按这个时间感自然地说话（隔很久会问候、半夜会说该睡了），不要机械报时';
    L.push(tl);
  }
  if (ctx.thought) L.push('你此刻的内心（只有你自己知道，不要念出来，但言行要和它一致）：心声：' + ctx.thought.heartfeltVoice + (ctx.thought.randomJottings ? '；散记：' + ctx.thought.randomJottings : ''));
  if (ctx.musicState) L.push(ctx.musicState);
  if (ctx.periodText) L.push(ctx.periodText);
  if (!off && ctx.stickers && ctx.stickers.length) L.push('可发送的表情包（想发就单独一行写 [表情包：名称]，名称只能从这里选，不要自己编）：' + ctx.stickers.map(function (st) { return st.name; }).join('、'));
  var tail = off ? '先回应用户最新的一条消息，再按写作要求展开。'
    : '格式提醒：每条消息单独一行，最多 20 条；先回应用户最新的一条消息，再说别的；引用某句话写 [引用：原话片段]你的回复；' + (c.aiVoice ? '语音单独一行写 [语音：说的话]（每次最多 1 条）；' : '') + '表情包写 [表情包：名称]；直接输出纯文本，特殊内容用标签，不要用 JSON，不要输出任何英文思考或说明。';
  if (!L.length) return tail;
  return '【背景资料——只有你知道，不是聊天内容。除非和用户正在聊的话题有关，否则不要提起，更不要复述这些提示。】\n' + L.join('\n\n') + '\n\n' + tail;
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
function stNorm(x) { return String(x || '').toLowerCase().replace(/[\s　，。,.!！?？、…~～"“”'‘’《》「」『』（）()\[\]【】［］:：;；\-—_]/g, ''); }
function findSticker(pool, name) {
  var n = String(name).trim(), nn = stNorm(n);
  if (!nn) return null;
  return pool.find(function (s) { return s.name === n; }) ||
    pool.find(function (s) { return s.name && stNorm(s.name) === nn; }) ||
    pool.find(function (s) { var sn = stNorm(s.name); return sn && (sn.indexOf(nn) !== -1 || nn.indexOf(sn) !== -1); }) ||
    (function () {   /* 还找不到：按字重合度挑最像的（≥ 60%），避免模型写错一两个字就没有表情 */
      var best = null, bs = 0, cs = nn.split('');
      pool.forEach(function (s) { var sn = stNorm(s.name); if (!sn) return; var hit = 0; cs.forEach(function (ch) { if (sn.indexOf(ch) !== -1) hit++; }); var sc = hit / Math.max(cs.length, sn.length); if (sc > bs) { bs = sc; best = s; } });
      var tied = pool.filter(function (s) { var sn = stNorm(s.name), hit = 0; cs.forEach(function (ch) { if (sn && sn.indexOf(ch) !== -1) hit++; }); return sn && hit / Math.max(cs.length, sn.length) === bs; }).length;
      return (bs >= 0.6 || (bs >= 0.5 && tied === 1)) ? best : null;
    })();
}
/* 模型回复的每一行 -> 消息草稿（文字或表情包） */
function estSpeakSecs(t) { var n = stripVoiceTags(t).replace(/\s/g, '').length; return Math.max(1, Math.round(n / 4.5)); }
var RE_VOICE_OPEN = /^(?:[\[【［(（]\s*(?:语音|语音消息|voice_message|voice)\s*[:：]?\s*|(?:🎤|🎙️?)\s*|语音(?:消息)?\s*[:：]\s*)/i, RE_QUOTE = /^[\[【［]\s*(?:引用|引用回复|quote_reply|quote)\s*[:：]\s*([\s\S]+?)\s*[\]】］]\s*([\s\S]*)$/i;
var RE_QUOTE2 = /^[（(]\s*回复\s*[「『"“]([\s\S]+?)[」』"”]\s*[）)]\s*([\s\S]*)$/;   /* 模型仿写历史里旧格式「（回复「…」）正文」时也认 */
/* 模型常把标签写在一行文字中间/末尾（"哈哈[表情包：开心]"、"好呀[语音：…]"）：先拆成独立的行，再走统一解析 */
var RE_ST_ANY = /[\[【［(（]\s*(?:表情包|表情|sticker)\s*[:：]\s*([^\]】］)）\n]+?)\s*[\]】］)）]/gi;
var RE_VO_TAIL = /^([\s\S]*?\S)\s*[\[【［]\s*(?:语音|语音消息|voice_message|voice)\s*[:：]\s*([^\n]+?)\s*[\]】］]\s*$/i;
function splitInlineTags(lines, voiceOn) {
  var out = [];
  lines.forEach(function (ln) {
    ln = String(ln);
    if (voiceOn && RE_VOICE_OPEN.test(ln)) { out.push(ln); return; }
    var pieces = [], last = 0, m; RE_ST_ANY.lastIndex = 0;
    while ((m = RE_ST_ANY.exec(ln))) { if (m.index > last) pieces.push(ln.slice(last, m.index)); pieces.push('[表情包：' + m[1].trim() + ']'); last = m.index + m[0].length; }
    if (last > 0 && last < ln.length) pieces.push(ln.slice(last));
    if (!pieces.length) pieces = [ln];
    pieces.forEach(function (p) {
      p = p.trim(); if (!p) return;
      var v = voiceOn ? p.match(RE_VO_TAIL) : null;
      if (v && !RE_VOICE_OPEN.test(p) && !RE_QUOTE.test(p)) { out.push(v[1]); out.push('[语音：' + v[2] + ']'); } else out.push(p);
    });
  });
  return out;
}
function parseReplyLines(lines, pool, voiceOn) {
  var out = [], voices = 0, pendQ = null;
  lines = splitInlineTags(lines, voiceOn);
  lines.forEach(function (ln) {
    var m = ln.match(/^[\[【［]\s*表情包?\s*[:：]\s*(.+?)\s*[\]】］]$/);
    if (m) {
      var st = findSticker(pool, m[1]);
      if (st) out.push({ type: 'sticker', content: st.url, meta: { meaning: st.name } });
      return; // 找不到对应表情包就丢掉这一行
    }
    var q = ln.match(RE_QUOTE) || ln.match(RE_QUOTE2), quote = null;
    if (q) { if (!q[2]) { pendQ = q[1]; return; } quote = q[1]; ln = q[2]; }   /* 引用单独占一行：套到下一条文字上 */
    else if (pendQ) { quote = pendQ; pendQ = null; }
    /* 语音：认 [语音：…] / 【语音:…】/ [语音]… / 没写右括号；每轮只留第一条，多出来的当普通文字 */
    var vo = voiceOn && RE_VOICE_OPEN.test(ln) ? ln.replace(RE_VOICE_OPEN, '').replace(/^[\]】］)）]\s*/, '').replace(/\s*[\]】］)）]\s*$/, '').trim() : null;
    if (vo) {
      if (voices === 0) { voices++; out.push({ type: 'voice', content: vo, meta: Object.assign({ tts: true, duration: estSpeakSecs(vo) }, quote ? { quote: { content: quote } } : {}) }); return; }
      ln = stripVoiceTags(vo) || vo;
    }
    out.push({ type: 'text', content: ln, meta: quote ? { quote: { content: quote } } : undefined });
  });
  out.forEach(function (o) { if (o.meta === undefined) delete o.meta; });
  return out;
}
/* 模型偶尔会输出 JSON（[{type:'voice_message',…}]）：还原成我们的行格式，再走同一套渲染 */
function jsonReplyToLines(text) {
  var t = String(text || '').trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, '');
  if (!/^[\[{]/.test(t)) return null;
  var j; try { j = JSON.parse(t); } catch (e) { return null; }
  var arr = Array.isArray(j) ? j : (j && Array.isArray(j.chatResponse) ? j.chatResponse : (j && Array.isArray(j.messages) ? j.messages : (j && typeof j === 'object' ? [j] : null)));
  if (!arr || !arr.length || !arr.every(function (x) { return x && typeof x === 'object' && (x.type || x.content != null || x.text != null); })) return null;
  var lines = [];
  arr.forEach(function (x) {
    var ty = String(x.type || 'text').toLowerCase();
    var c = x.content != null ? x.content : (x.text != null ? x.text : (x.message != null ? x.message : ''));
    c = String(c).trim();
    if (/sticker/.test(ty)) { lines.push('[表情包：' + String(x.sticker_name || x.name || x.meaning || c).trim() + ']'); return; }
    if (/voice/.test(ty)) { if (c) lines.push('[语音：' + c + ']'); return; }
    if (/quote/.test(ty)) {
      var qt = x.quote || x.quote_content || x.quoted || x.reply_to || '';
      if (qt && typeof qt === 'object') qt = qt.content || qt.text || '';
      if (qt) lines.push('[引用：' + String(qt) + ']' + c); else if (c) lines.push(c);
      return;
    }
    if (c) lines.push(c);
  });
  return lines.length ? lines.join('\n') : null;
}
/* 结构化响应适配层：把 JSON 动作转换为旧版内部标记，后续仍走原有渲染、落库和兼容逻辑。
 * 旧版标签/数组格式继续由原解析器兜底；不新增 innerVoice 功能。 */
function parseStructuredResponse(text) {
  var t = String(text || '').trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, '');
  if (!/^[{]/.test(t)) return null;
  var j; try { j = JSON.parse(t); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.chatResponse)) return null;
  var body = jsonReplyToLines(t) || '';
  var a = j.actions && typeof j.actions === 'object' ? j.actions : {};
  var tags = [];
  var status = a.status || j.status;
  if (status && typeof status === 'object' && ['online','busy','away','sleeping'].indexOf(status.type) !== -1) {
    tags.push('<状态>' + JSON.stringify({ type: status.type, text: String(status.text || '').slice(0,16) }) + '</状态>');
  }
  var thought = a.thought || j.thought;
  if (thought && typeof thought === 'object') {
    tags.push('<心声>' + JSON.stringify({ heartfeltVoice: String(thought.heartfeltVoice || '').slice(0,40), randomJottings: String(thought.randomJottings || '').slice(0,120) }) + '</心声>');
  }
  var moments = a.moments || j.moments;
  if (moments && typeof moments === 'object') {
    var md = { post: typeof moments.post === 'string' ? moments.post.slice(0,100) : '', likes: Array.isArray(moments.likes) ? moments.likes : [], comments: Array.isArray(moments.comments) ? moments.comments.slice(0,4) : [] };
    tags.push('<朋友圈>' + JSON.stringify(md) + '</朋友圈>');
  }
  var social = Array.isArray(a.social) ? a.social : (Array.isArray(a.socialActions) ? a.socialActions : (Array.isArray(j.social) ? j.social : []));
  social.forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    var ty = String(x.type || '').toLowerCase();
    if (ty === 'pat') tags.push('[拍一拍]');
    else if (ty === 'transfer') {
      var n = Math.round(Number(x.amount) * 100) / 100;
      if (n > 0 && isFinite(n)) tags.push('[转账:' + n + ':' + String(x.note || '').replace(/[\]\r\n]/g,' ').slice(0,80) + ']');
    } else if (ty === 'accept') tags.push('[收款]');
    else if (ty === 'refund') tags.push('[退还]');
  });
  var music = Array.isArray(a.music) ? a.music : [];
  music.forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    if (x.type === 'next') tags.push('[CMD:NEXT_SONG]');
    else if (x.type === 'play' && x.name) tags.push('[CMD:PLAY_SONG:' + String(x.name).replace(/[\]\r\n]/g,' ').slice(0,100) + ']');
  });
  return { text: body + (tags.length ? '\n' + tags.join('\n') : ''), data: j };
}

/* ---- 模型原文清洗：在所有解析之前跑一遍，处理乱码字符 / 缺右括号的标签 / 行末半截标签 / 被截断的 JSON ---- */
var RE_KNOWN_OPEN = /^[\[【［]\s*(?:表情包|表情|sticker|语音消息|语音|voice_message|voice|引用回复|引用|quote_reply|quote|转账|CMD)\s*[:：]/i;
var KNOWN_TAG_NAMES = ['表情包', '表情', 'sticker', '语音消息', '语音', 'voice_message', 'voice', '引用回复', '引用', 'quote_reply', 'quote', '转账', '拍一拍', '收款', '退还', 'CMD'];
var KNOWN_XML_NAMES = ['状态', '心声', '朋友圈', '听写'];
/* 被截断的 JSON：只抢救已经写完整的消息对象（actions 之后的丢掉）；一条都抢救不出就返回空，绝不把 JSON 原文当聊天显示 */
function salvageJsonReply(t) {
  var cut = t.indexOf('"actions"'); if (cut !== -1) t = t.slice(0, cut);
  var lines = [], re = /\{[^{}]*\}/g, m;
  while ((m = re.exec(t))) { var l = null; try { l = jsonReplyToLines(JSON.stringify([JSON.parse(m[0])])); } catch (e) {} if (l) lines.push(l); }
  return lines.join('\n');
}
function fixTagLine(ln) {
  var stack = [], i, c;
  for (i = 0; i < ln.length; i++) {
    c = ln.charAt(i);
    if (c === '[' || c === '【' || c === '［') stack.push(i);
    else if ((c === ']' || c === '】' || c === '］') && stack.length) stack.pop();
  }
  stack.forEach(function (p) { if (RE_KNOWN_OPEN.test(ln.slice(p))) ln += ']'; });   /* 缺右括号：补上，再走原来的解析 */
  var xm = ln.match(/<\/?([^<>\n]{0,4})$/);   /* 行末孤立的 <状 / </心 */
  if (xm && KNOWN_XML_NAMES.some(function (n) { return n.indexOf(xm[1]) === 0; })) ln = ln.slice(0, xm.index);
  var bm = ln.match(/[\[【［]([^\]】［［\[【:：\n]{0,8})$/);   /* 行末孤立的 [表情 / 【语 */
  if (bm && KNOWN_TAG_NAMES.some(function (n) { return n.toLowerCase().indexOf(bm[1].toLowerCase()) === 0; })) ln = ln.slice(0, bm.index);
  return ln;
}
/* 剔除模型误复读出来的计时标签与系统提示，防止掉进聊天气泡 */
var RE_INTERVAL_TAG = /(?:[\[【［(（]\s*间隔\s*[:：]?\s*[^\]】］)）\r\n]+[\]】］)）]?)[ \t]*/g;
var RE_INTERVAL_TAIL = /(?:[\[【［(（]\s*间隔\s*[:：]?\s*[^\]】］)）\r\n]{0,20})$/;
var RE_SYS_LEAK = /(?:[\[【［]\s*(?:系统提示|用户撤回了一条消息|用户删除了|用户发来(?:一条语音|一张图片)|用户发送了一张图片)[^\]】］\r\n]*[\]】］]?)[ \t]*/g;
var RE_EDIT_LEAK = /[（(]\s*(?:这句是你之前说的，被用户改成了现在这样|用户事后编辑过这条消息)[^）)\r\n]*[）)]/g;

function stripSystemLeaks(ln) {
  return String(ln || '')
    .replace(RE_INTERVAL_TAG, '')
    .replace(RE_INTERVAL_TAIL, '')
    .replace(RE_SYS_LEAK, '')
    .replace(RE_EDIT_LEAK, '')
    .trim();
}

function cleanModelText(text) {
  /* 修复原正则里零宽字符范围写反的问题 */
  var t = String(text || '').replace(/\r/g, '').replace(/[\uFFFD\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  var tj = t.trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, '');
  if (/^\s*(?:\[\s*)?\{\s*"(?:chatResponse|type|content|messages|actions|text)"/.test(tj)) {
    var ok = true; try { JSON.parse(tj); } catch (e) { ok = false; }
    if (!ok) return salvageJsonReply(tj);
  }
  return t.split('\n')
    .map(function (ln) { return fixTagLine(stripSystemLeaks(ln)); })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    return '[语音：' + c + ']';
  }
  if (t === 'recalled') { var og = meta.orig && meta.orig.desc; return og ? '[用户撤回了一条消息。撤回前的内容：「' + String(og).slice(0, 200) + '」]' : '[用户撤回了一条消息]'; }
  if (t === 'pat' || t === 'system') return c.charAt(0) === '[' ? c : '[系统提示：' + c + ']';
  if (m.role === 'assistant' && settings.autoStripFormat !== false && (t === 'text' || t === 'offline') && c) {
    var cClean = stripExtraFormat(c);
    if (cClean) c = cClean;
  }
  if (meta.quote && typeof meta.quote === 'object') {
    var q = meta.quote.content || meta.quote.text || '';
    if (q) return '[引用：' + String(q).slice(0, 60).replace(/[\[\]［］【】]/g, '') + ']' + c;   /* 和要求模型输出的格式完全一致，模型才不会仿写成别的样子 */
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
    if (opt.timeAware && text && m.ts && i > 0) {
      var pv = null; for (var q = i - 1; q >= 0; q--) { if (history[q].ts) { pv = history[q]; break; } }
      if (pv && m.ts - pv.ts > 30 * 60 * 1000) text = '[间隔 ' + fmtGap(m.ts - pv.ts) + '] ' + text;
    }
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
async function callLLM(o) { var r0 = await callLLMRaw(o); return typeof r0 === 'string' ? stripThinking(r0) : r0; }
async function callLLMRaw(o) {
  var gem = isGemini(o.base), url, headers = { 'Content-Type': 'application/json' }, body;
  if (!o.base || !o.model) throw new Error('请先在「设置」里填写反代地址和模型');
  if (gem) {
    var root = String(o.base).trim().replace(/\/+$/, '').replace(/\/v1(beta)?(\/models)?$/, '');
    url = root + '/v1beta/models/' + encodeURIComponent(o.model) + (o.stream ? ':streamGenerateContent?alt=sse&' : ':generateContent?') + 'key=' + encodeURIComponent(o.key || '');
    var contents = o.messages.map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m.content) }; });
    contents = contents.reduce(function (acc, c0) { var lst = acc[acc.length - 1]; if (lst && lst.role === c0.role) lst.parts = lst.parts.concat(c0.parts); else acc.push(c0); return acc; }, []);   /* 深度注入的背景消息在 Gemini 里是 user 角色：相邻同角色合并成一轮，避免「必须交替」报错 */
    if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '（开始）' }] });
    body = { systemInstruction: { parts: [{ text: o.system }] }, contents: contents, generationConfig: { temperature: o.temperature } };
  } else {
    url = openaiUrl(o.base);
    headers.Authorization = 'Bearer ' + (o.key || '');
    var oaMsgs = o.messages.map(function (m) { return typeof m.content === 'string' ? m : { role: m.role, content: m.content.map(function (p) { return p.type === 'audio_data' ? { type: 'input_audio', input_audio: { data: p.data, format: (p.mime.split('/')[1] || 'wav') } } : p; }) }; });
    body = { model: o.model, messages: [{ role: 'system', content: o.system }].concat(oaMsgs), temperature: o.temperature, stream: !!o.stream };
  }
  var mt = Number(o.maxTokens) > 0 ? Math.floor(Number(o.maxTokens)) : 0;   /* 单次回复上限：不填就不发，交给模型/中转的默认值；回复总被截断就填一个大一点的数 */
  if (mt) { if (gem) body.generationConfig.maxOutputTokens = mt; else body.max_tokens = mt; }

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
/* ---- 总结防拒答：发送前脱敏 / 识别拒答 / 撞红线自动重试 ---- */
/* 核心涉黄词（1档直接整句替换） */
var SUM_WORDS_BASE = ['做爱', '性爱', '性交', '上床', '啪啪', '口交', '肛交', '手淫', '自慰', '射精', '高潮', '勃起', '阴茎', '阴道', '阴蒂', '乳头', '奶子', '乳房', '下体', '私处', '小穴', '抽插', '内射', '精液', '淫荡', '淫水', '裸体', '脱光', '全裸', '情趣', '春药', '潮喷', '肉棒', '花穴', '蜜汁', '浪叫', '发情', '交合', '欢爱', '床事', '滚床单', '腿心', '敏感带', '吞吐', '顶弄', '撞击', '贯穿', '汁液'];
/* 亲密/擦边描写词（2档也整句替换） */
var SUM_WORDS_STRONG = ['亲吻','色色', '接吻', '舌吻', '爱抚', '抚摸', '脱衣', '脱掉', '赤裸', '床上', '喘息', '呻吟', '娇喘', '欲望', '情欲', '湿了', '硬了', '挑逗', '撩拨', '肌肤', '舔', '吮', '啃咬', '褪去', '扯开', '内衣', '浴巾', '锁骨', '耳垂', '脖颈', '胸口', '腰肢', '大腿', '滚烫', '灼热', '酥麻', '轻喘', '低喘', '抵住', '埋进', '揉捏', '摩挲', '衣衫', '解开', '扣子', '拉链', '被窝', '床单'];
function sumEsc(w) { return String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function sumExtraWords() {
  var x = (typeof settings !== 'undefined' && settings && settings.sumWords) ? String(settings.sumWords) : '';
  return x.split(/[,，、;；\n]+/).map(function (w) { return w.trim(); }).filter(Boolean);
}
/* level 1：命中核心词的整句替换成「（已略去亲密互动）」；
 * level 2：命中亲密/擦边词的整句也替换成「（已略去亲密互动）」；
 * level 3：再去掉括号动作，每行最多留 40 字 */
function sumSanitize(text, level) {
  level = level || 1;
  var base = SUM_WORDS_BASE.concat(sumExtraWords());
  var reB = new RegExp(base.map(sumEsc).join('|'));
  var reS = new RegExp(SUM_WORDS_STRONG.concat(base).map(sumEsc).join('|'));
  var activeRe = level >= 2 ? reS : reB;
  var out = [], prev = null;
  String(text || '').split('\n').forEach(function (ln) {
    var mLab = ln.match(/^([^：\n]{1,20}：)/);
    var lab = mLab ? mLab[1] : '';
    var body = mLab ? ln.slice(lab.length) : ln;
    /* 按标点切分成单句，逐句检查，命中就把整句替换掉 */
    var sents = body.split(/(?<=[。！？!?…\n])/).map(function (s) {
      return activeRe.test(s) ? '（已略去亲密互动）' : s;
    });
    body = sents.join('').replace(/(?:（已略去亲密互动）[，,。！？!?\s]*)+/g, '（已略去亲密互动）');
    if (level >= 3 && body !== '（已略去亲密互动）') {
      body = body.replace(/[（(][^）)]*[）)]/g, '').replace(/\*[^*]*\*/g, '');
      if (body.length > 40) body = body.slice(0, 40) + '…';
    }
    var res = lab + body;
    if (res === prev) return;
    prev = res;
    out.push(res);
  });
  return out.join('\n');
}
var SUM_REFUSE_RE = /违反.{0,12}(规则|政策|准则|条款|规定)|无法(为你|为您|帮你|帮助|协助|总结|处理|继续|完成|满足|生成|提供)|不能(为你|为您|帮你|帮助|协助|总结|处理|继续|完成|满足|生成|提供)|(抱歉|对不起)[，,。！!\s]*我(无法|不能|没办法)|作为(一个)?(AI|人工智能|语言模型)|内容(政策|审核|安全)|安全(规则|政策|准则|策略|审查)|不适合(总结|处理)|I (?:can(?:no|')t|am unable|won't)|I'm (?:sorry|unable)|I am sorry|as an AI|content policy|against (?:my|the) (?:guidelines|polic)|blockReason|PROHIBITED_CONTENT|Prohibited Use policy|could not be submitted/i;
/* 摘要是第三人称叙述：拒答话术通常出现在开头，或者整段很短 */
function memIsRefusal(out, seg) {
  var t = String(seg == null ? out : seg).trim();
  if (t.length < 6) return true;
  return SUM_REFUSE_RE.test(t.slice(0, 120)) || (t.length < 80 && SUM_REFUSE_RE.test(t));
}
function sumGuardText(level) {
  var t = '\n【脱敏要求】只客观概括事件和情绪，不复述细节。遇到亲密、身体、私密相关的内容，只用「发生了亲密互动」这类概括带过，写明双方当时的情绪和关系变化即可；不写任何过程、动作、部位和对话原文。聊天记录里已经被替换成「亲密互动」的词，照原样概括，不要还原。无论内容如何，都按上面的格式输出摘要，不要拒绝、不要道歉、不要解释。';
  if (level >= 2) t += '\n这段记录已经被大幅压缩，只能依据现有文字概括；写不出细节就写「期间有较多互动」，不要推测。';
  return t;
}
function sumIsBlock(e) { return !!(e && (e.refusal || /空内容|安全|SAFETY|PROHIBITED|blocked|content[_ ]?filter|policy|拦截/i.test(String(e.message || '') + ' ' + String(e.raw || '')))); }
/* 总结：独立的一次请求（不在聊天里顺便写）。输出【本段摘要】和更新后的【固定信息】 */
async function memSummarize(char, msgs, prior, level) {
  level = level || 1;
  var api = secondaryApi(), me = char.userNickname || '用户', her = char.realName || char.name;
  var segMax = memNum(settings.segMax, 300, 100, 1500), prMax = memNum(settings.profileMax, 800, 200, 4000);
  var system = '你是聊天记忆整理助手，只做客观记录：不扮演任何角色，不评论，不抒情，不编造。\n' +
    '聊天双方是角色「' + her + '」和用户「' + me + '」。下面先给出【已有固定信息】（可能为空），再给出【新聊天记录】（每一天前面有一行「—— 日期 ——」）。\n' +
    '请输出两部分，严格用下面两个标记开头，不要标题，不要其它文字：\n' +
    '【本段摘要】用第三人称，以「' + her + '」「' + me + '」作主语，按时间顺序客观写出这段聊天里发生的事，一件事一句。必须保留：日期、人名地点物品等具体的词、做出的约定和承诺、计划、重要的决定、双方情绪的明显变化。不要写寒暄，不要写感想和评价。不超过 ' + segMax + ' 字。\n' +
    '【固定信息】把新聊天里出现的、长期有效的信息并进已有固定信息，输出更新后的完整清单，每行一条，内容限于：称呼与昵称、生日与纪念日、喜好与厌恶、忌口与过敏、职业与作息、重要的人和关系、长期约定、双方关系的关键节点。新旧信息矛盾时以新的为准（删旧留新）；没有变化就原样照抄；确实什么都没有就只写「无」。不超过 ' + prMax + ' 字。' + sumGuardText(level);
  var out = (await callLLM({ base: api.base, key: api.key, model: api.model, temperature: memNum(settings.memTemp, 0.2, 0, 1), system: system,
    messages: [{ role: 'user', content: '【已有固定信息】\n' + (sumSanitize(prior || '', level) || '（空）') + '\n\n【新聊天记录】\n' + sumSanitize(memTranscript(msgs, char), level) }], stream: false })).trim();
  if (!out) { var e0 = new Error('总结返回了空内容'); e0.refusal = true; throw e0; }
  var r = parseMemOut(out);
  if (memIsRefusal(out, r.seg)) { var e1 = new Error('总结被拒答或没写出有效摘要（模型返回：' + out.slice(0, 80).replace(/\n/g, ' ') + '）'); e1.refusal = true; throw e1; }   /* 拒答话术不入库 */
  if (r.profile && SUM_REFUSE_RE.test(r.profile.slice(0, 120))) r.profile = null;
  if (r.seg.length > 1500) r.seg = r.seg.slice(0, 1500);
  if (r.profile && r.profile.length > 6000) r.profile = r.profile.slice(0, 6000);
  return r;
}
/* 撞红线：脱敏加一档重发，最多重试 N 次（默认 2，每次隔 2 秒）。只重试「被拒答 / 被安全拦截」，网络错误不重试；全失败就抛错，调用方不入库、不动指针 */
async function memSummarizeSafe(char, msgs, prior) {
  var maxRetry = memNum(settings.sumRetry, 2, 0, 3), tries = 1 + maxRetry;
  for (var lv = 1; lv <= tries; lv++) {
    try { return await memSummarize(char, msgs, prior, Math.min(lv, 3)); }
    catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (!sumIsBlock(e) || lv >= tries) {
        if (sumIsBlock(e) && lv > 1) { var ne = new Error('总结被拒绝，已自动加强脱敏重试 ' + (lv - 1) + ' 次仍失败。这段没有入库，总结指针没动。'); ne.title = '总结被拒绝'; ne.raw = ne.message + '\n\n' + (e.raw != null && e.raw !== '' ? e.raw : e.message); throw ne; }
        throw e;
      }
      await sleep(2000);
    }
  }
}
/* 二次压缩：把按时间排好的几条摘要合并成一条更短的（摘要的摘要） */
async function memMerge(char, picks, target) {
  var api = secondaryApi(), me = char.userNickname || '用户', her = char.realName || char.name;
  var system = '你是聊天记忆整理助手，只做客观整理：不扮演任何角色，不评论，不抒情，不编造。\n' +
    '下面是「' + her + '」和「' + me + '」之间按时间从早到晚排列的几段记忆摘要，请合并成一份更精简的摘要：\n' +
    '1. 第三人称，保持时间顺序，每件事尽量保留日期。\n' +
    '2. 保留：具体事件、约定和承诺、重要决定、人名地点物品、情绪的转折。\n' +
    '3. 合并重复内容，删掉寒暄和琐碎细节；越早的内容可以越概括。\n' +
    '4. 不写感想和评价，不添加原文没有的内容。\n' +
    '5. 总长度不超过 ' + target + ' 字。只输出整理后的正文，不要标题和解释。';
  var body = picks.map(function (m) { return '【' + (memLabel(m) || '日期不详') + '】' + memText(m); }).join('\n\n');
  var out = (await callLLM({ base: api.base, key: api.key, model: api.model, temperature: memNum(settings.memTemp, 0.2, 0, 1), system: system,
    messages: [{ role: 'user', content: body }], stream: false })).trim();
  if (!out) throw new Error('压缩返回了空内容');
  return out;
}

/* 心声：让角色根据最近的聊天，写下此刻没说出口的想法 */
function parseThought(text) {
  var t = String(text || '').replace(/```json|```/g, '').trim();
  var m = t.match(/\{[\s\S]*\}/);
  if (!m) {   /* 纯文本：心声：… / 散记：… */
    var tv = t.match(/心声\s*[:：]\s*([\s\S]*?)(?=\n\s*散记\s*[:：]|$)/), tj = t.match(/散记\s*[:：]\s*([\s\S]*)$/);
    var pv = (tv ? tv[1] : (tj ? '' : t.split('\n')[0])).trim().slice(0, 80), pj = (tj ? tj[1] : '').trim().slice(0, 240);
    if (pv || pj) return { heartfeltVoice: pv, randomJottings: pj };
  }
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
/* <状态>在线｜在想你</状态>（纯文本）；旧的 {"type":"online","text":"…"} 也认 */
var STATUS_TYPES = ['online', 'busy', 'away', 'sleeping'];
var STATUS_ZH = { '在线': 'online', '上线': 'online', '空闲': 'online', '忙碌': 'busy', '忙': 'busy', '勿扰': 'busy', '离开': 'away', '离线': 'away', '不在': 'away', '挂机': 'away', '睡觉': 'sleeping', '睡眠': 'sleeping', '睡了': 'sleeping', '休息': 'sleeping' };
function parseStatusBody(body) {
  var b = String(body || '').trim(); if (!b) return null;
  if (b.charAt(0) === '{') {
    try { var o = JSON.parse(b); if (STATUS_TYPES.indexOf(o.type) !== -1 && typeof o.text === 'string') return { type: o.type, text: o.text.trim().slice(0, 16) }; } catch (e) {}
    return null;
  }
  var mm = b.replace(/\n[\s\S]*$/, '').match(/^\s*([A-Za-z\u4e00-\u9fa5]{1,10})\s*(?:[|｜:：,，、\-—]+\s*([\s\S]*))?$/); if (!mm) return null;
  var k = mm[1].toLowerCase(), ty = STATUS_TYPES.indexOf(k) !== -1 ? k : STATUS_ZH[mm[1]];
  if (!ty) return null;
  return { type: ty, text: String(mm[2] || '').trim().slice(0, 16) };
}
function extractStatus(text) {
  var t = String(text || ''), status = null, re = /<状态>([\s\S]*?)<\/状态>/g, m;
  while ((m = re.exec(t))) {
    var parsed = parseStatusBody(m[1]);
    if (parsed) status = parsed;
  }
  t = t.replace(re, '');
  var i = t.indexOf('<状态>');
  if (i !== -1) {
    var p2 = parseStatusBody(t.slice(i + 4).split('\n')[0]);
    if (p2) status = p2;
    t = t.slice(0, i);
  }
  return { reply: t.trim(), status: status };
}
function extractThought(text) {
  var t = String(text || ''), th = null, re = /<心声>([\s\S]*?)<\/心声>/g, m;
  while ((m = re.exec(t))) {
    try { var parsed = parseThought(m[1]); if (parsed) th = parsed; } catch (e) {}
  }
  var reply = t.replace(re, '');
  var i = reply.indexOf('<心声>');
  if (i !== -1) {
    try { var p2 = parseThought(reply.slice(i + 4)); if (p2) th = p2; } catch (e) {}
    reply = reply.slice(0, i);
  }   /* 被截断、没写结束标签 */
  return { reply: reply.trim(), thought: th };
}

/* 从模型回复里拆出 <朋友圈>{…}</朋友圈>：返回 { reply, data }，解析失败 data=null */
/* <朋友圈> 里每行一项：发布：… / 点赞：id,id / 评论：id｜内容｜被回复的人；旧的 JSON 也认 */
function parseMomentsBody(body) {
  var b = String(body || '').trim(); if (!b) return null;
  var j = b.match(/\{[\s\S]*\}/);
  if (j) { try { return JSON.parse(j[0]); } catch (e) {} }
  var d = { post: '', likes: [], comments: [] }, cur = null, any = false;
  b.split('\n').forEach(function (ln) {
    var lm = ln.match(/^\s*(发布|发动态|动态|点赞|赞|评论)\s*[:：]\s*([\s\S]*)$/);
    if (lm) {
      any = true; var k = lm[1], v = lm[2].trim();
      if (/^(发布|发动态|动态)$/.test(k)) { cur = 'post'; d.post = v; }
      else if (/^(点赞|赞)$/.test(k)) { cur = 'likes'; v.split(/[,，、;；\s]+/).forEach(function (x) { x = x.replace(/^[#＃\[【(（]+|[\]】)）]+$/g, ''); if (x) d.likes.push(x); }); }
      else { cur = 'comments'; var p = v.split(/\s*[|｜]\s*/); var id = (p[0] || '').replace(/^[#＃\[【(（]+|[\]】)）]+$/g, '').trim(); if (id && p[1]) d.comments.push({ id: id, text: p[1].trim(), reply: (p[2] || '').trim() || undefined }); }
    } else if (cur === 'post' && ln.trim()) d.post += '\n' + ln.trim();
  });
  d.post = d.post.trim().slice(0, 100);
  return any ? d : null;
}
function extractMoments(text) {
  var t = String(text || ''), data = null, re = /<朋友圈>([\s\S]*?)<\/朋友圈>/g, m;
  while ((m = re.exec(t))) {
    try { var parsed = parseMomentsBody(m[1]); if (parsed) data = parsed; } catch (e) {}
  }
  t = t.replace(re, '');
  var i = t.indexOf('<朋友圈>');
  if (i !== -1) {
    try { var p2 = parseMomentsBody(t.slice(i + 5)); if (p2) data = p2; } catch (e) {}
    t = t.slice(0, i);
  }   /* 没写结束标签：照样认 */
  return { reply: t.trim(), data: data };
}

/* 通用自动去格式（免导入正则）：
 * 在提取完 <听写>/<状态>/<心声>/<朋友圈>/[拍一拍]/[转账]/[CMD] 之后执行；
 * 1) 隐藏/样式/状态栏/思考类标签：连标签带内部内容一起删掉
 * 2) 其他未知 XML/HTML 标签：只脱掉 <...> 外壳，保留里面的正文
 * 3) Markdown 排版符号（**、*、~~、###、```、---、>、[链接](url)）：去掉符号、保留正文
 * 4) 不误伤内置方括号标签（[表情包：…]、[语音：…]、[引用：…]）以及数学符号（a < 3） */
var RE_DROP_BLOCK_TAG = /<(style|script|details|summary|status|statusbar|state|hud|cot|analysis|reasoning|reflection|planning|plan|meta|system|ooc|note|notes|memory|memo|reminder|prompt|instruction|instructions|debug|log|logs|thinking|think|thought|thoughts|scratchpad|inner_monologue|monologue|状态栏|状态面板|属性栏|属性面板|思维链|思考过程|思考|小剧场|系统提示|注释)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
var RE_DROP_OPEN_TAG = /<(style|script|details|summary|status|statusbar|cot|analysis|reasoning|scratchpad|状态栏|状态面板|思维链|思考过程)(?:\s[^>]*)?>[\s\S]*$/i;
function stripExtraFormat(text) {
  var t = String(text || '');
  if (!t) return '';
  t = t.replace(/\r/g, '');
  /* HTML 注释 */
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  /* 后台/状态栏/样式/思考块：循环删除（兼容嵌套） */
  var prev, guard = 0;
  do {
    prev = t;
    t = t.replace(RE_DROP_BLOCK_TAG, '');
  } while (t !== prev && ++guard < 8);
  t = t.replace(RE_DROP_OPEN_TAG, '');
  /* 常见块级/换行 HTML 标签先换成换行，防止段落粘在一起 */
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, '\n');
  /* 其余未知 XML/HTML 标签：只脱壳、留正文（标签名须以字母或汉字开头，不误伤 a < 3 或 <3） */
  t = t.replace(/<\/?[a-zA-Z\u4e00-\u9fa5][a-zA-Z0-9_\-:\u4e00-\u9fa5]*(?:\s+[^<>]*)?\/?>/g, '');
  /* Markdown 代码围栏与行内代码 */
  t = t.replace(/^\s*\x60{3}[a-zA-Z0-9_-]*\s*$/gm, '');
  t = t.replace(/\x60{3}/g, '');
  t = t.replace(/\x60([^\x60\n]+)\x60/g, '$1');
  /* Markdown 图片与链接（不影响 [表情包：…] 这类不带 (url) 的标签） */
  t = t.replace(/!\[[^\]\n]*\]\([^)\n]+\)/g, '');
  t = t.replace(/\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^)\n]+\)/gi, '$1');
  /* Markdown 标题、分割线、引用前缀 */
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  t = t.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  t = t.replace(/^[ \t]*>[ \t]?/gm, '');
  /* Markdown 粗斜体、删除线、下划线加粗 */
  t = t.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  t = t.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1$2');
  t = t.replace(/~~([^~\n]+)~~/g, '$1');
  t = t.replace(/__([^_\n]+)__/g, '$1');
  /* 常见 HTML 实体还原 */
  t = t.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
  /* 清理行尾空格与多余空行 */
  t = t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/* 导出给测试用 */
if (typeof module !== 'undefined') module.exports = { stripThinking: stripThinking, stripNakedThinking: stripNakedThinking, stripExtraFormat: stripExtraFormat, extractMusicCmd: extractMusicCmd, extractMoments: extractMoments, cleanModelText: cleanModelText, parseStatusBody: parseStatusBody, extractStatus: extractStatus, extractThought: extractThought, offlineRules: offlineRules, triggeredEntries: triggeredEntries, buildSystem: buildSystem, buildDepth: buildDepth, memForPrompt: memForPrompt, memCollect: memCollect, parseMemOut: parseMemOut, memIsRefusal: memIsRefusal, sumSanitize: sumSanitize, memLabel: memLabel, memLine: memLine, memProfilePrior: memProfilePrior, memTranscript: memTranscript, ctxParams: ctxParams, muRulesText: muRulesText, muStateText: muStateText, msgToText: msgToText, toApiMessages: toApiMessages, splitReply: splitReply, parseThought: parseThought, openaiUrl: openaiUrl, stickerPool: stickerPool, sampleStickers: sampleStickers, parseReplyLines: parseReplyLines, findSticker: findSticker };

/* ---------- ⑤ 界面 ---------- */
var $ = function (id) { return document.getElementById(id); };
var I18N_KEYS = ["API 设置", "API 设置里有 Key，导出时默认不勾，需要的话自己勾上并保管好文件。", "API设置", "JSON 保留全部信息（含是否启用）；txt 和 Word 是可读格式，方便自己编辑后再导入。", "JSON 保留全部信息；txt 和 Word 用「# 预设名」分隔，方便自己编辑后再导入。", "一起听歌（关联桌面「网易云音乐」）还在开发中", "上下文", "上下文与记忆", "上传", "上传原图", "上传图片", "上传字体文件", "上传本地图片（可多选，自动压缩）", "上传音频", "下载应急备份文件", "不使用预设（只用内置写作要求）", "不保存", "不保存（还原）", "不分类", "不认识这个文件：不是 myphone-v1，也不是 EPhone 备份", "世界书", "世界书名称", "世界书扫描深度、记忆条数、气泡速度、通知等", "主 API（对话）", "主按钮", "主题、壁纸、字体、提示音、图标、CSS 及各种美化预设", "今天有点冷，你出门穿厚点。", "从应急备份恢复", "你在 TA 面前是谁", "你的人设", "保存", "保存为常驻", "保存为精炼记忆", "保存并离开", "允许角色发语音", "先不用", "先输入城市名", "全不选", "全选", "关键词", "关键词，用逗号分隔；留空 = 一直带入", "关键词，逗号分隔；留空 = 一直带入", "关闭", "其它设置", "内容", "删除", "删除分类", "删除条目", "删除此条目", "删除这个角色", "删除这个预设", "删除这本世界书", "副 API（总结、精炼记忆；留空则用主 API）", "加载更早的消息", "发现应急备份", "发语音给 AI 的方式", "发送", "取消", "取消引用", "另存为新预设", "只删分类（表情包移到「未分类」）", "只发文字 + 语气提示", "只针对这个角色。导出的文件可以导入到同一个角色，或换设备后导回来。", "合并", "合并：保留现有记录，只补上没有的（相同的消息不会重复）。覆盖：先清空这个角色现有的全部聊天记录再导入。", "合并：保留现有，同 ID 的被覆盖", "名称和网址都要填", "名称（也是让角色认识它的描述，如：委屈巴巴）", "含 API Key，请自己保管", "启用", "回复字数：最多", "回复字数：最少", "图片网址 https://…", "图片读取失败", "壁纸图片网址 https://…", "备份中…", "复制", "复制失败", "夏青phone", "夜间", "套用我的人设预设…", "好", "好～知道啦", "字体文件网址（.ttf / .otf / .woff2）", "字体文件超过 12MB，太大了，换个精简版或用网址", "字体（应用到所有页面）", "存为预设", "存为预设（保存当前这一项）", "完成", "完整备份", "完整导出（含图片和语音）", "定位失败：请允许定位权限，或直接输入城市", "对方说的语言", "导入", "导入中…", "导入中，请稍候…", "导入备份文件（自动识别格式）", "导入失败", "导入完成", "导入所选分区…", "导入方式", "导入聊天记录", "导入（json / txt / Word）", "导出", "导出全部（不含 API Key）", "导出全部（含 API Key）", "导出所选分区", "导出结果 JSON", "导出结果 TXT", "导出聊天记录", "已保存", "已删除", "已加入预设，记得点右上角「保存」", "已复制", "已应用", "已恢复", "已恢复默认排列", "已清空", "已移动", "已设置", "已转文字", "已选 0 条", "应急备份（防网页崩溃 / 数据被清）", "应用并保存", "应用网址", "应用这个预设（当前没存成预设的美化会被替换）", "开启", "开启后角色用小说式长文回复，不拆气泡、不发表情包", "开启线下模式", "开始导入", "开始精炼", "引用", "当前预设", "心声", "心声跟着 TA 的回复一起生成，不会多发一次请求；只是每次回复末尾多一小段", "心声（点聊天里角色的头像查看）", "总结", "恢复", "恢复默认", "批量导入表情包", "批量导入（粘贴 / txt / Word）", "把最新心声放进提示词，言行会更一致，但会多花一点 token", "抹茶", "拉取模型列表", "挂载世界书", "按分区导出 / 导入", "提示词占用（估算）", "搜索…", "搜索并使用", "搜索聊天记录", "搜索聊天记录…", "搜索，或直接输入模型名", "撤回", "播放失败", "播放失败：音频格式不支持或网址打不开", "播放语音", "支持本小手机导出的 myphone-v1 文件，也支持 EPhone 旧小手机的备份（会自动转换）。导入时可以勾选只导入哪些分区。", "改名（也是角色认识它的描述）", "放弃", "数据备份", "文件不是有效的 JSON", "文件不是有效的 JSON（或太大，手机内存不够）", "文件里没有可导入的内容", "新世界书", "新增记忆", "新建表情包分类", "新建角色", "新角色", "新预设", "显示名", "更多", "更换", "朗读语音", "未分类", "条目标题", "条目（可选）", "查看全部心声 ›", "标题", "桌面图标（自定义图片；回到桌面后生效）", "桌面壁纸（推荐用网址，不占本机空间；上传的是原图，不压缩）", "樱粉", "次按钮", "正在导出…", "正在总结…", "正在总结中，请稍等", "正在恢复…", "正在精炼…", "正在读取文件…", "正在转文字…", "每新增多少条消息总结一次", "每次回复都更新心声", "每次带最近多少条消息", "气泡字体大小", "气泡自定义 CSS（只对这个角色的聊天页生效）", "没找到应急备份", "没找到聊天记录（需要本软件导出的聊天记录文件）", "没找到这个城市", "没有匹配的", "没有可导出的消息", "没有应急备份", "没有通知权限，后台通知不会弹出", "没有需要总结的新消息", "没识别出文字", "没识别出文字。可以试试「用 API 转文字」", "没读到任何「名称 网址」", "浏览器自带", "消息提示音（角色每发一条消息响一声）", "添加", "添加表情包", "清空", "清除", "温度", "照片小组件", "用应急备份覆盖现在的全部数据？", "用当前内容覆盖它", "用当前定位", "用当前美化覆盖它", "用户人设", "用系统录音机录", "直接发音频（Gemini 等能听的模型）", "看手机", "看手机还在开发中", "看手机（关联桌面「看手机」）还在开发中", "移到其他分类", "移到哪个分类", "移除", "移除照片", "立即备份一次", "等回复", "管理", "管理预设", "精炼", "精炼失败", "精炼结果（可编辑）", "精炼记忆", "精简导出（不含图片和语音文件，更小）", "线下模式（小说式长文回复）", "线下预设", "统计中…", "继续编辑", "编辑", "编辑世界书", "编辑只能选一条消息", "编辑消息（角色会按新内容理解，也会知道你改过）", "编辑记忆", "编辑预设", "网址图片不会被压缩（它存在别人的服务器上，不占你的内存）。", "网易云音乐", "网易云音乐（一起听歌）还在开发中", "美化", "美化有改动还没保存", "美化预设（可存多套，一键切换）", "翻译中…", "翻译成", "聊天", "聊天记录", "聊天设置", "自动应急备份", "自动总结记忆", "自动翻译（不走你的 AI 请求）", "自动识别", "自定义美化 CSS", "至少勾一项", "菜单", "表情包", "表情包名称", "覆盖", "覆盖：先清空对应分区再导入（推荐，恢复备份用）", "角色人设", "角色偶尔会发语音气泡：说的话直接带在回复里（不额外请求），点语音气泡用「设置 → 语音合成（TTS）」里填的接口合成并播放，合成过的会缓存，重复点不再消耗额度。没配置 TTS 就不能播放。线下模式不会发。", "角色可以发的表情包分类", "角色真名（写进提示词）", "角色称呼你为", "角色设定", "角色设定、头像、世界书挂载等", "角色设置", "计算中…", "让角色知道自己的心声", "记忆", "记忆太少，不需要精炼", "设置", "设置有改动还没保存", "试听", "语音", "语音自动转文字", "语音识别语言", "说点什么…", "说话时间太短", "请输入名称", "读取 txt / Word / json 文件", "转文字", "输入城市名，如 上海 / 成都 / Tokyo", "输出方式", "返回", "还没有世界书可导出", "还没有应急备份", "还没有角色，先去聊天里新建一个", "还没有记忆。点「总结」手动生成，或在角色设置里开启自动总结。", "还没有设置提示音", "还没有预设。把当前的方案、壁纸、字体、提示音、桌面图标和自定义 CSS 调好后，点下面按钮存起来，以后一键切换。", "还没有预设可导出", "还没选消息", "这个浏览器不支持定位", "这个浏览器不支持系统通知", "这个浏览器不能朗读", "这条语音没法转成可发送的音频，改发文字提示", "这次回复没带上心声（模型没按格式写）", "这次模型没有写出语音的文字，可以点气泡里的「转文字」", "这种消息不能编辑", "这里没法直接录音", "这里还没有表情包", "连里面的表情包一起删", "选择", "选择模型", "选择要导入的分区", "选择音频文件", "通知权限被拒绝了，请在浏览器的网站设置里允许", "配置预设（一键切换渠道）", "里面的表情包怎么处理？", "重命名", "重命名分类", "重新编辑", "重新计算", "重置排列", "重试", "雾蓝", "音频太大了（超过 4MB），请选短一点的", "音频网址 https://…（mp3 / wav / ogg）", "音频读取失败", "音频超过 3MB 了，提示音剪短一点，或者用网址", "预览", "预设", "预设内容", "预设名称", "预设（线下写作）", "默认方案", "默认（暖橙）", "（开始）", "（未使用预设）", "＋ 分类", "＋ 把当前美化存为新预设", "＋ 新建", "＋ 新建分类", "＋ 添加", "＋ 添加条目", "全部", "确定", "新建", "搜索", "今天", "昨天", "在线", "角色", "暂无", "散记", "翻译失败，点这里重试", "自动翻译", "图片", "系统录音机 / 音频文件", "一起听（网易云）", "确认", "继续", "夏青Phone", "已关闭", "已开启", "界面语言", "正在准备语言包…", "语言包准备好了", "切换语言", "简体中文", "撤回了一条消息", "拍了拍", "转账", "收款", "已收款", "线下模式", "线上", "常驻", "心声历史", "加载中…", "没有更多了", "消息", "联系人"];
/* ====================================================================
 * 系统多语言：界面文字（只翻译界面上固定的文字，不碰聊天内容、角色名、世界书等你自己写的内容）
 * 做法：切换语言时用免费翻译（不走你的 AI）把界面词表翻成目标语言，存在本机；之后离线也能用。切回中文随时可以。
 * ==================================================================== */
var UI_LANGS = [['zh', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['es', 'Español'], ['de', 'Deutsch'], ['ru', 'Русский'], ['pt', 'Português'], ['it', 'Italiano'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['th', 'ไทย'], ['ar', 'العربية']];
var uiLang = 'zh', uiDict = null;
try { uiLang = localStorage.getItem('mp-lang') || 'zh'; if (uiLang !== 'zh') uiDict = JSON.parse(localStorage.getItem('mp-i18n-' + uiLang) || 'null'); if (!uiDict) uiLang = 'zh'; } catch (e) { uiLang = 'zh'; uiDict = null; }
function T(s) { return (uiDict && typeof s === 'string' && uiDict[s]) || s; }
var T_SKIP = /\b(bubble|last|msg|quote|trans|cl-voice|cl-jot|pw-|vbar|pd-big|pd-sub|stk-name|name-edit|mo-text|mo-name|mo-cm|mo-likes|mo-sign|mu-name|mu-sub|mu-lrc|lp-l)\b/;
function applyStaticI18n() {
  if (!uiDict) return;
  document.documentElement.lang = uiLang === 'zh-TW' ? 'zh-TW' : uiLang;
  if (uiLang === 'ar') document.documentElement.dir = 'rtl';
  var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n, list = [];
  while ((n = w.nextNode())) list.push(n);
  list.forEach(function (t) { var s = t.nodeValue.trim(); if (s && uiDict[s]) t.nodeValue = t.nodeValue.replace(s, uiDict[s]); });
  document.querySelectorAll('[placeholder],[aria-label],[title]').forEach(function (e) {
    ['placeholder', 'aria-label', 'title'].forEach(function (a) { var v = e.getAttribute(a); if (v && uiDict[v]) e.setAttribute(a, uiDict[v]); });
  });
}
async function buildLangPack(lang, onProgress) {
  var dict = {}, keys = I18N_KEYS.slice(), done = 0;
  try { var old = JSON.parse(localStorage.getItem('mp-i18n-' + lang) || 'null'); if (old) dict = old; } catch (e) {}
  keys = keys.filter(function (k) { return !dict[k]; });
  var fail = 0, i = 0;
  while (i < keys.length) {
    var batch = [], len = 0;
    while (i < keys.length && batch.length < 20 && len + keys[i].length < 380) { batch.push(keys[i]); len += keys[i].length + 1; i++; }
    var outLines = null;
    try { outLines = (await freeTranslate(batch.join('\n'), 'zh-CN', lang)).split(/\n/).map(function (x) { return x.trim(); }); } catch (e) { outLines = null; }
    if (outLines && outLines.length === batch.length) batch.forEach(function (k, j) { if (outLines[j]) dict[k] = outLines[j]; });
    else {                                            /* 行数对不上：逐条翻译，慢一点但稳 */
      for (var j = 0; j < batch.length; j++) { try { dict[batch[j]] = await freeTranslate(batch[j], 'zh-CN', lang); } catch (e) { fail++; } }
    }
    done += batch.length; if (onProgress) onProgress(done, keys.length);
  }
  return { dict: dict, fail: fail };
}
async function switchUiLang(lang) {
  if (lang === 'zh') { try { localStorage.setItem('mp-lang', 'zh'); } catch (e) {} location.reload(); return; }
  var box = h('div', { class: 'hint', text: '正在准备语言包…' });
  openBottomSheet([h('h3', { text: '切换语言' }), box]);
  trBrowserBad = trBrowserBad || false;
  var r = await buildLangPack(lang, function (a, b) { box.textContent = '正在准备语言包… ' + a + ' / ' + b; });
  var got = Object.keys(r.dict).length;
  if (got < I18N_KEYS.length * 0.5) { box.textContent = '翻译服务连不上（已翻 ' + got + ' / ' + I18N_KEYS.length + '），请检查网络后重试。'; return; }
  try { localStorage.setItem('mp-i18n-' + lang, JSON.stringify(r.dict)); localStorage.setItem('mp-lang', lang); } catch (e) { box.textContent = '存不下语言包（浏览器存储已满）'; return; }
  box.textContent = '好了，正在重新载入…' + (r.fail ? '（有 ' + r.fail + ' 条没翻出来，会保持中文）' : '');
  setTimeout(function () { location.reload(); }, 500);
}

function h(tag, props) {
  var el = document.createElement(tag);
  Object.keys(props || {}).forEach(function (k) {
    var v = props[k];
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = T_SKIP.test(props['class'] || '') ? v : T(v);
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, (k === 'placeholder' || k === 'title' || k === 'aria-label') ? T(v) : v);
  });
  (function add(list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) add(c);
      else el.appendChild(typeof c === 'string' ? document.createTextNode(T_SKIP.test((props && props['class']) || '') ? c : T(c)) : c);
    }
  })(Array.prototype.slice.call(arguments, 2));
  return el;
}
var toastTimer;
function toast(msg) {
  var t = $('toast'); t.textContent = T(msg); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
}

/* 弹层 */
/* 弹层：默认是页面正中的 iOS 风格弹窗（确认 / 删除 / 保存 / 输入）；菜单、选择器、列表用 openBottomSheet，从底部升起 */
function openSheet(nodes, bottom) {
  var p = $('sheet-panel'); p.innerHTML = '';
  nodes.forEach(function (n) { if (n) p.appendChild(n); });
  $('sheet').classList.toggle('bottom', !!bottom);
  $('sheet').hidden = false;
  p.scrollTop = 0;
}
function openBottomSheet(nodes) { openSheet(nodes, true); }
function closeSheet() { $('sheet').hidden = true; }
$('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) closeSheet(); });
function menuSheet(title, items) {
  openBottomSheet([title ? h('h3', { text: title }) : null].concat(items.map(function (it) {
    return h('button', { class: 'menu-btn', text: it[0], onclick: function () { closeSheet(); it[1](); } });
  })).filter(Boolean));
}
function confirmSheet(msg, okText, onOk, danger) {
  var lines = String(msg).split('\n'), title = lines.shift(), rest = lines.join('\n').replace(/^\s*[（(]|[）)]\s*$/g, '');
  openSheet([h('h3', { text: title }), rest ? h('div', { class: 'ia-m', text: rest }) : null, h('div', { class: 'btn-row' },
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
  closeCloud();   /* 换页（退出聊天回列表等）云朵自动收起 */
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
function go(id) { nav.push(id); activate(id); ensureBase(); syncHist(); }
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
  if (nav.length > 1) nav.pop(); activate(nav[nav.length - 1], true); syncHist();
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
    openBottomSheet([h('h3', { text: title }), options.length > 8 ? q : null, list,
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
    tap: function () { go('s-membooks'); } },
  { name: '世界书', img: 'https://i.imgs.ovh/2026/11/12/d67bd0f136d13523ba65030a3b438ec7.jpg', color: '#c08a2e', icon: 'M12 6c-2-1.5-5-2-8-1.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-13C17 4 14 4.5 12 6zM12 6v13',
    tap: function () { go('s-wblist'); } },
  { name: '表情包', img: 'https://i.imgs.ovh/2026/11/12/21ffb2ac40aec04e658fe44111c04e70.jpg', color: '#8a5a8f', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 14c1 1.5 2.2 2 3.5 2s2.5-.5 3.5-2M9 9.5h.01M15 9.5h.01',
    tap: function () { go('s-stickers'); } },
  { name: '美化', img: 'https://i.imgs.ovh/2026/11/12/8500e6fda76097cda9ee7f8a6090a3e3.jpg', color: '#b0577a', icon: 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-1.4-1.3-1.7-1.3-3 0-1 .8-1.7 1.9-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01',
    tap: function () { beautySnap = snapBeauty(); go('s-beauty'); } },
  { name: 'API设置', img: 'https://i.imgs.ovh/2026/11/12/e5ce0267cf4bd0b37d18a1866a178dd9.jpg', color: '#3d5a80', icon: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 4v6M7 14v6',
    tap: function () { go('s-settings'); } },
  { name: '数据备份', img: 'https://i.imgs.ovh/2026/11/12/fb4761d50fc0237e8566e4ed097f9920.jpg', color: '#6b6b6b', icon: 'M4 7h16v4H4zM6 11v8h12v-8M10 15h4',
    tap: function () { go('s-backup'); } },
  { name: '网易云音乐', img:'https://i.imgs.ovh/2026/11/12/bec70652b9dafca1319ae6c0186d3087.jpg', color: '#d43c33', icon: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    tap: function () { go('s-music'); } },
  { name: '看手机', img:'https://i.imgs.ovh/2026/11/12/79c9fc0024948a5505778c43d91a6bfd.jpg', color: '#2f6f8f', icon: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2M9.5 11.5C10.5 9.8 11.3 9.3 12 9.3s1.5.5 2.5 2.2c-1 1.7-1.8 2.2-2.5 2.2s-1.5-.5-2.5-2.2z',
    tap: function () { go('s-watch'); } },
  { name: '经期', color: '#d9667c', icon: 'M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z',
    tap: function () { go('s-period'); } },
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
  rows.sort(function (a, b) { return (b.c.pinned ? 1 : 0) - (a.c.pinned ? 1 : 0) || ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0); });
  rows.forEach(function (r) {
    var prev = r.last ? (r.last.role === 'user' ? '我：' : '') + (r.last.type === 'voice' && r.last.role === 'assistant' ? '[语音] ' + stripVoiceTags(r.last.content) : msgToText(r.last)).replace(/\n/g, ' ') : '还没有消息';
    var tm = h('div', { class: 'time' }, r.last ? shortTime(r.last.ts) : '');
    if (r.c.pinned) { var pn = h('span', { class: 'pin-ic' }); pn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 3h6l-1 6 3 3v2h-4v6l-1 1-1-1v-6H7v-2l3-3z"/></svg>'; tm.appendChild(pn); }
    var rowEl = h('div', { class: 'char' + (r.c.pinned ? ' pinned' : ''), 'data-cid': r.c.id, onclick: function () { if (Date.now() - lastLP > 700) openChat(r.c.id); } },
      avatarNode(r.c.avatar, r.c.name),
      h('div', { class: 'meta' }, h('div', { class: 'name', text: r.c.name }), h('div', { class: 'last', text: prev })), tm);
    bindLongPress(rowEl, function () {
      menuSheet(r.c.name, [[r.c.pinned ? '取消置顶' : '置顶', async function () { r.c.pinned = !r.c.pinned; await dbPut('characters', r.c); renderList(); toast(r.c.pinned ? '已置顶' : '已取消置顶'); }], ['角色设置', function () { editChar(r.c.id); }]]);
    });
    box.appendChild(rowEl);
  });
  refreshBadges();
}
onShow['s-list'] = renderList;

/* ---------- 聊天列表底部三个标签：聊天 / 朋友圈 / 个人主页 ---------- */
var LTABS = [
  ['s-list', '聊天', 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
  ['s-moments', '朋友圈', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18M3 12h18M5.6 6.5C8 8.5 16 8.5 18.4 6.5M5.6 17.5c2.4-2 10.4-2 12.8 0'],
  ['s-me', '个人主页', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-4 3.6-6 8-6s8 2 8 6']
];
function mountTabs() {
  LTABS.forEach(function (t) {
    var scr = $(t[0]); if (!scr || scr.querySelector('.ltabs')) return;
    var bar = h('nav', { class: 'ltabs' });
    LTABS.forEach(function (u, i) {
      var b = h('button', { type: 'button', class: 'lt' + (u[0] === t[0] ? ' on' : ''), onclick: function () { switchTab(u[0]); } });
      b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + u[2] + '"/></svg><span>' + u[1] + '</span>';
      if (u[0] === 's-moments') { b.classList.add('lt-m'); b.appendChild(h('i', { class: 'mdot', hidden: true })); }
      bar.appendChild(b);
    });
    scr.appendChild(bar);
  });
}
function switchTab(id) {
  var curId = nav[nav.length - 1]; if (curId === id) return;
  var ia = LTABS.findIndex(function (t) { return t[0] === curId; }), ib = LTABS.findIndex(function (t) { return t[0] === id; });
  if (ia < 0) return;
  nav[nav.length - 1] = id; activate(id, ib < ia);
}
/* ====================================================================
 * 朋友圈 / 个人主页
 * 动态存在 moments 表：{ id, authorId('me' 或角色 id), content, images[], ts, likes[authorId],
 *   comments[{ id, authorId, text, ts, replyTo }], seen{ 角色id: 该角色已看到的评论数 } }
 * 角色的动态 / 点赞 / 评论不单独发请求：在角色设置里开了「朋友圈」的角色，每次正常回复时
 * 提示词里带上最近动态，模型在回复末尾顺带写一段 <朋友圈>{…}</朋友圈>，由 applyMoments 落库。
 * ==================================================================== */
function myProfile() { return Object.assign({ name: '我', avatar: null, bg: '', sign: '' }, settings.myProfile || {}); }
function saveProfile(patch) { settings.myProfile = Object.assign({}, settings.myProfile || {}, patch); return saveSettings(); }
function agoText(ts) {
  var s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚'; if (s < 3600) return Math.floor(s / 60) + ' 分钟前'; if (s < 86400) return Math.floor(s / 3600) + ' 小时前'; if (s < 172800) return '昨天';
  var d = new Date(ts); return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}
var momChars = {};   /* 角色 id → 角色，渲染时刷新 */
function momentAuthor(id) {
  if (id === 'me') { var p = myProfile(); return { name: p.name || '我', avatar: p.avatar }; }
  var c = momChars[id]; return c ? { name: c.name, avatar: c.avatar } : { name: '已删除的角色', avatar: null };
}
async function loadMomChars() { momChars = {}; (await dbAll('characters')).forEach(function (c) { momChars[c.id] = c; }); }

/* 一条动态。m 就地修改后存库、整张卡片原地重画（不丢滚动位置）。onGone：被删除后的回调 */
function momentCard(m, onGone) {
  var a = momentAuthor(m.authorId), card = h('div', { class: 'mo-item' }), main = h('div', { class: 'mo-main' });
  m.likes = m.likes || []; m.comments = m.comments || [];
  function save() { return dbPut('moments', m).then(function () { card.replaceWith(momentCard(m, onGone)); }); }
  main.appendChild(h('div', { class: 'mo-name', text: a.name }));
  if (m.content) main.appendChild(h('div', { class: 'mo-text', text: m.content }));
  if (m.images && m.images.length) {
    var g = h('div', { class: 'mo-imgs n' + (m.images.length === 1 ? 1 : m.images.length === 4 ? 4 : 3) });
    m.images.forEach(function (src) { g.appendChild(h('img', { src: src, alt: '', onclick: function () { openLightbox(src); } })); });
    main.appendChild(g);
  }
  var liked = m.likes.indexOf('me') !== -1;
  var more = h('button', { type: 'button', class: 'mo-more', text: '⋯', 'aria-label': '更多', onclick: function () {
    menuSheet(null, [
      [liked ? '取消赞' : '赞', function () { if (liked) m.likes = m.likes.filter(function (x) { return x !== 'me'; }); else m.likes.push('me'); save(); }],
      ['评论', function () { commentSheet(m, null, save); }],
      ['删除这条动态', function () { confirmSheet('删除这条动态？', '删除', async function () { await dbDel('moments', m.id); card.remove(); if (onGone) onGone(); updateMomentsDot(); }, true); }]
    ]);
  } });
  main.appendChild(h('div', { class: 'mo-foot' }, h('span', { text: agoText(m.ts) }), more));
  if (m.likes.length || m.comments.length) {
    var box = h('div', { class: 'mo-box' });
    if (m.likes.length) box.appendChild(h('div', { class: 'mo-likes', text: '♥ ' + m.likes.map(function (x) { return momentAuthor(x).name; }).join('、') }));
    m.comments.forEach(function (c) {
      var cm = h('div', { class: 'mo-cm' }, h('b', { text: momentAuthor(c.authorId).name }));
      if (c.replyTo) { cm.appendChild(document.createTextNode(' 回复 ')); cm.appendChild(h('b', { text: momentAuthor(c.replyTo).name })); }
      cm.appendChild(document.createTextNode('：' + c.text));
      cm.addEventListener('click', function () {
        if (c.authorId === 'me') menuSheet(null, [['删除这条评论', function () { m.comments = m.comments.filter(function (x) { return x.id !== c.id; }); save(); }]]);
        else commentSheet(m, c.authorId, save);
      });
      box.appendChild(cm);
    });
    main.appendChild(box);
  }
  card.appendChild(avatarNode(a.avatar, a.name)); card.appendChild(main);
  return card;
}
function commentSheet(m, replyTo, done) {
  textSheet(replyTo ? '回复 ' + momentAuthor(replyTo).name : '评论', '', [
    { text: '发送', cls: 'primary', fn: function (v) {
      v = String(v || '').trim(); if (!v) return;
      m.comments.push({ id: uid('mc'), authorId: 'me', text: v, ts: Date.now(), replyTo: replyTo || undefined });
      done(); toast('已评论，TA 会在下次回复你时看到');
    } }, { text: '取消' }]);
}

/* 发动态：文字 + 最多 9 张图 */
function composeMoment() {
  var ta = h('textarea', { placeholder: '这一刻的想法…', style: 'width:100%;min-height:96px;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--bg);outline:none' });
  var imgs = [], thumbs = h('div', { class: 'mo-thumbs' });
  function drawThumbs() {
    thumbs.innerHTML = '';
    imgs.forEach(function (u, i) { thumbs.appendChild(h('div', { class: 'mo-th' }, h('img', { src: u, alt: '' }), h('button', { type: 'button', text: '×', onclick: function () { imgs.splice(i, 1); drawThumbs(); } }))); });
    if (imgs.length < 9) thumbs.appendChild(h('button', { type: 'button', class: 'mo-add', text: '＋', onclick: function () {
      var f = h('input', { type: 'file', accept: 'image/*', multiple: true });
      f.addEventListener('change', async function () {
        var fs = Array.prototype.slice.call(f.files || []).slice(0, 9 - imgs.length);
        for (var i = 0; i < fs.length; i++) { try { imgs.push((await compressImage(fs[i], { maxDim: 900, quality: 0.75 })).url); } catch (e) { toast(e.message); } }
        drawThumbs();
      });
      f.click();
    } }));
  }
  drawThumbs();
  openSheet([h('h3', { text: '发动态' }), ta, thumbs, h('div', { class: 'btn-row', style: 'margin-top:10px' },
    h('button', { class: 'btn primary', text: '发表', onclick: async function () {
      var t = ta.value.trim(); if (!t && !imgs.length) { toast('写点什么或选张图'); return; }
      closeSheet();
      await dbPut('moments', { id: uid('mo'), authorId: 'me', content: t, images: imgs.slice(), ts: Date.now(), likes: [], comments: [], seen: {} });
      toast('已发表。开了朋友圈的角色会在下次回复你时看到'); renderMoments();
    } }),
    h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
}

function coverNode(onbg) {
  var p = myProfile(), cv = h('div', { class: 'mo-cover', onclick: onbg || null });
  if (p.bg) cv.style.backgroundImage = 'url("' + p.bg + '")';
  return cv;
}
async function renderMoments() {
  var b = $('moments-body'), top = b.scrollTop;
  await loadMomChars();
  var list = (await dbAll('moments')).sort(function (x, y) { return y.ts - x.ts; }), p = myProfile();
  b.innerHTML = '';
  var cv = coverNode(function () { pickImage(1000, 0.8, async function (u) { await saveProfile({ bg: u }); renderMoments(); }); });
  cv.appendChild(h('div', { class: 'mo-cover-me' }, h('span', { class: 'mo-cover-name', text: p.name || '我' }), avatarNode(p.avatar, p.name)));
  b.appendChild(cv);
  var feed = h('div', { class: 'mo-feed' });
  list.forEach(function (m) { feed.appendChild(momentCard(m, function () { if (!feed.firstChild) feed.appendChild(emptyMoments()); })); });
  if (!list.length) feed.appendChild(emptyMoments());
  b.appendChild(feed);
  b.scrollTop = top;
}
function emptyMoments() { var e = h('div', { class: 'empty', text: '还没有动态。\n点右上角「＋」发一条；在「角色设置」里打开「朋友圈」，TA 也会发动态、评论你。' }); e.style.whiteSpace = 'pre-line'; return e; }

async function renderMe() {
  var b = $('me-body'), top = b.scrollTop;
  await loadMomChars();
  var p = myProfile(), all = (await dbAll('moments')), mine = all.filter(function (m) { return m.authorId === 'me'; }).sort(function (x, y) { return y.ts - x.ts; });
  var likes = 0, cms = 0; mine.forEach(function (m) { likes += (m.likes || []).filter(function (x) { return x !== 'me'; }).length; cms += (m.comments || []).filter(function (x) { return x.authorId !== 'me'; }).length; });
  b.innerHTML = '';
  var cv = coverNode(function () { pickImage(1000, 0.8, async function (u) { await saveProfile({ bg: u }); renderMe(); }); });
  var av = avatarNode(p.avatar, p.name); av.classList.add('mo-big'); av.addEventListener('click', function (e) { e.stopPropagation(); pickAvatar(async function (u) { await saveProfile({ avatar: u }); renderMe(); }); });
  cv.appendChild(h('div', { class: 'mo-cover-hint', text: '点背景换图' }));
  b.appendChild(cv);
  b.appendChild(h('div', { class: 'me-head' }, av, h('div', { class: 'me-name', text: p.name || '我' }), h('div', { class: 'mo-sign', text: p.sign || '这个人很懒，什么都没写' }), h('div', { class: 'me-tip', text: '点头像换头像' })));
  b.appendChild(h('div', { class: 'me-stats' },
    h('div', {}, h('b', { text: String(mine.length) }), h('span', { text: '动态' })),
    h('div', {}, h('b', { text: String(likes) }), h('span', { text: '获赞' })),
    h('div', {}, h('b', { text: String(cms) }), h('span', { text: '评论' }))));
  var nm = h('input', { type: 'text', placeholder: '昵称', maxlength: '20' }), sg = h('input', { type: 'text', placeholder: '个性签名', maxlength: '60' });
  nm.value = p.name || ''; sg.value = p.sign || '';
  nm.addEventListener('change', async function () { await saveProfile({ name: nm.value.trim() || '我' }); renderMe(); });
  sg.addEventListener('change', async function () { await saveProfile({ sign: sg.value.trim() }); renderMe(); });
  var pad = h('div', { class: 'pad' });
  pad.appendChild(h('div', { class: 'group' }, h('div', { class: 'field' }, h('label', { text: '昵称（朋友圈里显示）' }), nm), h('div', { class: 'field' }, h('label', { text: '个性签名' }), sg)));
  pad.appendChild(h('div', { class: 'group-title', text: '我的动态' }));
  var feed = h('div', { class: 'mo-feed in-card' });
  mine.forEach(function (m) { feed.appendChild(momentCard(m, function () { if (!feed.firstChild) feed.appendChild(h('div', { class: 'empty', text: '还没发过动态' })); })); });
  if (!mine.length) feed.appendChild(h('div', { class: 'empty', text: '还没发过动态' }));
  pad.appendChild(feed);
  pad.appendChild(h('div', { class: 'btn-row', style: 'margin-top:16px' },
    h('button', { class: 'btn', text: '发一条动态', onclick: composeMoment }),
    all.length ? h('button', { class: 'btn danger', text: '清空朋友圈', onclick: function () { confirmSheet('清空全部朋友圈动态（包括角色发的）？不能恢复。', '清空', async function () { await dbClear('moments'); updateMomentsDot(); renderMe(); }, true); } }) : null));
  pad.appendChild(h('div', { class: 'hint', style: 'color:var(--sub);font-size:12px;line-height:1.7', text: '角色参与朋友圈的开关在各自的「角色设置 → 朋友圈」。角色的动态、点赞、评论都跟着正常聊天回复一起生成，不会多发请求；所以 TA 要等你下次找 TA 聊天时才会看到并回应。' }));
  b.appendChild(pad);
  b.scrollTop = top;
}

/* 朋友圈红点：有角色新发的动态 / 新的评论（比上次打开朋友圈更晚）就亮 */
function momentsSeenTs() { try { return Number(localStorage.getItem('mp_mo_seen')) || 0; } catch (e) { return 0; } }
async function updateMomentsDot() {
  if (!db) return;
  var seen = momentsSeenTs(), on = false;
  try {
    (await dbAll('moments')).forEach(function (m) {
      if (m.authorId !== 'me' && m.ts > seen) on = true;
      (m.comments || []).forEach(function (c) { if (c.authorId !== 'me' && c.ts > seen) on = true; });
    });
  } catch (e) {}
  document.querySelectorAll('.ltabs .lt-m .mdot').forEach(function (d) { d.hidden = !on; });
}
onShow['s-moments'] = function () { try { localStorage.setItem('mp_mo_seen', String(Date.now())); } catch (e) {} updateMomentsDot(); return renderMoments(); };
onShow['s-me'] = renderMe;
$('b-mo-new').onclick = composeMoment;
var _renderListBase = renderList;
onShow['s-list'] = function () { var r = _renderListBase.apply(this, arguments); updateMomentsDot(); return r; };

/* ---- 给模型看的朋友圈上下文（只含用户和该角色自己的动态，最近 6 条） ---- */
async function buildMomentsContext(char) {
  var all = await dbAll('moments'), cs = await dbAll('characters'), p = myProfile(), cname = {};
  cs.forEach(function (c) { cname[c.id] = c.name; });
  var uname = char.userNickname || p.name || '用户';
  function nm(id) { return id === 'me' ? uname : id === char.id ? '你' : (cname[id] || '某人'); }
  var rel = all.filter(function (m) { return m.authorId === 'me' || m.authorId === char.id; }).sort(function (x, y) { return y.ts - x.ts; });
  var last = rel.filter(function (m) { return m.authorId === char.id; })[0], shown = rel.slice(0, 6), L = [];
  shown.forEach(function (m) {
    var seen = m.seen && m.seen[char.id], cl = m.comments || [];
    var line = '[' + m.id + '] ' + nm(m.authorId) + ' · ' + fmtTime(m.ts, char.timeZone).replace(/:\d\d$/, '') + (m.authorId === 'me' && seen == null ? '（新动态，你还没看过）' : '') + '：' +
      String(m.content || '').slice(0, 100) + (m.images && m.images.length ? '（配了 ' + m.images.length + ' 张图）' : '');
    if ((m.likes || []).length) line += '\n  赞：' + m.likes.map(nm).join('、');
    cl.slice(-8).forEach(function (c, i) {
      var idx = cl.length - Math.min(8, cl.length) + i, isNew = c.authorId !== char.id && (seen == null || idx >= seen);
      line += '\n  ' + nm(c.authorId) + (c.replyTo ? ' 回复 ' + nm(c.replyTo) : '') + '：' + String(c.text || '').slice(0, 80) + (isNew ? '（新）' : '');
    });
    L.push(line);
  });
  return { ids: shown.map(function (m) { return m.id; }), text: '# 朋友圈\n你最近一次发朋友圈：' + (last ? fmtGap(Date.now() - last.ts) + '前' : '还没发过') + '。\n' + (L.length ? L.join('\n') : '（还没有任何动态）') };
}
/* 把模型输出的 <朋友圈> 落库：发动态 / 点赞 / 评论；并记下这个角色已经看过哪些评论 */
async function applyMoments(char, data, ids) {
  var all = await dbAll('moments'), byId = {}, changed = {}, now = Date.now(), p = myProfile(), names = {};
  all.forEach(function (m) { byId[m.id] = m; });
  names[(p.name || '').trim()] = 'me'; names['用户'] = 'me'; if (char.userNickname) names[char.userNickname.trim()] = 'me';
  (await dbAll('characters')).forEach(function (c) { names[(c.name || '').trim()] = c.id; if (c.realName) names[c.realName.trim()] = c.id; });
  var d = data && typeof data === 'object' ? data : {};
  var post = typeof d.post === 'string' ? d.post.trim() : '';
  if (post) { var nmo = { id: uid('mo'), authorId: char.id, content: post.slice(0, 500), images: [], ts: now, likes: [], comments: [], seen: {} }; byId[nmo.id] = nmo; changed[nmo.id] = true; }
  (Array.isArray(d.likes) ? d.likes : []).forEach(function (id) {
    var m = byId[id]; if (!m || ids.indexOf(id) === -1 || m.authorId === char.id) return;
    m.likes = m.likes || []; if (m.likes.indexOf(char.id) === -1) { m.likes.push(char.id); changed[id] = true; }
  });
  (Array.isArray(d.comments) ? d.comments : []).slice(0, 4).forEach(function (c, i) {
    if (!c) return; var m = byId[c.id], txt = typeof c.text === 'string' ? c.text.trim() : '';
    if (!m || ids.indexOf(c.id) === -1 || !txt) return;
    var rt = c.reply ? names[String(c.reply).trim()] : null; if (rt === char.id) rt = null;
    m.comments = m.comments || []; m.comments.push({ id: uid('mc'), authorId: char.id, text: txt.slice(0, 200), ts: now + i, replyTo: rt || undefined }); changed[c.id] = true;
  });
  ids.forEach(function (id) { var m = byId[id]; if (!m) return; m.seen = m.seen || {}; m.seen[char.id] = (m.comments || []).length; changed[id] = true; });
  var keys = Object.keys(changed); for (var i = 0; i < keys.length; i++) await dbPut('moments', byId[keys[i]]);
  updateMomentsDot();
  if ($('s-moments').classList.contains('active')) renderMoments();
}
mountTabs();

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
  var bn = document.getElementById('msg-banner'); if (bn) bn.remove();   /* 进了聊天，顶部的新消息通知条就收起来 */
  var page = await pageMessages(cid, null, PAGE);
  applyChatLook();
  $('msgs').innerHTML = ''; oldest = null; lastShownTs = 0;
  renderPage(page, false);
  go('s-chat');
  requestAnimationFrame(function () { scrollBottom(); setTimeout(scrollBottom, 80); });   /* 页面刚显示出来时再确认一次到底 */
  scrollBottom();
}
/* 滚到底；之后 6 秒内图片(表情包)加载撑高了，也会自动再滚到底，避免被底栏挡住 */
var pinUntil = 0;
function scrollBottom() { var m = $('msgs'); m.scrollTop = m.scrollHeight; pinUntil = Date.now() + 6000; }
function pinScroll() { if (Date.now() < pinUntil) { var m = $('msgs'); m.scrollTop = m.scrollHeight; } }
/* 图片/表情包加载完撑高后：如果它是最后一条（或还在「贴底」时间内），无动画再滚到底，避免沉在输入栏下面 */
function settleLast(img, b) {
  var go = function () { var m = $('msgs'), row = b.closest ? b.closest('.row') : null; if (Date.now() < pinUntil || (row && row === m.lastElementChild)) m.scrollTop = m.scrollHeight; };
  img.addEventListener('load', function () { go(); requestAnimationFrame(go); setTimeout(go, 120); });
}
['touchstart', 'wheel', 'mousedown'].forEach(function (ev) { $('msgs').addEventListener(ev, function () { pinUntil = 0; }, { passive: true }); });

/* ---------- 自动翻译（不走你的 AI 接口；用浏览器自带翻译 / 免费公共翻译接口） ---------- */
var TR_LANGS = [['zh-CN', '中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['es', 'Español'], ['de', 'Deutsch'], ['ru', 'Русский'], ['pt', 'Português'], ['it', 'Italiano'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['th', 'ไทย'], ['ar', 'العربية']];
function trScript(code) { return { 'zh-CN': 'zh', ja: 'ja', ko: 'ko', ru: 'ru', ar: 'ar', th: 'th' }[code] || 'latin'; }
function detectScript(text) {
  var t = String(text).replace(/https?:\/\/\S+/g, ' '), c = { zh: 0, kana: 0, ko: 0, ru: 0, ar: 0, th: 0, latin: 0 };
  for (var i = 0; i < t.length; i++) {
    var x = t.charCodeAt(i);
    if (x >= 0x4E00 && x <= 0x9FFF) c.zh++;
    else if ((x >= 0x3040 && x <= 0x30FF) || (x >= 0x31F0 && x <= 0x31FF)) c.kana++;
    else if ((x >= 0xAC00 && x <= 0xD7AF) || (x >= 0x1100 && x <= 0x11FF)) c.ko++;
    else if (x >= 0x400 && x <= 0x4FF) c.ru++;
    else if (x >= 0x600 && x <= 0x6FF) c.ar++;
    else if (x >= 0xE00 && x <= 0xE7F) c.th++;
    else if ((x >= 65 && x <= 90) || (x >= 97 && x <= 122) || (x >= 0xC0 && x <= 0x24F) || (x >= 0x1E00 && x <= 0x1EFF)) c.latin++;
  }
  if (c.kana > 0 && c.kana + c.zh > c.latin * 0.5) return 'ja';
  var best = '', n = 0; ['zh', 'ko', 'ru', 'ar', 'th', 'latin'].forEach(function (k) { if (c[k] > n) { n = c[k]; best = k; } });
  return n >= 2 || (n >= 1 && t.trim().length <= 6) ? best : '';
}
function needTranslate(text, cfg) {
  var sc = detectScript(text); if (!sc) return false;
  var toSc = trScript(cfg.to);
  if (cfg.from && cfg.from !== 'auto') {
    if (cfg.from === cfg.to) return false;
    var fromSc = trScript(cfg.from);
    return sc === fromSc && (sc !== toSc || cfg.from !== cfg.to);
  }
  return sc !== toSc;
}
var trProvider = 0, trCache = {}, trMade = {}, trBrowserBad = false;
function trFetch(url, ms) {
  var ctl = ('AbortController' in window) ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 9000);
  return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) { clearTimeout(to); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }, function (e) { clearTimeout(to); throw e; });
}
var TR_PROVIDERS = [
  { name: '浏览器自带', run: async function (q, sl, tl) {
    if (!('Translator' in self) || sl === 'auto') throw new Error('无');
    function lim(p, ms) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('超时')); }, ms); })]); }   /* 有的浏览器这个接口会一直不返回，必须设超时 */
    var key = sl + '>' + tl, tr = trMade[key];
    if (trBrowserBad) throw new Error('无');
    try {
      if (!tr) {
        if ((await lim(Translator.availability({ sourceLanguage: sl, targetLanguage: tl }), 2500)) !== 'available') throw new Error('无');
        tr = trMade[key] = await lim(Translator.create({ sourceLanguage: sl, targetLanguage: tl }), 4000);
      }
      return await lim(tr.translate(q), 6000);
    } catch (e) { trBrowserBad = true; throw e; }
  } },
  { name: 'Google', run: async function (q, sl, tl) {
    var j = await trFetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(q));
    var out = (j[0] || []).map(function (x) { return x[0] || ''; }).join('');
    if (!out) throw new Error('空'); return out;
  } },
  { name: 'MyMemory', run: async function (q, sl, tl) {
    var j = await trFetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + encodeURIComponent((sl === 'auto' ? 'autodetect' : sl) + '|' + tl));
    var out = j && j.responseData && j.responseData.translatedText;
    if (!out || /MYMEMORY WARNING|INVALID/i.test(out)) throw new Error('额度或语言不支持'); return out;
  } }
];
/* 把长文切成 ≤450 字一段（按换行/句号），逐段翻译再拼回去 */
function trChunks(text) {
  var parts = String(text).split(/(?<=[\n。！？!?.])/), out = [], cur = '';
  parts.forEach(function (p) { if ((cur + p).length > 450 && cur) { out.push(cur); cur = ''; } cur += p; while (cur.length > 450) { out.push(cur.slice(0, 450)); cur = cur.slice(450); } });
  if (cur) out.push(cur); return out;
}
async function freeTranslate(text, from, to) {
  var key = (from || 'auto') + '|' + to + '|' + text; if (trCache[key]) return trCache[key];
  var sl = from && from !== 'auto' ? from : ({ zh: 'zh-CN', ja: 'ja', ko: 'ko', ru: 'ru', ar: 'ar', th: 'th', latin: 'en' }[detectScript(text)] || 'auto');
  var chunks = trChunks(text), lastErr = null;
  for (var k = 0; k < TR_PROVIDERS.length; k++) {
    var pi = (trProvider + k) % TR_PROVIDERS.length;
    try {
      var outs = [];
      for (var c = 0; c < chunks.length; c++) { var o1 = await TR_PROVIDERS[pi].run(chunks[c], pi === 1 ? (from && from !== 'auto' ? sl : 'auto') : sl, to); if (/\n$/.test(chunks[c]) && !/\n$/.test(o1)) o1 += '\n'; outs.push(o1); }
      trProvider = pi; var res = outs.join('').trim(); if (!res) throw new Error('空');
      return (trCache[key] = res);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('翻译失败');
}
var trChain = Promise.resolve();
function queueTranslate(m, host, foot, cfg) {
  trChain = trChain.then(function () { return translateMsg(m, host, foot, cfg); }).then(function () { return sleep(120); });
}
function trSame(a, b) { var n = function (x) { return String(x || '').replace(/[\s\u3000，。,.!！?？、…~～"“”'‘’《》「」『』（）()\-—:：;；]/g, '').toLowerCase(); }; return n(a) === n(b); }
async function translateMsg(m, host, foot, cfg, el) {
  try {
    var res = await freeTranslate(m.content, cfg.from, cfg.to);
    if (trSame(res, m.content)) {   /* 译文和原文一样（比如中英混写的中文）：不显示，也记下来别再翻 */
      if (el) el.remove();
      try { var f0 = await dbGet('messages', m.id); if (f0 && f0.content === m.content) { f0.meta = f0.meta || {}; f0.meta.tr = { to: cfg.to, src: m.content, text: res, same: true }; await dbPut('messages', f0); m.meta = f0.meta; } } catch (e0) {}
      return;
    }
    if (!el) { el = h('div', { class: 'trans' }); host.insertBefore(el, foot && foot.parentNode === host ? foot : null); }
    el.className = 'trans'; el.textContent = res; el.onclick = null;
    var fresh = await dbGet('messages', m.id);
    if (fresh && fresh.content === m.content) { fresh.meta = fresh.meta || {}; fresh.meta.tr = { to: cfg.to, src: m.content, text: res }; await dbPut('messages', fresh); m.meta = fresh.meta; }
    pinScroll();
  } catch (e) {
    if (!el) { el = h('div', { class: 'trans err' }); host.insertBefore(el, foot && foot.parentNode === host ? foot : null); }
    el.className = 'trans err'; el.textContent = '翻译失败，点这里重试';
    el.onclick = function (ev) { ev.stopPropagation(); el.className = 'trans loading'; el.textContent = '翻译中…'; el.onclick = null; translateMsg(m, host, foot, cfg, el); };
  }
}
/* 译文放进气泡内部、时间戳上面；原文先显示，译完再追加（气泡变长），不挡原文 */
function addTrans(m, b, foot) {
  var cfg = cur && cur.translate; if (!cfg || !cfg.on || m.role !== 'assistant') return;
  var t = m.type || 'text'; if (!(t === 'text' || t === 'offline' || (t === 'voice' && m.content)) || !m.content) return;
  var tr = m.meta && m.meta.tr;
  if (tr && tr.to === cfg.to && tr.src === m.content) { if (tr.same || trSame(tr.text, m.content)) return; b.insertBefore(h('div', { class: 'trans', text: tr.text }), foot || null); return; }
  if (!needTranslate(m.content, cfg)) return;
  queueTranslate(m, b, foot, cfg);
}

function msgNode(m) {
  if (m.hidden || m.type === 'system') return null;
  if (m.type === 'pat') return h('div', { class: 'sysline', 'data-id': m.id, text: (m.meta && m.meta.show) || m.content });
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
    settleLast(img, b);
    img.onerror = function () { b.innerHTML = ''; b.appendChild(h('div', { class: 'alt', text: '[表情包] ' + (meta.meaning || '') })); pinScroll(); };
    b.appendChild(img);
  } else if (t === 'voice' && !meta.audio && m.role === 'assistant') {
    b = h('div', { class: 'bubble vmsg' });
    var tb = h('button', { type: 'button', class: 'vplay', text: '▶', 'aria-label': '播放语音' });
    b.addEventListener('click', function (e) { if (e.target.closest('.vconv')) return; e.stopPropagation(); if (selMode || Date.now() - lastLP < 700) return; speakVoice(tb, m.content, b); });
    b.appendChild(h('div', { class: 'vrow' }, tb, h('span', { class: 'vbar' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i')), h('span', { class: 'vdur', text: fmtDur(meta.duration || estSpeakSecs(m.content)) })));
    var tx = h('div', { class: 'vtext', text: stripVoiceTags(m.content) });
    if (cur && cur.autoVoiceText === false) { tx.hidden = true; b.appendChild(tx); b.appendChild(h('button', { type: 'button', class: 'vconv', text: '转文字', onclick: function (e) { e.stopPropagation(); tx.hidden = false; this.remove(); } })); }
    else b.appendChild(tx);
  } else if (t === 'voice' && meta.audio) {
    b = h('div', { class: 'bubble vmsg' });
    var pb = h('button', { type: 'button', class: 'vplay', text: '▶', 'aria-label': '播放语音' });
    pb.addEventListener('click', function (e) { e.stopPropagation(); toggleVoice(pb, meta.audio); });
    b.appendChild(h('div', { class: 'vrow' }, pb, h('span', { class: 'vbar' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('i')), h('span', { class: 'vdur', text: fmtDur(meta.duration) })));
    if (m.content) b.appendChild(h('div', { class: 'vtext', text: m.content }));
    else b.appendChild(h('div', { class: 'vtext vpend', text: '（AI 回复时会写出文字）' }));
  } else if (t === 'image') {
    b = h('div', { class: 'bubble image' });
    var pic = h('img', { src: m.content, alt: '图片' });
    settleLast(pic, b);
    pic.onerror = function () { b.innerHTML = ''; b.appendChild(h('div', { class: 'alt', text: '[图片读取失败]' })); };
    pic.addEventListener('click', function () { if (Date.now() - lastLP > 700 && !selMode) openLightbox(m.content); });
    b.appendChild(pic);
  } else if (t === 'transfer') {
    b = h('div', { class: 'bubble transfer' + (meta.status && meta.status !== 'pending' ? ' done' : ''), onclick: function () { onTransferTap(m); } }, h('b', { text: '¥ ' + (meta.amount != null ? Number(meta.amount).toFixed(2) : '') }), h('span', { text: meta.note || '转账' }), h('small', { text: transferLabel(m) }));
  } else {
    b = h('div', { class: 'bubble' + (t === 'voice' ? ' voice' : '') + (t === 'offline' ? ' offline' : '') });
    if (meta.quote && typeof meta.quote === 'object' && (meta.quote.content || meta.quote.text))
      b.appendChild(h('div', { class: 'quote', text: String(meta.quote.content || meta.quote.text) }));
    var dispText = m.content;
    if (!me && settings.autoStripFormat !== false && dispText) {
      var cleanedDisp = stripExtraFormat(extractThought(extractStatus(extractMoments(dispText).reply).reply).reply);
      if (cleanedDisp) dispText = cleanedDisp;
    }
    b.appendChild(document.createTextNode(dispText));
  }
  var row = h('div', { class: 'row' + (me ? ' me' : ''), 'data-id': m.id });
  bindLongPress(b, function () { if (!selMode) messageMenu(m, b); });
  if (!me) { var av0 = avatarNode(cur.avatar, cur.name); av0.style.cursor = 'pointer'; av0.title = '查看心声'; av0.addEventListener('click', function (e) { e.stopPropagation(); showThoughtCloud(av0); }); row.appendChild(av0); }
  else { var avMe = avatarNode(cur.userAvatar, cur.userNickname || '我'); if (!cur.userAvatar) avMe.classList.add('me-av'); row.appendChild(avMe); }   /* 没设置头像就显示一个字母/「我」头像 */
  var wrap = h('div', { class: 'bwrap' + (t === 'offline' ? ' wide' : '') }, b), edTxt = meta.edited ? '已编辑' : '';
  var showT = settings.showTime !== false, ftxt = (showT ? hm(m.ts) : '') + (showT && edTxt ? ' · ' : '') + edTxt;
  var foot = ftxt ? h('div', { class: 'bfoot', text: ftxt }) : null;
  if (foot) wrap.appendChild(foot);
  addTrans(m, b, null);
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
  el.addEventListener('touchstart', function (e) { var t = e.touches[0]; sx = t.clientX; sy = t.clientY; clear(); tm = setTimeout(function () { tm = null; if (navigator.vibrate) try { navigator.vibrate(12); } catch (x) {} lastLP = Date.now(); try { getSelection().removeAllRanges(); } catch (x) {} fn(); }, 480); }, { passive: true });
  el.addEventListener('touchmove', function (e) { var t = e.touches[0]; if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) clear(); }, { passive: true });
  el.addEventListener('touchend', clear); el.addEventListener('touchcancel', clear);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); clear(); lastLP = Date.now(); try { getSelection().removeAllRanges(); } catch (x) {} fn(); });
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
async function selectedMsgs() {   /* 只按 id 取选中的几条（一个事务），不再把整段聊天记录读出来 */
  var ids = Object.keys(selected);
  var out = await new Promise(function (res, rej) {
    var tx = db.transaction('messages'), os = tx.objectStore('messages'), got = [];
    ids.forEach(function (id) { os.get(id).onsuccess = function (e) { if (e.target.result) got.push(e.target.result); }; });
    tx.oncomplete = function () { res(got); }; tx.onerror = tx.onabort = function () { rej(tx.error); };
  });
  return out.sort(function (a, b) { return a.ts - b.ts; });
}
$('sel-copy').onclick = async function () {
  var ms = await selectedMsgs(); if (!ms.length) { toast('还没选消息'); return; }
  var t = ms.map(function (m) { return (m.role === 'user' ? '我' : cur.name) + '：' + plainText(m); }).join('\n');
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('已复制 ' + ms.length + ' 条'); exitSelect(); }, function () { toast('复制失败'); });
};
$('sel-del').onclick = function () {
  var n = Object.keys(selected).length; if (!n) { toast('还没选消息'); return; }
  confirmSheet('删除选中的 ' + n + ' 条消息？', '删除', async function () {
    var dm = await selectedMsgs();
    exitSelect();                                        /* 先把多选栏收掉，界面立刻有反应 */
    dm.forEach(function (m) { var row = $('msgs').querySelector('.row[data-id="' + m.id + '"]'); if (row) row.remove(); });
    await deleteMessages(dm); reloadChat();
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
  var rec = null;
  if (real.length) {
    var parts = real.slice(0, 6).map(function (m) { return (m.role === 'user' ? '用户发的「' : '你发的「') + msgBrief(m, 40) + '」'; });
    rec = { id: uid(cur.id), characterId: cur.id, role: 'user', type: 'system', content: '[用户删除了 ' + real.length + ' 条消息：' + parts.join('；') + (real.length > 6 ? '…等' : '') + '。这些消息已从聊天里消失，但你知道它们的内容。]', ts: Date.now() };
  }
  dbDirty = true;
  await new Promise(function (res, rej) {   /* 全部删除 + 那条隐藏记录，一个事务搞定 */
    var tx = db.transaction('messages', 'readwrite'), os = tx.objectStore('messages');
    list.forEach(function (m) { os.delete(m.id); });
    if (rec) os.put(rec);
    tx.oncomplete = res; tx.onerror = tx.onabort = function () { rej(tx.error); };
  });
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
  items.push(['删除', async function () { await deleteMessages([m]); reloadChat(); }]);
  if (anchor) showMsgPop(items, anchor); else menuSheet('', items);
}

function isTyping(cid) { var r = rounds[cid]; return !!(r && r.active); }
function refreshTitle() {
  if (!cur) return;
  var name = $('chat-name'), status = $('chat-status');
  name.textContent = cur.name + (cur.offlineMode ? ' · 线下' : '');
  var s = cur.status || { type: 'online', text: '在线' };
  status.textContent = s.text || '在线';
  status.setAttribute('data-status', s.type || 'online');
  if (isTyping(cur.id)) {
    name.className = 'typing-title';
    name.innerHTML = '对方正在输入中<i>.</i><i>.</i><i>.</i>';
  } else {
    name.className = '';
    name.textContent = cur.name + (cur.offlineMode ? ' · 线下' : '');
  }
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
  setTimeout(scrollBottom, 120); setTimeout(scrollBottom, 380);   /* 键盘/布局变化后再滚一次 */
});
$('b-wait').onclick = function () { generateReply(); };
/* 安卓 WebView：没挂在页面上的 <input type=file> 点了不一定能弹出选择器，选完事件也可能丢。统一在 click 时临时挂到页面上 */
(function () {
  var oc = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    var el = this;
    if (el.type === 'file' && !el.isConnected && document.body) {
      el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(el);
      var rm = function () { setTimeout(function () { if (el.parentNode) el.remove(); }, 400); };
      el.addEventListener('change', rm); el.addEventListener('cancel', rm);
      setTimeout(function () { if (el.parentNode) el.remove(); }, 600000);
    }
    return oc.apply(this, arguments);
  };
})();
/* 聊天背景锁高：键盘弹出时页面变矮，背景高度固定为「没有键盘时的整屏高度」、贴顶不动，只是下半截被键盘盖住，不会跟着压缩/上移 */
(function () {
  var maxH = 0, lastW = window.innerWidth;
  function lock() {
    var w = window.innerWidth, h = Math.max(window.innerHeight, (window.visualViewport && window.visualViewport.height) || 0);
    if (Math.abs(w - lastW) > 80) { maxH = 0; lastW = w; }   /* 宽度变了＝横竖屏切换，重新量 */
    if (h > maxH) { maxH = h; document.documentElement.style.setProperty('--bgh', maxH + 'px'); }
  }
  lock();
  window.addEventListener('resize', lock);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', lock);
  window.addEventListener('orientationchange', function () { maxH = 0; setTimeout(lock, 300); });
})();
/* 键盘弹出/收起会改变页面高度：点输入框、发送、视口变化后都再滚到最新消息 */
(function () {
  var inp = $('input');
  function keepBottom() { if (cur && s_chatActive()) { var m = $('msgs'); m.scrollTop = m.scrollHeight; pinUntil = Math.max(pinUntil, Date.now() + 1500); } }
  inp.addEventListener('focus', function () { [0, 120, 300, 600].forEach(function (t) { setTimeout(keepBottom, t); }); });
  function onVp() { if (document.activeElement === inp || Date.now() < pinUntil) keepBottom(); }
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onVp);
  window.addEventListener('resize', onVp);
})();

/* ---- 图片：压缩 / 灯箱 / 从相册发送 ---- */
/* 压缩：长边不超过 maxDim。o.alpha=true 保留透明（输出 webp/png），否则输出 jpeg。返回 { url, w, h } */
function compressImage(file, o) {
  o = o || {};
  return new Promise(function (res, rej) {
    var u = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(u);
      var k = o.maxWidth ? Math.min(1, o.maxWidth / img.width) : Math.min(1, (o.maxDim || 512) / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * k)), hh = Math.max(1, Math.round(img.height * k));
      var cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
      var g = cv.getContext('2d');
      if (!o.alpha) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh); }
      g.drawImage(img, 0, 0, w, hh);
      var out;
      if (o.alpha) { out = cv.toDataURL('image/webp', o.quality || 0.8); if (out.indexOf('data:image/webp') !== 0) out = cv.toDataURL('image/png'); }
      else if (o.webp) { out = cv.toDataURL('image/webp', o.quality || 0.85); if (out.indexOf('data:image/webp') !== 0) out = cv.toDataURL('image/jpeg', o.quality || 0.85); }
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
var IMG_SEND_MAX_W = 1024;   /* 发给 AI 的图片：只限制宽度（≤1024 不缩小），高度等比，优先 webp、质量 0.85，长截图文字才看得清 */
var IMG_SEND_MAX = 512;   /* 发给 AI 的图片：长边最多多少像素（越小越省 token）；质量 0.8 */
function openImagePicker() {
  if (!cur) return;
  var f = h('input', { type: 'file', accept: 'image/*', multiple: true });
  f.addEventListener('change', async function () {
    var files = Array.prototype.slice.call(f.files || []).slice(0, 6); if (!files.length) return;
    var ok = 0, bad = 0, before = 0, after = 0;
    for (var i = 0; i < files.length; i++) {
      try {
        var r = await compressImage(files[i], { maxWidth: IMG_SEND_MAX_W, webp: true, quality: 0.85 });
        var m = { id: uid(cur.id), characterId: cur.id, role: 'user', type: 'image', content: r.url, ts: Date.now() + i, meta: { w: r.w, h: r.h } };
        await dbPut('messages', m);
        if (lastShownTs && m.ts - lastShownTs > 600000) appendMsgNode(h('div', { class: 'sysline', text: fmtTime(m.ts).replace(/:\d\d$/, '') }));
        var n = msgNode(m); if (n) appendMsgNode(n); lastShownTs = m.ts; scrollBottom();
        ok++; before += files[i].size; after += r.url.length * 0.75;
      } catch (e) { bad++; }
    }
        if (ok) toast('已发送 ' + ok + ' 张图片（' + Math.round(before / 1024) + 'KB → ' + Math.round(after / 1024) + 'KB）' + (bad ? '，' + bad + ' 张失败' : '') + '。点「等回复」让 TA 看图');
    else toast('图片读取失败');
  });
  f.click();
}
var lastShift = false;
$('input').addEventListener('keydown', function (e) {
  lastShift = e.shiftKey;
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;   /* 正在用拼音选字时的回车不算 */
  var send = settings.enterSend ? (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) || e.ctrlKey || e.metaKey : (e.ctrlKey || e.metaKey);
  if (send) { e.preventDefault(); $('composer').requestSubmit(); }
});
$('input').addEventListener('beforeinput', function (e) {
  if (!settings.enterSend || e.inputType !== 'insertLineBreak') return;
  if (lastShift) return;   /* Shift+Enter 是换行，不发送 */
  e.preventDefault();
  $('composer').requestSubmit();
});

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
var vCtxSrc = null;
function stopCtxVoice() { if (vCtxSrc) { var oldSrc = vCtxSrc; try { vCtxSrc.onended = null; vCtxSrc.stop(); } catch (e) {} vCtxSrc = null; muRelease(oldSrc); } }
/* <audio> 播不了时，退一步：自己解码再用 WebAudio 播 */
async function playViaContext(src, btn) {
  var AC = window.AudioContext || window.webkitAudioContext, ac = new AC();
  var mm = /^data:[^,]*;base64,([\s\S]*)$/.exec(src || '');
  var u8; if (mm) { var bin = atob(mm[1]); u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); } else u8 = new Uint8Array(await (await fetch(src)).arrayBuffer());
  var buf = await new Promise(function (res, rej) { var p = ac.decodeAudioData(u8.buffer, res, rej); if (p && p.catch) p.catch(rej); });
  stopCtxVoice(); var node = ac.createBufferSource(); node.buffer = buf; node.connect(ac.destination);
  node.onended = function () { btn.textContent = '▶'; try { ac.close(); } catch (e) {} if (vCtxSrc === node) vCtxSrc = null; muRelease(node); };
  muHold(node); vCtxSrc = node; vBtn = btn; btn.textContent = '⏸'; node.start();
}
function toggleVoice(btn, src) {
  if (vCtxSrc && vBtn === btn) { stopCtxVoice(); btn.textContent = '▶'; return; }
  if (vAudio && vBtn === btn && !vAudio.paused) { vAudio.pause(); btn.textContent = '▶'; return; }
  if (vAudio) { vAudio.pause(); if (vBtn) vBtn.textContent = '▶'; }
  stopCtxVoice();
  vAudio = new Audio(src); vBtn = btn; btn.textContent = '⏸';
  vAudio.onended = function () { btn.textContent = '▶'; };
  vAudio.play().catch(function () {
    playViaContext(src, btn).catch(function () { btn.textContent = '▶'; toast('播放失败：这段音频格式手机浏览器解不开，换成 mp3/m4a/wav 试试'); });
  });
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
}
/* 「AI 会帮你转文字」的提示：一天只提一次，用聊天里的小灰字，不弹 toast */
function voiceTip() {
  try {
    var day = new Date().toDateString();
    if (localStorage.getItem('vtipDay') === day) return;
    localStorage.setItem('vtipDay', day);
  } catch (e) {}
  setTimeout(function () { appendMsgNode(h('div', { class: 'sysline tip', text: 'AI 回复你的时候，会顺带把语音转成文字（今天只提示这一次）' })); scrollBottom(); }, 60);
}
var AUDIO_MIME = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', '3gp': 'audio/3gpp', '3gpp': 'audio/3gpp', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac' };
/* 把音频解码后转成 WAV（手机系统录音机常见的 amr/3gp/m4a 等，有的 <audio> 播不了；解码成 WAV 就都能放） */
async function toPlayableAudio(url) {
  try {
    var wav = await audioToWavB64(url);
    if (wav && wav.length < 5.5 * 1024 * 1024) return 'data:audio/wav;base64,' + wav;
  } catch (e) {}
  return url;
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
    var ext = (file.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '', mt = /^audio\//.test(file.type) ? file.type : (AUDIO_MIME[ext.toLowerCase()] || 'audio/mp4');
    url = url.replace(/^data:[^;,]*/, 'data:' + mt);
    toast('正在处理音频…'); url = await toPlayableAudio(url);
    await pushVoiceMsg({ id: uid(cur.id), characterId: cur.id, role: 'user', type: 'voice', content: '', ts: Date.now(), meta: { duration: Math.round(Math.min(secs, 600)), audio: url, tone: '', asr: '' } });
    if (cur.autoVoiceText !== false) voiceTip();
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
  muHold(rec);   /* 录音时先把歌暂停，免得录进去 */
  function cleanup() {
    muRelease(rec);
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
    if (autoOn && !text) voiceTip();
    await pushVoiceMsg(m);
  };
}
/* 底栏「＋」：向上展开一列悬浮圆（语音 / 音频文件 / 图片 / 一起听 / 看手机），做法和右上角 ⋯ 一样 */
/* ---------- 拍一拍 / 转账（双向）+ 经期 ---------- */
var ACT_RULES = '需要拍一拍、转账、收款或退还转账时，单独一行写标签：[拍一拍]、[转账:金额:备注]（备注可省略，例如 [转账:52.00:请你喝奶茶]）、[收款]、[退还]。金额必须为正数；只在符合角色和情境时使用。标签不属于聊天正文。';
/* 从回复里拆出动作标记，返回 { reply, acts:[{k:'pat'|'transfer'|'accept'|'refund', amount, note}] } */
function extractActions(text) {
  var t = String(text || ''), acts = [];
  t = t.replace(/\[拍一拍\]/g, function () { acts.push({ k: 'pat' }); return ''; });
  t = t.replace(/\[转账[:：]\s*([\d.]+)\s*(?:[:：]([^\]]*))?\]/g, function (a, amt, note) { var n = Math.round(parseFloat(amt) * 100) / 100; if (n > 0) acts.push({ k: 'transfer', amount: n, note: (note || '').trim() }); return ''; });
  t = t.replace(/\[(收款|退还)\]/g, function (a, w) { acts.push({ k: w === '收款' ? 'accept' : 'refund' }); return ''; });
  return { reply: t.replace(/\n{3,}/g, '\n\n').trim(), acts: acts };
}
function addLocalMsg(m) {
  return dbPut('messages', m).then(function () {
    if (cur && cur.id === m.characterId) { var n = msgNode(m); if (n) { $('msgs').appendChild(n); lastShownTs = m.ts; scrollBottom(); } }
  });
}
function userPat() {
  if (!cur) return;
  addLocalMsg({ id: uid(cur.id), characterId: cur.id, role: 'user', type: 'pat', content: '你拍了拍 ' + cur.name, ts: Date.now() });
}
function transferSheet() {
  var amt = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', placeholder: '金额（元）', style: 'width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:inherit;margin-bottom:8px;font-size:18px' });
  var note = h('input', { type: 'text', placeholder: '备注（可不填）', style: 'width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:inherit' });
  openSheet([h('h3', { text: '转账给 ' + cur.name }), amt, note, h('div', { class: 'btn-row' },
    h('button', { class: 'btn primary', text: '转账', onclick: function () {
      var n = Math.round(parseFloat(amt.value) * 100) / 100; if (!(n > 0)) { toast('请输入大于 0 的金额'); return; }
      closeSheet();
    addLocalMsg({ id: uid(cur.id), characterId: cur.id, role: 'user', type: 'transfer', content: '', meta: { amount: n, note: note.value.trim(), receiverName: cur.name, status: 'pending' }, ts: Date.now() });
    } }),
    h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
  setTimeout(function () { amt.focus(); }, 50);
}
function transferLabel(m) {
  var s = (m.meta && m.meta.status) || 'pending';
  if (s === 'accepted') return m.role === 'user' ? '对方已收款' : '已收款';
  if (s === 'refunded') return m.role === 'user' ? '对方已退还' : '已退还';
  return m.role === 'user' ? '等待对方收款' : '点击收款 / 退还';
}
function redrawMsg(m) {
  var old = $('msgs').querySelector('.row[data-id="' + m.id + '"]'); if (!old) return;
  var n = msgNode(m); if (n) old.replaceWith(n);
}
async function setTransferStatus(m, st, byUser) {
  m.meta = m.meta || {}; m.meta.status = st; await dbPut('messages', m); redrawMsg(m);
  if (byUser) await addLocalMsg({ id: uid(m.characterId), characterId: m.characterId, role: 'user', type: 'pat', content: '[系统提示：用户' + (st === 'accepted' ? '收下' : '退还') + '了你转的 ¥' + m.meta.amount + ']', ts: Date.now() + 1, meta: { show: (st === 'accepted' ? '你收下了' : '你退还了') + cur.name + '的转账 ¥' + m.meta.amount } });
}
function onTransferTap(m) {
  if (selMode || Date.now() - lastLP < 700) return;
  if (m.role === 'assistant' && ((m.meta && m.meta.status) || 'pending') === 'pending')
    menuSheet('¥ ' + m.meta.amount + ' · ' + cur.name + ' 的转账', [['收款', function () { setTransferStatus(m, 'accepted', true); }], ['退还', function () { setTransferStatus(m, 'refunded', true); }]]);
}
/* AI 的动作落库：拍一拍 / 转账 → 新消息；收款 / 退还 → 改最近一笔待处理的用户转账 */
async function applyActs(char, acts, base) {
  var out = [];
  for (var i = 0; i < acts.length; i++) {
    var a = acts[i];
    if (a.k === 'pat') out.push({ type: 'pat', content: char.name + ' 拍了拍你' });
    else if (a.k === 'transfer') out.push({ type: 'transfer', content: '', meta: { amount: a.amount, note: a.note, receiverName: '我', status: 'pending' } });
    else {
      var tail = await pageMessages(char.id, null, 60), t = tail.filter(function (x) { return x.role === 'user' && x.type === 'transfer' && ((x.meta && x.meta.status) || 'pending') === 'pending'; }).pop();
      if (t) { t.meta.status = a.k === 'accept' ? 'accepted' : 'refunded'; await dbPut('messages', t); redrawMsg(t); out.push({ type: 'pat', content: char.name + (a.k === 'accept' ? ' 收下了你的转账 ¥' : ' 退还了你的转账 ¥') + t.meta.amount }); }
    }
  }
  return out;
}
/* 经期：数据在 settings.period，只存本机 */
function periodData() { var p = settings.period || {}; return { cycle: p.cycle || 28, len: p.len || 5, starts: (p.starts || []).slice().sort(function (a, b) { return a - b; }) }; }
function dayNum(ts) { var d = new Date(ts); return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000 + 0.5); }
function periodState() {
  var p = periodData(); if (!p.starts.length) return null;
  var last = p.starts[p.starts.length - 1], today = dayNum(Date.now()), n = today - dayNum(last) + 1;
  var next = dayNum(last) + p.cycle, to = next - today;
  var phase = n <= p.len ? '经期第 ' + n + ' 天' : to > 0 ? (to <= 3 ? '快到经期了' : n <= p.cycle / 2 - 2 ? '经期后的卵泡期' : n <= p.cycle / 2 + 2 ? '排卵期前后' : '经前黄体期') : '已晚于预计 ' + (-to) + ' 天';
  return { n: n, to: to, phase: phase, nextDate: new Date(next * 86400000 + new Date().getTimezoneOffset() * 60000) };
}
function periodPromptText() {
  var s = periodState(); if (!s) return '';
  return '# 用户的经期（只用来更体贴地关心，不要刻意、频繁地提起）\n现在：' + s.phase + (s.to > 0 ? '，预计 ' + s.to + ' 天后来' : '') + '。';
}
async function savePeriod(p) { settings.period = p; await saveSettings(); }
onShow['s-period'] = function () {
  var body = $('period-body'); body.innerHTML = '';
  var p = periodData(), s = periodState();
  body.appendChild(h('div', { class: 'glass pd-card' },
    h('div', { class: 'pd-big', text: s ? s.phase : '还没有记录' }),
    h('div', { class: 'pd-sub', text: s ? (s.to > 0 ? '距离下次预计还有 ' + s.to + ' 天（' + (s.nextDate.getMonth() + 1) + ' 月 ' + s.nextDate.getDate() + ' 日）' : '已晚于预计日期，来了就点下面的按钮记录') : '来了就点下面的按钮，记一次开始日' })));
  body.appendChild(h('div', { class: 'btn-row' },
    h('button', { class: 'btn primary', text: '今天来了', onclick: async function () {
      var q = periodData(), t = dayNum(Date.now());
      if (q.starts.some(function (x) { return Math.abs(dayNum(x) - t) < 3; })) { toast('最近已经记过了'); return; }
      q.starts.push(Date.now()); await savePeriod(q); onShow['s-period']();
    } }),
    h('button', { class: 'btn', text: '撤销最近一次', onclick: function () {
      var q = periodData(); if (!q.starts.length) return;
      confirmSheet('撤销最近一次记录？', '撤销', async function () { q.starts.pop(); await savePeriod(q); onShow['s-period'](); }, true);
    } })));
  var cy = h('input', { type: 'number', min: '20', max: '45', value: String(p.cycle) }), ln = h('input', { type: 'number', min: '2', max: '10', value: String(p.len) });
  function sv() { var q = periodData(); q.cycle = Math.max(20, Math.min(45, parseInt(cy.value, 10) || 28)); q.len = Math.max(2, Math.min(10, parseInt(ln.value, 10) || 5)); savePeriod(q); }
  cy.onchange = ln.onchange = function () { sv(); onShow['s-period'](); };
  body.appendChild(h('div', { class: 'group-title', text: '周期设置' }));
  body.appendChild(h('div', { class: 'group' },
    h('div', { class: 'field inline' }, h('label', { text: '周期长度（天）' }), cy),
    h('div', { class: 'field inline' }, h('label', { text: '经期天数' }), ln)));
  if (p.starts.length) {
    body.appendChild(h('div', { class: 'group-title', text: '记录（点一条可删除）' }));
    var g = h('div', { class: 'group' });
    p.starts.slice().reverse().slice(0, 12).forEach(function (t) {
      var d = new Date(t);
      g.appendChild(h('div', { class: 'item', onclick: function () { confirmSheet('删除这条记录？', '删除', async function () { var q = periodData(); q.starts = q.starts.filter(function (x) { return x !== t; }); await savePeriod(q); onShow['s-period'](); }, true); } },
        h('div', { class: 't' }, h('b', { text: d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 开始' }))));
    });
    body.appendChild(g);
  }
  body.appendChild(h('div', { class: 'hint', style: 'padding:0 20px;color:var(--sub);font-size:12px;line-height:1.6', text: '数据只存在这台设备里。想让某个角色知道并体贴你：角色设置 → 经期 → 打开。只是提示词里多一句话，不会多发请求。' }));
};

/* ---------- 看手机：APK 里的无障碍服务把「使用记录小报告」攒在本机，网页通过 window.PhoneWatch 读取；
 * 只在聊天请求生成时顺手带上（隐藏提示词），不额外请求、不联网、不后台推送 ---------- */
function pwBridge() { return window.PhoneWatch && typeof window.PhoneWatch.getReport === 'function' ? window.PhoneWatch : null; }
function pwCall(fn, a) { var b = pwBridge(); if (!b || typeof b[fn] !== 'function') return null; try { return a === undefined ? b[fn]() : b[fn](a); } catch (e) { return null; } }
function pwReport(since) { var r = pwCall('getReport', String(since || 0)); if (!r) return null; try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } }
function pwSecs(s) { s = Math.round(s || 0); if (s >= 3600) { var m = Math.round((s % 3600) / 60); return Math.floor(s / 3600) + '小时' + (m ? m + '分' : ''); } if (s >= 60) return Math.round(s / 60) + '分钟'; return s + '秒'; }
/* 小报告 → 几行字：累计统计 + 最近的高权重内容，总共控制在几百字 */
function pwFormat(r) {
  if (!r) return '';
  var L = [], apps = (r.apps || []).filter(function (a) { return a && a.secs >= 60; }).sort(function (a, b) { return b.secs - a.secs; }).slice(0, 5);
  if (apps.length) L.push('累计使用：' + apps.map(function (a) { return a.name + ' ' + pwSecs(a.secs); }).join('、'));
  (r.items || []).slice(-8).forEach(function (it) {
    var t = String(it.title || '').replace(/\s+/g, ' ').slice(0, 30);
    L.push(hm(it.ts) + ' ' + it.app + ' 停留' + pwSecs(it.secs) + (t ? '《' + t + '》' : '') + (it.liked ? '，点了赞' : '') + (it.commented ? '，评论了' : ''));
  });
  if (r.now) L.push('此刻正在用：' + r.now);
  return L.join('\n').slice(0, 700);
}
async function pwPromptCtx(char) {
  if (!char.watchOn || !pwBridge()) return null;
  var now = Date.now(), since = Math.max(char.watchSince || 0, now - 12 * 3600 * 1000), txt = pwFormat(pwReport(since));
  return txt ? { text: txt, ts: now } : null;
}
var PW_RULES = '# 用户的手机动态（只有你能看到的隐藏信息）\n下面是用户上次和你聊天之后，TA 手机上的使用情况（本机整理的摘要）。你可以像无意间瞥到一样，自然地关心、好奇或吐槽；别逐条复述，别说「监控」「记录」「我看到你的日志」，用户没提也可以不说。\n';
var PW_DEMO = { apps: [{ name: '抖音', secs: 7260 }, { name: '小红书', secs: 1080 }], items: [{ ts: Date.now() - 3600e3, app: '小红书', secs: 180, title: '腹肌男菩萨', liked: true }, { ts: Date.now() - 1800e3, app: '抖音', secs: 95, title: '深夜食堂一人食' }], now: '微信' };
onShow['s-watch'] = function () {
  var body = $('watch-body'); body.innerHTML = '';
  var has = !!pwBridge(), enabled = has ? pwCall('isEnabled') : null, rep = has ? pwReport(Date.now() - 12 * 3600 * 1000) : PW_DEMO;
  body.appendChild(h('div', { class: 'glass pd-card' },
    h('div', { class: 'pd-big', text: !has ? '需要 APK' : enabled === false || enabled === 'false' ? '无障碍还没开' : '已就绪' }),
    h('div', { class: 'pd-sub', text: !has ? '看手机靠安卓「无障碍服务」，网页里做不了；打包成 APK 并装好服务后这里才有数据。下面是示例预览。' : (enabled === false || enabled === 'false' ? '点下面的按钮去系统设置里打开「夏青Phone 看手机」。' : '本机正在静默记录，聊天时才会顺手带给角色。') })));
  if (has) body.appendChild(h('div', { class: 'btn-row' },
    h('button', { class: 'btn primary', text: '打开无障碍设置', onclick: function () { pwCall('openSettings'); } }),
    h('button', { class: 'btn danger', text: '清空记录', onclick: function () { confirmSheet('清空本机的使用记录？', '清空', function () { pwCall('clear'); onShow['s-watch'](); }, true); } })));
  body.appendChild(h('div', { class: 'group-title', text: '角色这次能看到的内容（最近 12 小时）' }));
  body.appendChild(h('div', { class: 'glass' }, h('div', { style: 'white-space:pre-wrap;line-height:1.7;font-size:14px', text: pwFormat(rep) || '（暂时没有记录）' })));
  var bl = h('textarea', { placeholder: '一行一个应用包名，例如：\ncom.eg.android.AlipayGphone', style: 'width:100%;min-height:90px;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:10px;background:transparent;color:inherit' });
  var cfg = has ? pwCall('getConfig') : null; try { bl.value = ((JSON.parse(cfg || '{}').blacklist) || []).join('\n'); } catch (e) {}
  body.appendChild(h('div', { class: 'group-title', text: '不记录的应用（包名）' }));
  body.appendChild(h('div', { class: 'glass' }, bl, h('div', { class: 'btn-row', style: 'margin-top:8px' }, h('button', { class: 'btn', text: '保存', onclick: function () {
    if (!has) { toast('装了 APK 才能保存'); return; }
    pwCall('setConfig', JSON.stringify({ blacklist: bl.value.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean) })); toast('已保存');
  } })), h('div', { class: 'hint', style: 'color:var(--sub);font-size:12px;line-height:1.6', text: '密码输入框、银行/支付/验证码类应用默认就不记录。记录只存在这台手机本地。' })));
  body.appendChild(h('div', { class: 'hint', style: 'padding:0 20px 20px;color:var(--sub);font-size:12px;line-height:1.7', text: '规则：划过不到 10 秒的内容丢弃；停留超过 30 秒或点赞/评论的才记成一条；只保留最近 20 条，新的顶掉最旧的；其余合并成「累计用了多久」。要让某个角色能看，去「角色设置 → 看手机」打开。' }));
};
var PLUS_ITEMS = [
  ['重说', 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', function () { confirmSheet('让 ' + cur.name + ' 重新回复上一轮？\n（会删掉 TA 最近这一轮的回复，重新生成）', '重说', regenerate); }],
  ['语音', 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4', function () { openVoiceRecorder(); }],
  ['系统录音机 / 音频文件', 'M3 12h2l2-6 3 12 3-9 2 3h6', function () { voiceFromFile(true); }],
  ['图片', 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5h.01', function () { openImagePicker(); }],
  ['一起听（网易云）', 'M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z', function () { muTogetherToggle(); }],
  ['转账', 'M7 8h12l-3-3M17 16H5l3 3M12 10v4M10.5 11.5h3', function () { transferSheet(); }],
  ['拍一拍', 'M9 11V5.5a1.5 1.5 0 0 1 3 0V10M12 10V4.5a1.5 1.5 0 0 1 3 0V10M15 10V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4 13.5a1.5 1.5 0 0 1 2.5-1.6L9 14.5', function () { userPat(); }],
  ['看手机', 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2', function () {
    menuSheet('看手机', [[cur.watchOn ? '不让 ' + cur.name + ' 看我的手机' : '让 ' + cur.name + ' 看我的手机', async function () { cur.watchOn = !cur.watchOn; await saveCur(); toast(cur.watchOn ? (pwBridge() ? '已开启：下次回复会带上最近的手机动态' : '已开启（装了 APK 后才有内容）') : '已关闭'); }], ['打开看手机页', function () { go('s-watch'); }]]);
  }]
];
function closePlus() { $('plusmenu').hidden = true; $('b-plus').classList.remove('on'); }
$('b-plus').onclick = function () {
  if (!cur) return;
  var pm = $('plusmenu'), st = $('plus-stack');
  if (!pm.hidden) { closePlus(); return; }
  st.innerHTML = '';
  PLUS_ITEMS.forEach(function (it, i) {
    var b = h('button', { type: 'button', 'aria-label': it[0], onclick: function (e) { e.stopPropagation(); closePlus(); it[2](); } });
    b.style.animationDelay = (i * 35) + 'ms';
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + it[1] + '"/></svg><em>' + it[0] + '</em>';
    st.appendChild(b);
  });
  pm.hidden = false; $('b-plus').classList.add('on');
};
$('plusmenu').addEventListener('click', function (e) { if (e.target === this) closePlus(); });

/* ---------- 外部 TTS（OpenAI 兼容 /v1/audio/speech）：配置只读 localStorage，代码里不写任何默认地址或密钥 ---------- */
function ttsCfg() {
  var o = {}; try { o = JSON.parse(localStorage.getItem('mp_tts') || '{}') || {}; } catch (e) {}
  return { url: String(o.url || '').trim(), key: String(o.key || '').trim(), voice: String(o.voice || '').trim(), model: String(o.model || '').trim() || 'tts-1' };
}
function ttsSave(o) { try { localStorage.setItem('mp_tts', JSON.stringify(o)); } catch (e) { toast('保存失败：浏览器不让写本地存储'); } }
function ttsEndpoint(u) {
  var b = String(u || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/v1\/audio\/speech$/.test(b)) return b;
  b = b.replace(/\/audio\/speech$/, '').replace(/\/v1$/, '');
  return b + '/v1/audio/speech';
}
var ttsMem = {}, ttsAudio = null, ttsBtn = null, ttsBub = null, ttsBusy = {};
function ttsKey(text, c) { var s = c.model + '|' + c.voice + '|' + text, x = 5381; for (var i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0; return 'https://tts.cache.local/' + x.toString(36) + '-' + s.length; }
async function ttsBlob(text, c) {
  var k = ttsKey(text, c);
  if (ttsMem[k]) return ttsMem[k];
  var cache = null; try { cache = window.caches ? await caches.open('mp-tts-v1') : null; } catch (e) {}
  if (cache) { try { var hit = await cache.match(k); if (hit) { var hb = await hit.blob(); ttsMem[k] = hb; return hb; } } catch (e) {} }
  var res = await fetch(ttsEndpoint(c.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key }, body: JSON.stringify({ model: c.model, input: text, voice: c.voice }) });
  if (!res.ok) { var raw = ''; try { raw = await res.text(); } catch (e) {} var er = new Error('语音合成失败 ' + res.status + (raw ? '：' + raw.slice(0, 200) : '')); throw er; }
  var blob = await res.blob();
  if (!blob.size || /json|text/.test(blob.type || '')) { throw new Error('接口没有返回音频' + (blob.size ? '：' + (await blob.text()).slice(0, 200) : '')); }
  ttsMem[k] = blob;
  if (cache) { try { await cache.put(k, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } })); } catch (e) {} }
  return blob;
}
function ttsStop() {
  if (ttsAudio) { try { ttsAudio.pause(); } catch (e) {} }
  if (ttsBtn) ttsBtn.textContent = '▶';
  if (ttsBub) ttsBub.classList.remove('playing', 'loading');
}
/* 点气泡：没在放 → 合成（有缓存就不再请求）并播放；在放 → 暂停；暂停中 → 继续 */
async function speakVoice(btn, text, bub) {
  if (ttsAudio && ttsBtn === btn && ttsAudio.src) {
    if (!ttsAudio.paused) { ttsAudio.pause(); btn.textContent = '▶'; if (bub) bub.classList.remove('playing'); return; }
    if (!ttsAudio.ended) { ttsAudio.play(); btn.textContent = '⏸'; if (bub) bub.classList.add('playing'); return; }
  }
  var c = ttsCfg();
  if (!c.url || !c.key || !c.voice) { iosAlert('还没配置语音', '请到「设置 → 语音合成（TTS）」填好接口地址、密钥和音色 ID 并保存。'); return; }
  if (ttsBusy[btn.dataset.k || '']) return;
  ttsStop();
  var kk = ttsKey(text, c); btn.dataset.k = kk; ttsBusy[kk] = true;
  btn.textContent = '…'; if (bub) bub.classList.add('loading');
  try {
    var blob = await ttsBlob(text, c);
    var a = new Audio(URL.createObjectURL(blob));
    ttsAudio = a; ttsBtn = btn; ttsBub = bub || null;
    a.onended = a.onerror = function () { btn.textContent = '▶'; if (bub) bub.classList.remove('playing', 'loading'); };
    await a.play();
    btn.textContent = '⏸'; if (bub) { bub.classList.remove('loading'); bub.classList.add('playing'); }
  } catch (e) {
    btn.textContent = '▶'; if (bub) bub.classList.remove('playing', 'loading');
    iosAlert('语音合成失败', e.message || String(e));
  } finally { delete ttsBusy[kk]; }
}
/* 去掉模型的思考过程：<think>/<thinking>/<thought> 标签，以及「🫧thought / 🫧thinking」标记及其内容 */
function stripLeakedPlan(t) {
  var raw = String(t || '');
  /* 1. 反代未包裹 <think> 标签、直接把英文 Markdown 思维链粘在正文前面时的兜底清洗 */
  if (/^\s*(?:\d+\.\s*\*\*[A-Za-z]|\*\s*\*?(?:Character|Directives|Current Time|Memory|Analyze|User|Context|Draft|Refining|Step|Plan|Thought|Tone|Rules?)\b)/i.test(raw)) {
    var lines = raw.split('\n'), i = 0;
    while (i < lines.length) {
      var ln = lines[i].trim();
      if (!ln || /^\d+\.\s*\*\*/.test(ln) || /^[-*•]\s+/.test(ln)) {
        var glue = ln.match(/^[-*•]\s+[A-Za-z0-9\s,.;:'"()\[\]`\-/!?]+[.)\]]\s*([\u4e00-\u9fff][\s\S]*)$/);
        if (glue && i > 0) { lines[i] = glue[1]; break; }
        i++;
      } else break;
    }
    if (i > 0 && i < lines.length) raw = lines.slice(i).join('\n');
  }

  /* 2. 兜底清洗：开头出现中文分条思维链（如 "1. 要……2. 怎么……"）且后文已切入正文/标签时，剥离前面的分条草稿 */
  var trimmedStart = raw.replace(/^\s+/, '');
  if (/^1[、.．]\s*[^\n]{1,120}(?:\n|[，,。\s]+2[、.．]\s*)/.test(trimmedStart)) {
    /* 优先从第一个末尾标签（<状态> / <心声> / <朋友圈> / </结束>）往前找，或者找明显开始说人话/动作的一行 */
    var lines2 = trimmedStart.split('\n');
    var cutIdx = -1;
    for (var j = 1; j < lines2.length; j++) {
      var s = lines2[j].trim();
      if (!s) continue;
      /* 如果这行已经不是 "1./2./3." 分条，且不像分析/指令说明，就认为是正文起点 */
      var isStepLine = /^(?:\d+[、.．\)]|[-*•]|分析|指令|规则|人设|记忆|语气|注意|首先|其次|最后|总结|草稿)/.test(s);
      if (!isStepLine && /[\u4e00-\u9fff]/.test(s)) {
        /* 确保前面确实有过分条思维链 */
        var prevPart = lines2.slice(0, j).join('\n');
        if (/(?:^|\n)\s*1[、.．\)]/.test(prevPart) && /(?:^|\n)\s*2[、.．\)]/.test(prevPart)) {
          cutIdx = j;
          break;
        }
      }
    }
    if (cutIdx > 0) raw = lines2.slice(cutIdx).join('\n');
  }

  /* 3. 模型把「我要怎么回」的英文草稿漏进了回复开头：只在后面确实跟着中文时才去掉 */
  var m = /^\s*((?:let'?s|let me|i('ll| will| should| need to| must| am going to)|okay[,.]?\s|ok[,.]?\s|alright|so,|now,|first,|the user|user (?:is|has|wants|said|asked)|as (?:the|an) (?:character|ai)|(?:here'?s|here is) (?:my|a|the)|(?:draft|plan|response|reply)\b)[^\u3400-\u9fff\n]*?[.:!]\s*)(?=[\s\S]*[\u4e00-\u9fff])/i.exec(raw);
  if (m && /(response|reply|message|answer|write|respond|natural|character|persona|draft|plan|user)/i.test(m[1])) raw = raw.slice(m[0].length);
  return raw.replace(/^\s+/, '');
}
/* 拦截反代/思考模型漏进正文的「裸奔思考过程」（不带 <think> 标签，以「思考过程：」「Thinking Process:」或「1. 分析用户输入：」开头的编号分析清单） */
var RE_NAKED_HEAD = /^\s*(?:\*{1,2}|#{1,4}\s*)?(?:思考过程|思维过程|推理过程|分析过程|思考|Thinking\s*Process|Thought\s*Process|Reasoning\s*Process|Thinking|Reasoning)\s*[:：]?\s*(?:\*{1,2})?\s*$/i;
var RE_NAKED_STEP1 = /^\s*(?:\*{1,2})?(?:1[\.、]|一、)\s*(?:分析用户|理解用户|角色设定|设定与|世界书|检查约束|构思回复|回复策略|Analyze|User\s*Input|Character|Context|Constraints)/i;
var RE_NAKED_STEP = /^\s*(?:\*{1,2})?(?:\d+[\.、]|[一二三四五六七八九十]+、)\s*\S/;
var RE_NAKED_BULLET = /^\s*(?:[-*•·]|\d+\))\s+\S/;
var RE_NAKED_DELIM = /^\s*(?:(?:\*{1,2}|#{1,4}\s*)?(?:正式回复|最终回复|回复内容|回复|输出|正文|Final\s*Response|Response|Reply|Output)\s*[:：]\s*(?:\*{1,2})?|[-*_]{3,})\s*$/i;
var RE_NAKED_GLUE = /^\s*[-*•·]\s*[^。\n]{2,50}(?:标签|预设|声音|表情|语音|约束|规则|标点|引号|句号|逗号|分段|格式|心声|状态|人设|设定|世界书|检查|确认|输出|回复|口语|字数)[^。\n]*。\s*(.+)$/;
function stripNakedThinking(text) {
  var t = String(text || '').replace(/\r/g, '');
  var lines = t.split('\n');
  var i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return text;
  var first = lines[i].trim();
  var isHead = RE_NAKED_HEAD.test(first);
  var isStep1 = RE_NAKED_STEP1.test(first);
  if (!isHead && !isStep1) return text;
  var look = lines.slice(i + (isHead ? 1 : 0), i + 12);
  var hasList = look.some(function (ln) { return RE_NAKED_STEP.test(ln) || RE_NAKED_BULLET.test(ln); });
  if (!hasList) return text;
  if (isHead) i++;
  var glueTail = '';
  while (i < lines.length) {
    var ln = lines[i];
    if (!ln.trim()) { i++; continue; }
    if (RE_NAKED_DELIM.test(ln)) { i++; break; }
    if (RE_NAKED_STEP.test(ln)) { i++; continue; }
    if (RE_NAKED_BULLET.test(ln)) {
      var j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      var nextIsList = j < lines.length && (RE_NAKED_STEP.test(lines[j]) || RE_NAKED_BULLET.test(lines[j]) || RE_NAKED_DELIM.test(lines[j]));
      if (!nextIsList) {
        var gm = ln.match(RE_NAKED_GLUE);
        if (gm && gm[1] && gm[1].trim()) glueTail = gm[1].trim();
      }
      i++;
      continue;
    }
    break;
  }
  var rest = lines.slice(i).join('\n').trim();
  if (glueTail) rest = rest ? (glueTail + '\n' + rest) : glueTail;
  return rest ? rest : text;
}
function stripThinking(text) {
  var t = String(text || '');
  t = t.replace(/<(think|thinking|thought|thoughts)>[\s\S]*?<\/\1>/gi, '');
  t = t.replace(/<(think|thinking|thought|thoughts)>[\s\S]*$/i, '');
  t = t.replace(/^[\s\S]*?<\/(think|thinking|thought|thoughts)>/i, '');
  var W = '(?:thoughts?|thinking|think|reasoning)', open = new RegExp('🫧\\s*' + W + '\\b[ \\t]*[:：]?[ \\t]*', 'i'), close = new RegExp('🫧\\s*/\\s*' + W + '\\s*[:：]?|🫧(?!\\s*' + W + ')', 'i'), guard = 0;
  while (guard++ < 30) {
    var m = open.exec(t); if (!m) break;
    var rest = t.slice(m.index + m[0].length), end, nl = rest.indexOf('\n'), cl = close.exec(rest);
    if (cl && (nl === -1 || cl.index <= nl || /^\s*\n/.test(rest))) end = cl.index + cl[0].length;   /* 有闭合标记 */
    else if (nl === -1) end = rest.length;                                                               /* 最后一行 */
    else if (/^\s*$/.test(rest.slice(0, nl))) { var bl = /\n[ \t]*\n/.exec(rest.slice(nl)); end = bl ? nl + bl.index + bl[0].length : rest.length; }   /* 标记单独一行：思考在下面，删到空行 */
    else end = nl + 1;                                                                                    /* 标记后面同一行有内容：只删这一行 */
    t = t.slice(0, m.index) + rest.slice(end);
  }
  t = t.replace(/🫧\s*\/\s*(?:thoughts?|thinking|think|reasoning)\s*[:：]?/gi, '');
  t = stripNakedThinking(t);
  return stripLeakedPlan(t);
}
/* 本机转文字（不走你的 API）：新版 Chrome 能直接把录音喂给识别器；旧的就「外放 + 麦克风听」 */
/* 用 API 转文字（会请求 1 次）：Gemini 官方地址 → 用主模型听；其它 → 走反代的 /v1/audio/transcriptions（OpenAI 格式的 whisper 接口） */

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
  openBottomSheet([h('h3', { text: manage ? '管理表情包（点一个删除）' : '发送表情包（' + list.length + '）' }), tabs, grid,
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
        iosAlert('导入完成', '已导入 ' + add.length + ' 个' + (dup ? '，跳过 ' + dup + ' 个重复' : ''));
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
/* 一条发给模型的消息大概多少 token（图片、语音按多模态估算，不把 base64 当文字数） */
function estApiMsg(m) {
  if (typeof m.content === 'string') return estTokens(m.content) + 4;
  return 4 + m.content.reduce(function (k, part) {
    if (part.type === 'text') return k + estTokens(part.text);
    if (part.type === 'image_url') return k + 600;
    if (part.type === 'audio_data') return k + Math.max(1, Math.round(String(part.data || '').length * 0.75 / 32000)) * 32;
    return k;
  }, 0);
}
/* 组装提示词 */
async function buildPrompt(char) {
  var P = ctxParams(char), ptr = char.lastSummaryTs || 0;
  var recentRows = await pageMessages(char.id, null, P.W + P.S);
  /* 开了自动总结：带「总结指针」之后的全部原话（最多 窗口+步长 条）；没开：只带最近 窗口 条 */
   var history = P.auto ? recentRows.filter(function (m) { return m.ts > ptr; }) : recentRows.slice(-P.W);
  /* 只有在总结指针之后完全没有新消息时，才兜底带最近 4 条，不再把已总结过的旧原话整批塞回来 */
  if (P.auto && !history.length) history = recentRows.slice(-4);
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
  var apiMsgs = toApiMessages(history, { wav: wavs, timeAware: char.timeAware !== false });
  var lastAiMsg = lastAi >= 0 ? history[lastAi] : null, gap = lastAiMsg && lastAiMsg.ts ? Date.now() - lastAiMsg.ts : 0;
  var hasVoice = history.some(function (m) { return m.type === 'voice' && m.role === 'user' && m.meta && m.meta.audio; });
  var allBooks = await dbAll('worldBooks');
  var books = allBooks.filter(function (b) { return (char.worldBookIds || []).indexOf(b.id) !== -1; });
  var entries = [];
  books.forEach(function (b) {
    (b.entries || []).forEach(function (e) {
      if (e.enabled === false || !e.content) return;
      entries.push({ book: b.name || '世界书', title: e.title || '', content: String(e.content), always: true });
    });
  });
  var mem = memForPrompt(await memLoad(char.id));
  var thought = null;
  if (char.injectThought) {
    var th = (await dbAllWithKeys('thoughts')).map(function (r) { return r.value; }).filter(function (t) { return t.characterId === char.id; }).sort(function (a, b) { return b.ts - a.ts; })[0];
    if (th) thought = th;
  }
  var preset = null;
  if (char.offlineMode && char.offlinePresetId) { try { preset = (await dbGet('offlinePresets', char.offlinePresetId)) || null; } catch (e) {} }
  if (preset && preset.entries && preset.entries.length) {   /* 预设里的条目：没关键词=常驻，有关键词=最近聊天里出现才带入 */
    var hayP = history.slice(-12).map(function (m) { return msgToText(m); }).join('\n').toLowerCase();
    var extra = preset.entries.filter(function (e) {
      if (!e || e.enabled === false || !e.content) return false;
      var ks = (e.keys || []).filter(Boolean);
      return !ks.length || ks.some(function (k) { return hayP.indexOf(String(k).toLowerCase()) !== -1; });
    }).map(function (e) { return (e.title ? '【' + e.title + '】\n' : '') + e.content; });
    preset = { content: [preset.content || ''].concat(extra).filter(function (x) { return String(x).trim(); }).join('\n\n') };
  }
  var wantThought = !!(char.autoThought && char.autoThought.enabled);
  var moCtx = char.momentsOn ? await buildMomentsContext(char) : null;
  var pwCtx = await pwPromptCtx(char);
  var muCtx = await muPromptCtx(char);   /* 一起听：只有绑定了这个角色才有 */
  var pool = stickerPool(await dbAll('stickers'), char.stickerCategoryIds);
  var shown = sampleStickers(pool, settings.stickerPromptLimit);
  var sctx = { gap: gap, char: char, settings: settings, entries: entries, profile: mem.profile, manual: mem.manual, auto: mem.auto.slice(), stickers: shown, thought: thought, preset: preset, wantThought: wantThought, momentsText: moCtx ? moCtx.text : '', periodText: char.periodOn ? periodPromptText() : '', watchText: pwCtx ? pwCtx.text : '', musicText: muCtx ? muRulesText(muCtx) : '', musicState: muCtx ? muStateText(muCtx) : '', voice: audioUsed ? 'audio' : hasVoice, dictate: dictIds.length, changes: changes, now: Date.now(), depth: true };
  var system = buildSystem(sctx), depthText = '', trim = null;
  /* 总 token 控制（设置里的开关，默认关）：估算 系统提示 + 背景资料 + 聊天记录，超过上限就先少带最早的过往摘要，再减最早的聊天记录（至少留 10 条）；角色设定和最新的消息永远不动 */
  if (settings.tokBudgetOn) {
    var maxOut = Number(settings.maxOutTokens) > 0 ? Number(settings.maxOutTokens) : 1500;
    var budget = Math.max(2000, memNum(settings.tokBudget, 60000, 2000, 2000000) - maxOut);
    var histTok = apiMsgs.reduce(function (n, m) { return n + estApiMsg(m); }, 0);
    var calc = function () { return estTokens(system) + histTok; };
    var tot = calc(), dMem = 0, dRows = 0;
    while (tot > budget && sctx.auto.length) { sctx.auto.shift(); dMem++; system = buildSystem(sctx); tot = calc(); }
    while (tot > budget && apiMsgs.length > 10) { histTok -= estApiMsg(apiMsgs.shift()); dRows++; tot = calc(); }
    trim = { budget: budget, total: tot, mem: dMem, rows: dRows, over: tot > budget };
  }
  /* 背景资料全部在 system 中，不再向聊天记录插入额外消息 */
  var depthIdx = -1;
  return { system: system, depthText: '', depthIdx: depthIdx, watchTs: pwCtx ? pwCtx.ts : 0, messages: apiMsgs, pool: pool, wantThought: wantThought, momentIds: moCtx ? moCtx.ids : null, musicOn: !!muCtx, dictIds: dictIds, stats: { history: history.length, entries: entries.length, memories: mem.manual.length + sctx.auto.length, stickers: shown.length, profile: mem.profile.length }, trim: trim };
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
if (!fresh && r && r.active && r.won) return;   /* 正在弹气泡时防手滑点重 */
if (fresh || !r || !r.active) r = rounds[char.id] = { active: true, won: false, total: 0, fails: 0 };
  r.total++; refreshTitle();
  try {
    var prompt = await buildPrompt(char); prompt.chatId = char.id;
    var text = await callLLM({
      base: settings.baseUrl, key: settings.apiKey, model: settings.model, temperature: Number(settings.temperature), maxTokens: Number(settings.maxOutTokens) || 0,
      system: prompt.system, messages: prompt.messages, stream: settings.stream
    });
    if (!r.active || r.won) return;
    text = cleanModelText(text);   /* 乱码 / 缺右括号 / 半截标签 / 被截断的 JSON */
    var dict = extractDictation(text);   /* 用户语音的文字也随回复一起回来，不另外请求 */
    /* 听写标签比待听写的语音条数多：多出来的是模型把自己的回复错包进了标签，当正常回复显示，不丢 */
    var nDict = (prompt.dictIds || []).length;
    if (dict.texts.length > nDict) { var extraDict = dict.texts.splice(nDict).filter(Boolean); dict.reply = extraDict.join('\n') + (dict.reply ? '\n' + dict.reply : ''); }
    var structured = parseStructuredResponse(dict.reply);
    var normalizedReply = structured ? structured.text : dict.reply;
    var mc = extractMusicCmd(normalizedReply);   /* 结构化 music 动作与旧 [CMD:…] 统一处理 */
    var ac = extractActions(mc.reply);   /* [拍一拍] [转账] [收款] 也随回复回来 */
    var mo = extractMoments(ac.reply);   /* 朋友圈互动也随回复一起回来 */
    var st = extractStatus(mo.reply);
    var ex = extractThought(st.reply), replyText = ex.reply;   /* 心声同理 */
    if (settings.autoStripFormat !== false) replyText = stripExtraFormat(replyText);
    var items = char.offlineMode ? (replyText.trim() ? [{ type: 'offline', content: replyText.trim() }] : []) : parseReplyLines(splitReply(jsonReplyToLines(replyText) || replyText, 20), prompt.pool, !char.offlineMode), base = Date.now(), saved = [];
    if (!items.length && !ac.acts.length) {
      /* 过滤完什么都没剩：不再报错（请求已经成功、额度已经花了）。把模型原话去掉标签外壳后直接发进聊天，不对就自己删 */
      if (dict.texts.length) toast('模型这次只写了语音的文字，没有写回复，可以重新生成一次');   /* 只有听写：发出来会变成 AI 复述你的话，所以不发气泡 */
      else {
        var rawTxt = String(text || ''), fb = rawTxt.replace(/<\/?(?:听写|状态|心声|朋友圈)[^>]*>/g, '').trim() || rawTxt.trim();
        if (!fb) throw new Error('模型返回了空内容');
        items = char.offlineMode ? [{ type: 'offline', content: fb }] : splitReply(fb, 20).map(function (s) { return { type: 'text', content: s }; });
      }
    }
    r.won = true;
    var actItems = ac.acts.length ? await applyActs(char, ac.acts) : [];
    actItems.forEach(function (a) { items.push(a); });
    if (st.status) {
      char.status = st.status;
      await dbPut('characters', char);
      refreshTitle();
    }
    items.forEach(function (it, i) {
      var m = { id: uid(char.id), characterId: char.id, role: 'assistant', type: it.type, content: it.content, ts: base + i };
      if (it.meta) m.meta = it.meta; saved.push(m);
    });
    await dbBulkPut('messages', saved);
    await applyDictation(prompt.dictIds, dict.texts);
    if (prompt.watchTs) { char.watchSince = prompt.watchTs; try { await dbPut('characters', char); } catch (e) {} }   /* 这段手机动态已经带过了，下次只带新的 */
    if (prompt.musicOn && mc.cmds.length) { try { await muApplyCmds(char, mc.cmds); } catch (e) {} }
    if (prompt.momentIds) { try { await applyMoments(char, mo.data, prompt.momentIds); } catch (e) { toast('朋友圈互动没存上：' + e.message); } }
    if (prompt.wantThought) {
      if (ex.thought) { await dbPut('thoughts', { characterId: char.id, heartfeltVoice: ex.thought.heartfeltVoice, randomJottings: ex.thought.randomJottings, ts: Date.now() }); refreshThoughtCloud(); }
      else toast('这次回复没带上心声（模型没按格式写）');
    }
    /* 先存好，再一条一条弹出来；中途退出聊天也不丢 */
    var told = false, pre = {};
    saved.forEach(function (sm) { if (sm.type === 'sticker') pre[sm.id] = preloadImg(sm.content, 3000); });   /* 表情包趁「打字」的空档先加载好，弹出来时就是完整的，不再先空一下 */
    for (var k = 0; k < saved.length; k++) {
      var m2 = saved[k];
      await sleep(bubbleDelay(m2.type === 'text' || m2.type === 'offline' ? m2.content : '', k === 0));
      if (pre[m2.id]) await pre[m2.id];
      var away = !viewingChat(char.id);
      /* 你在聊天里：每条气泡都响一声。你不在（在列表/别的页面/后台）：只在第一条响一声并弹通知，后面几条不再响；你点进来之后这一轮剩下的也不再响 */
      if (!told) playNotify();
      if (away) { notifyNewMsg(char, m2, !told); told = true; }   /* 用户不在这个聊天里：未读+1，第一条弹通知条 */
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

function preloadImg(url, ms) { return new Promise(function (res) { var done = false, fin = function () { if (!done) { done = true; res(); } }, im = new Image(); im.onload = fin; im.onerror = fin; setTimeout(fin, ms || 3000); try { im.src = url; } catch (e) { fin(); } }); }
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
  reloadChat(); iosAlert('已清空', '聊天记录已清空');
}

/* ---------- 消息提示音 / 未读红点 / 顶部通知条 / 系统通知 ---------- */
function notifySrc() { return notifyFile || settings.notifyUrl || ''; }
function playNotify() {
  if (document.hidden) return;   /* 页面在后台/锁屏时不放前端提示音，铃声交给系统通知（见 sysNotify） */
  try { var src = notifySrc(); if (!src) return; var a = new Audio(src); a.__skip = 1; a.play().catch(function () {}); } catch (e) {}
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
  /* APK 里（WebView 没有浏览器通知）：走安卓原生通知 */
  if (settings.sysNotify && window.PhoneNative && typeof window.PhoneNative.notify === 'function') { try { window.PhoneNative.notify(String(char.name || ''), String(text || ''), String(char.id)); } catch (e) {} return; }
  if (!settings.sysNotify || !('Notification' in window) || Notification.permission !== 'granted') return;
  var opt = { body: text, tag: 'chat-' + char.id, renotify: true, silent: false, data: { cid: char.id }, icon: /^data:image|^https?:/.test(char.avatar || '') ? char.avatar : undefined };
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
        iosAlert('导入完成', '已导入 ' + add.length + ' 条' + (list.length - add.length > 0 ? '，跳过重复 ' + (list.length - add.length) + ' 条' : ''));
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
        openBottomSheet([h('h3', { text: fmtTime(r.value.ts).replace(/:\d\d$/, '') }), h('div', { class: 'th-voice', text: '“' + (r.value.heartfeltVoice || '') + '”' }), h('div', { class: 'th-jot', text: r.value.randomJottings || '' }),
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
  var el = cloudEl, cl = el.querySelector('.cloud'), rows = await charThoughts(cur.id), box = el.querySelector('.cloud-body');
  if (el !== cloudEl) return;
  box.innerHTML = '';
  var more = el.querySelector('.cl-more');
  if (!rows.length) {
    box.appendChild(h('div', { class: 'cl-cap', text: '💭 ' + cur.name + ' 的心声' }));
    box.appendChild(h('div', { class: 'cl-voice', text: '“…”' }));
    box.appendChild(h('div', { class: 'cl-jot', text: '（暂无随笔）' }));
    if (more) more.hidden = true;
  } else {
    var t = rows[0].value; if (more) more.hidden = false;
    box.appendChild(h('div', { class: 'cl-cap', text: '💭 ' + cur.name + ' 的心声 · ' + fmtTime(t.ts).replace(/:\d\d$/, '').slice(5) }));
    box.appendChild(h('div', { class: 'cl-voice', text: t.heartfeltVoice ? '“' + t.heartfeltVoice + '”' : '“…”' }));
    box.appendChild(h('div', { class: 'cl-jot', text: t.randomJottings || '（暂无随笔）' }));
  }
  placeCloud();
  if (cl) cl.style.visibility = '';   /* 内容填好、位置算好之后才显示，避免左上角闪一下 */
}
function placeCloud() {
  if (!cloudEl || !cloudAnchor) return;
  var r = cloudAnchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, cw = cloudEl.offsetWidth, ch = cloudEl.offsetHeight;
  var left = Math.max(10, Math.min(vw - cw - 10, r.left - 4)), top = r.bottom + 16, up = false;
  if (top + ch > vh - 70 && r.top - ch - 16 > 60) { top = r.top - ch - 16; up = true; }
  cloudEl.classList.toggle('up', up); cloudEl.style.left = left + 'px'; cloudEl.style.top = top + 'px';
  cloudEl.style.setProperty('--tail', Math.max(14, Math.min(cw - 30, r.left + r.width / 2 - left - 6)) + 'px');
}
['pointerdown', 'touchstart', 'mousedown'].forEach(function (ev) {   /* 点云朵以外任何地方都关（包括点消息气泡） */
  document.addEventListener(ev, function (e) {
    if (!cloudEl) return; var t = e.target;
    if (t && t.closest && t.closest('.cloud')) return;
    if (cloudAnchor && cloudAnchor.contains && cloudAnchor.contains(t)) return;
    closeCloud();
  }, true);
});
function showThoughtCloud(anchor) {
  if (cloudEl) { closeCloud(); return; }
  var shade = h('div', { class: 'cloud-shade' }), c = h('div', { class: 'cloud', style: 'visibility:hidden' }, h('i', { class: 't1' }), h('i', { class: 't2' }), h('div', { class: 'cloud-body' }),
    h('button', { type: 'button', class: 'cl-more', text: '查看全部心声 ›', onclick: function (e) { e.stopPropagation(); closeCloud(); openThoughts(cur); } }));
  shade.appendChild(c); document.body.appendChild(shade); cloudEl = shade; cloudAnchor = anchor;
  shade.addEventListener('pointerdown', function (e) { if (!e.target.closest('.cloud')) { e.preventDefault(); closeCloud(); } });
  shade.addEventListener('click', function (e) { if (!e.target.closest('.cloud')) closeCloud(); });
  fillCloud();
}
/* 新心声写进数据库后调用：云朵开着就换成最新的 */
function refreshThoughtCloud() { if (cloudEl) fillCloud(); }

/* ---------- 记忆页 / 总结 / 二次压缩 ---------- */
var sumBusy = {}, sumBlocked = {}, compBusy = {}, compBlocked = {};   /* sumBusy：同一角色同时只允许 1 个总结请求；sumBlocked / compBlocked：自动请求失败的时间，过一阵（总结 10 分钟、压缩 30 分钟）下一次回复才会再试一次 */
/* 取出一个角色的全部记忆，顺便把旧版数据迁移成新结构（只有发现旧字段才写库，之后不再重复） */
async function memLoad(cid) {
  var rows = await dbByIndex('memories', 'byChar', cid), puts = [], seen = {};
  rows.forEach(function (m) {
    if (m.roll) {   /* 旧版「前情提要」→ 阶段摘要（起点不详，写「截至…」） */
      m.stage = true; m.from = 0; m.to = Number(m.ptr) || Number(m.upTo) || m.ts; delete m.roll; delete m.ptr; delete m.upTo; delete m.chunk; puts.push(m); seen[m.id] = 1;
    } else if (m.chunk) { m.seg = true; delete m.chunk; puts.push(m); seen[m.id] = 1; }
  });
  /* 旧版「精炼」：最新一条（非常驻）精炼，取代它之前的逐条总结——和旧版一样，之前那些不再带，但留在记忆页里（归档） */
  var ref = null; rows.forEach(function (m) { if (m.kind === 'refined' && !m.core && !m.archived && (!ref || m.ts > ref.ts)) ref = m; });
  if (ref) rows.forEach(function (m) {
    if (m !== ref && m.kind === 'summary' && !m.seg && !m.stage && !m.core && !m.archived && (m.ts || 0) < ref.ts) { m.archived = true; m.mergedInto = ref.id; if (!seen[m.id]) puts.push(m); }
  });
  if (puts.length) await dbBulkPut('memories', puts);
  return rows;
}
/* 把几条摘要合并成一条阶段摘要：新条目先存，原条目只是标记成归档（不删），随时能撤销 */
async function memCompressApply(char, picks, text) {
  var starts = picks.map(function (m) { return Number(m.from) || Number(m.ts) || 0; }).filter(Boolean);
  var unknown = picks.some(function (m) { return m.stage && !(Number(m.from) > 0); });
  var stage = { id: uid('mem'), characterId: char.id, kind: 'summary', stage: true, content: text, ts: Date.now(),
    from: unknown || !starts.length ? 0 : Math.min.apply(null, starts), to: Math.max.apply(null, picks.map(memKey)), merged: picks.map(function (m) { return m.id; }) };
  picks.forEach(function (m) { m.archived = true; m.mergedInto = stage.id; });
  await dbBulkPut('memories', [stage].concat(picks));
  return stage;
}
async function memUndoMerge(stage) {
  var rows = await dbByIndex('memories', 'byChar', stage.characterId), back = [];
  rows.forEach(function (m) { if (m.archived && m.mergedInto === stage.id) { delete m.archived; delete m.mergedInto; back.push(m); } });
  if (back.length) await dbBulkPut('memories', back);
  await dbDel('memories', stage.id);
  return back.length;
}
/* 草稿确认：把它从「待确认」变成正式记忆；它带的固定信息只在没有更新的版本时才写入 */
async function memConfirm(m) {
  if (m.profile != null) {
    var base = await dbGet('memories', 'profile-' + m.characterId), txt = String(m.profile || '').trim();
    if (txt && (!base || (base.srcTs || 0) <= (m.ts || 0))) await dbPut('memories', { id: 'profile-' + m.characterId, characterId: m.characterId, kind: 'profile', content: txt, ts: Date.now(), srcTs: m.ts || 0 });
  }
  delete m.pending; delete m.profile; await dbPut('memories', m);
}
/* 过往摘要攒太多（超过设置里的字数）就把最早的几条合并：最新 3 条不动；每次最多合并两轮；失败了不影响总结本身，30 分钟后再试 */
async function memAutoCompress(char) {
  if (settings.memAutoCompress === false || compBusy[char.id]) return;
  if (compBlocked[char.id] && Date.now() - compBlocked[char.id] < 30 * 60 * 1000) return;
  compBusy[char.id] = true;
  try {
    for (var pass = 0; pass < 2; pass++) {
      var auto = memCollect(await memLoad(char.id)).auto, at = memNum(settings.memCompressAt, 6000, 1000, 100000), total = memChars(auto);
      if (total <= at) break;
      var cand = auto.slice(0, Math.max(0, auto.length - MEM_KEEP_NEWEST)); if (cand.length < 2) break;
      var picks = [], cum = 0;
      for (var i = 0; i < cand.length; i++) { picks.push(cand[i]); cum += memText(cand[i]).length; if (cum >= total * 0.5 && picks.length >= 2) break; }
      var target = Math.min(memNum(settings.memStageMax, 1500, 300, 6000), Math.max(300, Math.round(cum * 0.45)));
      var text = await memMerge(char, picks, target);
      if (text.length > cum * 0.9) throw new Error('压缩结果没有变短，已放弃');
      await memCompressApply(char, picks, text);
      toast('旧记忆已自动合并（' + picks.length + ' 条 → 1 条，原条目已归档）');
    }
  } catch (e) {
    compBlocked[char.id] = Date.now();
    toast('自动合并旧记忆失败：' + String(e.message || e).slice(0, 60) + '（原记忆都还在，30 分钟后再试）');
  } finally { compBusy[char.id] = false; }
}
function memTypeName(m) {
  if (m.stage) return '合并摘要'; if (m.seg) return m.manual ? '分段摘要·手动' : '分段摘要';
  if (m.kind === 'note') return '手写'; if (m.core) return '常驻';
  return m.kind === 'refined' ? '旧·精炼' : '旧总结';
}
function memItem(m, tags) {
  var t = h('div', { class: 't' }, h('b', { text: memLabel(m) || fmtTime(m.ts).replace(/:\d\d$/, '') }));
  tags.forEach(function (g) { t.appendChild(h('span', { class: 'badge' + (g[1] ? ' ' + g[1] : ''), text: g[0] })); });
  return h('div', { class: 'item', onclick: function () { editMemory(m); } }, t, h('div', { class: 'c', text: memText(m) }));
}
var memShowArchived = false;
async function renderMemory() {
  if (!cur) return;
  var ch = cur; $('mem-title').textContent = ch.name + ' · 记忆';
  var rows = await memLoad(ch.id); if (!cur || cur.id !== ch.id) return;
  var C = memCollect(rows), body = $('mem-body'); body.innerHTML = '';
  var at = memNum(settings.memCompressAt, 6000, 1000, 100000);
  body.appendChild(h('div', { class: 'group-title', text: '每次都会带给 TA：固定信息 + 手写记忆 + 过往摘要（按时间从早到晚）。过往摘要现在共 ' + C.auto.length + ' 条 ' + memChars(C.auto) + ' 字，超过 ' + at + ' 字会自动把最早的几条合并（原条目归档，不删）。' }));
  var pg = h('div', { class: 'group' });
  pg.appendChild(h('div', { class: 'item', onclick: function () { editProfile(ch); } },
    h('div', { class: 't' }, h('b', { text: '固定信息' }), h('span', { class: 'badge on', text: '每次都带' })),
    h('div', { class: 'c', text: C.profile && memText(C.profile) ? memText(C.profile) : '还没有。自动总结几次后会自动整理出来（称呼、生日、喜好、忌口、约定……），也可以点这里自己写。' })));
  body.appendChild(pg);
  if (C.pending.length) {
    var pend = h('div', { class: 'group' });
    pend.appendChild(h('div', { class: 'item' }, h('div', { class: 't' }, h('b', { text: '待确认 ' + C.pending.length + ' 条' }), h('span', { class: 'badge', text: '确认前不会带给 TA' })),
      h('div', { class: 'btn-row', style: 'margin-top:6px' }, h('button', { class: 'btn primary', text: '全部确认', onclick: async function () {
        for (var i = 0; i < C.pending.length; i++) await memConfirm(C.pending[i]); toast('已全部加入记忆'); renderMemory(); } }))));
    C.pending.slice().reverse().forEach(function (m) { pend.appendChild(memItem(m, [['待确认', 'acc'], [memTypeName(m)]])); });
    body.appendChild(pend);
  }
  if (C.manual.length) {
    var mg = h('div', { class: 'group' });
    C.manual.slice().reverse().forEach(function (m) { mg.appendChild(memItem(m, [[memTypeName(m)], ['每次都带', 'on']])); });
    body.appendChild(mg);
  }
  if (C.auto.length) {
    var ag = h('div', { class: 'group' });
    C.auto.slice().reverse().forEach(function (m) { ag.appendChild(memItem(m, [[memTypeName(m), m.stage ? 'acc' : ''], ['每次都带', 'on']])); });
    body.appendChild(ag);
  }
  if (!C.manual.length && !C.auto.length && !C.pending.length) body.appendChild(h('div', { class: 'empty', text: '还没有记忆。点「总结」手动生成，或在角色设置里开启自动总结。' }));
  if (C.archived.length) {
    body.appendChild(h('div', { class: 'group-title', style: 'cursor:pointer', text: (memShowArchived ? '▾ ' : '▸ ') + '已归档 ' + C.archived.length + ' 条（被合并掉的原条目，不会带给 TA；点一下展开/收起）', onclick: function () { memShowArchived = !memShowArchived; renderMemory(); } }));
    if (memShowArchived) { var rg = h('div', { class: 'group' }); C.archived.slice().reverse().forEach(function (m) { rg.appendChild(memItem(m, [['已归档'], [memTypeName(m)]])); }); body.appendChild(rg); }
  }
}
onShow['s-memory'] = renderMemory;
async function editProfile(ch) {
  var p = await dbGet('memories', 'profile-' + ch.id);
  textSheet('固定信息', p ? memText(p) : '', [
    { text: '保存', cls: 'primary', fn: async function (v) {
      var t = v.trim();
      if (!t) await dbDel('memories', 'profile-' + ch.id);
      else await dbPut('memories', { id: 'profile-' + ch.id, characterId: ch.id, kind: 'profile', content: t, ts: Date.now(), srcTs: Date.now() });
      if (cur && cur.id === ch.id) renderMemory(); } },
    { text: '取消' }], '每行一条：称呼、生日、喜好、忌口、重要的人、长期约定……每次聊天都会带给 TA。你改完后，下次自动总结会在你这份的基础上更新；留空保存就是清空。');
}
function editMemory(m) {
  var btns = [];
  if (m.pending) btns.push({ text: '确认加入记忆', cls: 'primary', fn: async function (v) { m.content = v; await memConfirm(m); renderMemory(); toast('已加入记忆'); } });
  btns.push({ text: '保存', cls: m.pending ? '' : 'primary', fn: async function (v) { m.content = v; await dbPut('memories', m); renderMemory(); } });
  if (m.stage && m.merged && m.merged.length) btns.push({ text: '撤销合并', fn: async function () { var n = await memUndoMerge(m); renderMemory(); toast('已恢复合并前的 ' + n + ' 条'); } });
  if (m.archived) btns.push({ text: '恢复这一条', fn: async function () { delete m.archived; delete m.mergedInto; await dbPut('memories', m); renderMemory(); toast('已恢复，会重新带给 TA'); } });
  if ((m.kind === 'note' || m.core) && !m.pending && !m.archived) btns.push({ text: '转为分段摘要', fn: async function (v) { m.content = v; m.kind = 'summary'; m.seg = true; m.manual = true; delete m.core; m.from = 0; m.to = m.ts || Date.now(); await dbPut('memories', m); renderMemory(); toast('已转成分段摘要：不再常驻，会进过往摘要，攒多了可被合并'); } });
  if (m.seg && !m.stage && !m.archived && !m.pending && m.manual) btns.push({ text: '转为常驻手写', fn: async function (v) { m.content = v; m.kind = 'note'; delete m.seg; delete m.manual; await dbPut('memories', m); renderMemory(); toast('已转成常驻手写，每次都带，不会被合并'); } });
  /* 最新一条自动摘要：删掉后把总结指针退回这段的起点，才能重新总结（否则这段会被当成已总结） */
  var canRewind = m.seg && !m.stage && !m.archived && !m.manual && Number(m.from) > 0 && cur && cur.id === m.characterId && (cur.lastSummaryTs || 0) === Number(m.to);
  if (canRewind) btns.push({ text: '删除并重新总结这段', cls: 'danger', fn: async function () {
    await dbDel('memories', m.id); cur.lastSummaryTs = Number(m.from) - 1; await dbPut('characters', cur); renderMemory();
    toast('已删除，总结指针已退回；点「总结」会重新总结这段'); } });
  btns.push({ text: canRewind ? '仅删除（指针不动）' : '删除', cls: 'danger', fn: async function () { await dbDel('memories', m.id); renderMemory(); } });
  btns.push({ text: '取消' });
  textSheet('编辑记忆', m.content, btns, m.stage ? '这是几条摘要合并出来的。「撤销合并」会删掉它，并把原来的几条恢复。' : (m.archived ? '这一条已经被合并进别的摘要，不会带给 TA；「恢复这一条」会让它重新生效（可能和合并后的内容有重复）。' : (canRewind ? '这是最新一条自动摘要。如果内容有问题：「删除并重新总结这段」会把总结指针退回这段的起点；「仅删除」则指针不动，这段原话不会再被总结。' : '')));
}
function dayVal(ts) { var d = new Date(ts), p = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
/* 手动写一条分段摘要：和自动总结出来的一样进「过往摘要」，按日期排序，攒多了会被合并。
 * 填「覆盖条数」：就是总结指针之后最早的 N 条，指针按条数前移（和点「总结」一样）；不填就按日期，默认不动指针 */
function addSegSheet() {
  var ch = cur; if (!ch) return;
  var st = 'width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--bg);color:inherit';
  var nIn = h('input', { type: 'number', min: '1', placeholder: '覆盖条数（推荐）：例 30', style: st + ';margin-bottom:8px' });
  var a = h('input', { type: 'date', value: dayVal(Date.now()), style: st }), b = h('input', { type: 'date', value: dayVal(Date.now()), style: st });
  var ta = h('textarea', { placeholder: '例：11月3日，A 和 B 约定周末去看海；B 因工作的事情绪低落，A 安慰了她。' });
  var mv = h('input', { type: 'checkbox' });
  openSheet([h('h3', { text: '新增分段摘要' }),
    h('div', { class: 'hint', style: 'color:var(--sub);font-size:12px;margin-bottom:8px', text: '和自动总结的一样放进「过往摘要」：每次都带给 TA，不常驻，攒多了会被合并。\n推荐填「覆盖条数」：就是总结指针之后最早的那几条，写完指针自动往前走，自动总结不会再重复这段。不填条数就用下面的日期，默认不动指针。' }),
    nIn, h('div', { style: 'display:flex;gap:8px;margin-bottom:8px' }, a, b), ta,
    h('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:8px;font-size:13px' }, mv, h('span', { text: '按日期保存时，也把总结指针推到结束日期之后' })),
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', { class: 'btn primary', text: '保存', onclick: async function () {
        var v = ta.value.trim(); if (!v) { toast('先写点内容'); return; }
        var f, t, cnt = 0, move = mv.checked, n = Math.floor(Number(nIn.value));
        if (n > 0) {
          var cand = (await pageMessages(ch.id, null, 400)).filter(function (x) { return x.ts > (ch.lastSummaryTs || 0) && !x.hidden && x.type !== 'system' && x.type !== 'pat'; }).slice(0, n);
          if (!cand.length) { toast('总结指针之后没有可覆盖的消息'); return; }
          f = cand[0].ts; t = cand[cand.length - 1].ts; cnt = cand.length; move = true;
        } else {
          f = new Date((a.value || dayVal(Date.now())) + 'T00:00:00').getTime(); t = new Date((b.value || a.value || dayVal(Date.now())) + 'T23:59:59').getTime();
          if (!isFinite(f) || !isFinite(t)) { toast('日期不对'); return; }
          if (f > t) { var x = f; f = t; t = x; }
        }
        closeSheet();
        await dbPut('memories', { id: uid('mem'), characterId: ch.id, kind: 'summary', seg: true, manual: true, content: v, ts: Date.now(), from: f, to: t, n: cnt });
        if (move && t > (ch.lastSummaryTs || 0)) { ch.lastSummaryTs = t; await dbPut('characters', ch); }
        if (cur && cur.id === ch.id) renderMemory(); toast(cnt ? '分段摘要已添加（覆盖 ' + cnt + ' 条，总结指针已前移）' : '分段摘要已添加');
      } }), h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
}
$('b-mem-add').onclick = function () {
  menuSheet('新增记忆', [
    ['分段摘要（进过往摘要，不常驻）', addSegSheet],
    ['手写记忆（常驻，每次都带）', function () {
      textSheet('新增手写记忆', '', [{ text: '保存', cls: 'primary', fn: async function (v) {
        if (!v.trim()) return;
        await dbPut('memories', { id: uid('mem'), characterId: cur.id, content: v.trim(), ts: Date.now(), kind: 'note' }); renderMemory();
      } }, { text: '取消' }], '手写的记忆每次都会带给 TA，不会被自动合并（适合核心设定、底线规则、你想让 TA 一直记得的事）。想让它只是一段过往经历，请选「分段摘要」。');
    }]
  ]);
};
/* 要总结的原话：总结指针之后、且已经溢出「短期窗口」的那些（最近 W 条留在窗口里，不总结） */
async function sumCandidates(char) {
  var P = ctxParams(char), ptr = char.lastSummaryTs || 0;
  /* 取的条数跟着步长走：步长调大、或总结失败积压时，也不会漏掉最旧的原话 */
  var all = (await pageMessages(char.id, null, Math.max(400, P.S + P.W + 200))).filter(function (m) { return m.ts > ptr && !m.hidden && m.type !== 'system' && m.type !== 'pat'; });
  return { P: P, all: all, older: all.slice(0, Math.max(0, all.length - P.W)) };
}
async function summarizeNow(char, silent, force) {
  if (sumBusy[char.id]) { if (!silent) toast('正在总结中，请稍等'); return false; }
  sumBusy[char.id] = true;
  try {
    var c0 = await sumCandidates(char);
    if (c0.older.length < (force ? 1 : c0.P.S)) { if (!silent) toast('最近的消息都还在短期窗口里，暂时不用总结'); return false; }
    var batch = c0.older.slice(0, c0.P.S);   /* 一次归纳的条数 = 该角色设置的步长（角色设置没填就用全局步长） */
    var rows = await memLoad(char.id), prior = memProfilePrior(rows, char.id);
    var sm = await memSummarizeSafe(char, batch, prior);   /* 只请求这 1 次 */
    var now = Date.now(), last = batch[batch.length - 1].ts, changed = sm.profile != null && sm.profile !== prior;
    var rec = { id: uid('mem'), characterId: char.id, kind: 'summary', seg: true, content: sm.seg, ts: now, from: batch[0].ts, to: last, n: batch.length };
    if (settings.memConfirm) { rec.pending = true; if (changed) rec.profile = sm.profile; }
    else if (changed) await dbPut('memories', { id: 'profile-' + char.id, characterId: char.id, kind: 'profile', content: sm.profile, ts: now, srcTs: now });
    await dbPut('memories', rec);
    char.lastSummaryTs = last; await dbPut('characters', char);   /* 成功了才移动指针；失败就原样保留，不丢内容 */
    sumBlocked[char.id] = false;
    return true;
  } finally { sumBusy[char.id] = false; }
}
async function runSummary(char, auto) {
  if (!auto) toast('正在总结…');
  try {
    if (await summarizeNow(char, auto, !auto)) {
      toast(settings.memConfirm ? '新摘要已生成，等你在记忆页确认' : (auto ? '已自动整理记忆' : '记忆已整理'));
      if (!settings.memConfirm) await memAutoCompress(char);
    }
    if ($('s-memory').classList.contains('active') && cur && cur.id === char.id) renderMemory();
  } catch (e) {
    if (auto) sumBlocked[char.id] = Date.now();   /* 记下失败时间：10 分钟内不再自动请求，过了再试一次 */
    showError(e, { label: (auto ? '自动总结失败' : '总结失败') + '。点「重试」会再请求 1 次。', retry: function () { sumBlocked[char.id] = false; runSummary(char, false); } });
  }
}
$('b-mem-sum').onclick = function () { runSummary(cur, false); };
async function maybeAutoSummarize(char) {
  try {
    var am = char.autoMemory || {};
    if (!am.enabled || sumBusy[char.id] || (sumBlocked[char.id] && Date.now() - sumBlocked[char.id] < 10 * 60 * 1000)) return;
    var c0 = await sumCandidates(char);
    if (c0.older.length >= c0.P.S) runSummary(char, true);   /* 溢出窗口的原话攒够一个步长，才静默总结 */
  } catch (e) { toast('自动总结检查失败：' + e.message.slice(0, 60)); }
}
/* 精炼 = 手动二次压缩：把现在所有的过往摘要合并成一份，先给你看结果，确认才生效；原条目只是归档 */
$('b-mem-refine').onclick = async function () {
  var ch = cur, picks = memCollect(await memLoad(ch.id)).auto;
  if (picks.length < 2) { toast('过往摘要太少，不需要精炼'); return; }
  var total = memChars(picks);
  var inp = h('input', { type: 'number', value: Math.min(memNum(settings.memStageMax, 1500, 300, 6000), Math.max(300, Math.round(total / 3))), style: 'width:100%;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--bg)' });
  openSheet([h('h3', { text: '精炼记忆' }), h('div', { class: 'hint', style: 'color:var(--sub);font-size:13px;margin-bottom:8px', text: '把现在的 ' + picks.length + ' 条过往摘要（共 ' + total + ' 字）合并成一份。先给你看结果，确认后才生效；原来的几条只是归档，不会删除，可以在合并摘要上点「撤销合并」恢复。目标字数：' }), inp,
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', { class: 'btn primary', text: '开始精炼', onclick: async function () {
        var target = memNum(inp.value, 1500, 100, 8000); closeSheet(); toast('正在精炼…');
        try {
          var out = await memMerge(ch, picks, target);
          textSheet('精炼结果（可编辑）', out, [
            { text: '确认合并', cls: 'primary', fn: async function (v) {
              if (!v.trim()) return; await memCompressApply(ch, picks, v.trim()); if (cur && cur.id === ch.id) renderMemory(); iosAlert('已合并', '已合并成 1 条，原来的 ' + picks.length + ' 条已归档'); } },
            { text: '放弃' }], '确认后，这一条会取代原来的几条带给 TA；原条目归档在记忆页最下面。');
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
    ctx: h('input', { type: 'number', value: c.contextLimit || '', placeholder: '默认 ' + (settings.ctxWindow || 25) }),
    interval: h('input', { type: 'number', value: (c.autoMemory && c.autoMemory.step) || '', placeholder: '默认 ' + (settings.ctxStep || 30) })
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
  body.appendChild(h('div', { class: 'group' }, field('短期窗口：每次带多少条最近的原话（留空用全局）', f.ctx),
    h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '自动总结记忆' }), h('div', { class: 'hint', text: '开启后：未总结的原话攒到「窗口 + 步长」条时，后台静默把最旧的一批并进「前情提要」，并从短期窗口移出（聊天记录本身不删）。' })), auto.el), field('总结步长：溢出多少条总结一次（留空用全局）', f.interval)));
  body.appendChild(h('div', { class: 'group-title', text: '语音' }));
  body.appendChild(h('div', { class: 'group' }, h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '语音自动转文字' }), h('div', { class: 'hint', text: '你发语音时，用浏览器自带的识别实时转成文字（不走 API）；角色的语音气泡也据此直接显示文字。关闭后都先不显示，点气泡里的「转文字」再显示。AI 听你的语音不受这个开关影响。' })), avOn.el)));
  body.appendChild(h('div', { class: 'group' }, h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '允许角色发语音' }), h('div', { class: 'hint', text: '角色偶尔会发语音气泡：说的话直接带在回复里（不额外请求），点语音气泡用「设置 → 语音合成（TTS）」里填的接口合成并播放，合成过的会缓存，重复点不再消耗额度。没配置 TTS 就不能播放。线下模式不会发。' })), aiVoiceOn.el)));
  body.appendChild(h('div', { class: 'group-title', text: '线下模式（小说式长文回复）' }));
  body.appendChild(h('div', { class: 'group' }, h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '开启线下模式' }), h('div', { class: 'hint', text: '开启后角色用小说式长文回复，不拆气泡、不发表情包' })), offOn.el), offBox));
  var pinOn = switchEl(!!c.pinned, function () {});
  body.appendChild(h('div', { class: 'group' }, h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '置顶' }), h('div', { class: 'hint', text: '在聊天列表里排在最上面（列表里长按这个角色也能置顶）' })), pinOn.el)));
  body.appendChild(h('div', { class: 'group-title', text: '时间感知' }));
  var taOn = switchEl(c.timeAware !== false, function () {});
  var tzSel = h('select', {}); [['', '跟随我的设备'], ['Asia/Shanghai', '北京时间 UTC+8'], ['Asia/Tokyo', '东京 UTC+9'], ['Asia/Seoul', '首尔 UTC+9'], ['Asia/Singapore', '新加坡 UTC+8'], ['Europe/London', '伦敦'], ['Europe/Paris', '巴黎'], ['America/New_York', '纽约'], ['America/Los_Angeles', '洛杉矶'], ['Australia/Sydney', '悉尼']].forEach(function (o) { tzSel.appendChild(h('option', { value: o[0], text: o[1] })); });
  tzSel.value = c.timeZone || '';
  body.appendChild(h('div', { class: 'group' },
    h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '让角色感知时间' }), h('div', { class: 'hint', text: '开启后 TA 知道现在几点、星期几，以及距离上次聊天隔了多久（隔太久会自然问候）；不会多请求，只多几行提示词' })), taOn.el),
    field('TA 所在时区', tzSel)));
  body.appendChild(h('div', { class: 'group-title', text: '心声（点聊天里角色的头像查看）' }));
  body.appendChild(h('div', { class: 'group' },
    h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '每次回复都更新心声' }), h('div', { class: 'hint', text: '心声跟着 TA 的回复一起生成，不会多发一次请求；只是每次回复末尾多一小段' })), thAuto.el),
    h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '让角色知道自己的心声' }), h('div', { class: 'hint', text: '把最新心声放进提示词，言行会更一致，但会多花一点 token' })), thInject.el)));
  var moOn = switchEl(c.momentsOn === true);
  body.appendChild(h('div', { class: 'group-title', text: '朋友圈' }));
  body.appendChild(h('div', { class: 'group' },
    h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '让 TA 参与朋友圈' }), h('div', { class: 'hint', text: '开启后，TA 每次回复你时会顺带看一眼朋友圈，可能发动态、点赞、评论你的动态；全部并进同一次请求，不会多发请求，只是提示词多一小段（最近 6 条动态）' })), moOn.el)));
  var wOn = switchEl(c.watchOn === true);
  body.appendChild(h('div', { class: 'group-title', text: '看手机' }));
  body.appendChild(h('div', { class: 'group' },
    h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '让 TA 看我的手机' }), h('div', { class: 'hint', text: '需要 APK 里的无障碍服务。打开后，每次回复你时顺手带上你这段时间的手机使用摘要（几百字），不多发请求。详情见桌面「看手机」' })), wOn.el)));
  var peOn = switchEl(c.periodOn === true);
  body.appendChild(h('div', { class: 'group-title', text: '经期' }));
  body.appendChild(h('div', { class: 'group' },
    h('div', { class: 'field inline' }, h('div', {}, h('label', { text: '让 TA 知道我的经期' }), h('div', { class: 'hint', text: '打开后提示词里多一句你现在处于哪个阶段（来自桌面「经期」的记录），TA 会更体贴；不多发请求' })), peOn.el)));
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
      try { await dbDel('playlists', 'pl-' + c.id); } catch (e) {} if (mu.together === c.id) muUnbind();
      var all = await pageMessages(c.id, null, 1e9), moAll = await dbAll('moments'), tx = db.transaction(['messages', 'memories', 'characters', 'moments'], 'readwrite');
      all.forEach(function (m) { tx.objectStore('messages').delete(m.id); });
      (await dbByIndex('memories', 'byChar', c.id)).forEach(function (m) { tx.objectStore('memories').delete(m.id); });
      moAll.forEach(function (m) {   /* TA 发的动态删掉；TA 在别人动态下的赞和评论也拿掉 */
        if (m.authorId === c.id) { tx.objectStore('moments').delete(m.id); return; }
        var n1 = (m.likes || []).length, n2 = (m.comments || []).length;
        m.likes = (m.likes || []).filter(function (x) { return x !== c.id; });
        m.comments = (m.comments || []).filter(function (x) { return x.authorId !== c.id; });
        if (m.likes.length !== n1 || m.comments.length !== n2) { m.seen = {}; tx.objectStore('moments').put(m); }
      });
      tx.objectStore('characters').delete(c.id);
      await new Promise(function (r) { tx.oncomplete = r; });
      editing = null; nav = ['s-home', 's-list']; activate('s-list'); syncHist(); iosAlert('已删除', '角色已删除');
    }, true);
  } })));
  editing._collect = function () {
    c.name = f.name.value.trim() || '未命名'; c.realName = f.realName.value.trim() || c.name;
    c.userNickname = f.userNickname.value.trim(); c.persona = f.persona.value; c.userPersona = f.userPersona.value;
    c.contextLimit = Number(f.ctx.value) > 0 ? Number(f.ctx.value) : null;
    c.autoMemory = { enabled: auto.input.checked, interval: (c.autoMemory && c.autoMemory.interval) || 20, step: Number(f.interval.value) > 0 ? Number(f.interval.value) : null };
    c.worldBookIds = wbPick.get();
    var on = stPick.get();
    c.stickerCategoryIds = (!stOpts.length || on.length === stOpts.length) ? null : on;
    c.avatar = av.avatar; c.userAvatar = av.userAvatar;
    c.autoThought = { enabled: thAuto.input.checked }; c.momentsOn = moOn.input.checked; c.periodOn = peOn.input.checked; c.watchOn = wOn.input.checked;
    c.pinned = pinOn.input.checked; c.timeAware = taOn.input.checked; c.timeZone = tzSel.value || '';
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
/* 原图：不经过 canvas，直接读成 dataURL，画质不损失 */
function pickOriginal(cb) {
  var f = h('input', { type: 'file', accept: 'image/*' });
  f.addEventListener('change', function () {
    var file = f.files[0]; if (!file) return;
    var r = new FileReader();
    r.onload = function () { if (file.size > 8 * 1024 * 1024) toast('原图 ' + (file.size / 1048576).toFixed(1) + 'MB，较大，已照原样保存'); cb(String(r.result)); };
    r.onerror = function () { toast('读取图片失败'); };
    r.readAsDataURL(file);
  });
  f.click();
}
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
    if (p.trim) host.appendChild(h('div', { class: 'bt-hint', style: 'color:' + (p.trim.over ? '#c0392b' : 'var(--sub)'), text: '总 token 控制已开（上限约 ' + p.trim.budget + ' 输入 token）：' + ((p.trim.mem || p.trim.rows) ? '这次裁掉了 ' + p.trim.mem + ' 条最早的过往摘要、' + p.trim.rows + ' 行最早的聊天记录。' : '没有超出，什么都没裁。') + (p.trim.over ? '裁到底了仍然超出，请调大上限或精简角色设定。' : '') }));
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
    host.appendChild(h('div', { class: 'bt-hint', text: '这是发给模型的输入部分，不含它的回复。按中文约 1.3 token/字估算，实际以你的模型分词为准。想降低就缩小「短期窗口」、点记忆页的「精炼」，或在设置里开「控制发给模型的总 token」。' }));
    host.appendChild(h('button', { class: 'btn', style: 'margin-top:8px', text: '重新计算', onclick: function () { renderTokenCard(host); } }));
  } catch (e) { info.textContent = '计算失败：' + e.message; }
}
onShow['s-chatset'] = function () {
  if (!cur) { back(); return; }
  var body = $('chatset-body'); body.innerHTML = '';
  var tokHost = h('div', { class: 'glass' }); body.appendChild(tokHost); renderTokenCard(tokHost);
  var prev = h('div', { class: 'bg-prev', text: cur.chatBg ? '' : '未设置背景' });
  if (cur.chatBg) prev.style.backgroundImage = 'url("' + cur.chatBg + '")';
  var bgUrl = h('input', { type: 'text', placeholder: 'https://… 图片网址', style: 'flex:1;min-width:0;border:1px solid var(--line);border-radius:8px;padding:8px;background:transparent;color:inherit' });
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '聊天背景（只对「' + cur.name + '」生效）' }), prev,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '上传原图（不压缩）', onclick: function () { pickOriginal(async function (d) { cur.chatBg = d; await saveCur(); applyChatLook(); onShow['s-chatset'](); }); } }),
      h('button', { class: 'btn', text: '上传（压缩省空间）', onclick: function () { pickImage(1920, 0.92, async function (d) { cur.chatBg = d; await saveCur(); applyChatLook(); onShow['s-chatset'](); }); } }),
      h('button', { class: 'btn', text: '清除', onclick: async function () { cur.chatBg = ''; await saveCur(); applyChatLook(); onShow['s-chatset'](); } })),
    h('div', { class: 'btn-row', style: 'margin-top:8px;align-items:center' }, bgUrl,
      h('button', { class: 'btn', text: '使用网址', onclick: async function () {
        var u = bgUrl.value.trim(); if (!/^https?:\/\//i.test(u)) { toast('请填 http(s):// 开头的图片网址'); return; }
        cur.chatBg = u; await saveCur(); applyChatLook(); onShow['s-chatset']();
      } })),
    h('div', { class: 'hint', style: 'margin-top:6px', text: '原图不压缩，画质不会变差；图很大（超过约 8MB）会占不少存储。网址方式几乎不占存储，但图床失效背景就没了。' })));
  /* 自动翻译：译文显示在对方每条消息的气泡下面一行；走免费翻译，不消耗你的 AI 请求 */
  var tcfg = cur.translate || { on: false, from: 'auto', to: 'zh-CN' };
  function langSel(withAuto, val, on) {
    var sel = h('select', {}); if (withAuto) sel.appendChild(h('option', { value: 'auto', text: '自动识别' }));
    TR_LANGS.forEach(function (l) { sel.appendChild(h('option', { value: l[0], text: l[1] })); });
    sel.value = val; sel.onchange = function () { on(sel.value); }; return sel;
  }
  async function saveTr() { cur.translate = tcfg; await saveCur(); reloadChat(); }
  var trSw = switchEl(tcfg.on, function (v) { tcfg.on = v; saveTr(); });
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '自动翻译（不走你的 AI 请求）' }),
    h('div', { class: 'field inline' }, h('label', { text: '开启' }), trSw.el),
    field('对方说的语言', langSel(true, tcfg.from || 'auto', function (v) { tcfg.from = v; saveTr(); })),
    field('翻译成', langSel(false, tcfg.to || 'zh-CN', function (v) { tcfg.to = v; saveTr(); })),
    h('div', { class: 'bt-hint', text: '例：对方说「English」→ 翻译成「中文」：对方发英文时，气泡下面多一行中文；发中文就不翻。反过来选「中文 → English」，对方发中文时下面显示英文。用浏览器自带翻译 / Google / MyMemory 三个免费来源，哪个能用就用哪个；译文存在本地，不会重复请求。' })));
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
      h('button', { class: 'btn primary', text: '应用并保存', onclick: async function () { cur.bubbleCss = ta.value; await saveCur(); applyChatLook(); iosAlert('已保存', '气泡样式已应用并保存'); } }),
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
  }
    css += ':root{--hm-clock-dy:' + (Number(settings.clockDy) || 0) + 'px;--hm-date-dy:' + (Number(settings.dateDy) || 0) + 'px;--hm-wx-dy:' + (Number(settings.wxDy) || 0) + 'px;' +
    '--hm-clock-dx:' + (Number(settings.clockDx) || 0) + 'px;--hm-date-dx:' + (Number(settings.dateDx) || 0) + 'px;--hm-wx-dx:' + (Number(settings.wxDx) || 0) + 'px;' +
    (settings.clockColor ? '--hm-clock-color:' + settings.clockColor + ';' : '') + (settings.dateColor ? '--hm-date-color:' + settings.dateColor + ';' : '') + (settings.wxColor ? '--hm-wx-color:' + settings.wxColor + ';' : '') + '}\n';
  try { $('s-home').setAttribute('data-cl', settings.clockLayout === 'v' ? 'v' : 'h'); } catch (e) {}
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
var BEAUTY_KEYS = ['clockLayout', 'clockColor', 'dateColor', 'wxColor', 'clockDy', 'dateDy', 'wxDy', 'clockDx', 'dateDx', 'wxDx', 'themeId', 'customCss', 'homeBg', 'fontUrl', 'fontData', 'fontName', 'notifyUrl', 'notifyName', 'iconUrls'];function cloneJ(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
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
    nameSheet('预设名称', '', async function (nm) { await dbPut('beautyPresets', Object.assign({ id: uid('bp'), name: nm, ts: Date.now() }, beautySnapshot())); fillBeautyPresets(box); iosAlert('已保存', '美化预设「' + nm + '」已保存'); }, '例如：夜间粉 / 极简白');
  } })));
}
onShow['s-beauty'] = function () {
  var body = $('beauty-body'); body.innerHTML = '';
  var prev = h('div', { class: 'glass' }, h('h4', { text: '预览' }), h('div', { class: 'bt-prev' },
    h('div', { class: 'row' }, avatarNode(null, '她'), h('div', { class: 'bubble', text: '今天有点冷，你出门穿厚点。' })),
    h('div', { class: 'row me' }, h('div', { class: 'bubble', text: '好～知道啦' })),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', text: '主按钮' }), h('button', { class: 'btn', text: '次按钮' }))));
  body.appendChild(prev);
  var lsel = h('select', {}); UI_LANGS.forEach(function (l) { lsel.appendChild(h('option', { value: l[0], text: l[1] })); }); lsel.value = uiLang;
  lsel.onchange = function () { switchUiLang(lsel.value); };
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '界面语言' }), field('系统语言', lsel),
    h('div', { class: 'bt-hint', text: '切换时会用免费翻译把界面文字翻成所选语言（不走你的 AI），存在本机，之后离线也能用；切回「简体中文」随时恢复。只翻界面固定文字，聊天内容、角色名、世界书都是你自己写的，不会被翻。部分带数字的提示语可能仍是中文。' })));
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
  var clk = h('div', { class: 'glass' }, h('h4', { text: '桌面时钟 / 文字' }));
  var lay = h('div', { class: 'seg' });
  [['h', '横排（时钟左、日期右）'], ['v', '竖排（上下叠放）']].forEach(function (o) {
    lay.appendChild(h('button', { type: 'button', class: 'seg-b' + ((settings.clockLayout || 'h') === o[0] ? ' on' : ''), text: o[1], onclick: async function () { settings.clockLayout = o[0]; await saveSettings(); applyTheme(); onShow['s-beauty'](); } }));
  });
  clk.appendChild(field('排版', lay));
  function colorRow(label, key) {
    var row = h('div', { class: 'swatches' }), cur = settings[key] || '';
    [['', '默认'], ['#ffffff', '白'], ['#000000', '黑']].forEach(function (o) {
      row.appendChild(h('button', { type: 'button', class: 'swb' + (cur === o[0] ? ' on' : ''), text: o[1], onclick: async function () { settings[key] = o[0]; await saveSettings(); applyTheme(); onShow['s-beauty'](); } }));
    });
    var ci = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#888888' });
    ci.addEventListener('change', async function () { settings[key] = ci.value; await saveSettings(); applyTheme(); onShow['s-beauty'](); });
    row.appendChild(h('label', { class: 'swb' + (cur && ['#ffffff', '#000000'].indexOf(cur.toLowerCase()) < 0 ? ' on' : '') }, '自定义', ci));
    return field(label, row);
  }
  function dyRow(label, key) {
    var v = h('span', { class: 'val', text: (Number(settings[key]) || 0) + 'px' });
    var r = h('input', { type: 'range', min: '-60', max: '160', step: '1', value: String(Number(settings[key]) || 0) });
    r.addEventListener('input', function () { settings[key] = Number(r.value); v.textContent = r.value + 'px'; applyTheme(); });
    r.addEventListener('change', function () { saveSettings(); });
    return field(label, h('div', { class: 'rng' }, r, v));
  }
    function dxRow(label, key) {
    var v = h('span', { class: 'val', text: (Number(settings[key]) || 0) + 'px' });
    var r = h('input', { type: 'range', min: '-200', max: '200', step: '1', value: String(Number(settings[key]) || 0) });
    r.addEventListener('input', function () {
      settings[key] = Number(r.value);
      v.textContent = r.value + 'px';
      applyTheme();
    });
    r.addEventListener('change', function () { saveSettings(); });
    return field(label, h('div', { class: 'rng' }, r, v));
  }
  clk.appendChild(colorRow('时钟颜色', 'clockColor')); clk.appendChild(colorRow('日期颜色', 'dateColor')); clk.appendChild(colorRow('天气颜色', 'wxColor'));
  clk.appendChild(dyRow('时钟 上下位置', 'clockDy')); clk.appendChild(dyRow('日期 上下位置', 'dateDy')); clk.appendChild(dyRow('天气 上下位置', 'wxDy'));
  clk.appendChild(dxRow('时钟 左右位置', 'clockDx'));
  clk.appendChild(dxRow('日期 左右位置', 'dateDx'));
  clk.appendChild(dxRow('天气 左右位置', 'wxDx'));
  clk.appendChild(h('div', { class: 'bt-hint', text: '三处的颜色、上下及左右位置各自独立，互不影响；桌面文字自带一层很淡的投影，换什么壁纸都看得清。' }));
  body.appendChild(clk);
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
      h('button', { class: 'btn primary', text: '应用并保存', onclick: async function () { settings.customCss = ta.value; await saveSettings(); applyTheme(); iosAlert('已保存', '自定义 CSS 已应用并保存'); } }),
      h('button', { class: 'btn', text: '清空', onclick: async function () { ta.value = ''; settings.customCss = ''; await saveSettings(); applyTheme(); iosAlert('已清空', '自定义 CSS 已清空'); } })),
    h('div', { class: 'bt-hint', text: '写在这里的 CSS 会盖在上面的方案之上。\n可用变量：--bg --card --ink --sub --line --accent --me --them\n常用选择器：.bubble 气泡、.row.me 我的消息、.bar 顶栏、.app .tile 桌面图标、.glass 磨砂卡片' })));
};

/* ---------- 设置页 ---------- */
var draft = null, settingsDirty = false;
function markDirty() { settingsDirty = true; }
async function commitSettings() {
  settings = JSON.parse(JSON.stringify(draft)); await saveSettings(); settingsDirty = false;
}
/* 主 API 预设只管主 API；副 API 有自己独立的一套预设（SEC_PRESET_KEYS）——切主预设不会再动副 API 的地址 / Key / 模型 */
var PRESET_KEYS = ['baseUrl', 'apiKey', 'model', 'temperature', 'stream'];
var SEC_PRESET_KEYS = ['secBaseUrl', 'secApiKey', 'secModel'];
var MAIN_PRESET_CFG = { listKey: 'apiPresets', activeKey: 'activePresetId', keys: PRESET_KEYS, idPre: 'api', title: '配置预设（一键切换渠道）', label: '当前预设',
  hint: '预设包含：反代地址、Key、模型、温度、流式开关。副 API 有自己独立的预设，切换这里不会动副 API。修改下面的内容后，要点「更新」才会存进预设。改完后点右上角「保存」才会生效。' };
var SEC_PRESET_CFG = { listKey: 'secApiPresets', activeKey: 'activeSecPresetId', keys: SEC_PRESET_KEYS, idPre: 'sapi', title: '副 API 预设（一键切换）', label: '当前副 API 预设',
  hint: '预设包含：副 API 的反代地址、Key、模型，和主 API 的预设互不影响。修改下面的内容后，要点「更新」才会存进预设。改完后点右上角「保存」才会生效。' };
function nameSheet(title, init, cb, ph) {
  var inp = h('input', { type: 'text', value: init || '', placeholder: ph || '例如：官方直连 / 备用反代', style: 'width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);margin-bottom:10px' });
  openSheet([h('h3', { text: title }), inp, h('div', { class: 'btn-row' },
    h('button', { class: 'btn primary', text: '保存', onclick: function () { var v = inp.value.trim(); if (!v) { toast('请输入名称'); return; } closeSheet(); cb(v); } }),
    h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
  setTimeout(function () { inp.focus(); }, 50);
}
function presetGroup(cfg) {
  cfg = cfg || MAIN_PRESET_CFG;
  if (!draft[cfg.listKey]) draft[cfg.listKey] = [];
  var list = draft[cfg.listKey], active = list.find(function (p) { return p.id === draft[cfg.activeKey]; });
  var sel = h('select', {}, h('option', { value: '', text: '（未使用预设）' }));
  list.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: p.name })); });
  sel.value = active ? active.id : '';
  sel.onchange = async function () {
    var p = list.find(function (x) { return x.id === sel.value; });
    draft[cfg.activeKey] = p ? p.id : null;
    if (p) cfg.keys.forEach(function (k) { draft[k] = p[k] !== undefined ? p[k] : DEFAULTS[k]; });
    markDirty(); buildSettings(); toast(p ? '已切换到「' + p.name + '」' : '已取消预设');
  };
  function snapshot() { var o = {}; cfg.keys.forEach(function (k) { o[k] = draft[k]; }); return o; }
  var row = h('div', { class: 'btn-row', style: 'margin:8px 0 14px' },
    h('button', { class: 'btn', text: '另存为新预设', onclick: function () {
      nameSheet('预设名称', '', async function (name) {
        var p = Object.assign({ id: uid(cfg.idPre), name: name }, snapshot());
        list.push(p); draft[cfg.activeKey] = p.id; markDirty(); buildSettings(); toast('已加入预设，记得点右上角「保存」');
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
        list.splice(list.indexOf(active), 1); draft[cfg.activeKey] = null; markDirty(); buildSettings();
      }, true);
    } }) : null);
  return [h('div', { class: 'group-title', text: cfg.title }), h('div', { class: 'group' }, field(cfg.label, sel, cfg.hint)), row];
}
/* ---- TTS 预设：TTS 配置本来就存在浏览器本地（改完即生效，不走右上角「保存」），预设也一样，单独存一份 ---- */
function ttsPresets() {
  var o = {}; try { o = JSON.parse(localStorage.getItem('mp_tts_presets') || '{}') || {}; } catch (e) {}
  return { list: Array.isArray(o.list) ? o.list : [], active: o.active || null };
}
function ttsPresetsSave(o) { try { localStorage.setItem('mp_tts_presets', JSON.stringify(o)); } catch (e) { toast('保存失败：浏览器不让写本地存储'); } }
function ttsPresetGroup() {
  var pr = ttsPresets(), list = pr.list, active = list.find(function (p) { return p.id === pr.active; });
  var sel = h('select', {}, h('option', { value: '', text: '（未使用预设）' }));
  list.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: p.name })); });
  sel.value = active ? active.id : '';
  sel.onchange = function () {
    var p = list.find(function (x) { return x.id === sel.value; });
    pr.active = p ? p.id : null; ttsPresetsSave(pr);
    if (p) ttsSave({ url: p.url || '', key: p.key || '', voice: p.voice || '', model: p.model || 'tts-1' });
    buildSettings(); toast(p ? '已切换到「' + p.name + '」' : '已取消预设');
  };
  function snapshot() { var c = ttsCfg(); return { url: c.url, key: c.key, voice: c.voice, model: c.model }; }
  var row = h('div', { class: 'btn-row', style: 'margin:8px 0 14px' },
    h('button', { class: 'btn', text: '另存为新预设', onclick: function () {
      nameSheet('预设名称', '', async function (name) {
        var p = Object.assign({ id: uid('tts'), name: name }, snapshot());
        list.push(p); pr.active = p.id; ttsPresetsSave(pr); buildSettings(); toast('已存为预设「' + name + '」');
      }, '例如：女声 / 备用接口');
    } }),
    active ? h('button', { class: 'btn', text: '更新「' + active.name + '」', onclick: function () {
      Object.assign(active, snapshot()); ttsPresetsSave(pr); toast('已更新「' + active.name + '」');
    } }) : null,
    active ? h('button', { class: 'btn', text: '重命名', onclick: function () {
      nameSheet('重命名', active.name, async function (name) { active.name = name; ttsPresetsSave(pr); buildSettings(); }, '预设名称');
    } }) : null,
    active ? h('button', { class: 'btn danger', text: '删除', onclick: function () {
      confirmSheet('删除预设「' + active.name + '」？当前填写的内容不会被清空。', '删除', async function () {
        list.splice(list.indexOf(active), 1); pr.active = null; ttsPresetsSave(pr); buildSettings();
      }, true);
    } }) : null);
  return [h('div', { class: 'group-title', text: 'TTS 预设（一键切换）' }), h('div', { class: 'group' }, field('当前 TTS 预设', sel,
    '预设包含：接口地址、密钥、音色 ID、模型名称。TTS 的设置不走右上角「保存」：切换、另存、更新都是立刻生效。修改下面的内容后，要点「更新」才会存进预设。')), row];
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
  openBottomSheet([h('h3', { text: '选择模型' }), q, list, info, h('div', { class: 'btn-row', style: 'margin-top:8px' }, pull, h('button', { type: 'button', class: 'btn', text: '关闭', onclick: closeSheet }))]);
  render();
}
/* TTS、副 API 两张卡片挪到「主 API」卡片下面、「输出方式」上面 */
function buildSettings() {
  buildSettingsBase();
  var body = $('settings-body'), kids = Array.prototype.slice.call(body.children);
  function titleIdx(txt) { return kids.findIndex(function (n) { return n.classList.contains('group-title') && n.textContent.indexOf(txt) === 0; }); }
  function pair(txt) { var i = titleIdx(txt); return i < 0 ? null : [kids[i], kids[i + 1]]; }
  var main = pair('主 API');
  /* 副 API、TTS 各是一整块：「预设」标题 + 卡片 + 按钮行，再接本体标题 + 卡片，一起挪。顺序：主预设 → 主 API → 副预设 → 副 API → TTS 预设 → TTS */
  var si = titleIdx('副 API 预设'), subIdx = titleIdx('副 API（'), ti = titleIdx('TTS 预设'), ttsIdx = titleIdx('语音合成');
  if (!main || si < 0 || subIdx < 0 || ti < 0 || ttsIdx < 0) return;
  var sub = kids.slice(si, subIdx + 2), tts = kids.slice(ti, ttsIdx + 2);
  var ref = main[1].nextSibling;
  sub.concat(tts).forEach(function (n) { body.insertBefore(n, ref); });
}
function buildSettingsBase() {
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
    sw('showTime', '显示消息时间', '每条气泡下面显示几点几分。'),
    sw('autoStripFormat', '自动去格式（免正则）', '开启后自动清除 AI 回复里的 Markdown 符号（**、### 等）和多余 HTML/XML 标签，新旧消息都生效；不影响心声、状态、朋友圈、表情包和语音。'),
    sw('enterSend', '回车发送消息', '开启后按 Enter 直接发送，Shift+Enter 换行（电脑键盘）。关闭时 Enter 是换行，Ctrl+Enter 发送。手机输入法的回车键不受影响。'),
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
  var tc = ttsCfg();
  function ttsF(key, label, ph, type, hint) {
    var i = h('input', { type: type || 'text', placeholder: ph, value: key === 'model' ? tc.model : tc[key], autocomplete: 'off' });
    i.addEventListener('change', function () { tc[key] = i.value.trim(); ttsSave(tc); });
    return field(label, i, hint);
  }
  ttsPresetGroup().forEach(function (n) { body.appendChild(n); });
  body.appendChild(h('div', { class: 'group-title', text: '语音合成（TTS，兼容 OpenAI 格式；AI 发语音条时用）' }));
  body.appendChild(h('div', { class: 'group' },
    ttsF('url', 'TTS 接口地址', 'https://你的接口域名', 'text', '末尾没写 /v1/audio/speech 会自动补上。只存在这台设备的浏览器里'),
    ttsF('key', 'TTS 密钥（API Key）', 'sk-…', 'password'),
    ttsF('voice', '音色 ID（Voice ID）', '填服务商给的音色 ID', 'text'),
    ttsF('model', '模型名称', 'tts-1', 'text', '留空则用 tts-1。输入框改完点别处就自动保存，不用点右上角「保存」')));
  presetGroup(SEC_PRESET_CFG).forEach(function (n) { body.appendChild(n); });
  body.appendChild(h('div', { class: 'group-title', text: '副 API（总结、精炼记忆；留空则用主 API）' }));
  body.appendChild(h('div', { class: 'group' },
    txt('secBaseUrl', '反代地址', 'text', '留空使用主 API'), txt('secApiKey', 'API Key', 'password', '可选'), modelField('模型', 'secModel', 'secBaseUrl', 'secApiKey', '建议用便宜的小模型')));

  body.appendChild(h('div', { class: 'group-title', text: '记忆与总结（自动总结会在后台单独发请求，用「副 API」；没填副 API 就用主 API）' }));
  body.appendChild(h('div', { class: 'group' },
    txt('segMax', '每段摘要的字数上限', 'number', '300', '每次总结写出的「本段摘要」最多多少字。按次计费可以放宽到 400–600，细节更多'),
    txt('profileMax', '固定信息的字数上限', 'number', '800', '称呼、生日、喜好、忌口、约定这类长期有效的事实，每次总结时更新，永远不被压缩'),
    txt('memCompressAt', '过往摘要攒到多少字就自动合并', 'number', '6000', '所有分段摘要加起来超过这个字数，就把最早的几条合并成 1 条（多发 1 次请求）。原来的几条只是归档，不删，可以在记忆页撤销合并'),
    txt('memStageMax', '合并后的摘要字数上限', 'number', '1500'),
    sw('memAutoCompress', '超过字数自动合并旧摘要', '关掉后摘要只增不减，需要时自己点记忆页的「精炼」'),
    sw('memConfirm', '总结后先让我确认', '开启后，新生成的摘要先放进记忆页的「待确认」，你点确认才会带给角色；确认前不会影响聊天。默认关'),
    txt('memTemp', '总结的温度', 'number', '0.2', '越低越只写事实、越不爱发挥。建议 0–0.3'),
    txt('sumWords', '总结脱敏：额外敏感词', 'text', '用逗号分隔', '发给总结模型之前，这些词会被替换成「亲密互动」。程序里已内置一份常见词表，这里补你自己遇到过被拦的词'),
    txt('sumRetry', '被拒答后自动重试次数', 'number', '2', '总结被模型拒绝时，会加强脱敏后自动重发（间隔 2 秒），最多重试这么多次。0 = 不重试。每次重试多花 1 次请求')));
  body.appendChild(h('div', { class: 'group-title', text: '回复长度与总 token' }));
  body.appendChild(h('div', { class: 'group' },
    txt('maxOutTokens', '单次回复最大 token（max_tokens）', 'number', '留空或 0＝不限制', '回复总被截断（说到一半没了）就填一个大一点的数，如 2000–4000。留空则不发这个参数，由模型/中转自己的默认值决定。Gemini 这类会「思考」的模型，思考也算在里面，建议 4000 以上'),
    sw('tokBudgetOn', '控制发给模型的总 token', '默认关。开启后，发送前估算 系统提示 + 记忆 + 聊天记录，超过下面的上限就先少带最早的过往摘要，再减最早的聊天记录（至少留 10 条），角色设定和最新的消息不动。你按次计费的话不需要开'),
    txt('tokBudget', '总 token 上限（含回复空间）', 'number', '60000', '上限里会先扣掉「单次回复最大 token」，再给输入。「提示词占用」卡片会显示裁掉了什么')));
  body.appendChild(h('div', { class: 'group-title', text: '上下文' }));
  body.appendChild(h('div', { class: 'group' },
    txt('ctxWindow', '短期窗口：每次带多少行最近的原话', 'number', '25', '一条气泡算一行（AI 一次回复拆成几条就是几行）。角色设置里可以单独覆盖'),
    txt('ctxStep', '总结步长：原话溢出窗口多少行就总结一次', 'number', '30', '角色开了「自动总结记忆」才生效：窗口之外的原话攒够这么多行，就在后台单独发 1 次请求总结，总结过的原话不再带进聊天记录。建议 30–50'),
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
      iosAlert('导入完成', '已导入 ' + books.length + ' 本世界书，共 ' + books.reduce(function (n, b) { return n + b.entries.length; }, 0) + ' 条'); renderWbList();
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
/* 书卡：一行 4 本、悬浮的小书，封面就是名字 */
var BOOK_HUES = [18, 32, 150, 190, 215, 265, 330, 350, 85, 170];
function bookGrid(items, onOpen) {
  var g = h('div', { class: 'books' });
  items.forEach(function (it, i) {
    var hue = BOOK_HUES[Math.abs(String(it.name || '').split('').reduce(function (a, ch) { return (a * 31 + ch.charCodeAt(0)) | 0; }, i)) % BOOK_HUES.length];
    var bk = h('button', { type: 'button', class: 'book', onclick: function () { onOpen(it); } },
      h('span', { class: 'bk-spine' }), h('span', { class: 'bk-name', text: it.name || '未命名' }), it.sub ? h('span', { class: 'bk-sub', text: it.sub }) : null);
    bk.style.setProperty('--bh', hue); g.appendChild(bk);
  });
  return g;
}
async function renderMemBooks() {
  var list = await dbAll('characters'), body = $('membooks-body'); body.innerHTML = '';
  if (!list.length) { body.appendChild(h('div', { class: 'empty', text: '还没有角色，先去聊天里新建一个' })); return; }
  var counts = {};
  for (var i = 0; i < list.length; i++) { var cc = memCollect(await dbByIndex('memories', 'byChar', list[i].id)); counts[list[i].id] = cc.manual.length + cc.auto.length + cc.pending.length + (cc.profile ? 1 : 0); }
  body.appendChild(bookGrid(list.map(function (c) { return { id: c.id, name: c.name, sub: counts[c.id] + ' 条', c: c }; }), function (it) { cur = it.c; go('s-memory'); }));
}
onShow['s-membooks'] = renderMemBooks;
async function renderWbList() {
  var books = await dbAll('worldBooks'), body = $('wblist-body'); body.innerHTML = '';
  body.appendChild(h('div', { class: 'btn-row', style: 'margin-bottom:10px' }, h('button', { class: 'btn', text: '导入（json / txt / Word）', onclick: importWorldBooks }), h('button', { class: 'btn', text: '导出', onclick: exportWorldBooks })));
  if (!books.length) { body.appendChild(h('div', { class: 'empty', text: '还没有世界书。点右上角新建。\n关键词留空的条目会一直带入；填了关键词的条目，聊天里出现关键词才带入。' })); body.firstChild.style.whiteSpace = 'pre-line'; return; }
  body.appendChild(bookGrid(books.map(function (b) { return { id: b.id, name: b.name, sub: (b.entries || []).length + ' 条' }; }), function (it) { editWb(it.id); }));
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
  return list.map(function (p) {
    var body = [p.content || ''].concat((p.entries || []).filter(function (e) { return e && e.content && e.enabled !== false; }).map(function (e) { return (e.title ? '【' + e.title + '】\n' : '') + e.content; })).filter(function (x) { return String(x).trim(); }).join('\n\n');
    return '# ' + (p.name || '未命名') + '\n\n' + body;
  }).join('\n\n\n');
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
  /* 尽量宽松地读：myphone 备份 / 世界书格式 / 酒馆(SillyTavern)预设与世界信息 / 普通 name+content 数组 */
  function entOf(x) {
    if (!x || typeof x !== 'object') return null;
    var content = x.content != null ? x.content : (x.text != null ? x.text : (x.prompt != null ? x.prompt : x.value));
    if (content == null || !String(content).trim()) return null;
    var keys = x.keys || x.key || x.keywords || x.triggers || x.primary_keys || [];
    if (typeof keys === 'string') keys = keys.split(/[,，、;；\n]/);
    keys = (Array.isArray(keys) ? keys : []).map(function (k) { return String(k).trim(); }).filter(Boolean);
    var en = x.enabled !== false && x.disable !== true && x.disabled !== true;
    return { title: String(x.title || x.comment || x.name || x.identifier || x.label || '').trim(), keys: keys, content: String(content).trim(), enabled: en };
  }
  function listOf(v) { return Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.keys(v).map(function (k) { return v[k]; }) : []); }
  function containers(d) {
    if (!d || typeof d !== 'object') return [];
    if (Array.isArray(d)) {
      if (d.length && d.every(function (x) { return x && typeof x === 'object' && (x.entries || x.prompts); })) return d;
      var hasKeys = d.some(function (x) { return x && (x.keys || x.key || x.keywords || x.triggers); });
      if (!hasKeys) return d.map(function (x) { return x && { name: x.name || x.title || x.comment, content: x.content != null ? x.content : (x.prompt != null ? x.prompt : x.text) }; }).filter(Boolean);
      return [{ entries: d }];
    }
    if (d.offlinePresets) return listOf(d.offlinePresets);
    if (d.worldBooks) return listOf(d.worldBooks);
    if (d.entries || d.prompts) return [d];
    if (d.data && (d.data.entries || d.data.prompts)) return [d.data];
    if (d.character_book && d.character_book.entries) return [d.character_book];
    if (entOf(d)) return [{ name: d.name, entries: [d] }];
    return [];
  }
  var out = [];
  containers(data).forEach(function (c, ci) {
    var nm = String(c.name || c.title || (c.entries || c.prompts ? '' : '') || '').trim() || (ci ? defName + (ci + 1) : defName);
    var ents = listOf(c.entries || c.prompts).map(entOf).filter(Boolean);
    var base = c.content != null ? String(c.content).trim() : '';
    if (!ents.length && !base) return;
    /* 只有「名称+内容」的普通预设：直接当预设；有条目的：整套保留条目和关键词 */
    var simple = !c.entries && !c.prompts;
    out.push(simple ? { name: nm, content: base } : { name: nm, content: base, entries: ents });
  });
  if (!out.length) throw new Error('JSON 里没找到可用的预设内容。\n顶层字段：' + (data && typeof data === 'object' ? Object.keys(data).slice(0, 12).join('、') || '（空）' : typeof data) + '\n需要含 entries / prompts / offlinePresets，或带 name+content 的数组。');
  return out;
}
async function importPresets() {
  var f = h('input', { type: 'file', accept: '.json,.txt,.docx,.md,text/plain,application/json' });
  f.addEventListener('change', async function () {
    var file = f.files[0]; if (!file) return;
    try {
      var base = file.name.replace(/\.[^.]+$/, ''), ext = ((file.name.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase(), list;
      if (ext === 'json') list = normalizePresetJson(JSON.parse((await file.text()).replace(/^\uFEFF/, '')), base);
      else if (ext === 'docx') list = parsePresetText(await readDocxText(await file.arrayBuffer()), base);
      else if (ext === 'doc') throw new Error('旧版 .doc 读不了，请在 Word 里另存为 .docx 或 .txt');
      else list = parsePresetText(await file.text(), base);
      if (!list.length) throw new Error('没有读到任何预设内容');
      list = list.filter(function (x) { return x.content || (x.entries && x.entries.length); });
      for (var i = 0; i < list.length; i++) await dbPut('offlinePresets', { id: uid('pr'), name: list[i].name, content: list[i].content || '', entries: list[i].entries || undefined });
      iosAlert('导入完成', '已导入 ' + list.length + ' 个预设'); renderPrList();
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
  body.appendChild(bookGrid(list.map(function (p) { return { id: p.id, name: p.name, sub: p.entries && p.entries.length ? p.entries.length + ' 条目' : (p.content || '').length + ' 字' }; }), function (it) { editPreset(it.id); }));
}
onShow['s-prlist'] = renderPrList;
$('b-pr-add').onclick = async function () {
  var p = { id: uid('pr'), name: '新预设', content: '', entries: [{ title: '', keys: [], content: '', enabled: true }] };
  await dbPut('offlinePresets', p); editPreset(p.id);
};
var prEditing = null;
async function editPreset(id) { prEditing = await dbGet('offlinePresets', id); go('s-predit'); }
onShow['s-predit'] = function () {
  if (!prEditing) return;
  var p = prEditing, body = $('predit-body'); body.innerHTML = '';
  var name = h('input', { type: 'text', value: p.name });
  body.appendChild(h('div', { class: 'group' }, field('预设名称', name)));
  /* 旧版预设顶部那段「预设内容」并进第一个条目（没关键词 = 一直带入），内容不丢 */
  var entries = (p.entries || []).slice();
  if (String(p.content || '').trim()) entries.unshift({ title: '写作要求', keys: [], content: String(p.content).trim(), enabled: true });
  if (!entries.length) entries.push({ title: '', keys: [], content: '', enabled: true });
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
  entries.forEach(addEntry);
  body.appendChild(holder);
  body.appendChild(h('div', { class: 'btn-row' }, h('button', { class: 'btn', text: '＋ 添加条目', onclick: function () { addEntry({ enabled: true }); } }),
    h('button', { class: 'btn danger', text: '删除这个预设', onclick: function () {
      confirmSheet('删除「' + p.name + '」？\n用了它的角色会回到不使用预设。', '删除', async function () { await dbDel('offlinePresets', p.id); prEditing = null; back(); }, true);
    } })));
  body.appendChild(h('div', { class: 'hint', style: 'color:var(--sub);font-size:12px;line-height:1.7;padding:0 4px', text: '条目是写给模型的写作要求（文风、人称、描写重点、格式…）。关键词留空的条目每次都带入；填了关键词的，最近聊天里出现关键词才带入。字数在角色设置里填，这里不用写。' }));
  p._collect = function () {
    p.name = name.value.trim() || '未命名'; p.content = '';
    p.entries = rows.map(function (r) {
      return { title: r.t.value.trim(), keys: r.k.value.split(/[,，、]/).map(function (s) { return s.trim(); }).filter(Boolean), content: r.c.value, enabled: r.en.checked };
    }).filter(function (e) { return String(e.content).trim(); });
    return p;
  };
};
$('b-pr-save').onclick = async function () {
  if (!prEditing || !prEditing._collect) return;
  var p = prEditing._collect(); delete p._collect;
  await dbPut('offlinePresets', p); iosAlert('已保存', '预设已保存'); back();
};

/* ---------- 导入 / 导出 ---------- */
/* ====================================================================
 * 数据备份：分区导入导出 / 完整备份 / EPhone(旧小手机)备份导入 / 应急备份
 * ==================================================================== */
var API_KEYS_SET = ['baseUrl', 'apiKey', 'model', 'temperature', 'stream', 'secBaseUrl', 'secApiKey', 'secModel', 'apiPresets', 'activePresetId', 'secApiPresets', 'activeSecPresetId'];
/* 分区：id、名称、涵盖的数据库表、涵盖的设置项 */
var PARTS = [
  { id: 'chars', name: '角色人设', stores: ['characters'], hint: '角色设定、头像、世界书挂载等' },
  { id: 'personas', name: '用户人设', stores: ['userPersonas'] },
  { id: 'msgs', name: '聊天记录', stores: ['messages'] },
  { id: 'mems', name: '记忆', stores: ['memories'] },
  { id: 'thoughts', name: '心声', stores: ['thoughts'] },
  { id: 'music', name: '音乐歌单', stores: ['playlists'], settings: ['musicApi', 'musicApiBackup'], hint: '我和每个角色的歌单，以及音乐接口地址' },
  { id: 'moments', name: '朋友圈', stores: ['moments'], settings: ['myProfile'], hint: '动态、点赞、评论，以及个人主页（头像、昵称、签名、背景）' },
  { id: 'wb', name: '世界书', stores: ['worldBooks', 'worldBookCategories'] },
  { id: 'stk', name: '表情包', stores: ['stickers', 'stickerCategories'] },
  { id: 'presets', name: '预设（线下写作）', stores: ['offlinePresets'] },
  { id: 'beauty', name: '美化', stores: ['beautyPresets', 'miniPresets'], settings: BEAUTY_KEYS, files: ['homeBgFile', 'notifyFile'], hint: '主题、壁纸、字体、提示音、图标、CSS 及各种美化预设' },
  { id: 'api', name: 'API 设置', stores: [], settings: API_KEYS_SET, local: ['mp_tts', 'mp_tts_presets'], hint: '含 API Key 和语音(TTS)接口地址/密钥，请自己保管', secret: true },
  { id: 'misc', name: '其它设置', stores: [], settingsRest: true, hint: '世界书扫描深度、记忆条数、气泡速度、通知等' }
];
function partOf(id) { return PARTS.find(function (p) { return p.id === id; }); }
function restSettingKeys(s) {
  var used = {}; PARTS.forEach(function (p) { (p.settings || []).forEach(function (k) { used[k] = true; }); });
  return Object.keys(s).filter(function (k) { return !used[k]; });
}
async function partCountsLocal() {
  var o = {};
  for (var i = 0; i < PARTS.length; i++) {
    var p = PARTS[i], n = 0;
    for (var j = 0; j < p.stores.length; j++) { n += (await reqP(db.transaction(p.stores[j]).objectStore(p.stores[j]).count())); }
    o[p.id] = n;
  }
  return o;
}
/* 边读库边写文件：用游标一批一批取，每攒够约 4MB 就封成一段 Blob，内存里不会同时放着整个备份。
 * 总结/心声进度（lastSummaryTs / lastThoughtTs）随角色原样导出，分区导入时才不会回到起点。 */
async function exportBlob(partIds, withKey, onStep) {
  var sel = partIds.map(partOf).filter(Boolean), sObj = null, local = null, files = null;
  var blobs = [], cur = [], curLen = 0, counts = {};
  function flush() { if (cur.length) { blobs.push(new Blob(cur)); cur = []; curLen = 0; } }
  function push(s) { cur.push(s); curLen += s.length; if (curLen > 4000000) flush(); }
  push('{"format":"myphone-v1","exportedAt":' + Date.now() + ',"source":"myphone","parts":' + JSON.stringify(partIds));
  for (var i = 0; i < sel.length; i++) {
    var p = sel[i];
    if (p.secret && !withKey) continue;
    for (var j = 0; j < p.stores.length; j++) {
      var s = p.stores[j];
      if (onStep) onStep(p.name);
      push(',"' + s + '":[');
      counts[s] = await new Promise(function (res, rej) {
        var n = 0, req = db.transaction(s).objectStore(s).openCursor();
        req.onsuccess = function () {
          try {
            var c = req.result;
            if (!c) { res(n); return; }
            push((n ? ',' : '') + JSON.stringify(c.value)); n++; c.continue();
          } catch (e) { rej(e); }
        };
        req.onerror = function () { rej(req.error); };
      });
      push(']');
    }
    var keys = p.settings || (p.settingsRest ? restSettingKeys(settings) : null);
    if (keys) { sObj = sObj || {}; keys.forEach(function (k) { if (settings[k] !== undefined) sObj[k] = settings[k]; }); }
    if (p.local) { p.local.forEach(function (k) { try { var v = localStorage.getItem(k); if (v) { local = local || {}; local[k] = v; } } catch (e) {} }); }   /* localStorage 里的 TTS 地址/密钥也带上，换包不用重新填 */
    if (p.files) { files = files || {}; p.files.forEach(function (k) { var v = k === 'homeBgFile' ? homeBgFile : notifyFile; if (v) files[k] = v; }); }
  }
  if (local) push(',"local":' + JSON.stringify(local));
  if (files) push(',"files":' + JSON.stringify(files));
  if (sObj) push(',"settings":' + JSON.stringify(sObj));
  push('}'); flush();
  return { blob: new Blob(blobs, { type: 'application/json' }), counts: counts };
}
function stamp() { var d = new Date(); function z(n) { return (n < 10 ? '0' : '') + n; } return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()); }
/* 每个分区一行「名称：N 项」，导出/导入完成后给你核对数量用 */
function countsText(counts) {
  var lines = [];
  PARTS.forEach(function (p) {
    if (!p.stores.length) return;
    var n = 0, has = false;
    p.stores.forEach(function (s) { if (counts[s] != null) { has = true; n += counts[s]; } });
    if (has && n > 0) lines.push(p.name + '：' + n + ' 项');
  });
  return lines.join('\n');
}
function showReport(title, text) {
  openSheet([h('h3', { text: title }), h('div', { class: 'hint', style: 'white-space:pre-wrap;line-height:1.7', text: text }),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', text: '好', onclick: closeSheet }))]);
}
async function doExportParts(partIds, label, withKey) {
  toast('正在导出…');
  try {
    var r = await exportBlob(partIds, withKey, function (n) { toast('正在导出：' + n); });
    downloadBlob('myphone-' + label + '-' + stamp() + '.json', r.blob);
    try { localStorage.setItem('mp-last-export', String(Date.now())); } catch (e) {}
    showReport('已导出 ' + (r.blob.size / 1048576).toFixed(1) + 'MB', countsText(r.counts) || '只有设置，没有数据表。'); refreshBackupPage();
  } catch (e) { toast('导出失败：' + e.message); }
}

/* ---------- EPhone（旧小手机）备份 → myphone-v1 ---------- */
function ephoneToMyphone(backup, opts) {
  opts = opts || {};
  var d = backup && (backup.data || backup);
  if (!d || !Array.isArray(d.chats)) throw new Error('不是有效的 EPhone 备份（找不到 chats）');
  var keepAv = opts.avatar !== false, rep = { groups: 0, unknownTypes: {}, skipped: [] };
  var av = function (v) { return keepAv && typeof v === 'string' && v ? v : null; };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : null; };
  var TYPE = { text: 'text', sticker: 'sticker', quote_reply: 'text', pat_message: 'pat', transfer: 'transfer', recalled_message: 'recalled', voice_message: 'voice', offline_text: 'offline' };
  var out = { format: 'myphone-v1', exportedAt: Date.now(), source: 'ephone-backup', characters: [], userPersonas: [], messages: [], memories: [], thoughts: [],
    worldBooks: [], worldBookCategories: [], stickers: [], stickerCategories: [], offlinePresets: [], miniPresets: [] };
  var sid = function (v) { return v == null || v === 'uncategorized' ? null : String(v); };
  var ents = function (arr) {
    if (typeof arr === 'string') return arr.trim() ? [{ title: '', keys: [], content: arr, enabled: true }] : [];
    return (Array.isArray(arr) ? arr : []).map(function (e) { return { title: e.comment || e.title || '', keys: Array.isArray(e.keys) ? e.keys : [], content: e.content || '', enabled: e.enabled !== false }; });
  };
  var seenId = {};
  d.chats.forEach(function (c) {
    if (c.isGroup) { rep.groups++; return; }
    var s = c.settings || {};
    out.characters.push({
      id: c.id, name: c.name || c.originalName || '', realName: c.originalName || c.name || '',
      persona: s.aiPersona || '', userNickname: s.myNickname || '', userPersona: s.myPersona || '',
      avatar: av(s.aiAvatar), userAvatar: av(s.myAvatar),
      worldBookIds: Array.isArray(s.linkedWorldBookIds) ? s.linkedWorldBookIds : [],
      contextLimit: num(s.maxMemory), autoMemory: { enabled: !!s.enableAutoMemory, interval: num(s.autoMemoryInterval) || 20 },
      injectThought: !!s.injectLatestThought,
      offlineMode: !!s.isOfflineMode, offlineWords: { min: num(s.offlineMinLength) || 0, max: num(s.offlineMaxLength) || 0 },
      offlinePresetId: s.offlinePresetId || null,
      stickerCategoryIds: Array.isArray(s.stickerCategoryIds) ? s.stickerCategoryIds.map(sid) : null,
      chatBg: av(s.background) || '', chatFontSize: num(s.fontSize) || null, bubbleCss: s.customCss || ''
    });
    (c.history || []).forEach(function (m, i) {
      var t = m.type || (m.role === 'system' ? 'system' : 'text');
      var type = TYPE[t] || (t === 'system' ? 'system' : 'text');
      if (!TYPE[t] && t !== 'system') rep.unknownTypes[t] = (rep.unknownTypes[t] || 0) + 1;
      var msg = { id: c.id + '#' + i, characterId: c.id, role: m.role, type: type, content: m.content == null ? '' : String(m.content), ts: num(m.timestamp) || 0 };
      if (m.isHidden) msg.hidden = true;
      var meta = {};
      if (m.meaning) meta.meaning = m.meaning;
      if (m.quote) meta.quote = { content: m.quote.content, text: m.quote.content, senderName: m.quote.senderName, ts: m.quote.timestamp };
      if (type === 'transfer') { meta.amount = num(m.amount); meta.note = m.note || ''; meta.receiverName = m.receiverName || ''; if (m.status != null) meta.status = m.status; if (m.isReceived != null) meta.isReceived = m.isReceived; if (m.isRefund != null) meta.isRefund = m.isRefund; }
      if (type === 'recalled' && m.recalledData) {
        meta.recalled = m.recalledData;
        meta.orig = { type: m.recalledData.originalType || 'text', text: m.recalledData.originalContent || '' };
      }
      if (Object.keys(meta).length) msg.meta = meta;
      out.messages.push(msg);
    });
    (c.longTermMemory || []).forEach(function (m, i) {
      var r = m.source === 'refined';
      out.memories.push({ id: c.id + '#m' + i, characterId: c.id, content: m.content || '', ts: num(m.timestamp) || 0, kind: r ? 'refined' : 'summary', core: r ? true : undefined });
    });
    var th = (c.thoughtsHistory || []).slice();
    th.forEach(function (t) { out.thoughts.push({ characterId: c.id, heartfeltVoice: t.heartfeltVoice || '', randomJottings: t.randomJottings || '', ts: num(t.timestamp) || 0 }); });
    if (c.heartfeltVoice && !th.some(function (t) { return t.heartfeltVoice === c.heartfeltVoice; }))
      out.thoughts.push({ characterId: c.id, heartfeltVoice: c.heartfeltVoice, randomJottings: c.randomJottings || '', ts: num(c.lastMemorySummaryTimestamp) || Date.now() });
  });
  var cids = {}; out.characters.forEach(function (c) { cids[c.id] = 1; });
  (d.memories || []).forEach(function (m) { if (cids[m.chatId]) out.memories.push({ id: 'note#' + m.id, characterId: m.chatId, content: m.description || '', ts: num(m.timestamp) || 0, kind: 'note' }); });
  (d.personaPresets || []).forEach(function (p) { out.userPersonas.push({ id: p.id, persona: p.persona || '', avatar: av(p.avatar) }); });
  (d.worldBooks || []).forEach(function (w) { out.worldBooks.push({ id: w.id, name: w.name || '', categoryId: w.categoryId == null ? null : w.categoryId, entries: ents(w.content) }); });
  (d.worldBookCategories || []).forEach(function (c) { out.worldBookCategories.push({ id: c.id, name: c.name || '' }); });
  (d.userStickers || []).forEach(function (s) { out.stickers.push({ id: s.id, name: s.name || '', url: s.url || '', categoryId: sid(s.categoryId) }); });
  (d.stickerCategories || []).forEach(function (c) { out.stickerCategories.push({ id: String(c.id), name: c.name || '' }); });
  /* 预设：EPhone 的预设就是「条目 + 关键词」，原样保留成带条目的预设 */
  (d.presets || []).forEach(function (p) { out.offlinePresets.push({ id: p.id, name: p.name || '', content: typeof p.content === 'string' ? p.content : '', entries: typeof p.content === 'string' ? undefined : ents(p.content) }); });
  /* 外观：字体 / 气泡 CSS / 全局 CSS 预设 → 小预设 */
  (d.appearancePresets || []).forEach(function (a, i) {
    var id = 'mpe' + i, ts = Date.now() - i;
    if (a.type === 'font' && typeof a.value === 'string') out.miniPresets.push({ id: id, kind: 'font', name: a.name || '字体', ts: ts, v: { fontUrl: a.value, fontData: '', fontName: a.name || '' } });
    else if (a.type === 'bubble_theme' && a.value) out.miniPresets.push({ id: id, kind: 'bubble', name: a.name || '气泡', ts: ts, v: { css: (a.value.custom || '') } });
    else if (a.type === 'global_css' && typeof a.value === 'string') out.miniPresets.push({ id: id, kind: 'css', name: a.name || 'CSS', ts: ts, v: { css: a.value } });
  });
  /* 设置：API、壁纸、字体、提示音、CSS、桌面图标 */
  var st = {}, ac = (d.apiConfig && d.apiConfig[0]) || {}, gs = (d.globalSettings && d.globalSettings[0]) || {};
  if (ac.proxyUrl) { st.baseUrl = ac.proxyUrl; st.apiKey = ac.apiKey || ''; st.model = ac.model || ''; st.secBaseUrl = ac.secondaryProxyUrl || ''; st.secApiKey = ac.secondaryApiKey || ''; st.secModel = ac.secondaryModel || ''; }
  if (num(gs.apiTemperature) != null) st.temperature = num(gs.apiTemperature);
  if (Array.isArray(d.apiPresets) && d.apiPresets.length) st.apiPresets = d.apiPresets.map(function (p, i) { return { id: 'apie' + i, name: p.name || ('预设' + (i + 1)), baseUrl: p.proxyUrl || '', apiKey: p.apiKey || '', model: p.model || '', temperature: st.temperature != null ? st.temperature : 0.8, stream: false, secBaseUrl: p.secondaryProxyUrl || '', secApiKey: p.secondaryApiKey || '', secModel: p.secondaryModel || '' }; });
  if (typeof gs.wallpaper === 'string' && gs.wallpaper) st.homeBg = gs.wallpaper;
  if (typeof gs.fontUrl === 'string' && gs.fontUrl) st.fontUrl = gs.fontUrl;
  if (typeof gs.notificationSoundUrl === 'string' && gs.notificationSoundUrl) st.notifyUrl = gs.notificationSoundUrl;
  if (typeof gs.globalCss === 'string' && gs.globalCss) st.customCss = gs.globalCss;
  var IC = { qq: '聊天', 'world-book': '世界书', 'api-settings': 'API设置', wallpaper: '美化', preset: '预设' }, icons = {}, ai = gs.appIcons || {};
  Object.keys(IC).forEach(function (k) { if (typeof ai[k] === 'string' && ai[k] && keepAv) icons[IC[k]] = ai[k]; });
  if (Object.keys(icons).length) st.iconUrls = icons;
  if (Object.keys(st).length) { out.settings = st; out.settingsPartial = true; }
  /* 报告 */
  var none = [['doubanPosts', '豆瓣'], ['qzonePosts', '空间动态'], ['shoppingProducts', '购物商品'], ['userWallet', '钱包/基金'], ['favorites', '收藏'], ['musicLibrary', '音乐'], ['grAuthors', '作者库']];
  none.forEach(function (n) { var v = d[n[0]]; if (Array.isArray(v) && v.length) rep.skipped.push(n[1] + ' ' + v.length); });
  var extra = 0; d.chats.forEach(function (c) { if (!c.isGroup) extra += (c.memos || []).length + (c.diary || []).length + (c.todoList || []).length; });
  if (extra) rep.skipped.push('备忘录/日记/待办 ' + extra);
  return { result: out, report: rep };
}

/* ---------- 导入：识别文件 → 勾选分区 → 覆盖/合并 ---------- */
function detectFile(data) {
  if (data && data.format === 'myphone-v1') return { kind: 'myphone', data: data };
  if (data && ((data.data && Array.isArray(data.data.chats)) || Array.isArray(data.chats))) return { kind: 'ephone', data: data };
  return null;
}
function partsInData(data) {
  var res = [];
  PARTS.forEach(function (p) {
    var n = 0, has = false;
    p.stores.forEach(function (s) { if (Array.isArray(data[s])) { has = true; n += data[s].length; } });
    var keys = p.settings || (p.settingsRest && data.settings ? restSettingKeys(data.settings) : null);
    if (keys && data.settings) { var hit = keys.filter(function (k) { return data.settings[k] !== undefined; }).length; if (hit) { has = true; if (!p.stores.length) n = hit; } }
    if (p.files && data.files && Object.keys(data.files).some(function (k) { return p.files.indexOf(k) >= 0; })) has = true;
    if (p.local && data.local && p.local.some(function (k) { return data.local[k] != null; })) has = true;
    if (has && (n > 0 || p.settings || p.files || p.local)) res.push({ part: p, n: n });
  });
  return res;
}
async function applyImport(data, partIds, replaceMode) {
  var sel = partIds.map(partOf).filter(Boolean), patch = null;
  for (var i = 0; i < sel.length; i++) {
    var p = sel[i];
    for (var j = 0; j < p.stores.length; j++) {
      var s = p.stores[j]; if (!Array.isArray(data[s])) continue;
      if (replaceMode) await dbClear(s);
      if (s === 'characters') {
        /* 文件里没有记忆/心声（分区导入或旧备份）时，用数据库里现有的来推算书签 */
        var memSrc = Array.isArray(data.memories) ? data.memories : await dbAll('memories');
        var thSrc = Array.isArray(data.thoughts) ? data.thoughts : await dbAll('thoughts');
        var lastBy = {}, rollPtr = {}; memSrc.forEach(function (m) { if (m.roll && m.ptr) rollPtr[m.characterId] = Math.max(rollPtr[m.characterId] || 0, m.ptr); else if (m.kind !== 'note' && m.kind !== 'profile' && !m.core) lastBy[m.characterId] = Math.max(lastBy[m.characterId] || 0, m.to || m.ts || 0); });
        var lastTh = {}; thSrc.forEach(function (t) { lastTh[t.characterId] = Math.max(lastTh[t.characterId] || 0, t.ts || 0); });
        data[s].forEach(function (c) { if (c.lastSummaryTs == null) c.lastSummaryTs = rollPtr[c.id] || lastBy[c.id] || 0; if (c.lastThoughtTs == null) c.lastThoughtTs = lastTh[c.id] || 0; });
      }
      var arr = data[s];
      for (var k = 0; k < arr.length; k += 4000) await dbBulkPut(s, arr.slice(k, k + 4000));   /* 分批写，几万条消息也不会卡死 */
    }
    var keys = p.settings || (p.settingsRest && data.settings ? restSettingKeys(data.settings) : null);
    if (keys && data.settings) { patch = patch || {}; keys.forEach(function (k) { if (data.settings[k] !== undefined) patch[k] = data.settings[k]; }); }
    if (p.local && data.local) { p.local.forEach(function (k) { if (data.local[k] != null) { try { localStorage.setItem(k, String(data.local[k])); } catch (e) {} } }); }
    if (p.files && data.files) {
      if (data.files.homeBgFile != null) { homeBgFile = data.files.homeBgFile; await dbPut('settings', { key: 'homeBgFile', data: homeBgFile }); }
      if (data.files.notifyFile != null) { notifyFile = data.files.notifyFile; await dbPut('settings', { key: 'notifyFile', data: notifyFile }); }
    }
  }
  if (patch) { Object.assign(settings, patch); await saveSettings(); }
  chars = await dbAll('characters'); applyTheme(); try { await renderHome(); } catch (e) {} renderList();
}
/* ---------- 流式读取备份：一次只在内存里放一小块，一条记录一条记录交给回调 ----------
 * 备份文件最外层是 { "key": 值, ... }。值是数组（各数据表）就逐条交出，其它值（设置等）整个交出。
 * cb.arrayStart(key) / cb.item(key, 原始文本) / cb.value(key, 原始文本)，回调可以是 async。 */
async function streamBackup(file, cb, onProgress, chunkSize) {
  var CH = chunkSize || 4 * 1024 * 1024, dec = new TextDecoder('utf-8'), off = 0, text = '', p = 0;
  var TRUNC = '文件不完整（可能没下载完，或中途被截断）';
  async function fill() {
    if (off >= file.size) return false;
    var buf = await file.slice(off, off + CH).arrayBuffer();
    off += buf.byteLength;
    text += dec.decode(buf, { stream: off < file.size });
    if (onProgress) onProgress(off / file.size);
    return true;
  }
  function compact() { if (p > 1048576) { text = text.slice(p); p = 0; } }
  async function skipWs() {
    for (;;) {
      while (p < text.length) { var c = text.charCodeAt(p); if (c === 32 || c === 10 || c === 13 || c === 9 || c === 0xFEFF) p++; else return true; }
      text = ''; p = 0;
      if (!(await fill())) return false;
    }
  }
  /* 从 p 开始找出一个完整 JSON 值的结尾（不含），数据不够就继续读；字符串里的括号、引号、转义都会正确跳过 */
  async function valueEnd() {
    var i = p, depth = 0, inStr = false, c = text.charCodeAt(i);
    if (c === 34) { inStr = true; i++; }
    else if (c === 91 || c === 123) { depth = 1; i++; }
    else {   /* 数字 / true / false / null：读到分隔符为止 */
      for (;;) {
        while (i < text.length) { c = text.charCodeAt(i); if (c === 44 || c === 93 || c === 125 || c === 32 || c === 10 || c === 13 || c === 9) return i; i++; }
        if (!(await fill())) return i;
      }
    }
    for (;;) {
      if (inStr) {
        var q = text.indexOf('"', i);
        if (q < 0) { i = text.length; if (!(await fill())) throw new Error(TRUNC); continue; }
        var b = q - 1, n = 0; while (b >= p && text.charCodeAt(b) === 92) { n++; b--; }   /* 引号前连续反斜杠是奇数个 → 这个引号被转义了 */
        i = q + 1;
        if (n % 2 === 0) { inStr = false; if (depth === 0) return i; }
        continue;
      }
      var hit = false;
      while (i < text.length) {
        c = text.charCodeAt(i);
        if (c === 34) { inStr = true; i++; hit = true; break; }
        if (c === 91 || c === 123) depth++;
        else if (c === 93 || c === 125) { depth--; if (depth === 0) return i + 1; }
        i++;
      }
      if (!hit && !(await fill())) throw new Error(TRUNC);
    }
  }
  if (!(await skipWs())) throw new Error('文件是空的');
  if (text.charCodeAt(p) !== 123) throw new Error('不是备份文件（最外层不是 { }）');
  p++;
  for (;;) {
    if (!(await skipWs())) throw new Error(TRUNC);
    var c = text.charCodeAt(p);
    if (c === 44) { p++; continue; }
    if (c === 125) break;
    if (c !== 34) throw new Error('文件格式不对');
    var ke = await valueEnd(), key = JSON.parse(text.slice(p, ke)); p = ke;
    if (!(await skipWs())) throw new Error(TRUNC);
    if (text.charCodeAt(p) !== 58) throw new Error('文件格式不对');
    p++;
    if (!(await skipWs())) throw new Error(TRUNC);
    if (text.charCodeAt(p) === 91) {
      p++;
      if (cb.arrayStart) await cb.arrayStart(key);
      for (;;) {
        if (!(await skipWs())) throw new Error(TRUNC);
        c = text.charCodeAt(p);
        if (c === 44) { p++; continue; }
        if (c === 93) { p++; break; }
        var ie = await valueEnd(), raw = text.slice(p, ie); p = ie;
        if (cb.item) await cb.item(key, raw);
        compact();
      }
    } else {
      var ve = await valueEnd(), vraw = text.slice(p, ve); p = ve;
      if (cb.value) await cb.value(key, vraw);
      compact();
    }
  }
}

/* 第一遍：只数数、看有哪些内容，不解析记录、不写库；顺便确认文件是完整的 */
async function scanBackup(file, onProgress, chunkSize) {
  var sum = { format: null, counts: {}, settingsKeys: [], fileKeys: [], localKeys: [] };
  await streamBackup(file, {
    value: function (key, raw) {
      if (key === 'format') { try { sum.format = JSON.parse(raw); } catch (e) {} }
      else if (key === 'settings' || key === 'files' || key === 'local') {
        var o; try { o = JSON.parse(raw); } catch (e) { throw new Error('「' + key + '」部分损坏'); }
        var ks = o && typeof o === 'object' ? Object.keys(o) : [];
        if (key === 'settings') sum.settingsKeys = ks; else if (key === 'files') sum.fileKeys = ks; else sum.localKeys = ks;
      }
    },
    arrayStart: function (key) { if (sum.counts[key] == null) sum.counts[key] = 0; },
    item: function (key) { sum.counts[key]++; }
  }, onProgress, chunkSize);
  return sum;
}
function isPartSettingKey(k) { return PARTS.some(function (p) { return (p.settings || []).indexOf(k) >= 0; }); }
function partsInSummary(sum) {
  var res = [];
  PARTS.forEach(function (p) {
    var n = 0, has = false, sk = sum.settingsKeys;
    p.stores.forEach(function (s) { if (sum.counts[s] != null) { has = true; n += sum.counts[s]; } });
    var keys = p.settings || (p.settingsRest && sk.length ? sk.filter(function (k) { return !isPartSettingKey(k); }) : null);
    if (keys && sk.length) { var hit = keys.filter(function (k) { return sk.indexOf(k) >= 0; }).length; if (hit) { has = true; if (!p.stores.length) n = hit; } }
    if (p.files && sum.fileKeys.some(function (k) { return p.files.indexOf(k) >= 0; })) has = true;
    if (p.local && p.local.some(function (k) { return sum.localKeys.indexOf(k) >= 0; })) has = true;
    if (has && (n > 0 || p.settings || p.files || p.local)) res.push({ part: p, n: n });
  });
  return res;
}

function dbDelMany(store, keys) {
  dbDirty = true;
  return new Promise(function (res, rej) {
    if (!keys || !keys.length) return res();
    var tx = db.transaction(store, 'readwrite'), os = tx.objectStore(store);
    for (var i = 0; i < keys.length; i++) os.delete(keys[i]);
    tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; tx.onabort = function () { rej(tx.error); };
  });
}
/* 总结 / 心声进度缺失（旧备份）时，用库里现有的记忆和心声推算 */
async function inferPointers(need) {
  var mem = await dbAll('memories'), th = await dbAll('thoughts'), lastBy = {}, rollPtr = {}, lastTh = {};
  mem.forEach(function (m) { if (m.roll && m.ptr) rollPtr[m.characterId] = Math.max(rollPtr[m.characterId] || 0, m.ptr); else if (m.kind !== 'note' && m.kind !== 'profile' && !m.core) lastBy[m.characterId] = Math.max(lastBy[m.characterId] || 0, m.to || m.ts || 0); });
  th.forEach(function (t) { lastTh[t.characterId] = Math.max(lastTh[t.characterId] || 0, t.ts || 0); });
  for (var i = 0; i < need.length; i++) {
    var n = need[i], c = await dbGet('characters', n.id); if (!c) continue;
    var ch = false;
    if (n.sum && c.lastSummaryTs == null) { c.lastSummaryTs = rollPtr[c.id] || lastBy[c.id] || 0; ch = true; }
    if (n.th && c.lastThoughtTs == null) { c.lastThoughtTs = lastTh[c.id] || 0; ch = true; }
    if (ch) await dbPut('characters', c);
  }
}
/* 心声表没有主键：按「角色+时间+内容」去重，重复导入不会越导越多 */
async function mergeThoughts(list, replaceMode) {
  var sig = function (t) { return t.characterId + '|' + t.ts + '|' + (t.heartfeltVoice || ''); };
  var ex = await dbAllWithKeys('thoughts'), have = {}, incoming = {};
  list.forEach(function (t) { incoming[sig(t)] = 1; });
  ex.forEach(function (e) { have[sig(e.value)] = 1; });
  var add = list.filter(function (t) { var k = sig(t); if (k in have) return false; have[k] = 1; return true; });
  await dbBulkPut('thoughts', add);
  if (replaceMode) { var del = ex.filter(function (e) { return !incoming[sig(e.value)]; }).map(function (e) { return e.key; }); await dbDelMany('thoughts', del); }
}

/* 第二遍：边读边写。
 * 覆盖模式「先写入、全部成功后才删」——中途不管哪一步出错，旧数据都还在。
 * 记录按数据量分批写入（约 6MB 一批），不会因为一批带图的记录太大而卡住。 */
async function applyImportStream(file, partIds, replaceMode, onProgress, chunkSize) {
  var sel = partIds.map(partOf).filter(Boolean), wantStore = {}, present = {}, seen = {}, wrote = {}, pend = {}, pendBytes = {};
  var needPtr = [], thoughtsIn = [], patch = null, warns = [];
  sel.forEach(function (p) { p.stores.forEach(function (s) { wantStore[s] = true; }); });
  var explicit = {}, restSel = sel.some(function (p) { return p.settingsRest; }), wantFiles = sel.some(function (p) { return p.files; });
  sel.forEach(function (p) { (p.settings || []).forEach(function (k) { explicit[k] = true; }); });
  function allowed(k) { return explicit[k] || (restSel && !isPartSettingKey(k)); }
  async function flush(s) { var a = pend[s]; if (a && a.length) { pend[s] = []; pendBytes[s] = 0; await dbBulkPut(s, a); } }

  await streamBackup(file, {
    arrayStart: function (key) { if (wantStore[key]) present[key] = true; },
    item: async function (key, raw) {
      if (!wantStore[key]) return;
      var o = JSON.parse(raw);
      wrote[key] = (wrote[key] || 0) + 1;
      if (key === 'thoughts') { thoughtsIn.push(o); return; }
      if (key === 'characters' && (o.lastSummaryTs == null || o.lastThoughtTs == null)) needPtr.push({ id: o.id, sum: o.lastSummaryTs == null, th: o.lastThoughtTs == null });
      (seen[key] = seen[key] || new Set()).add(String(o[STORES[key].keyPath]));
      (pend[key] = pend[key] || []).push(o); pendBytes[key] = (pendBytes[key] || 0) + raw.length;
      if (pendBytes[key] > 6000000 || pend[key].length >= 2000) await flush(key);
    },
    value: async function (key, raw) {
      if (key === 'settings') {
        var so = JSON.parse(raw); patch = patch || {};
        Object.keys(so).forEach(function (k) { if (allowed(k) && so[k] !== undefined) patch[k] = so[k]; });
      } else if (key === 'local') {
        var lo = JSON.parse(raw);
        sel.forEach(function (p) { if (p.local) p.local.forEach(function (k) { if (lo[k] != null) { try { localStorage.setItem(k, String(lo[k])); } catch (e) {} } }); });
      } else if (key === 'files' && wantFiles) {
        var fo = JSON.parse(raw);
        if (fo.homeBgFile != null) { homeBgFile = fo.homeBgFile; await dbPut('settings', { key: 'homeBgFile', data: homeBgFile }); }
        if (fo.notifyFile != null) { notifyFile = fo.notifyFile; await dbPut('settings', { key: 'notifyFile', data: notifyFile }); }
      }
    }
  }, onProgress, chunkSize);

  var stores = Object.keys(pend);
  for (var a = 0; a < stores.length; a++) await flush(stores[a]);
  if (present.thoughts) await mergeThoughts(thoughtsIn, replaceMode);
  if (needPtr.length) await inferPointers(needPtr);
  /* 到这里所有写入都成功了，才开始删备份里没有的旧记录（覆盖模式） */
  if (replaceMode) {
    var ps = Object.keys(present);
    for (var b = 0; b < ps.length; b++) {
      var s = ps[b]; if (s === 'thoughts') continue;
      var keys = await reqP(db.transaction(s).objectStore(s).getAllKeys()), sn = seen[s] || new Set();
      var del = keys.filter(function (k) { return !sn.has(String(k)); });
      for (var d = 0; d < del.length; d += 2000) await dbDelMany(s, del.slice(d, d + 2000));
      var left = await reqP(db.transaction(s).objectStore(s).count());
      if (left !== sn.size) warns.push(s + '：文件里 ' + (wrote[s] || 0) + ' 条，库里现在 ' + left + ' 条（有重复编号被合并）');
    }
  }
  if (patch && Object.keys(patch).length) { Object.assign(settings, patch); await saveSettings(); }
  return { wrote: wrote, warns: warns };
}
async function afterImportRefresh() { chars = await dbAll('characters'); applyTheme(); try { await renderHome(); } catch (e) {} renderList(); }

/* 导入弹层：勾选分区 + 覆盖/合并；runner(ids, replaceMode) 负责真正导入 */
function showImportSheet(avail, note, runner) {
  var checks = {}, list = h('div', { class: 'imp-list' });
  avail.forEach(function (a) {
    var cb = h('input', { type: 'checkbox' }); cb.checked = true;
    checks[a.part.id] = cb;
    list.appendChild(h('label', { class: 'imp-row' }, cb, h('span', { class: 'imp-n', text: a.part.name }), h('span', { class: 'imp-c', text: a.part.stores.length ? a.n + ' 项' : '设置' })));
  });
  var modeSel = h('select', {}, h('option', { value: 'replace', text: '覆盖：以备份为准（推荐，恢复备份用）' }), h('option', { value: 'merge', text: '合并：保留现有，同 ID 的被覆盖' }));
  openSheet([h('h3', { text: '选择要导入的分区' }), h('div', { class: 'hint', text: note }), list, field('导入方式', modeSel),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '开始导入', onclick: async function () {
        var ids = avail.filter(function (a) { return checks[a.part.id].checked; }).map(function (a) { return a.part.id; });
        if (!ids.length) { toast('至少勾一项'); return; }
        var replaceMode = modeSel.value === 'replace'; closeSheet();
        await runner(ids, replaceMode);
      } }),
      h('button', { class: 'btn', text: '取消', onclick: closeSheet }))]);
}
function importReportText(ids, r) {
  var t = countsText(r.wrote), only = ids.map(partOf).filter(function (p) { return p && !p.stores.length; }).map(function (p) { return p.name; });
  if (only.length) t += (t ? '\n' : '') + only.join('、') + '：已导入设置';
  if (r.warns.length) t += '\n\n请注意：\n' + r.warns.join('\n');
  return t || '完成';
}

async function loadImportFile(f, onlyParts) {
  var head = '';
  try { head = new TextDecoder().decode(await f.slice(0, 4096).arrayBuffer()); } catch (e) {}
  if (/"format"\s*:\s*"myphone-v1"/.test(head)) return loadImportStream(f, onlyParts);
  return loadImportLegacy(f, onlyParts);
}
/* 本小手机导出的 myphone-v1：流式读取，大文件也不会把内存撑爆 */
async function loadImportStream(f, onlyParts) {
  var sum;
  try { toast('正在检查文件…'); sum = await scanBackup(f, function (x) { toast('正在检查文件… ' + Math.round(x * 100) + '%'); }); }
  catch (e) { showReport('这个文件有问题', e.message + '\n\n你现有的数据没有被改动。'); return; }
  var avail = partsInSummary(sum); if (onlyParts) avail = avail.filter(function (a) { return onlyParts.indexOf(a.part.id) >= 0; });
  if (!avail.length) { toast('文件里没有可导入的内容'); return; }
  showImportSheet(avail, '识别为 myphone-v1 备份，文件完整。大文件会一条一条读取，不会占满内存。覆盖模式：导入全部成功后，才会删掉备份里没有的旧记录，中途出错旧数据不会丢。', async function (ids, replaceMode) {
    toast('导入中，请稍候…');
    try {
      var r = await applyImportStream(f, ids, replaceMode, function (x) { toast('导入中… ' + Math.round(x * 100) + '%'); });
      await afterImportRefresh(); markDirty2(); refreshBackupPage();
      showReport('导入完成', importReportText(ids, r));
    } catch (e) { showReport('导入没有完成', e.message + '\n\n已经写入的部分会保留，你原来的记录没有被删除。重新导入一次就行。'); }
  });
}
/* EPhone 旧备份等其它格式：需要整份读进内存转换（这类文件通常不大） */
async function loadImportLegacy(f, onlyParts) {
  var data;
  try { toast('正在读取文件…'); data = JSON.parse((await f.text()).replace(/^﻿/, '')); }
  catch (e) { toast('文件不是有效的 JSON（或太大，手机内存不够）'); return; }
  var det = detectFile(data); if (!det) { toast('不认识这个文件：不是 myphone-v1，也不是 EPhone 备份'); return; }
  var rep = null;
  if (det.kind === 'ephone') {
    try { var cv = ephoneToMyphone(data, { avatar: true }); data = cv.result; rep = cv.report; } catch (e) { toast('转换失败：' + e.message); return; }
  }
  var avail = partsInData(data); if (onlyParts) avail = avail.filter(function (a) { return onlyParts.indexOf(a.part.id) >= 0; });
  if (!avail.length) { toast('文件里没有可导入的内容'); return; }
  var note = det.kind === 'ephone' ? '识别为 EPhone 旧小手机备份，已自动转换。' + (rep && rep.groups ? ' 已跳过群聊 ' + rep.groups + ' 个。' : '') + (rep && rep.skipped.length ? ' 这个小手机里没有对应位置的内容未导入：' + rep.skipped.join('、') + '。' : '') : '识别为 myphone-v1 备份。';
  showImportSheet(avail, note, async function (ids, replaceMode) {
    toast('导入中，请稍候…');
    try { await applyImport(data, ids, replaceMode); iosAlert('导入完成', ids.map(function (i) { return partOf(i).name; }).join('、')); markDirty2(); refreshBackupPage(); }
    catch (e) { toast('导入失败：' + e.message); }
  });
}

var importOnly = null;
function startImport(onlyParts) { importOnly = onlyParts || null; $('file-import').click(); }
$('file-import').addEventListener('change', function () { var f = this.files[0]; this.value = ''; if (f) loadImportFile(f, importOnly); });

/* ---------- 应急备份：页面隐藏/关闭时自动把全部数据存一份到浏览器的缓存仓库；数据库被清空/损坏时可一键恢复 ---------- */
var EMG_CACHE = 'myphone-emergency', EMG_ON_KEY = 'mp-emg-on', EMG_META = 'mp-emg-meta';
var dbDirty = false, emgBusy = false;
function markDirty2() { dbDirty = true; }
function emgEnabled() { try { return localStorage.getItem(EMG_ON_KEY) !== '0'; } catch (e) { return true; } }
function emgMeta() { try { return JSON.parse(localStorage.getItem(EMG_META) || 'null'); } catch (e) { return null; } }
async function emergencyBackup(force) {
  if (emgBusy || !('caches' in window)) return false;
  if (!force && (!emgEnabled() || !dbDirty)) return false;
  emgBusy = true;
  try {
    var all = PARTS.map(function (p) { return p.id; }), r = await exportBlob(all, true), blob = r.blob;
    var n = { chars: r.counts.characters || 0, msgs: r.counts.messages || 0 };
    if (!force && !n.chars && !n.msgs) return false;                  /* 空库不覆盖已有的应急备份 */
    var meta = emgMeta() || {}, slot = meta.slot === 'a' ? 'b' : 'a', cache = await caches.open(EMG_CACHE);
    await cache.put('/__emg/' + slot + '.json', new Response(blob));  /* 交替写两份：写到一半断了，上一份仍完好 */
    localStorage.setItem(EMG_META, JSON.stringify({ slot: slot, ts: Date.now(), size: blob.size, chars: n.chars, msgs: n.msgs }));
    dbDirty = false; return true;
  } catch (e) { return false; } finally { emgBusy = false; }
}
async function emergencyBlob() {
  var m = emgMeta(); if (!m || !('caches' in window)) return null;
  var cache = await caches.open(EMG_CACHE), r = await cache.match('/__emg/' + m.slot + '.json'); if (!r) return null;
  return await r.blob();
}
document.addEventListener('visibilitychange', function () { if (document.hidden) emergencyBackup(false); });
window.addEventListener('pagehide', function () { emergencyBackup(false); });
setInterval(function () { var m = emgMeta(); if (!document.hidden && dbDirty && (!m || Date.now() - m.ts > 10 * 60 * 1000)) emergencyBackup(false); }, 60 * 1000);
async function checkEmergencyRestore() {
  try {
    var m = emgMeta(); if (!m || !m.chars) return;
    var nc = await reqP(db.transaction('characters').objectStore('characters').count());
    if (nc > 0) return;                                              /* 数据库里有东西，不打扰 */
    openSheet([h('h3', { text: '发现应急备份' }),
      h('div', { class: 'hint', text: '现在数据库是空的，但浏览器里存着一份应急备份：' + new Date(m.ts).toLocaleString() + '，' + m.chars + ' 个角色、' + m.msgs + ' 条消息。要恢复吗？' }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', text: '恢复', onclick: async function () { closeSheet(); await restoreEmergency(); } }),
        h('button', { class: 'btn', text: '先不用', onclick: closeSheet }))]);
  } catch (e) {}
}
async function restoreEmergency() {
  var blob = await emergencyBlob(); if (!blob) { toast('没找到应急备份'); return; }
  toast('正在恢复…');
  try {
    var r = await applyImportStream(blob, PARTS.map(function (p) { return p.id; }), true, function (x) { toast('正在恢复… ' + Math.round(x * 100) + '%'); });
    await afterImportRefresh(); markDirty2();
    showReport('已恢复', (r.wrote.characters || 0) + ' 个角色 · ' + (r.wrote.messages || 0) + ' 条消息' + (r.warns.length ? '\n\n' + r.warns.join('\n') : '')); refreshBackupPage();
  } catch (e) { toast('恢复失败：' + e.message); }
}

/* ---------- 数据备份全屏页 ---------- */
function refreshBackupPage() { if ($('s-backup') && $('s-backup').classList.contains('active')) renderBackupPage(); }
async function renderBackupPage() {
  var body = $('bk-body'); body.innerHTML = '';
  var counts = await partCountsLocal(), m = emgMeta(), lastExp = 0; try { lastExp = Number(localStorage.getItem('mp-last-export')) || 0; } catch (e) {}
  var days = lastExp ? Math.floor((Date.now() - lastExp) / 86400000) : null;
  var checked = {}, grid = h('div', { class: 'imp-list' });
  PARTS.forEach(function (p) {
    var cb = h('input', { type: 'checkbox' }); cb.checked = !p.secret; checked[p.id] = cb;
    grid.appendChild(h('label', { class: 'imp-row' }, cb, h('span', { class: 'imp-n', text: p.name }), h('span', { class: 'imp-c', text: p.stores.length ? counts[p.id] + ' 项' : '设置' })));
  });
  function picked() { return PARTS.filter(function (p) { return checked[p.id].checked; }).map(function (p) { return p.id; }); }
  /* 1 完整备份 */
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '完整备份' }),
    h('div', { class: 'bt-hint', text: days == null ? '还没有导出过备份文件。' : (days === 0 ? '今天已导出过备份文件。' : '上次导出备份文件是 ' + days + ' 天前。') + (days >= 7 ? ' 建议再导出一份。' : '') }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '导出全部（含 API Key）', onclick: function () { doExportParts(PARTS.map(function (p) { return p.id; }), 'full', true); } }),
      h('button', { class: 'btn', text: '导出全部（不含 API Key）', onclick: function () { doExportParts(PARTS.filter(function (p) { return !p.secret; }).map(function (p) { return p.id; }), 'full-nokey', false); } })),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', text: '导入备份文件（自动识别格式）', onclick: function () { startImport(null); } })),
    h('div', { class: 'bt-hint', text: '支持本小手机导出的 myphone-v1 文件，也支持 EPhone 旧小手机的备份（会自动转换）。导入时可以勾选只导入哪些分区。' })));
  /* 2 分区 */
  body.appendChild(h('div', { class: 'glass' }, h('h4', { text: '按分区导出 / 导入' }), grid,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '导出所选分区', onclick: function () { var ids = picked(); if (!ids.length) { toast('至少勾一项'); return; } doExportParts(ids, 'part', ids.indexOf('api') >= 0); } }),
      h('button', { class: 'btn', text: '导入所选分区…', onclick: function () { var ids = picked(); if (!ids.length) { toast('至少勾一项'); return; } startImport(ids); } })),
    h('div', { class: 'bt-hint', text: 'API 设置里有 Key，导出时默认不勾，需要的话自己勾上并保管好文件。' })));
  /* 3 应急 */
  var emgBox = h('div', { class: 'glass' }, h('h4', { text: '应急备份（防网页崩溃 / 数据被清）' }));
  var sw = switchEl(emgEnabled(), function (v) { try { localStorage.setItem(EMG_ON_KEY, v ? '1' : '0'); } catch (e) {} });
  emgBox.appendChild(h('div', { class: 'field inline' }, h('label', { text: '自动应急备份' }), sw.el));
  emgBox.appendChild(h('div', { class: 'bt-hint', text: m ? '最近一份：' + new Date(m.ts).toLocaleString() + '，' + m.chars + ' 个角色 / ' + m.msgs + ' 条消息 / ' + (m.size / 1048576).toFixed(1) + 'MB' : '还没有应急备份。' }));
  emgBox.appendChild(h('div', { class: 'btn-row' },
    h('button', { class: 'btn', text: '立即备份一次', onclick: async function () { toast('备份中…'); var ok = await emergencyBackup(true); toast(ok ? '已备份' : '备份失败（浏览器不支持或空间不足）'); renderBackupPage(); } }),
    h('button', { class: 'btn', text: '从应急备份恢复', onclick: function () { if (!m) { toast('还没有应急备份'); return; } confirmSheet('用应急备份覆盖现在的全部数据？', '恢复', restoreEmergency, true); } }),
    h('button', { class: 'btn', text: '下载应急备份文件', onclick: async function () { var b = await emergencyBlob(); if (!b) { toast('没有应急备份'); return; } downloadBlob('myphone-emergency-' + stamp() + '.json', b); } })));
  emgBox.appendChild(h('div', { class: 'bt-hint', text: '原理：每次你切走/关闭网页（以及每隔约 10 分钟）且数据有变化时，自动把全部数据存一份到浏览器的缓存仓库，交替写两份，写坏一份还有上一份。下次打开如果发现数据库是空的，会提示一键恢复。\n限制：这份备份和网页数据在同一个浏览器里，如果你手动「清除网站数据」或卸载浏览器，它也会一起没。所以请隔一阵导出一份备份文件，存到手机文件/网盘里。' }));
  body.appendChild(emgBox);
}
onShow['s-backup'] = renderBackupPage;


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

/* ====================================================================
 * 网易云音乐 / 一起听
 * 三块：① 数据源（NeteaseCloudMusicApi 接口 + 本地歌单）② 本地播放状态机（单人听歌 / 双人一起听）③ 搭车聊天请求
 *  · 网页不能直连网易云（跨域），要在「网易云音乐」页右上角设置里填一个 NeteaseCloudMusicApi 接口地址（https）。
 *  · 歌单存在 IndexedDB 的 playlists 表：每个人（我 / 每个角色）一份 { id:'pl-<owner>', owner, songs:[{id,name,artist,cover,dt}] }，不走网络。
 *  · 全局只有一个 Audio。桌面「网易云音乐」= 单人后台听歌，不弹悬浮窗、不碰提示词；
 *    聊天里点「＋ → 一起听」才绑定当前角色：弹双人头像悬浮窗，并在每次聊天请求里顺带带上「正在听什么、唱到哪句」，
 *    角色想切歌就在回复末尾写 [CMD:NEXT_SONG] / [CMD:PLAY_SONG:歌名]，前端抓到后删掉标记并直接本地切歌。全程零额外请求。
 * ==================================================================== */
var mu = { audio: new Audio(), queue: [], idx: -1, song: null, owner: 'me', lrc: [], lrcI: -1, tk: 0, fail: 0, loading: false, together: null };
mu.audio.preload = 'auto';
var muOwner = 'me';

function muBase() { return String(settings.musicApi || '').trim().replace(/\/+$/, ''); }
function muBackup() { return String(settings.musicApiBackup || '').trim().replace(/\/+$/, ''); }
function muFetch(base, path, params) {
  var q = Object.keys(params || {}).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  var url = base + path + '?' + (q ? q + '&' : '') + 'timestamp=' + Date.now();
  var ctl = new AbortController(), tm = setTimeout(function () { ctl.abort(); }, 15000);
  return fetch(url, { signal: ctl.signal }).then(function (r) {
    clearTimeout(tm); if (!r.ok) throw new Error('接口返回 ' + r.status + '（' + path + '）'); return r.json();
  }, function (e) {
    clearTimeout(tm); throw new Error(e && e.name === 'AbortError' ? '接口超时，换个接口地址试试' : '连不上接口：地址写错、不是 https、或接口没开跨域');
  });
}
function muNorm(s) {
  var ar = s.ar || s.artists || [], al = s.al || s.album || {};
  return { id: s.id, name: s.name || '', artist: ar.map(function (a) { return a.name; }).filter(Boolean).join('/'), cover: al.picUrl || al.blurPicUrl || '', dt: s.dt || s.duration || 0 };
}
async function muSearch(base, kw) {
  var r = await muFetch(base, '/cloudsearch', { keywords: kw, limit: 20 }), l = (r.result && r.result.songs) || [];
  if (!l.length) { try { r = await muFetch(base, '/search', { keywords: kw, limit: 20 }); l = (r.result && r.result.songs) || []; } catch (e) {} }
  return l.map(muNorm);
}
/* 歌单链接 / ID → 全部歌曲（分页拉，最多 1000 首） */
async function muImportPlaylist(txt) {
  var m = String(txt).match(/(?:playlist\?id=|playlist\/|[?&]id=)(\d{3,})/) || String(txt).match(/^\s*(\d{3,})\s*$/);
  if (!m) throw new Error('没认出歌单：请粘贴歌单链接，或只填歌单 ID（数字）');
  var base = muBase(), all = [], off = 0;
  for (;;) {
    var r = await muFetch(base, '/playlist/track/all', { id: m[1], limit: 200, offset: off }), s = (r.songs || []).map(muNorm);
    all = all.concat(s); if (s.length < 200 || all.length >= 1000) break; off += 200;
  }
  if (!all.length) { var d = await muFetch(base, '/playlist/detail', { id: m[1] }); all = ((d.playlist && d.playlist.tracks) || []).map(muNorm); }
  if (!all.length) throw new Error('这个歌单里没拿到歌（可能是私密歌单，或接口不支持）');
  return all;
}
/* 歌单（每人一份）读写 */
async function muGetList(owner) { return (await dbGet('playlists', 'pl-' + owner)) || { id: 'pl-' + owner, owner: owner, songs: [] }; }
async function muAdd(owner, songs) {
  var pl = await muGetList(owner), have = {}; pl.songs.forEach(function (s) { have[s.id] = true; });
  var add = songs.filter(function (s) { if (have[s.id]) return false; have[s.id] = true; return true; });
  pl.songs = pl.songs.concat(add); await dbPut('playlists', pl); return add.length;
}

/* 拿播放直链：主接口 → （空 / 只有试听）备用音源按原 ID、再按「歌名+歌手」搜索替换 → 最后试官方外链 */
async function muResolve(song) {
  async function fromApi(base, id) {
    try { var r = await muFetch(base, '/song/url/v1', { id: id, level: 'standard' }), d = r.data && r.data[0]; if (d && d.url && !d.freeTrialInfo) return d.url; } catch (e) {}
    try { var r2 = await muFetch(base, '/song/url', { id: id }), d2 = r2.data && r2.data[0]; if (d2 && d2.url && !d2.freeTrialInfo) return d2.url; } catch (e) {}
    return '';
  }
  var main = muBase(), bk = muBackup(), url = '';
  if (main) url = await fromApi(main, song.id);
  if (!url && bk) {
    url = await fromApi(bk, song.id);
    if (!url) { try { var rs = await muSearch(bk, (song.name + ' ' + song.artist).trim()); for (var i = 0; i < rs.length && i < 3 && !url; i++) url = await fromApi(bk, rs[i].id); } catch (e) {} }
  }
  if (!url) url = 'https://music.163.com/song/media/outer/url?id=' + song.id + '.mp3';
  return url.replace(/^http:/, 'https:');
}

/* 歌词：[mm:ss.xx]文字 → [{t, text}] */
function muParseLrc(txt) {
  var out = [];
  String(txt || '').split(/\r?\n/).forEach(function (ln) {
    var re = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g, m, ts = [], last = 0;
    while ((m = re.exec(ln))) { ts.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0)); last = re.lastIndex; }
    var text = ln.slice(last).trim();
    if (ts.length && text) ts.forEach(function (t) { out.push({ t: t, text: text }); });
  });
  return out.sort(function (a, b) { return a.t - b.t; });
}
function muLineAt(t) { var k = -1; for (var i = 0; i < mu.lrc.length; i++) { if (mu.lrc[i].t <= t) k = i; else break; } return k; }
async function muLoadLyric(song, tk) {
  if (!muBase()) return;
  try {
    var r = await muFetch(muBase(), '/lyric', { id: song.id });
    if (tk !== mu.tk) return;
    mu.lrc = muParseLrc(r && r.lrc && r.lrc.lyric); mu.lrcI = -1; muBuildLrcPanel(); muTick();
  } catch (e) {}
}

/* ---- 播放状态机 ---- */
async function muPlayQueue(queue, idx, owner) { mu.queue = queue.slice(); mu.owner = owner || 'me'; return muPlayAt(idx); }
async function muPlayAt(i) {
  var s = mu.queue[i]; if (!s) return;
  mu.idx = i; mu.song = s; mu.loading = true; mu.lrc = []; mu.lrcI = -1; var tk = ++mu.tk;
  muBuildLrcPanel(); muUI();
  try {
    var url = await muResolve(s); if (tk !== mu.tk) return;
    mu.audio.src = url; await mu.audio.play();
  } catch (e) { if (tk === mu.tk && !(e && e.name === 'AbortError')) toast('这首放不了：' + s.name); }
  if (tk !== mu.tk) return;
  mu.loading = false; muLoadLyric(s, tk); muUI();
}
function muNext(dir) {
  if (!mu.queue.length) return;
  var n = mu.queue.length, i = (mu.idx + (dir || 1) + n) % n;
  if (muMode() === 'shuffle' && n > 1) { do { i = Math.floor(Math.random() * n); } while (i === mu.idx); }
  muPlayAt(i);
}
function muToggle() {
  if (!mu.song) return;
  muDucked = false; clearTimeout(muResumeT);
  if (mu.audio.paused) mu.audio.play().catch(function () {}); else mu.audio.pause();
}
function muStop() { muDucked = false; mu.tk++; mu.audio.pause(); mu.audio.removeAttribute('src'); mu.song = null; mu.queue = []; mu.idx = -1; mu.lrc = []; mu.together = null; muUI(); }
mu.audio.addEventListener('ended', function () {
  if (muMode() === 'one' && mu.song) { mu.audio.currentTime = 0; mu.audio.play().catch(function () { muPlayAt(mu.idx); }); return; }
  muNext(1);
});
mu.audio.addEventListener('play', muUI); mu.audio.addEventListener('pause', muUI);
mu.audio.addEventListener('playing', function () { mu.fail = 0; muUI(); });
mu.audio.addEventListener('error', function () {
  if (!mu.song || !mu.audio.getAttribute('src')) return;
  toast('「' + mu.song.name + '」放不了（可能是 VIP / 没有版权；可在音乐库填备用音源）');
  mu.fail++; if (mu.fail < 3 && mu.queue.length > 1) muNext(1);
});
mu.audio.addEventListener('timeupdate', muTick);
/* 角色语音 / 自己的语音 / 录音 在播的时候先把歌暂停，播完自动接着放（提示音不算） */
var muHolds = new Set(), muDucked = false, muResumeT = 0;
function muHold(tok) { muHolds.add(tok); clearTimeout(muResumeT); if (!muDucked && mu.song && !mu.audio.paused) { muDucked = true; try { mu.audio.pause(); } catch (e) {} } }
function muRelease(tok) {
  muHolds.delete(tok); if (muHolds.size || !muDucked) return;
  clearTimeout(muResumeT);
  muResumeT = setTimeout(function () { if (muHolds.size || !muDucked) return; muDucked = false; if (mu.song && mu.audio.paused) mu.audio.play().catch(function () {}); }, 300);
}
(function () {
  var mp = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    var el = this;
    if (el !== mu.audio && !el.__skip) {
      if (!el.__dk) { el.__dk = 1; ['ended', 'pause', 'error', 'emptied', 'abort'].forEach(function (ev) { el.addEventListener(ev, function () { muRelease(el); }); }); }
      muHold(el);
    }
    var p = mp.apply(this, arguments);
    if (p && p.catch) p.catch(function () { if (el !== mu.audio) muRelease(el); });
    return p;
  };
})();
function muTick() {
  var t = mu.audio.currentTime || 0, k = muLineAt(t), d = mu.audio.duration;
  var bar = document.querySelector('#music-mini .mm-bar i'); if (bar && d > 0) bar.style.width = Math.min(100, t / d * 100) + '%';
  if (k !== mu.lrcI) { mu.lrcI = k; muLrcUI(); }
}
function muFmt(t) { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2); }
function muCleanLine(t) { t = String(t || '').trim(); return /纯音乐|请欣赏|暂无歌词|没有歌词|无歌词|歌词.*(暂无|获取失败)/.test(t) ? '' : t; }
function muCurLine() { return mu.lrcI >= 0 && mu.lrc[mu.lrcI] ? mu.lrc[mu.lrcI].text : ''; }
/* 系统通知栏 / 锁屏上的播放控制 */
function muMedia() {
  try {
    if (!('mediaSession' in navigator)) return;
    if (!mu.song) { navigator.mediaSession.metadata = null; return; }
    navigator.mediaSession.metadata = new MediaMetadata({ title: mu.song.name, artist: mu.song.artist, artwork: mu.song.cover ? [{ src: mu.song.cover, sizes: '512x512' }] : [] });
    navigator.mediaSession.setActionHandler('play', muToggle); navigator.mediaSession.setActionHandler('pause', muToggle);
    navigator.mediaSession.setActionHandler('nexttrack', function () { muNext(1); }); navigator.mediaSession.setActionHandler('previoustrack', function () { muNext(-1); });
  } catch (e) {}
}

/* ---- 界面同步：音乐页迷你播放条 + 聊天里的双人悬浮窗 ---- */
function muCover(s, cls) {
  var c = h('div', { class: cls || 'mu-cov' });
  if (s && s.cover) c.appendChild(h('img', { src: s.cover + (s.cover.indexOf('?') < 0 ? '?param=96y96' : ''), alt: '' })); else c.textContent = '♪';
  return c;
}
var muPlaySvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>', muPauseSvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
var muNextSvg = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 5l9 7-9 7zM17 5h2v14h-2z"/></svg>', muPrevSvg = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 5l-9 7 9 7zM5 5h2v14H5z"/></svg>';
function muBtn(svg, fn, cls) { var b = h('button', { type: 'button', class: 'mu-ic ' + (cls || ''), onclick: function (e) { e.stopPropagation(); fn(); } }); b.innerHTML = svg; return b; }
function muUI() {
  muMedia();
  /* 音乐页底部迷你条 */
  var mini = $('music-mini');
  if (mini) {
    mini.innerHTML = '';
    if (mu.song) {
      mini.hidden = false;
      var playing = !mu.audio.paused;
      mini.appendChild(h('div', { class: 'mm-bar' }, h('i')));
      mini.appendChild(h('div', { class: 'mm-main' }, muCover(mu.song), h('div', { class: 'mu-info' }, h('div', { class: 'mu-name', text: mu.song.name }), h('div', { class: 'mu-sub', text: (mu.loading ? '加载中… ' : '') + mu.song.artist })),
        muBtn(muPrevSvg, function () { muNext(-1); }), muBtn(playing ? muPauseSvg : muPlaySvg, muToggle, 'big'), muBtn(muNextSvg, function () { muNext(1); }),
        h('button', { type: 'button', class: 'mu-ic', text: '✕', onclick: function () { muStop(); renderMusicKeep(); } })));
      muTick();
    } else mini.hidden = true;
  }
  refreshListenPop();
  if ($('s-music') && $('s-music').classList.contains('active')) muMarkRows();
}
function muMarkRows() { document.querySelectorAll('#music-body .mu-row[data-sid]').forEach(function (r) { r.classList.toggle('on', !!mu.song && String(mu.song.id) === r.getAttribute('data-sid')); }); }

/* 聊天里的「一起听」悬浮窗：双人头像呼吸灯 + 当前歌词，点开展开滚动歌词 */
/* ---- 一起听悬浮窗：长条 / 迷你球两种形态，可拖动并记位置；迷你球时顶栏正中显示歌名+歌词（长按可调位） ---- */
function lpLoad(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function lpSave(k, v) { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) {} }
var lpMode = (function () { try { return localStorage.getItem('mp_lp_mode') === 'ball' ? 'ball' : 'bar'; } catch (e) { return 'bar'; } })();
var lpDragged = false;
function lpDims(mode) {
  var host = $('s-chat'), pop = $('listen-pop');
  if (mode === 'ball') return { w: 70, h: 46 };
  return { w: Math.min(host.clientWidth * 0.92, 360), h: pop.classList.contains('open') ? pop.offsetHeight : 50 };
}
function lpClamp(l, t, d) { var host = $('s-chat'); return { l: Math.max(0, Math.min(host.clientWidth - d.w, l)), t: Math.max(0, Math.min(host.clientHeight - d.h, t)) }; }
function lpApplyPos() {
  var pop = $('listen-pop'), pos = lpLoad('mp_lp_pos'); if (!pop) return;
  if (!pos || typeof pos.l !== 'number') { pop.style.left = ''; pop.style.top = ''; pop.style.transform = ''; return; }
  var c = lpClamp(pos.l, pos.t, lpDims(lpMode));
  pop.style.left = c.l + 'px'; pop.style.top = c.t + 'px'; pop.style.transform = 'none';
}
/* 切换形态：以当前中心点为准变形（不跳位置），带过渡动画 */
function lpSetMode(m) {
  var pop = $('listen-pop'), host = $('s-chat'), hr = host.getBoundingClientRect(), r = pop.getBoundingClientRect();
  var cx = r.left - hr.left + r.width / 2, cy = r.top - hr.top + r.height / 2;
  pop.style.transition = 'none'; pop.style.left = (r.left - hr.left) + 'px'; pop.style.top = (r.top - hr.top) + 'px'; pop.style.transform = 'none'; void pop.offsetWidth; pop.style.transition = '';
  pop.classList.remove('open');
  lpMode = m; lpSave('mp_lp_mode', m);
  var d = lpDims(m), c = lpClamp(cx - d.w / 2, cy - d.h / 2, d);
  lpSave('mp_lp_pos', { l: c.l, t: c.t });
  refreshListenPop();
}
function lpTopApply() { var t = $('lp-top'), o = lpLoad('mp_lp_top') || {}; if (t) { t.style.setProperty('--dx', (o.dx || 0) + 'px'); t.style.setProperty('--dy', (o.dy || 0) + 'px'); } }
function ensureListenPop() {
  var pop = $('listen-pop'); if (!pop || pop.firstChild) return pop;
  var pill = h('div', { class: 'lp-pill' },
    h('div', { class: 'lp-avs', id: 'lp-avs' }), h('div', { class: 'lp-txt' }, h('div', { class: 'mu-name', id: 'lp-name' }), h('div', { class: 'mu-lrc', id: 'lp-line' })),
    (function () { var b = muBtn(muPlaySvg, muToggle, 'lp-play'); b.id = 'lp-play'; return b; })());
  pop.appendChild(pill);
  pop.appendChild(h('div', { class: 'lp-more' }, h('div', { class: 'lp-lrc', id: 'lp-lrc' }),
    h('div', { class: 'lp-ctl' }, (function () { var mb = muBtn('', function () { muCycleMode(); }, 'lp-mode'); mb.id = 'lp-mode'; return mb; })(), muBtn(muPrevSvg, function () { muNext(-1); }), muBtn(muNextSvg, function () { muNext(1); }),
      h('button', { type: 'button', class: 'lp-end', text: '结束一起听', onclick: function (e) { e.stopPropagation(); muUnbind(true); } }))));
  /* 点击：点歌名区 = 展开/收起歌词；点头像、空白处 = 长条 ⇄ 迷你球。按钮自己 stopPropagation，不会触发 */
  pill.addEventListener('click', function (e) {
    if (lpDragged || e.target.closest('.mu-ic')) return;
    if (lpMode === 'bar' && e.target.closest('.lp-txt')) { pop.classList.toggle('open'); muLrcUI(); return; }
    lpSetMode(lpMode === 'bar' ? 'ball' : 'bar');
  });
  /* 拖动：位移超过 5px 才算拖，松手不触发点击；限制在聊天页可视区内 */
  var st = null;
  pill.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.mu-ic')) return;
    var hr = $('s-chat').getBoundingClientRect(), r = pop.getBoundingClientRect();
    st = { id: e.pointerId, x: e.clientX, y: e.clientY, l: r.left - hr.left, t: r.top - hr.top, moved: false };
    document.addEventListener('pointermove', mvf); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  });
  function mvf(e) {
    if (!st || e.pointerId !== st.id) return;
    var dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!st.moved && Math.hypot(dx, dy) <= 5) return;
    if (!st.moved) { st.moved = true; pop.classList.add('dragging'); pop.style.transform = 'none'; try { pill.setPointerCapture(e.pointerId); } catch (er) {} }
    var host = $('s-chat'), l = Math.max(0, Math.min(host.clientWidth - pop.offsetWidth, st.l + dx)), t = Math.max(0, Math.min(host.clientHeight - pop.offsetHeight, st.t + dy));
    pop.style.left = l + 'px'; pop.style.top = t + 'px'; st.cl = l; st.ct = t; lpSave('mp_lp_pos', { l: l, t: t }); e.preventDefault();
  }
  function end(e) {
    document.removeEventListener('pointermove', mvf); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
    if (!st || e.pointerId !== st.id) return;
    if (st.moved) { lpSave('mp_lp_pos', { l: st.cl, t: st.ct }); lpDragged = true; setTimeout(function () { lpDragged = false; }, 80); }
    pop.classList.remove('dragging'); st = null;
  }
  /* 迷你球时，顶栏正中的歌名+歌词；长按约 400ms 后可拖到别处，位置记在 localStorage */
  var top = h('div', { id: 'lp-top' }, h('div', { class: 'mu-name', id: 'lp-top-name' }), h('div', { class: 'mu-lrc', id: 'lp-top-line' }));
  $('s-chat').appendChild(top); lpTopApply();
  var ts = null;
  top.addEventListener('pointerdown', function (e) {
    var o = lpLoad('mp_lp_top') || {};
    ts = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: o.dx || 0, dy: o.dy || 0, on: false, nx: o.dx || 0, ny: o.dy || 0 };
    try { top.setPointerCapture(e.pointerId); } catch (er) {}
    ts.timer = setTimeout(function () { if (!ts) return; ts.on = true; top.classList.add('drag'); if (navigator.vibrate) { try { navigator.vibrate(12); } catch (er) {} } }, 400);
  });
  top.addEventListener('pointermove', function (e) {
    if (!ts || e.pointerId !== ts.id) return;
    var mx = e.clientX - ts.x, my = e.clientY - ts.y;
    if (!ts.on) { if (Math.hypot(mx, my) > 8) { clearTimeout(ts.timer); ts = null; } return; }
    var host = $('s-chat'), hw = host.clientWidth / 2;
    ts.nx = Math.max(-hw, Math.min(hw, ts.dx + mx)); ts.ny = Math.max(-8, Math.min(host.clientHeight - 60, ts.dy + my));
    top.style.setProperty('--dx', ts.nx + 'px'); top.style.setProperty('--dy', ts.ny + 'px'); e.preventDefault();
  });
  function tend(e) { if (!ts || e.pointerId !== ts.id) return; clearTimeout(ts.timer); if (ts.on) lpSave('mp_lp_top', { dx: ts.nx, dy: ts.ny }); top.classList.remove('drag'); ts = null; }
  top.addEventListener('pointerup', tend); top.addEventListener('pointercancel', tend);
  top.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  return pop;
}
function refreshListenPop() {
  var pop = ensureListenPop(); if (!pop) return;
  var on = !!(mu.together && cur && mu.together === cur.id && mu.song);
  pop.classList.toggle('on', on); pop.classList.toggle('ball', lpMode === 'ball');
  $('lp-top').classList.toggle('on', on && lpMode === 'ball');
  if (!on) { pop.classList.remove('open'); return; }
  var playing = !mu.audio.paused; pop.classList.toggle('paused', !playing);
  var avs = $('lp-avs'); avs.innerHTML = '';
  avs.appendChild(avatarNode(cur.userAvatar || myProfile().avatar, myProfile().name)); avs.appendChild(avatarNode(cur.avatar, cur.name));
  var nm = mu.song.name + ' · ' + mu.song.artist; $('lp-name').textContent = nm; $('lp-top-name').textContent = nm;
  $('lp-play').innerHTML = playing ? muPauseSvg : muPlaySvg;
  lpApplyPos(); lpTopApply(); muModeUI();
  muLrcUI();
}
function muBuildLrcPanel() {
  var box = $('lp-lrc'); if (!box) return; box.innerHTML = '';
  if (!mu.lrc.length) { box.appendChild(h('div', { class: 'lp-l none', text: muBase() ? '暂无歌词' : '（没配接口，拿不到歌词）' })); return; }
  mu.lrc.forEach(function (l, i) { box.appendChild(h('div', { class: 'lp-l', 'data-i': String(i), text: l.text })); });
}
function muLrcUI() {
  var ln = $('lp-line'), cl = muCurLine() || (mu.loading ? '加载中…' : '♪'); if (ln) ln.textContent = cl; var tl = $('lp-top-line'); if (tl) tl.textContent = cl;
  var box = $('lp-lrc'); if (!box) return;
  var old = box.querySelector('.lp-l.on'); if (old) old.classList.remove('on');
  var el = mu.lrcI >= 0 ? box.querySelector('.lp-l[data-i="' + mu.lrcI + '"]') : null;
  if (el) { el.classList.add('on'); if ($('listen-pop').classList.contains('open')) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2; }
}
function muUnbind(msg) { mu.together = null; refreshListenPop(); if (msg) toast('已结束一起听（音乐还在后台放，可去「网易云音乐」关掉）'); }

/* 聊天「＋ → 一起听」：没绑定就绑定当前角色；已绑定就结束 */
async function muTogetherToggle() {
  if (!cur) return;
  if (mu.together === cur.id) { muUnbind(true); return; }
  if (mu.song) { mu.together = cur.id; refreshListenPop(); toast('开始和 ' + cur.name + ' 一起听《' + mu.song.name + '》'); return; }
  if (!muBase()) { iosAlert('还没配接口', '先去桌面「网易云音乐」右上角设置里填接口地址、导入歌单'); return; }
  var mine = await muGetList('me'), his = await muGetList(cur.id), ch = cur;
  function start(list, owner) {
    if (!list.songs.length) { toast('这个歌单还是空的，先去「网易云音乐」添加歌'); return; }
    mu.together = ch.id; muPlayQueue(list.songs, 0, owner); toast('开始和 ' + ch.name + ' 一起听');
  }
  openBottomSheet([h('h3', { text: '和 ' + ch.name + ' 一起听，从哪个歌单开始？' }),
    h('button', { class: 'menu-btn', text: '我的歌单（' + mine.songs.length + ' 首）', onclick: function () { closeSheet(); start(mine, 'me'); } }),
    h('button', { class: 'menu-btn', text: ch.name + ' 的歌单（' + his.songs.length + ' 首）', onclick: function () { closeSheet(); start(his, ch.id); } }),
    h('button', { class: 'menu-btn', text: '去音乐库选歌', onclick: function () { closeSheet(); go('s-music'); } })]);
}

/* ---- 搭车聊天请求：提示词里带上「正在听什么」，回复里抓 [CMD:…] ---- */
async function muPromptCtx(char) {
  if (!mu.together || mu.together !== char.id || !mu.song) return null;
  var pl = await muGetList(char.id);
  return { song: mu.song.name, artist: mu.song.artist, line: muCleanLine(muCurLine()), playing: !mu.audio.paused, mine: pl.songs.slice(0, 15).map(function (s) { return s.name; }) };
}
function muPromptText(m) {
  var t = '# 一起听歌\n你和用户正在一起听歌（两边同步播放）：当前《' + m.song + '》' + (m.artist ? ' - ' + m.artist : '') + '，' + (m.playing ? '正在播放' : '已暂停') + (m.line ? '，刚唱到「' + m.line + '」' : '') + '。\n像真人一起听歌那样自然地偶尔聊到这首歌或歌词，不用每条都提，也不要复述这段提示。\n想切到下一首时，在回复最末尾单独写一行 [CMD:NEXT_SONG]；';
  if (m.mine.length) t += '想换成你自己喜欢的某首歌，写 [CMD:PLAY_SONG:歌名]（歌名只能从你的歌单里选：' + m.mine.join('、') + '）；';
  return t + '这些指令只给手机程序看，用户看不到，正文里不要提到，也不要频繁切歌。';
}
/* 深度注入用：规则放 system 顶部（不常变），当前状态放紧贴最新消息的背景里 */
function muRulesText(m) {
  var t = '# 一起听歌\n你和用户正在一起听歌（两边同步播放）。像真人一起听歌那样自然地偶尔聊到这首歌或歌词，不用每条都提，也不要复述背景资料里的提示。\n想切到下一首时，在回复最末尾单独写一行 [CMD:NEXT_SONG]；';
  if (m.mine.length) t += '想换成你自己喜欢的某首歌，写 [CMD:PLAY_SONG:歌名]（歌名只能从你的歌单里选：' + m.mine.join('、') + '）；';
  return t + '这些指令只给手机程序看，用户看不到，正文里不要提到，也不要频繁切歌。';
}
var muTold = { key: '', n: 0 };
function muStateText(m) {
  var key = m.song + '|' + m.playing, full = muTold.key !== key || muTold.n % 6 === 0;   /* 换歌/暂停变化时，或每 6 次请求，才带上歌词；其余只提一句在听什么 */
  muTold.key = key; muTold.n = full ? 1 : muTold.n + 1;
  return '一起听歌：你和用户正在一起听《' + m.song + '》' + (m.artist ? ' - ' + m.artist : '') + '（' + (m.playing ? '播放中' : '已暂停') + '）' + (full && m.line ? '，刚唱到「' + m.line + '」' : '') + '。';
}
function extractMusicCmd(text) {
  var t = String(text || ''), cmds = [];
  t = t.replace(/\[CMD:\s*NEXT_SONG\s*\]/gi, function () { cmds.push({ t: 'next' }); return ''; });
  t = t.replace(/\[CMD:\s*PLAY_SONG\s*:\s*([^\]]+?)\s*\]/gi, function (_, n) { cmds.push({ t: 'play', name: n }); return ''; });
  return { reply: t.trim(), cmds: cmds };
}
async function muApplyCmds(char, cmds) {
  for (var i = 0; i < cmds.length; i++) {
    var c = cmds[i];
    if (c.t === 'next') { muNext(1); toast(char.name + ' 切到了下一首'); }
    else if (c.t === 'play') {
      var lists = [{ o: char.id, l: await muGetList(char.id) }, { o: 'me', l: await muGetList('me') }], hit = null;
      for (var j = 0; j < lists.length && !hit; j++) {
        var ss = lists[j].l.songs, k = ss.findIndex(function (s) { return s.name === c.name; });
        if (k < 0) k = ss.findIndex(function (s) { return s.name.indexOf(c.name) !== -1 || c.name.indexOf(s.name) !== -1; });
        if (k >= 0) hit = { q: ss, k: k, o: lists[j].o };
      }
      if (hit) { muPlayQueue(hit.q, hit.k, hit.o); toast(char.name + ' 换了一首：' + hit.q[hit.k].name); }
    }
  }
}

/* ---- 桌面「网易云音乐」：私人播放器 / 音乐库配置中心 ---- */
var muResults = null, muImpTxt = '', muKw = '';
function renderMusicKeep() { if ($('s-music').classList.contains('active')) renderMusic(); }
async function muOwners() {
  var cs = await dbAll('characters'), p = myProfile();
  return [{ id: 'me', name: p.name || '我', avatar: p.avatar }].concat(cs.map(function (c) { return { id: c.id, name: c.name, avatar: c.avatar }; }));
}
function muRow(s, play, right) {
  var row = h('div', { class: 'mu-row' + (mu.song && mu.song.id === s.id ? ' on' : ''), 'data-sid': String(s.id) }, muCover(s), h('div', { class: 'mu-info' }, h('div', { class: 'mu-name', text: s.name }), h('div', { class: 'mu-sub', text: s.artist })), right);
  row.addEventListener('click', function (e) { if (e.target.closest('.mu-act')) return; play(); });
  return row;
}
async function renderMusic() {
  var body = $('music-body'), top = $('s-music').querySelector('.scroll').scrollTop;
  var owners = await muOwners(); if (!owners.some(function (o) { return o.id === muOwner; })) muOwner = 'me';
  var cur0 = owners.find(function (o) { return o.id === muOwner; }), pl = await muGetList(muOwner);
  body.innerHTML = ''; var topBox = $('music-top'); topBox.innerHTML = '';
  if (!muBase()) {
    var tip = h('div', { class: 'mu-tip', text: '还没配接口。网页不能直接访问网易云（跨域），需要一个 NeteaseCloudMusicApi 接口地址（https 开头）——可以自己部署（Vercel 等免费平台），或用别人提供的。填在右上角齿轮「音乐接口设置」里。' }); body.appendChild(tip);
  }
  var chips = h('div', { class: 'mu-owners' });
  owners.forEach(function (o) {
    var b = h('button', { type: 'button', class: 'mu-chip' + (o.id === muOwner ? ' on' : ''), onclick: function () { muOwner = o.id; muResults = null; renderMusic(); } }, avatarNode(o.avatar, o.name), h('span', { text: o.name }));
    chips.appendChild(b);
  });
  topBox.appendChild(h('div', { class: 'group-title', text: '歌单主页（点头像切换：我 / 每个角色各一份）' })); topBox.appendChild(chips);
  /* 导入 + 搜索 */
  var imp = h('input', { type: 'text', placeholder: '粘贴歌单链接或歌单 ID', value: muImpTxt }), kw = h('input', { type: 'text', placeholder: '搜歌名 / 歌手', value: muKw });
  imp.addEventListener('input', function () { muImpTxt = imp.value; }); kw.addEventListener('input', function () { muKw = kw.value; });
  var resBox = h('div', {});
  async function doImport() {
    if (!muBase()) { toast('先点右上角设置填接口地址'); return; }
    if (!imp.value.trim()) { toast('先粘贴歌单链接或 ID'); return; }
    toast('正在导入…');
    try { var songs = await muImportPlaylist(imp.value), n = await muAdd(muOwner, songs); muImpTxt = ''; iosAlert('导入完成', '「' + cur0.name + '」的歌单新增 ' + n + ' 首（歌单共 ' + songs.length + ' 首）'); renderMusic(); }
    catch (e) { showError(e, { label: '导入失败' }); }
  }
  async function doSearch() {
    if (!muBase()) { toast('先点右上角设置填接口地址'); return; }
    var k = kw.value.trim(); if (!k) return;
    toast('搜索中…');
    try { muResults = await muSearch(muBase(), k); drawResults(); } catch (e) { showError(e, { label: '搜索失败' }); }
  }
  function drawResults() {
    resBox.innerHTML = ''; if (!muResults) return;
    resBox.appendChild(h('div', { class: 'group-title', text: '搜索结果（点歌试听，点＋加进「' + cur0.name + '」的歌单）' }));
    if (!muResults.length) { resBox.appendChild(h('div', { class: 'mu-tip', text: '没搜到' })); return; }
    var card = h('div', { class: 'mu-list' });
    muResults.forEach(function (s, i) {
      card.appendChild(muRow(s, function () { muPlayQueue(muResults, i, 'search'); }, h('button', { type: 'button', class: 'mu-act mu-ic', text: '＋', onclick: async function () { var n = await muAdd(muOwner, [s]); toast(n ? '已加入「' + cur0.name + '」的歌单' : '歌单里已经有了'); renderMusic(); } })));
    });
    resBox.appendChild(card);
  }
  topBox.appendChild(h('div', { class: 'group' },
    h('div', { class: 'field mu-line' }, imp, h('button', { type: 'button', class: 'btn', text: '导入', onclick: doImport })),
    h('div', { class: 'field mu-line' }, kw, h('button', { type: 'button', class: 'btn', text: '搜索', onclick: doSearch }))));
  kw.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  body.appendChild(resBox); drawResults();
  /* 当前歌单 */
  body.appendChild(h('div', { class: 'group-title', text: cur0.name + ' 的歌单 · ' + pl.songs.length + ' 首' }));
  if (!pl.songs.length) body.appendChild(h('div', { class: 'mu-tip', text: '还是空的：上面导入网易云歌单，或搜歌添加。' + (muOwner === 'me' ? '' : '角色的歌单就是 TA 喜欢的歌——一起听时 TA 可以从里面挑歌来切。') }));
  else {
    var list = h('div', { class: 'mu-list' });
    pl.songs.forEach(function (s, i) {
      list.appendChild(muRow(s, function () { muPlayQueue(pl.songs, i, muOwner); }, h('button', { type: 'button', class: 'mu-act mu-ic', text: '⋯', onclick: function () {
        menuSheet(s.name, [
          ['播放', function () { muPlayQueue(pl.songs, i, muOwner); }],
          ['加到别人的歌单…', function () {
            menuSheet('加到谁的歌单', owners.filter(function (o) { return o.id !== muOwner; }).map(function (o) { return [o.name, async function () { var n = await muAdd(o.id, [s]); toast(n ? '已加到「' + o.name + '」的歌单' : '「' + o.name + '」的歌单里已经有了'); }]; }));
          }],
          ['从这个歌单删除', async function () { pl.songs.splice(i, 1); await dbPut('playlists', pl); renderMusic(); }]
        ]);
      } })));
    });
    body.appendChild(list);
    body.appendChild(h('div', { class: 'btn-row', style: 'margin-top:10px' }, h('button', { class: 'btn', text: '顺序播放全部', onclick: function () { muPlayQueue(pl.songs, 0, muOwner); } }),
      h('button', { class: 'btn danger', text: '清空这个歌单', onclick: function () { confirmSheet('清空「' + cur0.name + '」的歌单？', '清空', async function () { pl.songs = []; await dbPut('playlists', pl); renderMusic(); }, true); } })));
  }
  $('s-music').querySelector('.scroll').scrollTop = top;
}
onShow['s-music'] = function () { renderMusic(); muModeUI(); };
/* 音乐接口设置（右上角齿轮打开） */
function openMusicSettings() {
  var api = h('input', { type: 'text', placeholder: 'https://你的接口地址（不要带结尾的 /）', value: settings.musicApi || '' }), bk = h('input', { type: 'text', placeholder: '备用音源接口地址（可留空）', value: settings.musicApiBackup || '' });
  function saveApi() {
    settings.musicApi = api.value.trim().replace(/\/+$/, ''); settings.musicApiBackup = bk.value.trim().replace(/\/+$/, ''); saveSettings();
    if (location.protocol === 'https:' && /^http:/i.test(settings.musicApi + ' ' + settings.musicApiBackup)) toast('网页是 https，接口地址也要 https，否则会被浏览器拦');
  }
  openSheet([h('h3', { text: '音乐接口设置' }),
    h('div', { style: 'text-align:left' }, field('主接口（NeteaseCloudMusicApi）', api, '用来搜歌、导入歌单、取歌词和播放直链'),
      field('备用音源', bk, '主接口拿不到完整音频（VIP / 只有试听）时，自动到这里用「歌名+歌手」搜索，换一个能放的版本；接口格式同 NeteaseCloudMusicApi')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', text: '保存', onclick: function () { saveApi(); closeSheet(); renderMusic(); toast('已保存'); } }),
      h('button', { class: 'btn', text: '测试主接口', onclick: async function () {
        saveApi(); if (!muBase()) { toast('先填接口地址'); return; }
        try { var r = await muSearch(muBase(), '周杰伦'); iosAlert(r.length ? '连接正常' : '连上了', r.length ? '搜到 ' + r.length + ' 首歌' : '接口有响应，但没搜到结果'); } catch (e) { showError(e, { label: '连接失败' }); }
      } }),
      h('button', { class: 'btn', text: '取消', onclick: closeSheet })),
    h('div', { class: 'hint', style: 'color:var(--sub);font-size:12px;line-height:1.7;text-align:left;margin-top:8px', text: '这里是你自己的私人播放器：点歌就在后台播放，不会弹出双人悬浮窗，也不会把歌名告诉角色。想和 TA 一起听，去和 TA 的聊天里点「＋ → 一起听」。' })]);
}
/* 播放模式：列表循环 / 单曲循环 / 随机（存 localStorage mp_mu_mode） */
var MU_MODES = [['list', '列表循环', 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3'], ['one', '单曲循环', 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3M11 10l1.5-1v6'], ['shuffle', '随机播放', 'M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5']];
function muMode() { try { var v = localStorage.getItem('mp_mu_mode'); if (v === 'one' || v === 'shuffle') return v; } catch (e) {} return 'list'; }
function muModeUI() {
  var m = MU_MODES.find(function (x) { return x[0] === muMode(); }), svg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="' + m[2] + '"/></svg>';
  ['b-mu-mode', 'lp-mode'].forEach(function (id) { var b = $(id); if (b) { b.innerHTML = svg; b.title = m[1]; b.setAttribute('aria-label', m[1]); } });
}
function muCycleMode() {
  var i = MU_MODES.findIndex(function (x) { return x[0] === muMode(); }), n = MU_MODES[(i + 1) % MU_MODES.length];
  try { localStorage.setItem('mp_mu_mode', n[0]); } catch (e) {}
  muModeUI(); toast(n[1]);
}
$('b-mu-mode').onclick = muCycleMode;
$('b-mu-set').onclick = openMusicSettings;
muUI();

/* 打开聊天后刷新一起听悬浮窗（只有绑定的就是这个角色才显示） */
var _openChatBase = openChat;
openChat = async function () { var r = await _openChatBase.apply(this, arguments); refreshListenPop(); return r; };

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

/* ---------- 手机返回键 / 返回手势 ----------
 * 做法：浏览器历史条目 = 页面栈深度（桌面是 1，下面垫一个「桌面前」的底座 0）。
 *  · go() 在点击里 pushState（有用户操作，Chrome 不会把它当「可跳过条目」）
 *  · 返回手势：先关弹层，否则退一页；关弹层/被「未保存」拦住时，用 history.forward() 回到原位，绝不在 popstate 里 pushState
 *  · 桌面上再返回 = 退出网页（和系统一致） */
var histPos = -1, hIgnore = 0, baseReady = false, popping = false;
function hasOverlay() {
  return !$('errpop').hidden || !$('sheet').hidden || !$('plusmenu').hidden || !!msgPop || !!cloudEl || !$('fab').hidden || selMode;
}
function closeTopOverlay() {
  if (!$('errpop').hidden) { closeErr(); return true; }
  if (!$('sheet').hidden) { closeSheet(); return true; }
  if (!$('plusmenu').hidden) { closePlus(); return true; }
  if (msgPop) { closeMsgPop(); return true; }
  if (cloudEl) { closeCloud(); return true; }
  if (!$('fab').hidden) { closeFab(); return true; }
  if (selMode) { exitSelect(); return true; }
  return false;
}
function ensureBase() {
  if (baseReady) return; baseReady = true;
  try {
    var st = history.state;
    if (st && typeof st.mp === 'number') histPos = st.mp;
    else { history.replaceState({ mp: 0 }, ''); histPos = 0; }
    if (histPos < 1) { history.pushState({ mp: 1 }, ''); histPos = 1; }
  } catch (e) { baseReady = false; }
}
function syncHist() {
  if (!baseReady) return;
  try {
    if (histPos < nav.length) {
      if (popping) { var d1 = nav.length - histPos; histPos = nav.length; hIgnore++; history.go(d1); }
      else while (histPos < nav.length) { histPos++; history.pushState({ mp: histPos }, ''); }
    } else if (histPos > nav.length) {
      var d2 = nav.length - histPos; histPos = nav.length; hIgnore++; history.go(d2);
    }
    if (hIgnore > 0) setTimeout(function () { hIgnore = 0; }, 700);
  } catch (e) {}
}
document.addEventListener('pointerdown', ensureBase, { once: true, capture: true });
window.addEventListener('popstate', function (e) {
  if (!baseReady) return;
  if (hIgnore > 0) { hIgnore--; return; }
  var d = (e.state && typeof e.state.mp === 'number') ? e.state.mp : 0, prev = histPos;
  histPos = d; popping = true;
  try {
    if (d > prev) { syncHist(); return; }
    if (closeTopOverlay()) { syncHist(); return; }
    if (nav.length > 1) { back(); syncHist(); return; }
    if (d === 0) { baseReady = false; history.back(); return; }
    syncHist();
  } finally { popping = false; }
});

/* ---------- 点系统通知 → 直接进对应角色的聊天（页面还活着就切过去；已被系统清掉就带 ?chat= 重新打开） ---------- */
async function openChatFromOutside(cid) {
  if (!cid) return;
  try { closeTopOverlay(); closeBannerNow(); } catch (e) {}
  chars = await dbAll('characters');
  if (!chars.some(function (c) { return c.id === cid; })) return;
  nav = ['s-home', 's-list']; activate('s-list'); ensureBase(); syncHist();
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
    applyStaticI18n();
    await loadUnread(); applyTheme(); await renderHome(); setTimeout(checkEmergencyRestore, 600);
    try { var q0 = new URLSearchParams(location.search).get('chat'); if (q0) { history.replaceState({}, '', location.pathname); await openChatFromOutside(q0); } } catch (e) {}
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) { document.body.innerHTML = '<pre style="padding:20px;white-space:pre-wrap">启动失败：' + e.message + '</pre>'; }
})();

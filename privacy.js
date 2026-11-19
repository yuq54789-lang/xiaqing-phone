/* =====================================================================
 * 隐私编辑 / 隐私删除（独立文件，不改 app.js）
 * 角色看不到：编辑不记「改过」、删除不留「用户删除了…」记录。
 * 依赖 app.js 里的全局：messageMenu、showMsgPop、menuSheet、textSheet、confirmSheet、
 *   dbPut、db、dbDirty、editable、reloadChat、selectedMsgs、exitSelect、selected、$、toast
 * ===================================================================== */
(function () {
  if (window.__privacyLoaded) return; window.__privacyLoaded = true;

  /* 隐私编辑：只改内容，不写 meta.edited */
  function privateEditMessage(m) {
    textSheet('隐私编辑（角色不会知道你改过，只会当成原本就是这样）', m.content, [{ text: '保存', cls: 'primary', fn: async function (v) {
      if (v === m.content) return;
      m.content = v; await dbPut('messages', m); reloadChat();
    } }, { text: '取消' }]);
  }

  /* 隐私删除：真删，不留任何隐藏记录 */
  async function privateDeleteMessages(list) {
    dbDirty = true;
    await new Promise(function (res, rej) {
      var tx = db.transaction('messages', 'readwrite'), os = tx.objectStore('messages');
      list.forEach(function (m) { os.delete(m.id); });
      tx.oncomplete = res; tx.onerror = tx.onabort = function () { rej(tx.error); };
    });
  }

  /* 长按菜单：在原菜单里插入两项（不复制原逻辑，原菜单以后改了也跟着变） */
  var origMenu = messageMenu;
  messageMenu = function (m, anchor) {
    var oSP = showMsgPop, oMS = menuSheet;
    function addItems(items) {
      items = items.slice();
      var ei = -1;
      items.forEach(function (it, i) { if (it[0] === '编辑') ei = i; });
      if (ei >= 0) items.splice(ei + 1, 0, ['隐私编辑', function () { privateEditMessage(m); }]);
      items.push(['隐私删除', async function () { await privateDeleteMessages([m]); reloadChat(); }]);
      return items;
    }
    showMsgPop = function (items, a) { showMsgPop = oSP; menuSheet = oMS; return oSP(addItems(items), a); };
    menuSheet = function (t, items) { showMsgPop = oSP; menuSheet = oMS; return oMS(t, addItems(items)); };
    try { origMenu(m, anchor); } finally { showMsgPop = oSP; menuSheet = oMS; }
  };

  /* 多选栏：加一个「隐私删除」按钮，窄屏自动换行 */
  var st = document.createElement('style');
  st.textContent = '#selbar{flex-wrap:wrap}#selbar span{min-width:64px}' +
    /* 长按菜单超过 4 项时，改成每行 4 个的整齐格子；4 项及以下的菜单不受影响 */
    '.msgpop:has(button:nth-child(6)){display:grid;grid-template-columns:repeat(4,auto)}' +
    '.msgpop:has(button:nth-child(6)) button{text-align:center}';
  document.head.appendChild(st);

  var del = $('sel-del');
  if (del && !$('sel-pdel')) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'pill ghost'; b.id = 'sel-pdel'; b.textContent = '隐私删除';
    del.parentNode.insertBefore(b, del.nextSibling);
    b.onclick = function () {
      var n = Object.keys(selected).length; if (!n) { toast('还没选消息'); return; }
      confirmSheet('隐私删除选中的 ' + n + ' 条消息？角色不会知道你删过。', '隐私删除', async function () {
        var dm = await selectedMsgs();
        exitSelect();
        dm.forEach(function (m) { var row = $('msgs').querySelector('.row[data-id="' + m.id + '"]'); if (row) row.remove(); });
        await privateDeleteMessages(dm); reloadChat();
      }, true);
    };
  }
})();

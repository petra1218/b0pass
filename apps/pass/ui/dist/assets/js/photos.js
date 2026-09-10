/**
 * 照片批量上传（移动优先）
 *
 * 目标：手机上一次从相册选中百余张照片并稳定上传到当前目录。
 * 约定：复用 POST /pass/file-upload?f=<相对路径>，header 携带 token；
 *       成功返回 {code:0}，鉴权失败返回 {code:401}（HTTP 状态仍为 200）。
 * 策略：3 并发、每请求 1 张，进度与失败重试均以单张为粒度。
 */
layui.use(['layer'], function () {
  var layer = layui.layer;

  var MAX_CONCURRENT = 3;                              // 并发上传数
  var API = '/pass/file-upload';                       // 上传接口
  var LOGIN_URL = '/app/pass/login.html';              // 登录页
  var token = localStorage.getItem('token') || '';

  /* ------------------------------ 目标目录 ------------------------------ */
  var fpath = '/';
  try {
    var qs = new URLSearchParams(window.location.search);
    fpath = qs.get('f') || '/';
  } catch (e) {
    fpath = decodeURI(window.location.href.split('=')[1] || '/');
  }
  fpath = fpath.replace('//', '/');
  document.getElementById('f').textContent = fpath;

  /* ------------------------------ DOM 引用 ------------------------------ */
  var el = {
    grid: document.getElementById('grid'),
    empty: document.getElementById('empty'),
    input: document.getElementById('fileInput'),
    btnSelect: document.getElementById('btnSelect'),
    btnStart: document.getElementById('btnStart'),
    btnRetry: document.getElementById('btnRetry'),
    btnClose: document.getElementById('btnClose'),
    barInfo: document.getElementById('barInfo'),
    barProgress: document.getElementById('barProgress'),
    barProgressInner: document.getElementById('barProgressInner'),
    keepAwakeTip: document.getElementById('keepAwakeTip'),
    wxTip: document.getElementById('wxTip'),
    btnWxKnow: document.getElementById('btnWxKnow'),
    noSleepAudio: document.getElementById('noSleepAudio')
  };

  /* ------------------------------ 运行时状态 ------------------------------ */
  var items = [];        // {file,url,status,sent,size,msg,node}
  var active = 0;        // 正在上传的数量
  var running = false;   // 上传流程是否进行中
  var closing = false;   // 是否已进入收尾（防止重复触发）
  var runBase = { done: 0, fail: 0 };   // 本轮开始前的完成数，用于统计本轮结果

  var STATE_TEXT = { wait: '等待', doing: '上传中', done: '完成', fail: '失败' };

  /* ------------------------------ 工具函数 ------------------------------ */
  function fmtSize(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }

  function totals() {
    var t = { count: items.length, total: 0, sent: 0, wait: 0, doing: 0, done: 0, fail: 0 };
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      t.total += it.size;
      t.sent += (it.status === 'done' ? it.size : it.sent);
      t[it.status]++;
    }
    return t;
  }

  function hasWaiting() {
    for (var i = 0; i < items.length; i++) {
      if (items[i].status === 'wait') return true;
    }
    return false;
  }

  /* ------------------------------ 视图渲染 ------------------------------ */
  function addCell(item, idx) {
    var cell = document.createElement('div');
    cell.className = 'ph-cell';
    cell.setAttribute('data-idx', idx);

    var img = document.createElement('img');
    img.loading = 'lazy';       // 百余张缩略图按需解码，避免一次性占用大量内存
    img.decoding = 'async';
    img.src = item.url;
    img.alt = item.file.name;

    var state = document.createElement('span');
    state.className = 'ph-state';
    state.textContent = STATE_TEXT.wait;

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'ph-del';
    del.textContent = '×';
    del.title = '移除';
    del.onclick = function () { removeItem(item); };

    cell.appendChild(img);
    cell.appendChild(state);
    cell.appendChild(del);
    item.node = cell;
    return cell;
  }

  function updateCell(item) {
    if (!item.node) return;
    var state = item.node.querySelector('.ph-state');
    state.className = 'ph-state ph-state-' + item.status;
    if (item.status === 'doing') {
      state.textContent = (item.size ? Math.round(item.sent / item.size * 100) : 0) + '%';
    } else {
      state.textContent = STATE_TEXT[item.status];
      if (item.status === 'fail') state.title = item.msg || '';
    }
    item.node.classList.toggle('is-done', item.status === 'done');
    item.node.classList.toggle('is-fail', item.status === 'fail');
    item.node.classList.toggle('is-doing', item.status === 'doing');
  }

  // 进度刷新统一走 rAF 节流，避免高频 onprogress 触发大量重排
  var rafPending = false;
  var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };

  function scheduleProgress() {
    if (rafPending) return;
    rafPending = true;
    raf(flushProgress);
  }

  function flushProgress() {
    rafPending = false;
    var t = totals();
    for (var i = 0; i < items.length; i++) {
      if (items[i].status === 'doing') updateCell(items[i]);
    }
    renderBar(t);
  }

  function renderBar(t) {
    var pct = t.total ? Math.round(t.sent / t.total * 100) : 0;

    if (t.count === 0) {
      el.barInfo.textContent = '未选择照片';
      el.barProgress.classList.add('hide');
      el.btnStart.classList.add('hide');
      el.btnRetry.classList.add('hide');
      el.btnSelect.classList.remove('hide');
      return;
    }

    if (running) {
      el.barInfo.innerHTML = '上传中 <b>' + (t.done + t.fail) + '/' + t.count + '</b> 张 · ' +
        '<b>' + pct + '%</b> · ' + fmtSize(t.sent) + '/' + fmtSize(t.total) +
        (t.fail ? ' · <span class="ph-err">失败 ' + t.fail + ' 张</span>' : '');
      el.barProgress.classList.remove('hide');
      el.barProgressInner.style.width = pct + '%';
      el.btnStart.classList.add('hide');
      el.btnSelect.classList.add('hide');
      return;
    }

    // 空闲态：待上传与失败重试入口相互独立，避免部分失败后新选照片无法开始上传
    el.barProgress.classList.remove('hide');
    el.barProgressInner.style.width = pct + '%';
    el.btnSelect.classList.remove('hide');

    if (t.wait > 0) {
      el.btnStart.textContent = '开始上传 ' + t.wait + ' 张';
      el.btnStart.classList.remove('hide');
    } else {
      el.btnStart.classList.add('hide');
    }

    if (t.fail > 0) {
      el.btnRetry.textContent = '重试失败 ' + t.fail + ' 张';
      el.btnRetry.classList.remove('hide');
    } else {
      el.btnRetry.classList.add('hide');
    }

    if (t.wait > 0) {
      el.barInfo.innerHTML = '已选择 <b>' + t.count + '</b> 张 · 共 <b>' + fmtSize(t.total) + '</b>' +
        (t.fail ? ' · <span class="ph-err">其中 ' + t.fail + ' 张失败</span>' : '');
    } else if (t.fail > 0) {
      el.barInfo.innerHTML = '<span class="ph-ok">成功 ' + t.done + ' 张</span> · ' +
        '<span class="ph-err">失败 ' + t.fail + ' 张</span> · 可重试失败项';
    } else {
      el.barInfo.innerHTML = '<span class="ph-ok">全部上传完成</span> · 共 <b>' + t.done + '</b> 张';
    }
  }

  /* ------------------------------ 选择照片 ------------------------------ */
  el.btnSelect.onclick = function () { el.input.click(); };

  el.input.onchange = function () {
    var files = el.input.files;
    if (!files || !files.length) return;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var item = {
        file: file,
        url: URL.createObjectURL(file),
        status: 'wait',
        sent: 0,
        size: file.size,
        msg: '',
        node: null
      };
      items.push(item);
    }
    var frag = document.createDocumentFragment();
    for (var j = 0; j < items.length; j++) {
      if (!items[j].node) frag.appendChild(addCell(items[j], j));
    }
    el.grid.appendChild(frag);
    el.empty.classList.add('hide');
    el.input.value = '';           // 允许再次选择相同文件
    closing = false;
    renderBar(totals());
  };

  /* ------------------------------ 移除单张 ------------------------------ */
  function removeItem(item) {
    if (item.status === 'doing') return;   // 上传中不允许移除
    var i = items.indexOf(item);
    if (i < 0) return;
    try { URL.revokeObjectURL(item.url); } catch (e) { }
    if (item.node && item.node.parentNode) item.node.parentNode.removeChild(item.node);
    items.splice(i, 1);
    // 重建索引，保证 data-idx 与数组一致
    for (var k = 0; k < items.length; k++) {
      if (items[k].node) items[k].node.setAttribute('data-idx', k);
    }
    if (!items.length) el.empty.classList.remove('hide');
    renderBar(totals());
  }

  /* ------------------------------ 上传调度 ------------------------------ */
  function start() {
    if (running) return;
    if (!hasWaiting()) return;
    running = true;
    closing = false;
    runBase = totals();
    el.btnStart.classList.add('hide');
    el.btnRetry.classList.add('hide');
    startKeepAwake();
    renderBar(totals());
    schedule();
  }

  function schedule() {
    for (var i = 0; i < items.length && active < MAX_CONCURRENT; i++) {
      if (items[i].status === 'wait') launch(items[i]);
    }
    if (active === 0 && !hasWaiting()) onAllSettled();
  }

  function launch(item) {
    item.status = 'doing';
    item.sent = 0;
    active++;
    updateCell(item);

    var xhr = new XMLHttpRequest();
    var fd = new FormData();
    fd.append('file', item.file, item.file.name);

    xhr.open('POST', API + '?f=' + encodeURIComponent(fpath), true);
    xhr.setRequestHeader('token', token);

    xhr.upload.onprogress = function (ev) {
      if (ev.lengthComputable) {
        item.sent = ev.loaded;
        scheduleProgress();
      }
    };

    xhr.onload = function () {
      active--;
      var res = null;
      try { res = JSON.parse(xhr.responseText); } catch (e) { }

      if (res && res.code === 0) {
        item.status = 'done';
        item.sent = item.size;
      } else if (res && res.code === 401) {
        handleUnauthorized();
        return;
      } else {
        item.status = 'fail';
        item.msg = (res && res.msg) ? res.msg : ('HTTP ' + xhr.status);
      }
      updateCell(item);
      scheduleProgress();
      schedule();
    };

    xhr.onerror = xhr.ontimeout = function () {
      active--;
      item.status = 'fail';
      item.msg = '网络中断或超时';
      updateCell(item);
      scheduleProgress();
      schedule();
    };

    xhr.send(fd);
  }

  function onAllSettled() {
    running = false;
    stopKeepAwake();
    var t = totals();
    var okN = t.done - runBase.done;      // 本轮成功张数（排除历史已成功项）
    renderBar(t);
    if (t.fail > 0) {
      layer.msg(okN + ' 张成功，' + t.fail + ' 张失败', { icon: 0, time: 3000 });
      return;
    }
    if (okN > 0 && !closing) {
      closing = true;
      layer.msg('上传完成，共 ' + okN + ' 张', { icon: 1, time: 1500 });
      setTimeout(closeAndRefresh, 900);
    }
  }

  el.btnStart.onclick = start;

  el.btnRetry.onclick = function () {
    var n = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].status === 'fail') {
        items[i].status = 'wait';
        items[i].msg = '';
        updateCell(items[i]);
        n++;
      }
    }
    if (!n) return;
    layer.msg('重新上传 ' + n + ' 张');
    start();
  };

  /* ------------------------------ 鉴权失效 ------------------------------ */
  function handleUnauthorized() {
    running = false;
    stopKeepAwake();
    localStorage.removeItem('token');
    localStorage.removeItem('auth');
    layer.msg('登录已失效，即将跳转登录页', { icon: 5, time: 1500 });
    setTimeout(function () { window.location.href = LOGIN_URL; }, 1500);
  }

  /* ------------------------------ 关闭并刷新父页 ------------------------------ */
  function closeAndRefresh() {
    var closed = false;
    try {
      if (window.parent && window.parent !== window && window.parent.layer) {
        var idx = window.parent.layer.getFrameIndex(window.name);
        if (idx !== undefined && idx !== null) {
          window.parent.layer.close(idx);
          closed = true;
        }
      }
    } catch (e) { }
    if (!closed) {
      try {
        if (window.parent && window.parent !== window) window.parent.location.reload(false);
      } catch (e) { }
    }
  }

  el.btnClose.onclick = function () {
    if (running && !window.confirm('还有照片正在上传，确定要关闭吗？')) return;
    closeAndRefresh();
  };

  /* ------------------------------ 防息屏 ------------------------------ */
  var wakeLock = null;
  var noSleepUrl = null;

  // 生成 1 秒静音 WAV 的 Blob URL，避免引入外部音频资源（局域网离线可用）
  function buildSilentWavUrl() {
    var rate = 8000, samples = rate;
    var buf = new ArrayBuffer(44 + samples);
    var view = new DataView(buf);
    var wstr = function (off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); view.setUint32(4, 36 + samples, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate, true);
    view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    wstr(36, 'data'); view.setUint32(40, samples, true);
    for (var i = 0; i < samples; i++) view.setUint8(44 + i, 128);   // 8bit 静音中值
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  function startKeepAwake() {
    // 1) 标准 Wake Lock（需要 https/localhost，局域网 http 下通常不可用，失败则忽略）
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (lock) {
          wakeLock = lock;
        }).catch(function () { });
      }
    } catch (e) { }

    // 2) 兜底：循环播放静音音频，尽量保持页面活跃
    try {
      if (!noSleepUrl) noSleepUrl = buildSilentWavUrl();
      if (el.noSleepAudio.src !== noSleepUrl) el.noSleepAudio.src = noSleepUrl;
      var p = el.noSleepAudio.play();
      if (p && p.catch) p.catch(function () { });
    } catch (e) { }

    el.keepAwakeTip.classList.remove('hide');
  }

  function stopKeepAwake() {
    try {
      if (wakeLock && wakeLock.release) wakeLock.release();
    } catch (e) { }
    wakeLock = null;
    try { el.noSleepAudio.pause(); } catch (e) { }
    el.keepAwakeTip.classList.add('hide');
  }

  // 回到前台且仍在上传时，重新申请常亮
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && running) startKeepAwake();
  });

  /* ------------------------------ 微信环境引导 ------------------------------ */
  if (navigator.userAgent.toLowerCase().indexOf('micromessenger') > -1) {
    el.wxTip.classList.remove('hide');
  }
  el.btnWxKnow.onclick = function () { el.wxTip.classList.add('hide'); };

  /* ------------------------------ 初始化 ------------------------------ */
  renderBar(totals());
});

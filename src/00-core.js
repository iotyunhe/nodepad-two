/* ============================================================================
 * 00-core.js — 基础设施层
 *   职责：全局命名空间、事件总线（模块解耦 + 插件钩子载体）、通用工具函数。
 *   依赖：无（本文件必须是第一个加载的模块，且不触碰 DOM，便于 Node 单测）。
 * ========================================================================== */
(function (global) {
  'use strict';

  const NT = (global.NT = global.NT || {});
  /* 版本号：全项目唯一来源是 desktop/package.json 的 "version"。
   *   · 改版本请用 `node bump-version.js patch|minor|major|X.Y.Z`（会同时改这里）；
   *   · build.py 打包时还会用 package.json 覆盖此字面量，确保交付产物一定正确；
   *   · core.test.js 有一条断言校验此处与 package.json 一致，漂移会被测出来。*/
  NT.version = '1.0.2';

  /* ------------------------------------------------------------------ 事件总线
   * 全局单例。约定的事件名（节选）：
   *   doc:change       文档内容变更    { doc, changes }
   *   doc:dirty        脏标记变更      { doc, dirty }
   *   doc:open/close   文档生命周期
   *   view:selection   选区/光标变更   { doc, sel, active }
   *   view:render      一帧渲染完成    { doc, first, last }
   *   cmd:before/after 命令执行前后（宏引擎依赖 cmd:after 录制）
   *   plugin:loaded    插件激活完成
   * 通配监听 '*' 会收到 { event, payload }，插件借此做统一审计。
   * ------------------------------------------------------------------------ */
  class EventBus {
    constructor() {
      this._h = new Map();
      this.trace = false;
      this.log = [];
    }
    on(event, fn) {
      let set = this._h.get(event);
      if (!set) { set = new Set(); this._h.set(event, set); }
      set.add(fn);
      return () => this.off(event, fn);   // 返回取消订阅函数
    }
    off(event, fn) {
      const set = this._h.get(event);
      if (set) { set.delete(fn); if (!set.size) this._h.delete(event); }
    }
    once(event, fn) {
      const off = this.on(event, (p) => { off(); fn(p); });
      return off;
    }
    emit(event, payload) {
      if (this.trace) {
        this.log.push({ event, t: Date.now() });
        if (this.log.length > 500) this.log.shift();
      }
      const set = this._h.get(event);
      if (set) {
        // 复制一份，允许监听器内部反订阅
        for (const fn of Array.from(set)) {
          try { fn(payload, event); }
          catch (e) { console.error('[EventBus] 监听器异常 @' + event, e); }
        }
      }
      const any = this._h.get('*');
      if (any) {
        for (const fn of Array.from(any)) {
          try { fn({ event, payload }); } catch (e) { /* 忽略 */ }
        }
      }
    }
    /** 返回某事件当前的监听器数量，供调试/测试断言使用 */
    count(event) { return this._h.has(event) ? this._h.get(event).size : 0; }
    clear() { this._h.clear(); }
  }

  NT.EventBus = EventBus;
  NT.bus = new EventBus();

  /* -------------------------------------------------------------- 工具函数 */
  const util = NT.util = {
    clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),

    /** 统一的 HTML 转义：高亮层是 innerHTML 渲染的，必须严防 XSS/结构破坏 */
    esc(s) {
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    /** 把 tab 展开为空格后再交给高亮层，保证与 textarea 的列宽一致 */
    expandTabs(s, size) {
      if (s.indexOf('\t') < 0) return s;
      let out = '', col = 0;
      for (const ch of s) {
        if (ch === '\t') { const n = size - (col % size); out += ' '.repeat(n); col += n; }
        else { out += ch; col++; }
      }
      return out;
    },
    debounce(fn, ms) {
      let t = 0;
      return function (...a) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, a), ms);
      };
    },
    throttle(fn, ms) {
      let last = 0, timer = 0, lastArgs = null;
      return function (...a) {
        const now = Date.now();
        lastArgs = a;
        if (now - last >= ms) { last = now; fn.apply(this, a); }
        else if (!timer) {
          timer = setTimeout(() => {
            timer = 0; last = Date.now(); fn.apply(this, lastArgs);
          }, ms - (now - last));
        }
      };
    },
    formatBytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MB';
      return (n / 1073741824).toFixed(2) + ' GB';
    },
    isWordChar(ch) { return !!ch && /[\w$\u4e00-\u9fa5]/.test(ch); },
    /** 文件扩展名 → 语言 id */
    langFromPath(path) {
      const m = /\.([A-Za-z0-9_]+)$/.exec(path || '');
      if (!m) return 'plaintext';
      const ext = m[1].toLowerCase();
      const map = NT.LANGUAGES || {};
      for (const id in map) {
        const l = map[id];
        if (l.ext && l.ext.indexOf(ext) >= 0) return id;
      }
      return 'plaintext';
    },
    /** 简易差分：返回新旧文本的公共前缀/后缀，用于把 textarea 的整体输入
     *  还原成一次最小编辑区间，避免每次按键都全量 diff。 */
    diffRange(a, b) {
      const la = a.length, lb = b.length, min = Math.min(la, lb);
      let p = 0;
      while (p < min && a.charCodeAt(p) === b.charCodeAt(p)) p++;
      let s = 0;
      while (s < min - p && a.charCodeAt(la - 1 - s) === b.charCodeAt(lb - 1 - s)) s++;
      return { start: p, oldEnd: la - s, newEnd: lb - s };
    },
    /** 带二分的「最后一个 <= x 的下标」，行/偏移换算的高频路径 */
    lowerBound(arr, x, lo, hi) {
      lo = lo === undefined ? 0 : lo;
      hi = hi === undefined ? arr.length : hi;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] <= x) lo = mid + 1; else hi = mid;
      }
      return lo - 1;
    },
    /** 把秒数格式化为 m:ss */
    fmtTime(sec) {
      const m = Math.floor(sec / 60), s = sec % 60;
      return m + ':' + String(s).padStart(2, '0');
    }
  };

  /* --------------------------------------------------------- 简易 LRU 缓存 */
  class LRU {
    constructor(cap) { this.cap = cap; this.map = new Map(); }
    get(k) {
      if (!this.map.has(k)) return undefined;
      const v = this.map.get(k);
      this.map.delete(k); this.map.set(k, v);
      return v;
    }
    set(k, v) {
      if (this.map.has(k)) this.map.delete(k);
      this.map.set(k, v);
      if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value);
    }
    has(k) { return this.map.has(k); }
    clear() { this.map.clear(); }
    get size() { return this.map.size; }
  }
  NT.LRU = LRU;

  /* ------------------------------------------------------- 微任务让步调度器
   * 大文件解析必须切片执行并主动让出主线程，否则页面会卡死。
   *
   * 为什么不能只用 requestAnimationFrame：
   *   rAF 只在页面「可见且需要绘制」时触发。标签页切到后台、或运行在无头浏览器里时，
   *   rAF 会被节流到 1Hz 甚至完全停摆 —— 此时基于 rAF 的让步会让分片加载近乎卡死
   *   （实测 100 万行/37MB 场景下会从 ~1s 退化到 300s 以上）。
   *
   * 因此策略为：
   *   1) 优先 scheduler.yield()（Chromium 原生，语义最准确）
   *   2) 页面可见 → rAF + setTimeout（保证真的绘制了一帧，进度条能动）
   *   3) 页面不可见 → MessageChannel（宏任务让步，无 4ms 钳制，不受可见性影响）
   *   4) 兜底 setTimeout(0)
   * ---------------------------------------------------------------------- */
  const _mc = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
  const _mcQueue = [];
  if (_mc) _mc.port1.onmessage = () => { const fn = _mcQueue.shift(); if (fn) fn(); };

  NT.yieldToUI = function yieldToUI() {
    return new Promise((resolve) => {
      if (global.scheduler && typeof global.scheduler.yield === 'function') {
        global.scheduler.yield().then(resolve, resolve);
        return;
      }
      const doc = global.document;
      const visible = !doc || doc.hidden === false;
      if (visible && typeof global.requestAnimationFrame === 'function') {
        global.requestAnimationFrame(() => global.setTimeout(resolve, 0));
        return;
      }
      if (_mc) { _mcQueue.push(resolve); _mc.port2.postMessage(0); return; }
      setTimeout(resolve, 0);
    });
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);

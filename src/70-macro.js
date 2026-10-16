/* ============================================================================
 * 70-macro.js — 宏录制与回放
 *
 * 设计原则：宏记录的是「语义化命令」而不是「按键」或「字符偏移」。
 *   · 记录按键：无法跨键盘布局/输入法，且回放时依赖焦点状态。
 *   · 记录字符偏移：文档一变就错位。
 *   · 记录语义命令（insertText / deleteBackward / replaceAll / gotoLine…）：
 *     回放时基于「当前光标位置」重新执行，鲁棒性最好，这也是 Notepad++ 的做法。
 *
 * 所有编辑类命令都必须走 app.exec() 才能被录到——这是本项目的一条硬约定，
 * 因此输入框里的每次按键都会先被还原成语义操作（见 onViewInput）。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});

  /** 回放时跳过这些命令，避免宏把"录制/回放"自身也录进去造成递归 */
  const NEVER_RECORD = new Set([
    'macro.record.start', 'macro.record.stop', 'macro.play', 'macro.playNamed',
    'file.new', 'file.open', 'file.save', 'file.saveAs', 'app.quit',
    'plugin.toggle', 'ui.palette', 'ui.theme'
  ]);

  class MacroEngine {
    constructor(app) {
      this.app = app;
      this.recording = false;
      this.playing = false;
      this.steps = [];               // 正在录制的步骤
      this.macros = new Map();       // name -> steps[]
      this.currentName = null;
      this._prevCaret = 0;
      this._abort = false;
      this._listeners = new Set();

      // 文本输入（含输入法、粘贴）统一还原成语义编辑操作
      NT.bus.on('view:input', (p) => this._onViewInput(p));
      NT.bus.on('view:selection', (p) => {
        const doc = this.app.activeDoc;
        if (doc && p.doc === doc) this._prevCaret = doc.sel.head;
      });
    }

    on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _notify() { for (const f of this._listeners) f(this); }

    /* ------------------------------------------------------------ 录制 */
    start(name) {
      if (this.recording) return false;
      this.recording = true;
      this.steps = [];
      this.currentName = name || null;
      NT.bus.emit('macro:state', { recording: true, playing: false, steps: 0 });
      this._notify();
      return true;
    }

    stop() {
      if (!this.recording) return null;
      this.recording = false;
      const steps = this.steps;
      this.steps = [];
      let name = this.currentName;
      if (!name) name = '宏 ' + (this.macros.size + 1) + '（' + steps.length + ' 步）';
      this.macros.set(name, steps);
      this.currentName = null;
      NT.bus.emit('macro:state', { recording: false, playing: false, steps: steps.length });
      NT.bus.emit('macro:recorded', { name, steps: steps.length });
      this._notify();
      return { name, steps };
    }

    _record(id, args) {
      if (!this.recording || this.playing) return;
      if (NEVER_RECORD.has(id)) return;
      this.steps.push({ id, args: args ? JSON.parse(JSON.stringify(args)) : undefined });
      NT.bus.emit('macro:state', { recording: true, playing: false, steps: this.steps.length });
    }

    /** 把一次输入差分翻译成语义编辑操作 */
    _onViewInput(p) {
      if (!this.recording || this.playing) return;
      const ch = p.change;
      if (!ch) return;
      const removed = Math.max(0, ch.end - ch.start);
      if (removed === 0 && ch.text) {
        this._record('edit.insertText', { text: ch.text });
      } else if (removed > 0 && !ch.text) {
        // 方向：编辑前光标在区间尾部 → 退格；在头部 → 删除
        const dir = this._prevCaret >= ch.end ? 'back' : 'forward';
        this._record('edit.delete', { len: removed, dir });
      } else if (ch.text) {
        this._record('edit.replace', { len: removed, text: ch.text });
      }
      this._prevCaret = ch.start + (ch.text ? ch.text.length : 0);
    }

    /* ------------------------------------------------------------ 回放 */
    /**
     * @param {string} name 宏名
     * @param {object} opt {times, loop, delay, onStep}
     */
    async play(name, opt) {
      opt = opt || {};
      const steps = this.macros.get(name);
      if (!steps) return { ok: false, error: '宏不存在：' + name };
      if (this.playing) return { ok: false, error: '正在回放中' };

      const times = Math.max(1, opt.times || 1);
      const delay = opt.delay === undefined ? (this.app.settings.macroDelay || 0) : opt.delay;
      this.playing = true;
      this._abort = false;
      NT.bus.emit('macro:state', { recording: false, playing: true, steps: steps.length, name });
      this._notify();

      const doc = this.app.activeDoc;
      // 整段回放合并成一次撤销单元
      if (doc) doc.beginBatch('宏回放：' + name);
      let executed = 0;
      try {
        for (let round = 0; round < times && !this._abort; round++) {
          for (let i = 0; i < steps.length; i++) {
            if (this._abort) break;
            const st = steps[i];
            this.app.exec(st.id, st.args, { fromMacro: true });
            executed++;
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            else if (i % 40 === 39) await NT.yieldToUI();
            if (opt.onStep) opt.onStep(i + 1, steps.length, round + 1, times);
          }
        }
      } catch (e) {
        console.error('[Macro] 回放异常', e);
        this.app.toast('宏回放出错：' + e.message, 'err');
      } finally {
        if (doc) doc.endBatch();
        this.playing = false;
        NT.bus.emit('macro:state', { recording: false, playing: false, steps: steps.length, name });
        this._notify();
      }
      return { ok: true, executed, times };
    }

    stopPlayback() { this._abort = true; }

    /* ------------------------------------------------------------ 管理 */
    list() {
      return Array.from(this.macros.entries()).map(([name, steps]) => ({ name, steps: steps.length }));
    }
    rename(oldName, newName) {
      if (!this.macros.has(oldName) || !newName) return false;
      const v = this.macros.get(oldName);
      this.macros.delete(oldName);
      this.macros.set(newName, v);
      this._notify();
      return true;
    }
    remove(name) { const r = this.macros.delete(name); this._notify(); return r; }
    get(name) { return this.macros.get(name) || null; }

    /** 导出为可读 JSON（便于分享/版本管理） */
    exportJson() {
      return JSON.stringify({
        format: 'notepad-two-macro',
        version: 1,
        macros: Array.from(this.macros.entries()).map(([name, steps]) => ({ name, steps }))
      }, null, 2);
    }
    importJson(text, mode) {
      let data;
      try { data = JSON.parse(text); }
      catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message }; }
      if (!data || !Array.isArray(data.macros)) return { ok: false, error: '缺少 macros 字段' };
      let n = 0;
      for (const m of data.macros) {
        if (!m || typeof m.name !== 'string' || !Array.isArray(m.steps)) continue;
        let name = m.name;
        if (mode !== 'overwrite' && this.macros.has(name)) name = name + ' (导入)';
        this.macros.set(name, m.steps);
        n++;
      }
      this._notify();
      return { ok: true, count: n };
    }
  }

  NT.MacroEngine = MacroEngine;
  NT.MacroEngine.NEVER_RECORD = NEVER_RECORD;

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);

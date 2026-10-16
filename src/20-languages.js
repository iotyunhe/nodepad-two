/* ============================================================================
 * 20-languages.js — 语法高亮 / 词法分析层
 *
 * 架构：一条「带跨行状态的规则式分词器」+ 一份纯数据语言定义表。
 *   · 语言定义 = 有序规则数组。规则是 {t: 语义类型, re: 粘性正则, if/set: 上下文钩子}
 *     顺序敏感：先匹配者胜出，因此注释/字符串必须排在最前。
 *   · 跨行状态 state = { block: {close, type} }，用于块注释、三引号字符串、代码围栏。
 *     分词器是纯函数：tokenize(lang, line, stateIn) → { tokens, stateOut }，
 *     因此可以在「可见行虚拟化」的前提下按需增量计算，无需全量扫描。
 *   · ctx 是「行内上下文」，用于 HTML 这类词法上需要看前一个 token 才能判定的语言。
 *
 * 性能约定（渲染层依赖）：
 *   · 超长行（> MAX_LINE_SCAN）只扫描前 N 个字符，其余按纯文本处理，
 *     避免压缩过的单行 JS/CSS 拖垮渲染帧。
 *   · 返回值 tokens 保证对 [0, line.length) 无空洞、无重叠，可直接拼 HTML。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NT = global.NT || (global.NT = {});

  const MAX_LINE_SCAN = 4000;
  const INITIAL = Object.freeze({ block: null });

  /* ------------------------------------------------------------ 规则构造器 */
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const R = {
    ws: () => ({ t: 'ws', re: /\s+/y }),
    lineComment: (mark) => ({ t: 'comment', re: new RegExp(escRe(mark) + '[^\\n]*', 'y') }),
    blockComment: (open, close) => ({ t: 'comment', open, close, block: true }),
    keyword: (words) => ({ t: 'keyword', re: new RegExp('(?:' + words.join('|') + ')\\b', 'y') }),
    word: (type, words) => ({ t: type, re: new RegExp('(?:' + words.join('|') + ')\\b', 'y') }),
    str: (q) => ({ t: 'string', re: new RegExp(q + '(?:\\\\[\\s\\S]|[^' + q + '\\\\])*' + q, 'y') }),
    template: () => ({ t: 'string', re: /`(?:\\[\s\S]|[^`\\])*`/y }),
    number: () => ({
      t: 'number',
      re: /\b(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[nNfFlLdDmMuU]*\b/y
    }),
    funcCall: () => ({ t: 'func', re: /[A-Za-z_$][\w$]*(?=\s*\()/y }),
    ident: () => ({ t: 'var', re: /[A-Za-z_$\u00c0-\uffff][\w$\u00c0-\uffff]*/y }),
    punct: (s) => ({ t: 'punct', re: new RegExp('[' + escRe(s).replace(/\\-/g, '\\-') + ']', 'y') }),
    op: (re) => ({ t: 'op', re })
  };

  /* 把语言定义里的 block 规则编译成粘性正则（只匹配开标记） */
  function compile(lang) {
    const rules = [];
    for (const r of lang.rules || []) {
      if (r.block) {
        rules.push({
          t: r.t, open: r.open, close: r.close, block: true,
          re: new RegExp(escRe(r.open), 'y')
        });
      } else {
        rules.push(r);
      }
    }
    lang._rules = rules;
    return lang;
  }

  /* ---------------------------------------------------------------- 分词器 */
  /**
   * @param {object} lang 语言定义（内部 _rules 已编译）
   * @param {string} line 单行文本（不含换行符）
   * @param {object} stateIn 上一行遗留状态
   * @returns {{tokens: Array<{s:number,e:number,t:string}>, state: object}}
   */
  function tokenize(lang, line, stateIn) {
    const tokens = [];
    const state = stateIn || INITIAL;
    const rules = lang._rules;
    if (!rules || !rules.length) return { tokens: line ? [{ s: 0, e: line.length, t: 'var' }] : [], state };

    let n = line.length;
    if (n > MAX_LINE_SCAN) n = MAX_LINE_SCAN;   // 超长行截断扫描
    let i = 0;
    let block = state.block;
    const ctx = {};

    // (1) 延续上一行未闭合的块（块注释 / 三引号 / 代码围栏）
    if (block) {
      const idx = line.indexOf(block.close, 0);
      if (idx < 0) {
        if (n) tokens.push({ s: 0, e: n, t: block.type });
        if (n < line.length) tokens.push({ s: n, e: line.length, t: 'var' });
        return { tokens, state: { block } };
      }
      const end = idx + block.close.length;
      tokens.push({ s: 0, e: end, t: block.type });
      i = end;
      block = null;
    }

    const nRules = rules.length;
    while (i < n) {
      let matched = false;
      for (let k = 0; k < nRules; k++) {
        const r = rules[k];
        if (r.if && !r.if(ctx)) continue;
        r.re.lastIndex = i;
        const m = r.re.exec(line);
        if (!m || m.index !== i) continue;

        if (r.block) {
          // 需要跨行延续的规则：找闭合标记
          const searchFrom = i + r.open.length;
          const ci = line.indexOf(r.close, searchFrom);
          if (ci < 0 || ci >= n) {
            tokens.push({ s: i, e: n, t: r.t });
            if (n < line.length) tokens.push({ s: n, e: line.length, t: 'var' });
            return { tokens, state: { block: { close: r.close, type: r.t } } };
          }
          const end = ci + r.close.length;
          tokens.push({ s: i, e: end, t: r.t });
          i = end;
        } else {
          const end = i + m[0].length;
          tokens.push({ s: i, e: end, t: r.t });
          i = end;
        }
        if (r.set) r.set(ctx, m);
        matched = true;
        break;
      }
      if (!matched) { tokens.push({ s: i, e: i + 1, t: 'var' }); i++; }
    }
    // 超长行尾部按纯文本补齐，保证 token 覆盖完整
    if (n < line.length) tokens.push({ s: n, e: line.length, t: 'var' });

    return { tokens, state: { block } };
  }

  /* ================================================================ 语言表 */

  const JS_KEYWORDS = ['as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
    'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
    'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of',
    'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
    'void', 'while', 'with', 'yield'];
  const JS_LITERALS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'];
  const JS_BUILTINS = ['Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Map', 'Math',
    'Number', 'Object', 'Promise', 'Proxy', 'RegExp', 'Set', 'String', 'Symbol', 'WeakMap',
    'WeakSet', 'BigInt', 'console', 'document', 'window', 'globalThis', 'process', 'require',
    'module', 'exports', 'Buffer', 'setTimeout', 'setInterval', 'clearTimeout', 'fetch',
    'localStorage', 'sessionStorage', 'Intl', 'Reflect', 'Atomics', 'ArrayBuffer', 'Uint8Array'];

  function jsRules() {
    return [
      R.ws(),
      R.lineComment('//'),
      R.blockComment('/*', '*/'),
      R.template(),
      R.str('"'), R.str("'"),
      R.number(),
      R.keyword(JS_KEYWORDS),
      R.word('keyword', JS_LITERALS),
      R.word('builtin', JS_BUILTINS),
      R.funcCall(),
      R.ident(),
      R.punct('{}[]();,.'),
      R.op(/=>|\.\.\.|[+\-*/%=<>!&|^~?:]+/y)
    ];
  }

  function cLikeRules(keywords, types, literals, extra) {
    const rules = [
      R.ws(),
      R.lineComment('//'),
      R.blockComment('/*', '*/'),
      R.str('"'), R.str("'"),
      R.number(),
      R.keyword(keywords),
      R.word('type', types),
      R.word('keyword', literals),
      R.funcCall(),
      R.ident(),
      R.punct('{}[]();,.'),
      R.op(/->|::|<<=?|>>=?|[+\-*/%=<>!&|^~?:]+/y)
    ];
    return extra ? extra.concat(rules) : rules;
  }

  const LANGS = {};

  function def(id, cfg) { LANGS[id] = compile(Object.assign({ id }, cfg)); }

  def('plaintext', { name: '纯文本', ext: [], rules: [] });

  def('javascript', {
    name: 'JavaScript', ext: ['js', 'mjs', 'cjs', 'jsx'],
    comment: { line: '//', block: ['/*', '*/'] },
    keywords: JS_KEYWORDS, builtins: JS_BUILTINS,
    rules: jsRules()
  });

  def('typescript', {
    name: 'TypeScript', ext: ['ts', 'tsx', 'mts', 'cts'],
    comment: { line: '//', block: ['/*', '*/'] },
    keywords: JS_KEYWORDS.concat(['abstract', 'declare', 'enum', 'implements', 'interface',
      'is', 'keyof', 'namespace', 'private', 'protected', 'public', 'readonly', 'satisfies',
      'type', 'infer', 'asserts', 'override', 'module']),
    builtins: JS_BUILTINS.concat(['Partial', 'Required', 'Readonly', 'Record', 'Pick', 'Omit',
      'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Awaited', 'any', 'unknown', 'never',
      'void', 'string', 'number', 'boolean', 'object', 'symbol', 'bigint']),
    rules: jsRules()
  });

  def('python', {
    name: 'Python', ext: ['py', 'pyw', 'pyi'],
    comment: { line: '#' },
    rules: [
      R.ws(),
      R.lineComment('#'),
      // 三引号字符串需要跨行，放在普通字符串之前
      { t: 'string', open: '"""', close: '"""', block: true },
      { t: 'string', open: "'''", close: "'''", block: true },
      { t: 'string', re: /(?:[rRbBuUfF]{0,2})"(?:\\[\s\S]|[^"\\])*"/y },
      { t: 'string', re: /(?:[rRbBuUfF]{0,2})'(?:\\[\s\S]|[^'\\])*'/y },
      R.number(),
      R.keyword(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
        'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import',
        'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
        'while', 'with', 'yield', 'match', 'case']),
      R.word('keyword', ['True', 'False', 'None', 'NotImplemented', 'Ellipsis']),
      R.word('builtin', ['abs', 'all', 'any', 'bin', 'bool', 'bytes', 'callable', 'chr',
        'classmethod', 'compile', 'complex', 'dict', 'dir', 'divmod', 'enumerate', 'eval',
        'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr',
        'hash', 'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
        'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object', 'oct',
        'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round',
        'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple',
        'type', 'vars', 'zip', 'self', 'cls']),
      { t: 'func', re: /[A-Za-z_]\w*(?=\s*\()/y },
      R.ident(),
      R.punct('{}[]();,.:'),
      R.op(/->|:=|[+\-*/%=<>!&|^~@]+/y)
    ]
  });

  def('html', {
    name: 'HTML', ext: ['html', 'htm', 'vue', 'svelte', 'xhtml'],
    comment: { block: ['<!--', '-->'] },
    rules: [
      { t: 'comment', open: '<!--', close: '-->', block: true },
      R.ws(),
      { t: 'type', re: /<!DOCTYPE[^>]*>/iy },
      { t: 'punct', re: /<\/?/y, set: (c) => { c.inTag = true; c.first = true; } },
      { t: 'punct', re: />/y, set: (c) => { c.inTag = false; } },
      { t: 'punct', re: /\/>/y, set: (c) => { c.inTag = false; } },
      { t: 'tag', re: /[a-zA-Z][\w:.-]*/y, if: (c) => c.inTag && c.first, set: (c) => { c.first = false; } },
      { t: 'attr', re: /[a-zA-Z_:@#][\w:.-]*/y, if: (c) => c.inTag && !c.first },
      { t: 'string', re: /"[^"]*"|'[^']*'/y },
      { t: 'op', re: /=/y },
      { t: 'var', re: /[^<>&]+/y },
      { t: 'punct', re: /[<>&]/y }
    ]
  });

  def('xml', {
    name: 'XML', ext: ['xml', 'svg', 'xsl', 'xslt', 'plist', 'csproj'],
    comment: { block: ['<!--', '-->'] },
    rules: LANGS.html.rules
  });

  def('css', {
    name: 'CSS', ext: ['css', 'scss', 'less', 'sass'],
    comment: { block: ['/*', '*/'] },
    rules: [
      R.ws(),
      R.blockComment('/*', '*/'),
      { t: 'keyword', re: /@[\w-]+/y },
      { t: 'keyword', re: /::?[\w-]+/y },
      { t: 'number', re: /#[0-9a-fA-F]{3,8}\b/y },
      { t: 'type', re: /\.[-\w]+|#[\w-]+/y },
      { t: 'attr', re: /[-\w]+(?=\s*:)/y },
      { t: 'string', re: /"[^"]*"|'[^']*'/y },
      { t: 'func', re: /[-\w]+(?=\()/y },
      { t: 'number', re: /-?\d*\.?\d+(?:[a-zA-Z%]{1,4})?/y },
      { t: 'keyword', re: /\b(?:important|inherit|initial|unset|revert|auto|none|block|flex|grid|absolute|relative|fixed|sticky|hidden|visible|solid|dashed|dotted|bold|italic|normal|center|left|right|top|bottom|nowrap|wrap|pointer|transparent)\b/y },
      R.ident(),
      R.punct('{}[]();,>+~*'),
      R.op(/[:=]/y)
    ]
  });

  def('json', {
    name: 'JSON', ext: ['json', 'jsonc', 'geojson', 'webmanifest'],
    comment: { line: '//' },
    rules: [
      R.ws(), R.lineComment('//'), R.blockComment('/*', '*/'),
      R.str('"'),
      R.number(),
      R.word('keyword', ['true', 'false', 'null']),
      R.punct('{}[],:'),
      R.ident()
    ]
  });

  def('markdown', {
    name: 'Markdown', ext: ['md', 'markdown', 'mdx'],
    comment: {},
    rules: [
      { t: 'comment', open: '```', close: '```', block: true },
      { t: 'string', re: /`[^`\n]+`/y },
      { t: 'heading', re: /#{1,6}\s.*$/y },
      { t: 'keyword', re: /^\s*(?:[-*+]|\d+\.)\s/y },
      { t: 'comment', re: /^\s*>\s?.*$/y },
      { t: 'op', re: /^\s*(?:[-*_]\s*){3,}$/y },
      { t: 'bold', re: /\*\*[^*\n]+\*\*|__[^_\n]+__/y },
      { t: 'italic', re: /\*[^*\n]+\*|_[^_\n]+_/y },
      { t: 'link', re: /!?\[[^\]\n]*\]\([^)\n]*\)/y },
      { t: 'link', re: /<https?:\/\/[^>\s]+>/y },
      { t: 'var', re: /[^\s`*_#[\]()>]+/y },
      R.ws(),
      { t: 'punct', re: /./y }
    ]
  });

  def('c', {
    name: 'C', ext: ['c', 'h'],
    comment: { line: '//', block: ['/*', '*/'] },
    keywords: ['auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else', 'enum',
      'extern', 'for', 'goto', 'if', 'inline', 'register', 'restrict', 'return', 'sizeof',
      'static', 'struct', 'switch', 'typedef', 'union', 'volatile', 'while', '_Bool',
      '_Complex', '_Static_assert'],
    types: ['char', 'double', 'float', 'int', 'long', 'short', 'signed', 'unsigned', 'void',
      'size_t', 'ssize_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
      'uint32_t', 'uint64_t', 'FILE', 'bool', 'wchar_t'],
    rules: cLikeRules(
      ['auto', 'break', 'case', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extern',
        'for', 'goto', 'if', 'inline', 'register', 'restrict', 'return', 'sizeof', 'static',
        'struct', 'switch', 'typedef', 'union', 'volatile', 'while', '_Bool', '_Complex',
        '_Static_assert', 'NULL', 'true', 'false'],
      ['char', 'double', 'float', 'int', 'long', 'short', 'signed', 'unsigned', 'void',
        'size_t', 'ssize_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
        'uint32_t', 'uint64_t', 'FILE', 'bool', 'wchar_t'],
      [],
      [{ t: 'comment', re: /^\s*#\s*\w+/y }, { t: 'string', re: /<[\w./]+>/y }]
    )
  });

  def('cpp', {
    name: 'C++', ext: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ipp'],
    comment: { line: '//', block: ['/*', '*/'] },
    rules: cLikeRules(
      ['alignas', 'alignof', 'auto', 'break', 'case', 'catch', 'class', 'co_await',
        'co_return', 'co_yield', 'concept', 'const', 'consteval', 'constexpr', 'constinit',
        'const_cast', 'continue', 'decltype', 'default', 'delete', 'do', 'dynamic_cast',
        'else', 'enum', 'explicit', 'export', 'extern', 'final', 'for', 'friend', 'goto',
        'if', 'inline', 'mutable', 'namespace', 'new', 'noexcept', 'operator', 'override',
        'private', 'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'return',
        'sizeof', 'static', 'static_assert', 'static_cast', 'struct', 'switch', 'template',
        'this', 'thread_local', 'throw', 'try', 'typedef', 'typeid', 'typename', 'union',
        'using', 'virtual', 'volatile', 'while', 'nullptr', 'true', 'false'],
      ['bool', 'char', 'char8_t', 'char16_t', 'char32_t', 'double', 'float', 'int', 'long',
        'short', 'signed', 'unsigned', 'void', 'wchar_t', 'size_t', 'string', 'vector', 'map',
        'set', 'unordered_map', 'unordered_set', 'shared_ptr', 'unique_ptr', 'optional',
        'variant', 'tuple', 'pair', 'array', 'span', 'function', 'istream', 'ostream',
        'iostream', 'string_view', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t',
        'uint16_t', 'uint32_t', 'uint64_t'],
      [],
      [{ t: 'comment', re: /^\s*#\s*\w+/y }, { t: 'string', re: /<[\w./]+>/y }]
    )
  });

  def('java', {
    name: 'Java', ext: ['java'],
    comment: { line: '//', block: ['/*', '*/'] },
    rules: cLikeRules(
      ['abstract', 'assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
        'do', 'else', 'enum', 'exports', 'extends', 'final', 'finally', 'for', 'goto', 'if',
        'implements', 'import', 'instanceof', 'interface', 'module', 'native', 'new',
        'package', 'private', 'protected', 'public', 'record', 'requires', 'return', 'sealed',
        'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
        'transient', 'try', 'var', 'volatile', 'while', 'yield', 'true', 'false', 'null'],
      ['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void', 'String',
        'Object', 'Integer', 'Long', 'Double', 'Boolean', 'Character', 'List', 'ArrayList',
        'Map', 'HashMap', 'Set', 'HashSet', 'Optional', 'Stream', 'Exception', 'Runnable'],
      []
    )
  });

  def('csharp', {
    name: 'C#', ext: ['cs', 'csx'],
    comment: { line: '//', block: ['/*', '*/'] },
    rules: cLikeRules(
      ['abstract', 'as', 'async', 'await', 'base', 'break', 'case', 'catch', 'checked', 'class',
        'const', 'continue', 'default', 'delegate', 'do', 'else', 'enum', 'event', 'explicit',
        'extern', 'finally', 'fixed', 'for', 'foreach', 'goto', 'if', 'implicit', 'in',
        'interface', 'internal', 'is', 'lock', 'namespace', 'new', 'operator', 'out',
        'override', 'params', 'private', 'protected', 'public', 'readonly', 'record', 'ref',
        'return', 'sealed', 'sizeof', 'stackalloc', 'static', 'struct', 'switch', 'this',
        'throw', 'try', 'typeof', 'unchecked', 'unsafe', 'using', 'virtual', 'volatile',
        'while', 'yield', 'var', 'true', 'false', 'null', 'when', 'where', 'nameof'],
      ['bool', 'byte', 'char', 'decimal', 'double', 'float', 'int', 'long', 'object', 'sbyte',
        'short', 'string', 'uint', 'ulong', 'ushort', 'void', 'dynamic', 'List', 'Dictionary',
        'Task', 'Span', 'IEnumerable', 'Exception'],
      []
    )
  });

  def('go', {
    name: 'Go', ext: ['go'],
    comment: { line: '//', block: ['/*', '*/'] },
    rules: cLikeRules(
      ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
        'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range',
        'return', 'select', 'struct', 'switch', 'type', 'var', 'true', 'false', 'nil', 'iota'],
      ['bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int',
        'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16',
        'uint32', 'uint64', 'uintptr', 'any'],
      []
    )
  });

  def('rust', {
    name: 'Rust', ext: ['rs'],
    comment: { line: '//', block: ['/*', '*/'] },
    rules: cLikeRules(
      ['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
        'extern', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move',
        'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait',
        'type', 'unsafe', 'use', 'where', 'while', 'true', 'false', 'None', 'Some', 'Ok',
        'Err'],
      ['bool', 'char', 'f32', 'f64', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'str',
        'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'String', 'Vec', 'Option', 'Result',
        'Box', 'Rc', 'Arc', 'HashMap', 'HashSet', 'RefCell'],
      []
    )
  });

  def('sql', {
    name: 'SQL', ext: ['sql', 'ddl', 'dml'],
    comment: { line: '--', block: ['/*', '*/'] },
    rules: [
      R.ws(), R.lineComment('--'), R.blockComment('/*', '*/'),
      R.str("'"), R.str('"'), R.str('`'),
      R.number(),
      { t: 'keyword', re: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|ON|AS|AND|OR|NOT|NULL|IS|IN|LIKE|BETWEEN|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|UNIQUE|CHECK|CONSTRAINT|IF|EXISTS|BEGIN|COMMIT|ROLLBACK|TRANSACTION|WITH|RECURSIVE|ASC|DESC|COUNT|SUM|AVG|MIN|MAX|COALESCE|CAST|OVER|PARTITION|WINDOW|RETURNING|USING|CROSS|NATURAL|EXPLAIN|ANALYZE|VACUUM|TRUNCATE)\b/iy },
      R.funcCall(),
      R.ident(),
      R.punct('();,.*'),
      R.op(/[<>=!+\-/%|]+/y)
    ]
  });

  def('shell', {
    name: 'Shell', ext: ['sh', 'bash', 'zsh', 'fish', 'ksh'],
    comment: { line: '#' },
    rules: [
      R.ws(),
      R.lineComment('#'),
      { t: 'string', re: /"(?:\\[\s\S]|[^"\\])*"/y },
      { t: 'string', re: /'[^']*'/y },
      { t: 'builtin', re: /\$\{[^}]*\}|\$[\w@*#?$!-]+/y },
      { t: 'keyword', re: /^\s*(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|function|in|select|time|coproc)\b/y },
      R.word('keyword', ['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do',
        'done', 'case', 'esac', 'function', 'in', 'select', 'return', 'exit', 'local',
        'export', 'readonly', 'declare', 'shift', 'break', 'continue', 'true', 'false']),
      R.word('builtin', ['echo', 'printf', 'read', 'cd', 'pwd', 'ls', 'cp', 'mv', 'rm', 'mkdir',
        'rmdir', 'touch', 'cat', 'grep', 'sed', 'awk', 'find', 'xargs', 'sort', 'uniq', 'head',
        'tail', 'wc', 'cut', 'tr', 'tee', 'chmod', 'chown', 'ps', 'kill', 'export', 'source',
        'test', 'set', 'unset', 'env', 'which', 'git', 'npm', 'node', 'python', 'curl', 'wget']),
      { t: 'op', re: /-{1,2}[\w-]+/y },
      R.ident(),
      R.punct('{}[]();,&'),
      R.op(/[|&<>=!]+/y)
    ]
  });

  def('yaml', {
    name: 'YAML', ext: ['yml', 'yaml'],
    comment: { line: '#' },
    rules: [
      R.ws(),
      R.lineComment('#'),
      { t: 'punct', re: /^---\s*$|^\.\.\.\s*$/y },
      { t: 'attr', re: /^[ \t-]*[\w.$-]+(?=\s*:)/y },
      { t: 'keyword', re: /[&*!][\w-]+/y },
      { t: 'builtin', re: /\{\{[^}]*\}\}/y },
      { t: 'string', re: /"[^"]*"|'[^']*'/y },
      R.number(),
      R.word('keyword', ['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']),
      { t: 'punct', re: /[:|>?[\]{},-]/y },
      R.ident(),
      { t: 'punct', re: /./y }
    ]
  });

  def('ini', {
    name: 'INI / TOML', ext: ['ini', 'conf', 'cfg', 'toml', 'properties', 'env'],
    comment: { line: '#' },
    rules: [
      R.ws(),
      R.lineComment('#'),
      R.lineComment(';'),
      { t: 'heading', re: /^\s*\[[^\]]*\]/y },
      { t: 'attr', re: /^\s*[\w.$-]+(?=\s*[=:])/y },
      { t: 'string', re: /"[^"]*"|'[^']*'/y },
      R.number(),
      R.word('keyword', ['true', 'false', 'null']),
      { t: 'punct', re: /[=:,.{}[\]]/y },
      R.ident()
    ]
  });

  /* ------------------------------------------------------------ 注册表 API */
  const registry = {
    INITIAL,
    MAX_LINE_SCAN,
    tokenize,
    def: (id, cfg) => { def(id, cfg); NT.LANGUAGES = LANGS; return LANGS[id]; },
    get(id) { return LANGS[id] || LANGS.plaintext; },
    has(id) { return !!LANGS[id]; },
    list() {
      return Object.keys(LANGS)
        .map((id) => ({ id, name: LANGS[id].name, ext: LANGS[id].ext || [] }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    /**
     * 从语言的分词规则里反向提取词表（关键字/内置/类型）。
     * 好处：补全的词表与高亮完全同源，永远同步；插件自定义语言也自动获得补全，
     * 不需要额外声明 keywords 字段。
     * 只识别「纯字面量交替」形态的规则，例如 (?:const|let|var)\b —— 这正是
     * R.keyword() / R.word() 生成的形状。
     */
    words(langOrId, type) {
      const lang = typeof langOrId === 'string' ? LANGS[langOrId] : langOrId;
      if (!lang) return [];
      const cacheKey = '_w_' + type;
      if (lang[cacheKey]) return lang[cacheKey];
      const out = [];
      for (const r of lang._rules || []) {
        if (r.t !== type || !r.re || !r.re.source) continue;
        const m = /^(?:\\b)?\(\?:([^()]+)\)\\b$/.exec(r.re.source);
        if (!m) continue;
        for (const w of m[1].split('|')) {
          if (/^[A-Za-z_$][\w$]*$/.test(w)) out.push(w);
        }
      }
      lang[cacheKey] = out;
      return out;
    },
    /** 语法着色类型 → CSS 类名。bold/italic 是 Markdown 语义，映射到复合类 */
    className(t) {
      switch (t) {
        case 'ws': return '';
        case 'bold': return 'tk-bold';
        case 'italic': return 'tk-italic';
        default: return 'tk-' + t;
      }
    }
  };

  NT.languages = registry;
  NT.LANGUAGES = LANGS;

  if (typeof module !== 'undefined' && module.exports) module.exports = NT;
})(typeof window !== 'undefined' ? window : globalThis);

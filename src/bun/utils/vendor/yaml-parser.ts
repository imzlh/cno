// @ts-nocheck
// yaml@2.9.1 parser; regenerate: node cno/scripts/vendor-yaml.mjs
/*
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
*/
// yaml/nodes/identity.js
var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias"), DOC = /* @__PURE__ */ Symbol.for("yaml.document"), MAP = /* @__PURE__ */ Symbol.for("yaml.map"), PAIR = /* @__PURE__ */ Symbol.for("yaml.pair"), SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar"), SEQ = /* @__PURE__ */ Symbol.for("yaml.seq"), NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type"), isAlias = (node) => !!node && typeof node == "object" && node[NODE_TYPE] === ALIAS, isDocument = (node) => !!node && typeof node == "object" && node[NODE_TYPE] === DOC, isMap = (node) => !!node && typeof node == "object" && node[NODE_TYPE] === MAP, isPair = (node) => !!node && typeof node == "object" && node[NODE_TYPE] === PAIR, isScalar = (node) => !!node && typeof node == "object" && node[NODE_TYPE] === SCALAR, isSeq = (node) => !!node && typeof node == "object" && node[NODE_TYPE] === SEQ;
function isCollection(node) {
  if (node && typeof node == "object")
    switch (node[NODE_TYPE]) {
      case MAP:
      case SEQ:
        return !0;
    }
  return !1;
}
function isNode(node) {
  if (node && typeof node == "object")
    switch (node[NODE_TYPE]) {
      case ALIAS:
      case MAP:
      case SCALAR:
      case SEQ:
        return !0;
    }
  return !1;
}

// yaml/visit.js
var BREAK = /* @__PURE__ */ Symbol("break visit"), SKIP = /* @__PURE__ */ Symbol("skip children"), REMOVE = /* @__PURE__ */ Symbol("remove node");
function visit(node, visitor) {
  let visitor_ = initVisitor(visitor);
  isDocument(node) ? visit_(null, node.contents, visitor_, Object.freeze([node])) === REMOVE && (node.contents = null) : visit_(null, node, visitor_, Object.freeze([]));
}
visit.BREAK = BREAK;
visit.SKIP = SKIP;
visit.REMOVE = REMOVE;
function visit_(key, node, visitor, path) {
  let ctrl = callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl))
    return replaceNode(key, path, ctrl), visit_(key, ctrl, visitor, path);
  if (typeof ctrl != "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        let ci = visit_(i, node.items[i], visitor, path);
        if (typeof ci == "number")
          i = ci - 1;
        else {
          if (ci === BREAK)
            return BREAK;
          ci === REMOVE && (node.items.splice(i, 1), i -= 1);
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      let ck = visit_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      ck === REMOVE && (node.key = null);
      let cv = visit_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      cv === REMOVE && (node.value = null);
    }
  }
  return ctrl;
}
async function visitAsync(node, visitor) {
  let visitor_ = initVisitor(visitor);
  isDocument(node) ? await visitAsync_(null, node.contents, visitor_, Object.freeze([node])) === REMOVE && (node.contents = null) : await visitAsync_(null, node, visitor_, Object.freeze([]));
}
visitAsync.BREAK = BREAK;
visitAsync.SKIP = SKIP;
visitAsync.REMOVE = REMOVE;
async function visitAsync_(key, node, visitor, path) {
  let ctrl = await callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl))
    return replaceNode(key, path, ctrl), visitAsync_(key, ctrl, visitor, path);
  if (typeof ctrl != "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        let ci = await visitAsync_(i, node.items[i], visitor, path);
        if (typeof ci == "number")
          i = ci - 1;
        else {
          if (ci === BREAK)
            return BREAK;
          ci === REMOVE && (node.items.splice(i, 1), i -= 1);
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      let ck = await visitAsync_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      ck === REMOVE && (node.key = null);
      let cv = await visitAsync_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      cv === REMOVE && (node.value = null);
    }
  }
  return ctrl;
}
function initVisitor(visitor) {
  return typeof visitor == "object" && (visitor.Collection || visitor.Node || visitor.Value) ? Object.assign({
    Alias: visitor.Node,
    Map: visitor.Node,
    Scalar: visitor.Node,
    Seq: visitor.Node
  }, visitor.Value && {
    Map: visitor.Value,
    Scalar: visitor.Value,
    Seq: visitor.Value
  }, visitor.Collection && {
    Map: visitor.Collection,
    Seq: visitor.Collection
  }, visitor) : visitor;
}
function callVisitor(key, node, visitor, path) {
  if (typeof visitor == "function")
    return visitor(key, node, path);
  if (isMap(node))
    return visitor.Map?.(key, node, path);
  if (isSeq(node))
    return visitor.Seq?.(key, node, path);
  if (isPair(node))
    return visitor.Pair?.(key, node, path);
  if (isScalar(node))
    return visitor.Scalar?.(key, node, path);
  if (isAlias(node))
    return visitor.Alias?.(key, node, path);
}
function replaceNode(key, path, node) {
  let parent = path[path.length - 1];
  if (isCollection(parent))
    parent.items[key] = node;
  else if (isPair(parent))
    key === "key" ? parent.key = node : parent.value = node;
  else if (isDocument(parent))
    parent.contents = node;
  else {
    let pt = isAlias(parent) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${pt} parent`);
  }
}

// yaml/doc/directives.js
var escapeChars = {
  "!": "%21",
  ",": "%2C",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D"
}, escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]), Directives = class _Directives {
  constructor(yaml, tags) {
    this.docStart = null, this.docEnd = !1, this.yaml = Object.assign({}, _Directives.defaultYaml, yaml), this.tags = Object.assign({}, _Directives.defaultTags, tags);
  }
  clone() {
    let copy = new _Directives(this.yaml, this.tags);
    return copy.docStart = this.docStart, copy;
  }
  atDocument() {
    let res = new _Directives(this.yaml, this.tags);
    switch (this.yaml.version) {
      case "1.1":
        this.atNextDocument = !0;
        break;
      case "1.2":
        this.atNextDocument = !1, this.yaml = {
          explicit: _Directives.defaultYaml.explicit,
          version: "1.2"
        }, this.tags = Object.assign({}, _Directives.defaultTags);
        break;
    }
    return res;
  }
  add(line, onError) {
    this.atNextDocument && (this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" }, this.tags = Object.assign({}, _Directives.defaultTags), this.atNextDocument = !1);
    let parts = line.trim().split(/[ \t]+/), name = parts.shift();
    switch (name) {
      case "%TAG": {
        if (parts.length !== 2 && (onError(0, "%TAG directive should contain exactly two parts"), parts.length < 2))
          return !1;
        let [handle, prefix] = parts;
        return this.tags[handle] = prefix, !0;
      }
      case "%YAML": {
        if (this.yaml.explicit = !0, parts.length !== 1)
          return onError(0, "%YAML directive should contain exactly one part"), !1;
        let [version] = parts;
        if (version === "1.1" || version === "1.2")
          return this.yaml.version = version, !0;
        {
          let isValid = /^\d+\.\d+$/.test(version);
          return onError(6, `Unsupported YAML version ${version}`, isValid), !1;
        }
      }
      default:
        return onError(0, `Unknown directive ${name}`, !0), !1;
    }
  }
  tagName(source, onError) {
    if (source === "!")
      return "!";
    if (source[0] !== "!")
      return onError(`Not a valid tag: ${source}`), null;
    if (source[1] === "<") {
      let verbatim = source.slice(2, -1);
      return verbatim === "!" || verbatim === "!!" ? (onError(`Verbatim tags aren't resolved, so ${source} is invalid.`), null) : (source[source.length - 1] !== ">" && onError("Verbatim tags must end with a >"), verbatim);
    }
    let [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
    suffix || onError(`The ${source} tag has no suffix`);
    let prefix = this.tags[handle];
    if (prefix)
      try {
        return prefix + decodeURIComponent(suffix);
      } catch (error) {
        return onError(String(error)), null;
      }
    return handle === "!" ? source : (onError(`Could not resolve tag: ${source}`), null);
  }
  tagString(tag) {
    for (let [handle, prefix] of Object.entries(this.tags))
      if (tag.startsWith(prefix))
        return handle + escapeTagName(tag.substring(prefix.length));
    return tag[0] === "!" ? tag : `!<${tag}>`;
  }
  toString(doc) {
    let lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [], tagEntries = Object.entries(this.tags), tagNames;
    if (doc && tagEntries.length > 0 && isNode(doc.contents)) {
      let tags = {};
      visit(doc.contents, (_key, node) => {
        isNode(node) && node.tag && (tags[node.tag] = !0);
      }), tagNames = Object.keys(tags);
    } else
      tagNames = [];
    for (let [handle, prefix] of tagEntries)
      handle === "!!" && prefix === "tag:yaml.org,2002:" || (!doc || tagNames.some((tn) => tn.startsWith(prefix))) && lines.push(`%TAG ${handle} ${prefix}`);
    return lines.join(`
`);
  }
};
Directives.defaultYaml = { explicit: !1, version: "1.2" };
Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };

// yaml/nodes/Node.js
var NodeBase = class {
  constructor(type) {
    Object.defineProperty(this, NODE_TYPE, { value: type });
  }
};

// yaml/nodes/Alias.js
var Alias = class extends NodeBase {
  constructor(source) {
    super(ALIAS), this.source = source, Object.defineProperty(this, "tag", {
      set() {
        throw new Error("Alias nodes cannot have tags");
      }
    });
  }
};

// yaml/nodes/Scalar.js
var Scalar = class extends NodeBase {
  constructor(value) {
    super(SCALAR), this.value = value;
  }
};
Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
Scalar.PLAIN = "PLAIN";
Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";

// yaml/nodes/Collection.js
var Collection = class extends NodeBase {
  constructor(type, schema4) {
    super(type), Object.defineProperty(this, "schema", {
      value: schema4,
      configurable: !0,
      enumerable: !1,
      writable: !0
    });
  }
};

// yaml/schema/yaml-1.1/merge.js
var MERGE_KEY = "<<", merge = {
  default: "key",
  tag: "tag:yaml.org,2002:merge",
  test: /^<<$/,
  resolve: () => Object.assign(new Scalar(Symbol(MERGE_KEY)), {
    addToJSMap: addMergeToJSMap
  })
};
function addMergeToJSMap(ctx, map2, value) {
  let source = resolveAliasValue(ctx, value);
  if (isSeq(source))
    for (let it of source.items)
      mergeValue(ctx, map2, it);
  else if (Array.isArray(source))
    for (let it of source)
      mergeValue(ctx, map2, it);
  else
    mergeValue(ctx, map2, source);
}
function mergeValue(ctx, map2, value) {
  let source = resolveAliasValue(ctx, value);
  if (!isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  let srcMap = source.toJSON(null, ctx, Map);
  for (let [key, value2] of srcMap)
    map2 instanceof Map ? map2.has(key) || map2.set(key, value2) : map2 instanceof Set ? map2.add(key) : Object.prototype.hasOwnProperty.call(map2, key) || Object.defineProperty(map2, key, {
      value: value2,
      writable: !0,
      enumerable: !0,
      configurable: !0
    });
  return map2;
}
function resolveAliasValue(ctx, value) {
  return ctx && isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
}

// yaml/nodes/Pair.js
var Pair = class {
  constructor(key, value = null) {
    Object.defineProperty(this, NODE_TYPE, { value: PAIR }), this.key = key, this.value = value;
  }
};

// yaml/nodes/YAMLMap.js
var YAMLMap = class extends Collection {
  constructor(schema4) {
    super(MAP, schema4), this.items = [];
  }
};

// yaml/schema/common/map.js
var map = {
  collection: "map",
  default: !0,
  nodeClass: YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map2, onError) {
    return isMap(map2) || onError("Expected a mapping for this tag"), map2;
  }
};

// yaml/nodes/YAMLSeq.js
var YAMLSeq = class extends Collection {
  constructor(schema4) {
    super(SEQ, schema4), this.items = [];
  }
};

// yaml/schema/common/seq.js
var seq = {
  collection: "seq",
  default: !0,
  nodeClass: YAMLSeq,
  tag: "tag:yaml.org,2002:seq",
  resolve(seq2, onError) {
    return isSeq(seq2) || onError("Expected a sequence for this tag"), seq2;
  }
};

// yaml/schema/common/string.js
var string = {
  default: !0,
  tag: "tag:yaml.org,2002:str",
  resolve: (str) => str
};

// yaml/schema/common/null.js
var nullTag = {
  default: !0,
  tag: "tag:yaml.org,2002:null",
  test: /^(?:~|[Nn]ull|NULL)?$/,
  resolve: () => new Scalar(null)
};

// yaml/schema/core/bool.js
var boolTag = {
  default: !0,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  resolve: (str) => new Scalar(str[0] === "t" || str[0] === "T")
};

// yaml/schema/core/float.js
var floatNaN = {
  default: !0,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
}, floatExp = {
  default: !0,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str)
}, float = {
  default: !0,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
  resolve(str) {
    let node = new Scalar(parseFloat(str)), dot = str.indexOf(".");
    return dot !== -1 && str[str.length - 1] === "0" && (node.minFractionDigits = str.length - dot - 1), node;
  }
};

// yaml/schema/core/int.js
var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
var intOct = {
  default: !0,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^0o[0-7]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt)
}, int = {
  default: !0,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt)
}, intHex = {
  default: !0,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^0x[0-9a-fA-F]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt)
};

// yaml/schema/core/schema.js
var schema = [
  map,
  seq,
  string,
  nullTag,
  boolTag,
  intOct,
  int,
  intHex,
  floatNaN,
  floatExp,
  float
];

// yaml/schema/json/schema.js
var jsonScalars = [
  {
    default: !0,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str
  },
  {
    default: !0,
    tag: "tag:yaml.org,2002:null",
    test: /^null$/,
    resolve: () => null
  },
  {
    default: !0,
    tag: "tag:yaml.org,2002:bool",
    test: /^true$|^false$/,
    resolve: (str) => str === "true"
  },
  {
    default: !0,
    tag: "tag:yaml.org,2002:int",
    test: /^-?(?:0|[1-9][0-9]*)$/,
    resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10)
  },
  {
    default: !0,
    tag: "tag:yaml.org,2002:float",
    test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
    resolve: (str) => parseFloat(str)
  }
], jsonError = {
  default: !0,
  tag: "",
  test: /^/,
  resolve(str, onError) {
    return onError(`Unresolved plain scalar ${JSON.stringify(str)}`), str;
  }
}, schema2 = [map, seq].concat(jsonScalars, jsonError);

// yaml/schema/yaml-1.1/binary.js
var binary = {
  default: !1,
  tag: "tag:yaml.org,2002:binary",
  resolve(src, onError) {
    if (typeof atob == "function") {
      let str = atob(src.replace(/[\n\r]/g, "")), buffer = new Uint8Array(str.length);
      for (let i = 0; i < str.length; ++i)
        buffer[i] = str.charCodeAt(i);
      return buffer;
    } else
      return onError("This environment does not support reading binary tags; either Buffer or atob is required"), src;
  }
};

// yaml/schema/yaml-1.1/pairs.js
function resolvePairs(seq2, onError) {
  if (isSeq(seq2))
    for (let i = 0; i < seq2.items.length; ++i) {
      let item = seq2.items[i];
      if (!isPair(item)) {
        if (isMap(item)) {
          item.items.length > 1 && onError("Each pair must have its own sequence indicator");
          let pair = item.items[0] || new Pair(new Scalar(null));
          if (item.commentBefore && (pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore), item.comment) {
            let cn = pair.value ?? pair.key;
            cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
          }
          item = pair;
        }
        seq2.items[i] = isPair(item) ? item : new Pair(item);
      }
    }
  else
    onError("Expected a sequence for this tag");
  return seq2;
}
var pairs = {
  collection: "seq",
  default: !1,
  tag: "tag:yaml.org,2002:pairs",
  resolve: resolvePairs
};

// yaml/schema/yaml-1.1/omap.js
var YAMLOMap = class _YAMLOMap extends YAMLSeq {
  constructor() {
    super(), this.add = YAMLMap.prototype.add.bind(this), this.delete = YAMLMap.prototype.delete.bind(this), this.get = YAMLMap.prototype.get.bind(this), this.has = YAMLMap.prototype.has.bind(this), this.set = YAMLMap.prototype.set.bind(this), this.tag = _YAMLOMap.tag;
  }
};
YAMLOMap.tag = "tag:yaml.org,2002:omap";
var omap = {
  collection: "seq",
  nodeClass: YAMLOMap,
  default: !1,
  tag: "tag:yaml.org,2002:omap",
  resolve(seq2, onError) {
    let pairs2 = resolvePairs(seq2, onError), seenKeys = [];
    for (let { key } of pairs2.items)
      isScalar(key) && (seenKeys.includes(key.value) ? onError(`Ordered maps must not include duplicate keys: ${key.value}`) : seenKeys.push(key.value));
    return Object.assign(new YAMLOMap(), pairs2);
  }
};

// yaml/schema/yaml-1.1/bool.js
var trueTag = {
  default: !0,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: () => new Scalar(!0)
}, falseTag = {
  default: !0,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: () => new Scalar(!1)
};

// yaml/schema/yaml-1.1/float.js
var floatNaN2 = {
  default: !0,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
}, floatExp2 = {
  default: !0,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str.replace(/_/g, ""))
}, float2 = {
  default: !0,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
  resolve(str) {
    let node = new Scalar(parseFloat(str.replace(/_/g, ""))), dot = str.indexOf(".");
    if (dot !== -1) {
      let f = str.substring(dot + 1).replace(/_/g, "");
      f[f.length - 1] === "0" && (node.minFractionDigits = f.length);
    }
    return node;
  }
};

// yaml/schema/yaml-1.1/int.js
function intResolve2(str, offset, radix, { intAsBigInt }) {
  let sign = str[0];
  if ((sign === "-" || sign === "+") && (offset += 1), str = str.substring(offset).replace(/_/g, ""), intAsBigInt) {
    switch (radix) {
      case 2:
        str = `0b${str}`;
        break;
      case 8:
        str = `0o${str}`;
        break;
      case 16:
        str = `0x${str}`;
        break;
    }
    let n2 = BigInt(str);
    return sign === "-" ? BigInt(-1) * n2 : n2;
  }
  let n = parseInt(str, radix);
  return sign === "-" ? -1 * n : n;
}
var intBin = {
  default: !0,
  tag: "tag:yaml.org,2002:int",
  format: "BIN",
  test: /^[-+]?0b[0-1_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 2, opt)
}, intOct2 = {
  default: !0,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^[-+]?0[0-7_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 1, 8, opt)
}, int2 = {
  default: !0,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9][0-9_]*$/,
  resolve: (str, _onError, opt) => intResolve2(str, 0, 10, opt)
}, intHex2 = {
  default: !0,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^[-+]?0x[0-9a-fA-F_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 16, opt)
};

// yaml/schema/yaml-1.1/set.js
var YAMLSet = class _YAMLSet extends YAMLMap {
  constructor(schema4) {
    super(schema4), this.tag = _YAMLSet.tag;
  }
};
YAMLSet.tag = "tag:yaml.org,2002:set";
var set = {
  collection: "map",
  nodeClass: YAMLSet,
  default: !1,
  tag: "tag:yaml.org,2002:set",
  resolve(map2, onError) {
    if (isMap(map2)) {
      if (map2.hasAllNullValues(!0))
        return Object.assign(new YAMLSet(), map2);
      onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map2;
  }
};

// yaml/schema/yaml-1.1/timestamp.js
function parseSexagesimal(str, asBigInt) {
  let sign = str[0], parts = sign === "-" || sign === "+" ? str.substring(1) : str, num = (n) => asBigInt ? BigInt(n) : Number(n), res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
  return sign === "-" ? num(-1) * res : res;
}
var intTime = {
  default: !0,
  tag: "tag:yaml.org,2002:int",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
  resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt)
}, floatTime = {
  default: !0,
  tag: "tag:yaml.org,2002:float",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
  resolve: (str) => parseSexagesimal(str, !1)
}, timestamp = {
  default: !0,
  tag: "tag:yaml.org,2002:timestamp",
  test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
  resolve(str) {
    let match = str.match(timestamp.test);
    if (!match)
      throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
    let [, year, month, day, hour, minute, second] = match.map(Number), millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0, date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec), tz = match[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, !1);
      Math.abs(d) < 30 && (d *= 60), date -= 6e4 * d;
    }
    return new Date(date);
  }
};

// yaml/schema/yaml-1.1/schema.js
var schema3 = [
  map,
  seq,
  string,
  nullTag,
  trueTag,
  falseTag,
  intBin,
  intOct2,
  int2,
  intHex2,
  floatNaN2,
  floatExp2,
  float2,
  binary,
  merge,
  omap,
  pairs,
  set,
  intTime,
  floatTime,
  timestamp
];

// yaml/schema/tags.js
var schemas = /* @__PURE__ */ new Map([
  ["core", schema],
  ["failsafe", [map, seq, string]],
  ["json", schema2],
  ["yaml11", schema3],
  ["yaml-1.1", schema3]
]), tagsByName = {
  binary,
  bool: boolTag,
  float,
  floatExp,
  floatNaN,
  floatTime,
  int,
  intHex,
  intOct,
  intTime,
  map,
  merge,
  null: nullTag,
  omap,
  pairs,
  seq,
  set,
  timestamp
}, coreKnownTags = {
  "tag:yaml.org,2002:binary": binary,
  "tag:yaml.org,2002:merge": merge,
  "tag:yaml.org,2002:omap": omap,
  "tag:yaml.org,2002:pairs": pairs,
  "tag:yaml.org,2002:set": set,
  "tag:yaml.org,2002:timestamp": timestamp
};
function getTags(customTags, schemaName, addMergeTag) {
  let schemaTags = schemas.get(schemaName);
  if (schemaTags && !customTags)
    return addMergeTag && !schemaTags.includes(merge) ? schemaTags.concat(merge) : schemaTags.slice();
  let tags = schemaTags;
  if (!tags)
    if (Array.isArray(customTags))
      tags = [];
    else {
      let keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  if (Array.isArray(customTags))
    for (let tag of customTags)
      tags = tags.concat(tag);
  else typeof customTags == "function" && (tags = customTags(tags.slice()));
  return addMergeTag && (tags = tags.concat(merge)), tags.reduce((tags2, tag) => {
    let tagObj = typeof tag == "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      let tagName = JSON.stringify(tag), keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    return tags2.includes(tagObj) || tags2.push(tagObj), tags2;
  }, []);
}

// yaml/schema/Schema.js
var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0, Schema = class {
  constructor({ compat, customTags, merge: merge2, resolveKnownTags, schema: schema4, sortMapEntries, toStringDefaults }) {
    this.compat = Array.isArray(compat) ? getTags(compat, "compat") : compat ? getTags(null, compat) : null, this.name = typeof schema4 == "string" && schema4 || "core", this.knownTags = resolveKnownTags ? coreKnownTags : {}, this.tags = getTags(customTags, this.name, merge2), this.toStringOptions = toStringDefaults ?? null, Object.defineProperty(this, MAP, { value: map }), Object.defineProperty(this, SCALAR, { value: string }), Object.defineProperty(this, SEQ, { value: seq }), this.sortMapEntries = typeof sortMapEntries == "function" ? sortMapEntries : sortMapEntries === !0 ? sortMapEntriesByKey : null;
  }
};

// yaml/doc/Document.js
var Document = class {
  constructor(value, replacer, options) {
    this.commentBefore = null, this.comment = null, this.errors = [], this.warnings = [], Object.defineProperty(this, NODE_TYPE, { value: DOC });
    let _replacer = null;
    typeof replacer == "function" || Array.isArray(replacer) ? _replacer = replacer : options === void 0 && replacer && (options = replacer, replacer = void 0);
    let opt = Object.assign({
      intAsBigInt: !1,
      keepSourceTokens: !1,
      logLevel: "warn",
      prettyErrors: !0,
      strict: !0,
      stringKeys: !1,
      uniqueKeys: !0,
      version: "1.2"
    }, options);
    this.options = opt;
    let { version } = opt;
    options?._directives ? (this.directives = options._directives.atDocument(), this.directives.yaml.explicit && (version = this.directives.yaml.version)) : this.directives = new Directives({ version }), this.setSchema(version, options), this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
  }
  setSchema(version, options = {}) {
    typeof version == "number" && (version = String(version));
    let opt;
    switch (version) {
      case "1.1":
        this.directives ? this.directives.yaml.version = "1.1" : this.directives = new Directives({ version: "1.1" }), opt = { resolveKnownTags: !1, schema: "yaml-1.1" };
        break;
      case "1.2":
      case "next":
        this.directives ? this.directives.yaml.version = version : this.directives = new Directives({ version }), opt = { resolveKnownTags: !0, schema: "core" };
        break;
      case null:
        this.directives && delete this.directives, opt = null;
        break;
      default: {
        let sv = JSON.stringify(version);
        throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
      }
    }
    if (options.schema instanceof Object)
      this.schema = options.schema;
    else if (opt)
      this.schema = new Schema(Object.assign(opt, options));
    else
      throw new Error("With a null YAML version, the { schema: Schema } option is required");
  }
};

// yaml/errors.js
var YAMLError = class extends Error {
  constructor(name, pos, code, message) {
    super(), this.name = name, this.code = code, this.message = message, this.pos = pos;
  }
}, YAMLParseError = class extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLParseError", pos, code, message);
  }
}, YAMLWarning = class extends YAMLError {
  constructor(pos, code, message) {
    super("YAMLWarning", pos, code, message);
  }
};

// yaml/compose/resolve-props.js
function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
  let spaceBefore = !1, atNewline = startOnNewline, hasSpace = startOnNewline, comment = "", commentSep = "", hasNewline = !1, reqSpace = !1, tab = null, anchor = null, tag = null, newlineAfterProp = null, comma = null, found = null, start = null;
  for (let token of tokens)
    switch (reqSpace && (token.type !== "space" && token.type !== "newline" && token.type !== "comma" && onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space"), reqSpace = !1), tab && (atNewline && token.type !== "comment" && token.type !== "newline" && onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation"), tab = null), token.type) {
      case "space":
        !flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	") && (tab = token), hasSpace = !0;
        break;
      case "comment": {
        hasSpace || onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
        let cb = token.source.substring(1) || " ";
        comment ? comment += commentSep + cb : comment = cb, commentSep = "", atNewline = !1;
        break;
      }
      case "newline":
        atNewline ? comment ? comment += token.source : (!found || indicator !== "seq-item-ind") && (spaceBefore = !0) : commentSep += token.source, atNewline = !0, hasNewline = !0, (anchor || tag) && (newlineAfterProp = token), hasSpace = !0;
        break;
      case "anchor":
        anchor && onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor"), token.source.endsWith(":") && onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", !0), anchor = token, start ?? (start = token.offset), atNewline = !1, hasSpace = !1, reqSpace = !0;
        break;
      case "tag": {
        tag && onError(token, "MULTIPLE_TAGS", "A node can have at most one tag"), tag = token, start ?? (start = token.offset), atNewline = !1, hasSpace = !1, reqSpace = !0;
        break;
      }
      case indicator:
        (anchor || tag) && onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`), found && onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`), found = token, atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind", hasSpace = !1;
        break;
      case "comma":
        if (flow) {
          comma && onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`), comma = token, atNewline = !1, hasSpace = !1;
          break;
        }
      // else fallthrough
      default:
        onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`), atNewline = !1, hasSpace = !1;
    }
  let last = tokens[tokens.length - 1], end = last ? last.offset + last.source.length : offset;
  return reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "") && onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space"), tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq") && onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation"), {
    comma,
    found,
    spaceBefore,
    comment,
    hasNewline,
    anchor,
    tag,
    newlineAfterProp,
    end,
    start: start ?? end
  };
}

// yaml/compose/util-contains-newline.js
function containsNewline(key) {
  if (!key)
    return null;
  switch (key.type) {
    case "alias":
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      if (key.source.includes(`
`))
        return !0;
      if (key.end) {
        for (let st of key.end)
          if (st.type === "newline")
            return !0;
      }
      return !1;
    case "flow-collection":
      for (let it of key.items) {
        for (let st of it.start)
          if (st.type === "newline")
            return !0;
        if (it.sep) {
          for (let st of it.sep)
            if (st.type === "newline")
              return !0;
        }
        if (containsNewline(it.key) || containsNewline(it.value))
          return !0;
      }
      return !1;
    default:
      return !0;
  }
}

// yaml/compose/util-flow-indent-check.js
function flowIndentCheck(indent, fc, onError) {
  if (fc?.type === "flow-collection") {
    let end = fc.end[0];
    end.indent === indent && (end.source === "]" || end.source === "}") && containsNewline(fc) && onError(end, "BAD_INDENT", "Flow end indicator should be more indented than parent", !0);
  }
}

// yaml/compose/util-map-includes.js
function mapIncludes(ctx, items, search) {
  let { uniqueKeys } = ctx.options;
  if (uniqueKeys === !1)
    return !1;
  let isEqual = typeof uniqueKeys == "function" ? uniqueKeys : (a, b) => a === b || isScalar(a) && isScalar(b) && a.value === b.value;
  return items.some((pair) => isEqual(pair.key, search));
}

// yaml/compose/resolve-block-map.js
var startColMsg = "All mapping items must start at the same column";
function resolveBlockMap({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bm, onError, tag) {
  let NodeClass = tag?.nodeClass ?? YAMLMap, map2 = new NodeClass(ctx.schema);
  ctx.atRoot && (ctx.atRoot = !1);
  let offset = bm.offset, commentEnd = null;
  for (let collItem of bm.items) {
    let { start, key, sep, value } = collItem, keyProps = resolveProps(start, {
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: bm.indent,
      startOnNewline: !0
    }), implicitKey = !keyProps.found;
    if (implicitKey) {
      if (key && (key.type === "block-seq" ? onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key") : "indent" in key && key.indent !== bm.indent && onError(offset, "BAD_INDENT", startColMsg)), !keyProps.anchor && !keyProps.tag && !sep) {
        commentEnd = keyProps.end, keyProps.comment && (map2.comment ? map2.comment += `
` + keyProps.comment : map2.comment = keyProps.comment);
        continue;
      }
      (keyProps.newlineAfterProp || containsNewline(key)) && onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
    } else keyProps.found?.indent !== bm.indent && onError(offset, "BAD_INDENT", startColMsg);
    ctx.atKey = !0;
    let keyStart = keyProps.end, keyNode = key ? composeNode2(ctx, key, keyProps, onError) : composeEmptyNode2(ctx, keyStart, start, null, keyProps, onError);
    ctx.schema.compat && flowIndentCheck(bm.indent, key, onError), ctx.atKey = !1, mapIncludes(ctx, map2.items, keyNode) && onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
    let valueProps = resolveProps(sep ?? [], {
      indicator: "map-value-ind",
      next: value,
      offset: keyNode.range[2],
      onError,
      parentIndent: bm.indent,
      startOnNewline: !key || key.type === "block-scalar"
    });
    if (offset = valueProps.end, valueProps.found) {
      implicitKey && (value?.type === "block-map" && !valueProps.hasNewline && onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings"), ctx.options.strict && keyProps.start < valueProps.found.offset - 1024 && onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key"));
      let valueNode = value ? composeNode2(ctx, value, valueProps, onError) : composeEmptyNode2(ctx, offset, sep, null, valueProps, onError);
      ctx.schema.compat && flowIndentCheck(bm.indent, value, onError), offset = valueNode.range[2];
      let pair = new Pair(keyNode, valueNode);
      ctx.options.keepSourceTokens && (pair.srcToken = collItem), map2.items.push(pair);
    } else {
      implicitKey && onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values"), valueProps.comment && (keyNode.comment ? keyNode.comment += `
` + valueProps.comment : keyNode.comment = valueProps.comment);
      let pair = new Pair(keyNode);
      ctx.options.keepSourceTokens && (pair.srcToken = collItem), map2.items.push(pair);
    }
  }
  return commentEnd && commentEnd < offset && onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content"), map2.range = [bm.offset, offset, commentEnd ?? offset], map2;
}

// yaml/compose/resolve-block-seq.js
function resolveBlockSeq({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bs, onError, tag) {
  let NodeClass = tag?.nodeClass ?? YAMLSeq, seq2 = new NodeClass(ctx.schema);
  ctx.atRoot && (ctx.atRoot = !1), ctx.atKey && (ctx.atKey = !1);
  let offset = bs.offset, commentEnd = null;
  for (let { start, value } of bs.items) {
    let props = resolveProps(start, {
      indicator: "seq-item-ind",
      next: value,
      offset,
      onError,
      parentIndent: bs.indent,
      startOnNewline: !0
    });
    if (!props.found)
      if (props.anchor || props.tag || value)
        value?.type === "block-seq" ? onError(props.end, "BAD_INDENT", "All sequence items must start at the same column") : onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
      else {
        commentEnd = props.end, props.comment && (seq2.comment = props.comment);
        continue;
      }
    let node = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, start, null, props, onError);
    ctx.schema.compat && flowIndentCheck(bs.indent, value, onError), offset = node.range[2], seq2.items.push(node);
  }
  return seq2.range = [bs.offset, offset, commentEnd ?? offset], seq2;
}

// yaml/compose/resolve-end.js
function resolveEnd(end, offset, reqSpace, onError) {
  let comment = "";
  if (end) {
    let hasSpace = !1, sep = "";
    for (let token of end) {
      let { source, type } = token;
      switch (type) {
        case "space":
          hasSpace = !0;
          break;
        case "comment": {
          reqSpace && !hasSpace && onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          let cb = source.substring(1) || " ";
          comment ? comment += sep + cb : comment = cb, sep = "";
          break;
        }
        case "newline":
          comment && (sep += source), hasSpace = !0;
          break;
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
      }
      offset += source.length;
    }
  }
  return { comment, offset };
}

// yaml/compose/resolve-flow-collection.js
var blockMsg = "Block collections are not allowed within flow collections", isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
function resolveFlowCollection({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, fc, onError, tag) {
  let isMap2 = fc.start.source === "{", fcName = isMap2 ? "flow map" : "flow sequence", NodeClass = tag?.nodeClass ?? (isMap2 ? YAMLMap : YAMLSeq), coll = new NodeClass(ctx.schema);
  coll.flow = !0;
  let atRoot = ctx.atRoot;
  atRoot && (ctx.atRoot = !1), ctx.atKey && (ctx.atKey = !1);
  let offset = fc.offset + fc.start.source.length;
  for (let i = 0; i < fc.items.length; ++i) {
    let collItem = fc.items[i], { start, key, sep, value } = collItem, props = resolveProps(start, {
      flow: fcName,
      indicator: "explicit-key-ind",
      next: key ?? sep?.[0],
      offset,
      onError,
      parentIndent: fc.indent,
      startOnNewline: !1
    });
    if (!props.found) {
      if (!props.anchor && !props.tag && !sep && !value) {
        i === 0 && props.comma ? onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`) : i < fc.items.length - 1 && onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`), props.comment && (coll.comment ? coll.comment += `
` + props.comment : coll.comment = props.comment), offset = props.end;
        continue;
      }
      !isMap2 && ctx.options.strict && containsNewline(key) && onError(
        key,
        // checked by containsNewline()
        "MULTILINE_IMPLICIT_KEY",
        "Implicit keys of flow sequence pairs need to be on a single line"
      );
    }
    if (i === 0)
      props.comma && onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
    else if (props.comma || onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`), props.comment) {
      let prevItemComment = "";
      loop: for (let st of start)
        switch (st.type) {
          case "comma":
          case "space":
            break;
          case "comment":
            prevItemComment = st.source.substring(1);
            break loop;
          default:
            break loop;
        }
      if (prevItemComment) {
        let prev = coll.items[coll.items.length - 1];
        isPair(prev) && (prev = prev.value ?? prev.key), prev.comment ? prev.comment += `
` + prevItemComment : prev.comment = prevItemComment, props.comment = props.comment.substring(prevItemComment.length + 1);
      }
    }
    if (!isMap2 && !sep && !props.found) {
      let valueNode = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, sep, null, props, onError);
      coll.items.push(valueNode), offset = valueNode.range[2], isBlock(value) && onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
    } else {
      ctx.atKey = !0;
      let keyStart = props.end, keyNode = key ? composeNode2(ctx, key, props, onError) : composeEmptyNode2(ctx, keyStart, start, null, props, onError);
      isBlock(key) && onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg), ctx.atKey = !1;
      let valueProps = resolveProps(sep ?? [], {
        flow: fcName,
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: fc.indent,
        startOnNewline: !1
      });
      if (valueProps.found) {
        if (!isMap2 && !props.found && ctx.options.strict) {
          if (sep)
            for (let st of sep) {
              if (st === valueProps.found)
                break;
              if (st.type === "newline") {
                onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                break;
              }
            }
          props.start < valueProps.found.offset - 1024 && onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
        }
      } else value && ("source" in value && value.source?.[0] === ":" ? onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`) : onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`));
      let valueNode = value ? composeNode2(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode2(ctx, valueProps.end, sep, null, valueProps, onError) : null;
      valueNode ? isBlock(value) && onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg) : valueProps.comment && (keyNode.comment ? keyNode.comment += `
` + valueProps.comment : keyNode.comment = valueProps.comment);
      let pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens && (pair.srcToken = collItem), isMap2) {
        let map2 = coll;
        mapIncludes(ctx, map2.items, keyNode) && onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique"), map2.items.push(pair);
      } else {
        let map2 = new YAMLMap(ctx.schema);
        map2.flow = !0, map2.items.push(pair);
        let endRange = (valueNode ?? keyNode).range;
        map2.range = [keyNode.range[0], endRange[1], endRange[2]], coll.items.push(map2);
      }
      offset = valueNode ? valueNode.range[2] : valueProps.end;
    }
  }
  let expectedEnd = isMap2 ? "}" : "]", [ce, ...ee] = fc.end, cePos = offset;
  if (ce?.source === expectedEnd)
    cePos = ce.offset + ce.source.length;
  else {
    let name = fcName[0].toUpperCase() + fcName.substring(1), msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
    onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg), ce && ce.source.length !== 1 && ee.unshift(ce);
  }
  if (ee.length > 0) {
    let end = resolveEnd(ee, cePos, ctx.options.strict, onError);
    end.comment && (coll.comment ? coll.comment += `
` + end.comment : coll.comment = end.comment), coll.range = [fc.offset, cePos, end.offset];
  } else
    coll.range = [fc.offset, cePos, cePos];
  return coll;
}

// yaml/compose/compose-collection.js
function resolveCollection(CN2, ctx, token, onError, tagName, tag) {
  let coll = token.type === "block-map" ? resolveBlockMap(CN2, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq(CN2, ctx, token, onError, tag) : resolveFlowCollection(CN2, ctx, token, onError, tag), Coll = coll.constructor;
  return tagName === "!" || tagName === Coll.tagName ? (coll.tag = Coll.tagName, coll) : (tagName && (coll.tag = tagName), coll);
}
function composeCollection(CN2, ctx, token, props, onError) {
  let tagToken = props.tag, tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
  if (token.type === "block-seq") {
    let { anchor, newlineAfterProp: nl } = props, lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
    lastProp && (!nl || nl.offset < lastProp.offset) && onError(lastProp, "MISSING_CHAR", "Missing newline after block sequence props");
  }
  let expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
  if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.tagName && expType === "seq")
    return resolveCollection(CN2, ctx, token, onError, tagName);
  let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
  if (!tag) {
    let kt = ctx.schema.knownTags[tagName];
    if (kt?.collection === expType)
      ctx.schema.tags.push(Object.assign({}, kt, { default: !1 })), tag = kt;
    else
      return kt ? onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, !0) : onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, !0), resolveCollection(CN2, ctx, token, onError, tagName);
  }
  let coll = resolveCollection(CN2, ctx, token, onError, tagName, tag), res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll, node = isNode(res) ? res : new Scalar(res);
  return node.range = coll.range, node.tag = tagName, tag?.format && (node.format = tag.format), node;
}

// yaml/compose/resolve-block-scalar.js
function resolveBlockScalar(ctx, scalar, onError) {
  let start = scalar.offset, header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
  if (!header)
    return { value: "", type: null, comment: "", range: [start, start, start] };
  let type = header.mode === ">" ? Scalar.BLOCK_FOLDED : Scalar.BLOCK_LITERAL, lines = scalar.source ? splitLines(scalar.source) : [], chompStart = lines.length;
  for (let i = lines.length - 1; i >= 0; --i) {
    let content = lines[i][1];
    if (content === "" || content === "\r")
      chompStart = i;
    else
      break;
  }
  if (chompStart === 0) {
    let value2 = header.chomp === "+" && lines.length > 0 ? `
`.repeat(Math.max(1, lines.length - 1)) : "", end2 = start + header.length;
    return scalar.source && (end2 += scalar.source.length), { value: value2, type, comment: header.comment, range: [start, end2, end2] };
  }
  let trimIndent = scalar.indent + header.indent, offset = scalar.offset + header.length, contentStart = 0;
  for (let i = 0; i < chompStart; ++i) {
    let [indent, content] = lines[i];
    if (content === "" || content === "\r")
      header.indent === 0 && indent.length > trimIndent && (trimIndent = indent.length);
    else {
      indent.length < trimIndent && onError(offset + indent.length, "MISSING_CHAR", "Block scalars with more-indented leading empty lines must use an explicit indentation indicator"), header.indent === 0 && (trimIndent = indent.length), contentStart = i, trimIndent === 0 && !ctx.atRoot && onError(offset, "BAD_INDENT", "Block scalar values in collections must be indented");
      break;
    }
    offset += indent.length + content.length + 1;
  }
  for (let i = lines.length - 1; i >= chompStart; --i)
    lines[i][0].length > trimIndent && (chompStart = i + 1);
  let value = "", sep = "", prevMoreIndented = !1;
  for (let i = 0; i < contentStart; ++i)
    value += lines[i][0].slice(trimIndent) + `
`;
  for (let i = contentStart; i < chompStart; ++i) {
    let [indent, content] = lines[i];
    offset += indent.length + content.length + 1;
    let crlf = content[content.length - 1] === "\r";
    if (crlf && (content = content.slice(0, -1)), content && indent.length < trimIndent) {
      let message = `Block scalar lines must not be less indented than their ${header.indent ? "explicit indentation indicator" : "first line"}`;
      onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message), indent = "";
    }
    type === Scalar.BLOCK_LITERAL ? (value += sep + indent.slice(trimIndent) + content, sep = `
`) : indent.length > trimIndent || content[0] === "	" ? (sep === " " ? sep = `
` : !prevMoreIndented && sep === `
` && (sep = `

`), value += sep + indent.slice(trimIndent) + content, sep = `
`, prevMoreIndented = !0) : content === "" ? sep === `
` ? value += `
` : sep = `
` : (value += sep + content, sep = " ", prevMoreIndented = !1);
  }
  switch (header.chomp) {
    case "-":
      break;
    case "+":
      for (let i = chompStart; i < lines.length; ++i)
        value += `
` + lines[i][0].slice(trimIndent);
      value[value.length - 1] !== `
` && (value += `
`);
      break;
    default:
      value += `
`;
  }
  let end = start + header.length + scalar.source.length;
  return { value, type, comment: header.comment, range: [start, end, end] };
}
function parseBlockScalarHeader({ offset, props }, strict, onError) {
  if (props[0].type !== "block-scalar-header")
    return onError(props[0], "IMPOSSIBLE", "Block scalar header not found"), null;
  let { source } = props[0], mode = source[0], indent = 0, chomp = "", error = -1;
  for (let i = 1; i < source.length; ++i) {
    let ch = source[i];
    if (!chomp && (ch === "-" || ch === "+"))
      chomp = ch;
    else {
      let n = Number(ch);
      !indent && n ? indent = n : error === -1 && (error = offset + i);
    }
  }
  error !== -1 && onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
  let hasSpace = !1, comment = "", length = source.length;
  for (let i = 1; i < props.length; ++i) {
    let token = props[i];
    switch (token.type) {
      case "space":
        hasSpace = !0;
      // fallthrough
      case "newline":
        length += token.source.length;
        break;
      case "comment":
        strict && !hasSpace && onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters"), length += token.source.length, comment = token.source.substring(1);
        break;
      case "error":
        onError(token, "UNEXPECTED_TOKEN", token.message), length += token.source.length;
        break;
      /* istanbul ignore next should not happen */
      default: {
        let message = `Unexpected token in block scalar header: ${token.type}`;
        onError(token, "UNEXPECTED_TOKEN", message);
        let ts = token.source;
        ts && typeof ts == "string" && (length += ts.length);
      }
    }
  }
  return { mode, indent, chomp, comment, length };
}
function splitLines(source) {
  let split = source.split(/\n( *)/), first = split[0], m = first.match(/^( *)/), lines = [m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first]];
  for (let i = 1; i < split.length; i += 2)
    lines.push([split[i], split[i + 1]]);
  return lines;
}

// yaml/compose/resolve-flow-scalar.js
function resolveFlowScalar(scalar, strict, onError) {
  let { offset, type, source, end } = scalar, _type, value, _onError = (rel, code, msg) => onError(offset + rel, code, msg);
  switch (type) {
    case "scalar":
      _type = Scalar.PLAIN, value = plainValue(source, _onError);
      break;
    case "single-quoted-scalar":
      _type = Scalar.QUOTE_SINGLE, value = singleQuotedValue(source, _onError);
      break;
    case "double-quoted-scalar":
      _type = Scalar.QUOTE_DOUBLE, value = doubleQuotedValue(source, _onError);
      break;
    /* istanbul ignore next should not happen */
    default:
      return onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`), {
        value: "",
        type: null,
        comment: "",
        range: [offset, offset + source.length, offset + source.length]
      };
  }
  let valueEnd = offset + source.length, re = resolveEnd(end, valueEnd, strict, onError);
  return {
    value,
    type: _type,
    comment: re.comment,
    range: [offset, valueEnd, re.offset]
  };
}
function plainValue(source, onError) {
  let badChar = "";
  switch (source[0]) {
    /* istanbul ignore next should not happen */
    case "	":
      badChar = "a tab character";
      break;
    case ",":
      badChar = "flow indicator character ,";
      break;
    case "%":
      badChar = "directive indicator character %";
      break;
    case "|":
    case ">": {
      badChar = `block scalar indicator ${source[0]}`;
      break;
    }
    case "@":
    case "`": {
      badChar = `reserved character ${source[0]}`;
      break;
    }
  }
  return badChar && onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`), unfoldLines(source);
}
function singleQuotedValue(source, onError) {
  return (source[source.length - 1] !== "'" || source.length === 1) && onError(source.length, "MISSING_CHAR", "Missing closing 'quote"), unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
}
function unfoldLines(source) {
  let line = /(.*?)\r?\n/sy, match = line.exec(source);
  if (!match)
    return source;
  let trimEnd, trimBoth;
  try {
    trimEnd = new RegExp("(?<![ 	])[ 	]+$"), trimBoth = new RegExp("^[ 	]+|(?<![ 	])[ 	]+$", "g");
  } catch {
    trimEnd = /[ \t]+$/, trimBoth = /^[ \t]+|[ \t]+$/g;
  }
  let res = match[1].replace(trimEnd, ""), sep = " ", pos = line.lastIndex;
  for (; match = line.exec(source); ) {
    let lm = match[1].replace(trimBoth, "");
    lm === "" ? sep === `
` ? res += sep : sep = `
` : (res += sep + lm, sep = " "), pos = line.lastIndex;
  }
  let last = /[ \t]*(.*)/sy;
  return last.lastIndex = pos, match = last.exec(source), res + sep + (match?.[1] ?? "");
}
function doubleQuotedValue(source, onError) {
  let res = "";
  for (let i = 1; i < source.length - 1; ++i) {
    let ch = source[i];
    if (!(ch === "\r" && source[i + 1] === `
`))
      if (ch === `
`) {
        let { fold, offset } = foldNewline(source, i);
        res += fold, i = offset;
      } else if (ch === "\\") {
        let next = source[++i], cc = escapeCodes[next];
        if (cc)
          res += cc;
        else if (next === `
`)
          for (next = source[i + 1]; next === " " || next === "	"; )
            next = source[++i + 1];
        else if (next === "\r" && source[i + 1] === `
`)
          for (next = source[++i + 1]; next === " " || next === "	"; )
            next = source[++i + 1];
        else if (next === "x" || next === "u" || next === "U") {
          let length = next === "x" ? 2 : next === "u" ? 4 : 8;
          res += parseCharCode(source, i + 1, length, onError), i += length;
        } else {
          let raw = source.substr(i - 1, 2);
          onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`), res += raw;
        }
      } else if (ch === " " || ch === "	") {
        let wsStart = i, next = source[i + 1];
        for (; next === " " || next === "	"; )
          next = source[++i + 1];
        next !== `
` && !(next === "\r" && source[i + 2] === `
`) && (res += i > wsStart ? source.slice(wsStart, i + 1) : ch);
      } else
        res += ch;
  }
  return (source[source.length - 1] !== '"' || source.length === 1) && onError(source.length, "MISSING_CHAR", 'Missing closing "quote'), res;
}
function foldNewline(source, offset) {
  let fold = "", ch = source[offset + 1];
  for (; (ch === " " || ch === "	" || ch === `
` || ch === "\r") && !(ch === "\r" && source[offset + 2] !== `
`); )
    ch === `
` && (fold += `
`), offset += 1, ch = source[offset + 1];
  return fold || (fold = " "), { fold, offset };
}
var escapeCodes = {
  0: "\0",
  // null character
  a: "\x07",
  // bell character
  b: "\b",
  // backspace
  e: "\x1B",
  // escape character
  f: "\f",
  // form feed
  n: `
`,
  // line feed
  r: "\r",
  // carriage return
  t: "	",
  // horizontal tab
  v: "\v",
  // vertical tab
  N: "\x85",
  // Unicode next line
  _: "\xA0",
  // Unicode non-breaking space
  L: "\u2028",
  // Unicode line separator
  P: "\u2029",
  // Unicode paragraph separator
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  "	": "	"
};
function parseCharCode(source, offset, length, onError) {
  let cc = source.substr(offset, length), code = cc.length === length && /^[0-9a-fA-F]+$/.test(cc) ? parseInt(cc, 16) : NaN;
  try {
    return String.fromCodePoint(code);
  } catch {
    let raw = source.substr(offset - 2, length + 2);
    return onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`), raw;
  }
}

// yaml/compose/compose-scalar.js
function composeScalar(ctx, token, tagToken, onError) {
  let { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar(ctx, token, onError) : resolveFlowScalar(token, ctx.options.strict, onError), tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null, tag;
  ctx.options.stringKeys && ctx.atKey ? tag = ctx.schema[SCALAR] : tagName ? tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError) : token.type === "scalar" ? tag = findScalarTagByTest(ctx, value, token, onError) : tag = ctx.schema[SCALAR];
  let scalar;
  try {
    let res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
    scalar = isScalar(res) ? res : new Scalar(res);
  } catch (error) {
    let msg = error instanceof Error ? error.message : String(error);
    onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), scalar = new Scalar(value);
  }
  return scalar.range = range, scalar.source = value, type && (scalar.type = type), tagName && (scalar.tag = tagName), tag.format && (scalar.format = tag.format), comment && (scalar.comment = comment), scalar;
}
function findScalarTagByName(schema4, value, tagName, tagToken, onError) {
  if (tagName === "!")
    return schema4[SCALAR];
  let matchWithTest = [];
  for (let tag of schema4.tags)
    if (!tag.collection && tag.tag === tagName)
      if (tag.default && tag.test)
        matchWithTest.push(tag);
      else
        return tag;
  for (let tag of matchWithTest)
    if (tag.test?.test(value))
      return tag;
  let kt = schema4.knownTags[tagName];
  return kt && !kt.collection ? (schema4.tags.push(Object.assign({}, kt, { default: !1, test: void 0 })), kt) : (onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str"), schema4[SCALAR]);
}
function findScalarTagByTest({ atKey, directives, schema: schema4 }, value, token, onError) {
  let tag = schema4.tags.find((tag2) => (tag2.default === !0 || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema4[SCALAR];
  if (schema4.compat) {
    let compat = schema4.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema4[SCALAR];
    if (tag.tag !== compat.tag) {
      let ts = directives.tagString(tag.tag), cs = directives.tagString(compat.tag), msg = `Value may be parsed as either ${ts} or ${cs}`;
      onError(token, "TAG_RESOLVE_FAILED", msg, !0);
    }
  }
  return tag;
}

// yaml/compose/util-empty-scalar-position.js
function emptyScalarPosition(offset, before, pos) {
  if (before) {
    pos ?? (pos = before.length);
    for (let i = pos - 1; i >= 0; --i) {
      let st = before[i];
      switch (st.type) {
        case "space":
        case "comment":
        case "newline":
          offset -= st.source.length;
          continue;
      }
      for (st = before[++i]; st?.type === "space"; )
        offset += st.source.length, st = before[++i];
      break;
    }
  }
  return offset;
}

// yaml/compose/compose-node.js
var CN = { composeNode, composeEmptyNode };
function composeNode(ctx, token, props, onError) {
  let atKey = ctx.atKey, { spaceBefore, comment, anchor, tag } = props, node, isSrcToken = !0;
  switch (token.type) {
    case "alias":
      node = composeAlias(ctx, token, onError), (anchor || tag) && onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
      break;
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "block-scalar":
      node = composeScalar(ctx, token, tag, onError), anchor && (node.anchor = anchor.source.substring(1));
      break;
    case "block-map":
    case "block-seq":
    case "flow-collection":
      try {
        node = composeCollection(CN, ctx, token, props, onError), anchor && (node.anchor = anchor.source.substring(1));
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        onError(token, "RESOURCE_EXHAUSTION", message);
      }
      break;
    default: {
      let message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
      onError(token, "UNEXPECTED_TOKEN", message), isSrcToken = !1;
    }
  }
  return node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError)), anchor && node.anchor === "" && onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string"), atKey && ctx.options.stringKeys && (!isScalar(node) || typeof node.value != "string" || node.tag && node.tag !== "tag:yaml.org,2002:str") && onError(tag ?? token, "NON_STRING_KEY", "With stringKeys, all keys must be strings"), spaceBefore && (node.spaceBefore = !0), comment && (token.type === "scalar" && token.source === "" ? node.comment = comment : node.commentBefore = comment), ctx.options.keepSourceTokens && isSrcToken && (node.srcToken = token), node;
}
function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
  let token = {
    type: "scalar",
    offset: emptyScalarPosition(offset, before, pos),
    indent: -1,
    source: ""
  }, node = composeScalar(ctx, token, tag, onError);
  return anchor && (node.anchor = anchor.source.substring(1), node.anchor === "" && onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string")), spaceBefore && (node.spaceBefore = !0), comment && (node.comment = comment, node.range[2] = end), node;
}
function composeAlias({ options }, { offset, source, end }, onError) {
  let alias = new Alias(source.substring(1));
  alias.source === "" && onError(offset, "BAD_ALIAS", "Alias cannot be an empty string"), alias.source.endsWith(":") && onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", !0);
  let valueEnd = offset + source.length, re = resolveEnd(end, valueEnd, options.strict, onError);
  return alias.range = [offset, valueEnd, re.offset], re.comment && (alias.comment = re.comment), alias;
}

// yaml/compose/compose-doc.js
function composeDoc(options, directives, { offset, start, value, end }, onError) {
  let opts = Object.assign({ _directives: directives }, options), doc = new Document(void 0, opts), ctx = {
    atKey: !1,
    atRoot: !0,
    directives: doc.directives,
    options: doc.options,
    schema: doc.schema
  }, props = resolveProps(start, {
    indicator: "doc-start",
    next: value ?? end?.[0],
    offset,
    onError,
    parentIndent: 0,
    startOnNewline: !0
  });
  props.found && (doc.directives.docStart = !0, value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline && onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker")), doc.contents = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
  let contentEnd = doc.contents.range[2], re = resolveEnd(end, contentEnd, !1, onError);
  return re.comment && (doc.comment = re.comment), doc.range = [offset, contentEnd, re.offset], doc;
}

// yaml/compose/composer.js
function getErrorPos(src) {
  if (typeof src == "number")
    return [src, src + 1];
  if (Array.isArray(src))
    return src.length === 2 ? src : [src[0], src[1]];
  let { offset, source } = src;
  return [offset, offset + (typeof source == "string" ? source.length : 1)];
}
function parsePrelude(prelude) {
  let comment = "", atComment = !1, afterEmptyLine = !1;
  for (let i = 0; i < prelude.length; ++i) {
    let source = prelude[i];
    switch (source[0]) {
      case "#":
        comment += (comment === "" ? "" : afterEmptyLine ? `

` : `
`) + (source.substring(1) || " "), atComment = !0, afterEmptyLine = !1;
        break;
      case "%":
        prelude[i + 1]?.[0] !== "#" && (i += 1), atComment = !1;
        break;
      default:
        atComment || (afterEmptyLine = !0), atComment = !1;
    }
  }
  return { comment, afterEmptyLine };
}
var Composer = class {
  constructor(options = {}) {
    this.doc = null, this.atDirectives = !1, this.prelude = [], this.errors = [], this.warnings = [], this.onError = (source, code, message, warning) => {
      let pos = getErrorPos(source);
      warning ? this.warnings.push(new YAMLWarning(pos, code, message)) : this.errors.push(new YAMLParseError(pos, code, message));
    }, this.directives = new Directives({ version: options.version || "1.2" }), this.options = options;
  }
  decorate(doc, afterDoc) {
    let { comment, afterEmptyLine } = parsePrelude(this.prelude);
    if (comment) {
      let dc = doc.contents;
      if (afterDoc)
        doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
      else if (afterEmptyLine || doc.directives.docStart || !dc)
        doc.commentBefore = comment;
      else if (isCollection(dc) && !dc.flow && dc.items.length > 0) {
        let it = dc.items[0];
        isPair(it) && (it = it.key);
        let cb = it.commentBefore;
        it.commentBefore = cb ? `${comment}
${cb}` : comment;
      } else {
        let cb = dc.commentBefore;
        dc.commentBefore = cb ? `${comment}
${cb}` : comment;
      }
    }
    if (afterDoc) {
      for (let i = 0; i < this.errors.length; ++i)
        doc.errors.push(this.errors[i]);
      for (let i = 0; i < this.warnings.length; ++i)
        doc.warnings.push(this.warnings[i]);
    } else
      doc.errors = this.errors, doc.warnings = this.warnings;
    this.prelude = [], this.errors = [], this.warnings = [];
  }
  /**
   * Current stream status information.
   *
   * Mostly useful at the end of input for an empty stream.
   */
  streamInfo() {
    return {
      comment: parsePrelude(this.prelude).comment,
      directives: this.directives,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  /**
   * Compose tokens into documents.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *compose(tokens, forceDoc = !1, endOffset = -1) {
    for (let token of tokens)
      yield* this.next(token);
    yield* this.end(forceDoc, endOffset);
  }
  /** Advance the composer by one CST token. */
  *next(token) {
    switch (token.type) {
      case "directive":
        this.directives.add(token.source, (offset, message, warning) => {
          let pos = getErrorPos(token);
          pos[0] += offset, this.onError(pos, "BAD_DIRECTIVE", message, warning);
        }), this.prelude.push(token.source), this.atDirectives = !0;
        break;
      case "document": {
        let doc = composeDoc(this.options, this.directives, token, this.onError);
        this.atDirectives && !doc.directives.docStart && this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line"), this.decorate(doc, !1), this.doc && (yield this.doc), this.doc = doc, this.atDirectives = !1;
        break;
      }
      case "byte-order-mark":
      case "space":
        break;
      case "comment":
      case "newline":
        this.prelude.push(token.source);
        break;
      case "error": {
        let msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message, error = new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
        this.atDirectives || !this.doc ? this.errors.push(error) : this.doc.errors.push(error);
        break;
      }
      case "doc-end": {
        if (!this.doc) {
          let msg = "Unexpected doc-end without preceding document";
          this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
          break;
        }
        this.doc.directives.docEnd = !0;
        let end = resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
        if (this.decorate(this.doc, !0), end.comment) {
          let dc = this.doc.comment;
          this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
        }
        this.doc.range[2] = end.offset;
        break;
      }
      default:
        this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
    }
  }
  /**
   * Call at end of input to yield any remaining document.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *end(forceDoc = !1, endOffset = -1) {
    if (this.doc)
      this.decorate(this.doc, !0), yield this.doc, this.doc = null;
    else if (forceDoc) {
      let opts = Object.assign({ _directives: this.directives }, this.options), doc = new Document(void 0, opts);
      this.atDirectives && this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line"), doc.range = [0, endOffset, endOffset], this.decorate(doc, !1), yield doc;
    }
  }
};

// yaml/parse/cst-visit.js
var BREAK2 = /* @__PURE__ */ Symbol("break visit"), SKIP2 = /* @__PURE__ */ Symbol("skip children"), REMOVE2 = /* @__PURE__ */ Symbol("remove item");
function visit3(cst, visitor) {
  "type" in cst && cst.type === "document" && (cst = { start: cst.start, value: cst.value }), _visit(Object.freeze([]), cst, visitor);
}
visit3.BREAK = BREAK2;
visit3.SKIP = SKIP2;
visit3.REMOVE = REMOVE2;
visit3.itemAtPath = (cst, path) => {
  let item = cst;
  for (let [field, index] of path) {
    let tok = item?.[field];
    if (tok && "items" in tok)
      item = tok.items[index];
    else
      return;
  }
  return item;
};
visit3.parentCollection = (cst, path) => {
  let parent = visit3.itemAtPath(cst, path.slice(0, -1)), field = path[path.length - 1][0], coll = parent?.[field];
  if (coll && "items" in coll)
    return coll;
  throw new Error("Parent collection not found");
};
function _visit(path, item, visitor) {
  let ctrl = visitor(item, path);
  if (typeof ctrl == "symbol")
    return ctrl;
  for (let field of ["key", "value"]) {
    let token = item[field];
    if (token && "items" in token) {
      for (let i = 0; i < token.items.length; ++i) {
        let ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
        if (typeof ci == "number")
          i = ci - 1;
        else {
          if (ci === BREAK2)
            return BREAK2;
          ci === REMOVE2 && (token.items.splice(i, 1), i -= 1);
        }
      }
      typeof ctrl == "function" && field === "key" && (ctrl = ctrl(item, path));
    }
  }
  return typeof ctrl == "function" ? ctrl(item, path) : ctrl;
}

// yaml/parse/cst.js
var BOM = "\uFEFF", DOCUMENT = "", FLOW_END = "", SCALAR2 = "";
function tokenType(source) {
  switch (source) {
    case BOM:
      return "byte-order-mark";
    case DOCUMENT:
      return "doc-mode";
    case FLOW_END:
      return "flow-error-end";
    case SCALAR2:
      return "scalar";
    case "---":
      return "doc-start";
    case "...":
      return "doc-end";
    case "":
    case `
`:
    case `\r
`:
      return "newline";
    case "-":
      return "seq-item-ind";
    case "?":
      return "explicit-key-ind";
    case ":":
      return "map-value-ind";
    case "{":
      return "flow-map-start";
    case "}":
      return "flow-map-end";
    case "[":
      return "flow-seq-start";
    case "]":
      return "flow-seq-end";
    case ",":
      return "comma";
  }
  switch (source[0]) {
    case " ":
    case "	":
      return "space";
    case "#":
      return "comment";
    case "%":
      return "directive-line";
    case "*":
      return "alias";
    case "&":
      return "anchor";
    case "!":
      return "tag";
    case "'":
      return "single-quoted-scalar";
    case '"':
      return "double-quoted-scalar";
    case "|":
    case ">":
      return "block-scalar-header";
  }
  return null;
}

// yaml/parse/lexer.js
function isEmpty(ch) {
  switch (ch) {
    case void 0:
    case " ":
    case `
`:
    case "\r":
    case "	":
      return !0;
    default:
      return !1;
  }
}
var hexDigits = new Set("0123456789ABCDEFabcdef"), tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()"), flowIndicatorChars = new Set(",[]{}"), invalidAnchorChars = new Set(` ,[]{}
\r	`), isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch), Lexer = class {
  constructor() {
    this.atEnd = !1, this.blockScalarIndent = -1, this.blockScalarKeep = !1, this.buffer = "", this.flowKey = !1, this.flowLevel = 0, this.indentNext = 0, this.indentValue = 0, this.lineEndPos = null, this.next = null, this.pos = 0;
  }
  /**
   * Generate YAML tokens from the `source` string. If `incomplete`,
   * a part of the last line may be left as a buffer for the next call.
   *
   * @returns A generator of lexical tokens
   */
  *lex(source, incomplete = !1) {
    if (source) {
      if (typeof source != "string")
        throw TypeError("source is not a string");
      this.buffer = this.buffer ? this.buffer + source : source, this.lineEndPos = null;
    }
    this.atEnd = !incomplete;
    let next = this.next ?? "stream";
    for (; next && (incomplete || this.hasChars(1)); )
      next = yield* this.parseNext(next);
  }
  atLineEnd() {
    let i = this.pos, ch = this.buffer[i];
    for (; ch === " " || ch === "	"; )
      ch = this.buffer[++i];
    return !ch || ch === "#" || ch === `
` ? !0 : ch === "\r" ? this.buffer[i + 1] === `
` : !1;
  }
  charAt(n) {
    return this.buffer[this.pos + n];
  }
  continueScalar(offset) {
    let ch = this.buffer[offset];
    if (this.indentNext > 0) {
      let indent = 0;
      for (; ch === " "; )
        ch = this.buffer[++indent + offset];
      if (ch === "\r") {
        let next = this.buffer[indent + offset + 1];
        if (next === `
` || !next && !this.atEnd)
          return offset + indent + 1;
      }
      return ch === `
` || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
    }
    if (ch === "-" || ch === ".") {
      let dt = this.buffer.substr(offset, 3);
      if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
        return -1;
    }
    return offset;
  }
  getLine() {
    let end = this.lineEndPos;
    return (typeof end != "number" || end !== -1 && end < this.pos) && (end = this.buffer.indexOf(`
`, this.pos), this.lineEndPos = end), end === -1 ? this.atEnd ? this.buffer.substring(this.pos) : null : (this.buffer[end - 1] === "\r" && (end -= 1), this.buffer.substring(this.pos, end));
  }
  hasChars(n) {
    return this.pos + n <= this.buffer.length;
  }
  setNext(state) {
    return this.buffer = this.buffer.substring(this.pos), this.pos = 0, this.lineEndPos = null, this.next = state, null;
  }
  peek(n) {
    return this.buffer.substr(this.pos, n);
  }
  *parseNext(next) {
    switch (next) {
      case "stream":
        return yield* this.parseStream();
      case "line-start":
        return yield* this.parseLineStart();
      case "block-start":
        return yield* this.parseBlockStart();
      case "doc":
        return yield* this.parseDocument();
      case "flow":
        return yield* this.parseFlowCollection();
      case "quoted-scalar":
        return yield* this.parseQuotedScalar();
      case "block-scalar":
        return yield* this.parseBlockScalar();
      case "plain-scalar":
        return yield* this.parsePlainScalar();
    }
  }
  *parseStream() {
    let line = this.getLine();
    if (line === null)
      return this.setNext("stream");
    if (line[0] === BOM && (yield* this.pushCount(1), line = line.substring(1)), line[0] === "%") {
      let dirEnd = line.length, cs = line.indexOf("#");
      for (; cs !== -1; ) {
        let ch = line[cs - 1];
        if (ch === " " || ch === "	") {
          dirEnd = cs - 1;
          break;
        } else
          cs = line.indexOf("#", cs + 1);
      }
      for (; ; ) {
        let ch = line[dirEnd - 1];
        if (ch === " " || ch === "	")
          dirEnd -= 1;
        else
          break;
      }
      let n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(!0));
      return yield* this.pushCount(line.length - n), this.pushNewline(), "stream";
    }
    if (this.atLineEnd()) {
      let sp = yield* this.pushSpaces(!0);
      return yield* this.pushCount(line.length - sp), yield* this.pushNewline(), "stream";
    }
    return yield DOCUMENT, yield* this.parseLineStart();
  }
  *parseLineStart() {
    let ch = this.charAt(0);
    if (!ch && !this.atEnd)
      return this.setNext("line-start");
    if (ch === "-" || ch === ".") {
      if (!this.atEnd && !this.hasChars(4))
        return this.setNext("line-start");
      let s = this.peek(3);
      if ((s === "---" || s === "...") && isEmpty(this.charAt(3)))
        return yield* this.pushCount(3), this.indentValue = 0, this.indentNext = 0, s === "---" ? "doc" : "stream";
    }
    return this.indentValue = yield* this.pushSpaces(!1), this.indentNext > this.indentValue && !isEmpty(this.charAt(1)) && (this.indentNext = this.indentValue), yield* this.parseBlockStart();
  }
  *parseBlockStart() {
    let [ch0, ch1] = this.peek(2);
    if (!ch1 && !this.atEnd)
      return this.setNext("block-start");
    if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
      let n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(!0));
      return this.indentNext = this.indentValue + 1, this.indentValue += n, "block-start";
    }
    return "doc";
  }
  *parseDocument() {
    yield* this.pushSpaces(!0);
    let line = this.getLine();
    if (line === null)
      return this.setNext("doc");
    let n = yield* this.pushIndicators();
    switch (line[n]) {
      case "#":
        yield* this.pushCount(line.length - n);
      // fallthrough
      case void 0:
        return yield* this.pushNewline(), yield* this.parseLineStart();
      case "{":
      case "[":
        return yield* this.pushCount(1), this.flowKey = !1, this.flowLevel = 1, "flow";
      case "}":
      case "]":
        return yield* this.pushCount(1), "doc";
      case "*":
        return yield* this.pushUntil(isNotAnchorChar), "doc";
      case '"':
      case "'":
        return yield* this.parseQuotedScalar();
      case "|":
      case ">":
        return n += yield* this.parseBlockScalarHeader(), n += yield* this.pushSpaces(!0), yield* this.pushCount(line.length - n), yield* this.pushNewline(), yield* this.parseBlockScalar();
      default:
        return yield* this.parsePlainScalar();
    }
  }
  *parseFlowCollection() {
    let nl, sp, indent = -1;
    do
      nl = yield* this.pushNewline(), nl > 0 ? (sp = yield* this.pushSpaces(!1), this.indentValue = indent = sp) : sp = 0, sp += yield* this.pushSpaces(!0);
    while (nl + sp > 0);
    let line = this.getLine();
    if (line === null)
      return this.setNext("flow");
    if ((indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) && !(indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}")))
      return this.flowLevel = 0, yield FLOW_END, yield* this.parseLineStart();
    let n = 0;
    for (; line[n] === ","; )
      n += yield* this.pushCount(1), n += yield* this.pushSpaces(!0), this.flowKey = !1;
    switch (n += yield* this.pushIndicators(), line[n]) {
      case void 0:
        return "flow";
      case "#":
        return yield* this.pushCount(line.length - n), "flow";
      case "{":
      case "[":
        return yield* this.pushCount(1), this.flowKey = !1, this.flowLevel += 1, "flow";
      case "}":
      case "]":
        return yield* this.pushCount(1), this.flowKey = !0, this.flowLevel -= 1, this.flowLevel ? "flow" : "doc";
      case "*":
        return yield* this.pushUntil(isNotAnchorChar), "flow";
      case '"':
      case "'":
        return this.flowKey = !0, yield* this.parseQuotedScalar();
      case ":": {
        let next = this.charAt(1);
        if (this.flowKey || isEmpty(next) || next === ",")
          return this.flowKey = !1, yield* this.pushCount(1), yield* this.pushSpaces(!0), "flow";
      }
      // fallthrough
      default:
        return this.flowKey = !1, yield* this.parsePlainScalar();
    }
  }
  *parseQuotedScalar() {
    let quote = this.charAt(0), end = this.buffer.indexOf(quote, this.pos + 1);
    if (quote === "'")
      for (; end !== -1 && this.buffer[end + 1] === "'"; )
        end = this.buffer.indexOf("'", end + 2);
    else
      for (; end !== -1; ) {
        let n = 0;
        for (; this.buffer[end - 1 - n] === "\\"; )
          n += 1;
        if (n % 2 === 0)
          break;
        end = this.buffer.indexOf('"', end + 1);
      }
    let qb = this.buffer.substring(0, end), nl = qb.indexOf(`
`, this.pos);
    if (nl !== -1) {
      for (; nl !== -1; ) {
        let cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = qb.indexOf(`
`, cs);
      }
      nl !== -1 && (end = nl - (qb[nl - 1] === "\r" ? 2 : 1));
    }
    if (end === -1) {
      if (!this.atEnd)
        return this.setNext("quoted-scalar");
      end = this.buffer.length;
    }
    return yield* this.pushToIndex(end + 1, !1), this.flowLevel ? "flow" : "doc";
  }
  *parseBlockScalarHeader() {
    this.blockScalarIndent = -1, this.blockScalarKeep = !1;
    let i = this.pos;
    for (; ; ) {
      let ch = this.buffer[++i];
      if (ch === "+")
        this.blockScalarKeep = !0;
      else if (ch > "0" && ch <= "9")
        this.blockScalarIndent = Number(ch) - 1;
      else if (ch !== "-")
        break;
    }
    return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
  }
  *parseBlockScalar() {
    let nl = this.pos - 1, indent = 0, ch;
    loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2)
      switch (ch) {
        case " ":
          indent += 1;
          break;
        case `
`:
          nl = i2, indent = 0;
          break;
        case "\r": {
          let next = this.buffer[i2 + 1];
          if (!next && !this.atEnd)
            return this.setNext("block-scalar");
          if (next === `
`)
            break;
        }
        // fallthrough
        default:
          break loop;
      }
    if (!ch && !this.atEnd)
      return this.setNext("block-scalar");
    if (indent >= this.indentNext) {
      this.blockScalarIndent === -1 ? this.indentNext = indent : this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
      do {
        let cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = this.buffer.indexOf(`
`, cs);
      } while (nl !== -1);
      if (nl === -1) {
        if (!this.atEnd)
          return this.setNext("block-scalar");
        nl = this.buffer.length;
      }
    }
    let i = nl + 1;
    for (ch = this.buffer[i]; ch === " "; )
      ch = this.buffer[++i];
    if (ch === "	") {
      for (; ch === "	" || ch === " " || ch === "\r" || ch === `
`; )
        ch = this.buffer[++i];
      nl = i - 1;
    } else if (!this.blockScalarKeep)
      do {
        let i2 = nl - 1, ch2 = this.buffer[i2];
        ch2 === "\r" && (ch2 = this.buffer[--i2]);
        let lastChar = i2;
        for (; ch2 === " "; )
          ch2 = this.buffer[--i2];
        if (ch2 === `
` && i2 >= this.pos && i2 + 1 + indent > lastChar)
          nl = i2;
        else
          break;
      } while (!0);
    return yield SCALAR2, yield* this.pushToIndex(nl + 1, !0), yield* this.parseLineStart();
  }
  *parsePlainScalar() {
    let inFlow = this.flowLevel > 0, end = this.pos - 1, i = this.pos - 1, ch;
    for (; ch = this.buffer[++i]; )
      if (ch === ":") {
        let next = this.buffer[i + 1];
        if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
          break;
        end = i;
      } else if (isEmpty(ch)) {
        let next = this.buffer[i + 1];
        if (ch === "\r" && (next === `
` ? (i += 1, ch = `
`, next = this.buffer[i + 1]) : end = i), next === "#" || inFlow && flowIndicatorChars.has(next))
          break;
        if (ch === `
`) {
          let cs = this.continueScalar(i + 1);
          if (cs === -1)
            break;
          i = Math.max(i, cs - 2);
        }
      } else {
        if (inFlow && flowIndicatorChars.has(ch))
          break;
        end = i;
      }
    return !ch && !this.atEnd ? this.setNext("plain-scalar") : (yield SCALAR2, yield* this.pushToIndex(end + 1, !0), inFlow ? "flow" : "doc");
  }
  *pushCount(n) {
    return n > 0 ? (yield this.buffer.substr(this.pos, n), this.pos += n, n) : 0;
  }
  *pushToIndex(i, allowEmpty) {
    let s = this.buffer.slice(this.pos, i);
    return s ? (yield s, this.pos += s.length, s.length) : (allowEmpty && (yield ""), 0);
  }
  *pushIndicators() {
    let n = 0;
    loop: for (; ; ) {
      switch (this.charAt(0)) {
        case "!":
          n += yield* this.pushTag(), n += yield* this.pushSpaces(!0);
          continue loop;
        case "&":
          n += yield* this.pushUntil(isNotAnchorChar), n += yield* this.pushSpaces(!0);
          continue loop;
        case "-":
        // this is an error
        case "?":
        // this is an error outside flow collections
        case ":": {
          let inFlow = this.flowLevel > 0, ch1 = this.charAt(1);
          if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
            inFlow ? this.flowKey && (this.flowKey = !1) : this.indentNext = this.indentValue + 1, n += yield* this.pushCount(1), n += yield* this.pushSpaces(!0);
            continue loop;
          }
        }
      }
      break loop;
    }
    return n;
  }
  *pushTag() {
    if (this.charAt(1) === "<") {
      let i = this.pos + 2, ch = this.buffer[i];
      for (; !isEmpty(ch) && ch !== ">"; )
        ch = this.buffer[++i];
      return yield* this.pushToIndex(ch === ">" ? i + 1 : i, !1);
    } else {
      let i = this.pos + 1, ch = this.buffer[i];
      for (; ch; )
        if (tagChars.has(ch))
          ch = this.buffer[++i];
        else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2]))
          ch = this.buffer[i += 3];
        else
          break;
      return yield* this.pushToIndex(i, !1);
    }
  }
  *pushNewline() {
    let ch = this.buffer[this.pos];
    return ch === `
` ? yield* this.pushCount(1) : ch === "\r" && this.charAt(1) === `
` ? yield* this.pushCount(2) : 0;
  }
  *pushSpaces(allowTabs) {
    let i = this.pos - 1, ch;
    do
      ch = this.buffer[++i];
    while (ch === " " || allowTabs && ch === "	");
    let n = i - this.pos;
    return n > 0 && (yield this.buffer.substr(this.pos, n), this.pos = i), n;
  }
  *pushUntil(test) {
    let i = this.pos, ch = this.buffer[i];
    for (; !test(ch); )
      ch = this.buffer[++i];
    return yield* this.pushToIndex(i, !1);
  }
};

// yaml/parse/parser.js
function includesToken(list, type) {
  for (let i = 0; i < list.length; ++i)
    if (list[i].type === type)
      return !0;
  return !1;
}
function findNonEmptyIndex(list) {
  for (let i = 0; i < list.length; ++i)
    switch (list[i].type) {
      case "space":
      case "comment":
      case "newline":
        break;
      default:
        return i;
    }
  return -1;
}
function isFlowToken(token) {
  switch (token?.type) {
    case "alias":
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "flow-collection":
      return !0;
    default:
      return !1;
  }
}
function getPrevProps(parent) {
  switch (parent.type) {
    case "document":
      return parent.start;
    case "block-map": {
      let it = parent.items[parent.items.length - 1];
      return it.sep ?? it.start;
    }
    case "block-seq":
      return parent.items[parent.items.length - 1].start;
    /* istanbul ignore next should not happen */
    default:
      return [];
  }
}
function getFirstKeyStartProps(prev) {
  if (prev.length === 0)
    return [];
  let i = prev.length;
  loop: for (; --i >= 0; )
    switch (prev[i].type) {
      case "doc-start":
      case "explicit-key-ind":
      case "map-value-ind":
      case "seq-item-ind":
      case "newline":
        break loop;
    }
  for (; prev[++i]?.type === "space"; )
    ;
  return prev.splice(i, prev.length);
}
function arrayPushArray(target, source) {
  if (source.length < 1e5)
    Array.prototype.push.apply(target, source);
  else
    for (let i = 0; i < source.length; ++i)
      target.push(source[i]);
}
function fixFlowSeqItems(fc) {
  if (fc.start.type === "flow-seq-start")
    for (let it of fc.items)
      it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind") && (it.key && (it.value = it.key), delete it.key, isFlowToken(it.value) ? it.value.end ? arrayPushArray(it.value.end, it.sep) : it.value.end = it.sep : arrayPushArray(it.start, it.sep), delete it.sep);
}
var Parser = class {
  /**
   * @param onNewLine - If defined, called separately with the start position of
   *   each new line (in `parse()`, including the start of input).
   */
  constructor(onNewLine) {
    this.atNewLine = !0, this.atScalar = !1, this.indent = 0, this.offset = 0, this.onKeyLine = !1, this.stack = [], this.source = "", this.type = "", this.lexer = new Lexer(), this.onNewLine = onNewLine;
  }
  /**
   * Parse `source` as a YAML stream.
   * If `incomplete`, a part of the last line may be left as a buffer for the next call.
   *
   * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
   *
   * @returns A generator of tokens representing each directive, document, and other structure.
   */
  *parse(source, incomplete = !1) {
    this.onNewLine && this.offset === 0 && this.onNewLine(0);
    for (let lexeme of this.lexer.lex(source, incomplete))
      yield* this.next(lexeme);
    incomplete || (yield* this.end());
  }
  /**
   * Advance the parser by the `source` of one lexical token.
   */
  *next(source) {
    if (this.source = source, this.atScalar) {
      this.atScalar = !1, yield* this.step(), this.offset += source.length;
      return;
    }
    let type = tokenType(source);
    if (type)
      if (type === "scalar")
        this.atNewLine = !1, this.atScalar = !0, this.type = "scalar";
      else {
        switch (this.type = type, yield* this.step(), type) {
          case "newline":
            this.atNewLine = !0, this.indent = 0, this.onNewLine && this.onNewLine(this.offset + source.length);
            break;
          case "space":
            this.atNewLine && source[0] === " " && (this.indent += source.length);
            break;
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
            this.atNewLine && (this.indent += source.length);
            break;
          case "doc-mode":
          case "flow-error-end":
            return;
          default:
            this.atNewLine = !1;
        }
        this.offset += source.length;
      }
    else {
      let message = `Not a YAML token: ${source}`;
      yield* this.pop({ type: "error", offset: this.offset, message, source }), this.offset += source.length;
    }
  }
  /** Call at end of input to push out any remaining constructions */
  *end() {
    for (; this.stack.length > 0; )
      yield* this.pop();
  }
  get sourceToken() {
    return {
      type: this.type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
  }
  *step() {
    let top = this.peek(1);
    if (this.type === "doc-end" && top?.type !== "doc-end") {
      for (; this.stack.length > 0; )
        yield* this.pop();
      this.stack.push({
        type: "doc-end",
        offset: this.offset,
        source: this.source
      });
      return;
    }
    if (!top)
      return yield* this.stream();
    switch (top.type) {
      case "document":
        return yield* this.document(top);
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return yield* this.scalar(top);
      case "block-scalar":
        return yield* this.blockScalar(top);
      case "block-map":
        return yield* this.blockMap(top);
      case "block-seq":
        return yield* this.blockSequence(top);
      case "flow-collection":
        return yield* this.flowCollection(top);
      case "doc-end":
        return yield* this.documentEnd(top);
    }
    yield* this.pop();
  }
  peek(n) {
    return this.stack[this.stack.length - n];
  }
  *pop(error) {
    let token = error ?? this.stack.pop();
    if (!token)
      yield { type: "error", offset: this.offset, source: "", message: "Tried to pop an empty stack" };
    else if (this.stack.length === 0)
      yield token;
    else {
      let top = this.peek(1);
      switch (token.type === "block-scalar" ? token.indent = "indent" in top ? top.indent : 0 : token.type === "flow-collection" && top.type === "document" && (token.indent = 0), token.type === "flow-collection" && fixFlowSeqItems(token), top.type) {
        case "document":
          top.value = token;
          break;
        case "block-scalar":
          top.props.push(token);
          break;
        case "block-map": {
          let it = top.items[top.items.length - 1];
          if (it.value) {
            top.items.push({ start: [], key: token, sep: [] }), this.onKeyLine = !0;
            return;
          } else if (it.sep)
            it.value = token;
          else {
            Object.assign(it, { key: token, sep: [] }), this.onKeyLine = !it.explicitKey;
            return;
          }
          break;
        }
        case "block-seq": {
          let it = top.items[top.items.length - 1];
          it.value ? top.items.push({ start: [], value: token }) : it.value = token;
          break;
        }
        case "flow-collection": {
          let it = top.items[top.items.length - 1];
          !it || it.value ? top.items.push({ start: [], key: token, sep: [] }) : it.sep ? it.value = token : Object.assign(it, { key: token, sep: [] });
          return;
        }
        /* istanbul ignore next should not happen */
        default:
          yield* this.pop(), yield* this.pop(token);
      }
      if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
        let last = token.items[token.items.length - 1];
        last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent)) && (top.type === "document" ? top.end = last.start : top.items.push({ start: last.start }), token.items.splice(-1, 1));
      }
    }
  }
  *stream() {
    switch (this.type) {
      case "directive-line":
        yield { type: "directive", offset: this.offset, source: this.source };
        return;
      case "byte-order-mark":
      case "space":
      case "comment":
      case "newline":
        yield this.sourceToken;
        return;
      case "doc-mode":
      case "doc-start": {
        let doc = {
          type: "document",
          offset: this.offset,
          start: []
        };
        this.type === "doc-start" && doc.start.push(this.sourceToken), this.stack.push(doc);
        return;
      }
    }
    yield {
      type: "error",
      offset: this.offset,
      message: `Unexpected ${this.type} token in YAML stream`,
      source: this.source
    };
  }
  *document(doc) {
    if (doc.value)
      return yield* this.lineEnd(doc);
    switch (this.type) {
      case "doc-start": {
        findNonEmptyIndex(doc.start) !== -1 ? (yield* this.pop(), yield* this.step()) : doc.start.push(this.sourceToken);
        return;
      }
      case "anchor":
      case "tag":
      case "space":
      case "comment":
      case "newline":
        doc.start.push(this.sourceToken);
        return;
    }
    let bv = this.startBlockValue(doc);
    bv ? this.stack.push(bv) : yield {
      type: "error",
      offset: this.offset,
      message: `Unexpected ${this.type} token in YAML document`,
      source: this.source
    };
  }
  *scalar(scalar) {
    if (this.type === "map-value-ind") {
      let prev = getPrevProps(this.peek(2)), start = getFirstKeyStartProps(prev), sep;
      scalar.end ? (sep = scalar.end, sep.push(this.sourceToken), delete scalar.end) : sep = [this.sourceToken];
      let map2 = {
        type: "block-map",
        offset: scalar.offset,
        indent: scalar.indent,
        items: [{ start, key: scalar, sep }]
      };
      this.onKeyLine = !0, this.stack[this.stack.length - 1] = map2;
    } else
      yield* this.lineEnd(scalar);
  }
  *blockScalar(scalar) {
    switch (this.type) {
      case "space":
      case "comment":
      case "newline":
        scalar.props.push(this.sourceToken);
        return;
      case "scalar":
        if (scalar.source = this.source, this.atNewLine = !0, this.indent = 0, this.onNewLine) {
          let nl = this.source.indexOf(`
`) + 1;
          for (; nl !== 0; )
            this.onNewLine(this.offset + nl), nl = this.source.indexOf(`
`, nl) + 1;
        }
        yield* this.pop();
        break;
      /* istanbul ignore next should not happen */
      default:
        yield* this.pop(), yield* this.step();
    }
  }
  *blockMap(map2) {
    let it = map2.items[map2.items.length - 1];
    switch (this.type) {
      case "newline":
        if (this.onKeyLine = !1, it.value) {
          let end = "end" in it.value ? it.value.end : void 0;
          (Array.isArray(end) ? end[end.length - 1] : void 0)?.type === "comment" ? end?.push(this.sourceToken) : map2.items.push({ start: [this.sourceToken] });
        } else it.sep ? it.sep.push(this.sourceToken) : it.start.push(this.sourceToken);
        return;
      case "space":
      case "comment":
        if (it.value)
          map2.items.push({ start: [this.sourceToken] });
        else if (it.sep)
          it.sep.push(this.sourceToken);
        else {
          if (this.atIndentedComment(it.start, map2.indent)) {
            let end = map2.items[map2.items.length - 2]?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start), end.push(this.sourceToken), map2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
    }
    if (this.indent >= map2.indent) {
      let atMapIndent = !this.onKeyLine && this.indent === map2.indent, atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind", start = [];
      if (atNextItem && it.sep && !it.value) {
        let nl = [];
        for (let i = 0; i < it.sep.length; ++i) {
          let st = it.sep[i];
          switch (st.type) {
            case "newline":
              nl.push(i);
              break;
            case "space":
              break;
            case "comment":
              st.indent > map2.indent && (nl.length = 0);
              break;
            default:
              nl.length = 0;
          }
        }
        nl.length >= 2 && (start = it.sep.splice(nl[1]));
      }
      switch (this.type) {
        case "anchor":
        case "tag":
          atNextItem || it.value ? (start.push(this.sourceToken), map2.items.push({ start }), this.onKeyLine = !0) : it.sep ? it.sep.push(this.sourceToken) : it.start.push(this.sourceToken);
          return;
        case "explicit-key-ind":
          !it.sep && !it.explicitKey ? (it.start.push(this.sourceToken), it.explicitKey = !0) : atNextItem || it.value ? (start.push(this.sourceToken), map2.items.push({ start, explicitKey: !0 })) : this.stack.push({
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start: [this.sourceToken], explicitKey: !0 }]
          }), this.onKeyLine = !0;
          return;
        case "map-value-ind":
          if (it.explicitKey)
            if (it.sep)
              if (it.value)
                map2.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (includesToken(it.sep, "map-value-ind"))
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }]
                });
              else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                let start2 = getFirstKeyStartProps(it.start), key = it.key, sep = it.sep;
                sep.push(this.sourceToken), delete it.key, delete it.sep, this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key, sep }]
                });
              } else start.length > 0 ? it.sep = it.sep.concat(start, this.sourceToken) : it.sep.push(this.sourceToken);
            else if (includesToken(it.start, "newline"))
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            else {
              let start2 = getFirstKeyStartProps(it.start);
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: start2, key: null, sep: [this.sourceToken] }]
              });
            }
          else
            it.sep ? it.value || atNextItem ? map2.items.push({ start, key: null, sep: [this.sourceToken] }) : includesToken(it.sep, "map-value-ind") ? this.stack.push({
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [], key: null, sep: [this.sourceToken] }]
            }) : it.sep.push(this.sourceToken) : Object.assign(it, { key: null, sep: [this.sourceToken] });
          this.onKeyLine = !0;
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          let fs = this.flowScalar(this.type);
          atNextItem || it.value ? (map2.items.push({ start, key: fs, sep: [] }), this.onKeyLine = !0) : it.sep ? this.stack.push(fs) : (Object.assign(it, { key: fs, sep: [] }), this.onKeyLine = !0);
          return;
        }
        default: {
          let bv = this.startBlockValue(map2);
          if (bv) {
            if (bv.type === "block-seq") {
              if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                yield* this.pop({
                  type: "error",
                  offset: this.offset,
                  message: "Unexpected block-seq-ind on same line with key",
                  source: this.source
                });
                return;
              }
            } else atMapIndent && map2.items.push({ start });
            this.stack.push(bv);
            return;
          }
        }
      }
    }
    yield* this.pop(), yield* this.step();
  }
  *blockSequence(seq2) {
    let it = seq2.items[seq2.items.length - 1];
    switch (this.type) {
      case "newline":
        if (it.value) {
          let end = "end" in it.value ? it.value.end : void 0;
          (Array.isArray(end) ? end[end.length - 1] : void 0)?.type === "comment" ? end?.push(this.sourceToken) : seq2.items.push({ start: [this.sourceToken] });
        } else
          it.start.push(this.sourceToken);
        return;
      case "space":
      case "comment":
        if (it.value)
          seq2.items.push({ start: [this.sourceToken] });
        else {
          if (this.atIndentedComment(it.start, seq2.indent)) {
            let end = seq2.items[seq2.items.length - 2]?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start), end.push(this.sourceToken), seq2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
      case "anchor":
      case "tag":
        if (it.value || this.indent <= seq2.indent)
          break;
        it.start.push(this.sourceToken);
        return;
      case "seq-item-ind":
        if (this.indent !== seq2.indent)
          break;
        it.value || includesToken(it.start, "seq-item-ind") ? seq2.items.push({ start: [this.sourceToken] }) : it.start.push(this.sourceToken);
        return;
    }
    if (this.indent > seq2.indent) {
      let bv = this.startBlockValue(seq2);
      if (bv) {
        this.stack.push(bv);
        return;
      }
    }
    yield* this.pop(), yield* this.step();
  }
  *flowCollection(fc) {
    let it = fc.items[fc.items.length - 1];
    if (this.type === "flow-error-end") {
      let top;
      do
        yield* this.pop(), top = this.peek(1);
      while (top?.type === "flow-collection");
    } else if (fc.end.length === 0) {
      switch (this.type) {
        case "comma":
        case "explicit-key-ind":
          !it || it.sep ? fc.items.push({ start: [this.sourceToken] }) : it.start.push(this.sourceToken);
          return;
        case "map-value-ind":
          !it || it.value ? fc.items.push({ start: [], key: null, sep: [this.sourceToken] }) : it.sep ? it.sep.push(this.sourceToken) : Object.assign(it, { key: null, sep: [this.sourceToken] });
          return;
        case "space":
        case "comment":
        case "newline":
        case "anchor":
        case "tag":
          !it || it.value ? fc.items.push({ start: [this.sourceToken] }) : it.sep ? it.sep.push(this.sourceToken) : it.start.push(this.sourceToken);
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          let fs = this.flowScalar(this.type);
          !it || it.value ? fc.items.push({ start: [], key: fs, sep: [] }) : it.sep ? this.stack.push(fs) : Object.assign(it, { key: fs, sep: [] });
          return;
        }
        case "flow-map-end":
        case "flow-seq-end":
          fc.end.push(this.sourceToken);
          return;
      }
      let bv = this.startBlockValue(fc);
      bv ? this.stack.push(bv) : (yield* this.pop(), yield* this.step());
    } else {
      let parent = this.peek(2);
      if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep))
        yield* this.pop(), yield* this.step();
      else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
        let prev = getPrevProps(parent), start = getFirstKeyStartProps(prev);
        fixFlowSeqItems(fc);
        let sep = fc.end.splice(1, fc.end.length);
        sep.push(this.sourceToken);
        let map2 = {
          type: "block-map",
          offset: fc.offset,
          indent: fc.indent,
          items: [{ start, key: fc, sep }]
        };
        this.onKeyLine = !0, this.stack[this.stack.length - 1] = map2;
      } else
        yield* this.lineEnd(fc);
    }
  }
  flowScalar(type) {
    if (this.onNewLine) {
      let nl = this.source.indexOf(`
`) + 1;
      for (; nl !== 0; )
        this.onNewLine(this.offset + nl), nl = this.source.indexOf(`
`, nl) + 1;
    }
    return {
      type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
  }
  startBlockValue(parent) {
    switch (this.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return this.flowScalar(this.type);
      case "block-scalar-header":
        return {
          type: "block-scalar",
          offset: this.offset,
          indent: this.indent,
          props: [this.sourceToken],
          source: ""
        };
      case "flow-map-start":
      case "flow-seq-start":
        return {
          type: "flow-collection",
          offset: this.offset,
          indent: this.indent,
          start: this.sourceToken,
          items: [],
          end: []
        };
      case "seq-item-ind":
        return {
          type: "block-seq",
          offset: this.offset,
          indent: this.indent,
          items: [{ start: [this.sourceToken] }]
        };
      case "explicit-key-ind": {
        this.onKeyLine = !0;
        let prev = getPrevProps(parent), start = getFirstKeyStartProps(prev);
        return start.push(this.sourceToken), {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, explicitKey: !0 }]
        };
      }
      case "map-value-ind": {
        this.onKeyLine = !0;
        let prev = getPrevProps(parent), start = getFirstKeyStartProps(prev);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, key: null, sep: [this.sourceToken] }]
        };
      }
    }
    return null;
  }
  atIndentedComment(start, indent) {
    return this.type !== "comment" || this.indent <= indent ? !1 : start.every((st) => st.type === "newline" || st.type === "space");
  }
  *documentEnd(docEnd) {
    this.type !== "doc-mode" && (docEnd.end ? docEnd.end.push(this.sourceToken) : docEnd.end = [this.sourceToken], this.type === "newline" && (yield* this.pop()));
  }
  *lineEnd(token) {
    switch (this.type) {
      case "comma":
      case "doc-start":
      case "doc-end":
      case "flow-seq-end":
      case "flow-map-end":
      case "map-value-ind":
        yield* this.pop(), yield* this.step();
        break;
      case "newline":
        this.onKeyLine = !1;
      default:
        token.end ? token.end.push(this.sourceToken) : token.end = [this.sourceToken], this.type === "newline" && (yield* this.pop());
    }
  }
};

// yaml/yaml-parser.js
function parseDocuments(source, options) {
  return Array.from(new Composer(options).compose(new Parser().parse(source)));
}
export {
  parseDocuments
};

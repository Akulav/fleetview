// A small, strict-enough XML reader for KeePass files (elements, attributes,
// text, CDATA, comments, entities). Same code in the browser and in Node.
// Returns { name, attrs, children, text } trees.

const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENT[e] ?? m;
  });
}

export function parseXml(src) {
  let i = 0;
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  const fail = (m) => {
    throw new Error(`XML: ${m} at ${i}`);
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    i = lt;
    if (src.startsWith("<?", i)) {
      const e = src.indexOf("?>", i);
      if (e < 0) fail("unterminated declaration");
      i = e + 2;
    } else if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i);
      if (e < 0) fail("unterminated comment");
      i = e + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const e = src.indexOf("]]>", i);
      if (e < 0) fail("unterminated CDATA");
      top.text += src.slice(i + 9, e);
      i = e + 3;
    } else if (src.startsWith("<!", i)) {
      const e = src.indexOf(">", i);
      i = e + 1; // DOCTYPE: ignored (and never expanded)
    } else if (src[i + 1] === "/") {
      const e = src.indexOf(">", i);
      if (e < 0) fail("unterminated end tag");
      const name = src.slice(i + 2, e).trim();
      const el = stack.pop();
      if (!el || el.name !== name) fail(`mismatched </${name}>`);
      i = e + 1;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(src.slice(i, i + 256));
      if (!m) fail("bad tag");
      const el = { name: m[1], attrs: {}, children: [], text: "" };
      i += m[0].length;
      const attr = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
      for (;;) {
        attr.lastIndex = i;
        const a = attr.exec(src);
        if (!a) break;
        el.attrs[a[1]] = decodeEntities(a[3] ?? a[4]);
        i = attr.lastIndex;
      }
      while (/\s/.test(src[i])) i++;
      top.children.push(el);
      if (src.startsWith("/>", i)) i += 2;
      else if (src[i] === ">") {
        i += 1;
        stack.push(el);
      } else fail("bad tag end");
    }
  }
  if (stack.length !== 1) fail("unclosed elements");
  return root;
}

export const child = (el, name) => el?.children.find((c) => c.name === name) ?? null;
export const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);

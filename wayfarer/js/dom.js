// Tiny DOM helpers: escaped HTML templating and element creation.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

function render(v) {
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
}

class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export const raw = (s) => new Raw(String(s));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element from an html`` fragment (first element child). */
export function el(fragment) {
  const t = document.createElement('template');
  t.innerHTML = String(fragment).trim();
  return t.content.firstElementChild;
}

export function setHTML(node, fragment) {
  node.innerHTML = String(fragment);
  return node;
}

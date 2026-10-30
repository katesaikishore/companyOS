/**
 * The twin's welcome companion. It is built from the logo: two overlapping rings, one for you and one for the twin.
 * They drift toward each other, so their overlap widens when the twin is taking in your work, and the face sits in that
 * overlap. Work shapes (a document, a sheet, a chat) drift in, and the twin takes them up. The picture is decorative.
 * Its motion lives in app.css, so the page's CSP stays strict, and users who ask for reduced motion see it at rest.
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number>;

function node(tag: string, attrs: Attrs, children: Element[] = []): SVGElement {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  element.append(...children);
  return element as SVGElement;
}

/** A work tile at its resting place. The outer group places it; the inner group is what animates. */
function tile(index: number, x: number, y: number, glyph: Element[]): SVGElement {
  return node('g', { transform: `translate(${x} ${y})` }, [
    node('g', { class: `work-tile tile-${index}` }, [node('rect', { x: -26, y: -26, width: 52, height: 52, rx: 12, class: 'tile-face' }), ...glyph]),
  ]);
}

function documentGlyph(): Element[] {
  return [
    node('rect', { x: -12, y: -15, width: 24, height: 30, rx: 3, class: 'tile-page' }),
    node('rect', { x: -7, y: -8, width: 14, height: 2.4, rx: 1.2, class: 'tile-line' }),
    node('rect', { x: -7, y: -2, width: 14, height: 2.4, rx: 1.2, class: 'tile-line' }),
    node('rect', { x: -7, y: 4, width: 9, height: 2.4, rx: 1.2, class: 'tile-line' }),
  ];
}

function sheetGlyph(): Element[] {
  return [node('path', { d: 'M-13 -4H13M-13 6H13M-4 -13V13M6 -13V13', class: 'tile-grid' })];
}

function chatGlyph(): Element[] {
  return [
    node('path', { d: 'M-13 -11H13Q15 -11 15 -9V5Q15 7 13 7H-2L-8 12V7H-13Q-15 7 -15 5V-9Q-15 -11 -13 -11Z', class: 'tile-bubble' }),
  ];
}

/**
 * The two rings from the logo, drawn larger and filled so their overlap reads as a lens. The face sits in the lens.
 * The left ring is the person's side and the right ring is the twin's; both keep the logo's proportions.
 */
function twinRings(): SVGElement {
  return node('g', { class: 'twin-float' }, [
    node('ellipse', { cx: 180, cy: 186, rx: 58, ry: 6, class: 'twin-shadow' }),
    node('g', { class: 'ring ring-left' }, [node('circle', { cx: 156, cy: 134, r: 46, class: 'twin-ring twin-ring-a' })]),
    node('g', { class: 'ring ring-right' }, [node('circle', { cx: 204, cy: 134, r: 46, class: 'twin-ring twin-ring-b' })]),
    node('g', { class: 'eye eye-left' }, [node('ellipse', { cx: 173, cy: 127, rx: 4.5, ry: 6, class: 'twin-eye' }), node('circle', { cx: 174.6, cy: 124.5, r: 1.6, class: 'twin-glint' })]),
    node('g', { class: 'eye eye-right' }, [node('ellipse', { cx: 187, cy: 127, rx: 4.5, ry: 6, class: 'twin-eye' }), node('circle', { cx: 188.6, cy: 124.5, r: 1.6, class: 'twin-glint' })]),
    node('circle', { cx: 146, cy: 144, r: 6, class: 'twin-cheek' }),
    node('circle', { cx: 214, cy: 144, r: 6, class: 'twin-cheek' }),
    node('path', { d: 'M172 146Q180 154 188 146', class: 'twin-mouth' }),
  ]);
}

/** A speech bubble with a short greeting, pointing down at the twin. */
function greeting(): SVGElement {
  const text = node('text', { x: 98, y: 25, 'text-anchor': 'middle', class: 'bubble-text' });
  text.textContent = "Hi, I'm your twin.";
  return node('g', { class: 'bubble' }, [
    node('path', { d: 'M146 36L158 72L164 36Z', class: 'bubble-tail' }),
    node('rect', { x: 14, y: 4, width: 168, height: 32, rx: 12, class: 'bubble-box' }),
    text,
  ]);
}

/** The whole welcome picture: the twin, a pulse that reads as understanding, three work tiles and the lines that link them. */
export function twinCompanion(): SVGSVGElement {
  const svg = node('svg', { viewBox: '0 0 360 220', class: 'twin-art', 'aria-hidden': 'true', focusable: 'false' }, [
    node('g', { class: 'twin-lines' }, [
      node('path', { d: 'M106 106Q118 114 128 122' }),
      node('path', { d: 'M258 100Q244 110 234 122' }),
      node('path', { d: 'M256 160Q244 152 236 146' }),
    ]),
    node('circle', { cx: 180, cy: 134, r: 84, class: 'scan-ring' }),
    tile(1, 80, 96, documentGlyph()),
    tile(2, 286, 92, sheetGlyph()),
    tile(3, 282, 170, chatGlyph()),
    twinRings(),
    greeting(),
  ]);
  return svg as unknown as SVGSVGElement;
}

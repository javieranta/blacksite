/**
 * OWNER: ui agent.
 * The HUD's design system, injected once as a single stylesheet.
 *
 * Language: military-industrial. Hairline strokes (1px, never more), a cold
 * steel/bone neutral ramp with a single amber accent and a single warning red,
 * wide letter-spacing on small uppercase labels, tabular figures for anything
 * numeric, and no rounded corners anywhere. Nothing is drawn at a browser
 * default weight or default size.
 *
 * Zero external assets: the large ammo numerals are hand-authored vector glyphs
 * (see Glyphs.js), so the readout that matters most does not depend on any font
 * being installed.
 */
export const HUD_CSS = `
#hud {
  --ink:      #06080b;
  --panel:    rgba(7, 10, 14, 0.56);
  --hair:     rgba(214, 226, 238, 0.14);
  --hair-2:   rgba(214, 226, 238, 0.07);
  --steel:    #6f7b88;
  --steel-hi: #9aa7b4;
  --bone:     #dde5ee;
  --amber:    #d8a24a;
  --amber-dim:#8c6c34;
  --red:      #d2452c;
  --f-ui: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  --f-num: ui-monospace, "Cascadia Mono", "Consolas", "SF Mono", "DejaVu Sans Mono", monospace;
  font-family: var(--f-ui);
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  user-select: none;
}

#hud .bs-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  color: var(--steel);
  line-height: 1;
}
#hud .bs-num { font-family: var(--f-num); font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
#hud .bs-rule { height: 1px; background: var(--hair); }

/* ---------------------------------------------------------------- reticle -- */
#hud .bs-reticle {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0;
  will-change: opacity;
}
#hud .bs-blade {
  position: absolute; left: 0; top: 0;
  background: var(--bone);
  box-shadow: 0 0 0 1px rgba(2, 4, 7, 0.55), 0 0 6px rgba(2, 4, 7, 0.5);
  will-change: transform;
}
#hud .bs-blade.v { width: 2px; height: 9px; margin-left: -1px; }
#hud .bs-blade.h { width: 9px; height: 2px; margin-top: -1px; }
#hud .bs-spur {
  position: absolute; left: 0; top: 0; width: 7px; height: 2px; margin-top: -1px;
  transform-origin: 0 50%; background: var(--bone); opacity: .42;
  box-shadow: 0 0 0 1px rgba(2, 4, 7, 0.5);
}
#hud .bs-centre {
  position: absolute; left: 0; top: 0; width: 2px; height: 2px; margin: -1px 0 0 -1px;
  background: var(--bone); opacity: .7;
  box-shadow: 0 0 0 1px rgba(2, 4, 7, 0.65);
}

/* ------------------------------------------------------------- hitmarker -- */
#hud .bs-hm { position: absolute; left: 50%; top: 50%; margin: -32px 0 0 -32px; opacity: 0; }
#hud .bs-hm svg { display: block; }

/* ---------------------------------------------------- damage indicators --- */
#hud .bs-dmg { position: absolute; left: 50%; top: 50%; margin: -240px 0 0 -240px; }

/* -------------------------------------------------------------- vitals fx -- */
/* Pressure vignette: the red must live in the corners and stay off the centre
   of the frame — the player still has to be able to see and shoot. */
#hud .bs-fx {
  position: absolute; inset: 0; opacity: 0;
  background:
    radial-gradient(84% 96% at 50% 52%, rgba(0,0,0,0) 46%, rgba(108, 14, 7, 0.30) 78%, rgba(62, 6, 3, 0.72) 100%);
  will-change: opacity;
}
#hud .bs-desat { position: absolute; inset: 0; opacity: 0; backdrop-filter: saturate(0.58) contrast(1.05) brightness(0.95); }
#hud .bs-flash {
  position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(130% 100% at 50% 50%, rgba(190, 46, 26, 0.0) 25%, rgba(190, 46, 26, 0.5) 100%);
  will-change: opacity;
}

/* ------------------------------------------------------------------ ammo -- */
#hud .bs-ammo {
  position: absolute; right: 46px; bottom: 40px;
  display: flex; flex-direction: column; align-items: flex-end; gap: 9px;
}
#hud .bs-ammo-row { display: flex; align-items: flex-end; gap: 14px; }
#hud .bs-mag { display: flex; align-items: flex-end; gap: 3px; height: 52px; }
#hud .bs-mag svg { display: block; height: 52px; width: 32.5px; overflow: visible; }
#hud .bs-mag svg path {
  fill: none; stroke: var(--bone); stroke-width: 9;
  stroke-linejoin: miter; stroke-linecap: butt;
  filter: drop-shadow(0 0 3px rgba(2, 4, 7, 0.85));
}
#hud .bs-mag.warn svg path { stroke: var(--amber); }
#hud .bs-mag.crit svg path { stroke: var(--red); }
#hud .bs-mag svg.lead path { stroke: var(--steel); opacity: .30; }
#hud .bs-res-wrap { display: flex; align-items: flex-end; gap: 12px; padding-bottom: 4px; }
#hud .bs-res-bar { width: 1px; height: 30px; background: var(--hair); }
#hud .bs-res { font-size: 17px; font-weight: 400; letter-spacing: .10em; color: var(--steel-hi); line-height: 1; }
#hud .bs-res i { font-style: normal; font-size: 10px; letter-spacing: .26em; color: var(--steel); display: block; margin-top: 5px; }
#hud .bs-ammo-meta { display: flex; align-items: center; gap: 10px; }
#hud .bs-wname { font-size: 11px; font-weight: 600; letter-spacing: .34em; color: var(--bone); }
#hud .bs-sep { width: 3px; height: 3px; background: var(--amber); opacity: .8; }
#hud .bs-wmode { font-size: 9px; font-weight: 600; letter-spacing: .28em; color: var(--steel); text-transform: uppercase; }
#hud .bs-ammo-underline { width: 210px; height: 1px; background: linear-gradient(to left, var(--hair), rgba(0,0,0,0)); }
#hud .bs-reload {
  font-size: 10px; font-weight: 700; letter-spacing: .40em; color: var(--amber);
  opacity: 0; text-transform: uppercase;
}
#hud .bs-reload.on { animation: bs-blink 1.1s steps(1, end) infinite; opacity: 1; }
@keyframes bs-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0.16; } }
#hud .bs-reload-arc { width: 210px; height: 1px; background: var(--hair-2); position: relative; overflow: hidden; }
#hud .bs-reload-arc i { position: absolute; inset: 0 100% 0 0; background: var(--amber); }

/* ---------------------------------------------------------------- vitals -- */
#hud .bs-vitals { position: absolute; left: 46px; bottom: 40px; display: flex; flex-direction: column; gap: 10px; }
#hud .bs-armour { display: flex; gap: 3px; height: 7px; }
#hud .bs-armour span {
  width: 34px; height: 7px; background: var(--steel); opacity: .16;
  clip-path: polygon(0 0, 100% 0, 84% 100%, 0 100%);
}
#hud .bs-armour span.on { background: var(--steel-hi); opacity: .9; }
#hud .bs-hp-row { display: flex; align-items: flex-end; gap: 15px; }
/* Health uses the same hand-drawn stencil numerals as the ammo count, one step
   down in size and weight — one numeric language across the whole interface. */
#hud .bs-hp-glyph { display: flex; align-items: flex-end; gap: 2px; height: 30px; }
#hud .bs-hp-glyph svg { display: block; height: 30px; width: 18.75px; overflow: visible; }
#hud .bs-hp-glyph svg path {
  fill: none; stroke: var(--bone); stroke-width: 10;
  stroke-linejoin: miter; stroke-linecap: butt;
  filter: drop-shadow(0 0 3px rgba(2, 4, 7, 0.85));
}
#hud .bs-hp-glyph.warn svg path { stroke: var(--amber); }
#hud .bs-hp-glyph.crit svg path { stroke: var(--red); }
#hud .bs-hp-glyph svg.lead path { stroke: var(--steel); opacity: .26; }
#hud .bs-hp-seg { display: flex; gap: 3px; height: 20px; padding-bottom: 3px; }
#hud .bs-hp-seg span {
  width: 6px; height: 20px; background: var(--bone); opacity: .85;
  transform: skewX(-13deg);
  box-shadow: 0 1px 3px rgba(2,4,7,.7);
}
#hud .bs-hp-seg span.off { opacity: .09; box-shadow: none; }
#hud .bs-hp-seg.warn span { background: var(--amber); }
#hud .bs-hp-seg.crit span { background: var(--red); }
#hud .bs-vitals-underline { width: 210px; height: 1px; background: linear-gradient(to right, var(--hair), rgba(0,0,0,0)); }
#hud .bs-vitals-meta { display: flex; gap: 12px; align-items: center; }
#hud .bs-vitals-meta .bs-sep { width: 3px; height: 3px; background: var(--amber); opacity: .8; }

/* --------------------------------------------------------------- compass -- */
#hud .bs-compass {
  position: absolute; left: 50%; top: 30px; width: 420px; height: 30px; margin-left: -210px;
  overflow: hidden;
  mask-image: linear-gradient(to right, transparent, #000 20%, #000 80%, transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, #000 20%, #000 80%, transparent);
}
#hud .bs-tape { position: absolute; left: 0; top: 0; height: 30px; will-change: transform; }
#hud .bs-tick { position: absolute; top: 0; width: 1px; background: var(--steel); opacity: .30; }
#hud .bs-tick.maj { opacity: .85; background: var(--bone); }
#hud .bs-card {
  position: absolute; bottom: 0; transform: translateX(-50%);
  font-size: 10px; font-weight: 700; letter-spacing: .24em; color: var(--bone);
  text-shadow: 0 1px 3px rgba(2,4,7,.9);
}
#hud .bs-compass-mark {
  position: absolute; left: 50%; top: 22px; margin-left: -5px;
  width: 10px; height: 6px; background: var(--amber);
  clip-path: polygon(50% 100%, 0 0, 100% 0);
}
#hud .bs-bearing {
  position: absolute; left: 50%; top: 62px; transform: translateX(-50%);
  font-family: var(--f-num); font-size: 11px; letter-spacing: .18em; color: var(--steel-hi);
  text-shadow: 0 1px 3px rgba(2,4,7,.9);
}

/* ------------------------------------------------------------- kill feed -- */
#hud .bs-feed { position: absolute; right: 46px; top: 60px; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
#hud .bs-kill {
  display: flex; align-items: center; gap: 9px;
  background: var(--panel); border-left: 1px solid var(--amber);
  padding: 5px 10px 5px 9px; opacity: 0;
  transform: translateX(12px);
  transition: opacity .18s linear, transform .18s cubic-bezier(.2,.7,.3,1);
}
#hud .bs-kill.on { opacity: 1; transform: translateX(0); }
#hud .bs-kill.enemy { border-left-color: var(--red); }
#hud .bs-kill b { font-size: 10px; font-weight: 700; letter-spacing: .22em; color: var(--bone); text-transform: uppercase; }
#hud .bs-kill em { font-style: normal; font-size: 9px; font-weight: 600; letter-spacing: .20em; color: var(--steel); text-transform: uppercase; }
#hud .bs-kill .arrow { width: 16px; height: 1px; background: var(--steel); position: relative; }
#hud .bs-kill .arrow:after {
  content: ''; position: absolute; right: 0; top: -2px; width: 5px; height: 5px;
  background: var(--steel); clip-path: polygon(0 0, 100% 50%, 0 100%);
}
#hud .bs-kill .hs { width: 5px; height: 5px; background: var(--amber); clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }

/* ------------------------------------------------------------ pause menu -- */
#hud .bs-menu {
  position: absolute; inset: 0; display: none; pointer-events: auto;
  background: linear-gradient(to bottom, rgba(4,6,9,.86), rgba(4,6,9,.94));
  backdrop-filter: blur(16px) saturate(.55);
}
#hud .bs-menu.on { display: block; }
#hud .bs-menu-inner {
  position: absolute; left: 12%; top: 50%; transform: translateY(-50%);
  width: 460px; display: flex; flex-direction: column; gap: 26px;
}
#hud .bs-menu h1 { font-size: 15px; font-weight: 700; letter-spacing: .62em; color: var(--bone); }
#hud .bs-menu h1 span { color: var(--amber); }
#hud .bs-menu .sub { font-size: 9px; letter-spacing: .34em; color: var(--steel); margin-top: 9px; text-transform: uppercase; }
#hud .bs-block { display: flex; flex-direction: column; gap: 10px; }
#hud .bs-block > .bs-label { margin-bottom: 2px; }
#hud .bs-seg { display: flex; gap: 1px; }
#hud .bs-seg button {
  flex: 1; appearance: none; border: 1px solid var(--hair); border-right: none;
  background: rgba(255,255,255,.02); color: var(--steel);
  font-family: var(--f-ui); font-size: 9px; font-weight: 700; letter-spacing: .22em;
  text-transform: uppercase; padding: 9px 0; cursor: pointer;
  transition: color .12s linear, background .12s linear, border-color .12s linear;
}
#hud .bs-seg button:last-child { border-right: 1px solid var(--hair); }
#hud .bs-seg button:hover { color: var(--bone); background: rgba(255,255,255,.05); }
#hud .bs-seg button.on { color: var(--ink); background: var(--amber); border-color: var(--amber); }
#hud .bs-slider { display: flex; align-items: center; gap: 14px; }
#hud .bs-slider input {
  appearance: none; -webkit-appearance: none; flex: 1; height: 1px;
  background: var(--hair); cursor: pointer; outline: none;
}
#hud .bs-slider input::-webkit-slider-thumb {
  -webkit-appearance: none; width: 3px; height: 16px; background: var(--amber); cursor: pointer;
}
#hud .bs-slider input::-moz-range-thumb { width: 3px; height: 16px; border: none; background: var(--amber); }
#hud .bs-slider .val { font-family: var(--f-num); font-size: 12px; letter-spacing: .06em; color: var(--bone); width: 52px; text-align: right; }
#hud .bs-resume {
  appearance: none; border: 1px solid var(--hair); background: none; color: var(--bone);
  font-family: var(--f-ui); font-size: 10px; font-weight: 700; letter-spacing: .40em;
  text-transform: uppercase; padding: 13px 0; cursor: pointer; width: 200px;
  transition: color .12s linear, border-color .12s linear, background .12s linear;
}
#hud .bs-resume:hover { color: var(--ink); background: var(--bone); border-color: var(--bone); }
#hud .bs-menu-hint { font-size: 9px; letter-spacing: .26em; color: var(--steel); text-transform: uppercase; }
#hud .bs-menu-diag {
  position: absolute; right: 46px; bottom: 40px; display: flex; align-items: center; gap: 12px;
  font-family: var(--f-num); font-size: 10px; letter-spacing: .14em;
  color: var(--steel); text-transform: uppercase;
}
#hud .bs-menu-diag i { width: 3px; height: 3px; background: var(--amber); opacity: .7; }
`;

export function injectStyle() {
  if (document.getElementById('bs-hud-style')) return;
  const el = document.createElement('style');
  el.id = 'bs-hud-style';
  el.textContent = HUD_CSS;
  document.head.appendChild(el);
}

/* ================= Content ================= */
const M = n => `/assets/films/${n}`;
const MARK = "/assets/img/mark.svg";
const films = { // key → aspect ratio (w/h)
  intro: 16 / 9, launch: 16 / 9, kinetic: 9 / 16, bakery: 4 / 5, data: 16 / 9, event: 1, explainer: 16 / 9,
};
// Page copy comes from js/content-<lang>.js, loaded just before this script.
const { samples, steps, briefs, compare, chat, tools, prices, faq, ui } = window.SITE_CONTENT;

/* ================= Helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const html = (el, s) => (el.innerHTML = s, el);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const inView = (el, m = 0) => { const r = el.getBoundingClientRect(); return r.bottom > -m && r.top < innerHeight + m; };
const play = v => { if (v.paused) v.play().catch(() => {}); };
const pause = v => { if (!v.paused) v.pause(); };
const splitWords = (el, start = 0) => { let i = start; el.innerHTML = el.textContent.replace(/\S+/g, w => `<span class="w" style="--i:${i++}">${w}</span>`); return i; };
const mediaBox = (k, h) => { const ar = films[k]; return `style="aspect-ratio:${ar};${ar >= 1 ? "width:100%" : `height:${h}px`}"`; };

/* ================= Nav ================= */
const nav = $("#nav"), sheet = $("#sheet");
$("#menuBtn").addEventListener("click", e => { e.stopPropagation(); sheet.classList.toggle("open"); });
document.addEventListener("click", () => sheet.classList.remove("open"));

/* ================= Hero headline: per-word blur rise ================= */
let wi = 0;
$$("#heroTitle .line").forEach(line => {
  line.childNodes.forEach(n => {
    if (n.nodeType === 3) { const s = document.createElement("span"); s.textContent = n.textContent; line.replaceChild(s, n); wi = splitWords(s, wi); }
    else if (n.classList?.contains("hl")) { n.classList.add("w"); n.style.setProperty("--i", wi++); }
  });
});

/* ================= Film carousel (infinite marquee, hover to play) ================= */
const reelItems = [...samples.map(s => [s[4], s[1], `${s[0]} · ${s[2]}`]), ["intro", ui.introTitle, "SC 00 · 16:9"]];
const reelCard = ([k, title, sub]) => {
  const wide = films[k] >= 1;
  return `<article class="fcard ${wide ? "wide" : "portrait"}"><a class="open" href="#showcase">${ui.watchFilm}</a>
    <div class="stage"><div class="media" ${wide ? `style="aspect-ratio:${films[k]};width:100%"` : `style="aspect-ratio:${films[k]};height:100%"`}>
      <img src="${M(k + ".webp")}" alt="" loading="lazy" /><video src="${M(k + ".mp4")}" muted loop playsinline preload="none"></video></div></div>
    <div class="meta"><img src="${MARK}" alt="" /><div><b>${title}</b><small>${sub}</small></div></div></article>`;
};
html($("#reel"), [...reelItems, ...reelItems].map(reelCard).join(""));
$$(".fcard").forEach(c => {
  const v = $("video", c);
  c.addEventListener("pointerenter", () => { v.preload = "auto"; play(v); c.classList.add("playing"); });
  c.addEventListener("pointerleave", () => { pause(v); c.classList.remove("playing"); });
});

/* ================= Statement: words fill in with scroll ================= */
const statement = $("#statement"), sWords = (splitWords(statement), $$(".w", statement));
const fillStatement = () => {
  const r = statement.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (innerHeight * .85 - r.top) / (r.height + innerHeight * .35)));
  const n = Math.round(p * sWords.length);
  sWords.forEach((w, i) => w.classList.toggle("on", i < n));
};

/* ================= Sticky steps ================= */
html($("#stepList"), steps.map(([n, role, t, d, a]) => `
  <div class="step"><span class="num">${n}</span><span class="role">${role}</span><h3 class="h-md">${t}</h3><p>${d}</p><p class="aside">${a}</p></div>`).join(""));
const stepEls = $$(".step"), layers = $$("#stepPanel .layer");
let stepActive = -1;
const setStep = i => {
  if (i === stepActive) return;
  stepActive = i;
  stepEls.forEach((s, j) => s.classList.toggle("on", i === j));
  layers.forEach((l, j) => { l.classList.toggle("on", i === j); const v = $("video", l); if (v) (i === j ? play : pause)(v); });
  if (i === 0) typeBrief();
};
// typewriter for the brief composer; cycles through a few briefs while step 01 is active
const typed = $("#typed");
let typeToken = 0;
async function typeBrief() {
  const token = ++typeToken, wait = ms => new Promise(r => setTimeout(r, ms));
  for (let b = 0; stepActive === 0 && token === typeToken; b = (b + 1) % briefs.length) {
    typed.textContent = "";
    for (const ch of briefs[b]) { if (token !== typeToken || stepActive !== 0) return; typed.textContent += ch; await wait(reduced ? 0 : 28); }
    await wait(1800);
  }
}
const syncSteps = () => {
  const mid = innerHeight * .5; let best = 0, bd = Infinity;
  stepEls.forEach((s, i) => { const r = s.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - mid); if (d < bd) { bd = d; best = i; } });
  setStep(best);
};

/* ================= Intro film ================= */
const film = $("#film"), filmV = $("video", film);
film.addEventListener("click", () => {
  if (filmV.paused) { filmV.muted = false; filmV.play().catch(() => {}); film.classList.add("live"); }
  else { filmV.pause(); film.classList.remove("live"); }
});

/* ================= Showcase bento ================= */
html($("#bento"), samples.map(([id, name, ar, sec, k, brief, note, span], i) => `
  <article class="scard ${span} rv" style="--d:${(i % 2) * .08}s">
    <div class="stage"><div class="frame" ${films[k] >= 1 ? `style="aspect-ratio:${films[k]};width:100%"` : `style="aspect-ratio:${films[k]};height:340px"`}>
      <video src="${M(k + ".mp4")}" poster="${M(k + ".webp")}" muted loop playsinline preload="none"></video></div></div>
    <div class="info"><div class="tagrow"><span>${id}</span><span>${name}</span><span>${ar}</span><span>${sec}</span></div>
      <q>${brief}</q>${note ? `<p class="note">${note}</p>` : ""}</div>
  </article>`).join(""));

/* ================= Compare toggle (auto-flips until the user picks) ================= */
html($("#rows"), compare.map(([t, a, b]) => `<div class="row"><h4>${t}</h4><div class="val"><span class="a">${a}</span><span class="b">${b}</span></div></div>`).join(""));
const seg = $("#seg"), thumb = $(".thumb", seg), cmp = $("#compare"), segBtns = $$("button", seg);
let mode = 0, userPicked = false;
const setMode = m => {
  mode = m;
  segBtns.forEach((b, j) => b.classList.toggle("on", j === m));
  const b = segBtns[m]; thumb.style.left = b.offsetLeft + "px"; thumb.style.width = b.offsetWidth + "px";
  cmp.classList.toggle("mmcp", m === 1); seg.classList.toggle("mmcp", m === 1);
  $$(".row", cmp).forEach((r, i) => $$(".val span", r).forEach(s => s.style.transitionDelay = `${i * 60}ms`));
};
segBtns.forEach((b, j) => b.addEventListener("click", () => { userPicked = true; setMode(j); }));
setInterval(() => { if (!userPicked && inView(cmp)) setMode(1 - mode); }, 3200);
addEventListener("load", () => setMode(0)); setMode(0);

/* ================= Chat (plays once in view) + copy ================= */
const chatEl = $("#chat");
html(chatEl, chat.map(([r, t]) => `<div class="bubble ${r}">${r === "sys" ? "" : `<b>${r === "you" ? ui.you : ui.assistant}</b>`}<span>${t}</span></div>`).join(""));
let chatPlayed = false;
async function playChat() {
  chatPlayed = true;
  const bubbles = $$(".bubble", chatEl), wait = ms => new Promise(r => setTimeout(r, reduced ? 0 : ms));
  for (let i = 0; i < chat.length; i++) {
    await wait(chat[i][2]);
    const b = bubbles[i], body = $("span", b);
    if (chat[i][0] === "ai" && !reduced) { const full = body.innerHTML; body.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`; b.classList.add("show"); await wait(1100); body.innerHTML = full; }
    else b.classList.add("show");
  }
}
$("#copy").addEventListener("click", e => {
  const b = e.currentTarget;
  navigator.clipboard?.writeText($("#json").innerText).catch(() => {});
  b.textContent = ui.copied; b.classList.add("done");
  setTimeout(() => { b.textContent = ui.copy; b.classList.remove("done"); }, 1600);
});

/* ================= Tools, pricing, FAQ ================= */
html($("#tools"), tools.map(([n, d], i) => `<div class="tool rv" style="--d:${(i % 4) * .06}s"><span class="ix">0${i + 1}</span><div><code>${n}</code><p style="margin-top:8px">${d}</p></div></div>`).join(""));
// App URL comes from the CTAs the Worker already rewrote (data-app-link).
const APP = $("a[data-app-link]")?.href ?? "https://app.studix.digitop.ai/";
html($("#prices"), prices.map(([t, n, u, d, hl], i) => `
  <div class="price rv${hl ? " hl" : ""}" style="--d:${i * .08}s"><span class="label">${t}</span>
    <div><div class="num" data-n="${n}">${n}</div><div class="unit">${u}</div></div><p>${d}</p>
    <a href="${APP}" class="btn ${hl ? "btn-dark" : "btn-light"} btn-sm">${ui.startFree}</a></div>`).join(""));
const countUp = el => {
  const raw = el.dataset.n, target = +raw.replace(/\D/g, ""), pre = raw.startsWith("~") ? "~" : "", t0 = performance.now(), dur = reduced ? 1 : 1300;
  const f = t => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 4); el.textContent = pre + Math.round(target * e).toLocaleString(ui.locale); if (p < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
};
html($("#faq"), faq.map(([q, a]) => `<div class="qa rv"><button><span>${q}</span><span class="pm"></span></button><div class="ans"><div><p>${a}</p></div></div></div>`).join(""));
$$(".qa").forEach(qa => $("button", qa).addEventListener("click", () => qa.classList.toggle("open")));

/* ================= Filter video gallery =================
   Same media, filters and motion as filtervideogallery.framer.website:
   absolute masonry cells that glide to new slots (620ms, 45ms stagger),
   hover-to-preview, and a full-screen viewer with thumbnails. */
const F = n => `/assets/gallery/${n}.mp4`;
const gallery = [ // title, chip, video, aspect (w/h), filter tags
  ["Blaze test", "Motion", F("blaze-test"), 9 / 16, ["Motion", "Product"]],
  ["Sintel", "Story", F("sintel"), 9 / 16, ["Story", "Motion"]],
  ["Fun run", "Reels", F("fun-run"), 9 / 16, ["Reels"]],
  ["Meltdown", "Product", F("meltdown"), 9 / 16, ["Product"]],
  ["Elephants dream", "Story", F("elephants-dream"), 9 / 16, ["Story"]],
  ["Escape route", "Motion", F("escape-route"), 9 / 16, ["Motion", "Story"]],
  ["Joyride", "Reels", F("joyride"), 4 / 3, ["Reels", "Story"]],
  ["Tears of steel", "Motion", F("tears-of-steel"), 9 / 16, ["Motion"]],
  ["", "", F("untitled"), 9 / 16, []],
];
// The showcase films join the wall too, so the edge-to-edge grid has enough to fill wide screens.
const FILM_TAGS = { launch: ["Product"], kinetic: ["Reels", "Motion"], bakery: ["Product"], data: ["Story"], event: ["Motion"], explainer: ["Motion", "Story"], intro: ["Story"] };
const fvgBase = [...gallery, ...Object.entries(FILM_TAGS).map(([k, tags]) =>
  [samples.find(s => s[4] === k)?.[1] ?? ui.introTitle, tags[0], M(k + ".mp4"), films[k], tags, M(k + ".webp")])];
// Films open on a blank frame, so their cards show the poster. The #t=0.1 seek that gives clips a
// first frame would hide a poster, so a film loads without it.
const fvgSrc = b => fvgBase[b][5] ? `src="${fvgBase[b][2]}" poster="${fvgBase[b][5]}"` : `src="${fvgBase[b][2]}#t=0.1"`;
const fvgFilters = ["All", "Motion", "Product", "Reels", "Story"];
const fvgGrid = $("#fvgGrid"), fvgBar = $("#fvgBar"), fvgInd = $("#fvgInd");
let fvgFilter = "All", fvgItems = [], fvgCells = [];
const fvgMatch = i => fvgFilter === "All" || fvgBase[i][4].includes(fvgFilter);
const fvgVisible = () => fvgBase.map((g, i) => i).filter(fvgMatch); // unique items, for the viewer

fvgBar.insertAdjacentHTML("beforeend", fvgFilters.map(f =>
  `<button class="fvg-pill${f === "All" ? " on" : ""}" data-f="${f}"><span>${ui.filters[f]}</span><span class="fvg-count">${fvgBase.filter((g, i) => f === "All" || g[4].includes(f)).length}</span></button>`).join(""));

// Cards keep a fixed target width; wider screens get more columns, and the item list repeats
// (cell i shows fvgBase[i % length]) so every column has about four cards.
const FVG_GAP = 14, FVG_CARD = 290;
const fvgCols = W => Math.max(2, Math.round((W + FVG_GAP) / (FVG_CARD + FVG_GAP)));
function fvgRender(count) {
  if (count === fvgItems.length) return;
  fvgItems = Array.from({ length: count }, (_, i) => i % fvgBase.length);
  html(fvgGrid, fvgItems.map((b, i) => {
    const [t, chip] = fvgBase[b];
    return `
  <div class="fvg-cell" style="transition-delay:${(i % 12) * 45}ms"><div class="fvg-card" tabindex="0" role="button" aria-label="${t || `${ui.video} ${b + 1}`}" data-i="${b}">
    <video ${fvgSrc(b)} muted loop playsinline preload="metadata"></video>
    <span class="fvg-cue" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></span>
    <span class="fvg-cap">${t ? `<span>${t}</span><span class="fvg-chip">${ui.filters[chip]}</span>` : ""}</span></div></div>`;
  }).join(""));
  fvgCells = $$(".fvg-cell", fvgGrid);
  // Hover preview: zoom, hide play cue, raise caption, play muted
  $$(".fvg-card", fvgGrid).forEach(card => {
    const v = $("video", card);
    card.addEventListener("mouseenter", () => { card.classList.add("hot"); play(v); });
    card.addEventListener("mouseleave", () => { card.classList.remove("hot"); pause(v); });
    card.addEventListener("click", () => fvgOpen(+card.dataset.i));
    card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fvgOpen(+card.dataset.i); } });
  });
}

// Shortest-column masonry, 14px gutters
function fvgLayout() {
  const W = fvgGrid.clientWidth, cols = fvgCols(W), cw = (W - FVG_GAP * (cols - 1)) / cols;
  fvgRender(Math.max(fvgBase.length, cols * 4));
  const heights = Array(cols).fill(0);
  fvgCells.forEach((cell, i) => {
    const h = cw / fvgBase[fvgItems[i]][3];
    cell.style.width = cw + "px"; cell.style.height = h + "px";
    if (!fvgMatch(fvgItems[i])) { cell.classList.add("off"); return; }
    const c = heights.indexOf(Math.min(...heights));
    cell.style.transform = `translate3d(${c * (cw + FVG_GAP)}px, ${heights[c]}px, 0)`;
    cell.classList.remove("off");
    heights[c] += h + FVG_GAP;
  });
  fvgGrid.style.height = Math.max(0, Math.max(...heights) - FVG_GAP) + "px";
}
function fvgMoveInd() {
  const on = $(".fvg-pill.on", fvgBar);
  fvgInd.style.width = on.offsetWidth + "px"; fvgInd.style.transform = `translateX(${on.offsetLeft}px)`;
}
fvgBar.addEventListener("click", e => {
  const b = e.target.closest(".fvg-pill"); if (!b) return;
  fvgFilter = b.dataset.f;
  $$(".fvg-pill", fvgBar).forEach(p => p.classList.toggle("on", p === b));
  b.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  fvgMoveInd(); fvgLayout();
});

// Full-screen viewer, scoped to the active filter
const fvgStage = $("#fvgStage"), fvgSound = $(".fvg-ctl.sound", fvgStage);
const ICON_MUTED = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M16 9.5l4 5M20 9.5l-4 5"/></svg>`;
const ICON_SOUND = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>`;
let fvgList = [], fvgAt = 0, fvgMuted = true;
function fvgShow(k) {
  fvgAt = (k + fvgList.length) % fvgList.length;
  const [t, , src] = fvgBase[fvgList[fvgAt]];
  html($("#fvgFrame"), `<video src="${src}" autoplay loop playsinline ${fvgMuted ? "muted" : ""} aria-label="${t}"></video>`);
  const fr = $("#fvgFrame"); fr.style.animation = "none"; fr.offsetWidth; fr.style.animation = "";
  $("#fvgVcap").textContent = t;
  $$(".fvg-thumb", fvgStage).forEach((b, j) => b.classList.toggle("on", j === fvgAt));
  $(".fvg-thumb.on", fvgStage)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function fvgOpen(i) {
  fvgList = fvgVisible();
  html($("#fvgThumbs"), fvgList.map((g, j) => `<button class="fvg-thumb" aria-label="${ui.showVideo} ${j + 1}" data-j="${j}"><video ${fvgSrc(g)} muted playsinline preload="metadata"></video></button>`).join(""));
  fvgStage.hidden = false; document.documentElement.style.overflow = "hidden";
  fvgShow(fvgList.indexOf(i));
}
function fvgClose() {
  fvgStage.hidden = true; document.documentElement.style.overflow = "";
  html($("#fvgFrame"), ""); html($("#fvgThumbs"), "");
}
fvgSound.innerHTML = ICON_MUTED;
fvgSound.addEventListener("click", () => {
  fvgMuted = !fvgMuted; const v = $("#fvgFrame video"); if (v) v.muted = fvgMuted;
  fvgSound.innerHTML = fvgMuted ? ICON_MUTED : ICON_SOUND;
  fvgSound.setAttribute("aria-label", fvgMuted ? ui.soundOn : ui.soundOff);
});
$(".fvg-ctl.close", fvgStage).addEventListener("click", fvgClose);
$(".fvg-ctl.prev", fvgStage).addEventListener("click", () => fvgShow(fvgAt - 1));
$(".fvg-ctl.next", fvgStage).addEventListener("click", () => fvgShow(fvgAt + 1));
$("#fvgThumbs").addEventListener("click", e => { const b = e.target.closest(".fvg-thumb"); if (b) fvgShow(+b.dataset.j); });
fvgStage.addEventListener("click", e => { if (e.target === fvgStage) fvgClose(); });
document.addEventListener("keydown", e => {
  if (fvgStage.hidden) return;
  if (e.key === "Escape") fvgClose();
  if (e.key === "ArrowLeft") fvgShow(fvgAt - 1);
  if (e.key === "ArrowRight") fvgShow(fvgAt + 1);
});
fvgLayout(); fvgMoveInd();
document.fonts?.ready.then(fvgMoveInd);

/* ================= Scroll loop ================= */
const dashShot = $("#dashShot"), navLinks = $$("#links a");
const bentoVideos = $$(".scard video");
let ticking = false;
function onScroll() {
  ticking = false;
  nav.classList.toggle("compact", scrollY > 120);
  $$(".rv:not(.in)").forEach(el => { if (el.getBoundingClientRect().top < innerHeight * .9) { el.classList.add("in"); $$(".num", el).forEach(countUp); } });
  fillStatement();
  if (inView($("#how"))) syncSteps();
  bentoVideos.forEach(v => inView(v, 50) ? play(v) : pause(v));
  if (!chatPlayed && chatEl.getBoundingClientRect().top < innerHeight * .75) playChat();
  if (!inView(film)) { filmV.pause(); film.classList.remove("live"); }
  // dashboard screenshot rises into its card as you scroll
  const dr = dashShot.parentElement.getBoundingClientRect();
  if (inView(dashShot.parentElement) && !reduced) dashShot.style.transform = `translateY(${Math.max(0, Math.min(120, (dr.top - innerHeight * .2) * .25))}px)`;
  let cur = null;
  navLinks.forEach(a => { const s = $(a.getAttribute("href")); if (s && s.getBoundingClientRect().top < innerHeight * .4) cur = a; });
  navLinks.forEach(a => a.classList.toggle("on", a === cur));
}
addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
addEventListener("resize", () => { onScroll(); setMode(mode); fvgLayout(); fvgMoveInd(); });
onScroll();

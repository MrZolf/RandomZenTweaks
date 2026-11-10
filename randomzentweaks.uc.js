// ==UserScript==
// @name            RandomZenTweaks
// @description     Writes default prefs on first start and powers the "Real" sound visualiser.
// @include         main
// ==/UserScript==

(() => {
  "use strict";

  if (window.__randomZenTweaksLoaded) return;
  window.__randomZenTweaksLoaded = true;

  const PREF = "mod.randomzentweaks.essentials-audio.";
  const LOG = "[RandomZenTweaks]";

  // Sine does not write default pref values until the user changes them,
  // so the defaults are written here (only when a pref has never been set).
  const DEFAULTS = {
    "enabled": true,
    "mute-position": "top-right",
    "mute-style": "dark",
    "visualiser-mode": "animated",
    "visualiser-style": "bars",
    "visualiser-color": "mono-light",
    "visualiser-size": "medium",
    "visualiser-layer": "behind",
  };

  function seedDefaults() {
    const p = Services.prefs;
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const name = PREF + key;
      try {
        if (p.getPrefType(name) !== p.PREF_INVALID) continue;
        if (typeof value === "boolean") p.setBoolPref(name, value);
        else p.setStringPref(name, value);
      } catch (e) {
        console.error(LOG, "could not seed", name, e);
      }
    }
  }

  seedDefaults();

  // ---------------------------------------------------------------------
  // Frame script (runs in the content process of every tab).
  // It looks for a playing <audio>/<video>, analyses its sound with the
  // Web Audio API and reports 9 frequency bands to the parent process.
  // Never executed in this scope - it is only stringified and loaded.
  // ---------------------------------------------------------------------
  function frameMain() {
    "use strict";

    const { classes: Cc, interfaces: Ci } = Components;
    const EDGES = [1, 2, 3, 5, 8, 12, 18, 28, 44, 70];
    const TILT = [1, 1, 1.05, 1.15, 1.3, 1.5, 1.7, 2, 2.3];
    const NB = 9;
    const SILENT_LIMIT = 75; // ~5 s of digital silence => treat as "no signal"

    let on = false;
    let timer = null;
    let ctx = null;
    let ctxDoc = null;
    let analyser = null;
    let bins = null;
    let sources = new WeakMap();
    let curEl = null;
    let curSrc = null;
    let levels = new Array(NB).fill(0);
    let lastSent = null;
    let silentTicks = 0;
    let live = false;

    function schedule(ms) {
      if (!timer) timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.cancel();
      if (on) timer.initWithCallback(tick, ms, Ci.nsITimer.TYPE_ONE_SHOT);
    }

    function setLive(value) {
      if (value === live) return;
      live = value;
      if (!value) {
        lastSent = null;
        sendAsyncMessage("RZT:levels", { live: false });
      }
    }

    function detach() {
      try { if (curSrc) curSrc.disconnect(); } catch (e) {}
      curEl = null;
      curSrc = null;
    }

    function resetCtx() {
      detach();
      try { if (ctx) ctx.close(); } catch (e) {}
      ctx = null;
      analyser = null;
      bins = null;
      sources = new WeakMap();
    }

    function stopAll() {
      if (timer) timer.cancel();
      resetCtx();
      ctxDoc = null;
      setLive(false);
    }

    function ensureCtx() {
      const doc = content.document;
      if (!doc) return false;
      if (ctxDoc !== doc) {
        resetCtx();
        ctxDoc = doc;
      }
      if (!ctx) {
        ctx = new content.AudioContext();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        bins = new Uint8Array(analyser.frequencyBinCount);
      }
      if (ctx.state === "suspended") {
        try { ctx.resume(); } catch (e) {}
      }
      return true;
    }

    function findPlaying() {
      let els;
      try {
        els = content.document.querySelectorAll("video, audio");
      } catch (e) {
        return null;
      }
      for (const el of els) {
        if (!el.paused && !el.ended && el.readyState >= 2 && !el.muted && el.volume > 0) {
          return el;
        }
      }
      return null;
    }

    function attach(el) {
      if (el === curEl) return;
      detach();
      let src = sources.get(el);
      if (!src) {
        // mozCaptureStream() does not reroute the element's own output.
        const stream = el.mozCaptureStream();
        src = ctx.createMediaStreamSource(stream);
        sources.set(el, src);
      }
      src.connect(analyser);
      curEl = el;
      curSrc = src;
      silentTicks = 0;
    }

    function report() {
      let changed = !lastSent;
      if (lastSent) {
        for (let b = 0; b < NB; b++) {
          if (Math.abs(levels[b] - lastSent[b]) >= 3) { changed = true; break; }
        }
      }
      if (!changed) return;
      lastSent = levels.slice();
      live = true;
      const avg = (a, b, c) => Math.round((levels[a] + levels[b] + levels[c]) / 3);
      sendAsyncMessage("RZT:levels", {
        live: true,
        lv: levels,
        lo: avg(0, 1, 2),
        mid: avg(3, 4, 5),
        hi: avg(6, 7, 8),
      });
    }

    function tick() {
      if (!on) return;
      let next = 1000; // idle: just look for playing media once a second
      try {
        const el = findPlaying();
        if (!el) {
          setLive(false);
          detach();
        } else if (ensureCtx()) {
          attach(el);
          analyser.getByteFrequencyData(bins);

          let total = 0;
          for (let b = 0; b < NB; b++) {
            let sum = 0;
            const from = EDGES[b];
            const to = EDGES[b + 1];
            for (let i = from; i < to; i++) sum += bins[i];
            total += sum;
            const v = sum / Math.max(1, to - from) / 255;
            const target = Math.min(100, Math.round(Math.pow(v, 0.75) * 140 * TILT[b]));
            levels[b] = Math.max(target, Math.round(levels[b] * 0.8));
          }

          if (total === 0) {
            silentTicks++;
            if (silentTicks > SILENT_LIMIT) setLive(false);
          } else {
            silentTicks = 0;
            report();
          }
          next = silentTicks > SILENT_LIMIT ? 500 : 66;
        }
      } catch (e) {
        // DRM / cross-origin / no audio track: let the CSS fall back to "animated"
        setLive(false);
        detach();
        next = 2000;
      }
      schedule(next);
    }

    addMessageListener("RZT:config", (msg) => {
      const was = on;
      on = !!(msg.data && msg.data.on);
      if (on && !was) schedule(0);
      else if (!on && was) stopAll();
    });

    sendAsyncMessage("RZT:hello");
  }

  const FRAME_URL =
    "data:application/javascript;charset=utf-8," +
    encodeURIComponent("(" + frameMain.toString() + ")();");

  // ---------------------------------------------------------------------
  // Parent process side
  // ---------------------------------------------------------------------
  const BAND_PROPS = [
    "--rzt-l0", "--rzt-l1", "--rzt-l2", "--rzt-l3", "--rzt-l4",
    "--rzt-l5", "--rzt-l6", "--rzt-l7", "--rzt-l8",
    "--rzt-lo", "--rzt-mid", "--rzt-hi",
  ];

  let frameLoaded = false;

  function isRealMode() {
    const p = Services.prefs;
    return (
      p.getBoolPref(PREF + "enabled", false) &&
      p.getStringPref(PREF + "visualiser-mode", "animated") === "real"
    );
  }

  function clearTab(tab) {
    tab.removeAttribute("rzt-live");
    for (const prop of BAND_PROPS) tab.style.removeProperty(prop);
  }

  function pushConfig(tab) {
    try {
      const on = isRealMode() && tab.hasAttribute("zen-essential");
      tab.linkedBrowser?.messageManager?.sendAsyncMessage("RZT:config", { on });
      if (!on) clearTab(tab);
    } catch (e) {
      // tab has no browser (e.g. discarded) - it will say hello when it loads
    }
  }

  function onHello(msg) {
    const tab = gBrowser.getTabForBrowser(msg.target);
    if (tab) pushConfig(tab);
  }

  function onLevels(msg) {
    const tab = gBrowser.getTabForBrowser(msg.target);
    if (!tab) return;
    const data = msg.data || {};

    if (!data.live) {
      clearTab(tab);
      return;
    }
    if (!tab.hasAttribute("zen-essential") || !isRealMode()) {
      pushConfig(tab);
      return;
    }

    const style = tab.style;
    for (let i = 0; i < 9; i++) style.setProperty("--rzt-l" + i, String(data.lv[i]));
    style.setProperty("--rzt-lo", String(data.lo));
    style.setProperty("--rzt-mid", String(data.mid));
    style.setProperty("--rzt-hi", String(data.hi));
    if (!tab.hasAttribute("rzt-live")) tab.setAttribute("rzt-live", "true");
  }

  function syncMode() {
    try {
      if (isRealMode()) {
        if (!frameLoaded) {
          window.messageManager.loadFrameScript(FRAME_URL, true);
          frameLoaded = true;
        }
        for (const tab of gBrowser.tabs) pushConfig(tab);
      } else {
        if (frameLoaded) window.messageManager.broadcastAsyncMessage("RZT:config", { on: false });
        for (const tab of gBrowser.tabs) clearTab(tab);
      }
    } catch (e) {
      console.error(LOG, "real visualiser unavailable, falling back to animated", e);
    }
  }

  function init() {
    window.messageManager.addMessageListener("RZT:hello", onHello);
    window.messageManager.addMessageListener("RZT:levels", onLevels);

    Services.prefs.addObserver(PREF, { observe: syncMode });

    // an Essential can be added/removed at any time
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.target?.localName === "tab") pushConfig(r.target);
      }
    }).observe(gBrowser.tabContainer, {
      subtree: true,
      attributes: true,
      attributeFilter: ["zen-essential"],
    });

    syncMode();
  }

  if (window.gBrowserInit?.delayedStartupFinished) {
    init();
  } else {
    const obs = {
      observe(subject, topic) {
        if (topic === "browser-delayed-startup-finished" && subject === window) {
          Services.obs.removeObserver(obs, topic);
          init();
        }
      },
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();

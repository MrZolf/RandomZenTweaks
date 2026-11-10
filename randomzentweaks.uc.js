// ==UserScript==
// @name            RandomZenTweaks
// @description     Pref defaults/cleanup and the "Tab notes" module.
// @include         main
// ==/UserScript==

(() => {
  "use strict";

  if (window.__randomZenTweaksLoaded) return;
  window.__randomZenTweaksLoaded = true;

  const ROOT = "mod.randomzentweaks.";
  const LOG = "[RandomZenTweaks]";

  // ---------------------------------------------------------------------
  // Preferences
  //
  // Zen/Sine dropdowns always start with a built-in first entry (value
  // "none", label = the `placeholder` text). In this mod that entry is the
  // DEFAULT choice, so the default is never stored: an unset pref (or "none")
  // simply means "default" and the CSS/JS fall back to it. Any other stored
  // value that is not a real option (old defaults, "none", ...) is cleared.
  // ---------------------------------------------------------------------
  const CHECKBOX_DEFAULTS = {
    "essentials-audio.enabled": true,
    "tab-notes.enabled": true,
  };

  const VALID_DROPDOWN_VALUES = {
    "essentials-audio.mute-position": ["top-left", "bottom-right", "bottom-left", "middle"],
    "essentials-audio.mute-style": ["light"],
    "essentials-audio.mute-size": ["small", "big"],
    "essentials-audio.visualiser-mode": ["off"],
    "essentials-audio.visualiser-style": ["wave"],
    "essentials-audio.visualiser-color": ["mono-dark", "accent"],
    "essentials-audio.visualiser-size": ["small", "large"],
    "essentials-audio.visualiser-layer": ["above"],
    "tab-notes.indicator": ["icon"],
    "tab-notes.ribbon-corner": ["left"],
    "tab-notes.icon-position": ["top-right", "bottom-right", "bottom-left", "middle"],
    "tab-notes.color": [
      "black", "blue", "green", "orange", "pink", "purple", "red", "white", "accent",
    ],
  };

  function seedCheckboxes() {
    const p = Services.prefs;
    for (const [key, value] of Object.entries(CHECKBOX_DEFAULTS)) {
      try {
        if (p.getPrefType(ROOT + key) === p.PREF_INVALID) p.setBoolPref(ROOT + key, value);
      } catch (e) {
        console.error(LOG, "could not seed", key, e);
      }
    }
  }

  function sanitizeDropdown(key) {
    const valid = VALID_DROPDOWN_VALUES[key];
    if (!valid) return;
    const p = Services.prefs;
    const name = ROOT + key;
    try {
      if (!p.prefHasUserValue(name)) return;
      if (p.getPrefType(name) !== p.PREF_STRING || !valid.includes(p.getStringPref(name))) {
        p.clearUserPref(name);
      }
    } catch (e) {
      console.error(LOG, "could not sanitise", key, e);
    }
  }

  seedCheckboxes();
  Object.keys(VALID_DROPDOWN_VALUES).forEach(sanitizeDropdown);

  // ---------------------------------------------------------------------
  // Module: Tab notes
  //
  // Notes are stored twice:
  //  1. in the tab's session data (SessionStore custom value) - this is what
  //     makes a note survive "restore closed tab";
  //  2. in <profile>/randomzentweaks-notes.json, keyed by the tab's id - this
  //     is what makes a note survive closing the browser / rebooting even for
  //     pinned tabs and Essentials, which Zen rebuilds on its own.
  // ---------------------------------------------------------------------
  const TabNotes = (() => {
    const PREF_ENABLED = ROOT + "tab-notes.enabled";
    const PREF_INDICATOR = ROOT + "tab-notes.indicator";
    const KEY = "rzt-note";
    const XHTML = "http://www.w3.org/1999/xhtml";
    const STORE_FILE = PathUtils.join(PathUtils.profileDir, "randomzentweaks-notes.json");
    const SS =
      typeof SessionStore !== "undefined"
        ? SessionStore
        : ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs").SessionStore;

    let enabled = false;
    let menuItem = null;
    let card = null;
    const els = {};
    let cardTab = null;
    let cardMode = null; // "peek" (hover) | "edit"
    let lastSaved = "";
    let openedAt = 0;
    let showTimer = 0;
    let hideTimer = 0;
    let saveTimer = 0;
    let anchorEl = null;

    let store = {}; // tab id -> { t: text, u: updated }
    let flushTimer = 0;

    const h = (tag, cls, text) => {
      const el = document.createElementNS(XHTML, tag);
      if (cls) el.className = cls;
      if (text) el.textContent = text;
      return el;
    };

    // ---- storage ----
    const keyOf = (tab) => tab.id || "";

    async function loadStore() {
      try {
        const data = await IOUtils.readJSON(STORE_FILE);
        if (data && typeof data.notes === "object" && data.notes) store = data.notes;
      } catch (e) {
        // no file yet
      }
      refreshAll();
    }

    function flushStore() {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(async () => {
        try {
          await IOUtils.writeJSON(STORE_FILE, { version: 1, notes: store }, { tmpPath: STORE_FILE + ".tmp" });
        } catch (e) {
          console.error(LOG, "could not write notes file", e);
        }
      }, 400);
    }

    function pruneStore() {
      const open = new Set(Array.from(gBrowser.tabs, (t) => t.id).filter(Boolean));
      const cutoff = Date.now() - 120 * 24 * 3600 * 1000;
      let changed = false;
      for (const [k, v] of Object.entries(store)) {
        if (!open.has(k) && (v.u || 0) < cutoff) {
          delete store[k];
          changed = true;
        }
      }
      if (changed) flushStore();
    }

    function getNote(tab) {
      let value = "";
      try {
        value = SS.getCustomTabValue(tab, KEY) || "";
      } catch (e) {}
      if (!value) {
        const k = keyOf(tab);
        if (k && store[k]) value = store[k].t || "";
      }
      return value;
    }

    function saveNote(tab, text) {
      text = text.replace(/\s+$/, "");
      const has = !!text.trim();
      try {
        if (has) SS.setCustomTabValue(tab, KEY, text);
        else SS.deleteCustomTabValue(tab, KEY);
      } catch (e) {
        console.error(LOG, "could not save note to the session", e);
      }
      const k = keyOf(tab);
      if (k) {
        if (has) store[k] = { t: text, u: Date.now() };
        else delete store[k];
        flushStore();
      }
      refresh(tab);
    }

    // ---- indicator on the tab ----
    const indicatorMode = () =>
      Services.prefs.getStringPref(PREF_INDICATOR, "") === "icon" ? "icon" : "ribbon";

    function createIndicator(tab, mode, essential) {
      const content = tab.querySelector(".tab-content");
      if (!content) return null;

      const ind = h("div", "rzt-note-indicator " + (mode === "icon" ? "rzt-note-icon" : "rzt-note-ribbon"));
      ind.addEventListener("mouseenter", () => scheduleShow(tab));
      ind.addEventListener("mouseleave", scheduleHide);
      ind.addEventListener("mousedown", (e) => e.stopPropagation());
      ind.addEventListener("click", (e) => {
        e.stopPropagation();
        openCard(tab, "edit", ind);
      });

      if (mode === "icon" && !essential) {
        // regular tabs: right next to the mute button
        ind.classList.add("rzt-note-inline");
        const ref = content.querySelector(".tab-audio-button") || content.querySelector(".tab-icon-stack");
        if (ref) ref.after(ind);
        else content.appendChild(ind);
      } else {
        content.appendChild(ind);
      }
      return ind;
    }

    function refresh(tab) {
      if (!tab || tab.closing) return;
      let ind = tab._rztIndicator;
      const note = enabled ? getNote(tab) : "";

      if (!note) {
        tab.removeAttribute("rzt-note");
        if (ind) ind.remove();
        tab._rztIndicator = null;
        return;
      }

      tab.setAttribute("rzt-note", "true");

      // keep the session copy in sync when the note came from the file
      try {
        if (!SS.getCustomTabValue(tab, KEY)) SS.setCustomTabValue(tab, KEY, note);
      } catch (e) {}

      const mode = indicatorMode();
      const essential = tab.hasAttribute("zen-essential");
      const kind = mode + (essential ? "-essential" : "-regular");
      if (ind && ind.isConnected && ind.dataset.rztKind === kind) return;

      if (ind) ind.remove();
      ind = createIndicator(tab, mode, essential);
      if (!ind) return;
      ind.dataset.rztKind = kind;
      tab._rztIndicator = ind;
    }

    function refreshAll() {
      for (const tab of gBrowser.tabs) refresh(tab);
    }

    // ---- the note window (auto-saving, no buttons) ----
    function buildCard() {
      if (card) return;
      card = h("div", "rzt-note-card");

      const head = h("div", "rzt-note-head");
      els.title = h("span", "rzt-note-title");
      head.append(h("span", "rzt-note-label", "Note"), els.title);

      els.text = h("textarea", "rzt-note-text");
      els.text.setAttribute("placeholder", "Write a note for this tab…");

      card.append(head, els.text);

      card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
      card.addEventListener("mouseleave", () => {
        if (cardMode === "peek") scheduleHide();
      });
      card.addEventListener("mousedown", (e) => e.stopPropagation());

      els.text.addEventListener("input", () => {
        autosize();
        reposition();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(commit, 250);
      });
      els.text.addEventListener("focus", () => {
        if (cardMode === "peek") setMode("edit");
      });
      els.text.addEventListener("blur", (e) => {
        if (cardMode !== "edit" || !card.hasAttribute("open")) return;
        if (e.relatedTarget && card.contains(e.relatedTarget)) return;
        if (Date.now() - openedAt < 500) {
          // the context menu was still closing and stole the focus back
          setTimeout(() => els.text.focus(), 0);
          return;
        }
        closeCard(true);
      });
      els.text.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          closeCard(true);
        }
      });
      for (const type of ["keyup", "keypress"]) {
        els.text.addEventListener(type, (e) => e.stopPropagation());
      }
    }

    function setMode(mode) {
      cardMode = mode;
      card.dataset.mode = mode;
    }

    function autosize() {
      els.text.style.height = "auto";
      els.text.style.height = Math.min(els.text.scrollHeight + 2, 240) + "px";
    }

    function reposition() {
      if (!card || !card.hasAttribute("open")) return;
      if (anchorEl && !anchorEl.isConnected) anchorEl = cardTab; // indicator was just removed/recreated
      if (!anchorEl) return;
      const r = anchorEl.getBoundingClientRect();
      const cw = card.offsetWidth || 300;
      const ch = card.offsetHeight || 120;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = r.right + 10;
      if (left + cw > vw - 8) left = Math.max(8, r.left - cw - 10);
      const top = Math.min(Math.max(8, r.top - 4), Math.max(8, vh - ch - 8));
      card.style.left = left + "px";
      card.style.top = top + "px";
    }

    function commit() {
      clearTimeout(saveTimer);
      if (!cardTab || !els.text) return;
      const value = els.text.value;
      if (value === lastSaved) return;
      lastSaved = value;
      saveNote(cardTab, value);
    }

    function openCard(tab, mode, anchor) {
      if (!enabled || !tab) return;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);

      const isOpen = card && card.hasAttribute("open");
      if (isOpen && cardTab === tab) {
        if (mode === "edit" && cardMode !== "edit") {
          setMode("edit");
          els.text.focus();
        }
        return;
      }
      if (isOpen) closeCard(true);

      buildCard();
      if (!card.isConnected) document.documentElement.appendChild(card);

      cardTab = tab;
      anchorEl = anchor || tab;
      lastSaved = getNote(tab);
      els.text.value = lastSaved;
      els.title.textContent = tab.label || "";
      setMode(mode);
      openedAt = Date.now();

      card.setAttribute("open", "");
      autosize();
      reposition();

      if (mode === "edit") {
        els.text.focus();
        const end = els.text.value.length;
        els.text.setSelectionRange(end, end);
      }
    }

    function closeCard(save) {
      if (!card || !card.hasAttribute("open")) return;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      if (save) commit();
      else clearTimeout(saveTimer);
      card.removeAttribute("open");
      cardTab = null;
      cardMode = null;
      anchorEl = null;
      if (document.activeElement === els.text) els.text.blur();
    }

    function scheduleShow(tab) {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      showTimer = setTimeout(() => openCard(tab, "peek", tab._rztIndicator), 140);
    }

    function scheduleHide() {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (cardMode === "peek") closeCard(true);
      }, 280);
    }

    function deleteNote(tab) {
      if (cardTab === tab) closeCard(false);
      saveNote(tab, "");
    }

    // ---- "Add Note..." / "Delete Note..." in the tab context menu ----
    function onPopupShowing(e) {
      const popup = e.target;
      if (popup.id !== "tabContextMenu" || !menuItem) return;
      const tab = window.TabContextMenu?.contextTab;
      menuItem.setAttribute("label", tab && getNote(tab) ? "Delete Note..." : "Add Note...");
      menuItem.hidden = !tab;
    }

    function ensureMenu() {
      const popup = document.getElementById("tabContextMenu");
      if (!popup) return;

      if (!menuItem) {
        menuItem = document.createXULElement("menuitem");
        menuItem.id = "context_rzt-add-note";
        menuItem.setAttribute("label", "Add Note...");
        menuItem.classList.add("menuitem-iconic");
        menuItem.addEventListener("command", () => {
          const tab = window.TabContextMenu?.contextTab;
          if (!tab) return;
          if (getNote(tab)) deleteNote(tab);
          else setTimeout(() => openCard(tab, "edit", tab), 80);
        });
      }

      // directly above "Change Label..."
      const anchor = popup.querySelector(
        '#context_zen-edit-tab-title, [data-l10n-id="tab-context-zen-edit-title"]'
      );
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(menuItem, anchor);
      else popup.insertBefore(menuItem, popup.firstElementChild);
    }

    // ---- enable / disable ----
    function setEnabled(value) {
      if (value === enabled) return;
      enabled = value;
      if (enabled) {
        ensureMenu();
      } else {
        closeCard(true);
        menuItem?.remove();
      }
      refreshAll();
    }

    function sync() {
      setEnabled(Services.prefs.getBoolPref(PREF_ENABLED, false));
    }

    function init() {
      document.getElementById("tabContextMenu")?.addEventListener("popupshowing", onPopupShowing);

      const tabs = gBrowser.tabContainer;
      tabs.addEventListener("SSTabRestored", (e) => refresh(e.target));
      tabs.addEventListener("TabClose", (e) => {
        if (cardTab === e.target) closeCard(true);
      });
      window.addEventListener("SSWindowStateReady", refreshAll);
      window.addEventListener("resize", reposition);

      // a tab can become / stop being an Essential at any time
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.target?.localName === "tab") refresh(r.target);
        }
      }).observe(tabs, { subtree: true, attributes: true, attributeFilter: ["zen-essential"] });

      sync();
      loadStore();
      // session data can arrive a little after startup
      setTimeout(refreshAll, 2000);
      setTimeout(refreshAll, 6000);
      setTimeout(pruneStore, 15000);
    }

    return { init, sync, refreshAll };
  })();

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function init() {
    Services.prefs.addObserver(ROOT, {
      observe(subject, topic, data) {
        const key = (data || "").slice(ROOT.length);
        if (key in VALID_DROPDOWN_VALUES) sanitizeDropdown(key);
        if (key === "tab-notes.enabled") TabNotes.sync();
        if (key === "tab-notes.indicator") TabNotes.refreshAll();
      },
    });
    TabNotes.init();
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

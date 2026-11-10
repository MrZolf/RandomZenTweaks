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
    "essentials-audio.visualiser-style": ["line"],
    "essentials-audio.visualiser-color": ["mono-dark", "accent"],
    "essentials-audio.visualiser-size": ["small", "large"],
    "essentials-audio.visualiser-layer": ["above"],
    "tab-notes.indicator": ["icon"],
    "tab-notes.color": ["yellow", "red"],
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
  // ---------------------------------------------------------------------
  const TabNotes = (() => {
    const PREF_ENABLED = ROOT + "tab-notes.enabled";
    const KEY = "rzt-note";
    const XHTML = "http://www.w3.org/1999/xhtml";
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
    let original = "";
    let openedAt = 0;
    let showTimer = 0;
    let hideTimer = 0;
    let anchorEl = null;

    const h = (tag, cls, text) => {
      const el = document.createElementNS(XHTML, tag);
      if (cls) el.className = cls;
      if (text) el.textContent = text;
      return el;
    };

    // ---- storage (saved with the tab session) ----
    function getNote(tab) {
      try {
        return SS.getCustomTabValue(tab, KEY) || "";
      } catch (e) {
        return "";
      }
    }

    function saveNote(tab, text) {
      text = text.replace(/\s+$/, "");
      try {
        if (text.trim()) SS.setCustomTabValue(tab, KEY, text);
        else SS.deleteCustomTabValue(tab, KEY);
      } catch (e) {
        console.error(LOG, "could not save note", e);
      }
      refresh(tab);
    }

    // ---- indicator on the tab ----
    function refresh(tab) {
      if (!tab || tab.closing) return;
      let ind = tab._rztIndicator;
      const has = enabled && !!getNote(tab);

      if (!has) {
        tab.removeAttribute("rzt-note");
        if (ind) ind.remove();
        tab._rztIndicator = null;
        return;
      }

      tab.setAttribute("rzt-note", "true");
      if (ind && ind.isConnected) return;

      const content = tab.querySelector(".tab-content");
      if (!content) return;
      ind = h("div", "rzt-note-indicator");
      ind.addEventListener("mouseenter", () => scheduleShow(tab));
      ind.addEventListener("mouseleave", scheduleHide);
      ind.addEventListener("mousedown", (e) => e.stopPropagation());
      ind.addEventListener("click", (e) => {
        e.stopPropagation();
        openCard(tab, "edit", ind);
      });
      content.appendChild(ind);
      tab._rztIndicator = ind;
    }

    function refreshAll() {
      for (const tab of gBrowser.tabs) refresh(tab);
    }

    // ---- the note window ----
    function buildCard() {
      if (card) return;
      card = h("div", "rzt-note-card");

      const head = h("div", "rzt-note-head");
      els.title = h("span", "rzt-note-title");
      head.append(h("span", "rzt-note-label", "Note"), els.title);

      els.text = h("textarea", "rzt-note-text");
      els.text.setAttribute("placeholder", "Write a note for this tab…");

      const actions = h("div", "rzt-note-actions");
      els.del = h("button", "rzt-note-btn rzt-note-danger", "Delete");
      els.hint = h("span", "rzt-note-hint", "Ctrl+Enter saves · Esc discards");
      els.save = h("button", "rzt-note-btn rzt-note-primary", "Save");
      actions.append(els.del, els.hint, els.save);

      card.append(head, els.text, actions);

      card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
      card.addEventListener("mouseleave", () => {
        if (cardMode === "peek") scheduleHide();
      });
      card.addEventListener("mousedown", (e) => e.stopPropagation());

      els.text.addEventListener("input", () => {
        autosize();
        reposition();
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
        if (e.key === "Escape") {
          e.preventDefault();
          closeCard(false);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          closeCard(true);
        }
      });
      for (const type of ["keyup", "keypress"]) {
        els.text.addEventListener(type, (e) => e.stopPropagation());
      }

      els.save.addEventListener("click", () => closeCard(true));
      els.del.addEventListener("click", () => {
        els.text.value = "";
        closeCard(true);
      });
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
      if (!card || !anchorEl) return;
      const r = anchorEl.getBoundingClientRect();
      const cw = card.offsetWidth || 300;
      const ch = card.offsetHeight || 160;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = r.right + 10;
      if (left + cw > vw - 8) left = Math.max(8, r.left - cw - 10);
      const top = Math.min(Math.max(8, r.top - 4), Math.max(8, vh - ch - 8));
      card.style.left = left + "px";
      card.style.top = top + "px";
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
      original = getNote(tab);
      els.text.value = original;
      els.title.textContent = tab.label || "";
      els.del.style.visibility = original ? "visible" : "hidden";
      setMode(mode);
      openedAt = Date.now();

      autosize();
      reposition();
      card.setAttribute("open", "");

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
      const tab = cardTab;
      const value = els.text.value;
      card.removeAttribute("open");
      cardTab = null;
      cardMode = null;
      anchorEl = null;
      if (document.activeElement === els.text) els.text.blur();
      if (save && tab && value !== original) saveNote(tab, value);
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

    // ---- "Add note..." in the tab context menu ----
    function onPopupShowing(e) {
      const popup = e.target;
      if (popup.id !== "tabContextMenu" || !menuItem) return;
      const tab = window.TabContextMenu?.contextTab;
      menuItem.setAttribute("label", tab && getNote(tab) ? "Edit note..." : "Add note...");
      menuItem.hidden = !tab;
    }

    function ensureMenu() {
      const popup = document.getElementById("tabContextMenu");
      if (!popup) return;

      if (!menuItem) {
        menuItem = document.createXULElement("menuitem");
        menuItem.id = "context_rzt-add-note";
        menuItem.setAttribute("label", "Add note...");
        menuItem.classList.add("menuitem-iconic");
        menuItem.addEventListener("command", () => {
          const tab = window.TabContextMenu?.contextTab;
          if (tab) setTimeout(() => openCard(tab, "edit", tab), 80);
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
        closeCard(false);
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
        if (cardTab === e.target) closeCard(false);
      });
      window.addEventListener("SSWindowStateReady", refreshAll);
      window.addEventListener("resize", reposition);

      sync();
      // session data can arrive a little after startup
      setTimeout(refreshAll, 2000);
      setTimeout(refreshAll, 6000);
    }

    return { init, sync };
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

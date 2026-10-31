(function () {
  "use strict";

  var core = globalThis.__lsiAltTextInspectorCore;
  var TABS = ["slides", "quiz", "alt", "captions", "notes"];
  var TYPE_LABELS = { image: "Image", button: "Button", choice: "Answer choice", input: "Text entry", text: "Text", shape: "Shape" };
  var tab = "slides";
  var snapshot = null;
  var queue = Promise.resolve();
  var pending = 0;
  var refreshing = null;
  var refreshAgain = false;
  var drawn = {};
  var poll = 0;
  var toastTimer = 0;
  var answerMode = false;
  var playThrough = false;
  var slideQuery = "";
  var altFilter = true;
  var lastCurrentId = "";
  var lastAnnouncedId = "";

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- page access (unchanged reading logic) ---------- */

  function invokeInPage(command) {
    try {
      var api = globalThis.__lsiAltTextInspector;
      if (!api || typeof api.handle !== "function") {
        return { found: false, error: "The course page blocked the inspector." };
      }
      return api.handle(command);
    } catch (error) {
      return { found: false, error: error && error.message ? error.message : String(error) };
    }
  }

  function getTabId() {
    if (typeof chrome.devtools !== "undefined" && chrome.devtools.inspectedWindow) {
      return Promise.resolve(chrome.devtools.inspectedWindow.tabId);
    }
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      if (tabs[0]) return tabs[0].id;
      return chrome.tabs.query({ active: true }).then(function (any) {
        return any[0] && any[0].id;
      });
    });
  }

  function executeAll(tabId, details) {
    var primary = Object.assign({ target: { tabId: tabId, allFrames: true }, world: "MAIN" }, details);
    return chrome.scripting.executeScript(primary).catch(function () {
      if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) {
        return chrome.scripting.executeScript(Object.assign({ target: { tabId: tabId }, world: "MAIN" }, details));
      }
      return chrome.webNavigation.getAllFrames({ tabId: tabId }).then(function (frames) {
        var jobs = (frames || []).map(function (frame) {
          return chrome.scripting.executeScript(Object.assign({
            target: { tabId: tabId, frameIds: [frame.frameId] },
            world: "MAIN"
          }, details)).catch(function () { return []; });
        });
        return Promise.all(jobs).then(function (groups) {
          var flat = [];
          groups.forEach(function (group) {
            (group || []).forEach(function (item) { flat.push(item); });
          });
          if (flat.length) return flat;
          return chrome.scripting.executeScript(Object.assign({ target: { tabId: tabId }, world: "MAIN" }, details));
        });
      });
    });
  }

  function callPage(command) {
    return getTabId().then(function (tabId) {
      if (!tabId) throw new Error("Open a course tab, then click the extension icon again.");
      return executeAll(tabId, { files: ["inspector-core.js", "page-bridge.js"] }).then(function () {
        return executeAll(tabId, { func: invokeInPage, args: [command] });
      });
    }).then(function (results) {
      var packed = (results || []).map(function (entry) { return entry && entry.result; }).filter(Boolean);
      if (command.type === "snapshot") return core.pickBest(packed);
      return pickAction(packed);
    });
  }

  function pickAction(packed) {
    var ranked = packed.filter(Boolean).slice().sort(function (a, b) {
      return actionScore(b) - actionScore(a);
    });
    return ranked[0] || { ok: false, error: "No Storyline frame responded." };
  }

  function actionScore(item) {
    var points = 0;
    if (item.ok) points += 5;
    if (item.found) points += 5;
    if (item.changes && item.changes.length) points += item.changes.length;
    if (item.ok && item.value !== undefined) points += 1;
    if (item.ok && item.text && /"layerSource": "found"/.test(item.text)) points += 3;
    if (item.ok && item.text && /"slide": \{/.test(item.text)) points += 2;
    if (item.ok && item.layers && item.layers.length) points += 2;
    if (item.error && !item.ok) points -= 1;
    return points;
  }

  function explain(error) {
    var text = String(error && error.message || error || "Could not reach the page.");
    // Checked first: Chrome reports a blocked file:// course as "Cannot access contents of url".
    if (/file:\/\//i.test(text)) {
      return "For a course opened from a folder, turn on Allow access to file URLs in the extension's details.";
    }
    if (/Cannot access contents|The extensions gallery cannot be scripted|Cannot access a chrome:|chrome:\/\//i.test(text)) {
      return "Open the published course page, then click the extension icon again.";
    }
    return text;
  }

  // Page calls run one at a time. A click made while the background refresh is
  // running waits for it to finish instead of being dropped.
  function serialize(task) {
    pending += 1;
    var run = queue.then(task);
    var settle = function () { pending -= 1; };
    queue = run.then(settle, settle);
    return run;
  }

  // Skip rebuilding a list when nothing it shows has changed, so a click or
  // keyboard focus on one of its buttons is not lost to the 2-second refresh.
  function unchanged(key, parts) {
    var signature = JSON.stringify(parts);
    if (drawn[key] === signature) return true;
    drawn[key] = signature;
    return false;
  }

  function focusKeyIn(root) {
    var active = document.activeElement;
    return active && root.contains(active) && active.dataset ? active.dataset.focusKey || "" : "";
  }

  function restoreFocus(root, key) {
    if (!key) return;
    var match = Array.prototype.filter.call(root.querySelectorAll("[data-focus-key]"), function (node) {
      return node.dataset.focusKey === key;
    })[0];
    if (match) match.focus();
  }

  /* ---------- status, toast, announcements ---------- */

  function setStatus(main, counts, kind) {
    var pill = $("status");
    $("status-main").textContent = main;
    $("status-main").title = main;
    $("status-counts").textContent = counts || "";
    pill.className = "status-pill" + (kind ? " " + kind : "");
  }

  function showToast(text) {
    var node = $("toast");
    node.classList.remove("leaving");
    node.hidden = false;
    $("toast-text").textContent = text;
    announce(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.add("leaving");
      setTimeout(function () { node.hidden = true; node.classList.remove("leaving"); }, 160);
    }, 2000);
  }

  function announce(text) {
    var node = $("announce");
    node.textContent = "";
    setTimeout(function () { node.textContent = text; }, 30);
  }

  /* ---------- tabs ---------- */

  function showTab(next, focus) {
    if (TABS.indexOf(next) === -1) next = "slides";
    var changed = tab !== next;
    tab = next;
    TABS.forEach(function (name) {
      var button = $("tab-" + name);
      var on = name === tab;
      button.setAttribute("aria-selected", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
      if (on && focus) button.focus();
      var sheet = $("panel-" + name);
      sheet.hidden = !on || !connected();
      sheet.classList.toggle("enter", on && changed);
    });
    render();
  }

  function connected() {
    return !!(snapshot && snapshot.found);
  }

  function setConnected(isOn) {
    TABS.forEach(function (name) {
      var button = $("tab-" + name);
      button.setAttribute("aria-disabled", isOn ? "false" : "true");
      $("panel-" + name).hidden = !isOn || name !== tab;
    });
    $("panel-disconnected").hidden = isOn;
    ["prev-slide", "next-slide", "reset-slide"].forEach(function (id) {
      $(id).setAttribute("aria-disabled", isOn ? "false" : "true");
    });
    $("download-snapshot").disabled = !isOn;
  }

  document.querySelectorAll("[role=tab]").forEach(function (button) {
    button.addEventListener("click", function () {
      if (button.getAttribute("aria-disabled") === "true") return;
      showTab(button.dataset.tab);
    });
    button.addEventListener("keydown", function (event) {
      var index = TABS.indexOf(tab);
      if (event.key === "ArrowRight") showTab(TABS[(index + 1) % TABS.length], true);
      else if (event.key === "ArrowLeft") showTab(TABS[(index + TABS.length - 1) % TABS.length], true);
      else if (event.key === "Home") showTab(TABS[0], true);
      else if (event.key === "End") showTab(TABS[TABS.length - 1], true);
      else return;
      event.preventDefault();
    });
  });

  /* ---------- helpers ---------- */

  function currentSlide() {
    if (!connected()) return null;
    return snapshot.slides.filter(function (slide) { return slide.current; })[0] || null;
  }

  function currentIndex() {
    if (!connected()) return -1;
    var index = -1;
    snapshot.slides.forEach(function (slide, i) { if (slide.current) index = i; });
    return index;
  }

  function el(tagName, className, text) {
    var node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(name) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + name);
    svg.appendChild(use);
    return svg;
  }

  function hasQuestion() {
    if (!connected()) return false;
    if (snapshot.playback && snapshot.playback.knowledgeCheck) return true;
    if ((snapshot.correctTargets || []).length || (snapshot.quizNotes || []).length) return true;
    var slide = currentSlide();
    return !!(slide && slide.question);
  }

  function describeFlow() {
    var flow = String(snapshot && snapshot.navigation && snapshot.navigation.flow || "").toLowerCase();
    if (/restricted|locked/.test(flow)) return { text: "Course menu: locked by the course", icon: "i-lock" };
    if (/free/.test(flow)) return { text: "Course menu: open", icon: "i-unlock" };
    return { text: "Course menu: " + (flow && flow !== "unknown" ? flow : "not reported"), icon: "i-lock" };
  }

  /* ---------- render ---------- */

  function render() {
    var isOn = connected();
    setConnected(isOn);
    renderSlideBar();
    if (!isOn) return;
    if (tab === "slides") renderSlides();
    if (tab === "quiz") renderQuiz();
    if (tab === "alt") renderObjects();
    if (tab === "captions") renderCaptions();
    if (tab === "notes") renderNotes();
    var slide = currentSlide();
    if (slide && slide.id !== lastAnnouncedId) {
      if (lastAnnouncedId) announce("Moved to slide " + slide.number + ", " + slide.title);
      lastAnnouncedId = slide.id;
    }
  }

  function renderSlideBar() {
    var slide = currentSlide();
    var index = currentIndex();
    $("bar-eyebrow").textContent = slide ? "ON SCREEN · " + slide.number : "ON SCREEN";
    $("bar-title").textContent = slide ? slide.title : (connected() ? "No slide reported yet" : "—");
    $("bar-title").title = slide ? slide.title : "";
    var total = connected() ? snapshot.slides.length : 0;
    $("prev-slide").setAttribute("aria-disabled", !connected() || index <= 0 ? "true" : "false");
    $("next-slide").setAttribute("aria-disabled", !connected() || index < 0 || index >= total - 1 ? "true" : "false");
  }

  function renderSlides() {
    var play = snapshot.playThrough || {};
    var button = $("play-through");
    button.textContent = playThrough ? "Stop play through" : "Play through";
    button.setAttribute("aria-pressed", playThrough ? "true" : "false");
    $("play-dot").classList.toggle("on", playThrough);
    var stateText = playThrough ? "Playing" : "Stopped";
    if (playThrough && play.status === "holding") {
      stateText = "Holding on " + (play.holdingOn || "this slide") + ": answer or leave the question to continue";
    }
    $("play-state").textContent = stateText;
    var detail = $("play-detail");
    var showDetail = playThrough && (play.status === "stuck" || play.status === "advancing") && play.detail;
    detail.hidden = !showDetail;
    detail.textContent = showDetail ? play.detail : "";
    var flow = describeFlow();
    $("lock-line").textContent = flow.text;
    $("lock-icon").querySelector("use").setAttribute("href", "#" + flow.icon);

    var root = $("slide-list");
    var query = slideQuery.trim().toLowerCase();
    var rows = snapshot.slides.filter(function (slide) {
      if (!query) return true;
      return (slide.number + " " + slide.title + " " + slide.scene + " " + slide.id).toLowerCase().indexOf(query) !== -1;
    });
    if (unchanged("slides", [query, rows])) return;
    var focusKey = focusKeyIn(root);
    root.replaceChildren();
    if (!rows.length) {
      root.appendChild(noMatch("No slides match '" + slideQuery.trim() + "'.", function () {
        slideQuery = "";
        $("slide-filter").value = "";
        renderSlides();
      }));
      return;
    }
    var lastScene = "";
    rows.forEach(function (slide) {
      if (slide.scene !== lastScene) {
        var heading = el("h3", "eyebrow scene", "SCENE " + slide.sceneNumber + " · " + slide.scene);
        root.appendChild(heading);
        lastScene = slide.scene;
      }
      var row = el("button", "slide-row");
      row.type = "button";
      row.dataset.id = slide.id;
      row.dataset.focusKey = "slide:" + slide.id;
      if (slide.current) row.setAttribute("aria-current", "true");
      row.appendChild(el("span", "num", slide.number));
      row.appendChild(el("span", "title", slide.title));
      var side;
      if (slide.current) side = el("span", "tag", "ON SCREEN");
      else if (slide.question) side = el("span", "tag", "Knowledge check");
      else { side = el("span", "id", slide.id || ""); side.title = slide.id || ""; }
      row.appendChild(side);
      row.addEventListener("click", function () { jumpToSlide(slide); });
      row.addEventListener("keydown", slideKeys);
      root.appendChild(row);
    });
    restoreFocus(root, focusKey);
    if (lastCurrentId !== snapshot.currentSlideId) {
      var current = root.querySelector("[aria-current=true]");
      if (current) current.scrollIntoView({ block: "nearest" });
      lastCurrentId = snapshot.currentSlideId;
    }
  }

  function slideKeys(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    var rows = Array.prototype.slice.call($("slide-list").querySelectorAll(".slide-row"));
    var index = rows.indexOf(event.currentTarget);
    var next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) { next.focus(); event.preventDefault(); }
  }

  function noMatch(text, clear) {
    var wrap = el("div", "sheet");
    wrap.appendChild(el("p", "empty", text));
    var button = el("button", "text-btn link", "Clear");
    button.type = "button";
    button.addEventListener("click", clear);
    wrap.appendChild(button);
    return wrap;
  }

  function renderQuiz() {
    var question = hasQuestion();
    $("quiz-empty").hidden = question;
    $("quiz-body").hidden = !question;
    var bank = snapshot.questionBank || [];
    var nextQuestion = bank.filter(function (item) { return item.index - 1 > currentIndex(); })[0] || bank[0];
    $("next-question").hidden = !nextQuestion;

    if (question) {
      var state = snapshot.questionState || {};
      var line = "Not answered";
      if (state.answered) {
        line = "Answered";
        if (state.result) line += " · " + (state.result === "correct" ? "Correct" : "Incorrect");
        var attempts = state.attempts || 1;
        line += " · " + attempts + (attempts === 1 ? " attempt" : " attempts");
      }
      $("question-state").textContent = line;
      $("answers").setAttribute("aria-checked", answerMode ? "true" : "false");

      var box = $("answer-box");
      box.replaceChildren();
      var targets = snapshot.correctTargets || [];
      var notes = snapshot.quizNotes || [];
      var choice = targets.map(function (target) { return target.label; }).filter(Boolean);
      notes.forEach(function (noteText) {
        var match = /^Correct (?:choice|value): (.*)$/.exec(noteText);
        if (match && choice.indexOf(match[1]) === -1) choice.push(match[1]);
      });
      addDefinition(box, "Correct choice", choice.length ? choice.join(", ") : "Not published in this player");
      notes.forEach(function (noteText) {
        var match = /^Accepted answers: (.*)$/.exec(noteText);
        if (match) addDefinition(box, "Accepted answers", match[1]);
      });
      var scores = snapshot.passingScores || [];
      if (scores.length) addDefinition(box, "Passing score", scores.map(function (s) { return s.value + "%"; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", "));
    }

    $("all-checks-heading").textContent = "ALL KNOWLEDGE CHECKS · " + bank.length;
    var list = $("quiz-list");
    if (!unchanged("checks", bank)) {
      var listFocus = focusKeyIn(list);
      list.replaceChildren();
      if (!bank.length) list.appendChild(el("p", "note", "No knowledge checks were found in the loaded player."));
      bank.forEach(function (item) {
        var row = el("div", "check-row");
        var text = el("div", "text");
        text.appendChild(el("strong", "", item.number + " " + item.title));
        var summary = (item.targets || []).map(function (t) { return t.label; }).filter(Boolean).join(", ");
        (item.notes || []).forEach(function (noteText) {
          if (!summary && /^Accepted answers: /.test(noteText)) summary = noteText.replace(/^Accepted answers: /, "Accepts: ");
          if (!summary && /^Correct (?:choice|value): /.test(noteText)) summary = noteText.replace(/^Correct (?:choice|value): /, "");
        });
        var sub = el("span", "", summary || "Answer not published");
        sub.title = summary;
        text.appendChild(sub);
        row.appendChild(text);
        if (item.current) {
          row.appendChild(el("span", "muted", "On screen"));
        } else {
          var open = el("button", "text-btn link", "Open");
          open.type = "button";
          open.dataset.focusKey = "open:" + item.slideId;
          open.setAttribute("aria-label", "Open " + item.number + " " + item.title);
          open.addEventListener("click", function () { jumpToId(item.slideId, item.number, item.title); });
          row.appendChild(open);
        }
        list.appendChild(row);
      });
      restoreFocus(list, listFocus);
    }

    var states = snapshot.states || [];
    var layers = snapshot.layers || [];
    var triggers = snapshot.triggers || [];
    $("details-summary").textContent = states.length + " states · " + layers.length + " layers · " + triggers.length + " triggers · " + (snapshot.notes ? "notes" : "no notes");
    var more = $("more-list");
    if (unchanged("details", [states, layers, triggers, snapshot.notes])) return;
    var moreFocus = focusKeyIn(more);
    more.replaceChildren();
    states.forEach(function (item) {
      var p = el("p", "note");
      p.appendChild(el("strong", "", item.label || item.id));
      var parts = item.states.map(function (name) { return name === item.current ? name + " (current)" : name; });
      p.appendChild(document.createTextNode(" — " + parts.join(", ")));
      more.appendChild(p);
    });
    layers.forEach(function (layer) {
      var kindText = layer.kind === "correct" ? " (correct feedback)" : layer.kind === "incorrect" ? " (incorrect feedback)" : layer.kind === "tryAgain" ? " (try again feedback)" : layer.kind === "review" ? " (review feedback)" : "";
      more.appendChild(el("p", "note", "Layer: " + (layer.title || layer.id) + kindText));
    });
    triggers.forEach(function (item) { more.appendChild(el("p", "note", "Trigger: " + item.label)); });
    if (snapshot.notes) more.appendChild(el("p", "note", "Notes: " + snapshot.notes));
    if (!states.length && !layers.length && !triggers.length && !snapshot.notes) {
      more.appendChild(el("p", "note", "The player does not expose states, layers, triggers, or notes for this slide."));
    }
    var diag = el("button", "text-btn", "Copy slide details for support");
    diag.type = "button";
    diag.dataset.focusKey = "diagnose";
    diag.appendChild(icon("i-copy"));
    diag.addEventListener("click", copyDiagnostics);
    more.appendChild(diag);
    more.appendChild(el("p", "help", "Copies the names of what the player exposes for this slide (no course text or scores). Paste it to whoever maintains this tool when something on this slide does not respond."));
    restoreFocus(more, moreFocus);
  }

  // Reading details changes nothing in the course, so copy as soon as they arrive
  // rather than waiting for a refresh, while the click still counts as recent.
  function copyDiagnostics() {
    serialize(function () {
      return callPage({ type: "diagnose" });
    }).then(function (result) {
      if (result && result.ok && result.text) copyText(result.text, "Copied slide details");
      else showToast(result && result.error || "Could not read this slide's details.");
    }).catch(function (error) {
      showToast(explain(error));
    });
  }

  function addDefinition(box, term, value) {
    box.appendChild(el("dt", "", term));
    box.appendChild(el("dd", "", value));
  }

  // What a reviewer needs to know about one object's alt text, worst case first.
  function altStatus(item) {
    if (item.readerHidden) {
      if (item.type === "image") return { kind: "decorative", text: "Decorative · hidden from screen readers" };
      // Something a learner has to use must reach a screen reader; hidden shapes and text are usually decoration.
      if (/^(button|choice|input)$/.test(item.type)) return { kind: "missing", text: "Hidden from screen readers" };
      return { kind: "decorative", text: "Hidden from screen readers" };
    }
    if (item.decorative) return { kind: "decorative", text: "Decorative · empty alt text" };
    if (!item.hasAlt) return { kind: "missing", text: "No alt text" };
    if (item.defaultName) return { kind: "warn", text: "Default name, not written alt text" };
    return { kind: "written", text: "Written alt text · " + item.alt.length + " characters" };
  }

  function visibleObjects() {
    var all = snapshot.objects || [];
    if (!altFilter) return all;
    return all.filter(function (item) { return item.type === "image" || item.type === "button"; });
  }

  function renderObjects() {
    var all = snapshot.objects || [];
    var rows = visibleObjects();
    var toCheck = rows.filter(function (item) { return /^(warn|missing)$/.test(altStatus(item).kind); }).length;
    $("alt-count").textContent = (altFilter ? "IMAGES & BUTTONS · " : "OBJECTS · ") + rows.length + (toCheck ? " · " + toCheck + " TO CHECK" : "");
    $("alt-filter").setAttribute("aria-checked", altFilter ? "true" : "false");
    var root = $("object-list");
    if (unchanged("objects", [rows, snapshot.highlightId, altFilter])) return;
    var focusKey = focusKeyIn(root);
    root.replaceChildren();
    if (!rows.length) {
      root.appendChild(el("p", "empty", altFilter && all.length
        ? "No images or buttons are showing on this slide. Turn off Images and buttons only to see everything else."
        : "Nothing with alt text is showing on this slide."));
      return;
    }
    rows.forEach(function (item) {
      var selected = snapshot.highlightId === item.id;
      var status = altStatus(item);
      var card = el("div", "object" + (selected ? " selected" : ""));
      card.dataset.type = item.type;
      var top = el("div", "object-top");
      var main = el("button", "object-main");
      main.type = "button";
      main.dataset.focusKey = "object:" + item.id;
      main.setAttribute("aria-pressed", selected ? "true" : "false");
      main.appendChild(el("span", "eyebrow", TYPE_LABELS[item.type] || item.type));
      // An image with no alt text shows its file name, the next best way to find it.
      main.appendChild(el("span", "alt-text" + (item.hasAlt ? "" : " none"), item.hasAlt ? item.alt : (item.fileName || "No alt text")));
      main.addEventListener("click", function () { toggleHighlight(item.id); });
      top.appendChild(main);
      var side = el("div", "object-side");
      if (selected) side.appendChild(el("span", "tag solid", "Highlighted"));
      if (item.hasAlt) {
        var copy = el("button", "icon-btn small");
        copy.type = "button";
        copy.dataset.focusKey = "copy-alt:" + item.id;
        copy.setAttribute("aria-label", "Copy alt text");
        copy.appendChild(icon("i-copy"));
        copy.addEventListener("click", function () { copyText(item.alt, "Copied alt text"); });
        side.appendChild(copy);
      }
      top.appendChild(side);
      card.appendChild(top);

      var line = el("div", "object-status");
      var badge = el("span", "badge " + status.kind);
      badge.appendChild(icon(status.kind === "written" ? "i-check" : status.kind === "decorative" ? "i-image" : "i-warn"));
      badge.appendChild(document.createTextNode(status.text));
      line.appendChild(badge);
      if (item.layer) line.appendChild(el("span", "", "Layer: " + item.layer));
      card.appendChild(line);
      root.appendChild(card);
    });
    restoreFocus(root, focusKey);
  }

  function renderNotes() {
    var notes = snapshot.slideNotes || { available: false, text: "" };
    $("copy-notes").hidden = !notes.text;
    var body = $("notes-body");
    if (unchanged("notes", [notes.available, notes.text])) return;
    body.replaceChildren();
    if (notes.text) body.textContent = notes.text;
    else body.appendChild(el("p", "empty", notes.available ? "This slide has no notes." : "This player does not expose slide notes."));
  }

  function renderCaptions() {
    var data = snapshot.captions || { available: false, groups: [] };
    var groups = data.groups || [];
    var count = groups.reduce(function (sum, group) { return sum + group.lines.length; }, 0);
    $("caption-count").textContent = "CLOSED CAPTIONS · " + count;
    $("copy-captions").hidden = !count;
    var root = $("caption-list");
    if (unchanged("captions", [data.available, groups])) return;
    root.replaceChildren();
    if (!data.available) {
      root.appendChild(el("p", "empty", "This player does not expose closed captions. Turn on CC in the course and play the slide to read them."));
      return;
    }
    if (!count) {
      root.appendChild(el("p", "empty", "This slide has no closed captions."));
      return;
    }
    groups.forEach(function (group) {
      var wrap = el("div", "caption-group");
      var n = group.lines.length;
      wrap.appendChild(el("h3", "eyebrow", group.layer + " · " + (group.media === "video" ? "Video" : "Audio") + " · " + n + (n === 1 ? " line" : " lines")));
      group.lines.forEach(function (line) {
        var row = el("div", "caption-row");
        row.appendChild(el("span", "time", formatTime(line.start)));
        row.appendChild(el("span", "text", line.text));
        wrap.appendChild(row);
      });
      root.appendChild(wrap);
    });
  }

  function formatTime(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds)) return "";
    var whole = Math.floor(seconds);
    return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
  }

  // One caption per line, ready to paste. Layer names only when there is more than one.
  function captionsAsText(withTimes) {
    var groups = snapshot && snapshot.captions && snapshot.captions.groups || [];
    var out = [];
    groups.forEach(function (group) {
      if (groups.length > 1) out.push(group.layer + " (" + group.media + ")");
      group.lines.forEach(function (line) {
        out.push((withTimes ? "[" + formatTime(line.start) + "] " : "") + line.text);
      });
      if (groups.length > 1) out.push("");
    });
    return out.join("\n").trim();
  }

  /* ---------- actions ---------- */

  function jumpToSlide(slide) {
    return jumpToId(slide.id, slide.number, slide.title);
  }

  function jumpToId(slideId, number, title) {
    return runAction(function () {
      return callPage({ type: "jump", slideId: slideId });
    }, null).then(function (result) {
      if (result && result.ok !== false) announce("Moved to slide " + number + ", " + title);
      setTimeout(refresh, 500);
    });
  }

  function stepSlide(delta) {
    if (!connected()) return;
    var target = snapshot.slides[currentIndex() + delta];
    if (!target) return;
    jumpToSlide(target);
  }

  function resetThisSlide() {
    if (!connected()) return;
    runAction(function () {
      return callPage({ type: "resetSlide" });
    }, "Slide reset");
  }

  function toggleHighlight(id) {
    runAction(function () {
      return callPage({ type: "highlight", id: id });
    }, null);
  }

  function copyText(text, message) {
    var done = function () { showToast(message || "Copied"); };
    var fallback = function () {
      if (copyWithSelection(text)) done();
      else showToast("Could not copy. Chrome blocked the clipboard here.");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
      return;
    }
    fallback();
  }

  // The DevTools tab can block navigator.clipboard, so copy through a hidden text box there.
  function copyWithSelection(text) {
    var active = document.activeElement;
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try { copied = document.execCommand("copy"); } catch (error) {}
    area.remove();
    if (active && active.focus) active.focus();
    return copied;
  }

  function downloadSnapshot() {
    if (!connected()) return;
    var lines = [];
    lines.push("Storyline Inspector notes");
    lines.push("Course: " + (snapshot.title || "Untitled course"));
    lines.push("Saved: " + new Date().toLocaleString());
    lines.push("");
    lines.push("SLIDES");
    snapshot.slides.forEach(function (slide) {
      lines.push(slide.number + "  " + slide.title + (slide.question ? "  [Knowledge check]" : "") + "  " + (slide.id || ""));
    });
    lines.push("");
    lines.push("KNOWLEDGE CHECKS");
    (snapshot.questionBank || []).forEach(function (item) {
      lines.push(item.number + "  " + item.title);
      (item.targets || []).forEach(function (t) { lines.push("    Correct: " + t.label + " (" + t.id + ")"); });
      (item.notes || []).forEach(function (n) { lines.push("    " + n); });
    });
    (snapshot.passingScores || []).forEach(function (s) { lines.push("Passing score " + s.value + " at " + s.where); });
    lines.push("");
    lines.push("ALT TEXT ON THIS SLIDE");
    visibleObjects().forEach(function (item) {
      lines.push((TYPE_LABELS[item.type] || item.type) + " · " + altStatus(item).text);
      lines.push("    " + (item.hasAlt ? item.alt : (item.fileName || "(none)")));
    });
    lines.push("");
    lines.push("NOTES ON THIS SLIDE");
    lines.push(snapshot.slideNotes && snapshot.slideNotes.text || "(none)");
    lines.push("");
    lines.push("CLOSED CAPTIONS ON THIS SLIDE");
    lines.push(captionsAsText(true) || "(none)");
    var blob = new Blob([lines.join("\n")], { type: "text/plain" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "storyline-inspector-notes.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking in the same tick can cancel the download before Chrome reads the file.
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showToast("Saved a copy of this view");
  }

  /* ---------- refresh loop ---------- */

  // A refresh asked for while one is running (a toggle, or the Refresh button)
  // runs again right after it, so the page always gets the latest settings.
  function refresh() {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = serialize(loadSnapshot).then(function () {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        return refresh();
      }
    });
    return refreshing;
  }

  function loadSnapshot() {
    return callPage({ type: "snapshot", answers: answerMode, playThrough: playThrough }).then(function (data) {
      snapshot = data;
      if (data && data.found) {
        var title = data.title || "Untitled course";
        setStatus("Connected to " + title, data.slides.length + " slides", "");
        $("help").hidden = true;
      } else {
        setStatus(data && data.loading ? "A course frame is loading. Wait for the first slide, then press Refresh." : "Looking for a Storyline course on this tab…", "", "searching");
        showHelp(data);
      }
      render();
    }).catch(function (error) {
      snapshot = null;
      setStatus(explain(error), "", "error");
      showHelp(null);
      render();
    });
  }

  function showHelp(data) {
    var help = $("help");
    help.hidden = false;
    if (data && data.reviewPage) {
      help.textContent = "This is a Review 360 page. Press Start in the course, wait until the first slide is visible, then press Refresh.";
    } else {
      help.textContent = "Published story.html, a Review 360 link, or the course inside an LMS all work. For a file saved on this PC, turn on Allow access to file URLs in the extension's details.";
    }
  }

  function runAction(action, success) {
    return serialize(action).then(function (result) {
      if (result && result.ok === false) {
        showToast(result.error || "The course did not accept that action.");
        return result;
      }
      if (success) showToast(success);
      return refresh().then(function () { return result; });
    }).catch(function (error) {
      showToast(explain(error));
    });
  }

  function startPoll() {
    clearInterval(poll);
    poll = setInterval(function () {
      if (document.hidden || pending) return;
      var active = document.activeElement;
      if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;
      refresh();
    }, 2000);
  }

  /* ---------- wiring ---------- */

  $("refresh").addEventListener("click", refresh);
  $("theme").addEventListener("click", function () {
    var next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    chrome.storage.local.set({ theme: next });
  });

  $("prev-slide").addEventListener("click", function () { stepSlide(-1); });
  $("next-slide").addEventListener("click", function () { stepSlide(1); });
  $("reset-slide").addEventListener("click", resetThisSlide);
  $("reset-slide-quiz").addEventListener("click", resetThisSlide);

  $("play-through").addEventListener("click", function () {
    playThrough = !playThrough;
    if (connected()) renderSlides();
    refresh();
  });
  $("slide-filter").addEventListener("input", function (event) {
    slideQuery = event.target.value;
    if (connected()) renderSlides();
  });

  $("answers").addEventListener("click", function () {
    answerMode = !answerMode;
    $("answers").setAttribute("aria-checked", answerMode ? "true" : "false");
    refresh();
  });
  $("next-question").addEventListener("click", function () {
    var bank = snapshot && snapshot.questionBank || [];
    var next = bank.filter(function (item) { return item.index - 1 > currentIndex(); })[0] || bank[0];
    if (next) jumpToId(next.slideId, next.number, next.title);
  });

  $("alt-filter").addEventListener("click", function () {
    altFilter = !altFilter;
    if (connected()) renderObjects();
  });
  $("copy-captions").addEventListener("click", function () {
    var text = captionsAsText(false);
    if (text) copyText(text, "Copied captions");
  });
  $("copy-notes").addEventListener("click", function () {
    var text = snapshot && snapshot.slideNotes && snapshot.slideNotes.text;
    if (text) copyText(text, "Copied notes");
  });
  $("download-snapshot").addEventListener("click", downloadSnapshot);

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });

  if (chrome.devtools && chrome.devtools.network && chrome.devtools.network.onNavigated) {
    chrome.devtools.network.onNavigated.addListener(function () { refresh(); });
  }

  chrome.storage.local.get("theme").then(function (stored) {
    document.documentElement.dataset.theme = stored.theme === "dark" ? "dark" : "light";
  }).catch(function () {
    document.documentElement.dataset.theme = "light";
  });

  setConnected(false);
  startPoll();
  refresh();
})();

(function bridge() {
  "use strict";

  // The bridge stays in the course page after the extension is reloaded. Compare
  // the source so an edited copy takes over at once instead of after a page reload.
  var build = fingerprint(bridge);
  var existing = globalThis.__lsiAltTextInspector;
  if (existing && existing.handle && existing.build === build) return;
  if (existing && existing.state) stopTimers(existing.state);

  var state = {
    answers: false,
    highlightId: "",
    highlightTimer: 0,
    targets: [],
    observer: null,
    timer: 0,
    painting: false,
    play: {
      on: false,
      poll: 0,
      watch: 0,
      armedFor: "",
      advancedFor: "",
      clickedFor: "",
      status: "off",
      detail: "",
      holdingOn: ""
    }
  };

  function core() {
    return globalThis.__lsiAltTextInspectorCore;
  }

  function fingerprint(fn) {
    var text = "";
    try { text = String(fn); } catch (error) {}
    var hash = 0;
    for (var i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return text.length + ":" + hash;
  }

  // Stops an older copy's play-through, highlight, and outline timers.
  function stopTimers(old) {
    try {
      window.clearInterval(old.highlightTimer);
      if (old.play) {
        window.clearInterval(old.play.poll);
        window.clearInterval(old.play.watch);
        old.play.on = false;
      }
      if (old.observer) old.observer.disconnect();
      if (old.timer) clearTimeout(old.timer);
      var box = document.getElementById("lcia-highlight");
      if (box) box.style.display = "none";
    } catch (error) {}
  }

  function handle(cmd) {
    try {
      if (!cmd || typeof cmd !== "object") return { found: false, error: "Unknown command." };
      var api = core();
      if (!api) return { found: false, error: "Inspector core did not load." };
      if (cmd.type === "snapshot") return snapshot(api, cmd);
      if (cmd.type === "readVar") return api.readVariable(window, cmd.name);
      if (cmd.type === "jump") return api.jump(window, cmd.slideId);
      if (cmd.type === "playThrough") return setPlayThrough(!!cmd.on);
      if (cmd.type === "resetSlide") return resetSlideView(api);
      if (cmd.type === "highlight") return setHighlight(cmd.id);
      if (cmd.type === "diagnose") return diagnose(api);
      return { found: false, error: "That action is not available." };
    } catch (error) {
      return { found: false, error: error && error.message ? error.message : "Command failed." };
    }
  }

  function snapshot(api, cmd) {
    if (typeof cmd.answers === "boolean") state.answers = cmd.answers;
    if (typeof cmd.playThrough === "boolean" && cmd.playThrough !== state.play.on) setPlayThrough(cmd.playThrough);
    var data = api.inspect(window);
    if (data.found && !data.title) data.title = courseTitleFromPage();
    data.playThrough = playStatus();
    data.objects = scanObjects(document, api);
    data.captions = typeof api.readCaptions === "function" ? api.readCaptions(window) : { available: false, groups: [] };
    data.slideNotes = typeof api.readSlideNotes === "function" ? api.readSlideNotes(window) : { available: false, text: "" };
    data.domReady = looksLike(document);
    data.reviewPage = isReviewShell(document);
    data.highlightId = state.highlightId;
    if (!data.found && data.domReady) data.loading = true;
    state.targets = data.correctTargets || [];
    ensureStyle(document);
    paintAll(document);
    if (state.highlightId && !state.highlightTimer) trackHighlight(document);
    if (state.answers || state.highlightId) watch(document);
    else unwatch();
    return data;
  }

  function courseTitleFromPage() {
    var text = String(document.title || "").replace(/\s+/g, " ").trim();
    if (text && !/^(story|index|player|untitled)$/i.test(text)) return text.slice(0, 120);
    try {
      var parentTitle = window.parent && window.parent !== window ? String(window.parent.document.title || "") : "";
      if (parentTitle.trim()) return parentTitle.replace(/\s+/g, " ").trim().slice(0, 120);
    } catch (error) {}
    return "";
  }

  function diagnose(api) {
    var model = typeof api.describeSlide === "function" ? api.describeSlide(window) : null;
    var domLayers = [];
    forEachElement(document, function (el) {
      if (domLayers.length >= 20 || !el.getAttribute || !el.classList) return;
      var className = String(el.className || "");
      if (!/layer/i.test(className) && !el.hasAttribute("data-layer-id")) return;
      var attrs = {};
      Array.prototype.slice.call(el.attributes).slice(0, 12).forEach(function (attr) {
        if (/^(style|d|points|transform)$/.test(attr.name)) return;
        attrs[attr.name] = String(attr.value).slice(0, 80);
      });
      domLayers.push({ tag: el.tagName, attrs: attrs, children: el.children.length });
    });
    var text = JSON.stringify({
      tool: "Local Storyline Inspector (Alt Text)",
      href: String(location.origin || "") + String(location.pathname || ""),
      model: model,
      domLayers: domLayers,
      objects: objectCensus(api),
      captionsManager: !!(window.DS && window.DS.captionsManager)
    }, null, 1);
    return { ok: true, text: text };
  }

  // How each object on the slide is published (kinds and flags only, no alt text),
  // so a list that looks wrong can be traced to the player's own data.
  function objectCensus(api) {
    var rows = [];
    if (!api || typeof api.readSlideObjects !== "function") return rows;
    try {
      api.readSlideObjects(window).slice(0, 80).forEach(function (row) {
        var safeId = String(row.id || "").replace(/["\\]/g, "");
        var el = safeId ? document.querySelector('[data-model-id="' + safeId + '"]') : null;
        var copy = safeId ? document.getElementById("acc-" + safeId) : null;
        rows.push({
          kind: row.objectKind,
          accType: row.accType,
          readerVisible: row.readerVisible,
          picture: row.hasPicture,
          onPage: !!el,
          shown: el ? isRendered(el) : false,
          readerCopy: copy ? copy.tagName + "." + classOf(copy).replace(/\s*acc-shadow-el\s*/, "") : ""
        });
      });
    } catch (error) {}
    return rows;
  }

  function resetSlideView(api) {
    var result = api.resetCurrentSlide(window);
    reenableSlideControls(document);
    return result;
  }

  // After submit, Storyline marks the shadow radios disabled. The model reset
  // usually clears that. This only lifts a disabled flag the redraw left behind.
  function reenableSlideControls(doc) {
    forEachElement(doc, function (el) {
      if (!el.getAttribute || !isChoiceEl(el)) return;
      try { if (el.disabled) el.disabled = false; } catch (error) {}
      if (el.getAttribute("aria-disabled") === "true") el.removeAttribute("aria-disabled");
    });
  }

  function isChoiceEl(el) {
    var role = String(el.getAttribute("role") || "").toLowerCase();
    var type = String(el.getAttribute("type") || "").toLowerCase();
    var cls = classOf(el).toLowerCase();
    if (role === "radio" || role === "checkbox" || role === "option") return true;
    if (type === "radio" || type === "checkbox") return true;
    if (/choice|radio|checkbox/.test(cls)) return true;
    return false;
  }

  // Click once to highlight, click the same object again to clear. Nothing else clears it.
  function setHighlight(id) {
    var next = typeof id === "string" ? id : "";
    state.highlightId = state.highlightId === next ? "" : next;
    ensureStyle(document);
    paintAll(document);
    trackHighlight(document);
    if (state.highlightId) watch(document);
    return { ok: true, highlightId: state.highlightId };
  }

  function findByModelId(doc, id) {
    var match = null;
    forEachElement(doc, function (el) {
      if (match || !el.getAttribute) return;
      if (el.getAttribute("data-model-id") === id || el.getAttribute("data-lcia-ref") === id || el.id === id) match = el;
    });
    return match;
  }

  // A box drawn over the object in its own fixed layer, so it stays visible even when
  // the player redraws the object or clips outlines. Follows the object while highlighted.
  function trackHighlight(doc) {
    window.clearInterval(state.highlightTimer);
    state.highlightTimer = 0;
    var box = doc.getElementById("lcia-highlight");
    if (!state.highlightId) {
      if (box) box.style.display = "none";
      return;
    }
    if (!box) {
      box = doc.createElement("div");
      box.id = "lcia-highlight";
      (doc.body || doc.documentElement).appendChild(box);
    }
    var place = function () {
      var el = findByModelId(doc, state.highlightId);
      if (!el || !isOnScreen(el)) {
        box.style.display = "none";
        return;
      }
      var rect = el.getBoundingClientRect();
      box.style.display = "block";
      box.style.left = (rect.left - 4) + "px";
      box.style.top = (rect.top - 4) + "px";
      box.style.width = (rect.width + 8) + "px";
      box.style.height = (rect.height + 8) + "px";
    };
    place();
    state.highlightTimer = window.setInterval(place, 250);
  }

  function looksLike(doc) {
    try {
      if (doc.querySelector && doc.querySelector("[data-model-id], .slide-object, .slide-window, #preso, .cs-player")) return true;
      return /story\.html|index_lms\.html|story_html5/i.test(String(location.href || ""));
    } catch (error) {
      return false;
    }
  }

  function isReviewShell(doc) {
    try {
      if (/360\.articulate\.com\/review|review\.articulate\.com/i.test(String(location.href || ""))) return true;
      return !!(doc.querySelector && doc.querySelector("iframe.player, iframe[src*='story.html'], iframe[src*='story_html5'], iframe[src*='articulateusercontent']"));
    } catch (error) {
      return false;
    }
  }

  // Lists what is on the slide and visible: Storyline objects (data-model-id) plus plain
  // images inside the slide area. Each row says what a screen reader gets.
  //
  // Storyline builds a hidden copy of every readable object (acc-<id> inside
  // .acc-shadow-dom) and that copy is what screen readers read, so its label is the alt
  // text. An object published with tabEnabled off ("Object is visible to accessibility
  // tools" unticked) has no copy: it is hidden from screen readers, which is how authors
  // mark an image decorative. The copies themselves, player controls, and anything
  // closed, transparent, or zero-sized are left out.
  function scanObjects(doc, api) {
    var fromModel = modelObjects(api);
    var hasReaderCopies = !!(doc.querySelector && doc.querySelector(".acc-shadow-dom"));
    var rows = [];
    var seen = {};
    var counter = 0;
    forEachElement(doc, function (el) {
      if (rows.length >= 300 || !el.getAttribute) return;
      if (el.closest && el.closest(".acc-shadow-dom")) return;
      var cls = classOf(el);
      if (/slide-layer|slide-container|slide-transition/.test(cls) && !/slide-object/.test(cls)) return;
      var modelId = el.getAttribute("data-model-id") || "";
      var model = modelId ? fromModel[modelId] : null;
      if (!modelId) {
        // Without a Storyline id only a real image element counts: parts inside a Storyline
        // object belong to it, slide containers are not objects, and anything outside the
        // slide (player controls, sidebar) is not course content.
        var host = el.parentElement && el.parentElement.closest ? el.parentElement.closest("[data-model-id]") : null;
        if (host || !inSlideArea(el) || !isPlainImage(el)) return;
      }
      if (model && /^(objgroup|scrollarea|shufflegroup|webobject)$/.test(model.objectKind)) return;
      var copy = modelId && doc.getElementById ? doc.getElementById("acc-" + modelId) : null;
      var type = objectType(el, cls, model, copy);
      var alt = readerText(copy) || altTextFor(el) || (model && model.alt) || "";
      if (!modelId && !alt && type !== "image") return;
      if (!isShown(el, type)) return;
      var id = modelId || el.getAttribute("data-lcia-ref") || el.id || "";
      if (!id) {
        counter += 1;
        id = "obj-" + counter + "-" + (alt || el.tagName).replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toLowerCase();
        el.setAttribute("data-lcia-ref", id);
      }
      if (seen[id]) return;
      seen[id] = 1;
      var readerHidden = model ? model.readerVisible === false : (hasReaderCopies && modelId ? !copy : isHiddenFromReaders(el));
      var emptyAlt = !alt && el.tagName === "IMG" && el.hasAttribute("alt");
      var rect = el.getBoundingClientRect();
      rows.push({
        id: id,
        type: type,
        alt: alt,
        hasAlt: alt.length > 0,
        readerHidden: readerHidden,
        decorative: type === "image" && (readerHidden || emptyAlt),
        defaultName: isDefaultName(alt),
        fileName: type === "image" ? imageFileName(el) : "",
        layer: model && model.layer ? model.layer : "",
        top: Math.round(rect.top),
        left: Math.round(rect.left)
      });
    });
    rows.sort(function (a, b) { return (a.top - b.top) || (a.left - b.left); });
    return rows;
  }

  function inSlideArea(el) {
    return !!(el.closest && el.closest(".slide-layer, .slide-window, #slide-window"));
  }

  function isPlainImage(el) {
    var tag = String(el.tagName || "").toLowerCase();
    return tag === "img" || tag === "image" || tag === "picture" || String(el.getAttribute("role") || "").toLowerCase() === "img";
  }

  // The slide data says what the author made the object; the hidden reader copy and
  // the page markup are the fallbacks for players that do not expose it.
  function objectType(el, cls, model, copy) {
    var acc = model ? model.accType : "";
    var kind = model ? model.objectKind : "";
    var copyClass = copy ? classOf(copy) : "";
    if (acc === "button" || kind === "button" || kind === "hotspot" || /acc-button/.test(copyClass)) return "button";
    if (/^(radio|checkbox)$/.test(acc) || /acc-(radio|checkbox)/.test(copyClass)) return "choice";
    if (acc === "image" || (model && model.hasPicture) || /acc-image/.test(copyClass)) return "image";
    if (/^(textinput|textentry|input)$/.test(acc) || kind === "textinput") return "input";
    if (model && acc) {
      if (/^(icon|graphic|picture|image)\b/i.test(model.alt || "")) return "image";
      return el.querySelector && el.querySelector("text, tspan") ? "text" : "shape";
    }
    if (isImage(el, cls)) return "image";
    return typeFor(el);
  }

  // What a screen reader announces for the hidden copy: its label, or for a text or
  // button copy, its own text.
  function readerText(copy) {
    if (!copy) return "";
    var label = copy.getAttribute("aria-label") || copy.getAttribute("alt") || "";
    if (label.trim()) return cleanText(label);
    if (copy.tagName === "INPUT") return "";
    return cleanText(copy.textContent || "").slice(0, 2000);
  }

  // Storyline fills alt text with the object's name until someone writes it: the file
  // name for a picture ("Picture 2.png") or a numbered name for a shape ("Rectangle 7").
  function isDefaultName(text) {
    var value = String(text || "").trim();
    if (!value) return false;
    if (/\.(png|jpe?g|gif|svg|bmp|webp|tiff?|emf|wmf|ico)$/i.test(value)) return true;
    return /^(picture|image|graphic|icon|photo|illustration|rectangle|rounded rectangle|oval|circle|shape|freeform|line|arrow|star|triangle|button|hotspot|marker|group|text ?box|title|placeholder|character|callout)\s*\d+$/i.test(value);
  }

  // Shown means rendered at a visible size. A see-through object is skipped unless it is
  // a button, since hotspots are transparent on purpose.
  function isShown(el, type) {
    if (!isRendered(el)) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (type === "button") return true;
    try {
      if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } catch (error) {}
    return true;
  }

  function modelObjects(api) {
    var map = {};
    if (!api || typeof api.readSlideObjects !== "function") return map;
    try {
      api.readSlideObjects(window).forEach(function (row) {
        if (row && row.id) map[row.id] = row;
      });
    } catch (error) {}
    return map;
  }

  // SVG elements expose className as an object, so read the attribute instead.
  function classOf(el) {
    if (typeof el.className === "string") return el.className;
    return String(el.getAttribute("class") || "");
  }

  function isImage(el, cls) {
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "img" || tag === "image" || tag === "picture") return true;
    if (String(el.getAttribute("role") || "").toLowerCase() === "img") return true;
    if (/slide-object-image|slide-object-picture|object-image/.test(cls)) return true;
    if (/slide-object/.test(cls) && !/group/.test(cls) && el.querySelector && el.querySelector("img, image, picture")) return true;
    return false;
  }

  // When an image has no alt text, its file name is the next best handle for finding it.
  function imageFileName(el) {
    var target = el;
    if (el.tagName !== "IMG" && el.tagName !== "image" && el.querySelector) target = el.querySelector("img, image") || el;
    var src = target.getAttribute("src") || target.getAttribute("href") || target.getAttribute("xlink:href") || "";
    if (!src || /^data:/.test(src)) return "";
    var clean = src.split("?")[0].split("#")[0];
    var name = clean.substring(clean.lastIndexOf("/") + 1);
    try { name = decodeURIComponent(name); } catch (error) {}
    return name.slice(0, 80);
  }

  // Rendered means not inside anything that is display:none or visibility:hidden
  // (a closed layer, for example). Size and position are not considered.
  function isRendered(el) {
    try {
      if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
      var view = el.ownerDocument.defaultView || window;
      var node = el;
      while (node && node.nodeType === 1) {
        var style = view.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        node = node.parentElement;
      }
      return true;
    } catch (error) {
      return true;
    }
  }

  function isOnScreen(el) {
    return isRendered(el);
  }

  function altTextFor(el) {
    var direct = el.getAttribute("data-acc-text") || el.getAttribute("aria-label") || "";
    if (direct.trim()) return cleanText(direct);
    var labelled = el.getAttribute("aria-labelledby");
    if (labelled && el.ownerDocument) {
      var target = el.ownerDocument.getElementById(labelled);
      if (target && target.textContent.trim()) return cleanText(target.textContent);
    }
    if (el.tagName === "IMG" && el.getAttribute("alt")) return cleanText(el.getAttribute("alt"));
    var image = el.querySelector ? el.querySelector("img[alt]") : null;
    if (image && image.getAttribute("alt").trim()) return cleanText(image.getAttribute("alt"));
    return "";
  }

  function cleanText(value) {
    return String(value || "").replace(/[\uE000-\uF8FF\uFFF0-\uFFFF\u0000-\u001F]/g, "").replace(/\s+/g, " ").trim();
  }

  function typeFor(el) {
    var tag = el.tagName;
    var role = String(el.getAttribute("role") || "").toLowerCase();
    var className = classOf(el).toLowerCase();
    if (role === "radio" || role === "checkbox" || role === "option" || /choice|radio|checkbox/.test(className)) return "choice";
    if (tag === "BUTTON" || role === "button" || role === "link" || tag === "A" || /button|hotspot/.test(className) || el.getAttribute("tabindex") === "0") return "button";
    if (tag === "INPUT" || tag === "TEXTAREA" || role === "textbox" || /textinput|text-input|textentry/.test(className)) return "input";
    if (tag === "IMG" || /picture|image/.test(className) || (el.querySelector && !!el.querySelector("img, image, picture, video, canvas"))) return "image";
    if (/textbox|caption|text/.test(className) || (el.querySelector && !!el.querySelector("text, tspan, p, span"))) return "text";
    return "shape";
  }

  // Only the object's own flags count. Storyline hides its visual wrappers from
  // screen readers and exposes the accessible text separately.
  function isHiddenFromReaders(el) {
    if (el.getAttribute("aria-hidden") === "true") return true;
    var role = String(el.getAttribute("role") || "").toLowerCase();
    return (role === "presentation" || role === "none") && !el.getAttribute("data-acc-text") && !el.getAttribute("aria-label");
  }

  function paintAll(doc) {
    runPaint(function () {
      forEachElement(doc, function (el) {
        if (!el.classList) return;
        el.classList.remove("lcia-correct", "lcia-focus");
      });
      var wanted = {};
      (state.targets || []).forEach(function (target) {
        if (target && target.id) wanted[target.id] = 1;
      });
      forEachElement(doc, function (el) {
        if (!el.getAttribute) return;
        var id = el.getAttribute("data-model-id") || el.getAttribute("data-lcia-ref");
        if (!id) return;
        if (state.answers && wanted[id]) el.classList.add("lcia-correct");
        if (state.highlightId && id === state.highlightId) el.classList.add("lcia-focus");
      });
    });
  }

  function runPaint(fn) {
    state.painting = true;
    try { fn(); } finally { state.painting = false; }
  }

  function watch(doc) {
    if (state.observer || typeof MutationObserver !== "function") return;
    var root = doc.body || doc.documentElement;
    if (!root) return;
    state.observer = new MutationObserver(function (records) {
      if (state.painting) return;
      var relevant = false;
      records.forEach(function (record) {
        var nodes = [];
        record.addedNodes.forEach(function (node) { nodes.push(node); });
        record.removedNodes.forEach(function (node) { nodes.push(node); });
        nodes.forEach(function (node) {
          if (!isOurs(node)) relevant = true;
        });
      });
      if (!relevant) return;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(function () {
        state.timer = 0;
        paintAll(doc);
      }, 180);
    });
    state.observer.observe(root, { childList: true, subtree: true });
  }

  function unwatch() {
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    if (state.timer) clearTimeout(state.timer);
    state.timer = 0;
  }

  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.id === "lcia-style" || node.id === "lcia-highlight";
  }

  function forEachElement(root, visit) {
    var stack = [root];
    var count = 0;
    while (stack.length && count < 20000) {
      var node = stack.pop();
      if (!node) continue;
      count += 1;
      if (node.nodeType === 1) visit(node);
      if (node.shadowRoot) stack.push(node.shadowRoot);
      var kids = node.children;
      if (!kids) continue;
      for (var i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    }
  }

  function ensureStyle(doc) {
    if (!doc.getElementById || doc.getElementById("lcia-style")) return;
    var style = doc.createElement("style");
    style.id = "lcia-style";
    style.textContent = [
      ".lcia-correct{outline:3px solid #cb2027 !important;outline-offset:2px !important;}",
      ".lcia-focus{outline:3px dashed #1a1718 !important;outline-offset:3px !important;}",
      "#lcia-highlight{position:fixed;z-index:2147483647;pointer-events:none;display:none;box-sizing:border-box;border:3px solid #1a1718;border-radius:6px;box-shadow:0 0 0 3px rgba(255,255,255,.95),0 0 0 6px rgba(26,23,24,.35),0 6px 20px rgba(0,0,0,.25);}"
    ].join("");
    (doc.head || doc.documentElement).appendChild(style);
  }

  function playStatus() {
    return {
      on: state.play.on,
      status: state.play.status,
      detail: state.play.detail,
      holdingOn: state.play.holdingOn
    };
  }

  function setPlayThrough(on) {
    state.play.on = !!on;
    if (!state.play.on) {
      window.clearInterval(state.play.poll);
      window.clearInterval(state.play.watch);
      state.play.poll = 0;
      state.play.watch = 0;
      state.play.armedFor = "";
      state.play.clickedFor = "";
      state.play.status = "off";
      state.play.detail = "";
      state.play.holdingOn = "";
      return { ok: true, playThrough: playStatus() };
    }
    state.play.status = "playing";
    state.play.detail = "Waiting for this slide to finish.";
    if (!state.play.poll) state.play.poll = window.setInterval(playTick, 500);
    playTick();
    return { ok: true, playThrough: playStatus() };
  }

  function playTick() {
    if (!state.play.on) return;
    var api = core();
    if (!api) return;
    var data;
    try { data = api.inspect(window); } catch (error) { return; }
    if (!data || !data.found) return;
    var slideId = data.currentSlideId || "";
    if (data.playback && data.playback.knowledgeCheck) {
      window.clearInterval(state.play.watch);
      state.play.watch = 0;
      state.play.armedFor = "";
      state.play.advancedFor = "";
      state.play.status = "holding";
      var row = (data.slides || []).filter(function (slide) { return slide.current; })[0];
      state.play.holdingOn = row ? row.number : "";
      state.play.detail = "Holding on " + (row ? row.number : "this slide") + ": answer or leave the question to continue";
      return;
    }
    state.play.holdingOn = "";
    if (!slideId || state.play.armedFor === slideId || state.play.advancedFor === slideId) return;
    armSlide(slideId, data.playback || {});
  }

  function armSlide(slideId, playback) {
    window.clearInterval(state.play.watch);
    state.play.armedFor = slideId;
    // Cleared per slide: left over, it stops a revisited slide from ever advancing.
    state.play.clickedFor = "";
    state.play.status = "playing";
    var started = Date.now();
    var nextAtStart = nextControlState();
    var durationMs = playback.durationMs || 0;
    state.play.detail = durationMs
      ? "Playing this slide, then moving on."
      : "Waiting until Next becomes available.";
    state.play.watch = window.setInterval(function () {
      if (!state.play.on || state.play.armedFor !== slideId) return;
      var api = core();
      var data;
      try { data = api.inspect(window); } catch (error) { return; }
      var currentId = data && data.currentSlideId || "";
      if (currentId && currentId !== slideId) {
        window.clearInterval(state.play.watch);
        state.play.watch = 0;
        state.play.armedFor = "";
        return;
      }
      if (data && data.playback && data.playback.knowledgeCheck) {
        playTick();
        return;
      }
      var elapsed = Date.now() - started;
      var nextNow = nextControlState();
      var durationDone = durationMs > 0 && elapsed >= durationMs + 500;
      var nextOpened = nextAtStart === "disabled" && nextNow === "enabled";
      var timelineDone = !durationMs && timelineAtEnd();
      if (!durationDone && !nextOpened && !timelineDone) {
        if (!durationMs && nextAtStart === "enabled" && elapsed > 1500 && !state.play.clickedFor) {
          state.play.status = "stuck";
          state.play.detail = "This slide has no published length, and Next is already available. Press Next once, and playback continues.";
        }
        return;
      }
      if (state.play.clickedFor === slideId) return;
      if (!advanceSlide()) {
        state.play.status = "stuck";
        state.play.detail = "This slide finished, but no Next control was available.";
        return;
      }
      state.play.clickedFor = slideId;
      state.play.status = "advancing";
      state.play.detail = "Moving to the next slide.";
    }, 400);
  }

  function advanceSlide() {
    if (clickNext()) return true;
    var api = core();
    if (!api || typeof api.goNext !== "function") return false;
    var result = api.goNext(window);
    return !!(result && result.ok);
  }

  function clickNext() {
    var button = findNextControl(true);
    if (!button) return false;
    button.click();
    return true;
  }

  function nextControlState() {
    var enabled = findNextControl(true);
    if (enabled) return "enabled";
    if (findNextControl(false)) return "disabled";
    return "missing";
  }

  function findNextControl(requireEnabled) {
    var match = null;
    forEachElement(document, function (el) {
      if (match || !isNextControl(el)) return;
      var disabled = !!(el.disabled || el.getAttribute("aria-disabled") === "true" || (el.classList && (el.classList.contains("cs-disabled") || el.classList.contains("disabled"))));
      if (requireEnabled && disabled) return;
      match = el;
    });
    return match;
  }

  function isNextControl(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    var role = String(el.getAttribute("role") || "").toLowerCase();
    if (tag !== "BUTTON" && tag !== "A" && role !== "button") return false;
    var className = String(el.className || "").toLowerCase();
    var id = String(el.id || "");
    var label = (String(el.getAttribute("aria-label") || "") + " " + String(el.getAttribute("title") || "")).toLowerCase();
    var text = String(el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (className.indexOf("cs-next") !== -1 || /(^|[^a-z])next-button([^a-z]|$)/.test(className)) return true;
    if (/^next$/i.test(id)) return true;
    if (/\bnext\b/.test(label) && label.indexOf("previous") === -1) return true;
    return text === "next" || text === "next slide";
  }

  function timelineAtEnd() {
    var done = false;
    forEachElement(document, function (el) {
      if (done || !el.getAttribute) return;
      if (String(el.getAttribute("type") || "").toLowerCase() !== "range") return;
      var hint = (String(el.getAttribute("aria-label") || "") + " " + String(el.className || "") + " " + String(el.id || "")).toLowerCase();
      if (!/timeline|seek|scrub|progress|time/.test(hint)) return;
      var max = Number(el.max || el.getAttribute("aria-valuemax") || 0);
      var value = Number(el.value || el.getAttribute("aria-valuenow") || 0);
      if (max > 0 && value >= max - Math.max(0.05, max * 0.01)) done = true;
    });
    return done;
  }

  globalThis.__lsiAltTextInspector = { handle: handle, state: state, build: build };
})();

(function (root) {
  "use strict";

  var BUILT_INS = [
    "Menu.SectionNumber",
    "Menu.SlideNumber",
    "Menu.SlideReference",
    "Menu.SlideTitle",
    "Menu.SlidesViewed",
    "Menu.Progress",
    "Project.ElapsedTime",
    "Scene.SlideNumber",
    "Results.ScorePercent",
    "Results.ScorePoints",
    "Results.PassPercent",
    "Results.PassPoints",
    "Results.Passed"
  ];

  var BUILTIN_ALIASES = {
    "Menu.Progress": ["_playerVars.#menuProgress"],
    "Results.ScorePercent": ["_playerVars.#resultsScorePercent"],
    "Results.PassPercent": ["_playerVars.#resultsPassPercent"]
  };

  var SKIP_KEYS = {
    window: 1,
    top: 1,
    parent: 1,
    frames: 1,
    self: 1,
    globalThis: 1,
    document: 1,
    ownerDocument: 1,
    defaultView: 1,
    view: 1,
    el: 1,
    element: 1,
    dom: 1,
    domNode: 1,
    node: 1,
    style: 1,
    classList: 1,
    parentNode: 1,
    owner: 1,
    $el: 1,
    _el: 1,
    jquery: 1
  };

  var HEAVY_KEYS = {
    slides: 1,
    scenes: 1,
    slideLayers: 1,
    objects: 1,
    assets: 1,
    timeline: 1,
    events: 1,
    triggers: 1,
    choices: 1,
    hotspots: 1,
    media: 1,
    thumbnail: 1,
    thumbnails: 1
  };

  var PASS_KEYS = [
    "passPercent",
    "passPoints",
    "passingScore",
    "PassPercent",
    "PassPoints",
    "PassingScore"
  ];

  function inspect(win) {
    try {
      return inspectInner(win);
    } catch (error) {
      return { found: false, error: message(error) };
    }
  }

  function inspectInner(win) {
    if (!win || typeof win !== "object") {
      return { found: false, error: "No page window." };
    }

    var hasPlayer = typeof win.GetPlayer === "function" || typeof win.getVar === "function" || typeof win.setVar === "function";
    var hasDS = !!(win.DS && (win.DS.presentation || win.DS.windowManager));
    var href = safeHref(win);
    if (!hasPlayer && !hasDS) return { found: false, href: href };

    var map = new Map();
    knownBuckets(win).forEach(function (bucket) {
      absorbBucket(bucket, map, new Set());
    });

    if (map.size === 0 && win.DS && win.DS.presentation) {
      walkForVariables(win.DS.presentation, map, 4, new Set(), { count: 0, max: 1500, win: win });
    }

    BUILT_INS.forEach(function (name) {
      if (map.has(name)) return;
      var value = readVarWithAliases(win, name);
      if (value === undefined || (value && typeof value === "object")) return;
      map.set(name, { name: name, value: value, declared: "", live: true });
    });

    applyLive(win, map);

    var variables = Array.from(map.values()).map(function (row) {
      return {
        name: row.name,
        value: row.value,
        type: row.type,
        live: !!row.live,
        fromModel: !!row.fromModel,
        initial: row.fromModel ? row.initial : null
      };
    }).sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    var entries = readSlideEntries(win);
    var current = currentSlideObject(win);
    var currentId = idFrom(current);
    var sceneIndex = new Map();
    var sceneCounts = new Map();
    var slides = entries.map(function (entry, index) {
      var scene = entry.scene;
      var sceneKey = scene || "course";
      if (!sceneIndex.has(sceneKey)) sceneIndex.set(sceneKey, sceneIndex.size);
      var ordinal = sceneIndex.get(sceneKey);
      var within = (sceneCounts.get(sceneKey) || 0) + 1;
      sceneCounts.set(sceneKey, within);
      var id = idFrom(entry.slide);
      var sceneNo = sceneNumber(scene, ordinal);
      return {
        id: id,
        title: slideTitle(entry.slide),
        index: index + 1,
        number: sceneNo + "." + within,
        sceneNumber: sceneNo,
        scene: sceneName(scene, ordinal),
        current: !!id && id === currentId,
        question: false
      };
    });

    var quiz = quizFromSlide(current, win);
    var questionBank = [];
    entries.forEach(function (entry, index) {
      if (questionBank.length >= 60) return;
      var slideId = idFrom(entry.slide);
      var isCurrent = !!slideId && slideId === currentId;
      if (!isCurrent && !mightHaveQuiz(entry.slide)) return;
      var found = isCurrent ? quiz : quizFromSlide(entry.slide, win);
      if (!found.targets.length && !found.notes.length) return;
      questionBank.push({
        slideId: slideId,
        index: index + 1,
        title: slideTitle(entry.slide),
        targets: found.targets,
        notes: found.notes
      });
    });
    var questionIds = {};
    questionBank.forEach(function (question) {
      if (question.slideId) questionIds[question.slideId] = 1;
    });
    slides.forEach(function (slide) {
      slide.question = !!(slide.id && questionIds[slide.id]);
    });
    questionBank.forEach(function (question) {
      var row = slides[question.index - 1];
      question.number = row ? row.number : String(question.index);
      question.current = !!(question.slideId && question.slideId === currentId);
    });
    var passingScores = [];
    var seenPass = {};
    variables.forEach(function (variable) {
      if (!isPassName(variable.name)) return;
      if (typeof variable.value !== "number" || !(variable.value > 0 && variable.value <= 100)) return;
      addPass(passingScores, seenPass, variable.name, variable.value);
    });
    gatherPassProps(win).forEach(function (item) {
      addPass(passingScores, seenPass, item.label, item.value);
    });

    var warnings = [];
    if (!variables.length) warnings.push("No variables were listed. Type a name and choose Read.");
    if (!slides.length) warnings.push("No slide list was found in this player.");
    var jumpVia = jumpCapability(win);
    if (slides.length && jumpVia === "unavailable") {
      warnings.push("This player does not expose slide jump. Unlock navigation, then use the course Next button.");
    }

    return {
      found: true,
      href: href,
      title: presentationTitle(win),
      jumpVia: jumpVia,
      variables: variables,
      slides: slides,
      currentSlideId: currentId,
      correctTargets: quiz.targets,
      quizNotes: quiz.notes,
      questionBank: questionBank,
      passingScores: passingScores,
      layers: readLayerList(current),
      feedback: readLayerList(current).filter(function (layer) { return layer.kind; }),
      states: readStates(current, win),
      triggers: readTriggers(current, win),
      notes: readSlideNotes(win).text,
      navigation: readNavigation(win),
      playback: readPlayback(current, quiz),
      questionState: readQuestionState(current, win),
      warnings: warnings
    };
  }

  function readQuestionState(slide, win) {
    var out = { answered: false, result: "", attempts: 0 };
    if (!slide) return out;
    walk(slide, function (obj) {
      if (!obj || Array.isArray(obj)) return;
      ["answered", "submitted", "isAnswered", "isSubmitted"].forEach(function (key) {
        if (readKey(obj, key) === true) out.answered = true;
      });
      ["eval", "evalResult", "lastResult", "interactionResult"].forEach(function (key) {
        var value = readKey(obj, key);
        if (typeof value !== "string") return;
        var text = value.toLowerCase();
        if (text === "correct" || text === "incorrect") {
          out.answered = true;
          out.result = text;
        }
      });
      ["attemptCount", "attemptsUsed", "currentAttempt", "attemptNumber", "numAttempts"].forEach(function (key) {
        var value = readKey(obj, key);
        if (typeof value === "number" && value > out.attempts && value < 1000) out.attempts = value;
      });
    }, 8, new Set(), { count: 0, max: 2500, win: win }, []);
    var flag = readVarWithAliases(win, "Question.Correct");
    if (flag === true) {
      out.answered = true;
      out.result = "correct";
    }
    if (out.answered && !out.attempts) out.attempts = 1;
    return out;
  }

  function sceneNumber(scene, ordinal) {
    if (scene && typeof scene === "object") {
      if (typeof scene.sceneNumber === "number") return scene.sceneNumber;
      if (scene.attributes && typeof scene.attributes.sceneNumber === "number") return scene.attributes.sceneNumber;
    }
    return ordinal + 1;
  }

  function setVariable(win, name, raw, declaredType) {
    try {
      if (typeof name !== "string" || !name.trim() || name.length > 120) {
        return { ok: false, error: "Enter a variable name." };
      }
      name = name.trim();
      var type = declaredType || guessType(raw);
      if (type !== "boolean" && type !== "number") type = "string";
      var coerced = coerce(raw, type);
      if (coerced && typeof coerced === "object") return { ok: false, error: coerced.error };
      var written = writeVar(win, name, coerced);
      if (written.ok) updateModel(win, name, written.value);
      return written;
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  function readVariable(win, name) {
    try {
      if (typeof name !== "string" || !name.trim()) return { ok: false, error: "Enter a variable name." };
      name = name.trim();
      var value = readVarWithAliases(win, name);
      if (value === undefined || (value && typeof value === "object")) {
        return {
          ok: false,
          error: "That name did not return a value. Built-in Storyline names sometimes have to be copied into a project variable first."
        };
      }
      return { ok: true, name: name, value: plainValue(value), type: inferType(value, "") };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  function jump(win, slideId) {
    try {
      if (typeof slideId !== "string" || !slideId) return { ok: false, error: "Missing slide id." };
      var match = null;
      readSlideEntries(win).forEach(function (entry) {
        if (match) return;
        if (idFrom(entry.slide) === slideId || entry.slide.absoluteId === slideId) match = entry.slide;
      });
      var player = safePlayer(win);
      if (player && typeof player.JumpToSlide === "function") {
        player.JumpToSlide(slideId);
        return { ok: true, via: "JumpToSlide" };
      }
      if (player && typeof player.jumpToSlide === "function") {
        player.jumpToSlide(slideId);
        return { ok: true, via: "jumpToSlide" };
      }
      var manager = win.DS && win.DS.windowManager;
      if (match && manager && typeof manager.requestSlideForReview === "function") {
        manager.requestSlideForReview(match, "_frame");
        return { ok: true, via: "requestSlideForReview" };
      }
      return {
        ok: false,
        error: "This publish does not expose slide jump. Use Unlock navigation, then the course Next button."
      };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  function unlock(win) {
    try {
      var changes = [];
      var presentation = win.DS && win.DS.presentation;
      var holders = [
        presentation,
        presentation && presentation.navigation,
        presentation && presentation.playerProps,
        presentation && presentation.player,
        presentation && presentation.menu,
        presentation && presentation.attributes
      ];
      holders.forEach(function (holder) {
        if (!holder || typeof holder !== "object") return;
        ["flow", "menuFlow", "navigationMode", "navMode"].forEach(function (key) {
          var value;
          try { value = holder[key]; } catch (error) { return; }
          if (typeof value === "string" && /restricted|locked/i.test(value)) {
            if (trySet(holder, key, "free")) changes.push(key + " set to free");
          }
        });
        ["restrictNavigation", "restricted", "menuRestricted", "lockNavigation"].forEach(function (key) {
          if (holder[key] === true && trySet(holder, key, false)) changes.push(key + " cleared");
        });
      });
      var marked = 0;
      readSlideEntries(win).forEach(function (entry) {
        var slide = entry.slide;
        if (trySet(slide, "viewed", true)) marked += 1;
        if ("visited" in slide) trySet(slide, "visited", true);
        if (slide.attributes && typeof slide.attributes === "object") {
          trySet(slide.attributes, "viewed", true);
          if ("visited" in slide.attributes) trySet(slide.attributes, "visited", true);
        }
      });
      if (marked) changes.push(marked + (marked === 1 ? " slide marked viewed" : " slides marked viewed"));
      return { ok: true, changes: changes };
    } catch (error) {
      return { ok: false, error: message(error), changes: [] };
    }
  }

  function resetDefaults(win) {
    try {
      var changes = [];
      inspect(win).variables.forEach(function (variable) {
        if (!variable.fromModel) return;
        if (sameValue(variable.value, variable.initial)) return;
        var written = setVariable(win, variable.name, variable.initial, variable.type);
        if (written.ok) changes.push(variable.name + " restored");
      });
      return { ok: true, changes: changes };
    } catch (error) {
      return { ok: false, error: message(error), changes: [] };
    }
  }

  function setMany(win, items) {
    try {
      var changes = [];
      (Array.isArray(items) ? items : []).slice(0, 300).forEach(function (item) {
        if (!item || typeof item.name !== "string") return;
        var written = setVariable(win, item.name, item.value, item.type || "");
        if (written.ok) changes.push(item.name + " set");
      });
      return { ok: true, changes: changes };
    } catch (error) {
      return { ok: false, error: message(error), changes: [] };
    }
  }

  function markQuizzesPassed(win) {
    try {
      var changes = [];
      var seen = {};
      inspect(win).variables.forEach(function (variable) {
        if (/(^|\.)ScorePercent$/i.test(variable.name) && typeof variable.value === "number" && variable.value !== 100) {
          var scored = setVariable(win, variable.name, 100, "number");
          if (scored.ok) addMarked(changes, seen, variable.name, variable.value, 100);
        }
        if (/(^|\.)Passed$/i.test(variable.name) && variable.value !== true) {
          var passed = setVariable(win, variable.name, true, "boolean");
          if (passed.ok) addMarked(changes, seen, variable.name, variable.value, true);
        }
      });
      var zeroed = zeroPassingScores(win);
      (zeroed.changes || []).forEach(function (change) {
        addMarked(changes, seen, change.where, change.from, 0);
      });
      return { ok: true, changes: changes };
    } catch (error) {
      return { ok: false, error: message(error), changes: [] };
    }
  }

  function showFeedback(win, kind) {
    try {
      var wanted = kind === "incorrect" ? "incorrect" : kind === "tryAgain" ? "tryAgain" : "correct";
      var slide = currentSlideObject(win);
      var items = collectFeedback(slide, win);
      var layerSummary = items.map(function (item) {
        return { id: item.id || "", kind: item.kind, title: item.title || "", type: item.type };
      });
      var allLayers = readLayerList(slide).map(function (layer) { return layer.title; });
      var matches = items.filter(function (item) { return item.kind === wanted; });
      if (!matches.length) {
        return {
          ok: false,
          error: allLayers.length
            ? "This slide's layers are named " + allLayers.slice(0, 6).join(", ") + ". None of them reads as " + wanted + " feedback."
            : "The player did not list any layers for this slide. Use Copy slide details under Slide details and send it along.",
          layers: layerSummary
        };
      }
      var completion = captureCompletion(win);
      items.forEach(function (item) {
        if (!item.kind || item.kind === wanted) return;
        if (item.type === "layer" && item.trusted && item.obj) hideLayerObject(win, slide, item.obj);
        if (item.type === "state" && item.obj) applyState(item.obj, "Normal");
      });
      var applied = false;
      var via = "";
      matches.forEach(function (item) {
        if (item.type === "layer") {
          var shown = item.obj ? showLayerObject(win, slide, item.obj) : showLayer(win, item.id);
          if (shown && shown.ok) {
            applied = true;
            via = shown.via || "show";
          }
        }
        if (item.type === "state" && applyState(item.obj, item.stateName)) {
          applied = true;
          via = via || "state";
        }
      });
      var restored = restoreCompletion(win, completion);
      return {
        ok: applied,
        via: via,
        error: applied ? "" : "The feedback was found, but this player did not switch it on.",
        title: matches[0].title,
        kind: wanted,
        layers: layerSummary,
        completion: completion,
        restored: restored.restored || []
      };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  function collectFeedback(slide, win) {
    var found = [];
    var seen = {};
    function add(item) {
      var key = item.type + "|" + item.kind + "|" + (item.id || "") + "|" + (item.stateName || item.title || "");
      if (seen[key]) return;
      seen[key] = 1;
      found.push(item);
    }
    var roots = [];
    function pushRoot(root) {
      if (root && typeof root === "object") roots.push(root);
    }
    pushRoot(slide);
    ["slide", "baseSlide", "activeSlide", "baseLayer"].forEach(function (key) {
      pushRoot(slide && readKey(slide, key));
    });
    ["getSlideLayers", "getLayers", "getAllLayers"].forEach(function (method) {
      if (!slide || typeof slide[method] !== "function") return;
      try { pushRoot(slide[method]()); } catch (error) {}
    });
    var slideIds = {};
    readSlideEntries(win).forEach(function (entry) {
      var slideId = idFrom(entry.slide);
      if (slideId) slideIds[slideId] = 1;
    });
    roots.forEach(function (root) {
      readLayerList(root).forEach(function (layer) {
        if (!layer.kind) return;
        add({
          type: "layer",
          id: layer.id,
          title: layer.title,
          kind: layer.kind,
          trusted: true,
          obj: findLayerObject(root, layer.id)
        });
      });
      walk(root, function (obj) {
        if (!obj || Array.isArray(obj)) return;
        if (roots.indexOf(obj) !== -1) return;
        var objId = idFrom(obj);
        if (objId && slideIds[objId]) return;
        var slideLike = !!(readKey(obj, "slideLayers") || readKey(obj, "layers") || readKey(obj, "slideLayerList") || typeof obj.getSlideLayers === "function");
        if (slideLike) return;
        var title = firstText([obj.title, obj.name, obj.lmstext, obj.accText, obj.label, obj.displayName]);
        var kind = feedbackKind(title);
        if (kind && typeof obj.show === "function" && typeof obj.hide === "function") {
          add({ type: "layer", id: objId, title: title, kind: kind, obj: obj });
        }
        var states = readKey(obj, "states");
        if (!Array.isArray(states)) states = readKey(obj, "stateList");
        if (!Array.isArray(states)) return;
        states.forEach(function (state) {
          var stateName = typeof state === "string" ? state : firstText([state && state.name, state && state.title, state && state.id]);
          var stateKind = feedbackKind(stateName);
          if (!stateKind) return;
          add({
            type: "state",
            id: idFrom(obj),
            title: stateName,
            stateName: stateName,
            kind: stateKind,
            obj: obj
          });
        });
      }, 8, new Set(), { count: 0, max: 2500, win: win }, []);
    });
    return found;
  }

  function firstText(values) {
    for (var i = 0; i < values.length; i += 1) {
      if (typeof values[i] === "string" && values[i].trim()) return values[i].trim();
    }
    return "";
  }

  function callShow(obj) {
    try {
      obj.show();
      return { ok: true, via: "show" };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  function applyState(obj, stateName) {
    if (!obj || !stateName) return false;
    try {
      if (typeof obj.setState === "function") {
        obj.setState(stateName);
        return true;
      }
      if (typeof obj.setCurrentState === "function") {
        obj.setCurrentState(stateName);
        return true;
      }
    } catch (error) {}
    return false;
  }

  function captureCompletion(win) {
    var rows = [];
    inspect(win).variables.forEach(function (variable) {
      if (!isCompletionName(variable.name)) return;
      rows.push({ name: variable.name, value: variable.value, type: variable.type });
    });
    return rows;
  }

  function restoreCompletion(win, rows) {
    var restored = [];
    (rows || []).forEach(function (row) {
      if (!row || !isCompletionName(row.name)) return;
      var live = readVarWithAliases(win, row.name);
      if (sameValue(live, row.value)) return;
      var written = setVariable(win, row.name, row.value, row.type || "");
      if (written.ok) restored.push(row.name);
    });
    return { ok: true, restored: restored };
  }

  function isCompletionName(name) {
    return /(^|\.)(Correct|Passed|ScorePercent|ScorePoints|Attempts)$/i.test(String(name || ""));
  }

  function resetCurrentSlide(win) {
    try {
      var slide = currentSlideObject(win);
      if (!slide) return { ok: false, error: "No slide is open.", changes: [] };
      var changes = [];
      // Clear the saved answer before replaying. Replaying while the question is
      // still marked correct runs the player's "question answered" actions, which
      // closes the menu and grades the next click as a review of the old attempt.
      var answers = resetSlideInteractions(slide);
      if (answers) changes.push("Cleared " + answers + (answers === 1 ? " answer" : " answers"));
      clearSlideResume(slide);
      var redrawn = redrawSlide(slide);
      if (redrawn) changes.push(redrawn);
      // Replay can put the saved answer back. Clear it again, then restore the choices.
      resetSlideInteractions(slide);
      var restored = restoreChoiceObjects(slide, win) + restoreChoiceStates(slide, win);
      if (restored) changes.push("Re-enabled " + restored + (restored === 1 ? " choice" : " choices"));
      readLayerList(slide).forEach(function (layer) {
        if (!layer.kind) return;
        var live = findLayerObject(slide, layer.id);
        if (live && hideLayerObject(win, slide, live)) changes.push("Hid " + layer.title);
      });
      var cleared = clearAttemptFlags(slide, win);
      if (cleared) changes.push("Cleared " + cleared + (cleared === 1 ? " answer mark" : " answer marks"));
      var questionFlags = {};
      inspect(win).variables.forEach(function (variable) {
        if (/^Question\.Correct$/i.test(variable.name) || /^questionCorrect$/i.test(variable.name)) questionFlags[variable.name] = variable.value;
      });
      var currentCorrect = readVarWithAliases(win, "Question.Correct");
      if (currentCorrect !== undefined) questionFlags["Question.Correct"] = currentCorrect;
      Object.keys(questionFlags).forEach(function (name) {
        if (questionFlags[name] !== true) return;
        var written = setVariable(win, name, false, "boolean");
        if (written.ok) changes.push(name + " cleared");
      });
      if (!changes.length) changes.push("This slide was already at the start.");
      return { ok: true, changes: changes };
    } catch (error) {
      return { ok: false, error: message(error), changes: [] };
    }
  }

  function clearAttemptFlags(slide, win) {
    var count = 0;
    var attemptFlags = {
      answered: 1, isAnswered: 1, hasAnswered: 1,
      submitted: 1, isSubmitted: 1, hasSubmitted: 1,
      complete: 1, completed: 1, isComplete: 1, isCompleted: 1, evaluated: 1
    };
    walk(slide, function (obj) {
      if (!obj || Array.isArray(obj)) return;
      Object.keys(attemptFlags).forEach(function (key) {
        var value = flagValue(obj, key);
        if (value !== true && value !== 1) return;
        if (writeAttr(obj, key, false)) count += 1;
      });
      ["attemptCount", "attemptsUsed", "currentAttempt", "attemptNumber", "numAttempts"].forEach(function (key) {
        var value = flagValue(obj, key);
        if (typeof value === "number" && value > 0 && writeAttr(obj, key, 0)) count += 1;
      });
      ["resetInteraction", "resetQuestion", "resetAttempts", "clearResponse"].forEach(function (name) {
        if (typeof obj[name] !== "function") return;
        try { obj[name](); count += 1; } catch (error) {}
      });
    }, 8, new Set(), { count: 0, max: 2500, win: win }, []);
    return count;
  }

  // Drop the saved answer so replaying the slide cannot restore the selected radio.
  function clearSlideResume(slide) {
    try { if (typeof slide.clearResumeData === "function") slide.clearResumeData(); } catch (error) {}
    try { if (typeof slide.resetResume === "function") slide.resetResume(); } catch (error) {}
    layerModels(slide).forEach(function (layer) {
      try { if (typeof layer.clearResumeData === "function") layer.clearResumeData(); } catch (error) {}
    });
  }

  // Replay the slide from the start so the feedback and the selected radio go away.
  function redrawSlide(slide) {
    if (typeof slide.reset === "function") {
      try { slide.reset(); return "Reset the slide"; } catch (error) {}
    }
    return replaySlide(slide);
  }

  // The published player stores the radio's look in ObjectState, including
  // Selected, Disabled, and Review. Review is what paints a choice correct or
  // incorrect. Put every choice back to its plain state and turn it on.
  function findSlideObject(slide, id, win) {
    var match = null;
    function consider(obj) {
      if (match || !obj || typeof obj !== "object") return;
      if (obj.id !== id && idFrom(obj) !== id) return;
      if (typeof obj.prop !== "function") return;
      match = obj;
    }
    var containers = [slide].concat(layerModels(slide));
    function visit(obj, depth) {
      if (match || !obj || typeof obj !== "object" || depth > 8) return;
      consider(obj);
      if (match) return;
      childObjects(obj).forEach(function (child) { visit(child, depth + 1); });
      if (typeof obj.getChildren !== "function") return;
      try {
        var kids = obj.getChildren() || [];
        for (var i = 0; i < kids.length; i += 1) visit(kids[i], depth + 1);
      } catch (error) {}
    }
    containers.forEach(function (container) { visit(container, 0); });
    if (!match) consider(findById(slide, id, win));
    return match;
  }

  function restoreChoiceObjects(slide, win) {
    var list = [];
    try {
      if (typeof slide.interactions === "function") list = collectionToArray(slide.interactions());
    } catch (error) {}
    var count = 0;
    list.forEach(function (interaction) {
      var choices = [];
      try {
        var raw = typeof interaction.choices === "function" ? interaction.choices() : interaction.choices;
        choices = collectionToArray(raw);
      } catch (error) {}
      choices.forEach(function (choice) {
        var id = String((choice && choice.id) || "").replace(/^choice_/, "");
        if (!id) return;
        var obj = findSlideObject(slide, id, win);
        if (!obj || typeof obj.prop !== "function") return;
        try {
          var state = obj.prop("ObjectState");
          if (typeof state === "string" && state !== "_default") {
            obj.prop("ObjectState", "_default");
            count += 1;
          }
          obj.prop("Enabled", true);
        } catch (error) {}
      });
    });
    return count;
  }

  // Storyline locks each choice in the Disabled state after submit. Put them back
  // to Normal or the radios stay unselectable even once the flags are cleared.
  function restoreChoiceStates(slide, win) {
    var count = 0;
    walk(slide, function (obj) {
      if (!obj || Array.isArray(obj)) return;
      var state = currentStateName(obj);
      if (!state || !/^(disabled|selected)$/i.test(state)) return;
      // The published player's setState expects an action, not a state name.
      // A one-argument setState is the simple setter used by older data.
      if (typeof obj.setState === "function" && obj.setState.length < 2) {
        try { obj.setState("Normal"); count += 1; return; } catch (error) {}
      }
      if (typeof obj.setCurrentState === "function") {
        try { obj.setCurrentState("Normal"); count += 1; return; } catch (error) {}
      }
      if (writeAttr(obj, "currentState", "Normal") || writeAttr(obj, "state", "Normal")) count += 1;
    }, 8, new Set(), { count: 0, max: 2500, win: win }, []);
    return count;
  }

  function currentStateName(obj) {
    var keys = ["currentState", "shownState", "state"];
    for (var i = 0; i < keys.length; i += 1) {
      var value = flagValue(obj, keys[i]);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  // The published player gives each model an accessor method per attribute
  // (layer.audiolib(), obj.kind()), so a function found on the object is not the value.
  function modelValue(obj, key) {
    var direct = readKey(obj, key);
    if (direct !== undefined && typeof direct !== "function") return direct;
    var attrs = readKey(obj, "attributes");
    if (attrs && typeof attrs === "object") {
      var stored = readKey(attrs, key);
      if (stored !== undefined) return stored;
    }
    if (typeof obj.get === "function") {
      try {
        var got = obj.get(key);
        if (got !== undefined) return got;
      } catch (error) {}
    }
    return undefined;
  }

  function flagValue(obj, key) {
    var value = readKey(obj, key);
    if (value !== undefined) return value;
    if (typeof obj.get === "function") {
      try {
        value = obj.get(key);
        if (value !== undefined) return value;
      } catch (error) {}
    }
    if (obj.attributes && typeof obj.attributes === "object") return readKey(obj.attributes, key);
    return undefined;
  }

  // Storyline keeps the chosen radio in the interaction, and question slides are
  // set to resume that saved answer. resetResume(true) drops the response and the
  // answered/disabled props. Do this before the slide redraws.
  function resetSlideInteractions(slide) {
    var list = [];
    try {
      if (typeof slide.interactions === "function") list = collectionToArray(slide.interactions());
    } catch (error) {}
    var count = 0;
    list.forEach(function (interaction) {
      try {
        if (typeof interaction.resetResume === "function") {
          interaction.resetResume(true);
          count += 1;
        } else if (typeof interaction.reset === "function") {
          interaction.reset();
          count += 1;
        }
      } catch (error) {}
    });
    return count;
  }

  function replaySlide(slide) {
    var timeline = readKey(slide, "timeline");
    if (timeline && typeof timeline.seek === "function") {
      try { timeline.seek(0); return "Restarted the slide"; } catch (error) {}
    }
    if (timeline && typeof timeline.setTime === "function") {
      try { timeline.setTime(0); return "Restarted the slide"; } catch (error) {}
    }
    return "";
  }

  function hideLayer(win, layerId) {
    var slide = currentSlideObject(win);
    var live = findLayerObject(slide, layerId);
    if (!live) return;
    hideLayerObject(win, slide, live);
  }

  function showLayer(win, layerId) {
    try {
      if (typeof layerId !== "string" || !layerId) return { ok: false, error: "Missing layer id." };
      var slide = currentSlideObject(win);
      var live = findLayerObject(slide, layerId);
      if (!live) return { ok: false, error: "That layer is not on this slide." };
      return showLayerObject(win, slide, live);
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  function setObjectState(win, objectId, stateName) {
    try {
      if (typeof objectId !== "string" || !objectId || typeof stateName !== "string" || !stateName) {
        return { ok: false, error: "Choose an object and a state." };
      }
      var obj = findById(currentSlideObject(win), objectId, win);
      if (obj && typeof obj.setState === "function") {
        obj.setState(stateName);
        return { ok: true, via: "setState" };
      }
      if (obj && typeof obj.setCurrentState === "function") {
        obj.setCurrentState(stateName);
        return { ok: true, via: "setCurrentState" };
      }
      return callAllowlisted(win, ["setState", "setObjectState", "changeState"], [
        [objectId, stateName],
        [obj, stateName]
      ]);
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  function goNext(win) {
    try {
      return callAllowlisted(win, ["next", "nextSlide", "gotoNextSlide", "goToNextSlide", "moveNext"], [[]]);
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  function controlTimeline(win, action, seconds) {
    try {
      var names = {
        pause: ["pause", "pauseTimeline", "stop"],
        play: ["play", "playTimeline", "resume"],
        seek: ["seek", "setTime", "setTimelineTime"]
      };
      if (action === "seek") {
        var time = Number(seconds);
        if (!Number.isFinite(time) || time < 0) return { ok: false, error: "Enter a time in seconds." };
        return callAllowlisted(win, names.seek, [[time]]);
      }
      if (!names[action]) return { ok: false, error: "Unknown timeline action." };
      return callAllowlisted(win, names[action], [[]]);
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  function zeroPassingScores(win) {
    try {
      var changes = [];
      var seen = {};
      inspect(win).variables.forEach(function (variable) {
        if (!isPassName(variable.name)) return;
        if (typeof variable.value !== "number" || !(variable.value > 0 && variable.value <= 100)) return;
        var written = setVariable(win, variable.name, 0, "number");
        if (written.ok) addChange(changes, seen, variable.name, variable.value);
      });
      gatherPassProps(win).forEach(function (item) {
        if (!(item.value > 0 && item.value <= 100)) return;
        if (!trySet(item.obj, item.key, 0)) return;
        addChange(changes, seen, item.label, item.value);
      });
      var current = currentSlideObject(win);
      walk(current, function (obj) {
        PASS_KEYS.forEach(function (key) {
          var value;
          try { value = obj[key]; } catch (error) { return; }
          if (typeof value !== "number" || !(value > 0 && value <= 100)) return;
          if (!trySet(obj, key, 0)) return;
          addChange(changes, seen, "loaded slide." + key, value);
        });
      }, 8, new Set(), { count: 0, max: 2500, win: win }, []);
      return { ok: true, changes: changes };
    } catch (error) {
      return { ok: false, error: message(error), changes: [] };
    }
  }

  function pickBest(results) {
    var list = Array.isArray(results) ? results : [];
    var found = list.filter(function (item) { return item && item.found; });
    if (found.length) {
      found.sort(function (a, b) { return rank(b) - rank(a); });
      if (anyReview(list)) found[0].reviewPage = true;
      return found[0];
    }
    var review = anyReview(list);
    var loading = list.find(function (item) { return item && item.loading; });
    if (loading) return { found: false, loading: true, reviewPage: review, href: loading.href || "" };
    if (review) return { found: false, reviewPage: true, href: reviewHref(list) };
    var withError = list.find(function (item) { return item && item.error; });
    return { found: false, error: withError ? withError.error : "" };
  }

  function anyReview(list) {
    return list.some(function (item) { return item && item.reviewPage; });
  }

  function reviewHref(list) {
    var match = list.find(function (item) { return item && item.reviewPage && item.href; });
    return match ? match.href : "";
  }

  function rank(item) {
    var slides = Array.isArray(item.slides) ? item.slides.length : 0;
    var variables = Array.isArray(item.variables) ? item.variables.length : 0;
    return slides * 2 + variables;
  }

  function knownBuckets(win) {
    var buckets = [];
    var presentation = win.DS && win.DS.presentation;
    var player = safePlayer(win);
    var holders = [
      presentation,
      player,
      player && player.object,
      player && player.data,
      presentation && presentation.project,
      presentation && presentation.data
    ];
    holders.forEach(function (holder) {
      if (!holder || typeof holder !== "object") return;
      ["variables", "variableList", "vars", "userVariables"].forEach(function (key) {
        try {
          if (holder[key] != null) buckets.push(holder[key]);
        } catch (error) {}
      });
      ["getVariables", "getAllVariables", "getVariableList"].forEach(function (method) {
        if (typeof holder[method] !== "function") return;
        try { buckets.push(holder[method]()); } catch (error) {}
      });
    });
    if (typeof win.globalLoadData === "function") {
      try { buckets.push(win.globalLoadData("data")); } catch (error) {}
    }
    return buckets;
  }

  function absorbBucket(bucket, map, seen) {
    if (bucket == null || seen.has(bucket)) return;
    if (typeof bucket === "string") {
      if (bucket.length > 2000000 || bucket.indexOf("variables") === -1) return;
      var start = bucket.trim().charAt(0);
      if (start !== "{" && start !== "[") return;
      try { bucket = JSON.parse(bucket); } catch (error) { return; }
    }
    if (!bucket || typeof bucket !== "object") return;
    seen.add(bucket);
    if (Array.isArray(bucket)) {
      bucket.forEach(function (item) { absorbBucket(item, map, seen); });
      return;
    }
    if (bucket.variables) absorbBucket(bucket.variables, map, seen);
    if (bucket.course) absorbBucket(bucket.course, map, seen);
    var keys = safeKeys(bucket);
    var dict = keys.length > 0 && !bucket.name && keys.every(function (key) {
      var value = readKey(bucket, key);
      return !!value && typeof value === "object" && !Array.isArray(value) && ("value" in value || "type" in value || "kind" in value);
    });
    if (dict) {
      keys.forEach(function (key) {
        var source = readKey(bucket, key);
        var row = asVariable(assignName(source, key));
        if (row) map.set(row.name, row);
      });
      return;
    }
    var one = asVariable(bucket);
    if (one) map.set(one.name, one);
  }

  function assignName(source, key) {
    var copy = {};
    safeKeys(source).forEach(function (name) { copy[name] = readKey(source, name); });
    if (typeof copy.name !== "string") copy.name = key;
    return copy;
  }

  function walkForVariables(obj, map, depth, seen, nodes) {
    if (!obj || typeof obj !== "object" || seen.has(obj) || depth < 0 || nodes.count > nodes.max) return;
    if (isSkippable(obj, nodes.win)) return;
    seen.add(obj);
    nodes.count += 1;
    var row = asVariable(obj);
    if (row) map.set(row.name, row);
    safeKeys(obj).forEach(function (key) {
      if (SKIP_KEYS[key] || HEAVY_KEYS[key]) return;
      var child = readKey(obj, key);
      if (child && typeof child === "object") walkForVariables(child, map, depth - 1, seen, nodes);
    });
  }

  function asVariable(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    var name;
    var value;
    var declared = "";
    var hasValue = false;
    try {
      name = obj.name;
      declared = obj.type || obj.kind || "";
      if (Object.prototype.hasOwnProperty.call(obj, "value")) {
        hasValue = true;
        value = obj.value;
      } else if (Object.prototype.hasOwnProperty.call(obj, "defaultValue")) {
        hasValue = true;
        value = obj.defaultValue;
      } else if (Object.prototype.hasOwnProperty.call(obj, "defaultvalue")) {
        hasValue = true;
        value = obj.defaultvalue;
      }
    } catch (error) {
      return null;
    }
    if (typeof name !== "string") return null;
    name = name.trim();
    if (!name || name.length > 120 || name === "constructor" || name === "prototype") return null;
    if (!hasValue || (value && typeof value === "object")) return null;
    var kind = String(declared || "").toLowerCase();
    if (["slide", "scene", "layer", "choice", "object", "asset", "image", "video", "audio", "shape", "hotspot", "trigger", "timeline"].indexOf(kind) !== -1) {
      return null;
    }
    return { name: name, value: value, declared: declared, live: false, fromModel: true };
  }

  function applyLive(win, map) {
    map.forEach(function (row) {
      if (row.fromModel && row.initial === undefined) row.initial = plainValue(row.value);
      var live = readVarWithAliases(win, row.name);
      if (live !== undefined && (live === null || typeof live !== "object")) {
        row.value = live;
        row.live = true;
      }
      row.type = inferType(row.value, row.declared);
      row.value = plainValue(row.value);
    });
  }

  function readSlideEntries(win) {
    var presentation = win.DS && win.DS.presentation;
    if (!presentation) return [];
    try {
      if (typeof presentation.getFlatSlides === "function") {
        var flat = presentation.getFlatSlides();
        if (Array.isArray(flat) && flat.length) {
          return flat.filter(Boolean).map(function (slide) {
            return { slide: slide, scene: slide.scene || slide.parent || null };
          });
        }
      }
    } catch (error) {}
    var scenes = Array.isArray(presentation.scenes) ? presentation.scenes : [];
    var entries = [];
    scenes.forEach(function (scene) {
      var slides = scene && Array.isArray(scene.slides) ? scene.slides : [];
      slides.forEach(function (slide) {
        if (slide && typeof slide === "object") entries.push({ slide: slide, scene: scene });
      });
    });
    return entries;
  }

  function currentSlideObject(win) {
    var manager = win.DS && win.DS.windowManager;
    var presentation = win.DS && win.DS.presentation;
    var attempts = [];
    if (manager && typeof manager.getCurrentWindowSlide === "function") attempts.push(function () { return manager.getCurrentWindowSlide(); });
    if (presentation && typeof presentation.getCurrentSlide === "function") attempts.push(function () { return presentation.getCurrentSlide(); });
    for (var i = 0; i < attempts.length; i += 1) {
      try {
        var value = attempts[i]();
        if (value && typeof value === "object") return value;
      } catch (error) {}
    }
    return null;
  }

  function quizFromSlide(slide, win) {
    var targets = [];
    var notes = [];
    var seen = {};
    if (!slide) return { targets: targets, notes: notes };
    walk(slide, function (obj, parents) {
      if (isCorrectFlag(obj)) {
        var ids = idsOf(obj);
        if (!ids.length) {
          for (var i = parents.length - 1; i >= 0 && !ids.length; i -= 1) ids = idsOf(parents[i]);
        }
        var label = labelOf(obj);
        if (!label) {
          for (var p = parents.length - 1; p >= 0 && !label; p -= 1) label = labelOf(parents[p]);
        }
        if (!label) label = "Correct choice";
        if (!ids.length) addNote(notes, seen, "Correct choice: " + label);
        ids.forEach(function (id) {
          var key = id + "|" + label;
          if (seen[key]) return;
          seen[key] = 1;
          targets.push({ id: id, label: label });
        });
      }
      ["correctValue", "correctvalue"].forEach(function (key) {
        var value = readKey(obj, key);
        if (typeof value === "string" || typeof value === "number") addNote(notes, seen, "Correct value: " + value);
      });
      var accepted = readKey(obj, "acceptableAnswers");
      if (!Array.isArray(accepted)) accepted = readKey(obj, "acceptableanswers");
      if (Array.isArray(accepted)) {
        var texts = accepted.filter(function (item) {
          return typeof item === "string" || typeof item === "number";
        }).slice(0, 12);
        if (texts.length) addNote(notes, seen, "Accepted answers: " + texts.join(", "));
      }
    }, 8, new Set(), { count: 0, max: 2500, win: win }, []);
    return { targets: targets.slice(0, 40), notes: notes.slice(0, 30) };
  }

  function gatherPassProps(win) {
    var into = [];
    var presentation = win.DS && win.DS.presentation;
    readPassProps(presentation, "presentation", into);
    if (presentation) {
      readPassProps(presentation.quiz, "quiz", into);
      readPassProps(presentation.quizSettings, "quiz settings", into);
      readPassProps(presentation.attributes, "presentation attributes", into);
      ["quizzes", "results", "quizList"].forEach(function (key) {
        var list = presentation[key];
        if (!Array.isArray(list)) return;
        list.forEach(function (item, index) {
          readPassProps(item, key + " " + (index + 1), into);
        });
      });
    }
    readSlideEntries(win).forEach(function (entry, index) {
      var label = "slide " + (index + 1);
      readPassProps(entry.slide, label, into);
      ["quiz", "attributes", "results"].forEach(function (key) {
        var child = readKey(entry.slide, key);
        if (Array.isArray(child)) {
          child.forEach(function (item, itemIndex) {
            readPassProps(item, label + " " + key + " " + (itemIndex + 1), into);
          });
        } else {
          readPassProps(child, label + " " + key, into);
        }
      });
    });
    return into;
  }

  function readPassProps(obj, label, into) {
    if (!obj || typeof obj !== "object") return;
    PASS_KEYS.forEach(function (key) {
      var value;
      try { value = obj[key]; } catch (error) { return; }
      if (typeof value !== "number" || !(value > 0 && value <= 100)) return;
      into.push({ obj: obj, key: key, value: value, label: label + "." + key });
    });
  }

  function walk(root, visitor, depthLeft, seen, nodes, parents) {
    if (!root || typeof root !== "object" || seen.has(root) || nodes.count > nodes.max) return;
    if (isSkippable(root, nodes.win)) return;
    seen.add(root);
    nodes.count += 1;
    visitor(root, parents || []);
    if (depthLeft <= 0) return;
    var used = 0;
    safeKeys(root).forEach(function (key) {
      if (used >= 150 || nodes.count > nodes.max || SKIP_KEYS[key]) return;
      var child = readKey(root, key);
      if (!child || typeof child !== "object") return;
      used += 1;
      var nextParents = (parents || []).concat(root).slice(-3);
      walk(child, visitor, depthLeft - 1, seen, nodes, nextParents);
    });
  }

  function isCorrectFlag(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (obj.correct === true || obj.isCorrect === true || obj.iscorrect === true) return true;
    var status = String(obj.status || obj.state || "").toLowerCase();
    return status === "correct";
  }

  function idsOf(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
    var ids = [];
    ["id", "modelId", "modelid", "absoluteId", "dataModelId"].forEach(function (key) {
      var value = readKey(obj, key);
      if (typeof value === "string" && /^[A-Za-z0-9._:-]{2,80}$/.test(value)) ids.push(value);
    });
    return ids;
  }

  function labelOf(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
    var keys = ["lmstext", "text", "title", "altText", "accText", "label", "name", "displayText"];
    var sources = [obj, readKey(obj, "attributes")];
    for (var s = 0; s < sources.length; s += 1) {
      if (!sources[s] || typeof sources[s] !== "object") continue;
      for (var i = 0; i < keys.length; i += 1) {
        var value = readKey(sources[s], keys[i]);
        if (typeof value === "string" && value.trim()) return cleanLabel(value);
      }
    }
    if (typeof obj.get === "function") {
      for (var g = 0; g < keys.length; g += 1) {
        try {
          var got = obj.get(keys[g]);
          if (typeof got === "string" && got.trim()) return cleanLabel(got);
        } catch (error) {}
      }
    }
    return "";
  }

  function cleanLabel(value) {
    return String(value).replace(/<[^>]+>/g, " ").replace(/[\uE000-\uF8FF\uFFF0-\uFFFF]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
  }

  function jumpCapability(win) {
    var player = safePlayer(win);
    if (player && (typeof player.JumpToSlide === "function" || typeof player.jumpToSlide === "function")) return "JumpToSlide";
    var manager = win.DS && win.DS.windowManager;
    if (manager && typeof manager.requestSlideForReview === "function") return "requestSlideForReview";
    return "unavailable";
  }

  function writeVar(win, name, value) {
    var names = [name].concat(BUILTIN_ALIASES[name] || []);
    var lastError = "This page has no SetVar method.";
    for (var i = 0; i < names.length; i += 1) {
      var attempt = writeOnce(win, names[i], value);
      if (!attempt.wrote) {
        lastError = attempt.error || lastError;
        continue;
      }
      var seen = readVarWithAliases(win, name);
      if (seen === undefined || sameValue(seen, value)) {
        return { ok: true, name: name, value: seen === undefined ? plainValue(value) : plainValue(seen) };
      }
      lastError = "The player kept a different value.";
    }
    if (updateModel(win, name, value)) return { ok: true, name: name, value: plainValue(value), via: "model" };
    return { ok: false, error: lastError };
  }

  function writeOnce(win, name, value) {
    var wrote = false;
    var lastError = "";
    function tryWrite(fn) {
      try {
        fn();
        wrote = true;
      } catch (error) {
        lastError = message(error);
      }
    }
    if (typeof win.setVar === "function") tryWrite(function () { win.setVar(name, value); });
    var player = safePlayer(win);
    if (player && typeof player.SetVar === "function") tryWrite(function () { player.SetVar(name, value); });
    else if (player && typeof player.setVar === "function") tryWrite(function () { player.setVar(name, value); });
    return { wrote: wrote, error: lastError };
  }

  function updateModel(win, name, value) {
    var updated = false;
    var seen = new Set();
    knownBuckets(win).forEach(function (bucket) {
      visitVariableObjects(bucket, seen, function (obj) {
        if (obj.name !== name || !("value" in obj)) return;
        if (trySet(obj, "value", value)) updated = true;
      });
    });
    return updated;
  }

  function visitVariableObjects(bucket, seen, fn) {
    if (bucket == null || seen.has(bucket)) return;
    if (typeof bucket === "string") return;
    if (typeof bucket !== "object") return;
    seen.add(bucket);
    if (Array.isArray(bucket)) {
      bucket.forEach(function (item) { visitVariableObjects(item, seen, fn); });
      return;
    }
    if (asVariable(bucket)) fn(bucket);
    if (bucket.variables) visitVariableObjects(bucket.variables, seen, fn);
    if (bucket.course) visitVariableObjects(bucket.course, seen, fn);
  }

  function readVarWithAliases(win, name) {
    var direct = readVar(win, name);
    if (direct !== undefined) return direct;
    var aliases = BUILTIN_ALIASES[name] || [];
    for (var i = 0; i < aliases.length; i += 1) {
      var value = readVar(win, aliases[i]);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function readVar(win, name) {
    var attempts = [];
    if (typeof win.getVar === "function") attempts.push(function () { return win.getVar(name); });
    var player = safePlayer(win);
    if (player && typeof player.GetVar === "function") attempts.push(function () { return player.GetVar(name); });
    if (player && typeof player.getVar === "function") attempts.push(function () { return player.getVar(name); });
    for (var i = 0; i < attempts.length; i += 1) {
      try {
        var value = attempts[i]();
        if (value !== undefined) return value;
      } catch (error) {}
    }
    return undefined;
  }

  function safePlayer(win) {
    if (!win || typeof win.GetPlayer !== "function") return null;
    try { return win.GetPlayer() || null; } catch (error) { return null; }
  }

  function coerce(raw, type) {
    if (type === "boolean") {
      if (typeof raw === "boolean") return raw;
      var text = String(raw).trim().toLowerCase();
      if (text === "true" || text === "yes" || text === "1") return true;
      if (text === "false" || text === "no" || text === "0") return false;
      return { error: "Use true or false." };
    }
    if (type === "number") {
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      var number = Number(String(raw).trim());
      if (!Number.isFinite(number)) return { error: "Enter a number." };
      return number;
    }
    if (raw == null) return "";
    return String(raw).slice(0, 20000);
  }

  function guessType(raw) {
    if (typeof raw === "number" && Number.isFinite(raw)) return "number";
    if (typeof raw === "boolean") return "boolean";
    var text = String(raw == null ? "" : raw).trim().toLowerCase();
    if (text === "true" || text === "false") return "boolean";
    if (text !== "" && Number.isFinite(Number(text))) return "number";
    return "string";
  }

  function inferType(value, declared) {
    var kind = String(declared || "").toLowerCase();
    if (kind.indexOf("bool") !== -1) return "boolean";
    if (kind.indexOf("num") !== -1) return "number";
    if (kind === "text" || kind.indexOf("string") !== -1) return "string";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    return "string";
  }

  function plainValue(value) {
    if (value == null) return value === null ? null : "";
    if (typeof value === "string") return value.length > 20000 ? value.slice(0, 20000) : value;
    if (typeof value === "number") return Number.isFinite(value) ? value : "";
    if (typeof value === "boolean") return value;
    return String(value).slice(0, 20000);
  }

  function isPassName(name) {
    return /(^|\.)(PassPercent|PassPoints|PassingScore)$/i.test(name);
  }

  function idFrom(obj) {
    if (!obj || typeof obj !== "object") return "";
    if (typeof obj.id === "string" && obj.id) return obj.id;
    if (typeof obj.absoluteId === "string" && obj.absoluteId) return obj.absoluteId;
    if (obj.attributes && typeof obj.attributes.id === "string") return obj.attributes.id;
    if (obj.slide) return idFrom(obj.slide);
    return "";
  }

  function slideTitle(slide) {
    var values = [
      slide.title,
      slide.name,
      slide.displayTitle,
      slide.attributes && slide.attributes.title,
      slide.attributes && slide.attributes.slideTitle,
      slide.attributes && slide.attributes.name
    ];
    for (var i = 0; i < values.length; i += 1) {
      var text = typeof values[i] === "string" ? titleText(values[i]) : "";
      if (text) return text;
    }
    return "Untitled slide";
  }

  // Some players keep a slide title as a styled HTML paragraph. Show only its words, on one line.
  function titleText(value) {
    return notesText(value).replace(/\s+/g, " ");
  }

  function sceneName(scene, index) {
    if (!scene || typeof scene !== "object") return "Course";
    var direct = [scene.title, scene.name, scene.lmsId];
    for (var i = 0; i < direct.length; i += 1) {
      if (typeof direct[i] === "string" && direct[i].trim()) return direct[i].trim();
    }
    var attr = scene.attributes;
    if (attr) {
      var nested = [attr.title, attr.lmsId, attr.name];
      for (var n = 0; n < nested.length; n += 1) {
        if (typeof nested[n] === "string" && nested[n].trim()) return nested[n].trim();
      }
      if (typeof attr.sceneNumber === "number") return "Scene " + attr.sceneNumber;
    }
    if (typeof scene.sceneNumber === "number") return "Scene " + scene.sceneNumber;
    return "Scene " + (index + 1);
  }

  function presentationTitle(win) {
    var presentation = win.DS && win.DS.presentation;
    if (!presentation) return "";
    if (typeof presentation.title === "string") return presentation.title;
    if (typeof presentation.name === "string") return presentation.name;
    if (presentation.attributes && typeof presentation.attributes.title === "string") return presentation.attributes.title;
    return "";
  }

  function safeHref(win) {
    try {
      var location = win.location;
      if (!location) return "";
      return String(location.origin || "") + String(location.pathname || "");
    } catch (error) {
      return "";
    }
  }

  function isSkippable(value, win) {
    if (!value || typeof value !== "object") return true;
    if (value === win) return true;
    try {
      if (win && (value === win.window || value === win.document)) return true;
    } catch (error) {}
    if (typeof value.nodeType === "number") return true;
    var ctor = value.constructor && value.constructor.name;
    return !!(ctor && /^(Window|Document|HTML|SVG|CSS|Node|Element|Text|Attr)/.test(ctor));
  }

  function safeKeys(obj) {
    try { return Object.keys(obj); } catch (error) { return []; }
  }

  function readKey(obj, key) {
    try { return obj[key]; } catch (error) { return undefined; }
  }

  function trySet(obj, key, value) {
    try {
      obj[key] = value;
      return obj[key] === value;
    } catch (error) {
      return false;
    }
  }

  // Storyline models store flags behind set/get. Direct assignment leaves the
  // real attribute (and the radios) unchanged.
  function writeAttr(obj, key, value) {
    if (typeof obj.set === "function") {
      try {
        obj.set(key, value);
        if (typeof obj.get === "function") {
          try { if (obj.get(key) === value) return true; } catch (error) {}
        }
        if (obj.attributes && readKey(obj.attributes, key) === value) return true;
        return true;
      } catch (error) {}
    }
    if (obj.attributes && typeof obj.attributes === "object") {
      try { obj.attributes[key] = value; } catch (error) {}
    }
    return trySet(obj, key, value);
  }

  function sameValue(left, right) {
    if (left === right) return true;
    if (typeof right === "boolean" && String(left).toLowerCase() === String(right)) return true;
    if (typeof right === "number" && Number(left) === right) return true;
    return false;
  }

  function addNote(notes, seen, note) {
    if (seen[note] || notes.length >= 30) return;
    seen[note] = 1;
    notes.push(note);
  }

  function addPass(list, seen, where, value) {
    var key = where + ":" + value;
    if (seen[key]) return;
    seen[key] = 1;
    list.push({ where: where, value: value });
  }

  function addChange(list, seen, where, from) {
    addMarked(list, seen, where, from, 0);
  }

  function addMarked(list, seen, where, from, to) {
    var key = where + ":" + from + ":" + to;
    if (seen[key]) return;
    seen[key] = 1;
    list.push({ where: where, from: from, to: to });
  }

  function mightHaveQuiz(slide) {
    if (!slide || typeof slide !== "object") return false;
    if (slide.quiz || slide.questions || slide.interactions) return true;
    return /quiz|question|interaction|choice|survey/.test(safeKeys(slide).join(" ").toLowerCase());
  }

  function feedbackKind(title) {
    var text = String(title || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (/\bincorrect\b|\bwrong\b/.test(text)) return "incorrect";
    if (/try again/.test(text)) return "tryAgain";
    if (/\breview\b/.test(text)) return "review";
    if (/\bcorrect\b/.test(text)) return "correct";
    return "";
  }

  function readLayerList(slide) {
    var found = [];
    var seen = {};
    if (!slide) return found;
    layerModels(slide).forEach(function (obj) {
      if (isBaseLayerModel(obj, slide)) return;
      var id = idFrom(obj);
      var title = layerTitle(obj);
      if (!id && !title) return;
      var key = id || title;
      if (seen[key]) return;
      seen[key] = 1;
      var label = title || id || "Layer";
      found.push({ id: id, title: label, kind: feedbackKind(label) });
    });
    return found.slice(0, 40);
  }

  // Storyline's modern player keeps layers behind a method that returns a collection,
  // older output keeps a plain array. Normalize both to an array of layer objects.
  function layerModels(slide) {
    if (!slide || typeof slide !== "object") return [];
    var keys = ["slideLayers", "layers", "slideLayerList", "getSlideLayers", "getLayers", "getAllLayers"];
    for (var i = 0; i < keys.length; i += 1) {
      var value = readKey(slide, keys[i]);
      if (typeof value === "function") {
        try { value = value.call(slide); } catch (error) { continue; }
      }
      var list = collectionToArray(value);
      if (list.length) return list;
    }
    return [];
  }

  function collectionToArray(value) {
    if (!value || typeof value !== "object") return [];
    var isObj = function (item) { return !!item && typeof item === "object"; };
    if (Array.isArray(value)) return value.filter(isObj);
    if (Array.isArray(value.models)) return value.models.filter(isObj);
    if (typeof value.toArray === "function") {
      try {
        var arr = value.toArray();
        if (Array.isArray(arr)) return arr.filter(isObj);
      } catch (error) {}
    }
    if (typeof value.length === "number" && value.length < 500) {
      var out = [];
      for (var i = 0; i < value.length; i += 1) {
        var item = typeof value.at === "function" ? value.at(i) : value[i];
        if (isObj(item)) out.push(item);
      }
      if (out.length) return out;
    }
    return [];
  }

  function layerTitle(layer) {
    var direct = firstText([
      readKey(layer, "title"), readKey(layer, "name"), readKey(layer, "displayName"), readKey(layer, "label"),
      layer.attributes && readKey(layer.attributes, "title"), layer.attributes && readKey(layer.attributes, "name")
    ]);
    if (direct) return direct;
    var getters = ["get", "prop", "attr"];
    for (var g = 0; g < getters.length; g += 1) {
      if (typeof layer[getters[g]] !== "function") continue;
      try {
        var value = layer[getters[g]]("title");
        if (typeof value === "string" && value.trim()) return value.trim();
      } catch (error) {}
    }
    return "";
  }

  function isBaseLayerModel(layer, slide) {
    var flag = readKey(layer, "isBaseLayer");
    if (flag === true) return true;
    if (typeof flag === "function") {
      try { if (flag.call(layer) === true) return true; } catch (error) {}
    }
    if (readKey(layer, "baseLayer") === true || readKey(layer, "isBase") === true) return true;
    return !!(slide && layer === slide);
  }

  function showLayerObject(win, slide, layer) {
    var id = idFrom(layer);
    var tries = [
      function () { return typeof layer.show === "function" && (layer.show(), "layer.show"); },
      function () { return typeof layer.showLayer === "function" && (layer.showLayer(), "layer.showLayer"); },
      function () { return slide && typeof slide.showLayer === "function" && (slide.showLayer(layer), "slide.showLayer"); },
      function () { return slide && typeof slide.showLayer === "function" && id && (slide.showLayer(id), "slide.showLayer(id)"); },
      function () { return slide && typeof slide.showSlideLayer === "function" && (slide.showSlideLayer(layer), "slide.showSlideLayer"); },
      function () { return typeof layer.setVisible === "function" && (layer.setVisible(true), "layer.setVisible"); },
      function () { return typeof layer.setVisibility === "function" && (layer.setVisibility(true), "layer.setVisibility"); },
      function () { return typeof layer.set === "function" && (layer.set("visible", true), "layer.set(visible)"); },
      function () { return triggerLayerEvent(win, slide, layer, /show/i); }
    ];
    for (var i = 0; i < tries.length; i += 1) {
      try {
        var via = tries[i]();
        if (via) return { ok: true, via: via };
      } catch (error) {}
    }
    var allow = callAllowlisted(win, ["showLayer", "openLayer", "setSlideLayer", "displayLayer", "showSlideLayer"], [[layer], [id], [layer, "_frame"]]);
    return allow.ok ? allow : { ok: false, error: "The player did not switch that layer on." };
  }

  function hideLayerObject(win, slide, layer) {
    var id = idFrom(layer);
    var tries = [
      function () { return typeof layer.hide === "function" && (layer.hide(), true); },
      function () { return typeof layer.hideLayer === "function" && (layer.hideLayer(), true); },
      function () { return slide && typeof slide.hideLayer === "function" && (slide.hideLayer(layer), true); },
      function () { return slide && typeof slide.hideLayer === "function" && id && (slide.hideLayer(id), true); },
      function () { return typeof layer.setVisible === "function" && (layer.setVisible(false), true); },
      function () { return typeof layer.set === "function" && (layer.set("visible", false), true); },
      function () { return !!triggerLayerEvent(win, slide, layer, /hide|close/i); }
    ];
    for (var i = 0; i < tries.length; i += 1) {
      try { if (tries[i]()) return true; } catch (error) {}
    }
    return false;
  }

  // Last resort: the player's own event bus. Only event names that clearly mean
  // "show (or hide) a layer" are used, and a page reload undoes anything they do.
  function triggerLayerEvent(win, slide, layer, verb) {
    var ds = win.DS;
    if (!ds || !ds.pubSub || typeof ds.pubSub.trigger !== "function" || !ds.events) return "";
    var names = layerEventNames(ds.events).filter(function (name) { return verb.test(name); });
    if (!names.length) return "";
    var argSets = [[layer], [idFrom(layer)], [slide, layer], [layer, slide]];
    for (var n = 0; n < names.length; n += 1) {
      for (var a = 0; a < argSets.length; a += 1) {
        try {
          ds.pubSub.trigger.apply(ds.pubSub, [names[n]].concat(argSets[a]));
          return "event " + names[n];
        } catch (error) {}
      }
    }
    return "";
  }

  function layerEventNames(events) {
    var out = [];
    function scan(obj, depth) {
      if (!obj || typeof obj !== "object" || depth > 2) return;
      safeKeys(obj).forEach(function (key) {
        var value = readKey(obj, key);
        if (typeof value === "string") {
          if (/layer/i.test(key + " " + value)) out.push(value);
        } else if (value && typeof value === "object" && /layer/i.test(key)) {
          scan(value, depth + 1);
        } else if (value && typeof value === "object" && depth === 0) {
          scan(value, depth + 1);
        }
      });
    }
    scan(events, 0);
    return out.filter(function (name, index) { return out.indexOf(name) === index; });
  }

  // Diagnostics the reviewer can copy when a course does not respond. Names only, no values.
  function describeSlide(win) {
    var slide = currentSlideObject(win);
    var ds = win.DS || {};
    function shape(obj) {
      if (!obj || typeof obj !== "object") return null;
      var proto = null;
      try { proto = Object.getPrototypeOf(obj); } catch (error) {}
      var methods = [];
      try {
        if (proto && proto !== Object.prototype) {
          methods = Object.getOwnPropertyNames(proto).filter(function (name) {
            try { return typeof obj[name] === "function"; } catch (error) { return false; }
          });
        }
      } catch (error) {}
      return {
        id: idFrom(obj),
        title: layerTitle(obj) || (obj === slide ? slideTitle(obj) : ""),
        keys: safeKeys(obj).slice(0, 80),
        methods: methods.slice(0, 120)
      };
    }
    var layers = layerModels(slide);
    return {
      href: safeHref(win),
      slide: shape(slide),
      layers: layers.slice(0, 12).map(shape),
      layerSource: layers.length ? "found" : "none",
      dsKeys: safeKeys(ds).slice(0, 80),
      windowManager: shape(ds.windowManager),
      presentationMethods: shape(ds.presentation) ? shape(ds.presentation).methods : [],
      layerEvents: ds.events ? layerEventNames(ds.events) : [],
      hasPubSub: !!(ds.pubSub && typeof ds.pubSub.trigger === "function")
    };
  }

  // Alt text as the author typed it, read from the slide's own data. This covers objects
  // whose alt text the page never writes onto the element (images drawn inside SVG, for example).
  function readSlideObjects(win) {
    var slide = currentSlideObject(win);
    var rows = [];
    var seen = {};
    if (!slide) return rows;
    var containers = [slide].concat(layerModels(slide));
    function visit(obj, layer, depth) {
      if (!obj || typeof obj !== "object" || depth > 6 || rows.length >= 400) return;
      var id = idFrom(obj);
      if (id && !seen[id]) {
        seen[id] = 1;
        rows.push({
          id: id,
          alt: accTextOf(obj),
          kind: accKindOf(obj),
          layer: layer,
          objectKind: String(modelValue(obj, "kind") || "").toLowerCase(),
          accType: String(modelValue(obj, "accType") || "").toLowerCase(),
          // Unticking "Object is visible to accessibility tools" publishes as tabEnabled: false.
          readerVisible: modelValue(obj, "tabEnabled") !== false,
          hasPicture: collectionToArray(modelValue(obj, "imagelib")).length > 0
        });
      }
      childObjects(obj).forEach(function (child) { visit(child, layer, depth + 1); });
    }
    containers.forEach(function (container) {
      var layer = container === slide ? "" : layerTitle(container);
      childObjects(container).forEach(function (obj) { visit(obj, layer, 0); });
    });
    return rows;
  }

  // The published player keeps a layer's or group's objects in attributes.objects.
  function childObjects(obj) {
    var keys = ["slideObjects", "objects", "getSlideObjects", "slideObjectList", "children", "getChildren"];
    var sources = [obj, readKey(obj, "attributes")];
    for (var s = 0; s < sources.length; s += 1) {
      var source = sources[s];
      if (!source || typeof source !== "object") continue;
      for (var i = 0; i < keys.length; i += 1) {
        var value = readKey(source, keys[i]);
        if (typeof value === "function") {
          try { value = value.call(source); } catch (error) { continue; }
        }
        var list = collectionToArray(value);
        if (list.length) return list;
      }
    }
    return [];
  }

  function accTextOf(obj) {
    var keys = ["accText", "altText", "alt", "accessibilityText"];
    var sources = [obj, readKey(obj, "attributes")];
    for (var s = 0; s < sources.length; s += 1) {
      if (!sources[s] || typeof sources[s] !== "object") continue;
      for (var i = 0; i < keys.length; i += 1) {
        var value = readKey(sources[s], keys[i]);
        if (typeof value === "string" && value.trim()) return cleanAlt(value);
      }
    }
    if (typeof obj.get === "function") {
      for (var g = 0; g < keys.length; g += 1) {
        try {
          var got = obj.get(keys[g]);
          if (typeof got === "string" && got.trim()) return cleanAlt(got);
        } catch (error) {}
      }
    }
    // Where the published slide data keeps it: attributes.data.vectorData.altText.
    var data = modelValue(obj, "data");
    var vector = data && typeof data === "object" ? readKey(data, "vectorData") : null;
    var vectorAlt = vector && typeof vector === "object" ? readKey(vector, "altText") : "";
    if (typeof vectorAlt === "string" && vectorAlt.trim()) return cleanAlt(vectorAlt);
    return "";
  }

  // Storyline loads every caption file when the course starts and keeps the cues in
  // DS.captionsManager, keyed by media asset id. Each layer lists its audio and video
  // by asset id, so the slide's captions are read without playing it.
  function readCaptions(win) {
    try {
      var manager = win && win.DS && win.DS.captionsManager;
      if (!manager || typeof manager.getCaptions !== "function") return { available: false, groups: [] };
      var slide = currentSlideObject(win);
      var groups = [];
      var seen = {};
      layerModels(slide).forEach(function (layer, index) {
        var base = index === 0 || modelValue(layer, "isBaseLayer") === true || isBaseLayerModel(layer, slide);
        var title = base ? "Base layer" : (layerTitle(layer) || "Layer " + (index + 1));
        mediaAssets(layer).forEach(function (media) {
          if (seen[media.assetId]) return;
          var cues = [];
          try { cues = collectionToArray(manager.getCaptions(media.assetId)); } catch (error) {}
          var lines = cues.map(cueLine).filter(function (line) { return line.text; });
          if (!lines.length) return;
          seen[media.assetId] = 1;
          groups.push({ layer: title, media: media.kind, lines: lines.slice(0, 500) });
        });
      });
      return { available: true, groups: groups };
    } catch (error) {
      return { available: false, groups: [], error: message(error) };
    }
  }

  // Audio sits in a layer's audiolib; video and audio objects carry their own assetId.
  // Only the layer's own objects are followed, never its siblings.
  function mediaAssets(container) {
    var found = [];
    var seen = {};
    // audiolib is a collection of models, so entries are read like any other model.
    function add(entry, kindHint) {
      var assetId = modelValue(entry, "assetId");
      if ((typeof assetId !== "number" && typeof assetId !== "string") || assetId === "" || seen[assetId]) return;
      seen[assetId] = 1;
      var kind = String(modelValue(entry, "kind") || kindHint || "");
      found.push({ assetId: assetId, kind: /video/i.test(kind) ? "video" : "audio" });
    }
    function visit(obj, depth) {
      if (!obj || typeof obj !== "object" || depth > 8 || found.length > 100) return;
      ["audiolib", "videolib"].forEach(function (key) {
        collectionToArray(modelValue(obj, key)).forEach(function (entry) {
          add(entry, key === "videolib" ? "video" : "audio");
        });
      });
      if (modelValue(obj, "assetId") != null) add(obj, modelValue(obj, "kind"));
      childObjects(obj).forEach(function (child) { visit(child, depth + 1); });
    }
    visit(container, 0);
    return found;
  }

  // Player cues are VTTCue-like (startTime in seconds, text in text.cueSource);
  // transcript sidecars use { start: milliseconds, text }.
  function cueLine(cue) {
    var text = readKey(cue, "text");
    if (text && typeof text === "object") {
      text = readKey(text, "cueSource") || readKey(text, "processedCue") || readKey(text, "0") || "";
    }
    var start = Number(readKey(cue, "startTime"));
    var end = Number(readKey(cue, "endTime"));
    if (!Number.isFinite(start) && Number.isFinite(Number(readKey(cue, "start")))) start = Number(readKey(cue, "start")) / 1000;
    if (!Number.isFinite(end) && Number.isFinite(Number(readKey(cue, "end")))) end = Number(readKey(cue, "end")) / 1000;
    return {
      start: Number.isFinite(start) ? Math.round(start * 1000) / 1000 : null,
      end: Number.isFinite(end) ? Math.round(end * 1000) / 1000 : null,
      text: cleanAlt(typeof text === "string" ? text : "")
    };
  }

  function accKindOf(obj) {
    var keys = ["accType", "kind", "type"];
    var sources = [obj, readKey(obj, "attributes")];
    for (var s = 0; s < sources.length; s += 1) {
      if (!sources[s] || typeof sources[s] !== "object") continue;
      for (var i = 0; i < keys.length; i += 1) {
        var value = readKey(sources[s], keys[i]);
        if (typeof value === "string" && value.trim()) return value.trim().toLowerCase().slice(0, 40);
      }
    }
    return "";
  }

  function cleanAlt(value) {
    return String(value).replace(/<[^>]+>/g, " ").replace(/[\uE000-\uF8FF\uFFF0-\uFFFF]/g, "").replace(/\s+/g, " ").trim().slice(0, 2000);
  }

  function readStates(slide, win) {
    var rows = [];
    var seen = {};
    if (!slide) return rows;
    walk(slide, function (obj) {
      var states = readKey(obj, "states");
      if (!Array.isArray(states)) states = readKey(obj, "stateList");
      if (!Array.isArray(states) || !states.length) return;
      var id = idFrom(obj);
      if (!id || seen[id]) return;
      var names = states.map(function (state) {
        if (typeof state === "string") return state;
        if (!state || typeof state !== "object") return "";
        return state.name || state.title || state.id || "";
      }).filter(function (name) { return typeof name === "string" && name.trim(); }).slice(0, 20);
      if (!names.length) return;
      seen[id] = 1;
      var current = readKey(obj, "currentState");
      if (typeof current !== "string") current = readKey(obj, "applied") || "";
      rows.push({
        id: id,
        label: labelOf(obj) || id,
        states: names,
        current: typeof current === "string" ? current : ""
      });
    }, 6, new Set(), { count: 0, max: 800, win: win }, []);
    return rows.slice(0, 40);
  }

  function readTriggers(slide, win) {
    var rows = [];
    var seen = {};
    if (!slide) return rows;
    walk(slide, function (obj) {
      if (!obj || Array.isArray(obj)) return;
      var kind = String(readKey(obj, "kind") || readKey(obj, "type") || readKey(obj, "triggerType") || "").toLowerCase();
      var eventName = readKey(obj, "event");
      if (typeof eventName !== "string") eventName = readKey(obj, "eventName");
      if (typeof eventName !== "string") eventName = readKey(obj, "on");
      var action = readKey(obj, "action");
      if (action == null) action = readKey(obj, "actionName");
      var actionText = typeof action === "string" ? action : (action && typeof action === "object" ? (action.type || action.name || "") : "");
      if (kind.indexOf("trigger") === -1 && !(typeof eventName === "string" && actionText)) return;
      var label = labelOf(obj) || [eventName, actionText].filter(Boolean).join(" → ");
      if (!label || seen[label]) return;
      seen[label] = 1;
      rows.push({ label: String(label).slice(0, 180) });
    }, 6, new Set(), { count: 0, max: 800, win: win }, []);
    return rows.slice(0, 40);
  }

  function readPlayback(slide, quiz) {
    var knowledge = !!(quiz && ((quiz.targets && quiz.targets.length) || (quiz.notes && quiz.notes.length)));
    return {
      knowledgeCheck: knowledge,
      durationMs: readDurationMs(slide),
      reason: knowledge ? "This slide has question answers in the published player." : ""
    };
  }

  function readDurationMs(slide) {
    if (!slide || typeof slide !== "object") return null;
    var timeline = readKey(slide, "timeline");
    var attributes = readKey(slide, "attributes");
    var raw = firstTimingNumber([
      readKey(slide, "duration"),
      timeline && readKey(timeline, "duration"),
      readKey(slide, "timelineDuration"),
      attributes && readKey(attributes, "duration"),
      attributes && readKey(attributes, "timelineDuration")
    ]);
    if (raw == null) return null;
    var ms = raw >= 100 ? raw : raw * 1000;
    if (ms < 200 || ms > 20 * 60 * 1000) return null;
    return Math.round(ms);
  }

  function firstTimingNumber(values) {
    for (var i = 0; i < values.length; i += 1) {
      var value = values[i];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

  // The published player keeps every slide's notes in DS.frameModel.frame.notesData,
  // one HTML entry per slide keyed "sceneId.slideId". Older data keeps them on the slide.
  function readSlideNotes(win) {
    try {
      var slide = currentSlideObject(win);
      var frame = win && win.DS && win.DS.frameModel ? readKey(win.DS.frameModel, "frame") : null;
      var list = frame && typeof frame === "object" ? collectionToArray(readKey(frame, "notesData")) : [];
      if (!slide) return { available: list.length > 0, text: "" };
      var id = idFrom(slide);
      var fullId = String(modelValue(slide, "fullId") || "");
      var match = list.filter(function (entry) {
        var key = String(readKey(entry, "slideId") || "");
        return !!key && (key === fullId || key === id || (!!id && key.slice(-(id.length + 1)) === "." + id));
      })[0];
      if (match) return { available: true, text: notesText(readKey(match, "content")) };
      var plain = readNotes(slide);
      return { available: list.length > 0 || !!plain, text: plain ? notesText(plain) : "" };
    } catch (error) {
      return { available: false, text: "", error: message(error) };
    }
  }

  // Notes are styled HTML paragraphs. Keep one line per paragraph and drop the styling.
  function notesText(html) {
    var text = String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\u2022 ")
      .replace(/<[^>]+>/g, "");
    text = decodeEntities(text).replace(/[\ue000-\uf8ff\ufff0-\uffff]/g, "");
    return text.split("\n").map(function (line) {
      return line.replace(/[ \t\u00a0]+/g, " ").trim();
    }).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000);
  }

  function decodeEntities(text) {
    var named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026" };
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, code) {
      if (code.charAt(0) === "#") {
        var n = code.charAt(1).toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      var key = code.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : all;
    });
  }

  function readNotes(slide) {
    if (!slide) return "";
    var sources = [slide, slide.attributes];
    var keys = ["notes", "speakerNotes", "slideNotes", "narrationNotes"];
    for (var s = 0; s < sources.length; s += 1) {
      if (!sources[s]) continue;
      for (var k = 0; k < keys.length; k += 1) {
        var value = readKey(sources[s], keys[k]);
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 2000);
      }
    }
    return "";
  }

  function readNavigation(win) {
    var presentation = win.DS && win.DS.presentation;
    var holders = [presentation && presentation.navigation, presentation && presentation.menu, presentation];
    var flow = "";
    holders.forEach(function (holder) {
      if (flow || !holder) return;
      ["flow", "menuFlow", "navigationMode", "navMode"].forEach(function (key) {
        if (flow) return;
        var value = readKey(holder, key);
        if (typeof value === "string" && value.trim()) flow = value.trim();
      });
    });
    return { flow: flow || "unknown" };
  }

  function findLayerObject(slide, layerId) {
    if (!slide || !layerId) return null;
    var match = null;
    layerModels(slide).forEach(function (item) {
      if (!match && idFrom(item) === layerId) match = item;
    });
    return match;
  }

  function findById(root, objectId, win) {
    var match = null;
    walk(root, function (obj) {
      if (match) return;
      if (idFrom(obj) === objectId) match = obj;
    }, 7, new Set(), { count: 0, max: 1500, win: win }, []);
    return match;
  }

  function playerHosts(win) {
    var player = safePlayer(win);
    var slide = currentSlideObject(win);
    return [
      player,
      win.DS && win.DS.windowManager,
      win.DS && win.DS.presentation,
      slide,
      slide && slide.timeline,
      player && player.timeline
    ];
  }

  function findMethod(win, names) {
    var hosts = playerHosts(win);
    for (var h = 0; h < hosts.length; h += 1) {
      var host = hosts[h];
      if (!host || typeof host !== "object") continue;
      for (var n = 0; n < names.length; n += 1) {
        try {
          if (typeof host[names[n]] === "function") return { host: host, name: names[n] };
        } catch (error) {}
      }
    }
    return null;
  }

  function callAllowlisted(win, names, argSets) {
    var found = findMethod(win, names);
    if (!found) return { ok: false, error: "This player does not expose that control." };
    var last = "The player rejected that call.";
    var sets = argSets && argSets.length ? argSets : [[]];
    for (var i = 0; i < sets.length; i += 1) {
      try {
        found.host[found.name].apply(found.host, sets[i]);
        return { ok: true, via: found.name };
      } catch (error) {
        last = message(error);
      }
    }
    return { ok: false, error: last };
  }

  function message(error) {
    if (error && error.message) return String(error.message);
    return "The player call failed.";
  }

  root.__lsiAltTextInspectorCore = {
    inspect: inspect,
    readVariable: readVariable,
    jump: jump,
    describeSlide: describeSlide,
    readSlideObjects: readSlideObjects,
    readCaptions: readCaptions,
    readSlideNotes: readSlideNotes,
    resetCurrentSlide: resetCurrentSlide,
    goNext: goNext,
    pickBest: pickBest
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

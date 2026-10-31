(function () {
  var core = globalThis.__lsiAltTextInspectorCore;
  var failures = [];

  function assert(condition, label) {
    if (!condition) failures.push(label);
  }

  function makeCourse() {
    var vars = {
      PlayerName: "Ada",
      Score: 1,
      Passed: false,
      "Results.PassPercent": 80,
      "Results.ScorePercent": 10,
      "_playerVars.#menuProgress": 25
    };
    var scene = { title: "Start" };
    var slides = [
      { id: "slide1", title: "Welcome", scene: scene, viewed: false },
      { id: "slide2", title: "Check", scene: scene, viewed: false }
    ];
    slides[1].quiz = {
      passPercent: 80,
      scorePercent: 10,
      choices: [
        { id: "choiceWrong", lmstext: "No", correct: false },
        { id: "choiceRight", lmstext: "Yes", correct: true }
      ],
      numeric: { correctValue: 42, acceptableAnswers: ["42", "forty-two"] }
    };
    var current = slides[1];
    var jumped = null;
    var win = {
      location: { origin: "https://lms.example", pathname: "/course/story.html", search: "?token=secret" },
      payroll: { name: "Salary", type: "number", value: 999999 },
      DS: {
        presentation: {
          title: "Safety course",
          navigation: { flow: "restricted" },
          variables: [
            { name: "PlayerName", type: "string", value: "" },
            { name: "Score", type: "number", value: 0 },
            { name: "Passed", type: "boolean", value: false },
            { name: "Results.PassPercent", type: "number", value: 80 },
            { name: "Results.ScorePercent", type: "number", value: 10 }
          ],
          getFlatSlides: function () { return slides; }
        },
        windowManager: {
          getCurrentWindowSlide: function () { return current; },
          requestSlideForReview: function (slide) {
            jumped = slide;
            current = slide;
          }
        }
      },
      getVar: function (name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
      },
      setVar: function (name, value) { vars[name] = value; },
      GetPlayer: function () {
        return {
          GetVar: function (name) { return win.getVar(name); },
          SetVar: function (name, value) { win.setVar(name, value); }
        };
      }
    };
    return { win: win, vars: vars, slides: slides, get jumped() { return jumped; } };
  }

  var course = makeCourse();
  var report = core.inspect(course.win);
  var names = report.variables.map(function (item) { return item.name; });
  var byName = {};
  report.variables.forEach(function (item) { byName[item.name] = item; });

  assert(report.found === true, "course is found");
  assert(report.href === "https://lms.example/course/story.html", "query string is left out of the page address");
  assert(names.indexOf("Salary") === -1, "values outside the player are ignored");
  assert(byName.PlayerName.value === "Ada" && byName.PlayerName.live === true, "live variable replaces the published default");
  assert(byName.Score.value === 1 && byName.Score.type === "number", "number type comes from the live value");
  assert(byName.Passed.type === "boolean", "boolean type is kept");
  assert(byName["Menu.Progress"].value === 25, "documented player alias is read");
  assert(report.slides.length === 2, "both slides are listed");
  assert(report.slides[1].current === true && report.slides[1].title === "Check", "current slide is the quiz");
  assert(report.slides[0].scene === "Start", "scene name is kept");
  assert(report.slides[0].number === "1.1" && report.slides[1].number === "1.2", "slides get scene.slide numbers");
  assert(report.slides[1].question === true && report.slides[0].question === false, "question slides are flagged");
  assert(report.questionBank[0].number === "1.2" && report.questionBank[0].current === true, "question bank rows carry number and current");
  assert(report.questionState && report.questionState.answered === false, "an untouched question reads as not answered");
  assert(report.correctTargets.some(function (item) { return item.id === "choiceRight" && item.label === "Yes"; }), "correct choice is listed");
  assert(!report.correctTargets.some(function (item) { return item.id === "choiceWrong"; }), "wrong choice is not listed");
  assert(report.quizNotes.indexOf("Correct value: 42") !== -1, "numeric answer is listed");
  assert(report.quizNotes.indexOf("Accepted answers: 42, forty-two") !== -1, "accepted text answers are listed");
  assert(report.passingScores.some(function (item) { return item.where === "Results.PassPercent" && item.value === 80; }), "pass percent variable is listed");
  assert(!report.passingScores.some(function (item) { return String(item.where).indexOf("scorePercent") !== -1; }), "current score is not treated as the passing score");

  assert(typeof core.setVariable !== "function", "variable editing is not available");
  assert(typeof core.setVariable !== "function", "variable editing is not available");
  assert(typeof core.unlock !== "function", "unlocking the presentation is not available");
  assert(typeof core.showFeedback !== "function", "forcing feedback states is not available");
  assert(typeof core.zeroPassingScores !== "function", "changing the passing score is not available");
  assert(typeof core.markQuizzesPassed !== "function", "marking a quiz passed is not available");
  assert(typeof core.setObjectState !== "function", "changing object states is not available");
  assert(course.vars.Score === 1, "reading the course leaves the score unchanged");
  assert(course.win.DS.presentation.navigation.flow === "restricted", "the menu lock stays as published");
  assert(course.slides[1].quiz.passPercent === 80, "the passing score stays as published");

  var jumpResult = core.jump(course.win, "slide1");
  assert(jumpResult.ok === true && jumpResult.via === "requestSlideForReview", "jump uses the review request");
  assert(course.jumped && course.jumped.id === "slide1", "jump receives the live slide");

  var preferred = makeCourse();
  var usedJump = "";
  preferred.win.GetPlayer = function () {
    return {
      GetVar: preferred.win.getVar,
      SetVar: preferred.win.setVar,
      JumpToSlide: function (id) { usedJump = id; }
    };
  };
  var preferredJump = core.jump(preferred.win, "slide2");
  assert(preferredJump.via === "JumpToSlide" && usedJump === "slide2", "JumpToSlide is used when the player has it");

  var preview = makeCourse();
  preview.slides[1].slideLayers = [
    { id: "layerOk", title: "Correct", show: function () {}, hide: function () {} },
    { id: "layerNo", title: "Incorrect", show: function () {}, hide: function () {} }
  ];
  var feedbackReport = core.inspect(preview.win);
  assert(feedbackReport.feedback.some(function (layer) { return layer.kind === "correct" && layer.title === "Correct"; }), "correct feedback layer is listed");
  assert(feedbackReport.feedback.some(function (layer) { return layer.kind === "incorrect"; }), "incorrect feedback layer is listed");

  // Modern player shape: slideLayers() returns a collection of models with get("title").
  var modern = makeCourse();
  function model(id, title) {
    return { id: id, attributes: { title: title }, get: function (key) { return this.attributes[key]; }, isBaseLayer: function () { return title === "Base"; } };
  }
  var modernLayers = { models: [model("base", "Base"), model("fbOk", "Correct"), model("fbNo", "Incorrect")], length: 3 };
  delete modern.slides[1].slideLayers;
  modern.slides[1].slideLayers = function () { return modernLayers; };
  var modernReport = core.inspect(modern.win);
  assert(modernReport.layers.length === 2 && modernReport.layers.every(function (l) { return l.title !== "Base"; }), "collection-style layers are listed without the base layer");
  assert(modernReport.feedback.some(function (l) { return l.kind === "incorrect" && l.id === "fbNo"; }), "collection-style feedback layers are recognized");
  var described = core.describeSlide(modern.win);
  assert(described.layerSource === "found" && described.layers.length === 3 && described.slide.id === "slide2", "describeSlide reports slide and layer shapes");
  assert(JSON.stringify(described).indexOf("Ada") === -1, "diagnostics carry names only, not learner values");
  modernLayers.models[0].attributes.slideObjects = {
    models: [
      { id: "pic1", attributes: { accText: "<p>Smiling nurse</p>", accType: "image" }, get: function (k) { return this.attributes[k]; } },
      { id: "grp1", attributes: {}, get: function (k) { return this.attributes[k]; }, children: [{ id: "pic2", accText: "Hospital entrance" }] }
    ],
    length: 2
  };
  modernLayers.models[0].slideObjects = function () { return this.attributes.slideObjects; };
  var objects = core.readSlideObjects(modern.win);
  var objById = {};
  objects.forEach(function (o) { objById[o.id] = o; });
  assert(objById.pic1 && objById.pic1.alt === "Smiling nurse" && objById.pic1.kind === "image", "readSlideObjects reads acc text from models and strips tags");
  assert(objById.pic2 && objById.pic2.alt === "Hospital entrance" && objById.pic2.layer === "Base", "readSlideObjects reaches objects nested in groups");

  var resetCourse = makeCourse();
  var hidden = false;
  resetCourse.slides[1].answered = true;
  resetCourse.slides[1].quiz.submitted = true;
  resetCourse.slides[1].quiz.choices[1].correct = true;
  resetCourse.slides[1].slideLayers = [
    { id: "layerOk", title: "Correct", hide: function () { hidden = true; } }
  ];
  resetCourse.vars["Question.Correct"] = true;
  var resetResult = core.resetCurrentSlide(resetCourse.win);
  assert(resetResult.ok === true, "the current slide can be reset");
  assert(resetCourse.slides[1].answered === false, "the question is unanswered after reset");
  assert(resetCourse.slides[1].quiz.submitted === false, "the question is no longer submitted");
  assert(resetCourse.slides[1].quiz.choices[1].correct === true, "the answer key stays intact");
  assert(hidden === true, "open feedback is hidden on reset");
  assert(resetCourse.vars.Score === 1, "the course score is left alone");
  assert(resetCourse.vars["Question.Correct"] === false, "the current question correct flag is cleared");

  var modernReset = makeCourse();
  var modernResetLog = [];
  delete modernReset.slides[1].slideLayers;
  modernReset.slides[1].slideLayers = function () { return modernLayers; };
  modernReset.slides[1].hideLayer = function (layer) { modernResetLog.push(layer.id || layer); };
  assert(core.resetCurrentSlide(modernReset.win).ok === true, "a modern-player slide can be reset");
  assert(modernResetLog.indexOf("fbOk") !== -1 && modernResetLog.indexOf("fbNo") !== -1 && modernResetLog.indexOf("base") === -1, "reset hides feedback layers through slide.hideLayer and leaves the base layer");

  var radioCourse = makeCourse();
  radioCourse.slides[1].attributes = { isSubmitted: true, status: "submitted" };
  radioCourse.slides[1].get = function (key) { return this.attributes[key]; };
  radioCourse.slides[1].set = function (key, value) { this.attributes[key] = value; };
  radioCourse.slides[1].resume = function () { return true; };
  var interaction = { responses: ["choiceRight"], full: false };
  interaction.resetResume = function (full) { this.full = full; this.responses = []; };
  radioCourse.slides[1].interactions = function () { return [interaction]; };
  interaction.choices = function () {
    return [{ id: "choice_choiceRight" }];
  };
  var choiceObject = {
    id: "choiceRight",
    stateName: "_default_Selected_Disabled",
    enabled: false,
    prop: function (key, value) {
      if (arguments.length < 2) return key === "ObjectState" ? this.stateName : this.enabled;
      if (key === "ObjectState") this.stateName = value;
      if (key === "Enabled") this.enabled = value;
      return value;
    }
  };
  radioCourse.slides[1].slideObjects = [choiceObject];
  radioCourse.slides[1].clearResumeData = function () { this.clearedResume = true; };
  var lockedChoice = radioCourse.slides[1].quiz.choices[1];
  lockedChoice.currentState = "Disabled";
  lockedChoice.setState = function (name) { this.currentState = name; };
  var slideResetCalls = 0;
  var resetOrder = [];
  interaction.resetResume = function (full) {
    this.full = full;
    this.responses = [];
    resetOrder.push("interaction");
  };
  radioCourse.slides[1].reset = function () {
    slideResetCalls += 1;
    resetOrder.push("slide");
  };
  assert(core.resetCurrentSlide(radioCourse.win).ok === true, "a submitted question can be reset");
  assert(radioCourse.slides[1].get("isSubmitted") === false, "isSubmitted is cleared through set/get so the question is unanswered");
  assert(interaction.full === true && interaction.responses.length === 0, "the saved radio answer is cleared even when the slide resumes it");
  assert(choiceObject.stateName === "_default" && choiceObject.enabled === true, "a reviewed choice returns to its plain state and can be clicked");
  assert(slideResetCalls === 1 && radioCourse.slides[1].clearedResume === true, "the slide is replayed from the start after the saved answer is dropped");
  assert(resetOrder.indexOf("interaction") !== -1 && resetOrder.indexOf("interaction") < resetOrder.indexOf("slide"), "the answer is cleared before the slide replays");
  assert(lockedChoice.currentState === "Normal", "a disabled choice is returned to Normal so it can be selected");
  assert(radioCourse.jumped == null, "reset does not reopen the slide in review, which would restore the selection");

  var stateCourse = makeCourse();
  stateCourse.slides[1].quiz.choices[1].states = [{ name: "Normal" }, { name: "Selected" }];
  stateCourse.slides[1].quiz.choices[1].currentState = "Normal";
  var stateReport = core.inspect(stateCourse.win);
  assert(stateReport.states.some(function (item) {
    return item.id === "choiceRight" && item.states.indexOf("Selected") !== -1 && item.current === "Normal";
  }), "knowledge check states are listed");
  assert(stateCourse.vars.Score === 1, "listing states does not change the course");

  var dictWin = {
    GetPlayer: function () { return { GetVar: function () { return undefined; }, SetVar: function () {} }; },
    DS: { presentation: { title: "Dict", variables: { City: { type: "string", value: "Paris" } } } }
  };
  var dictReport = core.inspect(dictWin);
  assert(dictReport.variables.some(function (item) { return item.name === "City" && item.value === "Paris"; }), "dictionary variables are read");

  var empty = core.inspect({});
  assert(empty.found === false, "a normal page is ignored");

  var best = core.pickBest([
    { found: false, loading: true },
    { found: true, slides: [{ id: "a" }], variables: [{ name: "One" }] },
    { found: true, slides: [], variables: [{ name: "Only" }] }
  ]);
  assert(best.slides.length === 1, "the frame with the slide list wins");

  var reviewShell = core.pickBest([{ found: false, reviewPage: true, href: "https://360.articulate.com/review/content/abc/review" }]);
  assert(reviewShell.found === false && reviewShell.reviewPage === true, "a Review 360 page is recognized before the course starts");
  var reviewCourse = core.pickBest([
    { found: false, reviewPage: true },
    { found: true, slides: [{ id: "a" }], variables: [{ name: "One" }] }
  ]);
  assert(reviewCourse.found === true && reviewCourse.reviewPage === true, "the course frame is used inside Review 360");

  var loading = core.pickBest([{ found: false, loading: true, href: "https://lms.example/story.html" }]);
  assert(loading.loading === true, "a loading frame is reported when no player exists yet");

  var quizPlayback = core.inspect(makeCourse().win).playback;
  assert(quizPlayback.knowledgeCheck === true, "a question slide is a knowledge check");
  var timed = makeCourse();
  timed.slides[0].duration = 8000;
  timed.win.DS.windowManager.getCurrentWindowSlide = function () { return timed.slides[0]; };
  var timedPlayback = core.inspect(timed.win).playback;
  assert(timedPlayback.knowledgeCheck === false, "a normal slide is not a knowledge check");
  assert(timedPlayback.durationMs === 8000, "slide length is read in milliseconds");
  timed.slides[0].duration = 12;
  assert(core.inspect(timed.win).playback.durationMs === 12000, "a short duration is treated as seconds");

  // Published-player shape: every attribute also has an accessor method, a layer's
  // objects sit in attributes.objects, alt text in data.vectorData.altText, and
  // captions come from DS.captionsManager keyed by the layer's audio asset id.
  var real = makeCourse();
  function accessorModel(attrs) {
    var m = { id: attrs.id, attributes: attrs, get: function (k) { return this.attributes[k]; } };
    Object.keys(attrs).forEach(function (k) {
      if (!(k in m)) m[k] = function () { return attrs[k]; };
    });
    return m;
  }
  var picture = accessorModel({ id: "picA", kind: "vectorshape", accType: "image", tabEnabled: true, imagelib: [{}], data: { vectorData: { altText: "Smiling nurse" } } });
  var decoPicture = accessorModel({ id: "picB", kind: "vectorshape", accType: "image", tabEnabled: false, imagelib: [{}], data: { vectorData: { altText: "Picture 4.png" } } });
  var submit = accessorModel({ id: "btnA", kind: "vectorshape", accType: "button", tabEnabled: true, data: { vectorData: { altText: "Submit" } } });
  var audio = { models: [accessorModel({ kind: "audio", assetId: 5, id: "aud1" })], length: 1 };
  var realBase = accessorModel({ isBaseLayer: true, audiolib: audio, objects: { models: [picture, decoPicture, submit], length: 3 } });
  real.slides[1].slideLayers = function () { return { models: [realBase], length: 1 }; };
  real.win.DS.captionsManager = {
    getCaptions: function (id) {
      if (id !== 5) return undefined;
      return [
        { startTime: 0.15, endTime: 4.6, text: { cueSource: "Welcome to the course" } },
        { startTime: 4.7, endTime: 9, text: { cueSource: "<i>Let's begin.</i>" } }
      ];
    }
  };
  var realRows = {};
  core.readSlideObjects(real.win).forEach(function (row) { realRows[row.id] = row; });
  assert(realRows.picA && realRows.picA.alt === "Smiling nurse" && realRows.picA.accType === "image" && realRows.picA.hasPicture, "published-player objects are read from attributes, with alt text from vectorData");
  assert(realRows.picA && realRows.picA.objectKind === "vectorshape", "an accessor method is not mistaken for the attribute's value");
  assert(realRows.picB && realRows.picB.readerVisible === false, "an object with tabEnabled off is hidden from screen readers");
  assert(realRows.btnA && realRows.btnA.accType === "button" && realRows.btnA.alt === "Submit", "a button's accessibility type and label are read");
  var captions = core.readCaptions(real.win);
  assert(captions.available === true && captions.groups.length === 1 && captions.groups[0].layer === "Base layer", "captions are grouped under the layer whose audio they belong to");
  assert(captions.groups[0] && captions.groups[0].lines.length === 2 && captions.groups[0].lines[0].start === 0.15 && captions.groups[0].lines[1].text === "Let's begin.", "caption lines keep their start time and lose markup");
  assert(core.readCaptions(makeCourse().win).available === false, "a player without a captions manager reports captions as unavailable");

  // Notes live in DS.frameModel.frame.notesData, one HTML entry per slide keyed "sceneId.slideId".
  real.win.DS.frameModel = {
    frame: {
      notesData: [
        { slideId: "scene1.slide1", content: "<p>Not this slide</p>" },
        { slideId: "scene1.slide2", content: "<p style='text-align:left'><span style=\"font-size:16px\">Welcome &amp; hello</span></p><p>Second&nbsp;line</p>" }
      ]
    }
  };
  var notes = core.readSlideNotes(real.win);
  var newline = String.fromCharCode(10);
  assert(notes.available === true && notes.text === "Welcome & hello" + newline + "Second line", "slide notes are read from notesData as plain text, one line per paragraph");
  assert(core.inspect(real.win).notes === notes.text, "slide details show the same notes");
  assert(core.readSlideNotes(makeCourse().win).available === false, "a player without notes data reports notes as unavailable");

  // Some players keep a slide title as a styled HTML paragraph in attributes.title.
  var htmlTitled = makeCourse();
  delete htmlTitled.slides[1].title;
  htmlTitled.slides[1].attributes = { title: "<p dir='ltr' align='left' style=\"font-family: 'Calibri5859E9C5';\">Invalid&nbsp;Answer &amp; retry</p>" };
  var htmlTitleReport = core.inspect(htmlTitled.win);
  assert(htmlTitleReport.slides[1].title === "Invalid Answer & retry", "an HTML slide title is shown as plain text");
  assert(htmlTitleReport.questionBank[0] && htmlTitleReport.questionBank[0].title === "Invalid Answer & retry", "the knowledge-check list shows the plain title too");
  assert(htmlTitleReport.slides[0].title === "Welcome", "a plain slide title is unchanged");

  var read = core.readVariable(course.win, "PlayerName");
  assert(read.ok === true && read.value === "Ada", "a named read returns the live value");

  var output = document.getElementById("out");
  if (failures.length) {
    output.textContent = "FAIL " + failures.length + "\n" + failures.join("\n");
    document.title = "FAIL";
  } else {
    output.textContent = "PASS";
    document.title = "PASS";
  }
})();
"use strict";
// The little bot. Everything on the page can talk to it through setBotState(state, optionalMessage).
// States: "idle" | "checking" | "pass" | "fail" | "cantrun". Taken from your zapple-revised.html design.
(function () {
  const NAME = "Biii";  // used in some greetings; set to "" to leave it out
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const buddy = document.getElementById("bots"), bubble = document.getElementById("bubble"), orb = document.getElementById("orb");
  const MAX_X = 9, MAX_Y = 7;  // how far the eyes can travel, in px
  const DIRS = { center:[0,0], right:[1,0], left:[-1,0], down:[0,1], up:[0,-1],
                 upRight:[1,-1], upLeft:[-1,-1], lowerLeft:[-1,1], lowerRight:[1,1] };
  const hi = NAME ? ", " + NAME : "";
  const LINES = {
    morning:   ["Morning" + hi + ". Fresh code?", "Good morning. Let's catch bugs before lunch.", "Up early. Paste something."],
    afternoon: ["Afternoon. What did the AI write this time?", "Back at it" + hi + "? Paste it in.", "Afternoon check. Hand it over."],
    evening:   ["Evening" + hi + ". One more check?", "Late session? I'm ready.", "Evening. Paste, check, done."],
    night:     ["It's late. Bugs don't sleep either.", "Still up" + hi + "? Same. Paste your code.", "Night shift. Let's go."],
    any:       ["Paste some code. I'll poke at it.", "I trust nothing the AI wrote. Paste it in.", "Ready when you are.", "Eyes open. Systems fine."],
    poke:      ["Hey!", "That tickles.", "Eyes up here.", "Boop.", "Still watching.", "Careful, I'm round."],
    quip:      ["Still here.", "Waiting on code.", "Imports are the usual suspects.", "Tell the AI to double-check its imports.", "Quiet in here."],
    checking:  ["Running it...", "Poking at your code...", "Checking every call...", "Hold on, testing."],
    pass:      ["All clear.", "That one holds up.", "Clean. Paste it back.", "No problems found."],
    fail:      ["Found problems. Check the log.", "Nope. Details in the log.", "Something broke. Look at the log."],
    cantrun:   ["Couldn't test-run this. The log says why.", "Hm. Couldn't run it. See the log."]
  };
  let state = "idle", loopT, speakT, typeT, followUntil = 0, lastDir = "center", step = 0, lastSpoke = 0;
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = v => Math.max(-1, Math.min(1, v));

  function look(x, y) {
    buddy.style.setProperty("--gx", (x * MAX_X).toFixed(2));
    buddy.style.setProperty("--gy", (y * MAX_Y).toFixed(2));
  }
  function blink() { buddy.classList.add("blink"); setTimeout(() => buddy.classList.remove("blink"), 130); }
  (function blinkLoop() {
    if (!document.hidden) { blink(); if (Math.random() < .25) setTimeout(blink, 260); }  // sometimes a double blink
    setTimeout(blinkLoop, rand(2200, 5800));
  })();

  // What the eyes do depends on the state. Returns how long to wait before the next move.
  function behave() {
    if (document.hidden || reduce) return 2000;
    if (state === "idle") {
      if (Date.now() < followUntil) return 600;  // busy following the mouse
      if (Math.random() < .18) {                 // occasional slow sweep across the room
        const path = ["left", "upLeft", "up", "upRight", "right"];
        if (Math.random() < .5) path.reverse();
        path.forEach((k, i) => setTimeout(() => { if (state === "idle" && Date.now() >= followUntil) look(...DIRS[k]); }, i * 380));
        return path.length * 380 + rand(500, 1200);
      }
      let k; do { k = pick(Object.keys(DIRS)); } while (k === lastDir);
      lastDir = k; look(...DIRS[k]);
      return rand(800, 2400);
    }
    if (state === "checking") { const P = [[-1,-.3],[1,-.3],[1,.5],[-1,.5],[0,-.8]]; look(...P[step++ % P.length]); return 420; }
    if (state === "cantrun")  { look(step++ % 2 ? 1 : -1, -.5); return 1100; }
    look(0, state === "fail" ? .6 : 0);
    return 2000;
  }
  function loop() { clearTimeout(loopT); loopT = setTimeout(loop, behave()); }

  // Speech bubble with a typewriter effect
  function say(text, hold) {
    clearInterval(typeT); clearTimeout(speakT);
    bubble.classList.add("show"); bubble.textContent = ""; lastSpoke = Date.now();
    if (reduce) bubble.textContent = text;
    else { let i = 0; typeT = setInterval(() => { bubble.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(typeT); }, 24); }
    speakT = setTimeout(() => bubble.classList.remove("show"), hold || Math.max(3200, text.length * 75 + 2200));
  }

  function greet() {
    const h = new Date().getHours();
    const slot = h < 5 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : h < 23 ? "evening" : "night";
    let visits = 1, last = "";
    try {
      visits = (+localStorage.getItem("zapple-visits") || 0) + 1; localStorage.setItem("zapple-visits", visits);
      last = localStorage.getItem("zapple-last") || "";
    } catch (e) {}
    let pool = LINES[slot].concat(LINES.any);
    if (visits === 1) pool = ["First time here? Paste some code and press Check."];
    else if (Math.random() < .2) pool = ["Visit number " + visits + ". I'm keeping count."];
    let line; do { line = pick(pool); } while (line === last && pool.length > 1);
    try { localStorage.setItem("zapple-last", line); } catch (e) {}
    say(line);
  }

  // Your code calls this: setBotState("checking" | "pass" | "fail" | "cantrun" | "idle", optionalMessage)
  window.setBotState = function (s, msg) {
    state = s; buddy.dataset.state = s; step = 0;
    if (s !== "idle") say(msg || pick(LINES[s]));
    loop();
  };

  // Eyes follow the pointer for a couple of seconds, then go back to wandering
  let raf = 0;
  window.addEventListener("pointermove", e => {
    if (state !== "idle" || reduce || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0; const r = orb.getBoundingClientRect();
      look(clamp((e.clientX - (r.left + r.width / 2)) / 280), clamp((e.clientY - (r.top + r.height / 2)) / 280));
      followUntil = Date.now() + 2600;
    });
  });

  // Back to idle (eyes wander again). Used by the Clear button and by tapping the bot.
  function wakeUp() { if (state !== "idle") window.setBotState("idle"); }

  orb.addEventListener("click", () => {
    wakeUp();  // tapping the bot after a check returns it to idle
    orb.classList.remove("hop"); void orb.offsetWidth; orb.classList.add("hop"); blink(); say(pick(LINES.poke));
  });

  // Clear button: go idle and put the old speech bubble away
  const clearBtn = document.getElementById("clear-button");
  if (clearBtn) clearBtn.addEventListener("click", () => { wakeUp(); bubble.classList.remove("show"); });
  orb.addEventListener("animationend", e => { if (e.animationName === "hop") orb.classList.remove("hop"); });
  setInterval(() => { if (state === "idle" && !document.hidden && Date.now() - lastSpoke > 45000 && Math.random() < .5) say(pick(LINES.quip)); }, 20000);

  // Wake-up: eyes start shut, open, glance right and left, then greet
  buddy.classList.add("blink");
  setTimeout(() => { buddy.classList.remove("blink"); look(1, 0); }, 450);
  setTimeout(() => look(-1, 0), 1100);
  setTimeout(() => { look(0, 0); greet(); }, 1700);
  loopT = setTimeout(loop, 2800);
})();

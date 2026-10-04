// Install-chip copy + reveal-on-scroll + marquee duplication.
// No framework, no build step.
(function () {
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // copyable install command — feedback on the chip itself
  var chip = document.getElementById("install-chip");
  if (chip) {
    chip.addEventListener("click", function () {
      var cmd = document.getElementById("install-cmd").textContent;
      var label = chip.querySelector(".chip-copy");
      var done = function () {
        chip.classList.add("copied");
        label.textContent = "copied";
        setTimeout(function () {
          chip.classList.remove("copied");
          label.textContent = "copy";
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = cmd;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
        done();
      }
    });
  }

  // duplicate the marquee track once so translateX(-50%) loops seamlessly
  var track = document.getElementById("marquee-track");
  if (track && !reduced) {
    track.innerHTML += track.innerHTML;
  }

  if (reduced || !("IntersectionObserver" in window)) {
    return;
  }

  var targets = document.querySelectorAll(
    ".hero-badge, .hero h1, .hero .sub, .cta-row, .hero-shot, .pipeline, .split-copy, .split-shot, .cell, .plat, .deploy"
  );
  targets.forEach(function (el) {
    el.classList.add("reveal");
  });

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  targets.forEach(function (el) {
    io.observe(el);
  });
})();

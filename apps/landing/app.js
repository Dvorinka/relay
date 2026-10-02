// Reveal-on-scroll + marquee duplication. No framework, no build step.
(function () {
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // duplicate the marquee track once so translateX(-50%) loops seamlessly
  var track = document.getElementById("marquee-track");
  if (track && !reduced) {
    track.innerHTML += track.innerHTML;
  }

  if (reduced || !("IntersectionObserver" in window)) {
    return;
  }

  var targets = document.querySelectorAll(
    ".hero-copy, .hero-shot, .pipeline, .split-copy, .split-shot, .cell, .deploy"
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

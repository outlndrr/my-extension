(() => {
  // Runs in the page's MAIN world at document_start, before any site script.
  // ponytail: patches this frame's prototypes only; a page can still read the real state
  // through a pristine Document.prototype from a fresh same-origin iframe, or from element blur events.
  const visible = { hidden: false, webkitHidden: false, visibilityState: "visible", webkitVisibilityState: "visible" };
  for (const [name, value] of Object.entries(visible)) {
    Object.defineProperty(Document.prototype, name, { get: () => value, configurable: true, enumerable: true });
  }
  Document.prototype.hasFocus = () => true;

  // Registered first, so this capture listener runs before any listener the page adds.
  const block = (event) => {
    if (event.target === window || event.target === document) event.stopImmediatePropagation();
  };
  for (const type of ["visibilitychange", "webkitvisibilitychange", "blur", "focus"]) {
    window.addEventListener(type, block, true);
  }
})();

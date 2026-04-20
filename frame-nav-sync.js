(() => {
  if (window.parent === window) return;

  const CHILD_BASE = "/js2wasm";
  const MESSAGE_TYPE = "js2:navigate";

  function normalizeChildPathname(pathname) {
    let path = pathname || "/";
    if (path.startsWith(CHILD_BASE)) {
      path = path.slice(CHILD_BASE.length) || "/";
    }
    if (!path.startsWith("/")) path = `/${path}`;
    return path;
  }

  function postRoute() {
    const payload = {
      type: MESSAGE_TYPE,
      pathname: normalizeChildPathname(location.pathname),
      search: location.search || "",
      hash: location.hash || "",
      title: document.title || "",
      href: location.href,
    };

    window.parent.postMessage(payload, "*");
  }

  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    const result = originalPushState(...args);
    postRoute();
    return result;
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    const result = originalReplaceState(...args);
    postRoute();
    return result;
  };

  window.addEventListener("hashchange", postRoute);
  window.addEventListener("popstate", postRoute);
  window.addEventListener("pageshow", postRoute);
  document.addEventListener("DOMContentLoaded", postRoute);
  postRoute();
})();

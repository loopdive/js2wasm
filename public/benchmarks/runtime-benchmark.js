const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const sandboxRoot = document.getElementById("sandbox-root");
const MANIFEST_URL = "./results/loadtime-benchmarks.json";
const WARM_CALLS = 80;
const WARMUP_ROUNDS = 2;
const MEASURED_ROUNDS = 9;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function timeIt(fn, iterations) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return performance.now() - t0;
}

function calibrate(fn) {
  let iterations = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 100) {
    fn();
    iterations++;
  }
  return Math.max(10, Math.ceil((iterations / 100) * 300));
}

function snapshotSandboxState() {
  return {
    sandboxHtml: sandboxRoot?.innerHTML ?? "",
    bodyBackground: document.body.style.background,
    bodyColor: document.body.style.color,
  };
}

function restoreSandboxState(state) {
  if (sandboxRoot) sandboxRoot.innerHTML = state.sandboxHtml;
  document.body.style.background = state.bodyBackground;
  document.body.style.color = state.bodyColor;
}

async function importFreshModule(url) {
  const bust = `${url}${url.includes("?") ? "&" : "?"}runtime=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return import(/* @vite-ignore */ bust);
}

async function measureEntry(entry, runtimeHelpers, manifestUrl) {
  const exportName = entry.exportName || `bench_${entry.name}`;
  const jsUrl = new URL(entry.jsUrl, manifestUrl).href;
  const wasmUrl = new URL(entry.wasmUrl, manifestUrl).href;
  const jsModule = await importFreshModule(jsUrl);
  const jsFn = jsModule?.[exportName];
  if (typeof jsFn !== "function") {
    throw new Error(`JS export ${exportName} missing for ${entry.name}`);
  }

  const imports = runtimeHelpers.buildImports(
    entry.imports ?? [],
    {
      document,
      window,
      performance,
      globalThis,
    },
    entry.stringPool ?? [],
  );
  const wasmBytes = new Uint8Array(await (await fetch(wasmUrl, { cache: "no-store" })).arrayBuffer());
  const wasmResult = await runtimeHelpers.instantiateWasm(wasmBytes, imports.env, imports.string_constants);
  if (imports.setExports) imports.setExports(wasmResult.instance.exports);
  const wasmFn = wasmResult.instance.exports?.[exportName];
  if (typeof wasmFn !== "function") {
    throw new Error(`Wasm export ${exportName} missing for ${entry.name}`);
  }

  const bodyState = snapshotSandboxState();
  try {
    for (let i = 0; i < WARM_CALLS; i++) {
      wasmFn();
      jsFn();
    }

    const iterations = calibrate(wasmFn);
    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      timeIt(wasmFn, iterations);
      timeIt(jsFn, iterations);
    }

    const wasmSamplesUs = [];
    const jsSamplesUs = [];
    const ratioSamples = [];
    for (let i = 0; i < MEASURED_ROUNDS; i++) {
      const wasmUs = (timeIt(wasmFn, iterations) / iterations) * 1000;
      const jsUs = (timeIt(jsFn, iterations) / iterations) * 1000;
      wasmSamplesUs.push(wasmUs);
      jsSamplesUs.push(jsUs);
      ratioSamples.push(jsUs / Math.max(wasmUs, 0.000001));
    }

    return {
      name: entry.name,
      path: entry.path,
      wasmUs: median(wasmSamplesUs),
      jsUs: median(jsSamplesUs),
      wasmStdUs: stddev(wasmSamplesUs),
      jsStdUs: stddev(jsSamplesUs),
      ratioStd: stddev(ratioSamples),
      warmupRounds: WARMUP_ROUNDS,
      measuredRounds: MEASURED_ROUNDS,
      runtimeEnvironment: "browser",
    };
  } finally {
    restoreSandboxState(bodyState);
  }
}

export async function runBrowserRuntimeBenchmarks() {
  setStatus("Loading runtime benchmark manifest...");
  const manifestUrl = new URL(MANIFEST_URL, window.location.href);
  const manifest = await fetch(manifestUrl, { cache: "no-store" }).then((res) => res.json());
  const entries = (manifest?.benchmarks ?? []).filter((entry) => entry?.runtimeEnvironment === "browser");
  const runtimeHelpers = await importFreshModule(new URL("./results/loadtime/runtime.js", window.location.href).href);

  const results = [];
  for (const entry of entries) {
    setStatus(`Measuring ${entry.name}...`);
    results.push(await measureEntry(entry, runtimeHelpers, manifestUrl));
  }

  setStatus(`Done. Measured ${results.length} browser runtime benchmark${results.length === 1 ? "" : "s"}.`);
  const json = JSON.stringify(results, null, 2);
  if (resultEl) resultEl.textContent = json;
  return results;
}

window.__ts2wasmRunBrowserRuntimeBenchmarks = runBrowserRuntimeBenchmarks;

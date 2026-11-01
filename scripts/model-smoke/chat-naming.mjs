// Opt-in check: names three seeded routines with the real chat model (Qwen3 0.6B from the catalogue), on this machine's
// CPU, through the app's own worker code and client. It prints one JSON report to stdout and progress to stderr.
//
// Needs: npm run build  (the engine and the desktop app), and 0.64 GB of disk for the model (see fetch-models.mjs).
// Usage: COMPANYOS_MODEL_CACHE=/path/to/cache node scripts/model-smoke/chat-naming.mjs
//
// Six parts:
//   A. nameRoutine() through LocalModelClient and the compiled worker, in a child process (not Electron).
//   B. One RoutineNamingJob pass over the same routines, with the same client and worker.
//   C. The same prompts with node-llama-cpp in this process, to split prefill from decoding and to count tokens.
//   D. Failure paths with the real worker: timeout and recovery, idle stop, a path outside the models folder, a
//      generation cut short, a request over the worker's size limit, the widest routine the engine can produce.
//   E. A wider sample: 60 made-up routines from a fixed seed, to see how often the output passes the namer's check.
//   F. One busy program on the machine: names with all cores and with modelThreads(), then through the real worker.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { loadavg } from 'node:os';
import { core, ensureModel, machine, memoryOf, repoRoot, round, seededRoutines, startRealWorker, syntheticRoutines, waitUntilGone, widestRoutine } from './lib.mjs';

const {
  LocalModelClient,
  NAMING_SYSTEM_PROMPT,
  NAMING_TIMEOUT_MS,
  ROUTINE_NAME_JSON_SCHEMA,
  RoutineNameOutputSchema,
  RoutineNamingJob,
  nameRoutine,
  namingPrompt,
  verifyModelFile,
} = core;

const log = (...parts) => console.error(...parts);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const { spec, path, dir } = await ensureModel('qwen3-0.6b', log);
const { routines } = seededRoutines();
if (routines.length !== 3) throw new Error(`Expected three seeded routines, got ${routines.length}.`);
const describeRoutine = routine => routine.steps.map(step => step.app).join(' > ');

const load = () => loadavg().map(value => round(value));
const report = {
  machine: machine(),
  loadAverageAtStart: load(),
  model: { id: spec.id, file: spec.file, bytes: spec.sizeBytes, sha256: spec.sha256 },
};

// ---- A. nameRoutine through the real worker -------------------------------------------------------------------
{
  let workerPid;
  const client = new LocalModelClient({
    modelPath: path,
    modelsDir: dir,
    start: () => {
      const worker = startRealWorker();
      workerPid = worker.child.pid;
      return worker.channel;
    },
  });
  const loadStart = performance.now();
  await client.warm();
  const loadMs = performance.now() - loadStart;
  const afterLoad = memoryOf(workerPid);
  log(`A. worker started and model loaded in ${round(loadMs / 1000)} s, worker RSS ${round(afterLoad.rssMiB, 0)} MiB`);

  const names = [];
  for (const routine of routines) {
    let raw;
    let error;
    const recorder = {
      complete: async request => {
        try {
          raw = await client.complete(request);
          return raw;
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          throw caught;
        }
      },
    };
    const started = performance.now();
    const result = await nameRoutine(routine, { completer: recorder });
    const ms = performance.now() - started;
    const check = RoutineNameOutputSchema.safeParse(raw);
    names.push({
      steps: describeRoutine(routine),
      ms: round(ms, 0),
      raw,
      error,
      result,
      passesValidation: check.success,
      issues: check.success ? undefined : check.error.issues.map(issue => issue.message),
    });
    log(`   ${describeRoutine(routine)} -> ${JSON.stringify(raw)} (${round(ms, 0)} ms) ${JSON.stringify(result)}`);
  }
  const afterNames = memoryOf(workerPid);
  client.stop();
  report.workerPath = { loadMs: round(loadMs, 0), memoryAfterLoad: afterLoad, memoryAfterNames: afterNames, names, namingTimeoutMs: NAMING_TIMEOUT_MS };
}

// ---- B. One naming job pass through the real worker -------------------------------------------------------------
{
  const renamed = new Map();
  let jobClient;
  const job = new RoutineNamingJob({
    routines: () => routines,
    rename: (id, name) => renamed.set(id, name),
    installed: () => [{ id: spec.id, sha256: spec.sha256, bytes: spec.sizeBytes, installedAt: Date.now() }],
    preferredModelId: async () => spec.id,
    modelPath: model => join(dir, model.file),
    verify: model => verifyModelFile(join(dir, model.file), model),
    openModel: modelPath => {
      jobClient = new LocalModelClient({ modelPath, modelsDir: dir, start: () => startRealWorker().channel });
      return jobClient;
    },
    allowed: () => true,
  });
  const started = performance.now();
  await job.pass();
  const ms = performance.now() - started;
  job.stop();
  report.jobPass = {
    ms: round(ms, 0),
    renamed: routines.map(routine => ({ steps: describeRoutine(routine), name: renamed.get(routine.id) ?? null })),
  };
  log(`B. job pass (verify, load, name three) in ${round(ms / 1000)} s, renamed ${renamed.size} of ${routines.length}`);
}

// ---- C. The same prompts in this process: prefill and decoding speed, tokens, backend ---------------------------------
{
  const lib = await import(pathToFileURL(createRequire(join(repoRoot, 'apps', 'desktop', 'package.json')).resolve('node-llama-cpp')).href);
  const llama = await lib.getLlama({
    build: 'never',
    skipDownload: true,
    progressLogs: false,
    logLevel: lib.LlamaLogLevel.disabled,
    logger: () => undefined,
  });
  const memoryBeforeModel = memoryOf(process.pid);
  const loadStart = performance.now();
  const model = await llama.loadModel({ modelPath: path });
  const modelMs = performance.now() - loadStart;
  const memoryAfterModel = memoryOf(process.pid);
  const contextStart = performance.now();
  // The same thread count the worker uses.
  const context = await model.createContext({ contextSize: 2048, threads: core.modelThreads(llama.cpuMathCores) });
  const contextMs = performance.now() - contextStart;
  const memoryAfterContext = memoryOf(process.pid);
  const grammar = await llama.createGrammarForJsonSchema(ROUTINE_NAME_JSON_SCHEMA);

  const runs = [];
  for (let round_ = 0; round_ < 3; round_++) {
    for (const routine of routines) {
      const session = new lib.LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: NAMING_SYSTEM_PROMPT,
        autoDisposeSequence: true,
      });
      const stamps = [];
      let outputTokens = 0;
      const started = performance.now();
      const text = await session.prompt(namingPrompt(routine), {
        grammar,
        maxTokens: 64,
        temperature: 0,
        onToken: tokens => {
          outputTokens += tokens.length;
          stamps.push(performance.now());
        },
      });
      const ended = performance.now();
      const contextTokens = session.sequence.nextTokenIndex;
      session.dispose();
      const firstMs = stamps[0] - started;
      const decodeSeconds = (stamps.at(-1) - stamps[0]) / 1000;
      runs.push({
        steps: describeRoutine(routine),
        round: round_ + 1,
        text,
        inputTokens: contextTokens - outputTokens,
        outputTokens,
        firstTokenMs: round(firstMs, 0),
        totalMs: round(ended - started, 0),
        prefillTokensPerSecond: round((contextTokens - outputTokens) / (firstMs / 1000), 1),
        decodeTokensPerSecond: outputTokens > 1 ? round((outputTokens - 1) / decodeSeconds, 1) : null,
      });
    }
  }
  const memory = memoryOf(process.pid);
  const workerNames = report.workerPath.names;
  report.direct = {
    backend: llama.gpu === false ? 'cpu' : llama.gpu,
    systemInfo: llama.systemInfo,
    nodeLlamaCppVersion: lib.getModuleVersion ? await lib.getModuleVersion().catch(() => undefined) : undefined,
    modelMs: round(modelMs, 0),
    contextMs: round(contextMs, 0),
    modelSizeMiB: round(model.size / 1024 ** 2, 0),
    contextSize: context.contextSize,
    threads: context.currentThreads ?? undefined,
    memoryBeforeModel,
    memoryAfterModel,
    memoryAfterContext,
    memoryAfterRuns: memory,
    runs,
    medianPrefillTokensPerSecond: round(median(runs.map(run => run.prefillTokensPerSecond)), 1),
    medianDecodeTokensPerSecond: round(median(runs.filter(run => run.decodeTokensPerSecond).map(run => run.decodeTokensPerSecond)), 1),
    medianTotalMs: round(median(runs.map(run => run.totalMs)), 0),
    sameTextAsWorker: routines.map((routine, index) => {
      const direct = runs.find(run => run.round === 1 && run.steps === describeRoutine(routine))?.text;
      return JSON.stringify(workerNames[index].raw) === JSON.stringify(JSON.parse(direct));
    }),
  };
  log(
    `C. backend ${report.direct.backend}, prefill ${report.direct.medianPrefillTokensPerSecond} tok/s, ` +
      `decode ${report.direct.medianDecodeTokensPerSecond} tok/s, median call ${report.direct.medianTotalMs} ms`,
  );
  await context.dispose();
  await model.dispose();
  await llama.dispose();
}

// ---- D. Failure paths with the real worker ---------------------------------------------------------------------------
{
  const pids = [];
  const open = (modelPath, modelsDir, extra = {}) =>
    new LocalModelClient({
      modelPath,
      modelsDir,
      start: () => {
        const worker = startRealWorker();
        pids.push(worker.child.pid);
        return worker.channel;
      },
      ...extra,
    });
  const failures = {};

  // D1. A name that takes longer than its time limit is given up on, the worker is stopped, and the next request works.
  const timeoutClient = open(path, dir, { idleStopMs: 1_500 });
  await timeoutClient.warm();
  const firstPid = pids[0];
  const timedOut = await nameRoutine(routines[0], { completer: timeoutClient, timeoutMs: 30 });
  const stoppedAfterTimeout = await waitUntilGone(firstPid);
  const recoverStart = performance.now();
  const recovered = await nameRoutine(routines[0], { completer: timeoutClient });
  const recoverMs = performance.now() - recoverStart;
  const secondPid = pids[1];
  const secondWorkerWasNew = secondPid !== undefined && secondPid !== firstPid;
  // D2. With no request for idleStopMs, the worker is stopped and its memory returned.
  const stoppedWhenIdle = secondPid !== undefined && (await waitUntilGone(secondPid, 6_000));
  failures.timeout = {
    result: timedOut,
    workerStoppedAfterTimeout: stoppedAfterTimeout,
    nextRequest: recovered,
    nextRequestMsIncludingNewWorkerAndLoad: round(recoverMs, 0),
    nextRequestUsedANewWorker: secondWorkerWasNew,
    workerStoppedWhenIdle: stoppedWhenIdle,
  };
  timeoutClient.stop();

  // D3. A symbolic link inside the models folder that points outside it is refused, so nothing is loaded.
  const outside = mkdtempSync(join(tmpdir(), 'model-smoke-outside-'));
  const inside = join(outside, 'models');
  mkdirSync(inside);
  symlinkSync(path, join(outside, 'outside.gguf'));
  symlinkSync(join(outside, 'outside.gguf'), join(inside, 'linked.gguf'));
  const linked = open(join(inside, 'linked.gguf'), inside);
  failures.linkOutsideModelsFolder = await nameRoutine(routines[0], { completer: linked });
  linked.stop();

  // D4. A generation cut short by maxTokens is not valid JSON. The worker reports a failure, never a half answer.
  const shortClient = open(path, dir);
  const request = { system: NAMING_SYSTEM_PROMPT, prompt: namingPrompt(routines[0]), schema: ROUTINE_NAME_JSON_SCHEMA };
  failures.cutShort = await shortClient.complete({ ...request, maxTokens: 3 }).then(
    value => ({ rejected: false, value }),
    error => ({ rejected: true, message: error.message }),
  );
  // D5. A request over the worker's size limit (4000 characters) is refused, and the worker keeps serving others.
  failures.overLimit = await shortClient.complete({ ...request, prompt: 'x'.repeat(4_001), maxTokens: 64 }).then(
    value => ({ rejected: false, value }),
    error => ({ rejected: true, message: error.message }),
  );
  failures.afterRefusal = await nameRoutine(routines[0], { completer: shortClient });
  // D6. The widest routine the engine can produce. Its prompt must stay inside the worker's limit, so the worker
  // answers and the result is a name or an invalid name, never a model error.
  const widest = widestRoutine();
  failures.widestRoutine = { promptChars: namingPrompt(widest).length, result: await nameRoutine(widest, { completer: shortClient }) };
  shortClient.stop();
  failures.allWorkersGone = (await Promise.all(pids.map(pid => waitUntilGone(pid)))).every(Boolean);
  report.failurePaths = failures;
  log(`D. ${JSON.stringify(failures)}`);
}

// ---- E. A wider sample ----------------------------------------------------------------------------------------------
{
  const sample = syntheticRoutines(60);
  let pid;
  const client = new LocalModelClient({
    modelPath: path,
    modelsDir: dir,
    start: () => {
      const worker = startRealWorker();
      pid = worker.child.pid;
      return worker.channel;
    },
  });
  await client.warm();
  const tally = {};
  const durations = [];
  const names = [];
  let namesAnApp = 0;
  for (const routine of sample) {
    let raw;
    const recorder = {
      complete: async request => {
        raw = await client.complete(request);
        return raw;
      },
    };
    const started = performance.now();
    const result = await nameRoutine(routine, { completer: recorder });
    durations.push(performance.now() - started);
    const key = result.source === 'model' ? 'passes' : result.reason;
    tally[key] = (tally[key] ?? 0) + 1;
    if (result.source === 'model') {
      // A rough check of usefulness, not the namer's own: does the name contain a word of one of the app names?
      const words = routine.steps.flatMap(step => step.options.flatMap(app => app.split(' '))).filter(word => word.length >= 3);
      if (words.some(word => result.name.toLowerCase().includes(word))) namesAnApp++;
    }
    names.push({ steps: describeRoutine(routine), raw, outcome: key });
  }
  const memory = memoryOf(pid);
  client.stop();
  durations.sort((a, b) => a - b);
  report.wideSample = {
    routines: sample.length,
    tally,
    passingNamesThatContainAnAppWord: namesAnApp,
    callMs: { min: round(durations[0], 0), median: round(median(durations), 0), p90: round(durations[Math.floor(durations.length * 0.9)], 0), max: round(durations.at(-1), 0) },
    workerMemoryAfter: memory,
    names,
  };
  log(`E. ${JSON.stringify(tally)}, ${namesAnApp} of ${tally.passes ?? 0} passing names contain an app word, median ${report.wideSample.callMs.median} ms`);
}

// ---- F. One busy program on the machine --------------------------------------------------------------------------
// llama.cpp's threads wait for each other at every step, so a program that holds one core can stall a run that uses all
// of them. This starts one busy Node process (killed by its pid afterwards) and times names with all cores and with
// modelThreads(). A call is stopped after 45 s so the run stays short on a very busy machine.
{
  const lib = await import(pathToFileURL(createRequire(join(repoRoot, 'apps', 'desktop', 'package.json')).resolve('node-llama-cpp')).href);
  const llama = await lib.getLlama({ build: 'never', skipDownload: true, progressLogs: false, logLevel: lib.LlamaLogLevel.disabled, logger: () => undefined });
  const model = await llama.loadModel({ modelPath: path });
  const grammar = await llama.createGrammarForJsonSchema(ROUTINE_NAME_JSON_SCHEMA);
  const cores = llama.cpuMathCores;
  const settings = [
    { label: 'all cores', threads: cores },
    { label: 'modelThreads()', threads: core.modelThreads(cores) },
  ];
  const STOP_AFTER_MS = 45_000;
  const timeOnce = async threads => {
    const context = await model.createContext({ contextSize: 2048, threads });
    const times = [];
    try {
      for (const routine of routines) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), STOP_AFTER_MS);
        const session = new lib.LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: NAMING_SYSTEM_PROMPT, autoDisposeSequence: true });
        const started = performance.now();
        await session.prompt(namingPrompt(routine), { grammar, maxTokens: 64, temperature: 0, signal: controller.signal, stopOnAbortSignal: true });
        clearTimeout(timer);
        times.push(round(performance.now() - started, 0));
        session.dispose();
      }
    } finally {
      await context.dispose();
    }
    return times;
  };

  const quiet = {};
  for (const setting of settings) quiet[setting.label] = { threads: setting.threads, callMs: await timeOnce(setting.threads) };

  const busy = Object.fromEntries(settings.map(setting => [setting.label, { threads: setting.threads, callMs: [] }]));
  let throughWorker;
  const hog = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' });
  const loadWhileBusy = [];
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    for (let pass = 0; pass < 2; pass++) {
      for (const setting of settings) busy[setting.label].callMs.push(...(await timeOnce(setting.threads)));
      loadWhileBusy.push(load());
    }
    // The real worker, which uses modelThreads(), with the busy program still running.
    const client = new LocalModelClient({ modelPath: path, modelsDir: dir, start: () => startRealWorker().channel });
    await client.warm();
    const results = [];
    for (const routine of routines) {
      const started = performance.now();
      const result = await nameRoutine(routine, { completer: client });
      results.push({ ms: round(performance.now() - started, 0), source: result.source, reason: result.source === 'rule' ? result.reason : undefined });
    }
    client.stop();
    throughWorker = results;
  } finally {
    hog.kill('SIGKILL');
  }
  await model.dispose();
  await llama.dispose();
  const summary = values => ({ median: round(median(values), 0), max: Math.max(...values) });
  report.contention = {
    cpuMathCores: cores,
    stoppedAfterMs: STOP_AFTER_MS,
    quiet,
    oneBusyProgram: busy,
    medians: Object.fromEntries(Object.entries(busy).map(([label, entry]) => [label, summary(entry.callMs)])),
    loadAverageWhileBusy: loadWhileBusy,
    throughRealWorkerWhileBusy: throughWorker,
  };
  log(`F. quiet ${JSON.stringify(Object.fromEntries(Object.entries(quiet).map(([k, v]) => [k, v.callMs])))}`);
  log(`   one busy program ${JSON.stringify(Object.fromEntries(Object.entries(busy).map(([k, v]) => [k, v.callMs])))}`);
  log(`   real worker while busy ${JSON.stringify(throughWorker)}`);
}

report.loadAverageAtEnd = load();

console.log(JSON.stringify(report, null, 2));

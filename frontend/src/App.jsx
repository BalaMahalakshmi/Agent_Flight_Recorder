import { useEffect, useState } from "react";

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
  }

  if (!response.ok) {
    const detail = data.detail ?? data.message ?? response.statusText;
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
    );
  }

  return data;
}

function formatCost(value) {
  return Number.isFinite(value) ? `$${value.toFixed(6)}` : "—";
}

function formatCreatedAt(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : date.toLocaleString();
}

function formatOutput(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  if (value === undefined) return "No output recorded.";
  return JSON.stringify(value, null, 2);
}

function getInitialStepIndex(run) {
  const steps = run.steps ?? [];
  let index = run.forked_from_step;

  if (!run.parent_run_id) {
    const match = run.explanation?.match(/Likely failed at step\s+(\d+)/i);
    index = match ? Number(match[1]) : 0;
  }

  return steps.some((step) => step.index === index)
    ? index
    : (steps[0]?.index ?? null);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatToolArguments(input) {
  const args = getToolArgs(input);
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return `{${entries
    .map(([key, value]) => {
      const formatted =
        typeof value === "string" ? value : JSON.stringify(value);
      return `${key}: ${formatted}`;
    })
    .join(", ")}}`;
}

function getToolArgs(input) {
  if (!input || typeof input !== "object") return input;
  if ("arguments" in input) return input.arguments;
  if ("args" in input) {
    return Array.isArray(input.args) ? input.args[1] : input.args;
  }
  if ("kwargs" in input) return input.kwargs;
  return input;
}

function getOutputBlocks(output) {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [{ type: "text", text: value }];
    }
    if (typeof value === "string") return [{ type: "text", text: value }];
  }
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.content)) return value.content;
  return value && typeof value === "object" && value.type ? [value] : [];
}

function getStepSummary(step) {
  if (step.kind === "tool") {
    const args = formatToolArguments(step.input);
    const toolName =
      (Array.isArray(step.input?.args) ? step.input.args[0] : undefined) ??
      step.input?.tool_name ??
      step.input?.name ??
      step.name ??
      "tool";
    return `${toolName}${args ? ` ${args}` : ""}`;
  }

  const firstBlock = getOutputBlocks(step.output)[0];
  if (firstBlock?.type === "tool_use") {
    const args = formatToolArguments(
      firstBlock.input ?? firstBlock.arguments ?? {},
    );
    return `calls ${firstBlock.name ?? "tool"}${args ? ` ${args}` : ""}`;
  }
  if (firstBlock?.type === "text") {
    return String(firstBlock.text ?? "").slice(0, 60);
  }
  return firstBlock?.type ?? "No output block";
}

function diffWords(original, replay) {
  const originalTokens = original.match(/\s+|[^\s]+/g) ?? [];
  const replayTokens = replay.match(/\s+|[^\s]+/g) ?? [];
  const table = Array.from(
    { length: originalTokens.length + 1 },
    () => new Uint32Array(replayTokens.length + 1),
  );

  for (let originalIndex = originalTokens.length - 1; originalIndex >= 0; originalIndex -= 1) {
    for (let replayIndex = replayTokens.length - 1; replayIndex >= 0; replayIndex -= 1) {
      table[originalIndex][replayIndex] =
        originalTokens[originalIndex] === replayTokens[replayIndex]
          ? table[originalIndex + 1][replayIndex + 1] + 1
          : Math.max(
              table[originalIndex + 1][replayIndex],
              table[originalIndex][replayIndex + 1],
            );
    }
  }

  const diff = [];
  let originalIndex = 0;
  let replayIndex = 0;
  while (
    originalIndex < originalTokens.length ||
    replayIndex < replayTokens.length
  ) {
    if (
      originalTokens[originalIndex] === replayTokens[replayIndex] &&
      originalIndex < originalTokens.length
    ) {
      diff.push({ type: "same", text: originalTokens[originalIndex] });
      originalIndex += 1;
      replayIndex += 1;
    } else if (
      replayIndex >= replayTokens.length ||
      (originalIndex < originalTokens.length &&
        table[originalIndex + 1][replayIndex] >=
          table[originalIndex][replayIndex + 1])
    ) {
      diff.push({ type: "removed", text: originalTokens[originalIndex] });
      originalIndex += 1;
    } else {
      diff.push({ type: "added", text: replayTokens[replayIndex] });
      replayIndex += 1;
    }
  }
  return diff;
}

function renderTextDiff(original, replay) {
  return diffWords(original, replay).map((part, index) => {
    if (part.type === "same") return part.text;
    return (
      <span className={`diff-${part.type}`} key={`${part.type}-${index}`}>
        {part.type === "removed" ? <del>{part.text}</del> : part.text}
      </span>
    );
  });
}

function getMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part?.text === "string"
          ? part.text
          : JSON.stringify(part, null, 2),
      )
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content, null, 2);
}

function getTaskText(input) {
  const messages = input && Array.isArray(input.messages) ? input.messages : [];
  const firstUserMessage = messages.find((message) => message?.role === "user");
  return firstUserMessage
    ? getMessageText(firstUserMessage.content)
    : "No user message recorded.";
}

function getFirstUserMessage(input) {
  const messages = input && Array.isArray(input.messages) ? input.messages : [];
  const firstUserMessage = messages.find((message) => message?.role === "user");
  return firstUserMessage ? getMessageText(firstUserMessage.content) : "";
}

function getSystemPrompt(step) {
  return typeof step?.input?.system === "string" ? step.input.system : "";
}

function App() {
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState(null);
  const [comparisonOriginal, setComparisonOriginal] = useState(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [additionalInstruction, setAdditionalInstruction] = useState("");
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingRun, setLoadingRun] = useState(false);
  const [loadingComparison, setLoadingComparison] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState("");

  async function openRun(runId) {
    setError("");
    setLoadingRun(true);
    setComparisonOriginal(null);
    try {
      const run = await requestJson(`/api/runs/${encodeURIComponent(runId)}`);
      setSelectedRun(run);
      const initialStepIndex = getInitialStepIndex(run);
      const initialStep =
        run.steps?.find((step) => step.index === initialStepIndex) ?? null;
      setSelectedStepIndex(initialStepIndex);
      setSystemPrompt(getSystemPrompt(initialStep));
      setAdditionalInstruction("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoadingRun(false);
    }
  }

  async function compareWithOriginal() {
    if (!selectedRun?.parent_run_id) return;
    setError("");
    setLoadingComparison(true);
    try {
      const original = await requestJson(
        `/api/runs/${encodeURIComponent(selectedRun.parent_run_id)}`,
      );
      setComparisonOriginal(original);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoadingComparison(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function loadRuns() {
      setLoadingRuns(true);
      try {
        const loadedRuns = await requestJson("/api/runs");
        if (!active) return;
        setRuns(loadedRuns);
        if (loadedRuns.length > 0) {
          await openRun(loadedRuns[0].id);
        }
      } catch (requestError) {
        if (active) setError(requestError.message);
      } finally {
        if (active) setLoadingRuns(false);
      }
    }

    loadRuns();
    return () => {
      active = false;
    };
  }, []);

  async function explainFailure() {
    if (!selectedRun) return;
    setError("");
    setExplaining(true);
    try {
      const result = await requestJson(
        `/api/runs/${encodeURIComponent(selectedRun.id)}/explain`,
        { method: "POST" },
      );
      setSelectedRun((current) =>
        current ? { ...current, explanation: result.explanation } : current,
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setExplaining(false);
    }
  }

  async function replayFromStep() {
    if (!selectedRun || !selectedStep || selectedStep.kind !== "llm") return;
    setError("");
    setReplaying(true);
    try {
      const replay = await requestJson(
        `/api/runs/${encodeURIComponent(selectedRun.id)}/replay`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            step_index: selectedStep.index,
            system: [
              systemPrompt.trimEnd(),
              additionalInstruction.trim(),
            ]
              .filter(Boolean)
              .join("\n"),
          }),
        },
      );
      setRuns((currentRuns) => [
        replay,
        ...currentRuns.filter((run) => run.id !== replay.id),
      ]);
      setSelectedRun(replay);
      setComparisonOriginal(null);
      setAdditionalInstruction("");
      const initialStepIndex = getInitialStepIndex(replay);
      const initialStep =
        replay.steps?.find((step) => step.index === initialStepIndex) ?? null;
      setSelectedStepIndex(initialStepIndex);
      setSystemPrompt(getSystemPrompt(initialStep));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setReplaying(false);
    }
  }

  const steps = selectedRun?.steps ?? [];
  const selectedStep =
    steps.find((step) => step.index === selectedStepIndex) ?? null;
  const newStepsCost = steps.reduce(
    (total, step) =>
      step.inherited === false ||
      (step.inherited === undefined &&
        selectedRun?.parent_run_id &&
        step.index >= selectedRun.forked_from_step)
        ? total + (Number.isFinite(step.cost) ? step.cost : 0)
        : total,
    0,
  );
  const inheritedStepsCost = steps.reduce(
    (total, step) =>
      step.inherited === true ||
      (step.inherited === undefined &&
        selectedRun?.parent_run_id &&
        step.index < selectedRun.forked_from_step)
        ? total + (Number.isFinite(step.cost) ? step.cost : 0)
        : total,
    0,
  );
  const comparisonRows = comparisonOriginal
    ? Array.from(
        new Set([
          ...(comparisonOriginal.steps ?? []).map((step) => step.index),
          ...steps.map((step) => step.index),
        ]),
      )
        .sort((left, right) => left - right)
        .map((index) => ({
          index,
          original: comparisonOriginal.steps?.find(
            (step) => step.index === index,
          ),
          replay: steps.find((step) => step.index === index),
        }))
    : [];
  const forkStepOriginal = comparisonOriginal?.steps?.find(
    (step) => step.index === selectedRun?.forked_from_step,
  );
  const forkStepReplay = steps.find(
    (step) => step.index === selectedRun?.forked_from_step,
  );
  const originalPrompt = getSystemPrompt(forkStepOriginal);
  const replayPrompt = getSystemPrompt(forkStepReplay);
  const originalUserMessage = getFirstUserMessage(forkStepOriginal?.input);
  const replayUserMessage = getFirstUserMessage(forkStepReplay?.input);
  const changedComparisonRows = comparisonRows.filter(
    (row) =>
      row.index >= selectedRun?.forked_from_step &&
      (row.original && row.replay
        ? getStepSummary(row.original) !== getStepSummary(row.replay) ||
          stableStringify(row.original.output) !==
            stableStringify(row.replay.output)
        : true),
  );
  const changedStepIndexes = new Set(
    changedComparisonRows.map((row) => row.index),
  );
  const firstDifferenceIndex = changedComparisonRows[0]?.index;
  const outcomeChanged =
    stableStringify(comparisonOriginal?.output) !==
    stableStringify(selectedRun?.output);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Recorded runs">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◉
          </span>
          <div>
            <p className="eyebrow">Agent Flight Recorder</p>
            <h1>Runs</h1>
          </div>
        </div>

        {loadingRuns && runs.length === 0 ? (
          <p className="sidebar-message">Loading runs…</p>
        ) : runs.length === 0 ? (
          <div className="empty-runs">
            <p>No runs yet, run</p>
            <code>python -m demo_agent.run_demo</code>
          </div>
        ) : (
          <nav className="run-list" aria-label="Run list">
            {runs.map((run) => (
              <button
                className={`run-card${selectedRun?.id === run.id ? " active" : ""}`}
                key={run.id}
                onClick={() => openRun(run.id)}
                type="button"
              >
                <span className="run-name">{run.name || "Untitled run"}</span>
                <span className="run-meta">
                  <span className={`status-dot status-${run.status || "unknown"}`} />
                  {run.status || "unknown"}
                  <span className="run-cost">{formatCost(run.total_cost)}</span>
                </span>
                <span className="run-created">{formatCreatedAt(run.created_at)}</span>
                {run.parent_run_id && (
                  <span className="replay-tag">
                    replay of step {run.forked_from_step}
                  </span>
                )}
              </button>
            ))}
          </nav>
        )}
      </aside>

      <main className="main-content">
        {error && (
          <div className="error-banner" role="alert">
            <strong>Something went wrong.</strong> {error}
            <button
              aria-label="Dismiss error"
              className="dismiss-error"
              onClick={() => setError("")}
              type="button"
            >
              ×
            </button>
          </div>
        )}

        {loadingRun && !selectedRun ? (
          <div className="welcome-panel">Loading run…</div>
        ) : !selectedRun ? (
          <div className="welcome-panel">
            <span className="welcome-icon" aria-hidden="true">
              ◉
            </span>
            <h2>Your agent’s black box</h2>
            <p>Select a run to inspect its task, result, and step-by-step timeline.</p>
          </div>
        ) : (
          <div className="run-detail">
            {loadingRun && <p className="loading-note">Loading selected run…</p>}
            {selectedRun.parent_run_id && (
              <p className="fork-note">
                Forked from step {selectedRun.forked_from_step},{" "}
                <a
                  href={`#run-${encodeURIComponent(selectedRun.parent_run_id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    openRun(selectedRun.parent_run_id);
                  }}
                >
                  open original run
                </a>
              </p>
            )}

            <header className="run-header">
              <div>
                <p className="eyebrow">Recorded run</p>
                <h2>{selectedRun.name || "Untitled run"}</h2>
              </div>
              <button
                className="button button-secondary"
                disabled={explaining}
                onClick={explainFailure}
                type="button"
              >
                {explaining ? "Explaining…" : "Explain failure"}
              </button>
            </header>

            {selectedRun.parent_run_id && (
              <div className="comparison-actions">
                <button
                  className="button button-secondary"
                  disabled={loadingComparison}
                  onClick={compareWithOriginal}
                  type="button"
                >
                  {loadingComparison
                    ? "Loading original…"
                    : "Compare with original"}
                </button>
              </div>
            )}

            {comparisonOriginal && (
              <section className="comparison-view" aria-label="Run comparison">
                <div className="comparison-heading">
                  <div>
                    <p className="eyebrow">Side-by-side comparison</p>
                    <h3>Original and replay</h3>
                  </div>
                  <button
                    className="button button-secondary"
                    onClick={() => setComparisonOriginal(null)}
                    type="button"
                  >
                    Close comparison
                  </button>
                </div>

                {outcomeChanged && (
                  <div className="outcome-banner">
                    <strong>Outcome changed:</strong>{" "}
                    {formatOutput(comparisonOriginal.output)} →{" "}
                    {formatOutput(selectedRun.output)}
                  </div>
                )}

                <section className="prompt-diff" aria-label="Prompt changes">
                  <p className="section-label">What changed in the prompt</p>
                  {originalPrompt === replayPrompt ? (
                    <p className="prompt-unchanged">Prompt unchanged</p>
                  ) : (
                    <p className="diff-text">
                      {renderTextDiff(originalPrompt, replayPrompt)}
                    </p>
                  )}
                  {originalUserMessage !== replayUserMessage && (
                    <div className="user-message-diff">
                      <p className="section-label">First user message changed</p>
                      <p className="diff-text">
                        {renderTextDiff(originalUserMessage, replayUserMessage)}
                      </p>
                    </div>
                  )}
                </section>

                <div className="comparison-answers">
                  <article className="comparison-answer">
                    <p className="section-label">Original final answer</p>
                    <p className="answer-text">
                      {formatOutput(comparisonOriginal.output)}
                    </p>
                  </article>
                  <article className="comparison-answer">
                    <p className="section-label">Replay final answer</p>
                    <p className="answer-text">
                      {formatOutput(selectedRun.output)}
                    </p>
                  </article>
                </div>

                <div className="comparison-costs" aria-label="Comparison costs">
                  <div>
                    <span className="section-label">Original total</span>
                    <strong>{formatCost(comparisonOriginal.total_cost)}</strong>
                  </div>
                  <div>
                    <span className="section-label">
                      Re-run cost (new steps)
                    </span>
                    <strong>{formatCost(newStepsCost)}</strong>
                  </div>
                  <div>
                    <span className="section-label">
                      Reused from original (inherited steps)
                    </span>
                    <strong>{formatCost(inheritedStepsCost)}</strong>
                  </div>
                </div>

                {firstDifferenceIndex !== undefined && (
                  <p className="comparison-note">
                    First output difference: step {firstDifferenceIndex}
                  </p>
                )}

                <div className="comparison-columns">
                  <section className="comparison-column" aria-label="Original steps">
                    <h4>Original run</h4>
                    <ol className="comparison-step-list">
                      {comparisonRows.map((row) => (
                        <li
                          className={`comparison-step${
                            row.index === firstDifferenceIndex ? " different" : ""
                          }`}
                          key={row.index}
                        >
                          {row.original ? (
                            <>
                              <div className="comparison-step-title">
                                <span>{String(row.index).padStart(2, "0")}</span>
                                <strong>{row.original.name}</strong>
                                <span>{formatCost(row.original.cost)}</span>
                                {changedStepIndexes.has(row.index) && (
                                  <span className="changed-badge">changed</span>
                                )}
                              </div>
                              <p>{getStepSummary(row.original)}</p>
                            </>
                          ) : (
                            <span className="comparison-missing">No matching step</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </section>

                  <section className="comparison-column" aria-label="Replay steps">
                    <h4>Replay (from step {selectedRun.forked_from_step})</h4>
                    <ol className="comparison-step-list">
                      {comparisonRows.map((row) => {
                        const inherited =
                          row.index < selectedRun.forked_from_step;
                        return (
                          <li
                            className={`comparison-step${
                              row.index === firstDifferenceIndex ? " different" : ""
                            }`}
                            key={row.index}
                          >
                            {row.replay ? (
                              <>
                                <div className="comparison-step-title">
                                  <span>{String(row.index).padStart(2, "0")}</span>
                                  <strong>{row.replay.name}</strong>
                                  <span>{formatCost(row.replay.cost)}</span>
                                  {changedStepIndexes.has(row.index) && (
                                    <span className="changed-badge">changed</span>
                                  )}
                                </div>
                                <p>{getStepSummary(row.replay)}</p>
                                {inherited && (
                                  <span className="inherited-tag">
                                    same (inherited)
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="comparison-missing">
                                No matching step
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                </div>
              </section>
            )}

            {!comparisonOriginal && (
              <>
            <section className="summary-grid" aria-label="Run summary">
              <article className="summary-card">
                <p className="section-label">Task</p>
                <p className="task-text">{getTaskText(selectedRun.input)}</p>
              </article>
              <article className="summary-card answer-card">
                <p className="section-label">Final answer</p>
                <p className="answer-text">{formatOutput(selectedRun.output)}</p>
              </article>
            </section>

            {selectedRun.explanation && (
              <section className="explanation-card" aria-live="polite">
                <p className="section-label">Failure explanation</p>
                <p>{selectedRun.explanation}</p>
              </section>
            )}

            <section className="cost-strip" aria-label="Run costs">
              <div>
                <span className="section-label">Total cost</span>
                <strong>{formatCost(selectedRun.total_cost)}</strong>
              </div>
              <div>
                <span className="section-label">Cost of new steps</span>
                <strong>{formatCost(newStepsCost)}</strong>
              </div>
              <div>
                <span className="section-label">Total tokens</span>
                <strong>{selectedRun.total_tokens ?? "—"}</strong>
              </div>
            </section>

            <section className="trace-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Execution trace</p>
                  <h3>Timeline</h3>
                </div>
                <span className="step-count">{steps.length} steps</span>
              </div>

              {steps.length === 0 ? (
                <p className="no-steps">This run has no recorded steps.</p>
              ) : (
                <div className="timeline-layout">
                  <ol className="timeline">
                    {steps.map((step) => (
                      <li
                        className={`timeline-item ${step.kind === "tool" ? "tool" : "llm"}${
                          step.inherited ? " inherited" : ""
                        }`}
                        key={`${step.index}-${step.name}`}
                      >
                        <button
                          aria-current={
                            selectedStepIndex === step.index ? "step" : undefined
                          }
                          className={`step-button${
                            selectedStepIndex === step.index ? " selected" : ""
                          }`}
                          onClick={() => {
                            setSelectedStepIndex(step.index);
                            setSystemPrompt(getSystemPrompt(step));
                            setAdditionalInstruction("");
                          }}
                          type="button"
                        >
                          <span className="timeline-marker" aria-hidden="true" />
                          <span className="step-title-row">
                            <span className="step-index">
                              {String(step.index).padStart(2, "0")}
                            </span>
                            <span className="step-name">{step.name}</span>
                            {step.inherited && (
                              <span className="inherited-tag">same (inherited)</span>
                            )}
                            {selectedStepIndex === step.index && (
                              <span className="replay-marker">replay from here</span>
                            )}
                          </span>
                          <span className="step-meta">
                            <span className="kind-label">
                              {step.kind === "tool" ? "Tool" : "LLM"}
                            </span>
                            <span>
                              {Number.isFinite(step.latency_ms)
                                ? `${step.latency_ms.toFixed(1)} ms`
                                : "—"}
                            </span>
                            <span>{formatCost(step.cost)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>

                  <div className="step-inspector">
                    {selectedStep ? (
                      <>
                        <div className="inspector-heading">
                          <div>
                            <p className="eyebrow">Step {selectedStep.index}</p>
                            <h4>{selectedStep.name}</h4>
                          </div>
                          <span
                            className={`kind-badge ${
                              selectedStep.kind === "tool" ? "tool-badge" : "llm-badge"
                            }`}
                          >
                            {selectedStep.kind === "tool" ? "Tool" : "LLM"}
                          </span>
                        </div>
                        {selectedStep.error && (
                          <div className="step-error" role="alert">
                            {selectedStep.error}
                          </div>
                        )}
                        <div className="json-panel">
                          <p className="section-label">Input</p>
                          <pre>{formatOutput(selectedStep.input)}</pre>
                        </div>
                        <div className="json-panel">
                          <p className="section-label">Output</p>
                          <pre>{formatOutput(selectedStep.output)}</pre>
                        </div>

                        {selectedStep.kind === "llm" && (
                          <div className="replay-panel">
                            <p className="section-label">Replay from this step</p>
                            <label htmlFor="additional-instruction">
                              Add an instruction
                            </label>
                            <input
                              id="additional-instruction"
                              onChange={(event) =>
                                setAdditionalInstruction(event.target.value)
                              }
                              placeholder="Add a short instruction for this replay"
                              value={additionalInstruction}
                            />
                            <details className="advanced-prompt">
                              <summary>Edit full prompt (advanced)</summary>
                              <label htmlFor="system-prompt">System prompt</label>
                              <textarea
                                id="system-prompt"
                                onChange={(event) =>
                                  setSystemPrompt(event.target.value)
                                }
                                rows={5}
                                value={systemPrompt}
                              />
                            </details>
                            <button
                              className="button button-primary"
                              disabled={replaying}
                              onClick={replayFromStep}
                              type="button"
                            >
                              {replaying ? "Replaying…" : "Replay from this step"}
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="no-steps">Select a step to inspect its data.</p>
                    )}
                  </div>
                </div>
              )}
            </section>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
